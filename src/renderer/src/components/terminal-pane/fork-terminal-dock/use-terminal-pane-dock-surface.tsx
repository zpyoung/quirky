import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import type { TerminalPaneController } from '../use-terminal-pane-controller'
import { TerminalPaneDockMount } from './TerminalPaneDockMount'
import { useTerminalPaneDock } from './use-terminal-pane-dock'
import {
  resolveRemoteDockConptyUnverifiedForWorktree,
  restampRemoteDockConptyUnverifiedForLivePanes
} from './terminal-dock-remote-conpty'
import {
  getTerminalDockRawRecoveryPhases,
  registerTerminalDockControllerBridge,
  subscribeTerminalDockRawRecoveryPhases
} from './terminal-dock-controller-bridge'

export type TerminalPaneDockContextMenuProps = {
  canToggleTerminalDock: boolean
  isTerminalDockDocked: boolean
  onToggleTerminalDock: () => void
}

/**
 * Hosts the terminal dock from the pane's view layer.
 *
 * Upstream pins the controller chain's hook order, listener order, and per-pane store
 * subscriptions with exact-equality ratchets over the files beside `TerminalPane.tsx`, so the
 * dock's own hooks run here — in the Surface, outside all three — and the chain reaches back
 * through the module-level bridge this hook registers.
 */
export function useTerminalPaneDockSurface(controller: TerminalPaneController): {
  dockMounts: React.ReactNode
  contextMenuProps: TerminalPaneDockContextMenuProps
} {
  const {
    containerRef,
    contextMenuLeafId,
    effectiveChatViewMode,
    managedPanes,
    managerRef,
    paneTransportsRef,
    resolveAgentForLeaf,
    setPaneLayoutRevision,
    sshReconnectStatus,
    sshReconnectTargetId,
    tabId,
    worktreeId
  } = controller
  const experimentalTerminalDockEnabled = useAppStore(
    (store) => store.settings?.experimentalTerminalDock === true
  )
  const terminalDock = useTerminalPaneDock({
    tabId,
    worktreeId,
    enabled: experimentalTerminalDockEnabled && !effectiveChatViewMode,
    managerRef,
    containerRef
  })
  const dockRawRecoveryPhaseByPaneId = useSyncExternalStore(
    useMemo(
      () => (listener: () => void) => subscribeTerminalDockRawRecoveryPhases(tabId, listener),
      [tabId]
    ),
    useMemo(() => () => getTerminalDockRawRecoveryPhases(tabId), [tabId])
  )
  const { notePanePtyBindingChanged, paneDockOwnsFocus } = terminalDock
  const { prunePassthroughForRetiredPane, undockOnConfirmedAgentExit } = terminalDock
  useEffect(
    () =>
      registerTerminalDockControllerBridge(tabId, {
        paneDockOwnsFocus,
        notePanePtyBindingChanged,
        undockOnConfirmedAgentExit,
        prunePassthroughForRetiredPane
      }),
    [
      notePanePtyBindingChanged,
      paneDockOwnsFocus,
      prunePassthroughForRetiredPane,
      tabId,
      undockOnConfirmedAgentExit
    ]
  )
  // Why reactive, and why here: a pane created before SSH/runtime platform hydration must
  // still pick up a later-confirmed verdict. The subscription lives in the Surface because
  // upstream pins the controller chain's per-pane store-subscription count.
  const remoteConptyUnverified = useAppStore((store) =>
    store.settings?.experimentalTerminalDock === true
      ? resolveRemoteDockConptyUnverifiedForWorktree(store, worktreeId)
      : null
  )
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    if (restampRemoteDockConptyUnverifiedForLivePanes(manager, remoteConptyUnverified)) {
      setPaneLayoutRevision((revision) => revision + 1)
    }
  }, [managerRef, remoteConptyUnverified, setPaneLayoutRevision])

  // Why: the dock's disabled reason needs this regardless of tab visibility — a hidden pane's
  // composer must not stay enabled against a dead SSH connection just because the reconnect
  // banner (which only shows for the active, visible pane) isn't currently rendering.
  const sshConnectionUnavailable = Boolean(
    sshReconnectTargetId && sshReconnectStatus && sshReconnectStatus !== 'connected'
  )
  const dockMounts =
    experimentalTerminalDockEnabled && !effectiveChatViewMode
      ? managedPanes.map((pane) => {
          const paneKey = makePaneKey(tabId, pane.leafId)
          const agent = terminalDock.resolveDockAgent(paneKey, resolveAgentForLeaf(pane.leafId))
          if (!agent) {
            return null
          }
          const targetPtyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
          return (
            <TerminalPaneDockMount
              key={paneKey}
              pane={pane}
              terminalTabId={tabId}
              paneKey={paneKey}
              agent={agent}
              docked={terminalDock.isPaneDocked(paneKey)}
              gutterRows={terminalDock.gutterRowsFor(paneKey)}
              targetPtyId={targetPtyId}
              disabledReason={terminalDock.disabledReasonFor({
                paneKey,
                targetPtyId,
                recoveryPhase: dockRawRecoveryPhaseByPaneId[pane.id] ?? null,
                sshDisconnected: sshConnectionUnavailable
              })}
              onInitialize={() => terminalDock.ensurePaneDockDefault(paneKey, agent)}
              onCommitGutterRows={(rows) => terminalDock.commitGutterRows(paneKey, rows)}
              onEffectiveMountedChange={(mounted) =>
                terminalDock.setPaneDockMounted(paneKey, mounted)
              }
              passthroughActive={terminalDock.isPanePassthrough(paneKey)}
            />
          )
        })
      : null
  // Mirrors the dock's own mount gate, so the menu never offers a toggle for a pane
  // where no dock could render.
  const contextMenuDockPaneKey = contextMenuLeafId ? makePaneKey(tabId, contextMenuLeafId) : null
  return {
    dockMounts,
    contextMenuProps: {
      canToggleTerminalDock: Boolean(
        experimentalTerminalDockEnabled &&
        !effectiveChatViewMode &&
        contextMenuDockPaneKey &&
        terminalDock.resolveDockAgent(
          contextMenuDockPaneKey,
          resolveAgentForLeaf(contextMenuLeafId)
        )
      ),
      isTerminalDockDocked: Boolean(
        contextMenuDockPaneKey && terminalDock.isPaneDocked(contextMenuDockPaneKey)
      ),
      onToggleTerminalDock: () => terminalDock.toggleDockForLeaf(contextMenuLeafId)
    }
  }
}
