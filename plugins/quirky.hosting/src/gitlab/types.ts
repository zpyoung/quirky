import type { PluginCaller } from '@quirky/protocol'
import type { BeginReviewSnapshot, Review } from '../pr-review'
import type { Scope } from '../env'

export type GitLabScope = Scope & {
  provider: 'gitlab'
  apiBase: string
  projectId: string
}

export type GitLabReview = Omit<Review, 'provider'> & {
  provider: 'gitlab'
  detailedMergeStatus: string
}

export type GitLabHandler = (
  scope: GitLabScope,
  params: Record<string, unknown>,
  caller?: PluginCaller,
  beginReviewSnapshot?: BeginReviewSnapshot
) => unknown
export type GitLabHandlers = Record<string, GitLabHandler>
