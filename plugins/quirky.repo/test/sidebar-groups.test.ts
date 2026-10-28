import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type ProjectGroup, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { call, failure, isolateGitConfig, makeRepo } from './git-fixtures'
import { startPluginHarness, type PluginHarness } from './harness'
import { listWorktrees } from '../../quirky.worktree/test/fixtures/real-project'

const { scratch } = isolateGitConfig()

type GroupWithParent = ProjectGroup & { parentId: string | null }
type CanonicalWorktree = Worktree & { projectGroupId: string | null; instanceId: string }

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

async function start() {
  t = await startPluginHarness({ realGit: true })
  return { t, client: t.client }
}

const groups = async (client: PluginHarness['client']) => (await call(client, 'quirky.repo/groupList')) as GroupWithParent[]
const groupCreate = async (client: PluginHarness['client'], params: Record<string, unknown>) =>
  (await call(client, 'quirky.repo/groupCreate', params)) as GroupWithParent
const worktrees = async (client: PluginHarness['client'], params: Record<string, unknown> = {}) =>
  (await listWorktrees(client, params)) as CanonicalWorktree[]

async function addRepoAndWorktree(client: PluginHarness['client'], name: string) {
  const path = makeRepo(join(scratch(), name))
  const rootPath = join(scratch(), `${name}-worktrees`)
  mkdirSync(rootPath, { recursive: true })
  await call(client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: rootPath })
  const repo = (await call(client, 'quirky.repo/add', { path })) as Repo
  const created = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'member' })) as WorktreeCreateResult
  return { repo, repoPath: path, worktree: created.worktree as CanonicalWorktree }
}

describe('canonical repository group hierarchy', () => {
  test('groups expose parentId, parent changes are nullable, and invalid parent writes leave the tree untouched', async () => {
    const { client } = await start()
    const root = await groupCreate(client, { name: 'Team' })
    expect(root.parentId).toBeNull()

    const child = await groupCreate(client, { name: 'Child', parent: root.id })
    const loose = await groupCreate(client, { name: 'Loose' })
    expect(child.parentId).toBe(root.id)
    expect(loose.parentId).toBeNull()

    const attached = (await call(client, 'quirky.repo/groupSetParent', { group: loose.id, parent: child.id })) as GroupWithParent
    expect(attached.parentId).toBe(child.id)
    const detached = (await call(client, 'quirky.repo/groupSetParent', { group: loose.id, parent: null })) as GroupWithParent
    expect(detached.parentId).toBeNull()

    const beforeRejectedWrites = await groups(client)
    const missing = await failure(call(client, 'quirky.repo/groupCreate', { name: 'Missing parent', parent: 'id:grp_missing_parent' }))
    expect(missing.code === RpcErrorCode.NotFound || missing.code === RpcErrorCode.InvalidParams).toBe(true)
    const self = await failure(call(client, 'quirky.repo/groupSetParent', { group: root.id, parent: root.id }))
    expect(self.code).toBe(RpcErrorCode.InvalidParams)
    const cycle = await failure(call(client, 'quirky.repo/groupSetParent', { group: root.id, parent: child.id }))
    expect(cycle.code).toBe(RpcErrorCode.InvalidParams)
    expect(await groups(client)).toEqual(beforeRejectedWrites)

    const emitted = await groups(client)
    expect(emitted.map((group) => group.id).sort()).toEqual([root.id, child.id, loose.id].sort())
    expect(new Set(emitted.map((group) => group.id)).size).toBe(emitted.length)
  })

  test('groupList normalizes persisted missing, self and cyclic parents deterministically without losing groups', async () => {
    const { client, t } = await start()
    const first = await groupCreate(client, { name: 'First' })
    const second = await groupCreate(client, { name: 'Second' })
    const third = await groupCreate(client, { name: 'Third' })
    const missing = await groupCreate(client, { name: 'Missing edge' })
    const self = await groupCreate(client, { name: 'Self edge' })

    const untouched = await groups(client)
    expect(untouched.map((group) => group.parentId)).toEqual([null, null, null, null, null])

    // Seed only persisted corruption; assertions below observe the daemon's public groupList result.
    const db = new Database(join(t.h.home, 'plugin-data', 'quirky.repo', 'store.db'))
    try {
      db.run('UPDATE groups SET parent_id = ? WHERE id = ?', [second.id, first.id])
      db.run('UPDATE groups SET parent_id = ? WHERE id = ?', [third.id, second.id])
      db.run('UPDATE groups SET parent_id = ? WHERE id = ?', [first.id, third.id])
      db.run('UPDATE groups SET parent_id = ? WHERE id = ?', ['grp_missing_persisted', missing.id])
      db.run('UPDATE groups SET parent_id = ? WHERE id = ?', [self.id, self.id])
    } finally {
      db.close()
    }

    const normalized = await groups(client)
    const ids = normalized.map((group) => group.id)
    expect(ids.sort()).toEqual([first.id, second.id, third.id, missing.id, self.id].sort())
    expect(new Set(ids).size).toBe(5)
    const parentById = new Map(normalized.map((group) => [group.id, group.parentId]))
    expect(parentById).toEqual(new Map([
      [first.id, second.id],
      [second.id, third.id],
      [third.id, null],
      [missing.id, null],
      [self.id, null]
    ]))
    const repeated = await groups(client)
    expect(repeated.map((group) => [group.id, group.parentId])).toEqual(normalized.map((group) => [group.id, group.parentId]))
  })

  test('generated repo group commands return canonical parent fields', async () => {
    const { t, client } = await start()
    const created = await runCli(['repo', 'group', 'create', 'From CLI', '--json'], { home: t.h.home })
    expect(created).toMatchObject({ code: 0, stderr: '' })
    const group = JSON.parse(created.stdout) as GroupWithParent
    expect(group).toMatchObject({ name: 'From CLI', parentId: null })

    const parent = await groupCreate(client, { name: 'CLI parent' })
    const attached = await runCli(['repo', 'group', 'set-parent', group.id, '--parent', parent.id, '--json'], { home: t.h.home })
    expect(attached).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(attached.stdout)).toMatchObject({ id: group.id, parentId: parent.id })
    const detached = await runCli(['repo', 'group', 'set-parent', group.id, '--no-parent', '--json'], { home: t.h.home })
    expect(detached).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(detached.stdout)).toMatchObject({ id: group.id, parentId: null })

    const listed = await runCli(['repo', 'group', 'list', '--json'], { home: t.h.home })
    expect(listed).toMatchObject({ code: 0, stderr: '' })
    expect((JSON.parse(listed.stdout) as GroupWithParent[]).map((entry) => entry.id)).toContain(group.id)
  })
})

describe('durable group deletion reconciliation', () => {
  test('deleting a subtree while worktree is unloaded survives restart, releases only membership, and keeps Git state', async () => {
    const { client, t } = await start()
    const { repo, worktree: member } = await addRepoAndWorktree(client, 'nested')
    const additional = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'other' })) as WorktreeCreateResult
    const other = additional.worktree as CanonicalWorktree
    const main = (await worktrees(client, { repo: repo.id })).find((worktree) => worktree.isMain)!

    const root = await groupCreate(client, { name: 'Root' })
    const child = await groupCreate(client, { name: 'Child', parent: root.id })
    const solo = await groupCreate(client, { name: 'Solo' })
    const beforeMember = (await call(client, 'quirky.worktree/set', {
      worktree: member.id,
      parent: main.id,
      displayName: 'Keep this label',
      comment: 'Keep this note',
      projectGroupId: child.id
    })) as CanonicalWorktree
    const beforeOther = (await call(client, 'quirky.worktree/set', {
      worktree: other.id,
      parent: main.id,
      displayName: 'Other label',
      projectGroupId: solo.id
    })) as CanonicalWorktree
    expect(beforeMember.projectGroupId).toBe(child.id)
    expect(beforeOther.projectGroupId).toBe(solo.id)

    const worktreeLink = join(t.builtinPluginsDir, 'quirky.worktree')
    unlinkSync(worktreeLink)
    const repoOnly = await t.restart()
    await call(repoOnly.client, 'quirky.repo/groupDelete', { group: root.id })
    await call(repoOnly.client, 'quirky.repo/groupDelete', { group: solo.id })
    expect(await groups(repoOnly.client)).toEqual([])
    const tombstones = (await call(repoOnly.client, 'quirky.repo/groupDeletedIds')) as string[]
    expect(tombstones).toEqual(expect.arrayContaining([root.id, child.id, solo.id]))
    expect(existsSync(member.path)).toBe(true)
    expect(existsSync(other.path)).toBe(true)

    const worktreePlugin = join(import.meta.dir, '..', '..', 'quirky.worktree')
    symlinkSync(worktreePlugin, worktreeLink)
    const reactivated = await t.restart()

    const listedWorktrees = await worktrees(reactivated.client, { repo: repo.id })

    const listReconciled = listedWorktrees.find((worktree) => worktree.id === member.id)!
    expect(listReconciled).toMatchObject({
      id: member.id,
      repoId: repo.id,
      path: member.path,
      parentId: main.id,
      groupId: member.groupId,
      instanceId: beforeMember.instanceId,
      projectGroupId: null,
      displayName: 'Keep this label',
      comment: 'Keep this note'
    })
    expect(existsSync(listReconciled.path)).toBe(true)
    const otherReconciled = listedWorktrees.find((worktree) => worktree.id === other.id)!
    expect(otherReconciled).toMatchObject({
      projectGroupId: null,
      displayName: 'Other label',
      repoId: repo.id,
      parentId: main.id,
      instanceId: beforeOther.instanceId
    })
    expect(existsSync(otherReconciled.path)).toBe(true)

  })

  test('set and releaseGroups reconcile tombstones idempotently without deleting worktrees', async () => {
    const { client, t } = await start()
    const { repo, worktree: releasedByMethod } = await addRepoAndWorktree(client, 'release-method')
    const secondResult = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'second' })) as WorktreeCreateResult
    const releasedBySet = secondResult.worktree as CanonicalWorktree
    const firstGroup = await groupCreate(client, { name: 'Release method' })
    const secondGroup = await groupCreate(client, { name: 'Release through set' })
    await call(client, 'quirky.worktree/set', {
      worktree: releasedByMethod.id,
      displayName: 'Keep first',
      projectGroupId: firstGroup.id
    })
    await call(client, 'quirky.worktree/set', {
      worktree: releasedBySet.id,
      displayName: 'Keep second',
      projectGroupId: secondGroup.id
    })

    const worktreeLink = join(t.builtinPluginsDir, 'quirky.worktree')
    unlinkSync(worktreeLink)
    const repoOnly = await t.restart()
    await call(repoOnly.client, 'quirky.repo/groupDelete', { group: firstGroup.id })
    await call(repoOnly.client, 'quirky.repo/groupDelete', { group: secondGroup.id })
    expect((await call(repoOnly.client, 'quirky.repo/groupDeletedIds')) as string[]).toEqual(
      expect.arrayContaining([firstGroup.id, secondGroup.id])
    )

    symlinkSync(join(import.meta.dir, '..', '..', 'quirky.worktree'), worktreeLink)
    const reactivated = await t.restart()
    await call(reactivated.client, 'quirky.worktree/releaseGroups', { groups: [firstGroup.id] })
    await call(reactivated.client, 'quirky.worktree/releaseGroups', { groups: [firstGroup.id] })
    const updated = (await call(reactivated.client, 'quirky.worktree/set', {
      worktree: releasedBySet.id,
      comment: 'Set after group deletion'
    })) as CanonicalWorktree
    expect(updated).toMatchObject({
      id: releasedBySet.id,
      projectGroupId: null,
      displayName: 'Keep second',
      comment: 'Set after group deletion',
      repoId: repo.id,
      instanceId: releasedBySet.instanceId
    })
    const released = (await worktrees(reactivated.client, { repo: repo.id })).find((worktree) => worktree.id === releasedByMethod.id)!
    expect(released.projectGroupId).toBeNull()
    expect(released.displayName).toBe('Keep first')
    expect(existsSync(released.path)).toBe(true)
    expect(existsSync(updated.path)).toBe(true)
  })
})
