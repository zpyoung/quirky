import { describe, expect, test } from 'bun:test'
import { bootReviews } from './support'
import { isRecord } from '../src/detail/data'
import { detailGhSource, detailSeedState } from './detail-fixture'

type ReviewHarness = {
  worktree: string
  call(name: string, params?: Record<string, unknown>): Promise<unknown>
  invocations(): unknown[]
  cleanup(): Promise<void>
}

async function stateOf(host: ReviewHarness): Promise<Record<string, unknown>> {
  const value = await host.call('state')
  if (!isRecord(value)) throw new Error('reviews state was not an object')
  return value
}

async function openReview(host: ReviewHarness): Promise<void> {
  await host.call('open', { worktree: host.worktree, number: 12, tab: 'conversation' })
}

function detailOf(state: Record<string, unknown>): Record<string, unknown> {
  const detail = state.detail
  if (!isRecord(detail)) throw new Error('detail state was not an object')
  return detail
}

function commentsOf(state: Record<string, unknown>): Record<string, unknown>[] {
  const comments = detailOf(state).comments
  if (!isRecord(comments) || !Array.isArray(comments.comments) || !comments.comments.every(isRecord)) {
    throw new Error('detail comments were unavailable')
  }
  return comments.comments as Record<string, unknown>[]
}

function providerMutations(host: ReviewHarness): unknown[] {
  return host.invocations().filter((value) => {
    if (!isRecord(value) || !Array.isArray(value.args)) return false
    const args = value.args.filter((arg): arg is string => typeof arg === 'string')
    if (args.includes('graphql')) {
      let request: unknown
      try {
        request = JSON.parse(typeof value.input === 'string' ? value.input : '{}')
      } catch {
        return false
      }
      return isRecord(request) && typeof request.query === 'string' && /^\s*mutation\b/.test(request.query)
    }
    const methodIndex = args.findIndex((arg) => arg === '-X' || arg === '--method')
    const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1]?.toUpperCase()
    return args[0] === 'api' && method !== 'GET'
  })
}

function checksRollup(headSha: string, contexts: unknown[] = []): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: headSha,
          commits: {
            nodes: [{
              commit: {
                statusCheckRollup: { contexts: { nodes: contexts } },
                checkSuites: { nodes: [] },
              },
            }],
          },
        },
      },
    },
  }
}

function fileViews(path: string): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          id: 'PR_fixture_12',
          files: {
            nodes: [{ path, viewerViewedState: 'UNVIEWED' }],
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  }
}

async function refreshReview(host: ReviewHarness): Promise<void> {
  await host.call('detailRefresh', { surface: 'detail', worktree: host.worktree, number: 12 })
}



describe('review detail methods', () => {
  test('audience and grouping changes are shared daemon state', async () => {
    const host = await bootReviews(detailGhSource)
    try {
      await openReview(host)
      await host.call('detailSetAudience', { surface: 'detail', worktree: host.worktree, number: 12, audience: 'humans' })
      await host.call('detailSetGrouping', { surface: 'detail', worktree: host.worktree, number: 12, grouping: 'timeline' })
  
      const detail = detailOf(await stateOf(host))
      expect(detail.audience).toBe('humans')
      expect(detail.grouping).toBe('timeline')
      expect(detail.target).toMatchObject({ worktree: host.worktree, number: 12, tab: 'conversation' })
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  test('opening a review retains the selected trusted repository source', async () => {
    const prRepo = { host: 'github.com', owner: 'source-owner', repo: 'source-repo' }
    const host = await bootReviews(detailGhSource, { remote: 'https://github.com/source-owner/source-repo.git' })
    try {
      await host.call('open', { worktree: host.worktree, number: 12, tab: 'files', prRepo })
      const state = await stateOf(host)
      const detailValue = state.detail
      if (typeof detailValue !== 'object' || detailValue === null || Array.isArray(detailValue)) {
        throw new Error('detail state was not an object')
      }
      const detail = detailValue as Record<string, unknown>
      const targetValue = detail.target
      if (typeof targetValue !== 'object' || targetValue === null || Array.isArray(targetValue)) {
        throw new Error('review target was not an object')
      }
      expect((targetValue as Record<string, unknown>).prRepo).toEqual(prRepo)
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  test('inline comments fail closed when the selected review has no verified head', async () => {
    const host = await bootReviews(detailGhSource)
    try {
      await openReview(host)
      const before = host.invocations().length
      await expect(host.call('detailInlineComment', {
        surface: 'detail',
        worktree: host.worktree,
        number: 12,
        expectedHead: 'a'.repeat(40),
        path: 'src/index.ts',
        line: 3,
        startLine: 2,
        body: 'Please check this range.'
      })).rejects.toThrow()
      expect(host.invocations()).toHaveLength(before)
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  test('comment deletion is refused before any provider call without exact-target confirmation', async () => {
    const host = await bootReviews(detailGhSource)
    try {
      await openReview(host)
      const before = host.invocations().length
      await expect(host.call('detailDeleteComment', { surface: 'detail', worktree: host.worktree, number: 12, commentId: 91 })).rejects.toThrow()
      expect(host.invocations()).toHaveLength(before)
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  test('confirmed comment writes reconcile when subsequent provider reads lag', async () => {
    const issueUrl = 'https://api.github.com/repos/source-owner/source-repo/issues/12'
    const oldComment = {
      id: 'IC_fixture_91',
      databaseId: 91,
      body: 'Original comment',
      createdAt: '2026-10-27T00:00:00Z',
      url: 'https://github.com/source-owner/source-repo/pull/12#issuecomment-91',
      author: { login: 'fixture-human', __typename: 'User' },
      reactionGroups: [],
    }
    const host = await bootReviews(detailGhSource, { remote: 'https://github.com/source-owner/source-repo.git' })
    host.writeState(detailSeedState({
      graphqlResponses: {
        HostingComments: {
          data: {
            repository: {
              pullRequest: {
                id: 'PR_fixture_12',
                comments: { nodes: [oldComment], pageInfo: { hasNextPage: false } },
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          },
        },
      },
      responses: {
        'GET repos/source-owner/source-repo/issues/comments/91': { id: 91, issue_url: issueUrl },
        'POST repos/source-owner/source-repo/issues/12/comments': {
          id: 92,
          body: 'hello **team**',
          user: { login: 'fixture-user', type: 'User' },
          created_at: '2026-10-27T00:01:00Z',
          html_url: 'https://github.com/source-owner/source-repo/issues/12#issuecomment-92',
        },
        'PATCH repos/source-owner/source-repo/issues/comments/91': {
          id: 91,
          body: 'Edited comment',
          user: { login: 'fixture-human', type: 'User' },
          created_at: '2026-10-27T00:00:00Z',
          html_url: 'https://github.com/source-owner/source-repo/issues/12#issuecomment-91',
        },
        'DELETE repos/source-owner/source-repo/issues/comments/91': {},
      },
    }))
    try {
      await openReview(host)
      await refreshReview(host)
      expect(commentsOf(await stateOf(host))).toEqual([
        expect.objectContaining({ id: 91, body: 'Original comment' }),
      ])
  
      const mutationsBefore = providerMutations(host).length
      const posted = await host.call('detailPostComment', {
        surface: 'detail', worktree: host.worktree, number: 12, body: 'hello **team**',
      })
      expect(posted).toMatchObject({
        number: 12,
        comment: { id: 92, kind: 'issue_comment', body: 'hello **team**' },
      })
      await refreshReview(host)
      expect(commentsOf(await stateOf(host))).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 91, body: 'Original comment' }),
        expect.objectContaining({ id: 92, body: 'hello **team**' }),
      ]))
  
      await host.call('detailEditComment', {
        surface: 'detail', worktree: host.worktree, number: 12, commentId: 91, body: 'Edited comment',
      })
      await refreshReview(host)
      expect(commentsOf(await stateOf(host))).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 91, body: 'Edited comment' }),
        expect.objectContaining({ id: 92, body: 'hello **team**' }),
      ]))
  
      await host.call('detailDeleteComment', {
        surface: 'detail', worktree: host.worktree, number: 12, commentId: 91, yes: true,
      })
      await refreshReview(host)
      expect(commentsOf(await stateOf(host))).toEqual([
        expect.objectContaining({ id: 92, body: 'hello **team**' }),
      ])
      expect(providerMutations(host)).toHaveLength(mutationsBefore + 3)
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  test('old review context cannot mutate a newly selected pull request', async () => {
    const seed = detailSeedState()
    const responses = seed.responses as Record<string, unknown>
    const original = responses['GET repos/source-owner/source-repo/pulls/12'] as Record<string, unknown>
    const pullRequest13 = {
      ...original,
      number: 13,
      html_url: 'https://github.com/source-owner/source-repo/pull/13',
      url: 'https://api.github.com/repos/source-owner/source-repo/pulls/13',
    }
    const host = await bootReviews(detailGhSource, { remote: 'https://github.com/source-owner/source-repo.git' })
    host.writeState({
      ...seed,
      responses: { ...responses, 'GET repos/source-owner/source-repo/pulls/13': pullRequest13 },
    })
    try {
      await openReview(host)
      await refreshReview(host)
      await host.call('open', { worktree: host.worktree, number: 13, tab: 'conversation' })
      await host.call('detailRefresh', { surface: 'detail', worktree: host.worktree, number: 13 })
      const detail = detailOf(await stateOf(host))
      expect(detail.target).toMatchObject({ worktree: host.worktree, number: 13 })
      expect(detail.review).toMatchObject({ number: 13 })
  
      const mutationsBefore = providerMutations(host).length
      await expect(host.call('detailUpdateBody', {
        surface: 'detail', worktree: host.worktree, number: 12, body: 'stale review edit',
      })).rejects.toMatchObject({ data: { reason: 'stale_target' } })
      expect(providerMutations(host)).toHaveLength(mutationsBefore)
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  test('same-number review actions from a prior repository source cannot retarget the current review', async () => {
    const source = { host: 'github.com', owner: 'source-owner', repo: 'source-repo' }
    const upstream = { host: 'github.com', owner: 'upstream-owner', repo: 'upstream-repo' }
    const seed = detailSeedState()
    const responses = seed.responses as Record<string, unknown>
    const original = responses['GET repos/source-owner/source-repo/pulls/12'] as Record<string, unknown>
    const upstreamReview = {
      ...original,
      html_url: 'https://github.com/upstream-owner/upstream-repo/pull/12',
      url: 'https://api.github.com/repos/upstream-owner/upstream-repo/pulls/12',
    }
    const host = await bootReviews(detailGhSource, {
      remote: 'https://github.com/source-owner/source-repo.git',
      upstream: 'https://github.com/upstream-owner/upstream-repo.git',
    })
    host.writeState({
      ...seed,
      responses: {
        ...responses,
        'GET repos/upstream-owner/upstream-repo/pulls/12': upstreamReview,
      },
    })
    try {
      await host.call('open', { worktree: host.worktree, number: 12, tab: 'conversation', prRepo: source })
      await host.call('detailRefresh', { surface: 'detail', worktree: host.worktree, number: 12, prRepo: source })
      await host.call('open', { worktree: host.worktree, number: 12, tab: 'conversation', prRepo: upstream })
      await host.call('detailRefresh', { surface: 'detail', worktree: host.worktree, number: 12, prRepo: upstream })
      expect(detailOf(await stateOf(host)).target).toMatchObject({ prRepo: upstream, number: 12 })
  
      const mutationsBefore = providerMutations(host).length
      await expect(host.call('detailUpdateBody', {
        surface: 'detail', worktree: host.worktree, number: 12, prRepo: source, body: 'stale source edit',
      })).rejects.toMatchObject({ data: { reason: 'source_mismatch' } })
      expect(providerMutations(host)).toHaveLength(mutationsBefore)
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  test('a head refresh invalidates old file coordinates before inline comments reach the provider', async () => {
    const headA = 'a'.repeat(40)
    const headB = 'c'.repeat(40)
    const oldPath = 'src/old.ts'
    const newPath = 'src/new.ts'
    const filesRoute = 'GET repos/source-owner/source-repo/pulls/12/files'
    const pullRoute = 'GET repos/source-owner/source-repo/pulls/12'
    const oldFile = { filename: oldPath, status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n keep\n+old' }
    const newFile = { filename: newPath, status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n keep\n+new' }
    const initial = detailSeedState({
      responses: { [filesRoute]: [oldFile] },
      graphqlResponses: {
        HostingChecksRollup: checksRollup(headA),
        HostingFileViews: fileViews(oldPath),
      },
    })
    const initialResponses = initial.responses as Record<string, unknown>
    const originalPullRequest = initialResponses[pullRoute] as Record<string, unknown>
    const originalHead = originalPullRequest.head as Record<string, unknown>
    const nextPullRequest = {
      ...originalPullRequest,
      head: { ...originalHead, sha: headB },
      headRefOid: headB,
    }
    const host = await bootReviews(detailGhSource, { remote: 'https://github.com/source-owner/source-repo.git' })
    host.writeState(initial)
    try {
      await openReview(host)
      await refreshReview(host)
      await host.call('detailSetFilesView', {
        worktree: host.worktree,
        number: 12,
        fileFilter: '',
        diffMode: 'side-by-side',
        selectedFile: oldPath,
        collapsedFiles: [oldPath],
        treeVisible: false,
      })
  
      host.writeState({
        ...initial,
        responses: {
          ...initialResponses,
          [pullRoute]: nextPullRequest,
          [filesRoute]: [newFile],
        },
        graphqlResponses: {
          ...(initial.graphqlResponses as Record<string, unknown>),
          HostingChecksRollup: checksRollup(headB),
          HostingFileViews: fileViews(newPath),
        },
      })
      await refreshReview(host)
      const detail = detailOf(await stateOf(host))
      expect(detail.review).toMatchObject({ headRefOid: headB })
      expect(detail.selectedFile).toBeNull()
      expect(detail.collapsedFiles).toEqual([])
      expect(detail.files).toMatchObject({ files: [{ path: newPath }] })
  
      const mutationsBefore = providerMutations(host).length
      await expect(host.call('detailInlineComment', {
        surface: 'detail', worktree: host.worktree, number: 12, expectedHead: headA,
        path: oldPath, line: 2, body: 'comment on stale head',
      })).rejects.toMatchObject({ data: { reason: 'stale_head' } })
      await expect(host.call('detailInlineComment', {
        surface: 'detail', worktree: host.worktree, number: 12, expectedHead: headB,
        path: oldPath, line: 2, body: 'comment on stale file',
      })).rejects.toMatchObject({ data: { reason: 'invalid_coordinates' } })
      await expect(host.call('detailInlineComment', {
        surface: 'detail', worktree: host.worktree, number: 12, expectedHead: headB,
        path: newPath, line: 99, body: 'comment outside diff',
      })).rejects.toMatchObject({ data: { reason: 'invalid_coordinates' } })
      expect(providerMutations(host)).toHaveLength(mutationsBefore)
    } finally {
      await host.cleanup()
    }
  }, 20_000)

  test('legacy status-only checks surface the canonical non-rerunnable error', async () => {
    const head = 'a'.repeat(40)
    const host = await bootReviews(detailGhSource, { remote: 'https://github.com/source-owner/source-repo.git' })
    host.writeState(detailSeedState({
      graphqlResponses: {
        HostingChecksRollup: checksRollup(head, [
          { __typename: 'StatusContext', context: 'legacy-ci', state: 'FAILURE' },
        ]),
      },
    }))
    try {
      await openReview(host)
      await refreshReview(host)
      const current = detailOf(await stateOf(host))
      expect(current.checks).toMatchObject({
        checks: [{ kind: 'status', name: 'legacy-ci', checkRunId: null, workflowRunId: null }],
      })
  
      const mutationsBefore = providerMutations(host).length
      await expect(host.call('detailRerunChecks', {
        surface: 'detail', worktree: host.worktree, number: 12, failedOnly: true,
      })).rejects.toMatchObject({ data: { reason: 'legacy_status_only' } })
      expect(providerMutations(host)).toHaveLength(mutationsBefore)
      const after = detailOf(await stateOf(host))
      expect(typeof after.error).toBe('string')
      expect(after.error).not.toBe('')
    } finally {
      await host.cleanup()
    }
  }, 20_000)

})
