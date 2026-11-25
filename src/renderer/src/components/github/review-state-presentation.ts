import { GitMerge, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from 'lucide-react'
import type { HostedReviewState } from '../../../../shared/hosted-review'

/** Every review surface renders state from here; `unknown` means we have a number but no fetched state. */
export type ReviewStateForDisplay = HostedReviewState | 'unknown' | null | undefined

/** Also the tone for an open issue, which reads the same as an open review. */
export const OPEN_REVIEW_STATE_TONE = 'border-agent-done/30 bg-agent-done/10 text-agent-done'

/** Outline-pill tone: purple merged, destructive closed, muted draft, green open, neutral unknown. */
export function getReviewStateTone(state: ReviewStateForDisplay): string {
  if (state === 'merged') {
    return 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300'
  }
  if (state === 'draft') {
    return 'border-border bg-muted/60 text-muted-foreground'
  }
  if (state === 'closed') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  if (state === 'open') {
    return OPEN_REVIEW_STATE_TONE
  }
  return 'border-border bg-background text-muted-foreground'
}

// Why: the glyph must carry review state — tone alone made a draft with failing
// checks render as a red PR icon, which reads as closed.
export function getReviewStateIcon(state: ReviewStateForDisplay): LucideIcon | null {
  if (state === 'merged') {
    return GitMerge
  }
  if (state === 'closed') {
    return GitPullRequestClosed
  }
  if (state === 'draft') {
    return GitPullRequestDraft
  }
  return null
}
