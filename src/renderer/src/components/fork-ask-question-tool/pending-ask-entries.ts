import type { AskCardModel } from '../../store/slices/fork-ask-question-tool/asks'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isTerminalAskStatus } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'

export type PendingAskEntry = {
  askId: string
  paneKey: string
  worktreeId: string | null
  worktreeLabel: string | null
  tabId: string | null
  leafId: string | null
  tabTitle: string | null
  question: string | null
  /** The pane (or its tab) is gone, so there is nowhere to jump to. */
  paneClosed: boolean
}

type PendingAskEntriesState = {
  pendingAsksByPaneKey: Record<string, readonly AskCardModel[]>
  tabsByWorktree: Record<
    string,
    readonly { id: string; title: string; customTitle: string | null }[] | undefined
  >
  terminalLayoutsByTabId: Record<string, { root: TerminalPaneLayoutNode | null } | undefined>
  getKnownWorktreeById: (worktreeId: string) => { displayName: string } | null | undefined
}

function findTab(
  state: PendingAskEntriesState,
  tabId: string,
  preferredWorktreeId: string | null | undefined
): { worktreeId: string; title: string } | null {
  const search = preferredWorktreeId
    ? [[preferredWorktreeId, state.tabsByWorktree[preferredWorktreeId]] as const]
    : Object.entries(state.tabsByWorktree ?? {})
  for (const [worktreeId, tabs] of search) {
    const tab = tabs?.find((candidate) => candidate.id === tabId)
    if (tab) {
      return { worktreeId, title: tab.customTitle ?? tab.title }
    }
  }
  return null
}

/** Every unanswered ask across all panes, in registration order, with where it lives. */
export function buildPendingAskEntries(state: PendingAskEntriesState): PendingAskEntry[] {
  const entries: PendingAskEntry[] = []
  for (const [paneKey, cards] of Object.entries(state.pendingAsksByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    for (const card of cards) {
      if (isTerminalAskStatus(card.status)) {
        continue
      }
      const tab = parsed ? findTab(state, parsed.tabId, card.worktreeId) : null
      const layout = parsed ? state.terminalLayoutsByTabId?.[parsed.tabId] : undefined
      const leafGone =
        parsed !== null &&
        layout?.root != null &&
        !collectLeafIds(layout.root).includes(parsed.leafId)
      const worktreeId = tab?.worktreeId ?? card.worktreeId ?? null
      entries.push({
        askId: card.askId,
        paneKey,
        worktreeId,
        worktreeLabel: worktreeId
          ? (state.getKnownWorktreeById(worktreeId)?.displayName ?? null)
          : null,
        tabId: parsed?.tabId ?? null,
        leafId: parsed?.leafId ?? null,
        tabTitle: tab?.title ?? null,
        question: card.spec?.questions[0]?.question ?? null,
        paneClosed: tab === null || leafGone
      })
    }
  }
  return entries
}
