import type { Session, UiPluginContext } from '@quirky/protocol'
import type { Draft } from '../../drafts'
import { WORKTREE_VIEW_ID } from '../model'

/**
 * Resumes an ended chat in the tab that shows it: the resumed session takes over the old one's pane,
 * carrying `draft` with it. A chat no tab shows opens the resumed session in the worktree view instead.
 */
export async function resumeInPlace(context: UiPluginContext, session: Session, draft?: Draft): Promise<Session> {
  const result = (await context.call('quirky.terminal/resumeSession', {
    session: session.id,
    ...(draft === undefined ? {} : { draft })
  })) as { session: Session; pane: string | null }
  if (result.pane === null) context.openView(WORKTREE_VIEW_ID, { worktree: session.worktreeId, session: result.session.id })
  return result.session
}
