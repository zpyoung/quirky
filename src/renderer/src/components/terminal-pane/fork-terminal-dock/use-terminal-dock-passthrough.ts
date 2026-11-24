import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type { AgentStatusState } from '../../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { shouldAutoExitPassthroughOnAgentStatus } from './terminal-pane-dock-passthrough'

export type TerminalDockPassthrough = {
  isPanePassthrough: (paneKey: string) => boolean
  exitPanePassthrough: (paneKey: string) => void
  togglePassthroughForFocusedPane: () => void
  prunePassthroughForRetiredPane: (leafId: string) => void
}

export function useTerminalDockPassthrough(args: {
  enabled: boolean
  tabId: string
  managerRef: React.RefObject<PaneManager | null>
  isPaneComposerMounted: (paneKey: string) => boolean
  agentForPane: (paneKey: string) => string | undefined
}): TerminalDockPassthrough {
  const { enabled, tabId, managerRef, isPaneComposerMounted, agentForPane } = args
  const [paneKeys, setPaneKeys] = useState<ReadonlySet<string>>(() => new Set())
  const previousAgentStatesRef = useRef<Map<string, AgentStatusState | null>>(new Map())

  const isPanePassthrough = useCallback((paneKey: string) => paneKeys.has(paneKey), [paneKeys])
  const exitPanePassthrough = useCallback((paneKey: string): void => {
    previousAgentStatesRef.current.delete(paneKey)
    setPaneKeys((previous) => {
      if (!previous.has(paneKey)) {
        return previous
      }
      const next = new Set(previous)
      next.delete(paneKey)
      return next
    })
  }, [])

  const togglePassthroughForFocusedPane = useCallback((): void => {
    const activePane = managerRef.current?.getActivePane()
    if (!activePane) {
      return
    }
    const paneKey = makePaneKey(tabId, activePane.leafId)
    const entering = !paneKeys.has(paneKey)
    if (entering && !isPaneComposerMounted(paneKey)) {
      return
    }
    if (entering) {
      activePane.terminal.focus()
      const currentState = useAppStore.getState().agentStatusByPaneKey[paneKey]?.state ?? null
      previousAgentStatesRef.current.set(paneKey, currentState)
    } else {
      previousAgentStatesRef.current.delete(paneKey)
    }
    setPaneKeys((previous) => {
      const next = new Set(previous)
      if (entering) {
        next.add(paneKey)
      } else {
        next.delete(paneKey)
      }
      return next
    })
  }, [agentForPane, isPaneComposerMounted, managerRef, paneKeys, tabId])

  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    for (const paneKey of paneKeys) {
      if (!previousAgentStatesRef.current.has(paneKey)) {
        const currentState = useAppStore.getState().agentStatusByPaneKey[paneKey]?.state ?? null
        previousAgentStatesRef.current.set(paneKey, currentState)
      }
    }
    return useAppStore.subscribe(() => {
      if (paneKeys.size === 0) {
        return
      }
      const agentStatusByPaneKey = useAppStore.getState().agentStatusByPaneKey
      for (const paneKey of paneKeys) {
        const entry = agentStatusByPaneKey[paneKey]
        const previousState = previousAgentStatesRef.current.get(paneKey) ?? null
        const nextState = entry?.state ?? null
        if (nextState === previousState) {
          continue
        }
        previousAgentStatesRef.current.set(paneKey, nextState)
        if (
          shouldAutoExitPassthroughOnAgentStatus({
            previousState,
            nextState,
            agentType: entry?.agentType
          })
        ) {
          exitPanePassthrough(paneKey)
        }
      }
    })
  }, [enabled, exitPanePassthrough, paneKeys])

  const prunePassthroughForRetiredPane = useCallback(
    (leafId: string): void => exitPanePassthrough(makePaneKey(tabId, leafId)),
    [exitPanePassthrough, tabId]
  )

  return {
    isPanePassthrough,
    exitPanePassthrough,
    togglePassthroughForFocusedPane,
    prunePassthroughForRetiredPane
  }
}
