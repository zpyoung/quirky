import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import { selectTerminalTabAgentTypesByLeaf } from './terminal-tab-agent-type-index'
import { collectLeafIdsInOrder, EMPTY_LAYOUT } from './layout-serialization'
import { sanitizeTerminalLayoutPaneTitles } from '../../../../shared/terminal-pane-title-sanitization'
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import { selectUnifiedTerminalTabFields } from './terminal-unified-tab-lookup'
import {
  resolveNativeChatLeafRoute,
  type NativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import type { TerminalPaneTitleController } from './use-terminal-pane-title-state'
import { notifyTerminalDockConfirmedAgentExit } from './fork-terminal-dock/terminal-dock-controller-bridge'

export function useTerminalPaneChatState(controller: TerminalPaneTitleController) {
  const {
    chatLeafId,
    managerRef,
    onAgentExitedRef,
    paneCount,
    setChatLeafId,
    setTabWideAgentHintLeafId,
    tabId,
    tabWideAgentHintLeafId,
    worktreeId
  } = controller
  const {
    clearCodexRestartNotice,
    consumePendingPaneAccountRestart,
    setTabCanExpandPane,
    setTabLayout,
    setTabPaneExpanded,
    setTabViewMode,
    suppressPtyExit
  } = useTerminalPaneStoreActions()
  // Why one selector: five separate subscriptions each re-read the same unified
  // tab, so one publication paid the lookup five times per mounted tab.
  const { unifiedTabId, isChatViewMode, unifiedTabLabel, isTabPinned } = useAppStore(
    useShallow((store) =>
      selectUnifiedTerminalTabFields(store.unifiedTabsByWorktree, worktreeId, tabId)
    )
  )
  const effectiveChatViewMode = isChatViewMode
  // Terminals stay terminals: a tab saved in the removed chat view mode returns to its terminal.
  useEffect(() => {
    if (isChatViewMode && unifiedTabId) {
      setChatLeafId(null)
      setTabViewMode(unifiedTabId, 'terminal')
    }
  }, [isChatViewMode, setChatLeafId, setTabViewMode, unifiedTabId])
  const runtimePaneTitlesByPaneId = useAppStore(
    useShallow((store) => store.runtimePaneTitlesByTabId[tabId] ?? {})
  )
  const tabAgentTypeByLeaf = useAppStore((store) =>
    selectTerminalTabAgentTypesByLeaf(
      store.agentStatusByPaneKey,
      tabId,
      store.paneForegroundAgentByPaneKey
    )
  )
  const savedLayout = useAppStore((store) => store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const terminalTab = useAppStore((store) =>
    getCachedTerminalTabForWorktree(store.tabsByWorktree, worktreeId, tabId)
  )
  const restoredLayout = useMemo(
    () => (terminalTab ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab) : savedLayout),
    [savedLayout, terminalTab]
  )
  const expectedLayoutLeafIds = useMemo(
    () => collectLeafIdsInOrder(restoredLayout.root),
    [restoredLayout.root]
  )
  const getNativeChatLeafIds = useCallback((): string[] => {
    const mountedLeafIds = managerRef.current?.getPanes().map((pane) => pane.leafId) ?? []
    return [...new Set([...expectedLayoutLeafIds, ...mountedLeafIds])]
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [expectedLayoutLeafIds])
  const getTabWideAgentHintLeafId = useCallback((): string | null => {
    if (tabWideAgentHintLeafId !== undefined) {
      return tabWideAgentHintLeafId
    }
    const leafIds = getNativeChatLeafIds()
    return leafIds.length === 1 ? leafIds[0] : null
  }, [getNativeChatLeafIds, tabWideAgentHintLeafId])
  const getTabWideAgentHintLeafIdRef = useRef(getTabWideAgentHintLeafId)
  useEffect(() => {
    getTabWideAgentHintLeafIdRef.current = getTabWideAgentHintLeafId
  }, [getTabWideAgentHintLeafId])
  useEffect(() => {
    if (tabWideAgentHintLeafId !== undefined) {
      return
    }
    const leafIds = getNativeChatLeafIds()
    if (leafIds.length === 0) {
      return
    }
    setTabWideAgentHintLeafId(leafIds.length === 1 ? leafIds[0] : null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [getNativeChatLeafIds, paneCount, tabWideAgentHintLeafId])
  const resolveTitleAgentForLeaf = useCallback(
    (leafId: string | null) => {
      const hasSingleKnownLeaf =
        getNativeChatLeafIds().length === 1 && getTabWideAgentHintLeafId() === leafId
      return resolveNativeChatLeafTitleAgent({
        leafId,
        panes: managerRef.current?.getPanes() ?? [],
        runtimePaneTitlesByPaneId,
        tabLabel: hasSingleKnownLeaf ? unifiedTabLabel : null,
        terminalTitle: hasSingleKnownLeaf ? terminalTab?.title : null
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      runtimePaneTitlesByPaneId,
      terminalTab?.title,
      unifiedTabLabel
    ]
  )
  const applyNativeChatLeafRoute = useCallback(
    (route: NativeChatLeafRoute): void => {
      const state = useAppStore.getState()
      const currentMode = selectUnifiedTerminalTabFields(
        state.unifiedTabsByWorktree,
        worktreeId,
        tabId
      ).isChatViewMode
      if (!isChatViewMode && currentMode && chatLeafId && route.chatLeafId === null) {
        // Keep the owner through the batched toggle that turns chat mode on.
        return
      }
      if (route.chatLeafId !== chatLeafId) {
        setChatLeafId(route.chatLeafId)
      }
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId]
      if (existingLayout && existingLayout.chatLeafId !== (route.chatLeafId ?? undefined)) {
        if (route.chatLeafId) {
          setTabLayout(tabId, { ...existingLayout, chatLeafId: route.chatLeafId })
        } else if (existingLayout?.chatLeafId) {
          const nextLayout = { ...existingLayout }
          delete nextLayout.chatLeafId
          setTabLayout(tabId, nextLayout)
        }
      }
      if (route.exitChat && unifiedTabId) {
        setTabViewMode(unifiedTabId, 'terminal')
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [chatLeafId, isChatViewMode, setTabLayout, setTabViewMode, tabId, unifiedTabId, worktreeId]
  )
  const handleConfirmedAgentExit = useCallback(
    (leafId: string): void => {
      if (leafId !== chatLeafId) {
        return
      }
      const panes = managerRef.current?.getPanes() ?? []
      const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
      applyNativeChatLeafRoute(
        resolveNativeChatLeafRoute({
          isChatViewMode,
          chatLeafId,
          activeLeafId,
          chatLeafStillMounted: panes.some((pane) => pane.leafId === chatLeafId),
          activeLeafIsEligible: false,
          chatLeafHasConfirmedAgentExit: true
        })
      )
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [applyNativeChatLeafRoute, chatLeafId, isChatViewMode]
  )
  useEffect(() => {
    onAgentExitedRef.current = (leafId: string) => {
      handleConfirmedAgentExit(leafId)
      notifyTerminalDockConfirmedAgentExit(tabId, leafId)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [handleConfirmedAgentExit, tabId])
  return {
    setTabPaneExpanded,
    setTabCanExpandPane,
    suppressPtyExit,
    consumePendingPaneAccountRestart,
    clearCodexRestartNotice,
    unifiedTabId,
    isChatViewMode,
    effectiveChatViewMode,
    unifiedTabLabel,
    isTabPinned,
    runtimePaneTitlesByPaneId,
    tabAgentTypeByLeaf,
    setTabViewMode,
    savedLayout,
    terminalTab,
    restoredLayout,
    expectedLayoutLeafIds,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    getTabWideAgentHintLeafIdRef,
    resolveTitleAgentForLeaf,
    applyNativeChatLeafRoute
  }
}

export type TerminalPaneChatController = TerminalPaneTitleController &
  ReturnType<typeof useTerminalPaneChatState>
