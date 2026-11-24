import type { HostedReviewProvider } from '../../../../shared/hosted-review'

type WorktreeReviewLink = Partial<{
  linkedPR: number
  linkedGitLabMR: number
}>

type HostedReviewLookupLink = Partial<{
  linkedGitHubPR: number
  linkedGitLabMR: number
}>

export type CreatedHostedReviewLink = {
  worktree: WorktreeReviewLink
  lookup: HostedReviewLookupLink
}

export function resolveCreatedHostedReviewLink(
  provider: HostedReviewProvider,
  number: number
): CreatedHostedReviewLink {
  switch (provider) {
    case 'github':
      return { worktree: { linkedPR: number }, lookup: { linkedGitHubPR: number } }
    case 'gitlab':
      return { worktree: { linkedGitLabMR: number }, lookup: { linkedGitLabMR: number } }
    case 'unsupported':
      return { worktree: {}, lookup: {} }
  }
}
