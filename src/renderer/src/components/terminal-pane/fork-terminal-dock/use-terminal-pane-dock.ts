import { useCallback, useMemo, useState } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import type { Tab } from '../../../../../shared/tab-types'
import { getCachedUnifiedTerminalTabForWorktree } from '../terminal-unified-tab-lookup'
import { useTerminalDockAgentLatch } from './terminal-pane-dock-agent-latch'
import { useTerminalDockLocalFallback } from './use-terminal-dock-local-fallback'
import { shouldDockTerminalComposerByDefault } from './terminal-dock-initial-state'
import { useTerminalDockDisabledReason } from './use-terminal-dock-disabled-reason'
import { useTerminalDockPassthrough } from './use-terminal-dock-passthrough'
import { useTerminalDockPtyBindingRevision } from './use-terminal-dock-pty-binding-revision'
import { useTerminalDockShortcutListener } from './use-terminal-dock-shortcut-listener'
import type { PtyTransportRecoveryState } from '../pty-transport-types'

// Why: upstream's own suites drive TerminalPaneSurface with store doubles that carry no tab
// catalog; an absent one means no dock state, not a crash.
function unifiedTerminalTab(
  state: { unifiedTabsByWorktree?: Record<string, Tab[]> },
  worktreeId: string,
  tabId: string
): Tab | null {
  return state.unifiedTabsByWorktree
    ? getCachedUnifiedTerminalTabForWorktree(state.unifiedTabsByWorktree, worktreeId, tabId)
    : null
}

export type UseTerminalPaneDockArgs = {
  tabId: string
  worktreeId: string
  enabled: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
}

export type UseTerminalPaneDockResult = {
  isPaneDocked: (paneKey: string) => boolean
  /** Combines docked state with the experimental flag — a stale persisted `docked: true`
   *  from before the flag was disabled must not keep programmatic focus off the terminal. */
  paneDockOwnsFocus: (paneKey: string) => boolean
  gutterRowsFor: (paneKey: string) => number
  isPanePassthrough: (paneKey: string) => boolean
  setPaneDockMounted: (paneKey: string, mounted: boolean) => void
  exitPanePassthrough: (paneKey: string) => void
  /** Docks a recognized agent pane unless the setting is off or the user closed it. */
  ensurePaneDockDefault: (paneKey: string, agent: AgentType) => void
  /** The agent to render the dock with for this pane: `detectedAgent` when it's a live,
   *  recognized TUI agent; otherwise the last agent this pane was recognized as, but only
   *  while persisted-docked — so a status flap (reconnect, hook reconciliation) that clears
   *  live status without a confirmed exit can never unmount the composer. Falls back to the
   *  client-local latch when the in-memory one is empty (e.g. a renderer remount), so agent-
   *  status availability is never what decides whether a persisted dock renders. Null means
   *  render nothing, matching the caller's prior `!isTuiAgent(agent)` gate. */
  resolveDockAgent: (paneKey: string, detectedAgent: string | null) => AgentType | null
  commitGutterRows: (paneKey: string, rows: number) => void
  disabledReasonFor: (args: {
    paneKey: string
    targetPtyId: string | null
    recoveryPhase: PtyTransportRecoveryState['phase'] | null
    sshDisconnected?: boolean
  }) => string | null
  /** Toggles a specific pane's dock. The keyboard shortcut targets the focused pane, but
   *  menu-driven callers act on the pane they were opened over, which need not be focused. */
  toggleDockForLeaf: (leafId: string | null) => void
  /** Wire into the confirmed-agent-exit signal (onAgentExitedRef) alongside any existing
   *  consumer — undocks a pane whose agent just confirmed exit, same as the passthrough
   *  auto-exit, this never touches panes that were never docked. */
  undockOnConfirmedAgentExit: (leafId: string) => void
  /** Wire into the pane-retirement signal (close/detach) alongside the store-side dock-state
   *  prune — drops a closed pane's passthrough membership and auto-exit tracking so neither
   *  lingers for a leaf id that will never be reused. */
  prunePassthroughForRetiredPane: (leafId: string) => void
  /** Call wherever a pane's transport binds or loses its PTY. The dock reads the id straight
   *  off the transport during render, and the layout-store write at those same call sites
   *  dedupes a reattach to an unchanged id — so without this the dock never re-reads. */
  notePanePtyBindingChanged: () => void
}

/** Centralizes the terminal dock's TerminalPane-side state: which panes are docked (mirrored
 *  from the unified tab's persisted record), per-pane passthrough mode (ephemeral, local —
 *  never persisted or synced), and the two pane-scoped keyboard shortcuts. Kept out of
 *  TerminalPane.tsx itself so that already-3000-line file only gains a handful of call sites. */
export function useTerminalPaneDock(args: UseTerminalPaneDockArgs): UseTerminalPaneDockResult {
  const { tabId, worktreeId, enabled, managerRef, containerRef } = args

  const terminalDockByPaneKey = useAppStore(
    (store) => unifiedTerminalTab(store, worktreeId, tabId)?.terminalDockByPaneKey
  )
  const setTabTerminalDockState = useAppStore((store) => store.setTabTerminalDockState)
  const autoDockNewPanes = useAppStore(
    (store) => store.settings?.dockTerminalComposerByDefault !== false
  )

  const [mountedPaneKeys, setMountedPaneKeys] = useState<ReadonlySet<string>>(() => new Set())
  const { resolvedStateFor, userUndockedFor, noteUserUndock, persistLocalDockState, forgetPane } =
    useTerminalDockLocalFallback()
  // Why: "ever echoed" is per-tab, not per-pane — a modern host's record simply omitting one
  // pane still means default (not local fallback) governs that pane, per resolveTerminalDockPaneState.
  const hostHasEverEchoed = terminalDockByPaneKey !== undefined
  const isPaneDocked = useCallback(
    (paneKey: string): boolean =>
      resolvedStateFor(paneKey, terminalDockByPaneKey?.[paneKey], hostHasEverEchoed).docked,
    [hostHasEverEchoed, resolvedStateFor, terminalDockByPaneKey]
  )
  const isPaneComposerMounted = useCallback(
    (paneKey: string): boolean => enabled && isPaneDocked(paneKey) && mountedPaneKeys.has(paneKey),
    [enabled, isPaneDocked, mountedPaneKeys]
  )
  const { agentForPane, noteDetectedAgent, resolveDockAgent, forgetPaneAgent } =
    useTerminalDockAgentLatch({ enabled, isPaneDocked })
  const passthrough = useTerminalDockPassthrough({
    enabled,
    tabId,
    managerRef,
    isPaneComposerMounted,
    agentForPane
  })
  const { isPanePassthrough, exitPanePassthrough } = passthrough
  const paneDockOwnsFocus = useCallback(
    (paneKey: string): boolean => isPaneComposerMounted(paneKey) && !isPanePassthrough(paneKey),
    [isPaneComposerMounted, isPanePassthrough]
  )
  const gutterRowsFor = useCallback(
    (paneKey: string): number =>
      resolvedStateFor(paneKey, terminalDockByPaneKey?.[paneKey], hostHasEverEchoed).gutterRows,
    [hostHasEverEchoed, resolvedStateFor, terminalDockByPaneKey]
  )
  const setPaneDockMounted = useCallback(
    (paneKey: string, mounted: boolean): void => {
      if (!mounted) {
        exitPanePassthrough(paneKey)
      }
      setMountedPaneKeys((previous) => {
        if (previous.has(paneKey) === mounted) {
          return previous
        }
        const next = new Set(previous)
        if (mounted) {
          next.add(paneKey)
        } else {
          next.delete(paneKey)
        }
        return next
      })
    },
    [exitPanePassthrough]
  )

  const resolveUnifiedTabId = useCallback((): string | null => {
    return unifiedTerminalTab(useAppStore.getState(), worktreeId, tabId)?.id ?? null
  }, [tabId, worktreeId])

  const applyDockState = useCallback(
    (
      paneKey: string,
      patch: { docked?: boolean; gutterRows?: number; userUndocked?: boolean },
      beforeApply?: () => void
    ): boolean => {
      const unifiedTabId = resolveUnifiedTabId()
      if (!unifiedTabId) {
        return false
      }
      const persistedState = {
        docked: patch.docked ?? isPaneDocked(paneKey),
        gutterRows: patch.gutterRows ?? gutterRowsFor(paneKey),
        ...(patch.userUndocked !== undefined ? { userUndocked: patch.userUndocked } : {})
      }
      beforeApply?.()
      setTabTerminalDockState(unifiedTabId, { paneKey, ...patch })
      persistLocalDockState(paneKey, persistedState)
      return true
    },
    [
      gutterRowsFor,
      isPaneDocked,
      persistLocalDockState,
      resolveUnifiedTabId,
      setTabTerminalDockState
    ]
  )

  const ensurePaneDockDefault = useCallback(
    (paneKey: string, agent: AgentType): void => {
      noteDetectedAgent(paneKey, agent)
      if (isPaneDocked(paneKey)) {
        return
      }
      // Why: the host record is the only copy a second client can see — a client-local
      // flag alone would re-dock a pane this user closed from somewhere else.
      const hasPersistedDecision =
        terminalDockByPaneKey?.[paneKey]?.userUndocked === true || userUndockedFor(paneKey)
      if (
        !shouldDockTerminalComposerByDefault({
          enabled,
          autoDockNewPanes,
          agent,
          hasPersistedDecision
        })
      ) {
        return
      }
      applyDockState(paneKey, {
        docked: true,
        gutterRows: gutterRowsFor(paneKey)
      })
    },
    [
      applyDockState,
      autoDockNewPanes,
      enabled,
      gutterRowsFor,
      isPaneDocked,
      noteDetectedAgent,
      terminalDockByPaneKey,
      userUndockedFor
    ]
  )

  const commitGutterRows = useCallback(
    (paneKey: string, rows: number): void => {
      if (!enabled) {
        return
      }
      applyDockState(paneKey, { gutterRows: rows })
    },
    [applyDockState, enabled]
  )

  const toggleDockForLeaf = useCallback(
    (leafId: string | null): void => {
      if (!enabled || !leafId) {
        return
      }
      const paneKey = makePaneKey(tabId, leafId)
      const nextDocked = !isPaneDocked(paneKey)
      const beforeApply = (): void => {
        noteUserUndock(paneKey, !nextDocked)
        if (!nextDocked) {
          exitPanePassthrough(paneKey)
        }
      }
      applyDockState(paneKey, { docked: nextDocked, userUndocked: !nextDocked }, beforeApply)
    },
    [applyDockState, enabled, exitPanePassthrough, isPaneDocked, noteUserUndock, tabId]
  )

  const toggleDockForFocusedPane = useCallback((): void => {
    toggleDockForLeaf(managerRef.current?.getActivePane()?.leafId ?? null)
  }, [managerRef, toggleDockForLeaf])

  const undockOnConfirmedAgentExit = useCallback(
    (leafId: string): void => {
      // Why: the flag is the kill switch — disabled means no dock state gets written, even
      // to clean up a stale `docked: true` left over from before it was turned off.
      if (!enabled) {
        return
      }
      const paneKey = makePaneKey(tabId, leafId)
      if (!isPaneDocked(paneKey)) {
        return
      }
      applyDockState(paneKey, { docked: false }, () => exitPanePassthrough(paneKey))
    },
    [applyDockState, enabled, exitPanePassthrough, isPaneDocked, tabId]
  )

  useTerminalDockShortcutListener({
    enabled,
    containerRef,
    toggleDock: toggleDockForFocusedPane,
    togglePassthrough: passthrough.togglePassthroughForFocusedPane
  })

  const disabledReasonFor = useTerminalDockDisabledReason({ enabled, tabId })
  const notePanePtyBindingChanged = useTerminalDockPtyBindingRevision(enabled)

  const prunePassthroughForRetiredPane = useCallback(
    (leafId: string): void => {
      const paneKey = makePaneKey(tabId, leafId)
      forgetPaneAgent(paneKey)
      if (enabled) {
        forgetPane(paneKey)
      }
      setMountedPaneKeys((previous) => {
        if (!previous.has(paneKey)) {
          return previous
        }
        const next = new Set(previous)
        next.delete(paneKey)
        return next
      })
      passthrough.prunePassthroughForRetiredPane(leafId)
    },
    [enabled, forgetPane, forgetPaneAgent, passthrough, tabId]
  )

  return useMemo(
    () => ({
      isPaneDocked,
      paneDockOwnsFocus,
      gutterRowsFor,
      isPanePassthrough,
      setPaneDockMounted,
      exitPanePassthrough,
      ensurePaneDockDefault,
      resolveDockAgent,
      commitGutterRows,
      disabledReasonFor,
      toggleDockForLeaf,
      undockOnConfirmedAgentExit,
      prunePassthroughForRetiredPane,
      notePanePtyBindingChanged
    }),
    [
      commitGutterRows,
      disabledReasonFor,
      exitPanePassthrough,
      gutterRowsFor,
      isPaneDocked,
      isPanePassthrough,
      notePanePtyBindingChanged,
      ensurePaneDockDefault,
      resolveDockAgent,
      paneDockOwnsFocus,
      prunePassthroughForRetiredPane,
      setPaneDockMounted,
      toggleDockForLeaf,
      undockOnConfirmedAgentExit
    ]
  )
}
