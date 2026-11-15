import type { Scope } from '../env'
import type { Review } from '../pr-review'

export type GitLabScope = Scope & {
  provider: 'gitlab'
  apiBase: string
  projectId: string
}

export type GitLabReview = Omit<Review, 'provider'> & {
  provider: 'gitlab'
  detailedMergeStatus: string
}

export type GitLabHandler = (scope: GitLabScope, params: Record<string, unknown>) => unknown
export type GitLabHandlers = Record<string, GitLabHandler>
