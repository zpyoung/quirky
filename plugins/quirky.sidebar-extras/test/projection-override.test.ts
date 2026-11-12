import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { RpcErrorCode } from '../../../packages/protocol/src'
import {
  boot,
  createFolderProject,
  createGitProject,
  createWorktree,
  extras,
  fakeHostingCalls,
  setFakeHostingCache,
  type ActivityProjection,
  type ExtrasPreferences,
  type ExtrasState,
  type TestEnvironment
} from './support'

setDefaultTimeout(20_000)

let env: TestEnvironment | null = null
afterEach(async () => {
  await env?.harness.cleanup()
  env = null
})

type Checks = 'pending' | 'success' | 'failure' | 'neutral' | null
type ProjectionWithChecks = Omit<ActivityProjection, 'workspaces'> & {
  workspaces: (ActivityProjection['workspaces'][number] & { checks: Checks })[]
}

const OFF: ExtrasPreferences = {
  workspaceActivityWindow: 'all',
  workspaceActivityCustomDays: 30,
  alwaysShowDefaultBranchWorkspace: true,
  workspaceActivityWindowBeforeLiveOnly: 'all',
  hideCompletedReviewWorkspaces: false,
  hidePassingCheckWorkspaces: false,
  hideAutomationCreated: false
}

type Identity = { id: string; instanceId: string; branch: string | null; head: string }

function entry(workspace: Identity, state: string, checksStatus: string, overrides: Record<string, unknown> = {}) {
  return {
    worktreeId: workspace.id,
    instanceId: workspace.instanceId,
    branch: workspace.branch,
    headOid: workspace.head,
    review: {
      state,
      checksStatus,
      headRefOid: workspace.head,
      number: 7,
      url: 'https://example.invalid/review/7'
    },
    stale: false,
    ...overrides
  }
}

function checksOf(projection: ProjectionWithChecks, worktreeId: string): Checks {
  const found = projection.workspaces.find((workspace) => workspace.worktreeId === worktreeId)
  expect(found).toBeDefined()
  return found!.checks
}

const project = (preferences?: unknown) =>
  extras<ProjectionWithChecks>(env!.client, 'projection', preferences === undefined ? {} : { preferences })

describe('projection preferences override', () => {
  test('computes from the override, echoes it, and writes nothing', async () => {
    env = await boot({ fakeHosting: true })
    const repo = await createGitProject(env.client)
    const merged = await createWorktree(env.client, repo.repo.id, 'merged')
    const open = await createWorktree(env.client, repo.repo.id, 'open')
    await setFakeHostingCache(env.client, [
      entry(merged, 'merged', 'success'),
      entry(open, 'open', 'failure')
    ])
    await extras(env.client, 'activate', { worktree: repo.main.id })

    const stored = await extras<ExtrasState>(env.client, 'state')
    const baseline = await project()
    expect(baseline.reviewHiddenIds).toEqual([])
    expect(baseline.visibleIds).toContain(merged.id)

    const override = { ...OFF, hideCompletedReviewWorkspaces: true }
    const overridden = await project(override)
    expect(overridden.preferences).toEqual(override)
    expect(overridden.reviewHiddenIds).toEqual([merged.id])
    expect(overridden.visibleIds).not.toContain(merged.id)
    expect(overridden.visibleIds).toContain(open.id)
    expect(overridden.filterCount).toBe(1)
    expect(overridden.active).toEqual(stored.active)

    expect(await extras<ExtrasState>(env.client, 'state')).toEqual(stored)
    expect((await project()).reviewHiddenIds).toEqual([])
  })

  test('an override can turn filters off while stored preferences have them on', async () => {
    env = await boot({ fakeHosting: true })
    const repo = await createGitProject(env.client)
    const merged = await createWorktree(env.client, repo.repo.id, 'merged')
    await setFakeHostingCache(env.client, [entry(merged, 'merged', 'success')])
    await extras(env.client, 'set', { hideCompletedReviewWorkspaces: true })
    expect((await project()).reviewHiddenIds).toEqual([merged.id])
    expect((await project(OFF)).reviewHiddenIds).toEqual([])
  })

  test('applies the override activity window instead of the stored one', async () => {
    env = await boot()
    const repo = await createGitProject(env.client)
    const other = await createWorktree(env.client, repo.repo.id, 'other')
    await extras(env.client, 'activate', { worktree: repo.main.id })
    await extras(env.client, 'set', { workspaceActivityWindow: 'live-only' })
    expect((await project()).visibleIds).not.toContain(other.id)
    const all = await project(OFF)
    expect(all.visibleIds).toContain(other.id)
    expect(all.workspaces.find((workspace) => workspace.worktreeId === other.id)!.reason).toBe('all')
  })

  test('rejects an invalid override field as invalid params', async () => {
    env = await boot()
    const bad: unknown[] = [
      null,
      [],
      'all',
      { ...OFF, workspaceActivityWindow: 'forever' },
      { ...OFF, workspaceActivityCustomDays: 0 },
      { ...OFF, workspaceActivityCustomDays: 1.5 },
      { ...OFF, alwaysShowDefaultBranchWorkspace: 'yes' },
      { ...OFF, workspaceActivityWindowBeforeLiveOnly: 'live-only' },
      { ...OFF, hideCompletedReviewWorkspaces: 1 },
      { ...OFF, hidePassingCheckWorkspaces: null },
      { ...OFF, hideAutomationCreated: 'no' },
      { ...OFF, extra: true }
    ]
    for (const preferences of bad) {
      await expect(extras(env.client, 'projection', { preferences })).rejects.toMatchObject({
        code: RpcErrorCode.InvalidParams
      })
    }
    const { hideAutomationCreated: _omitted, ...missing } = OFF
    await expect(extras(env.client, 'projection', { preferences: missing })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    await expect(extras(env.client, 'projection', { unknown: true })).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
  })
})

describe('projection checks', () => {
  test('reports the cached checks status with every hide filter off', async () => {
    env = await boot({ fakeHosting: true })
    const repo = await createGitProject(env.client)
    const pending = await createWorktree(env.client, repo.repo.id, 'pending')
    const success = await createWorktree(env.client, repo.repo.id, 'success')
    const failure = await createWorktree(env.client, repo.repo.id, 'failure')
    const neutral = await createWorktree(env.client, repo.repo.id, 'neutral')
    const none = await createWorktree(env.client, repo.repo.id, 'none')
    const stale = await createWorktree(env.client, repo.repo.id, 'stale')
    const folder = await createFolderProject(env.client)
    await setFakeHostingCache(env.client, [
      entry(pending, 'open', 'pending'),
      entry(success, 'merged', 'success'),
      entry(failure, 'draft', 'failure'),
      entry(neutral, 'open', 'neutral'),
      { ...entry(none, 'open', 'success'), review: null },
      entry(stale, 'open', 'success', { stale: true })
    ])

    const projection = await project(OFF)
    expect(checksOf(projection, pending.id)).toBe('pending')
    expect(checksOf(projection, success.id)).toBe('success')
    expect(checksOf(projection, failure.id)).toBe('failure')
    expect(checksOf(projection, neutral.id)).toBe('neutral')
    expect(checksOf(projection, none.id)).toBeNull()
    expect(checksOf(projection, stale.id)).toBeNull()
    expect(checksOf(projection, repo.main.id)).toBeNull()
    expect(checksOf(projection, folder.primary.id)).toBeNull()
    expect(projection.reviewHiddenIds).toEqual([])
    for (const workspace of projection.workspaces) {
      expect(workspace.reviewReason).toBeUndefined()
      expect(workspace.reviewError).toBeUndefined()
    }
  })

  test('is filled without an override while both stored hide filters are off', async () => {
    env = await boot({ fakeHosting: true })
    const repo = await createGitProject(env.client)
    const failing = await createWorktree(env.client, repo.repo.id, 'failing')
    await setFakeHostingCache(env.client, [entry(failing, 'open', 'failure')])
    const projection = await project()
    expect(checksOf(projection, failing.id)).toBe('failure')
    expect(projection.reviewHiddenIds).toEqual([])
    expect(projection.visibleIds).toContain(failing.id)
    for (const workspace of projection.workspaces) {
      expect(workspace.reviewReason).toBeUndefined()
      expect(workspace.reviewError).toBeUndefined()
    }
    expect((await fakeHostingCalls(env.client)).length).toBeGreaterThan(0)
  })

  test('is filled alongside the stored hide filters and reads only the review cache', async () => {
    env = await boot({ fakeHosting: true })
    const repo = await createGitProject(env.client)
    const success = await createWorktree(env.client, repo.repo.id, 'success')
    await setFakeHostingCache(env.client, [entry(success, 'open', 'success')])
    await extras(env.client, 'set', { hidePassingCheckWorkspaces: true })
    const projection = await project()
    expect(projection.reviewHiddenIds).toEqual([success.id])
    expect(checksOf(projection, success.id)).toBe('success')
    expect((await fakeHostingCalls(env.client)).length).toBeGreaterThan(0)
  })

  test('is null for every workspace when no review cache is available', async () => {
    env = await boot()
    const repo = await createGitProject(env.client)
    const other = await createWorktree(env.client, repo.repo.id, 'other')
    for (const projection of [await project(), await project(OFF)]) {
      expect(checksOf(projection, repo.main.id)).toBeNull()
      expect(checksOf(projection, other.id)).toBeNull()
    }
  })
})

describe('projection worktree override', () => {
  test('computes for the given worktree as selected, echoes it as active, and writes nothing', async () => {
    env = await boot()
    const repo = await createGitProject(env.client)
    const other = await createWorktree(env.client, repo.repo.id, 'other')
    await extras(env.client, 'activate', { worktree: repo.main.id })
    await extras(env.client, 'set', { workspaceActivityWindow: 'live-only' })
    const stored = await extras<ExtrasState>(env.client, 'state')

    const projected = await extras<ActivityProjection>(env.client, 'projection', { worktree: other.id })
    expect(projected.active).toEqual({ worktreeId: other.id, instanceId: other.instanceId })
    expect(projected.visibleIds).toContain(other.id)
    expect(projected.workspaces.find((workspace) => workspace.worktreeId === other.id)!.reason).toBe('selected')
    expect(projected.workspaces.find((workspace) => workspace.worktreeId === repo.main.id)!.reason).not.toBe('selected')

    expect(await extras<ExtrasState>(env.client, 'state')).toEqual(stored)
  })

  test('null or an unknown worktree projects with nothing selected', async () => {
    env = await boot()
    const repo = await createGitProject(env.client)
    await extras(env.client, 'activate', { worktree: repo.main.id })
    for (const worktree of [null, 'wt_missing']) {
      const projected = await extras<ActivityProjection>(env.client, 'projection', { worktree })
      expect(projected.active).toBeNull()
      expect(projected.workspaces.some((workspace) => workspace.reason === 'selected')).toBe(false)
    }
  })

  test('combines with a preferences override', async () => {
    env = await boot()
    const repo = await createGitProject(env.client)
    const other = await createWorktree(env.client, repo.repo.id, 'other')
    const projected = await extras<ActivityProjection>(env.client, 'projection', { worktree: other.id, preferences: OFF })
    expect(projected.preferences).toEqual(OFF)
    expect(projected.active?.worktreeId).toBe(other.id)
  })

  test('rejects a worktree that is neither a non-empty string nor null', async () => {
    env = await boot()
    for (const worktree of ['', 7, {}]) {
      await expect(extras(env.client, 'projection', { worktree })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
  })
})
