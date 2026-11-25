import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TerminalDockComposer } from './TerminalDockComposer'
import type { ComposerHandle } from '../../chat/composer/composer-types'
import { DEFAULT_GUTTER_ROWS } from './terminal-dock-pane-state'
import { NativeChatPaneFileDropSurface } from '../../native-chat/NativeChatPaneFileDropSurface'
import { useDockWindowRefocus } from './use-dock-window-refocus'

// Row height mirrors the composer field's text-sm/leading-5 (20px) so a
// gutterRows count tracks visible textarea lines; the remainder covers the
// composer's own card padding and action row, which don't scale with rows.
export const TERMINAL_DOCK_ROW_HEIGHT_PX = 20
const ROW_HEIGHT_PX = TERMINAL_DOCK_ROW_HEIGHT_PX
const CHROME_HEIGHT_PX = 80

// A gutter that fits exactly is still useless — the terminal above it is the
// ground truth the user watches their text land in, so undocking must leave
// it a minimum of visible rows rather than trigger on gutter fit alone.
const MIN_VISIBLE_TERMINAL_PX = 60

// Why: two thresholds instead of one give the flip a dead zone — a pane
// hovering at a single boundary would mount/unmount every resize tick.
const HYSTERESIS_BAND_PX = 40

export function terminalDockGutterHeightPx(gutterRows: number): number {
  return CHROME_HEIGHT_PX + gutterRows * ROW_HEIGHT_PX
}

// Thresholds scale with gutterRows: a taller gutter needs a taller pane
// before it can dock without starving the terminal above it.
export function terminalDockAutoUndockLowThresholdPx(gutterRows: number): number {
  return terminalDockGutterHeightPx(gutterRows) + MIN_VISIBLE_TERMINAL_PX
}

export function terminalDockAutoUndockHighThresholdPx(gutterRows: number): number {
  return terminalDockAutoUndockLowThresholdPx(gutterRows) + HYSTERESIS_BAND_PX
}

function useAutoUndock(paneHeightPx: number, gutterRows: number, dragActive: boolean): boolean {
  const [mounted, setMounted] = useState(
    () => paneHeightPx >= terminalDockAutoUndockHighThresholdPx(gutterRows)
  )

  // Why: a live gutter drag can walk gutterRows across a threshold and back before
  // release; evaluating against those intermediate rows undocks and immediately remounts
  // within one gesture (two SIGWINCHes). Freezing while dragging lets release's settled
  // rows decide once. useLayoutEffect (not useEffect) keeps that decision, and the
  // mount-notify effect it feeds, in the same pre-paint commit as the prop change.
  useLayoutEffect(() => {
    if (dragActive) {
      return
    }
    const lowThreshold = terminalDockAutoUndockLowThresholdPx(gutterRows)
    const highThreshold = terminalDockAutoUndockHighThresholdPx(gutterRows)
    setMounted((wasMounted) => {
      if (wasMounted && paneHeightPx < lowThreshold) {
        return false
      }
      if (!wasMounted && paneHeightPx >= highThreshold) {
        return true
      }
      return wasMounted
    })
  }, [paneHeightPx, gutterRows, dragActive])

  return mounted
}

export type TerminalDockProps = {
  terminalTabId: string
  paneKey: string
  targetPtyId: string | null
  agent: AgentType
  /** Current height of the hosting pane in pixels; drives auto-undock. */
  paneHeightPx: number
  /** Gutter rows this pane persisted, or the default when it hasn't. */
  gutterRows?: number
  /** Short reason the composer can't accept input right now, or null when it can. */
  disabledReason: string | null
  /** Fires once per mount/unmount transition (including auto-undock), never per render, so
   *  the host can coalesce the resulting PTY resize into exactly one send. */
  onMountedChange?: (mounted: boolean) => void
  /** Wired to the gutter-resize handle's pointerdown; omit to render a non-interactive handle. */
  onGutterPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void
  /** True while a gutter-resize drag is live; suspends auto-undock re-evaluation so
   *  intermediate rows crossing a threshold can't undock/remount before release. */
  gutterDragActive?: boolean
  /** True while the pane is in raw passthrough mode: xterm (not the composer) owns keyboard
   *  focus, so the composer greys out and stops accepting pointer interaction. */
  passthroughActive?: boolean
}

/** Fixed-height gutter beneath a terminal pane hosting the mountable
 *  composer core. Height depends only on gutterRows, never on draft
 *  content — the pane's resize path fires a PTY SIGWINCH on geometry
 *  change, so a content-driven height would resize the PTY on every
 *  keystroke. Unmounts below a pane height derived from the current
 *  gutterRows and re-mounts above a strictly greater derived threshold
 *  so a 1px resize jitter can't flap it. */
export const TerminalDock = forwardRef<ComposerHandle, TerminalDockProps>(
  function TerminalDock(props, ref): React.JSX.Element | null {
    const { terminalTabId, paneKey, targetPtyId, agent, paneHeightPx, disabledReason } = props
    const gutterRows = props.gutterRows ?? DEFAULT_GUTTER_ROWS
    const mounted = useAutoUndock(paneHeightPx, gutterRows, props.gutterDragActive ?? false)
    const composerRef = useRef<ComposerHandle>(null)
    const [rootNode, setRootNode] = useState<HTMLDivElement | null>(null)
    // Why: exposes the mounted composer's focus to the host so it can move keyboard focus onto the
    // dock (dock entry, passthrough exit) without reaching past this component's mount/auto-undock
    // gating.
    useImperativeHandle(ref, () => ({ focus: () => composerRef.current?.focus() }), [])
    useDockWindowRefocus(rootNode, composerRef)

    const onMountedChangeRef = useRef(props.onMountedChange)
    onMountedChangeRef.current = props.onMountedChange
    // Why: fires on every content mount/unmount edge (manual toggle, auto-undock, or the host
    // removing this component outright) so the caller can hold-and-flush exactly one PTY resize
    // per edge instead of guessing which internal transition caused the DOM to change.
    useLayoutEffect(() => {
      if (!mounted) {
        return undefined
      }
      onMountedChangeRef.current?.(true)
      return () => {
        onMountedChangeRef.current?.(false)
      }
    }, [mounted])

    if (!mounted) {
      return null
    }

    return (
      <div
        ref={setRootNode}
        className="flex shrink-0 flex-col border-t border-border bg-background"
        style={{ height: terminalDockGutterHeightPx(gutterRows) }}
        data-pane-prevent-terminal-focus
        data-native-chat-root="true"
        data-terminal-dock=""
        data-terminal-dock-passthrough={props.passthroughActive ? '' : undefined}
      >
        {props.onGutterPointerDown ? (
          <div
            className="h-1.5 shrink-0 cursor-row-resize"
            data-terminal-dock-gutter-handle=""
            data-pane-prevent-terminal-focus
            onPointerDown={props.onGutterPointerDown}
          />
        ) : null}
        <div
          className="flex h-4 shrink-0 items-center px-3 pt-1 text-[11px] font-medium text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <span className={cn(disabledReason === null && 'invisible')}>{disabledReason}</span>
        </div>
        <div className="relative min-h-0 flex-1">
          <div className="h-full overflow-visible" inert={props.passthroughActive || undefined}>
            {/* bottom-anchored: growth goes up over the terminal, since a taller dock would resize the PTY */}
            <div className="absolute inset-x-0 bottom-0 z-30 bg-background">
              <NativeChatPaneFileDropSurface className="relative">
                <TerminalDockComposer
                  ref={composerRef}
                  terminalTabId={terminalTabId}
                  paneKey={paneKey}
                  targetPtyId={targetPtyId}
                  agent={agent}
                  canSend={disabledReason === null && !props.passthroughActive}
                />
              </NativeChatPaneFileDropSurface>
            </div>
          </div>
          {props.passthroughActive ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-background/70 text-xs font-medium text-muted-foreground"
              data-terminal-dock-passthrough-overlay=""
            >
              {translate(
                'components.terminal-dock.passthroughActive',
                'Passthrough active — terminal has keyboard focus'
              )}
            </div>
          ) : null}
        </div>
      </div>
    )
  }
)
