import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type PluginStore, type ProjectGroup, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { type SetEnv, createGroupForWorktree } from '../src/daemon/set'
import { instanceIdFor, type DirectoryIdentitySource } from '../src/daemon/identity'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { call, failure, git, isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import {
  createRepoGroupCreateBarrier,
  startPluginHarness,
  type PluginHarness,
  type RepoGroupCreateBarrier
} from '../../quirky.repo/test/harness'
import { listWorktrees } from './fixtures/real-project'

const { scratch } = isolateGitConfig()

type CanonicalWorktree = Worktree & {
  projectGroupId: string | null
  lastActivityAt: number
  instanceId: string
}
type GroupWithParent = ProjectGroup & { parentId: string | null }
type CreateGroupResult = {
  group: GroupWithParent
  worktree: CanonicalWorktree
  assigned: boolean
  reason?: string
}

let t: PluginHarness | undefined
let sessionHarness: Harness | undefined
afterEach(async () => {
  await t?.cleanup()
  await sessionHarness?.cleanup()
  t = undefined
  sessionHarness = undefined
})

async function configureProject(client: Harness['clients'][number] | PluginHarness['client']) {
  const rootPath = join(scratch(), 'worktrees')
  mkdirSync(rootPath, { recursive: true })
  const root = realpathSync(rootPath)
  await call(client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const repoDir = makeRepo(join(scratch(), 'api'))
  const repo = (await call(client, 'quirky.repo/add', { path: repoDir })) as Repo
  return { client, repoDir, repo, root }
}

async function start() {
  t = await startPluginHarness({ realGit: true })
  return { t, ...(await configureProject(t.client)) }
}

async function startWithGroupCreateBarrier(barrier: RepoGroupCreateBarrier) {
  t = await startPluginHarness({ realGit: true, repoGroupCreateBarrier: barrier })
  return { t, ...(await configureProject(t.client)) }
}

/** Starts the real session dispatcher plus real repo/worktree plugins; only the unrelated agent provider is fake. */
async function startWithSessions() {
  const home = makeTempHome('qw-sidebar-')
  const builtinPluginsDir = join(home, 'builtin')
  mkdirSync(builtinPluginsDir, { recursive: true })
  const pluginsRoot = join(import.meta.dir, '..', '..')
  for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.session']) {
    symlinkSync(join(pluginsRoot, id), join(builtinPluginsDir, id))
  }
  symlinkSync(join(pluginsRoot, 'quirky.session', 'test', 'fakes', 'quirky.agents'), join(builtinPluginsDir, 'quirky.agents'))
  sessionHarness = await startHarness({ home, builtinPluginsDir })
  const client = await sessionHarness.connect('cli')
  return { h: sessionHarness, ...(await configureProject(client)) }
}

const worktrees = async (client: PluginHarness['client'] | Harness['clients'][number], params: Record<string, unknown> = {}) =>
  (await listWorktrees(client, params)) as CanonicalWorktree[]

async function createWorktree(client: PluginHarness['client'] | Harness['clients'][number], repo: Repo, name: string) {
  const result = (await call(client, 'quirky.worktree/create', { repo: repo.id, name })) as WorktreeCreateResult
  return result.worktree as CanonicalWorktree
}

async function worktreeById(client: PluginHarness['client'] | Harness['clients'][number], id: string) {
  const worktree = (await worktrees(client)).find((row) => row.id === id)
  if (!worktree) throw new Error(`worktree ${id} disappeared from the public list`)
  return worktree
}

const groups = async (client: PluginHarness['client'] | Harness['clients'][number]) =>
  (await call(client, 'quirky.repo/groupList')) as GroupWithParent[]

/** Waits until the real repo groupCreate handler has created the group and paused before returning. */
async function waitForRepoGroupCreateBarrier(
  barrier: RepoGroupCreateBarrier,
  pending: Promise<CreateGroupResult>
): Promise<void> {
  const outcome = await Promise.race([
    barrier.entered.then(() => ({ kind: 'entered' as const })),
    pending.then(
      () => ({ kind: 'completed' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error })
    )
  ])
  if (outcome.kind === 'failed') throw outcome.error
  if (outcome.kind === 'completed') throw new Error('createGroup completed before repo groupCreate reached its return barrier')
}

function expectStale(result: CreateGroupResult) {
  expect(result.assigned).toBe(false)
  expect(result.reason).toEqual(expect.any(String))
  expect(result.reason!.trim().length).toBeGreaterThan(0)
}

describe('canonical worktree project-group membership', () => {
  test('group membership changes presentation without moving Git or session ownership', async () => {
    const { client, repo } = await startWithSessions()
    const selected = await createWorktree(client, repo, 'same-owner')
    const session = await call<{ id: string; worktreeId: string }>(client, 'quirky.session/create', {
      worktree: `id:${selected.id}`,
      agent: 'shell'
    })
    const group = (await call(client, 'quirky.repo/groupCreate', { name: 'Presentation only' })) as GroupWithParent

    await call(client, 'quirky.worktree/set', { worktree: selected.id, projectGroupId: group.id })

    expect(await worktreeById(client, selected.id)).toMatchObject({ id: selected.id, repoId: repo.id, projectGroupId: group.id })
    expect((await call<{ id: string; worktreeId: string }[]>(client, 'quirky.session/list')).find((item) => item.id === session.id))
      .toMatchObject({ id: session.id, worktreeId: selected.id })
  })

  test('createGroup moves only the selected Git worktree and preserves canonical identity and lineage', async () => {
    const { client, repo } = await start()
    const parent = await createWorktree(client, repo, 'parent')
    const selected = await createWorktree(client, repo, 'fix')
    const other = await createWorktree(client, repo, 'other')
    await call(client, 'quirky.worktree/set', { worktree: selected.id, parent: parent.id })

    const before = await worktreeById(client, selected.id)
    expect(before.projectGroupId).toBeNull()
    expect(before.lastActivityAt).toEqual(expect.any(Number))
    expect(Number.isFinite(before.lastActivityAt)).toBe(true)
    expect(before.instanceId).toEqual(expect.any(String))
    expect(before.instanceId.length).toBeGreaterThan(0)
    expect(before.parentId).toBe(parent.id)

    const result = (await call(client, 'quirky.worktree/createGroup', {
      worktree: selected.id,
      name: 'Team',
      expectedInstanceId: before.instanceId,
      expectedProjectGroupId: null
    })) as CreateGroupResult

    expect(result).toMatchObject({
      assigned: true,
      group: { name: 'Team', parentId: null },
      worktree: { id: selected.id, projectGroupId: result.group.id }
    })
    const after = await worktreeById(client, selected.id)
    expect(after).toMatchObject({
      id: before.id,
      path: before.path,
      repoId: before.repoId,
      parentId: before.parentId,
      groupId: before.groupId,
      instanceId: before.instanceId,
      projectGroupId: result.group.id
    })
    expect((await worktreeById(client, other.id)).projectGroupId).toBeNull()
    expect((await worktreeById(client, parent.id)).projectGroupId).toBeNull()
    expect((await worktrees(client)).filter((row) => row.projectGroupId === result.group.id).map((row) => row.id)).toEqual([selected.id])

    const partial = (await call(client, 'quirky.worktree/set', { worktree: selected.id, displayName: 'Selected fix' })) as CanonicalWorktree
    expect(partial).toMatchObject({ displayName: 'Selected fix', projectGroupId: result.group.id })

    const cliSet = await runCli(['wt', 'set', `id:${selected.id}`, '--display-name', 'CLI fix', '--json'], { home: t!.h.home })
    expect(cliSet).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(cliSet.stdout)).toMatchObject({ displayName: 'CLI fix', projectGroupId: result.group.id })

    const cleared = (await call(client, 'quirky.worktree/set', { worktree: selected.id, projectGroupId: null })) as CanonicalWorktree
    expect(cleared.projectGroupId).toBeNull()
  })

  test('generated set flags move and clear only project-group membership', async () => {
    const { client, repo } = await start()
    const selected = await createWorktree(client, repo, 'cli-membership')
    const team = (await call(client, 'quirky.repo/groupCreate', { name: 'CLI Team' })) as GroupWithParent
    const release = (await call(client, 'quirky.repo/groupCreate', { name: 'CLI Release' })) as GroupWithParent
    await call(client, 'quirky.worktree/set', { worktree: selected.id, projectGroupId: team.id })

    const moved = await runCli(['wt', 'set', `id:${selected.id}`, '--project-group', release.id, '--json'], { home: t!.h.home })
    expect(moved).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(moved.stdout)).toMatchObject({ id: selected.id, projectGroupId: release.id, repoId: repo.id })

    const cleared = await runCli(['wt', 'set', `id:${selected.id}`, '--no-project-group', '--json'], { home: t!.h.home })
    expect(cleared).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(cleared.stdout)).toMatchObject({ id: selected.id, projectGroupId: null, repoId: repo.id })
  })

  test('a stale expected membership cannot overwrite a newer regroup', async () => {
    const { client, repo } = await start()
    const selected = await createWorktree(client, repo, 'fix')
    const team = (await call(client, 'quirky.repo/groupCreate', { name: 'Team' })) as GroupWithParent
    const release = (await call(client, 'quirky.repo/groupCreate', { name: 'Release' })) as GroupWithParent
    await call(client, 'quirky.worktree/set', { worktree: selected.id, projectGroupId: team.id })

    const current = await worktreeById(client, selected.id)
    const stale = await failure(call(client, 'quirky.worktree/set', {
      worktree: selected.id,
      projectGroupId: release.id,
      expectedInstanceId: current.instanceId,
      expectedProjectGroupId: null
    }))
    expect(stale.code).toBe(RpcErrorCode.Conflict)
    expect((await worktreeById(client, selected.id)).projectGroupId).toBe(team.id)
  })

  test('ordinary folders reject project-group membership rather than silently reverting it', async () => {
    const { client } = await start()
    const group = (await call(client, 'quirky.repo/groupCreate', { name: 'Team' })) as GroupWithParent
    const folderPath = join(scratch(), 'plain-folder')
    mkdirSync(folderPath, { recursive: true })
    const repo = (await call(client, 'quirky.repo/add', { path: folderPath, folder: true })) as Repo
    const folder = (await worktrees(client, { repo: repo.id }))[0]!
    expect(folder.kind).toBe('folder')

    const rejected = await failure(call(client, 'quirky.worktree/set', { worktree: folder.id, projectGroupId: group.id }))
    expect(rejected.code).toBe(RpcErrorCode.InvalidParams)
    expect((await worktreeById(client, folder.id)).projectGroupId).toBeNull()
  })

  test('the generated create-group command uses the guarded single-worktree assignment', async () => {
    const { client, repo } = await start()
    const selected = await createWorktree(client, repo, 'cli-fix')
    const other = await createWorktree(client, repo, 'other')

    const cli = await runCli(['wt', 'create-group', `id:${selected.id}`, 'From CLI', '--json'], { home: t!.h.home })
    expect(cli).toMatchObject({ code: 0, stderr: '' })
    const result = JSON.parse(cli.stdout) as CreateGroupResult
    expect(result).toMatchObject({ assigned: true, group: { name: 'From CLI' }, worktree: { id: selected.id } })
    expect(result.worktree.projectGroupId).toBe(result.group.id)
    expect((await worktreeById(client, other.id)).projectGroupId).toBeNull()
  })
})

describe('worktree identity and delayed group assignment', () => {
  test('a replacement filesystem object at the same path receives a new instance and no old membership', async () => {
    const { client, repo, repoDir } = await start()
    const path = join(scratch(), 'same-path')
    git(repoDir, 'worktree', 'add', '-q', '-b', 'feature/first-instance', path)
    const original = (await worktrees(client, { repo: repo.id })).find((row) => row.path === realpathSync(path))!
    const group = (await call(client, 'quirky.repo/groupCreate', { name: 'Old grouping' })) as GroupWithParent
    await call(client, 'quirky.worktree/set', { worktree: original.id, projectGroupId: group.id })

    git(repoDir, 'worktree', 'remove', '--force', path)
    git(repoDir, 'worktree', 'add', '-q', '-b', 'feature/replacement-instance', path)
    const replacement = (await worktrees(client, { repo: repo.id })).find((row) => row.path === realpathSync(path))!

    expect(replacement.id).toBe(original.id)
    expect(replacement.instanceId).not.toBe(original.instanceId)
    expect(replacement.projectGroupId).toBeNull()
    expect(existsSync(path)).toBe(true)
  })

  test('zero-birthtime path replacement is rejected using the held directory device and inode', async () => {
    const opened = { device: '8', inode: '101', birthtimeMs: 0 }
    const replacement = { device: '8', inode: '102', birthtimeMs: 0 }
    const worktree: Worktree = {
      id: 'wt_zero_birthtime',
      repoId: 'repo_zero_birthtime',
      path: '/fake/zero-birthtime',
      branch: 'zero-birthtime',
      head: 'a'.repeat(40),
      isMain: false,
      name: 'zero-birthtime',
      kind: 'git',
      displayName: null,
      comment: '',
      status: 'in-progress',
      pinned: false,
      unread: false,
      parentId: null,
      createdAt: 0,
      createdBy: 'external',
      baseRef: null,
      keepBranch: false,
      removing: false,
      groupId: null,
      projectGroupId: null,
      lastActivityAt: 0,
      instanceId: instanceIdFor(opened)
    }
    const group: GroupWithParent = {
      id: 'grp_zero_birthtime',
      name: 'Zero birthtime',
      parentPath: null,
      parentId: null,
      collapsed: false,
      order: 0,
      createdFrom: 'manual',
      repoIds: []
    }
    let closes = 0
    let created = 0
    const identitySource: DirectoryIdentitySource = {
      open: () => ({ identity: opened, close: () => { closes += 1 } }),
      stat: () => replacement
    }
    const env: SetEnv = {
      store: { transaction: () => { throw new Error('a stale assignment must not write') } } as unknown as PluginStore,
      fail: (kind, message, data) => Object.assign(new Error(message), {
        code: kind === 'conflict' ? RpcErrorCode.Conflict : kind === 'not-found' ? RpcErrorCode.NotFound : RpcErrorCode.InvalidParams,
        ...(data === undefined ? {} : { data })
      }),
      find: async () => ({ worktree, all: [worktree] }),
      resolveRepo: async () => ({
        id: worktree.repoId,
        name: 'zero-birthtime',
        path: '/fake/repo',
        addedAt: 0,
        kind: 'git',
        displayName: null,
        groupId: null
      }),
      groups: async () => [group],
      call: async () => {
        created += 1
        return group
      },
      identitySource,
      changed: () => {}
    }

    const result = await createGroupForWorktree(env, {
      worktree: worktree.id,
      name: group.name,
      expectedInstanceId: worktree.instanceId,
      expectedProjectGroupId: null
    }, {})

    expect(result).toMatchObject({ assigned: false, group: { id: group.id }, worktree: { projectGroupId: null } })
    expect(result.reason).toEqual(expect.any(String))
    expect(created).toBe(1)
    expect(closes).toBe(1)
  })

  test('a regroup during createGroup wins over the delayed assignment', async () => {
    const barrier = createRepoGroupCreateBarrier()
    let pending: Promise<CreateGroupResult> | undefined
    let client: PluginHarness['client'] | undefined
    let selected: CanonicalWorktree | undefined
    let releaseGroup: GroupWithParent | undefined
    let regrouped: CanonicalWorktree | undefined

    try {
      const setup = await startWithGroupCreateBarrier(barrier)
      client = setup.client
      const selectedWorktree = await createWorktree(client, setup.repo, 'fix')
      selected = await worktreeById(client, selectedWorktree.id)
      const release = (await call(client, 'quirky.repo/groupCreate', { name: 'Release' })) as GroupWithParent
      releaseGroup = release

      barrier.arm()
      pending = call(client, 'quirky.worktree/createGroup', {
        worktree: selected.id,
        name: 'Delayed team',
        expectedInstanceId: selected.instanceId,
        expectedProjectGroupId: null
      }) as Promise<CreateGroupResult>
      await waitForRepoGroupCreateBarrier(barrier, pending)

      regrouped = (await call(client, 'quirky.worktree/set', {
        worktree: selected.id,
        projectGroupId: release.id,
        expectedInstanceId: selected.instanceId,
        expectedProjectGroupId: null
      })) as CanonicalWorktree
    } finally {
      barrier.release()
      await pending?.catch(() => undefined)
      barrier.dispose()
    }

    if (!client || !selected || !releaseGroup || !regrouped || !pending) throw new Error('regroup barrier case did not complete')
    const result = await pending
    expect(regrouped.projectGroupId).toBe(releaseGroup.id)
    expectStale(result)
    expect((await worktreeById(client, selected.id)).projectGroupId).toBe(releaseGroup.id)
    expect((await worktrees(client)).some((row) => row.projectGroupId === result.group.id)).toBe(false)
  })

  test('a same-path replacement while createGroup is pending is never assigned as the old instance', async () => {
    const barrier = createRepoGroupCreateBarrier()
    let pending: Promise<CreateGroupResult> | undefined
    let client: PluginHarness['client'] | undefined
    let path: string | undefined
    let original: CanonicalWorktree | undefined
    let replacement: CanonicalWorktree | undefined

    try {
      const setup = await startWithGroupCreateBarrier(barrier)
      client = setup.client
      const replacementPath = join(scratch(), 'pending-replacement')
      path = replacementPath
      git(setup.repoDir, 'worktree', 'add', '-q', '-b', 'feature/pending-first', replacementPath)
      const originalWorktree = (await worktrees(client, { repo: setup.repo.id }))
        .find((row) => row.path === realpathSync(replacementPath))!
      original = originalWorktree

      barrier.arm()
      pending = call(client, 'quirky.worktree/createGroup', {
        worktree: originalWorktree.id,
        name: 'Replacement team',
        expectedInstanceId: originalWorktree.instanceId,
        expectedProjectGroupId: null
      }) as Promise<CreateGroupResult>
      await waitForRepoGroupCreateBarrier(barrier, pending)

      git(setup.repoDir, 'worktree', 'remove', '--force', replacementPath)
      git(setup.repoDir, 'worktree', 'add', '-q', '-b', 'feature/pending-second', replacementPath)
      replacement = (await worktrees(client, { repo: setup.repo.id }))
        .find((row) => row.path === realpathSync(replacementPath))!
    } finally {
      barrier.release()
      await pending?.catch(() => undefined)
      barrier.dispose()
    }

    if (!client || !path || !original || !replacement || !pending) throw new Error('replacement barrier case did not complete')
    const result = await pending
    expect(replacement.id).toBe(original.id)
    expect(replacement.instanceId).not.toBe(original.instanceId)
    expectStale(result)
    expect((await worktreeById(client, replacement.id)).projectGroupId).toBeNull()
    expect((await worktrees(client)).some((row) => row.projectGroupId === result.group.id)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

})

describe('monotonic worktree activity', () => {
  test('session creation, change, finish and removal never move worktree activity backwards', async () => {
    const { client, repo } = await startWithSessions()
    const worktree = await createWorktree(client, repo, 'activity')
    const before = await worktreeById(client, worktree.id)
    expect(before.lastActivityAt).toEqual(expect.any(Number))

    await waitFor(() => Date.now() > before.lastActivityAt)
    const session = (await call(client, 'quirky.session/register', {
      worktree: worktree.id,
      agent: 'codex',
      kind: 'structured',
      title: 'Activity test'
    })) as { id: string; lastActivityAt: number }
    expect(session.lastActivityAt).toBeGreaterThan(before.lastActivityAt)
    const afterCreate = await waitForAsync(async () => {
      const current = await worktreeById(client, worktree.id)
      return current.lastActivityAt >= session.lastActivityAt ? current : undefined
    })
    expect(afterCreate.lastActivityAt).toBeGreaterThanOrEqual(session.lastActivityAt)

    await waitFor(() => Date.now() > session.lastActivityAt)
    const changed = (await call(client, 'quirky.session/setStatus', { session: session.id, status: 'waiting' })) as { lastActivityAt: number }
    expect(changed.lastActivityAt).toBeGreaterThanOrEqual(session.lastActivityAt)
    const afterChange = await waitForAsync(async () => {
      const current = await worktreeById(client, worktree.id)
      return current.lastActivityAt >= changed.lastActivityAt ? current : undefined
    })
    expect(afterChange.lastActivityAt).toBeGreaterThanOrEqual(afterCreate.lastActivityAt)

    const finished = (await call(client, 'quirky.session/setStatus', { session: session.id, status: 'exited' })) as { lastActivityAt: number }
    const afterFinish = await waitForAsync(async () => {
      const current = await worktreeById(client, worktree.id)
      return current.lastActivityAt >= finished.lastActivityAt ? current : undefined
    })
    await call(client, 'quirky.session/close', { session: session.id })
    const afterRemoval = await worktreeById(client, worktree.id)
    expect(afterFinish.lastActivityAt).toBeGreaterThanOrEqual(afterChange.lastActivityAt)
    expect(afterRemoval.lastActivityAt).toBeGreaterThanOrEqual(afterFinish.lastActivityAt)
  })
})
