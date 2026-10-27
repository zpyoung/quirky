import type { UiState } from '@quirky/protocol'

export const WORKTREE_VIEW_ID = 'view:quirky.session/worktree'
export const FLOATING_OVERLAY_ID = 'overlay:quirky.terminal/floating'

/** What the people at the windows are looking at, read from one `ui.state`. */
export type Viewing = {
  /** A window has focus. */
  focused: boolean
  /** A window has focus and its person used it recently. */
  attended: boolean
  /** The worktree whose session view is open, or null. */
  shownWorktree: string | null
  /** The sessions on screen: those of the shown worktree and of the open floating workspace. */
  visibleSessions: ReadonlySet<string>
}

export const NOT_VIEWING: Viewing = { focused: false, attended: false, shownWorktree: null, visibleSessions: new Set() }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sessionIds = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])

/**
 * Works out what is on screen. The visible sessions are the union of the worktree view's report
 * (honoured only while it is about the worktree the layout shows), the session the view was opened
 * on, and the floating workspace's report while that panel is open, whichever worktree is shown.
 */
export function viewingOf(state: UiState): Viewing {
  const window = state.windows.find((candidate) => candidate.focused)
  const input = state.layout.view?.id === WORKTREE_VIEW_ID && isRecord(state.layout.view.input) ? state.layout.view.input : null
  const shownWorktree = typeof input?.worktree === 'string' ? input.worktree : null
  const visible = new Set<string>()
  if (shownWorktree !== null) {
    const report = state.slots.find((slot) => slot.id === WORKTREE_VIEW_ID)?.report
    if (isRecord(report) && report.worktree === shownWorktree) for (const id of sessionIds(report.visibleSessions)) visible.add(id)
    if (typeof input?.session === 'string') visible.add(input.session)
  }
  const floating = state.slots.find((slot) => slot.id === FLOATING_OVERLAY_ID)?.report
  if (isRecord(floating) && floating.shown === true) for (const id of sessionIds(floating.visibleSessions)) visible.add(id)
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
