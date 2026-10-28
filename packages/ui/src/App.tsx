import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useShortcuts } from './components/useShortcuts'
import { ConfirmHost } from './components/ConfirmHost'
import { ConnectionBanner } from './components/ConnectionBanner'
import { MainArea } from './components/MainArea'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { useAppState, usePluginHost, usePluginState } from './context'
import { CommandPalette } from './plugins/CommandPalette'
import { OverlayLayer } from './plugins/OverlayLayer'
import { PanelToggles } from './plugins/PanelToggles'
import { PluginSlot } from './plugins/PluginSlot'
import { useRegion } from './plugins/useRegion'
import { useThemeVariables } from './plugins/useThemeVariables'
import { ActivityItems } from './plugins/ActivityItems'

function NoToken() {
  return (
    <div className="fullscreen-message">
      <h1>Not connected</h1>
      <p>
        This page needs an access token. Open Quirky from the desktop app, or use the URL the daemon
        prints, which ends in <code>#token=…</code>.
      </p>
    </div>
  )
}

const PANEL_MIN_WIDTH = 220
const PANEL_MAX_WIDTH = 4096
const EDITOR_MIN_WIDTH = 320
const DEFAULT_PANEL_WIDTH = 360
const SIDE_ACTIVITY_WIDTH = 40
const ACTIVITY_ITEMS_WIDTH = 44

type ResizeDrag = { pointerId: number; startX: number; startWidth: number; width: number }

function clampPanelWidth(width: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(width)))
}

function PanelColumn({
  id,
  width,
  minWidth,
  maxWidth,
  onResize,
  onCommit
}: {
  id: string
  width: number
  minWidth: number
  maxWidth: number
  onResize(width: number): void
  onCommit(width: number): void
}) {
  const host = usePluginHost()
  const region = useRegion('panel')
  const drag = useRef<ResizeDrag | null>(null)

  const finishResize = (width: number) => {
    const current = drag.current
    if (!current) return
    drag.current = null
    onResize(width)
    // An impossible viewport may force the rendered track below the public preference minimum.
    if (width < PANEL_MIN_WIDTH) {
      onCommit(current.startWidth)
      return
    }
    if (width !== current.startWidth) {
      host.configurePanel(id, { width })
      onCommit(width)
    } else {
      onCommit(current.startWidth)
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || minWidth < PANEL_MIN_WIDTH) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const next = clampPanelWidth(current.startWidth + current.startX - event.clientX, minWidth, maxWidth)
    if (next === current.width) return
    drag.current = { ...current, width: next }
    onResize(next)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    finishResize(clampPanelWidth(current.startWidth + current.startX - event.clientX, minWidth, maxWidth))
  }

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current?.pointerId === event.pointerId) finishResize(current.width)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (minWidth < PANEL_MIN_WIDTH || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    event.preventDefault()
    const next = clampPanelWidth(width + (event.key === 'ArrowLeft' ? 32 : -32), minWidth, maxWidth)
    if (next === width) return
    onResize(next)
    host.configurePanel(id, { width: next })
    onCommit(next)
  }

  return (
    <aside className="scm-panel plugin-panel" {...region}>
      <div
        className="panel-resize-handle"
        role="separator"
        aria-label="Resize panel"
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        aria-disabled={minWidth < PANEL_MIN_WIDTH}
        tabIndex={minWidth < PANEL_MIN_WIDTH ? -1 : 0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        onKeyDown={handleKeyDown}
      />
      <PluginSlot key={id} id={id} />
    </aside>
  )
}

export function App() {
  const state = useAppState()
  const { model, layout } = usePluginState()
  const host = usePluginHost()
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [panelWidthOverride, setPanelWidthOverride] = useState<{ id: string; width: number; base: number | undefined } | null>(null)
  useShortcuts()
  useThemeVariables()

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

  const panel = layout.panel !== null && model?.panels.some((candidate) => candidate.id === layout.panel) ? layout.panel : null
  const hasActivityItems = (model?.activityItems.length ?? 0) > 0
  const activityWidth = layout.activityBarPosition === 'side' ? Math.min(SIDE_ACTIVITY_WIDTH, viewportWidth) : 0
  const sidebarWidth = Math.min(layout.sidebar ? 240 : 44, Math.max(0, viewportWidth - activityWidth))
  const widthAfterSidebar = Math.max(0, viewportWidth - sidebarWidth - activityWidth)
  const activityItemsWidth = hasActivityItems ? Math.min(ACTIVITY_ITEMS_WIDTH, widthAfterSidebar) : 0
  const widthAfterActivityItems = Math.max(0, widthAfterSidebar - activityItemsWidth)
  // If the viewport cannot fit a 220px panel at all, contract the track instead of overflowing.
  const panelMinWidth = Math.min(PANEL_MIN_WIDTH, widthAfterActivityItems)
  const panelMaxWidth = Math.max(
    panelMinWidth,
    Math.min(PANEL_MAX_WIDTH, widthAfterActivityItems - EDITOR_MIN_WIDTH)
  )
  // No saved width keeps the shell's former min-360px, half-viewport panel geometry.
  const desiredPanelWidth =
    panel === null
      ? DEFAULT_PANEL_WIDTH
      : (layout.panelWidths?.[panel] ?? Math.max(DEFAULT_PANEL_WIDTH, viewportWidth / 2))
  const persistedWidth = clampPanelWidth(desiredPanelWidth, panelMinWidth, panelMaxWidth)
  const panelWidth =
    panel !== null && panelWidthOverride?.id === panel
      ? clampPanelWidth(panelWidthOverride.width, panelMinWidth, panelMaxWidth)
      : persistedWidth
  const activityPosition = layout.activityBarPosition
  const panelTrack = panel === null ? '' : ' minmax(var(--panel-min-width), var(--panel-width))'
  const gridTemplateAreas =
    activityPosition === 'top'
      ? panel === null
        ? '"activity activity activity" "sidebar main activity-items"'
        : '"activity activity activity activity" "sidebar main activity-items panel"'
      : activityPosition === 'side'
        ? panel === null
          ? '"activity sidebar main activity-items"'
          : '"activity sidebar main activity-items panel"'
        : panel === null
          ? '"sidebar main activity-items"'
          : '"sidebar main activity-items panel"'
  const layoutStyle = {
    '--activity-width': `${activityWidth}px`,
    '--sidebar-width': `${sidebarWidth}px`,
    '--panel-min-width': `${panelMinWidth}px`,
    '--panel-width': `${panelWidth}px`,
    // The contribution rail needs a track without replacing the configurable panel geometry.
    ...(hasActivityItems
      ? {
          gridTemplateColumns:
            activityPosition === 'side'
              ? `${activityWidth}px ${sidebarWidth}px minmax(0, 1fr) ${activityItemsWidth}px${panelTrack}`
              : `${sidebarWidth}px minmax(0, 1fr) ${activityItemsWidth}px${panelTrack}`,
          gridTemplateAreas,
          ...(activityPosition === 'top' ? { gridTemplateRows: '36px minmax(0, 1fr)' } : {})
        }
      : {})
  } as CSSProperties

  useEffect(() => {
    if (!panelWidthOverride) return
    if (panelWidthOverride.id !== panel || layout.panelWidths?.[panelWidthOverride.id] !== panelWidthOverride.base) {
      setPanelWidthOverride(null)
    }
  }, [layout.panelWidths, panel, panelWidthOverride])

  if (state.connection === 'no-token') return <NoToken />
  const statusBars = model?.statusBars ?? []
  return (
    <div className="app">
      <ConnectionBanner />
      <div
        className={`layout${panel !== null ? ' with-panel' : ''}${layout.sidebar ? '' : ' no-sidebar'}${activityPosition ? ` activity-${activityPosition}` : ''}${hasActivityItems ? ' with-activity-items' : ''}`}
        style={layoutStyle}
      >
        {activityPosition === 'top' && (
          <div className="panel-activity-bar panel-activity-bar-top">
            <PanelToggles />
          </div>
        )}
        {activityPosition === 'side' && (
          <div className="panel-activity-bar panel-activity-bar-side">
            <PanelToggles vertical />
          </div>
        )}
        <Sidebar />
        <MainArea />
        {hasActivityItems && <ActivityItems />}
        {panel !== null && (
          <PanelColumn
            id={panel}
            minWidth={panelMinWidth}
            width={panelWidth}
            maxWidth={panelMaxWidth}
            onResize={(width) =>
              setPanelWidthOverride({ id: panel, width, base: layout.panelWidths?.[panel] })
            }
            onCommit={(width) => {
              setPanelWidthOverride((current) => {
                if (width === persistedWidth) return null
                return { id: panel, width, base: layout.panelWidths?.[panel] ?? current?.base }
              })
            }}
          />
        )}
      </div>
      {statusBars.length > 0 && (
        <div className="plugin-status-bar" data-region="status-bar" aria-label="Plugin status bar">
          {statusBars.map((entry) => <PluginSlot key={entry.id} id={entry.id} />)}
        </div>
      )}
      <OverlayLayer />
      {layout.palette === true && <CommandPalette onClose={() => host.setPalette(false)} />}
      <Toasts />
      <ConfirmHost />
    </div>
  )
}
