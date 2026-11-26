import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { AgentType } from '../../../../../shared/agent-status-types'
import type { ComposerHandle } from '../../chat/composer/composer-types'
import { TerminalDock, terminalDockGutterHeightPx } from './TerminalDock'
import { applyTerminalDockGeometryChange } from './terminal-pane-dock-geometry'
import { beginTerminalDockGutterDrag } from './terminal-pane-dock-gutter-drag'
import {
  resolveTerminalDockFocusTransition,
  type TerminalDockFocusState
} from './terminal-pane-dock-focus-transition'
import { trackPaneFocusOwnership } from './terminal-pane-dock-focus'
import { REMOTE_CONPTY_UNVERIFIED_DATASET_KEY } from './terminal-dock-remote-conpty'

/** ManagedPane's public view drops the internal dockContainer field (pane-public-view.ts), so
 *  reach it the same way the pane DOM itself advertises it: the '.pane-dock-slot' class every
 *  pane's container carries (pane-dom-creation.ts). */
function findDockContainer(pane: ManagedPane): HTMLElement | null {
  return pane.container.querySelector<HTMLElement>('.pane-dock-slot')
}

/** Same reach-through-the-DOM approach as findDockContainer, for the sibling xterm-container
 *  the pane's own pointerdown-focus routing lives outside this module's scope to edit. */
function findXtermContainer(pane: ManagedPane): HTMLElement | null {
  return pane.container.querySelector<HTMLElement>('.xterm-container')
}

export { REMOTE_CONPTY_UNVERIFIED_DATASET_KEY }

export function terminalPaneUsesConptyBelowWrapMarkers(pane: ManagedPane): boolean {
  const windowsPty = pane.terminal.options?.windowsPty
  if (windowsPty?.backend === 'conpty' && windowsPty.buildNumber === undefined) {
    return true
  }
  return pane.container.dataset[REMOTE_CONPTY_UNVERIFIED_DATASET_KEY] === 'true'
}

export type TerminalPaneDockMountProps = {
  pane: ManagedPane
  terminalTabId: string
  paneKey: string
  agent: AgentType
  docked: boolean
  gutterRows: number
  targetPtyId: string | null
  disabledReason: string | null
  onInitialize?: () => void
  onCommitGutterRows: (rows: number) => void
  onEffectiveMountedChange?: (mounted: boolean) => void
  passthroughActive: boolean
}

/** Portals the dock into the pane's reserved DOM slot and owns the single point where its
 *  DOM geometry changes (mount/unmount edges, live drag) get coalesced into exactly one PTY
 *  resize. Renders nothing when not docked — the caller already gates the experimental flag
 *  and agent eligibility, so reaching here at all means the feature is live for this pane. */
export function TerminalPaneDockMount(props: TerminalPaneDockMountProps): React.JSX.Element | null {
  const { pane, docked, passthroughActive, onEffectiveMountedChange } = props
  const dockRef = useRef<ComposerHandle>(null)
  const cancelGutterDragRef = useRef<(() => void) | null>(null)
  const [liveGutterRows, setLiveGutterRows] = useState<number | null>(null)
  // Why: the auto-undock hysteresis needs the pane's own available height, not the
  // terminal's — the split layout fixes this pane's box; only the internal xterm/dock
  // split moves, so this never feeds back into itself when the dock mounts or resizes.
  const [paneHeightPx, setPaneHeightPx] = useState(
    () => pane.container.getBoundingClientRect().height
  )
  const [effectiveDockMounted, setEffectiveDockMounted] = useState(false)
  // Why: React runs the unmount cleanup that zeroes the slot before the layout effect below,
  // one commit ahead of the state flush — the effect must not re-apply a height already gone.
  const dockMountedRef = useRef(false)
  const dockContainer = useMemo(() => findDockContainer(pane), [pane])
  const setDockHeight = useCallback(
    (height: number): void => {
      if (!dockContainer) {
        return
      }
      dockContainer.style.height = `${height}px`
      pane.container.style.setProperty('--terminal-dock-height', `${height}px`)
    },
    [dockContainer, pane]
  )

  useEffect(
    () => () => {
      cancelGutterDragRef.current?.()
      cancelGutterDragRef.current = null
    },
    [docked]
  )

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return undefined
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setPaneHeightPx(entry.contentRect.height)
      }
    })
    observer.observe(pane.container)
    return () => observer.disconnect()
  }, [pane])

  const onInitializeRef = useRef(props.onInitialize)
  onInitializeRef.current = props.onInitialize
  useEffect(() => {
    onInitializeRef.current?.()
  }, [props.paneKey])

  // Why: seeded false to match effectiveDockMounted's own initial value, not the docked
  // prop — a persisted-docked pane that starts too short to mount still needs its later
  // grow-past-threshold remount read as a real transition. Startup focus-stealing is
  // prevented by the focus-ownership gate below, not by this seed.
  const focusStateRef = useRef<TerminalDockFocusState>({ docked: false, passthroughActive })
  const paneFocusTrackerRef = useRef<ReturnType<typeof trackPaneFocusOwnership> | null>(null)
  useEffect(() => {
    const tracker = trackPaneFocusOwnership(pane.container)
    paneFocusTrackerRef.current = tracker
    return () => {
      tracker.dispose()
      paneFocusTrackerRef.current = null
    }
  }, [pane])
  useEffect(() => {
    const previous = focusStateRef.current
    const next: TerminalDockFocusState = { docked: effectiveDockMounted, passthroughActive }
    focusStateRef.current = next
    // Why: with two docked splits, every pane's mount transition would otherwise fire this
    // effect — only the pane that currently owns keyboard focus is the active one to steal it.
    if (!paneFocusTrackerRef.current?.hasFocus()) {
      return
    }
    const action = resolveTerminalDockFocusTransition(previous, next)
    if (action === 'focus-composer') {
      dockRef.current?.focus()
    } else if (action === 'focus-terminal') {
      pane.terminal.focus()
    }
  }, [effectiveDockMounted, passthroughActive, pane])

  // Why: while docked (and not in passthrough), a terminal pointerdown must still select and
  // scroll xterm but not take keyboard focus from the composer — data-pane-prevent-terminal-focus
  // is the opt-out shouldFocusTerminalFromPanePointerDown already honors, so toggling it here
  // reaches the desired behavior without touching the pane-manager focus-gate default itself.
  useEffect(() => {
    const xtermContainer = findXtermContainer(pane)
    if (!xtermContainer) {
      return undefined
    }
    if (effectiveDockMounted && !passthroughActive) {
      xtermContainer.setAttribute('data-pane-prevent-terminal-focus', '')
    } else {
      xtermContainer.removeAttribute('data-pane-prevent-terminal-focus')
    }
    return () => {
      xtermContainer.removeAttribute('data-pane-prevent-terminal-focus')
    }
  }, [pane, effectiveDockMounted, passthroughActive])

  // Why: xterm's own MouseService focuses its helper textarea on every mousedown — including
  // a click that's only selecting text — regardless of data-pane-prevent-terminal-focus, which
  // only opts xterm out of Quirky's own pane-level focus call. Reclaiming focus in the bubble
  // phase runs after xterm's own handler, so selection (driven by its own mousedown/mousemove
  // listeners, not by focus) still works while the composer keeps keyboard focus.
  useEffect(() => {
    const xtermContainer = findXtermContainer(pane)
    if (!xtermContainer || !effectiveDockMounted || passthroughActive) {
      return undefined
    }
    const reclaimFocus = (): void => {
      dockRef.current?.focus()
    }
    xtermContainer.addEventListener('mousedown', reclaimFocus)
    return () => {
      xtermContainer.removeEventListener('mousedown', reclaimFocus)
    }
  }, [pane, effectiveDockMounted, passthroughActive])

  const { gutterRows, onCommitGutterRows } = props
  const renderedGutterRows = liveGutterRows ?? gutterRows
  const handleMountedChange = useCallback(
    (mounted: boolean) => {
      dockMountedRef.current = mounted
      if (!mounted) {
        cancelGutterDragRef.current?.()
        cancelGutterDragRef.current = null
      }
      setEffectiveDockMounted(mounted)
      onEffectiveMountedChange?.(mounted)
      if (!dockContainer) {
        return
      }
      const height = mounted ? terminalDockGutterHeightPx(renderedGutterRows) : 0
      applyTerminalDockGeometryChange(pane, undefined, () => setDockHeight(height))
    },
    [dockContainer, onEffectiveMountedChange, pane, renderedGutterRows, setDockHeight]
  )

  useLayoutEffect(() => {
    if (!dockContainer || !dockMountedRef.current) {
      return
    }
    const height = terminalDockGutterHeightPx(renderedGutterRows)
    if (dockContainer.style.height === `${height}px`) {
      return
    }
    applyTerminalDockGeometryChange(pane, undefined, () => setDockHeight(height))
  }, [dockContainer, effectiveDockMounted, pane, renderedGutterRows, setDockHeight])

  const handleGutterPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      cancelGutterDragRef.current?.()
      cancelGutterDragRef.current = beginTerminalDockGutterDrag(event, {
        pane,
        startGutterRows: gutterRows,
        onLiveRowsChange: (rows) => {
          setDockHeight(terminalDockGutterHeightPx(rows))
          setLiveGutterRows(rows)
        },
        onCommit: (rows) => {
          onCommitGutterRows(rows)
        },
        onSettled: () => {
          setLiveGutterRows(null)
        }
      })
    },
    [gutterRows, onCommitGutterRows, pane, setDockHeight]
  )

  if (!docked || !dockContainer) {
    return null
  }

  return createPortal(
    <TerminalDock
      ref={dockRef}
      terminalTabId={props.terminalTabId}
      paneKey={props.paneKey}
      targetPtyId={props.targetPtyId}
      agent={props.agent}
      paneHeightPx={paneHeightPx}
      gutterRows={renderedGutterRows}
      disabledReason={props.disabledReason}
      onMountedChange={handleMountedChange}
      onGutterPointerDown={handleGutterPointerDown}
      gutterDragActive={liveGutterRows !== null}
      passthroughActive={props.passthroughActive}
    />,
    dockContainer
  )
}
