import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../../shared/hosted-review-github'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  getWorktreeCardPrDisplay,
  isCachedMergedBranchPRCurrentForWorktree,
  type WorktreeCardPrDisplay
} from '../worktree-card-pr-display'

type ReviewEntry = {
  data: HostedReviewInfo | null
  fetchedAt?: number
  linkedReviewHintKey?: string
  branchLookupGitHubPRNumber?: number | null
}
type PREntry = { data: PRInfo | null; fetchedAt?: number }

export type WorkspaceReviewResolution = {
  prDisplay: WorktreeCardPrDisplay | null
  cachedBranchFallbackGitHubPRNumber: number | null
  linkedGitHubPR: number | null
  linkedGitLabMR: number | null
  effectiveReviewStaleMerged: boolean
}

export function resolveWorkspaceReview(
  worktree: Worktree,
  hostedReviewEntry: ReviewEntry | undefined,
  prCacheEntry: PREntry | undefined
): WorkspaceReviewResolution {
  const hostedReview = hostedReviewEntry?.data
  const linkedGitHubPR = worktree.linkedPR ?? null
  const linkedGitLabMR = worktree.linkedGitLabMR ?? null
  const hasNonGitHubLinkedReview = linkedGitLabMR !== null
  const hasLinkedReview = linkedGitHubPR !== null || linkedGitLabMR !== null
  const cachedBranchPR = prCacheEntry?.data
  const cachedMergedBranchPRMatchesCurrentHead = isCachedMergedBranchPRCurrentForWorktree(
    cachedBranchPR,
    worktree
  )
  const cachedBranchFallbackGitHubPRNumber =
    linkedGitHubPR === null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPR?.number !== undefined &&
    (cachedBranchPR.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead)
      ? cachedBranchPR.number
      : null
  const cachedBranchPRCanDriveDisplay =
    cachedBranchPR?.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead
  const hostedReviewMatchesHeadMatchedCachedMergedPR =
    cachedMergedBranchPRMatchesCurrentHead &&
    cachedBranchPR != null &&
    hostedReview?.provider === 'github' &&
    hostedReview.number === cachedBranchPR.number
  const useCachedBranchReview =
    cachedBranchPR != null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPRCanDriveDisplay &&
    (hostedReview === undefined ||
      (cachedMergedBranchPRMatchesCurrentHead && !hostedReviewMatchesHeadMatchedCachedMergedPR) ||
      (hostedReview === null &&
        ((prCacheEntry?.fetchedAt !== undefined &&
          prCacheEntry.fetchedAt > (hostedReviewEntry?.fetchedAt ?? 0)) ||
          cachedMergedBranchPRMatchesCurrentHead)))
  const cachedBranchReview = useCachedBranchReview
    ? hostedReviewInfoFromGitHubPRInfo(cachedBranchPR)
    : hostedReview
  const branchLookupGitHubPRNumber =
    hostedReview?.provider === 'github' &&
    hostedReview.state === 'merged' &&
    !isCachedMergedBranchPRCurrentForWorktree(hostedReview, worktree)
      ? null
      : hostedReviewEntry?.branchLookupGitHubPRNumber
  const prDisplay = getWorktreeCardPrDisplay(cachedBranchReview, linkedGitHubPR, linkedGitLabMR, {
    reviewHintKey:
      (useCachedBranchReview || cachedMergedBranchPRMatchesCurrentHead) && !hasLinkedReview
        ? ''
        : hostedReviewEntry?.linkedReviewHintKey,
    branchLookupGitHubPRNumber,
    suppressedGitHubPR: worktree.suppressedGitHubPR ?? null
  })
  const effectiveReviewStaleMerged =
    cachedBranchReview?.state === 'merged' &&
    !isCachedMergedBranchPRCurrentForWorktree(cachedBranchReview, worktree)
  return {
    prDisplay,
    cachedBranchFallbackGitHubPRNumber,
    linkedGitHubPR,
    linkedGitLabMR,
    effectiveReviewStaleMerged
  }
}
