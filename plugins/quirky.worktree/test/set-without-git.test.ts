import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { gitApi } from '@quirky/git'
import { useTestGit } from '@quirky/git/testing'
import { RpcErrorCode, type Worktree } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { call, failure, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { worktreeIdForPath } from '../paths'
import { addExternalWorktree, listWorktrees, startRealProject, storedRows, type RealProject } from './fixtures/real-project'

setDefaultTimeout(60_000)

const { scratch } = isolateGitConfig()
let project: RealProject | undefined
const pendingCalls = new Set<Promise<unknown>>()
let releaseHeldGit: (() => void)[] = []

afterEach(async () => {
  for (const release of releaseHeldGit) release()
  try {
    await Promise.allSettled([...pendingCalls])
  } finally {
    pendingCalls.clear()
    useTestGit(null)
    try {
      await project?.t.cleanup()
    } finally {
      project = undefined
      releaseHeldGit = []
      useTestGit(null)
    }
  }
})

function track<T>(promise: Promise<T>): Promise<T> {
  const pending = promise as Promise<unknown>
  pendingCalls.add(pending)
  void pending.then(
    () => pendingCalls.delete(pending),
    () => pendingCalls.delete(pending)
  )
  return promise
}

type GitListingGate = { release(): void; calls(): number }

function holdGitListings(skipCalls = 0): GitListingGate {
  useTestGit(null)
  const real = gitApi()
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const release = () => gate.resolve()
  releaseHeldGit.push(release)
  useTestGit({
    ...real,
    listRegistrations: async (...args: Parameters<typeof real.listRegistrations>) => {
      calls++
      if (calls > skipCalls) await gate.promise
      return real.listRegistrations(...args)
    }
  })
  return { release, calls: () => calls }
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> {
  // These integration checks measure the RPC against held real git; fake timers would not measure elapsed daemon work.
  const result = Promise.withResolvers<{ settled: true; value: T } | { settled: false }>()
  const timer = setTimeout(() => result.resolve({ settled: false }), ms)
  promise.then(
    (value) => {
      clearTimeout(timer)
      result.resolve({ settled: true, value })
    },
    (error: unknown) => {
      clearTimeout(timer)
      result.reject(error)
    }
  )
  return result.promise
}

async function resolvesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  const outcome = await settlesWithin(promise, ms)
  expect(outcome.settled).toBe(true)
  if (!outcome.settled) throw new Error(`call did not resolve within ${ms} ms`)
  return outcome.value
}

async function waitsForGit<T>(promise: Promise<T>, gate: GitListingGate): Promise<T> {
  const outcome = await settlesWithin(promise, 300)
  expect(outcome.settled).toBe(false)
  expect(gate.calls()).toBeGreaterThan(0)
  gate.release()
  if (outcome.settled) throw new Error('call settled before held git was released')
  return promise
}

async function startFix(listFirst = true) {
  const started = await startRealProject(scratch)
  project = started
  const path = addExternalWorktree(started.repoDir, join(scratch(), 'fix'), 'zoe/fix')
  const id = worktreeIdForPath(path)
  const listed = listFirst ? await listWorktrees(started.client, { repo: started.repo.id }) : []
  return {
    project: started,
    path,
    id,
    fix: listed.find((worktree) => worktree.id === id),
    primary: listed.find((worktree) => worktree.isMain)
  }
}

const setById = (client: RealProject['client'], id: string, fields: Record<string, unknown>) =>
  track(call(client, 'quirky.worktree/set', { worktree: `id:${id}`, ...fields }) as Promise<Worktree>)

const missingWorktreeMessage = (id: string) => `no worktree matches id:${id}; use id:, name:, branch:, path: or current`

describe('quirky.worktree/set by id without waiting for git', () => {
  test('a listed metadata update returns the recorded facts and emits one unread event before git is released', async () => {
    const { project, fix } = await startFix()
    expect(fix).toBeDefined()
    const worktree = fix!
    const watcher = await project.t.h.connectWithEvents('cli')
    const changedBefore = watcher.events.filter((event) => event.type === 'quirky.worktree/changed').length
    const gate = holdGitListings()

    const updated = await resolvesWithin(setById(project.client, worktree.id, {
      unread: true,
      unreadSource: 'notifications'
    }), 500)
    expect(updated).toMatchObject({ id: worktree.id, unread: true, branch: 'zoe/fix' })
    expect(gate.calls()).toBe(0)

    const events = await waitFor(() => {
      const changed = watcher.events.filter((event) => event.type === 'quirky.worktree/changed')
      return changed.length > changedBefore ? changed.slice(changedBefore) : undefined
    })
    expect(events).toEqual([expect.objectContaining({
      type: 'quirky.worktree/changed',
      data: {
        repoId: project.repo.id,
        worktreeId: worktree.id,
        unread: true,
        unreadSource: 'notifications'
      }
    })])

    gate.release()
    const afterRelease = (await listWorktrees(project.client, { repo: project.repo.id })).find((item) => item.id === worktree.id)
    expect(afterRelease?.unread).toBe(true)
  })

  test('each metadata field resolves while git is held and appears in the next list', async () => {
    const { project, fix, primary } = await startFix()
    expect(fix).toBeDefined()
    expect(primary).toBeDefined()
    await call(project.client, 'quirky.worktree/set', { worktree: fix!.id, parent: primary!.id })

    const gate = holdGitListings()
    const updates = [
      { displayName: 'Fix display' },
      { comment: 'Owned by Zoe' },
      { status: 'done' },
      { pinned: true },
      { unread: true },
      { baseRef: 'main' },
      { references: [{ url: 'https://example.com/fix', label: 'Fix issue' }] },
      { noParent: true }
    ]
    for (const update of updates) {
      await resolvesWithin(setById(project.client, fix!.id, update), 500)
    }
    expect(gate.calls()).toBe(0)

    gate.release()
    const afterRelease = (await listWorktrees(project.client, { repo: project.repo.id })).find((item) => item.id === fix!.id)
    expect(afterRelease).toMatchObject({
      displayName: 'Fix display',
      comment: 'Owned by Zoe',
      status: 'done',
      pinned: true,
      unread: true,
      baseRef: 'main',
      parentId: null,
      references: [{ url: 'https://example.com/fix', label: 'Fix issue' }]
    })
  })

  test('an id never listed by this plugin waits for git, then stores the metadata', async () => {
    const { project, id } = await startFix(false)
    const gate = holdGitListings()
    const pending = setById(project.client, id, { comment: 'First seen after release' })

    const result = await waitsForGit(pending, gate)
    expect(result).toMatchObject({ id, comment: 'First seen after release' })
    const listed = (await listWorktrees(project.client, { repo: project.repo.id })).find((item) => item.id === id)
    expect(listed?.comment).toBe('First seen after release')
  })

  test('a selector other than id waits for git', async () => {
    const { project, fix } = await startFix()
    expect(fix).toBeDefined()
    const gate = holdGitListings()
    const pending = track(call(project.client, 'quirky.worktree/set', { worktree: 'name:fix', unread: true }) as Promise<Worktree>)

    const result = await waitsForGit(pending, gate)
    expect(result).toMatchObject({ id: fix!.id, unread: true })
  })

  test('parent, project-group, expected-identity and guarded group assignments keep the full live lookup', async () => {
    const { project, fix, primary } = await startFix()
    expect(fix).toBeDefined()
    expect(primary).toBeDefined()
    const group = await call(project.client, 'quirky.repo/groupCreate', { name: 'set-group' }) as { id: string }
    const liveUpdates = [
      { fields: { parent: primary!.id }, expected: { parentId: primary!.id } },
      { fields: { expectedProjectGroupId: null }, expected: { projectGroupId: null } },
      { fields: { expectedInstanceId: fix!.instanceId }, expected: { instanceId: fix!.instanceId } },
      { fields: { projectGroupId: group.id }, expected: { projectGroupId: group.id } }
    ]

    for (const { fields, expected } of liveUpdates) {
      const gate = holdGitListings()
      const pending = setById(project.client, fix!.id, fields)
      const result = await waitsForGit(pending, gate)
      expect(result).toMatchObject({ id: fix!.id, ...expected })
    }

    const guardedGate = holdGitListings(2)
    const guardedAssignment = track(call(project.client, 'quirky.worktree/createGroup', {
      worktree: fix!.id,
      name: 'guarded-group',
      expectedInstanceId: fix!.instanceId,
      expectedProjectGroupId: group.id
    }) as Promise<{ assigned: boolean; group: { id: string }; worktree: Worktree }>)
    const guardedResult = await waitsForGit(guardedAssignment, guardedGate)
    expect(guardedResult).toMatchObject({
      assigned: true,
      worktree: { id: fix!.id, projectGroupId: guardedResult.group.id }
    })
    expect(guardedGate.calls()).toBeGreaterThan(2)
  })

  test('a listed workspace whose folder disappeared falls back and emits no changed event', async () => {
    const { project, fix, path } = await startFix()
    expect(fix).toBeDefined()
    const watcher = await project.t.h.connectWithEvents('cli')
    rmSync(path, { recursive: true, force: true })

    const refused = await resolvesWithin(failure(setById(project.client, fix!.id, { unread: true })), 5_000)
    expect(refused).toMatchObject({ code: RpcErrorCode.NotFound, message: missingWorktreeMessage(fix!.id) })
    expect(watcher.events.filter((event) => event.type === 'quirky.worktree/changed')).toEqual([])
  })

  test('a workspace removed through Quirky has no row and cannot be set by id', async () => {
    const { project, fix } = await startFix()
    expect(fix).toBeDefined()
    await call(project.client, 'quirky.worktree/remove', { worktree: fix!.id, force: true, yes: true })
    expect(storedRows(project.t.h.home, 'id = ?', fix!.id)).toEqual([])

    const refused = await failure(setById(project.client, fix!.id, { comment: 'must not return' }))
    expect(refused).toMatchObject({ code: RpcErrorCode.NotFound, message: missingWorktreeMessage(fix!.id) })
  })

  test('validation errors remain exact and are returned before held git is reached', async () => {
    const { project, fix } = await startFix()
    expect(fix).toBeDefined()
    const gate = holdGitListings()
    const invalid = async (fields: Record<string, unknown>) =>
      resolvesWithin(track(failure(setById(project.client, fix!.id, fields))), 500)

    expect(await invalid({ unreadSource: 'notifications' })).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'unreadSource requires a boolean unread value'
    })
    expect(await invalid({ status: 'unknown-status' })).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'status must be one of todo, in-progress, in-review, done'
    })
    expect(await invalid({ parent: 'id:some-parent', noParent: true })).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'parent and noParent cannot be used together'
    })
    expect(gate.calls()).toBe(0)
    gate.release()
  })
})
