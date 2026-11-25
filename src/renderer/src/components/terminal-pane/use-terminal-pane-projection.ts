import { useCallback, useEffect } from 'react'
import type { CSSProperties } from 'react'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  isTerminalBackgroundLight,
  normalizeColor,
  resolveEffectiveTerminalAppearance,
  resolveOpaqueTerminalBackground
} from '@/lib/terminal-theme'
import { stripSshReconnectOwnedErrorLines } from './TerminalErrorToast'
import { agentLaunchPaneOutcomeForLeaf } from './agent-launch-pane-notice-text'
import { mapPaneTerminalErrors, terminalErrorForPane } from './terminal-error-accumulation'
import {
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import { canContinueAgentSessionInNewSession } from './terminal-agent-session-continuation'
import type { TerminalPaneMobileController } from './use-terminal-pane-mobile-actions'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolvePaneAgentSessionId } from './pane-agent-session-id'
import { canPaneOfferResumeInNewChat } from '../tab-bar/tab-session-history-switch'
import { resolveCliChatResumeSource } from '../tab-bar/cli-chat-resume-source'
import { runCliChatResume } from '../tab-bar/cli-chat-resume-run'

export function useTerminalPaneProjection(controller: TerminalPaneMobileController) {
  const {
    applyNativeChatLeafRoute,
    chatLeafId,
    contextMenu,
    contextMenuLeafId,
    getContextMenuLeafId,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    isActive,
    isChatViewMode,
    isVisible,
    managerRef,
    paneTitles,
    resolveTitleAgentForLeaf,
    setTerminalError,
    setTerminalErrorsByPaneId,
    settings,
    shouldMeasureHiddenStartup,
    tabId,
    sshReconnectOwnsTerminalErrors,
    systemPrefersDark,
    tabAgentTypeByLeaf,
    terminalError,
    terminalErrorsByPaneId,
    terminalTab,
    worktreeId
  } = controller
  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null
  const terminalBackground =
    settings?.terminalColorOverrides?.background ?? effectiveAppearance?.theme?.background
  const titleUsesLightSurface = isTerminalBackgroundLight(terminalBackground, {
    appSurface: effectiveAppearance?.mode,
    backgroundOpacity: settings?.terminalBackgroundOpacity
  })
  const paneTitleBackground =
    resolveOpaqueTerminalBackground(terminalBackground, {
      appSurface: effectiveAppearance?.mode,
      backgroundOpacity: settings?.terminalBackgroundOpacity
    }) ?? (titleUsesLightSurface ? '#ffffff' : '#000000')
  const terminalContentVisible = isVisible || shouldMeasureHiddenStartup
  const hiddenStartupStyle: CSSProperties = shouldMeasureHiddenStartup
    ? { opacity: 0, pointerEvents: 'none' }
    : {}
  const terminalContainerStyle: CSSProperties = {
    display: terminalContentVisible ? 'flex' : 'none',
    overflow: 'hidden',
    ...hiddenStartupStyle,
    ['--quirky-terminal-divider-color' as string]:
      effectiveAppearance?.dividerColor ?? DEFAULT_TERMINAL_DIVIDER_DARK,
    ['--quirky-terminal-divider-color-strong' as string]: normalizeColor(
      effectiveAppearance?.dividerColor,
      DEFAULT_TERMINAL_DIVIDER_DARK
    )
  }
  const activePane = managerRef.current?.getActivePane()
  const managedPanes = managerRef.current?.getPanes() ?? []
  const showSshReconnectOverlay = isActive && isVisible && sshReconnectOwnsTerminalErrors
  // Why: SSH reconnect owns its failures even while this tab is hidden; clear only those lines so
  // unrelated pane errors survive and no stale connect failure flashes after recovery.
  useEffect(() => {
    if (!sshReconnectOwnsTerminalErrors) {
      return
    }
    setTerminalError((current) =>
      current === null ? null : stripSshReconnectOwnedErrorLines(current)
    )
    setTerminalErrorsByPaneId((current) =>
      mapPaneTerminalErrors(current, stripSshReconnectOwnedErrorLines)
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [sshReconnectOwnsTerminalErrors])
  const visibleTerminalError = terminalErrorForPane(
    terminalError,
    terminalErrorsByPaneId,
    activePane?.id ?? null
  )
  const visibleLaunchRefusal = agentLaunchPaneOutcomeForLeaf(terminalTab, activePane?.leafId)
  const menuPaneHasCustomTitle =
    contextMenu.menuPaneId !== null && Boolean(paneTitles[contextMenu.menuPaneId])
  const chatLeafStillMounted = chatLeafId
    ? managedPanes.some((pane) => pane.leafId === chatLeafId)
    : false
  useEffect(() => {
    const activeLeafId = activePane?.leafId ?? null
    applyNativeChatLeafRoute(
      resolveNativeChatLeafRoute({
        isChatViewMode,
        chatLeafId,
        activeLeafId,
        chatLeafStillMounted,
        activeLeafIsEligible: false
      })
    )
  }, [
    isChatViewMode,
    chatLeafId,
    activePane?.leafId,
    chatLeafStillMounted,
    applyNativeChatLeafRoute
  ])
  const resolveAgentForLeaf = (leafId: string | null): string | null => {
    const detectedAgent = leafId ? (tabAgentTypeByLeaf[leafId] ?? null) : null
    if (detectedAgent) {
      return detectedAgent
    }
    return (
      nativeChatLaunchAgentForLeaf({
        launchAgent: terminalTab?.launchAgent,
        launchAgentLeafId: getTabWideAgentHintLeafId(),
        leafId,
        leafIds: getNativeChatLeafIds()
      }) ?? resolveTitleAgentForLeaf(leafId)
    )
  }
  const activePaneCanContinueInNewSession = canContinueAgentSessionInNewSession(
    resolveAgentForLeaf(activePane?.leafId ?? null)
  )
  const contextMenuCanContinueInNewSession = canContinueAgentSessionInNewSession(
    resolveAgentForLeaf(contextMenuLeafId)
  )
  const activeLeafId = activePane?.leafId ?? null
  // One subscription for both reads keeps the pane inside its store listener budget.
  const { menuAgentSessionId, activePaneCanResumeInChat, contextMenuCanResumeInChat } = useAppStore(
    useShallow((state) => ({
      menuAgentSessionId:
        contextMenu.open && contextMenuLeafId
          ? resolvePaneAgentSessionId(state, makePaneKey(tabId, contextMenuLeafId))
          : null,
      // Cheap stand-in for the tab menu's gate, on this pane's own conversation; the click looks it up.
      activePaneCanResumeInChat:
        activeLeafId !== null &&
        canPaneOfferResumeInNewChat(state, {
          worktreeId,
          paneKey: makePaneKey(tabId, activeLeafId)
        }),
      contextMenuCanResumeInChat:
        contextMenu.open &&
        contextMenuLeafId !== null &&
        canPaneOfferResumeInNewChat(state, {
          worktreeId,
          paneKey: makePaneKey(tabId, contextMenuLeafId)
        })
    }))
  )
  const handleContextMenuResumeInChat = useCallback(() => {
    const leafId = getContextMenuLeafId()
    if (!leafId) {
      return
    }
    const source = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: tabId, worktreeId },
      paneKey: makePaneKey(tabId, leafId)
    })
    if (source) {
      void runCliChatResume(source, true)
    }
  }, [getContextMenuLeafId, tabId, worktreeId])
  return {
    effectiveAppearance,
    terminalBackground,
    titleUsesLightSurface,
    paneTitleBackground,
    terminalContentVisible,
    hiddenStartupStyle,
    terminalContainerStyle,
    activePane,
    managedPanes,
    showSshReconnectOverlay,
    visibleLaunchRefusal,
    visibleTerminalError,
    menuPaneHasCustomTitle,
    menuAgentSessionId,
    chatLeafStillMounted,
    resolveAgentForLeaf,
    activePaneCanContinueInNewSession,
    contextMenuCanContinueInNewSession,
    activePaneCanResumeInChat,
    contextMenuCanResumeInChat,
    handleContextMenuResumeInChat
  }
}

export type TerminalPaneProjectionController = TerminalPaneMobileController &
  ReturnType<typeof useTerminalPaneProjection>
