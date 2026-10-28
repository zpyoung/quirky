import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  boot,
  createFolderProject,
  createGitProject,
  createWorktree,
  extras,
  fakeHostingCalls,
  setFakeHostingCache,
  type ActivityProjection,
  type TestEnvironment
} from './support'

setDefaultTimeout(20_000)

let env: TestEnvironment | null = null
afterEach(async () => {
  await env?.harness.cleanup()
  env = null
})

type WorkspaceIdentity = {
  id: string
  instanceId: string
  branch: string | null
  head: string
  kind: 'git' | 'folder'
}

type ReviewState = 'open' | 'draft' | 'closed' | 'merged'
type ChecksStatus = 'neutral' | 'pending' | 'success' | 'failure'

function cachedReview(
  workspace: WorkspaceIdentity,
  state: ReviewState,
  checksStatus: ChecksStatus
) {
  return {
    state,
    checksStatus,
    headRefOid: workspace.head,
    number: 7,
    url: 'https://example.invalid/review/7'
  }
}

function cacheEntry(
  workspace: WorkspaceIdentity,
  review: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    worktreeId: workspace.id,
    instanceId: workspace.instanceId,
    branch: workspace.branch,
    headOid: workspace.kind === 'folder' ? null : workspace.head,
    review,
    stale: false,
    ...overrides
  }
}

function row(projection: ActivityProjection, worktreeId: string) {
  const found = projection.workspaces.find((workspace) => workspace.worktreeId === worktreeId)
  expect(found).toBeDefined()
  return found!
}

const ids = (values: string[]) => new Set(values)

describe('sidebar review filter projection API', () => {
  test('reads only current completed or successful cached reviews and keeps unknown or malformed rows visible', async () => {
    env = await boot({ fakeHosting: true })
    const project = await createGitProject(env.client)
    const merged = await createWorktree(env.client, project.repo.id, 'merged')
    const closed = await createWorktree(env.client, project.repo.id, 'closed')
    const success = await createWorktree(env.client, project.repo.id, 'success')
    const failure = await createWorktree(env.client, project.repo.id, 'failure')
    const pending = await createWorktree(env.client, project.repo.id, 'pending')
    const neutral = await createWorktree(env.client, project.repo.id, 'neutral')
    const missing = await createWorktree(env.client, project.repo.id, 'missing')
    const stale = await createWorktree(env.client, project.repo.id, 'stale')
    const wrongInstance = await createWorktree(env.client, project.repo.id, 'wrong-instance')
    const wrongBranch = await createWorktree(env.client, project.repo.id, 'wrong-branch')
    const inferredMerged = await createWorktree(env.client, project.repo.id, 'inferred-merged')
    const missingHead = await createWorktree(env.client, project.repo.id, 'missing-head')
    const emptyHead = await createWorktree(env.client, project.repo.id, 'empty-head')
    const malformed = await createWorktree(env.client, project.repo.id, 'malformed')
    const rowError = await createWorktree(env.client, project.repo.id, 'row-error')
    const folder = await createFolderProject(env.client)

    const entries = [
      cacheEntry(project.main, cachedReview(project.main, 'merged', 'neutral')),
      cacheEntry(merged, cachedReview(merged, 'merged', 'failure')),
      cacheEntry(closed, cachedReview(closed, 'closed', 'neutral')),
      cacheEntry(success, cachedReview(success, 'open', 'success')),
      cacheEntry(failure, cachedReview(failure, 'open', 'failure')),
      cacheEntry(pending, cachedReview(pending, 'draft', 'pending')),
      cacheEntry(neutral, cachedReview(neutral, 'open', 'neutral')),
      cacheEntry(missing, null),
      cacheEntry(stale, null, { stale: true }),
      cacheEntry(wrongInstance, cachedReview(wrongInstance, 'merged', 'success'), { instanceId: 'replaced-instance' }),
      cacheEntry(wrongBranch, cachedReview(wrongBranch, 'closed', 'success'), { branch: 'replaced-branch' }),
      cacheEntry(inferredMerged, cachedReview(inferredMerged, 'merged', 'failure'), { headOid: 'current-local-head' }),
      cacheEntry(missingHead, cachedReview(missingHead, 'merged', 'success'), { headOid: null }),
      cacheEntry(emptyHead, cachedReview(emptyHead, 'merged', 'success'), { headOid: '' }),
      cacheEntry(malformed, { state: 'merged', checksStatus: 'success' }),
      cacheEntry(rowError, null, { stale: true, error: 'local identity read failed' }),
      cacheEntry(folder.primary, cachedReview(folder.primary, 'merged', 'success'))
    ]
    await setFakeHostingCache(env.client, entries)

    const off = await extras<ActivityProjection>(env.client, 'projection')
    expect(off.reviewHiddenIds).toEqual([])
    expect(off.reviewHiddenCount).toBe(0)
    expect(await fakeHostingCalls(env.client)).toEqual([])

    await extras(env.client, 'activate', { worktree: project.main.id })
    await extras(env.client, 'set', { hideCompletedReviewWorkspaces: true })
    const completed = await extras<ActivityProjection>(env.client, 'projection')
    expect(ids(completed.reviewHiddenIds)).toEqual(ids([project.main.id, merged.id, closed.id, inferredMerged.id]))
    expect(completed.visibleIds).not.toContain(project.main.id)
    expect(completed.visibleIds).not.toContain(merged.id)
    expect(completed.visibleIds).not.toContain(closed.id)
    expect(completed.visibleIds).toContain(success.id)
    expect(completed.visibleIds).toContain(failure.id)
    expect(completed.visibleIds).toContain(pending.id)
    expect(completed.visibleIds).toContain(neutral.id)
    expect(completed.visibleIds).toContain(missing.id)
    expect(completed.visibleIds).toContain(stale.id)
    expect(completed.visibleIds).toContain(wrongInstance.id)
    expect(completed.visibleIds).toContain(wrongBranch.id)
    expect(completed.visibleIds).not.toContain(inferredMerged.id)
    expect(completed.visibleIds).toContain(missingHead.id)
    expect(completed.visibleIds).toContain(emptyHead.id)
    expect(completed.visibleIds).toContain(malformed.id)
    expect(completed.visibleIds).toContain(rowError.id)
    expect(completed.visibleIds).toContain(folder.primary.id)
    expect(completed.filterCount).toBe(1)
    expect(completed.hiddenCount).toBe(0)
    expect(row(completed, stale.id).reviewReason).toBe('unknown')
    expect(row(completed, malformed.id).reviewReason).toBe('unknown')
    expect(row(completed, wrongInstance.id).reviewReason).toBe('unknown')
    expect(row(completed, wrongBranch.id).reviewReason).toBe('unknown')
    expect(row(completed, inferredMerged.id).reviewReason).toBe('completed')
    expect(row(completed, missingHead.id).reviewReason).toBe('unknown')
    expect(row(completed, emptyHead.id).reviewReason).toBe('unknown')
    expect(row(completed, rowError.id)).toMatchObject({
      reviewReason: 'unknown',
      reviewError: 'local identity read failed'
    })
    const cacheCall = (await fakeHostingCalls(env.client)).at(-1)!
    expect(cacheCall.worktrees).toHaveLength(16)
    expect(cacheCall.worktrees).toContain(project.main.id)
    expect(cacheCall.worktrees).not.toContain(folder.primary.id)
    expect(new Set(cacheCall.worktrees).size).toBe(cacheCall.worktrees.length)

    await extras(env.client, 'set', {
      hideCompletedReviewWorkspaces: false,
      hidePassingCheckWorkspaces: true
    })
    const passing = await extras<ActivityProjection>(env.client, 'projection')
    expect(ids(passing.reviewHiddenIds)).toEqual(ids([success.id]))
    expect(passing.visibleIds).toContain(project.main.id)
    expect(passing.visibleIds).toContain(merged.id)
    expect(passing.visibleIds).toContain(closed.id)
    expect(passing.visibleIds).toContain(failure.id)
    expect(passing.visibleIds).toContain(pending.id)
    expect(passing.visibleIds).toContain(neutral.id)
    expect(passing.visibleIds).toContain(folder.primary.id)
    expect(passing.filterCount).toBe(1)
  })

  test('unions activity and review visibility while keeping their hidden counts independent', async () => {
    env = await boot({ fakeHosting: true })
    const project = await createGitProject(env.client)
    const merged = await createWorktree(env.client, project.repo.id, 'merged')
    const success = await createWorktree(env.client, project.repo.id, 'success')
    const failure = await createWorktree(env.client, project.repo.id, 'failure')
    const folder = await createFolderProject(env.client)

    await setFakeHostingCache(env.client, [
      cacheEntry(project.main, cachedReview(project.main, 'merged', 'neutral')),
      cacheEntry(merged, cachedReview(merged, 'merged', 'failure')),
      cacheEntry(success, cachedReview(success, 'open', 'success')),
      cacheEntry(failure, cachedReview(failure, 'open', 'failure')),
      cacheEntry(folder.primary, cachedReview(folder.primary, 'closed', 'success'))
    ])
    await extras(env.client, 'activate', { worktree: project.main.id })
    await extras(env.client, 'set', {
      workspaceActivityWindow: 'live-only',
      hideCompletedReviewWorkspaces: true,
      hidePassingCheckWorkspaces: true
    })

    const projection = await extras<ActivityProjection>(env.client, 'projection')
    expect(ids(projection.reviewHiddenIds)).toEqual(ids([project.main.id, merged.id, success.id]))
    expect(projection.reviewHiddenCount).toBe(3)
    expect(projection.hiddenCount).toBe(3)
    expect(ids(projection.hiddenIds)).toEqual(ids([project.main.id, merged.id, success.id, failure.id]))
    expect(projection.hiddenIds.length).toBe(new Set(projection.hiddenIds).size)
    expect(projection.visibleIds).toEqual([folder.primary.id])
    expect(projection.filterCount).toBe(3)
    expect(row(projection, project.main.id).reason).toBe('selected')
    expect(row(projection, project.main.id).reviewReason).toBe('completed')
    expect(row(projection, merged.id).reviewReason).toBe('completed')
    expect(row(projection, success.id).reviewReason).toBe('passing')
    expect(row(projection, folder.primary.id).reason).toBe('folder')
    expect(projection.hiddenCount).toBe(projection.workspaces.filter((workspace) => workspace.reason === 'sleeping').length)
  })

  test('reports ordinary cache failures without treating them as completion or passing', async () => {
    env = await boot({ fakeHosting: true })
    const project = await createGitProject(env.client)
    await extras(env.client, 'set', { hideCompletedReviewWorkspaces: true, hidePassingCheckWorkspaces: true })
    await setFakeHostingCache(env.client, [], 'review cache unavailable')

    const projection = await extras<ActivityProjection>(env.client, 'projection')
    expect(projection.visibleIds).toContain(project.main.id)
    expect(projection.reviewHiddenIds).toEqual([])
    expect(projection.reviewHiddenCount).toBe(0)
    expect(row(projection, project.main.id)).toMatchObject({
      reviewReason: 'unknown',
      reviewError: expect.stringContaining('review cache unavailable')
    })
  })

  test('treats an unavailable optional hosting method as unknown', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    await extras(env.client, 'set', { hideCompletedReviewWorkspaces: true })

    const projection = await extras<ActivityProjection>(env.client, 'projection')
    expect(projection.visibleIds).toContain(project.main.id)
    expect(projection.reviewHiddenIds).toEqual([])
    expect(row(projection, project.main.id).reviewReason).toBe('unknown')
    expect(row(projection, project.main.id).reviewError).toBeUndefined()
  })
})
