import type { CheckState, ReviewState } from './pr-review'

/** Cache-only sidebar facts; no provider lookup or auth probe is permitted while reading. */
export type CachedWorkspaceReview = {
  worktreeId: string
  instanceId: string
  branch: string | null
  headOid: string | null
  review: {
    state: ReviewState
    checksStatus: CheckState
    headRefOid: string
    number: number
    url: string
  } | null
  stale: boolean
  error?: string
}

export type CachedReviewsResult = { workspaces: CachedWorkspaceReview[] }
