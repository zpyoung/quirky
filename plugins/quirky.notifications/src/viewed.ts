import type { UiState } from '@quirky/protocol'

export const WORKTREE_VIEW_ID = 'view:quirky.session/worktree'

/** What the people at the windows are looking at, read from one `ui.state`. */
export type Viewing = {
  /** A window has focus. */
  focused: boolean
  /** A window has focus and its person used it recently. */
  attended: boolean
  /** The worktree whose session view is open, or null. */
  shownWorktree: string | null
  /** The sessions on screen in the shown worktree. */
  visibleSessions: ReadonlySet<string>
}

export const NOT_VIEWING: Viewing = { focused: false, attended: false, shownWorktree: null, visibleSessions: new Set() }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Works out what is on screen. The visible sessions come from the focused window's report for the
 * worktree view, honoured only while that report is about the worktree the layout shows, plus the
 * session the view was opened on.
 */
export function viewingOf(state: UiState): Viewing {
  const window = state.windows.find((candidate) => candidate.focused)
  const input = state.layout.view?.id === WORKTREE_VIEW_ID && isRecord(state.layout.view.input) ? state.layout.view.input : null
  const shownWorktree = typeof input?.worktree === 'string' ? input.worktree : null
  const visible = new Set<string>()
  if (shownWorktree !== null) {
    const report = state.slots.find((slot) => slot.id === WORKTREE_VIEW_ID)?.report
    if (isRecord(report) && report.worktree === shownWorktree && Array.isArray(report.visibleSessions)) {
      for (const id of report.visibleSessions) if (typeof id === 'string') visible.add(id)
    }
    if (typeof input?.session === 'string') visible.add(input.session)
  }
  return { focused: window !== undefined, attended: window?.present === true, shownWorktree, visibleSessions: visible }
}

/** True when a person is attending a window that shows `sessionId`. */
export function sessionViewed(viewing: Viewing, sessionId: string): boolean {
  return viewing.attended && viewing.visibleSessions.has(sessionId)
}

/** True when a person is attending a window whose view is `worktreeId`. */
export function worktreeViewed(viewing: Viewing, worktreeId: string): boolean {
  return viewing.attended && viewing.shownWorktree === worktreeId
}

/** True when a focused window shows `worktreeId`, whether or not its person is present. */
export function worktreeOpenInFocusedWindow(viewing: Viewing, worktreeId: string): boolean {
  return viewing.focused && viewing.shownWorktree === worktreeId
}
