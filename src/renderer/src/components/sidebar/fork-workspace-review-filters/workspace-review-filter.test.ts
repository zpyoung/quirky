import { describe, expect, it } from 'vitest'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import type { Repo } from '../../../../../shared/repo-types'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  filterWorktreesByReview,
  type WorkspaceReviewFilterContext
} from './workspace-review-filter'

const repo = { id: 'repo', path: '/repo', connectionId: null, executionHostId: 'local' } as Repo
const settings = null
const baseWorktree = {
  id: 'repo::feature',
  repoId: 'repo',
  hostId: 'local',
  path: '/repo/.worktrees/feature',
  head: 'head-current',
  branch: 'feature',
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  suppressedGitHubPR: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
} as Worktree
const key = getHostedReviewCacheKey(
  repo.path,
  'feature',
  settings,
  repo.id,
  repo.connectionId,
  repo.executionHostId,
  true
)
const review = (overrides: Partial<HostedReviewInfo> = {}) =>
  ({
    provider: 'github',
    number: 7,
    title: 'review',
    state: 'open',
    url: '',
    status: 'failure',
    updatedAt: '',
    mergeable: 'MERGEABLE',
    ...overrides
  }) as HostedReviewInfo
const context = (
  hostedReviewCache: WorkspaceReviewFilterContext['hostedReviewCache'],
  hideCompleted = true,
  hidePassing = false
): WorkspaceReviewFilterContext => ({
  hideCompletedReviewWorkspaces: hideCompleted,
  hidePassingCheckWorkspaces: hidePassing,
  hostedReviewCache,
  prCache: {}
})

describe('filterWorktreesByReview', () => {
  it('fails open for stale merged head and data null precedence', () => {
    const stale = review({ state: 'merged', headSha: 'old-head' })
    expect(
      filterWorktreesByReview(
        [baseWorktree],
        context({ [key]: { data: stale, fetchedAt: 3 } }),
        new Map([[repo.id, repo]])
      )
    ).toEqual([baseWorktree])
    expect(
      filterWorktreesByReview(
        [baseWorktree],
        context({ [key]: { data: null, fetchedAt: 4 } }),
        new Map([[repo.id, repo]])
      )
    ).toEqual([baseWorktree])
  })

  it('does not hide other-provider linked placeholders', () => {
    const linked = { ...baseWorktree, linkedGitLabMR: 9 } as Worktree
    const stale = review({ state: 'merged', headSha: 'head-current' })
    expect(
      filterWorktreesByReview(
        [linked],
        context({ [key]: { data: stale, fetchedAt: 1 } }),
        new Map([[repo.id, repo]])
      )
    ).toEqual([linked])
  })

  it('hides normalized success checks and leaves unknown reviews visible', () => {
    const passing = review({ status: 'success' })
    const gitlabPassing = review({ provider: 'gitlab', status: 'success' })
    expect(
      filterWorktreesByReview(
        [baseWorktree],
        context({ [key]: { data: passing, fetchedAt: 1, linkedReviewHintKey: '' } }, false, true),
        new Map([[repo.id, repo]])
      )
    ).toEqual([])
    expect(
      filterWorktreesByReview(
        [baseWorktree],
        context(
          { [key]: { data: gitlabPassing, fetchedAt: 1, linkedReviewHintKey: '' } },
          false,
          true
        ),
        new Map([[repo.id, repo]])
      )
    ).toEqual([])
    expect(
      filterWorktreesByReview(
        [baseWorktree],
        context(
          { [key]: { data: review({ status: 'pending' }), fetchedAt: 1, linkedReviewHintKey: '' } },
          false,
          true
        ),
        new Map([[repo.id, repo]])
      )
    ).toEqual([baseWorktree])
  })
})
