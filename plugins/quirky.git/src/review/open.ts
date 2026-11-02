import type { UiPluginContext } from '@quirky/protocol'
import type { DiffViewInput } from '../shared/view-input'
import { activateHostedDiff, openHostedDiff } from '../view/hosted-tabs'
import { reviewViewFor } from '../view/registry'

export { registerReviewView, reviewViewFor, type ReviewViewHandle } from '../view/registry'

/**
 * Shows the worktree's one Review tab. A mounted tab is activated and told where to go without
 * remounting: its scope is set to `commit` (or cleared when none is given), then it reveals
 * `reveal` or scrolls to the top. Otherwise the tab is opened with that input.
 */
export async function openReview(
  context: UiPluginContext,
  input: { worktree: string; reveal?: string; commit?: string | null; noteId?: string }
): Promise<void> {
  const { worktree, reveal, commit, noteId } = input
  const request: DiffViewInput = {
    worktree,
    mode: 'review',
    ...(reveal === undefined ? {} : { reveal }),
    ...(commit ? { commit } : {}),
    ...(noteId === undefined ? {} : { noteId })
  }
  const handle = reviewViewFor(worktree)
  if (handle && (await activateHostedDiff(context, request))) {
    handle.setScope(commit ?? null)
    if (reveal !== undefined) handle.reveal(reveal, noteId)
    else handle.scrollToTop()
    return
  }
  await openHostedDiff(context, request)
}
