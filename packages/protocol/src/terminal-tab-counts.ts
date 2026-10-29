/** Current layout-owned tabs only; split panes and closed history are not additional tabs. */
export type TerminalTabCount = { worktreeId: string; tabCount: number }

/** A complete batch. Missing IDs mean zero unless their stored layout is unreadable. */
export type TerminalTabCounts = {
  counts: TerminalTabCount[]
  unavailableWorktrees: string[]
}
