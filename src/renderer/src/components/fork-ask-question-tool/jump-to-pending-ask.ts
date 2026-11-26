import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { useAppStore } from '@/store'
import type { PendingAskEntry } from './pending-ask-entries'

/**
 * Brings the asking pane to the front through the same reveal the dashboard uses; the Questions
 * panel then follows the focused pane. Returns false when the pane can no longer be shown.
 */
export function jumpToPendingAsk(entry: PendingAskEntry): boolean {
  if (entry.paneClosed || entry.worktreeId === null || entry.tabId === null) {
    return false
  }
  const state = useAppStore.getState()
  state.requestAskPanelReveal()
  return revealTerminalPane({
    worktreeId: entry.worktreeId,
    tabId: entry.tabId,
    leafId: entry.leafId,
    executionHostId: state.getKnownWorktreeById(entry.worktreeId)?.hostId ?? null
  })
}
