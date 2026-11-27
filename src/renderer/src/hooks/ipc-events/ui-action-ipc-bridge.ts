import { dispatchAppCommandWithResult } from '@/lib/app-command-dispatch'
import type { UiStateSnapshot } from '../../../../shared/public-rpc/ui-state'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'

const FOCUS_CHANGE_DEBOUNCE_MS = 250
const TABS_CHANGE_DEBOUNCE_MS = 100
const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i

type AppState = ReturnType<typeof useAppStore.getState>
type SnapshotTab = NonNullable<UiStateSnapshot['tab']>

function snapshotTabType(contentType: string, filePath: string | undefined): SnapshotTab['type'] {
  switch (contentType) {
    case 'terminal':
    case 'browser':
      return contentType
    case 'agent-session':
      return 'chat'
    case 'editor':
      return filePath && MARKDOWN_FILE_PATTERN.test(filePath) ? 'markdown' : 'editor'
    default:
      return 'other'
  }
}

/**
 * The focused tab of a worktree, read from state fields instead of the `getActiveTab` action so
 * observers keep working against partial store state; absent maps mean no active tab.
 */
export function readActiveTab(state: AppState, worktreeId: string): Tab | null {
  const groupId = state.activeGroupIdByWorktree?.[worktreeId]
  const group = state.groupsByWorktree?.[worktreeId]?.find((candidate) => candidate.id === groupId)
  if (!group?.activeTabId) {
    return null
  }
  return (
    state.unifiedTabsByWorktree?.[worktreeId]?.find((tab) => tab.id === group.activeTabId) ?? null
  )
}

/** What the user is looking at, read from the store the same way the window renders it. */
export function buildUiStateSnapshot(state: AppState): UiStateSnapshot {
  const worktreeId = state.activeWorktreeId
  const activeTab = worktreeId ? readActiveTab(state, worktreeId) : null
  const editorFile =
    activeTab?.contentType === 'editor'
      ? (state.openFiles.find((file) => file.id === activeTab.entityId)?.filePath ?? null)
      : null
  return {
    worktreeId,
    view: state.activeView,
    tab: activeTab
      ? {
          id: activeTab.id,
          type: snapshotTabType(activeTab.contentType, editorFile ?? undefined),
          title: activeTab.customLabel ?? activeTab.label
        }
      : null,
    paneId:
      activeTab?.contentType === 'terminal'
        ? (state.terminalLayoutsByTabId[activeTab.entityId]?.activeLeafId ?? null)
        : null,
    panels: {
      leftSidebar: state.sidebarOpen,
      rightSidebar: {
        open: state.rightSidebarOpen,
        tab: state.rightSidebarOpen ? state.rightSidebarTab : null
      },
      floatingTerminal: state.floatingWorkspacePanelOpen
    },
    editorFile
  }
}

type UiTabsSnapshot = Record<string, { id: string; type: SnapshotTab['type'] }[]>

/** Every workspace's open tabs with their public type, in the shape main diffs into tab events. */
export function buildUiTabsSnapshot(state: AppState): UiTabsSnapshot {
  const filePathById = new Map((state.openFiles ?? []).map((file) => [file.id, file.filePath]))
  const snapshot: UiTabsSnapshot = {}
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree ?? {})) {
    snapshot[worktreeId] = tabs.map((tab) => ({
      id: tab.id,
      type: snapshotTabType(tab.contentType, filePathById.get(tab.entityId))
    }))
  }
  return snapshot
}

function focusKey(state: AppState): string {
  const tab = state.activeWorktreeId ? readActiveTab(state, state.activeWorktreeId) : null
  return [state.activeWorktreeId, tab?.id, tab?.contentType, state.activeView].join('\u0000')
}

/**
 * Answers main's requests to run an app action or read UI state, and tells main when the focused
 * workspace, tab or view changes so it can publish `ui` topic events.
 */
export function registerUiActionIpcBridge(unsubs: (() => void)[]): void {
  const ui = window.api.ui

  if (ui.onRequestUiAction && ui.replyUiAction) {
    const reply = ui.replyUiAction
    unsubs.push(
      ui.onRequestUiAction(({ requestId, actionId, worktreeId, hostId, probeOnly }) => {
        const result = dispatchAppCommandWithResult(actionId, 'rpc', {
          ...(worktreeId ? { worktreeId } : {}),
          ...(hostId ? { hostId } : {}),
          ...(probeOnly ? { probeOnly } : {})
        })
        reply({ requestId, ...result })
      })
    )
  }

  if (ui.onRequestUiState && ui.replyUiState) {
    const reply = ui.replyUiState
    unsubs.push(
      ui.onRequestUiState(({ requestId }) => {
        reply({ requestId, state: buildUiStateSnapshot(useAppStore.getState()) })
      })
    )
  }

  if (ui.notifyUiFocusChanged) {
    const notify = ui.notifyUiFocusChanged
    let lastKey = focusKey(useAppStore.getState())
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribeStore = useAppStore.subscribe((state) => {
      const key = focusKey(state)
      if (key === lastKey) {
        return
      }
      lastKey = key
      if (timer !== null) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        const snapshot = buildUiStateSnapshot(useAppStore.getState())
        notify({
          ...(snapshot.worktreeId ? { worktreeId: snapshot.worktreeId } : {}),
          ...(snapshot.tab ? { tabId: snapshot.tab.id, tabType: snapshot.tab.type } : {}),
          view: snapshot.view
        })
      }, FOCUS_CHANGE_DEBOUNCE_MS)
    })
    unsubs.push(unsubscribeStore, () => {
      if (timer !== null) {
        clearTimeout(timer)
      }
    })
  }

  if (ui.notifyUiTabsChanged) {
    const notify = ui.notifyUiTabsChanged
    let lastTabs = useAppStore.getState().unifiedTabsByWorktree
    let timer: ReturnType<typeof setTimeout> | null = null
    // a fresh renderer re-seeds main's tab baseline, so its first report must not read as tabs opening
    notify({ tabs: buildUiTabsSnapshot(useAppStore.getState()), baseline: true })
    const unsubscribeStore = useAppStore.subscribe((state) => {
      if (state.unifiedTabsByWorktree === lastTabs) {
        return
      }
      lastTabs = state.unifiedTabsByWorktree
      if (timer !== null) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        notify({ tabs: buildUiTabsSnapshot(useAppStore.getState()) })
      }, TABS_CHANGE_DEBOUNCE_MS)
    })
    unsubs.push(unsubscribeStore, () => {
      if (timer !== null) {
        clearTimeout(timer)
      }
    })
  }
}
