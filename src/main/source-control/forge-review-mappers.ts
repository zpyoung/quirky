import type { HostedReviewInfo } from '../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../shared/hosted-review-github'
import type { PRInfo } from '../../shared/github/pull-request-types'
import type { MRInfo } from '../../shared/gitlab-types'

export function mapGitHubReview(pr: PRInfo): HostedReviewInfo {
  return hostedReviewInfoFromGitHubPRInfo(pr)
}

function mapGitLabReviewState(state: MRInfo['state']): HostedReviewInfo['state'] {
  if (state === 'opened' || state === 'locked') {
    return 'open'
  }
  return state
}

export function mapGitLabReview(mr: MRInfo): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number: mr.number,
    title: mr.title,
    state: mapGitLabReviewState(mr.state),
    url: mr.url,
    status: mr.pipelineStatus,
    updatedAt: mr.updatedAt,
    mergeable: mr.mergeable,
    ...(mr.mergeStateStatus !== undefined ? { mergeStateStatus: mr.mergeStateStatus } : {}),
    ...(mr.headSha ? { headSha: mr.headSha } : {}),
    ...(mr.conflictSummary ? { conflictSummary: mr.conflictSummary } : {})
  }
}
