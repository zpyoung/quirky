import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { UiToolEntry, UiToolLayout, UiToolResize, UiToolSlot } from '@quirky/protocol'
import { UI_TOOL_SLOTS } from '@quirky/protocol'
import { Badge, IconButton, Menu, ToolPanelFrame, type MenuItem } from '../design-system'
import { usePluginHost, usePluginState } from '../context'
import { PluginSlot } from '../plugins/PluginSlot'
import { InboxPanel } from './ShellChrome'
import { useAttention } from './attention'
import './tool-shell.css'

const SLOT_LABELS: Record<UiToolSlot, string> = {
  'left-top': 'Left top',
  'left-bottom': 'Left bottom',
  'right-top': 'Right top',
  'right-bottom': 'Right bottom',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right'
}

export type ToolShellChrome = {
  rail: number
  splitter: number
  centerMinWidth: number
  centerMinHeight: number
}

export type ToolShellOpenSlots = Record<UiToolSlot, boolean>

export type ToolShellGeometry = {
  leftRailWidth: number
  leftPanelWidth: number
  leftEdgeWidth: number
  centerWidth: number
  rightEdgeWidth: number
  rightPanelWidth: number
  rightRailWidth: number
  bottomPanelHeight: number
  bottomEdgeHeight: number
  bottomRailHeight: number
  centerHeight: number
  sideHeight: number
  leftTopHeight: number
  leftBottomHeight: number
  leftBottomTop: number
  leftTopStripeHeight: number
  leftBottomStripeHeight: number
  leftSplitHandleHeight: number
  rightTopHeight: number
  rightBottomHeight: number
  rightBottomTop: number
  rightTopStripeHeight: number
  rightBottomStripeHeight: number
  rightSplitHandleHeight: number
  bottomLeftPanelWidth: number
  bottomRightPanelWidth: number
  bottomLeftStripeWidth: number
  bottomRightStripeWidth: number
  bottomSplitHandleWidth: number
  bottomPanelTop: number
}

export type ToolShellProps = {
  geometry: ToolShellGeometry
  sizes: UiToolLayout['sizes']
  onResizePreview: (key: keyof UiToolResize, value: number | null) => void
  onResizeCommit: (patch: UiToolResize) => void
}

const RESIZE_BOUNDS: Record<keyof UiToolResize, { min: number; max: number }> = {
  left: { min: 160, max: 1200 },
  right: { min: 160, max: 1200 },
  bottom: { min: 100, max: 1000 },
  leftSplit: { min: 0.15, max: 0.85 },
  rightSplit: { min: 0.15, max: 0.85 },
  bottomSplit: { min: 0.15, max: 0.85 }
}


function isToolSlot(value: unknown): value is UiToolSlot {
  return typeof value === 'string' && (UI_TOOL_SLOTS as readonly string[]).includes(value)
}

function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function clampToolResize(key: keyof UiToolResize, value: number): number {
  const { min, max } = RESIZE_BOUNDS[key]
  const finite = Number.isFinite(value) ? value : min
  const clamped = Math.min(max, Math.max(min, finite))
  return key.endsWith('Split') ? clamped : Math.round(clamped)
}

export function resizeFromPointerDelta(
  key: keyof UiToolResize,
  start: number,
  delta: number,
  direction: 1 | -1,
  extent: number
): number {
  if (key.endsWith('Split')) {
    if (extent <= 0) return clampToolResize(key, start)
    return clampToolResize(key, start + direction * delta / extent)
  }
  return clampToolResize(key, start + direction * delta)
}

export function resolveToolDropId(activeId: string | null, knownIds: ReadonlySet<string>): string | null {
  return activeId !== null && knownIds.has(activeId) ? activeId : null
}

export function effectiveToolPlacement(tool: UiToolEntry, layout: UiToolLayout | undefined): UiToolSlot | null {
  if (!layout) return tool.defaultSlot
  const placement = layout.placements[tool.id]
  if (placement === undefined) return tool.defaultSlot
  return isToolSlot(placement) ? placement : null
}

export function getToolShellOpenSlots(tools: readonly UiToolEntry[], layout: UiToolLayout | undefined): ToolShellOpenSlots {
  const known = new Map(tools.map((tool) => [tool.id, tool] as const))
  return Object.fromEntries(UI_TOOL_SLOTS.map((slot) => {
    const id = layout?.open[slot]
    const tool = id ? known.get(id) : undefined
    return [slot, Boolean(tool && effectiveToolPlacement(tool, layout) === slot)]
  })) as ToolShellOpenSlots
}

function splitHeights(total: number, topOpen: boolean, bottomOpen: boolean, ratio: number, splitter: number) {
  if (topOpen && bottomOpen) {
    const handle = Math.min(total, splitter)
    const usable = Math.max(0, total - handle)
    const top = usable * ratio
    return { top, bottom: usable - top, bottomTop: top + handle, stripeTop: top, stripeBottom: usable - top, handle }
  }
  if (topOpen) return { top: total, bottom: 0, bottomTop: total, stripeTop: total / 2, stripeBottom: total / 2, handle: 0 }
  if (bottomOpen) return { top: 0, bottom: total, bottomTop: 0, stripeTop: total / 2, stripeBottom: total / 2, handle: 0 }
  return { top: 0, bottom: 0, bottomTop: total, stripeTop: total / 2, stripeBottom: total / 2, handle: 0 }
}

export function fitToolShellGeometry(
  sizes: UiToolLayout['sizes'],
  viewport: { width: number; height: number },
  open: ToolShellOpenSlots,
  chrome: ToolShellChrome
): ToolShellGeometry {
  const width = positive(viewport.width)
  const height = positive(viewport.height)
  const rail = positive(chrome.rail)
  const requestedSplitter = positive(chrome.splitter)
  const leftOpen = open['left-top'] || open['left-bottom']
  const rightOpen = open['right-top'] || open['right-bottom']
  const bottomLeftOpen = open['bottom-left']
  const bottomRightOpen = open['bottom-right']
  const bottomOpen = bottomLeftOpen || bottomRightOpen
  const leftRailWidth = Math.min(rail, width / 2)
  const rightRailWidth = leftRailWidth
  const horizontalSpace = Math.max(0, width - leftRailWidth - rightRailWidth)
  const activeEdges = Number(leftOpen) + Number(rightOpen)
  const edgeWidth = activeEdges === 0 ? 0 : Math.min(requestedSplitter, horizontalSpace / activeEdges)
  const leftEdgeWidth = leftOpen ? edgeWidth : 0
  const rightEdgeWidth = rightOpen ? edgeWidth : 0
  const panelSpace = Math.max(0, horizontalSpace - leftEdgeWidth - rightEdgeWidth - Math.min(positive(chrome.centerMinWidth), horizontalSpace))
  const requestedLeft = leftOpen ? clampToolResize('left', sizes.left) : 0
  const requestedRight = rightOpen ? clampToolResize('right', sizes.right) : 0
  const requestedPanels = requestedLeft + requestedRight
  const panelScale = requestedPanels > panelSpace && requestedPanels > 0 ? panelSpace / requestedPanels : 1
  const leftPanelWidth = requestedLeft * panelScale
  const rightPanelWidth = requestedRight * panelScale
  const centerWidth = Math.max(0, horizontalSpace - leftEdgeWidth - rightEdgeWidth - leftPanelWidth - rightPanelWidth)

  const bottomRailHeight = Math.min(rail, height)
  const bottomEdgeHeight = bottomOpen ? Math.min(requestedSplitter, Math.max(0, height - bottomRailHeight)) : 0
  const verticalSpace = Math.max(0, height - bottomRailHeight - bottomEdgeHeight)
  const centerMinimumHeight = Math.min(positive(chrome.centerMinHeight), verticalSpace)
  const bottomPanelHeight = bottomOpen
    ? Math.min(clampToolResize('bottom', sizes.bottom), Math.max(0, verticalSpace - centerMinimumHeight))
    : 0
  const centerHeight = Math.max(0, height - bottomRailHeight - bottomEdgeHeight - bottomPanelHeight)
  const sideHeight = centerHeight

  const leftSplit = clampToolResize('leftSplit', sizes.leftSplit)
  const rightSplit = clampToolResize('rightSplit', sizes.rightSplit)
  const bottomSplit = clampToolResize('bottomSplit', sizes.bottomSplit)
  const leftRows = splitHeights(sideHeight, open['left-top'], open['left-bottom'], leftSplit, requestedSplitter)
  const rightRows = splitHeights(sideHeight, open['right-top'], open['right-bottom'], rightSplit, requestedSplitter)

  const bottomSplitHandleWidth = bottomLeftOpen && bottomRightOpen
    ? Math.min(requestedSplitter, width)
    : 0
  const bottomUsableWidth = Math.max(0, width - bottomSplitHandleWidth)
  const stripeLeftWidth = bottomUsableWidth * bottomSplit
  const stripeRightWidth = bottomUsableWidth - stripeLeftWidth
  const bottomLeftPanelWidth = bottomLeftOpen ? stripeLeftWidth : 0
  const bottomRightPanelWidth = bottomRightOpen ? stripeRightWidth : 0
  const bottomPanelTop = sideHeight + bottomEdgeHeight

  return {
    leftRailWidth,
    leftPanelWidth,
    leftEdgeWidth,
    centerWidth,
    rightEdgeWidth,
    rightPanelWidth,
    rightRailWidth,
    bottomPanelHeight,
    bottomEdgeHeight,
    bottomRailHeight,
    centerHeight,
    sideHeight,
    leftTopHeight: leftRows.top,
    leftBottomHeight: leftRows.bottom,
    leftBottomTop: leftRows.bottomTop,
    leftTopStripeHeight: leftRows.stripeTop,
    leftBottomStripeHeight: leftRows.stripeBottom,
    leftSplitHandleHeight: leftRows.handle,
    rightTopHeight: rightRows.top,
    rightBottomHeight: rightRows.bottom,
    rightBottomTop: rightRows.bottomTop,
    rightTopStripeHeight: rightRows.stripeTop,
    rightBottomStripeHeight: rightRows.stripeBottom,
    rightSplitHandleHeight: rightRows.handle,
    bottomLeftPanelWidth,
    bottomRightPanelWidth,
    bottomLeftStripeWidth: stripeLeftWidth,
    bottomRightStripeWidth: stripeRightWidth,
    bottomSplitHandleWidth,
    bottomPanelTop
  }
}

export function readToolShellChrome(element: HTMLElement): ToolShellChrome {
  const styles = getComputedStyle(element)
  const read = (name: string) => positive(Number.parseFloat(styles.getPropertyValue(name)))
  return {
    rail: read('--tool-shell-rail-width'),
    splitter: read('--tool-shell-splitter-width'),
    centerMinWidth: read('--tool-shell-center-min-width'),
    centerMinHeight: read('--tool-shell-center-min-height')
  }
}

export function toolShellCssVariables(geometry: ToolShellGeometry): CSSProperties & Record<`--tool-${string}`, number> {
  return {
    '--tool-left-rail': geometry.leftRailWidth,
    '--tool-left-panel-width': geometry.leftPanelWidth,
    '--tool-left-edge': geometry.leftEdgeWidth,
    '--tool-right-rail': geometry.rightRailWidth,
    '--tool-right-panel-width': geometry.rightPanelWidth,
    '--tool-right-edge': geometry.rightEdgeWidth,
    '--tool-bottom-panel-height': geometry.bottomPanelHeight,
    '--tool-bottom-edge': geometry.bottomEdgeHeight,
    '--tool-bottom-rail': geometry.bottomRailHeight,
    '--tool-side-height': geometry.sideHeight,
    '--tool-left-top-height': geometry.leftTopHeight,
    '--tool-left-bottom-height': geometry.leftBottomHeight,
    '--tool-left-bottom-top': geometry.leftBottomTop,
    '--tool-left-top-stripe-height': geometry.leftTopStripeHeight,
    '--tool-left-bottom-stripe-height': geometry.leftBottomStripeHeight,
    '--tool-left-split-handle-height': geometry.leftSplitHandleHeight,
    '--tool-right-top-height': geometry.rightTopHeight,
    '--tool-right-bottom-height': geometry.rightBottomHeight,
    '--tool-right-bottom-top': geometry.rightBottomTop,
    '--tool-right-top-stripe-height': geometry.rightTopStripeHeight,
    '--tool-right-bottom-stripe-height': geometry.rightBottomStripeHeight,
    '--tool-right-split-handle-height': geometry.rightSplitHandleHeight,
    '--tool-bottom-left-panel-width': geometry.bottomLeftPanelWidth,
    '--tool-bottom-right-panel-width': geometry.bottomRightPanelWidth,
    '--tool-bottom-left-stripe-width': geometry.bottomLeftStripeWidth,
    '--tool-bottom-right-stripe-width': geometry.bottomRightStripeWidth,
    '--tool-bottom-split-handle-width': geometry.bottomSplitHandleWidth,
    '--tool-bottom-panel-top': geometry.bottomPanelTop,
  } as CSSProperties & Record<`--tool-${string}`, number>
}

function orderedTools(tools: readonly UiToolEntry[], layout: UiToolLayout | undefined): UiToolEntry[] {
  const seen = new Set<string>()
  const candidates = tools.filter((tool) => {
    if (seen.has(tool.id) || effectiveToolPlacement(tool, layout) === null) return false
    seen.add(tool.id)
    return true
  })
  const order = new Map((layout?.order ?? []).map((id, index) => [id, index] as const))
  return candidates
    .map((tool, index) => ({ tool, index, rank: order.get(tool.id) }))
    .sort((left, right) => {
      if (left.rank !== undefined && right.rank !== undefined) return left.rank - right.rank || left.index - right.index
      if (left.rank !== undefined) return -1
      if (right.rank !== undefined) return 1
      return left.index - right.index
    })
    .map(({ tool }) => tool)
}

function toolBadge(entry: UiToolEntry, badges: Record<string, number>, titles: Record<string, string>, inboxCount: number | null) {
  if (entry.id === 'host:inbox') {
    return inboxCount !== null && inboxCount > 0 ? { count: inboxCount, title: `${inboxCount} waiting` } : null
  }
  const ids = new Set([entry.id, ...entry.aliases])
  const count = [...ids].reduce((total, id) => total + Math.max(0, badges[id] ?? 0), 0)
  if (count === 0) return null
  const title = [...ids].map((id) => titles[id]).find(Boolean) ?? `${count} waiting`
  return { count, title }
}

type ToolMenuPosition = { left: number; top: number }
type ToolAnchorRegistration = (id: string, element: HTMLDivElement | null) => void

function ToolMenu({ entry, placement, slot, position, onMove }: {
  entry: UiToolEntry
  placement: UiToolSlot
  slot: UiToolSlot
  position: ToolMenuPosition | undefined
  onMove: (id: string, slot: UiToolSlot) => void
}) {
  const items = useMemo<MenuItem[]>(() => UI_TOOL_SLOTS.map((destination) => ({
    id: destination,
    label: SLOT_LABELS[destination],
    disabled: destination === placement,
    onAction: () => onMove(entry.id, destination)
  })), [entry.id, onMove, placement])

  if (!position) return null
  const opensRightToLeft = slot === 'right-top' || slot === 'right-bottom' || slot === 'bottom-right'
  const opensUp = slot === 'bottom-left' || slot === 'bottom-right'
  const style = {
    '--tool-menu-left': position.left,
    '--tool-menu-top': position.top
  } as CSSProperties
  return createPortal(
    <div
      className="tool-shell__menu-portal"
      data-menu-side={opensRightToLeft ? 'right' : 'left'}
      data-menu-edge={opensUp ? 'bottom' : 'top'}
      style={style}
    >
      <Menu label={`Move ${entry.title}`} items={items} />
    </div>,
    document.body
  )
}

const TOOL_ICON_PATHS: Record<string, string> = {
  'git-branch': 'M6 3v12a4 4 0 0 0 4 4h2M18 5v3a4 4 0 0 1-4 4H6M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4M18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4M14 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  'git-pull-request': 'M6 7v10M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4M6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4M14 3h2a3 3 0 0 1 3 3v11M12 5l2-2 2 2M19 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  inbox: 'M4 4h16l2 13v3H2v-3L4 4M2 14h6l2 3h4l2-3h6',
  'list-checks': 'm3 5 2 2 3-4M11 5h10M3 12h4M11 12h10M3 19h4M11 19h10',
  bot: 'M5 7h14v13H5V7M12 3v4M2 12h3M19 12h3M8 12h1M15 12h1M8 17h8',
  workflow: 'M3 3h6v6H3V3M15 15h6v6h-6v-6M6 9v6a3 3 0 0 0 3 3h6M9 6h6a3 3 0 0 1 3 3v6',
  smartphone: 'M7 2h10v20H7V2M11 18h2',
  files: 'M8 3h8l4 4v14H8V3M16 3v5h4M4 7v14',
  check: 'm4 12 5 5L20 6',
  'message-circle': 'M21 11a9 9 0 0 1-13 8l-6 3 2-6A9 9 0 1 1 21 11',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 10v7M12 7v1',
  archive: 'M3 3h18v5H3V3M5 8v13h14V8M9 12h6',
  'book-open': 'M12 5c-3-2-7-2-10-1v16c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1v16',
  terminal: 'M3 4h18v16H3V4m4 4 4 4-4 4M13 16h4',
  command: 'M8 8h8v8H8V5a3 3 0 1 0-3 3h14a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H5a3 3 0 1 0 3 3V8',
  'panel-left': 'M3 4h18v16H3V4M9 4v16',
  'panel-right': 'M3 4h18v16H3V4M15 4v16',
  activity: 'M2 12h5l3-9 4 18 3-9h5'
}

function ToolIcon({ tool }: { tool: UiToolEntry }) {
  const path = TOOL_ICON_PATHS[tool.icon]
  return path
    ? <svg className="tool-shell__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
    : <span aria-hidden="true">{tool.title.slice(0, 1)}</span>
}

function ToolItem({
  tool,
  slot,
  openId,
  placement,
  menuPosition,
  badges,
  badgeTitles,
  inboxCount,
  dragging,
  registerAnchor,
  onOpen,
  onClose,
  onMove
}: {
  tool: UiToolEntry
  slot: UiToolSlot
  openId: string | null
  placement: UiToolSlot
  menuPosition: ToolMenuPosition | undefined
  badges: Record<string, number>
  badgeTitles: Record<string, string>
  inboxCount: number | null
  dragging: { current: string | null }
  registerAnchor: ToolAnchorRegistration
  onOpen: (id: string) => void
  onClose: (slot: UiToolSlot) => void
  onMove: (id: string, slot: UiToolSlot) => void
}) {
  const anchor = useCallback((element: HTMLDivElement | null) => registerAnchor(tool.id, element), [registerAnchor, tool.id])
  const selected = openId === tool.id
  const badge = toolBadge(tool, badges, badgeTitles, inboxCount)

  return (
    <div ref={anchor} className="tool-shell__tool">
      <IconButton
        className="tool-shell__tool-button"
        label={tool.title}
        title={tool.title}
        aria-pressed={selected}
        draggable
        onDragStart={(event) => {
          dragging.current = tool.id
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('application/x-quirky-tool', tool.id)
        }}
        onDragEnd={() => { dragging.current = null }}
        onClick={() => selected ? onClose(slot) : onOpen(tool.id)}
      >
        <ToolIcon tool={tool} />
      </IconButton>
      {badge && <Badge tone="needs-you" label={badge.title}>{badge.count}</Badge>}
      <ToolMenu
        entry={tool}
        placement={placement}
        slot={slot}
        position={menuPosition}
        onMove={onMove}
      />
    </div>
  )
}

function ToolStripe({
  slot,
  tools,
  placementById,
  openId,
  badges,
  badgeTitles,
  inboxCount,
  knownIds,
  dragging,
  onOpen,
  onClose,
  onMove
}: {
  slot: UiToolSlot
  tools: readonly UiToolEntry[]
  placementById: ReadonlyMap<string, UiToolSlot>
  openId: string | null
  badges: Record<string, number>
  badgeTitles: Record<string, string>
  inboxCount: number | null
  knownIds: ReadonlySet<string>
  dragging: { current: string | null }
  onOpen: (id: string) => void
  onClose: (slot: UiToolSlot) => void
  onMove: (id: string, slot: UiToolSlot) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [menuPositions, setMenuPositions] = useState<Record<string, ToolMenuPosition>>({})
  const registerAnchor = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) anchors.current.set(id, element)
    else anchors.current.delete(id)
  }, [])
  const updateMenuPositions = useCallback(() => {
    const scrollElement = scroller.current
    if (!scrollElement) {
      setMenuPositions({})
      return
    }
    const scrollBounds = scrollElement.getBoundingClientRect()
    const next: Record<string, ToolMenuPosition> = {}
    for (const tool of tools) {
      if (placementById.get(tool.id) !== slot) continue
      const anchor = anchors.current.get(tool.id)
      if (!anchor) continue
      const bounds = anchor.getBoundingClientRect()
      const visible =
        bounds.left >= scrollBounds.left &&
        bounds.right <= scrollBounds.right &&
        bounds.top >= scrollBounds.top &&
        bounds.bottom <= scrollBounds.bottom &&
        bounds.right > 0 &&
        bounds.left < window.innerWidth &&
        bounds.bottom > 0 &&
        bounds.top < window.innerHeight
      if (visible) next[tool.id] = { left: bounds.right - 8, top: bounds.bottom - 16 }
    }
    setMenuPositions((current) => {
      const currentIds = Object.keys(current)
      const nextIds = Object.keys(next)
      if (currentIds.length !== nextIds.length) return next
      if (nextIds.every((id) => current[id]?.left === next[id].left && current[id]?.top === next[id].top)) {
        return current
      }
      return next
    })
  }, [placementById, slot, tools])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    updateMenuPositions()
    element.addEventListener('scroll', updateMenuPositions)
    window.addEventListener('scroll', updateMenuPositions, true)
    window.addEventListener('resize', updateMenuPositions)
    const observer = new ResizeObserver(updateMenuPositions)
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', updateMenuPositions)
      window.removeEventListener('scroll', updateMenuPositions, true)
      window.removeEventListener('resize', updateMenuPositions)
      observer.disconnect()
    }
  }, [updateMenuPositions])

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    const id = resolveToolDropId(dragging.current, knownIds)
    dragging.current = null
    event.currentTarget.removeAttribute('data-drop-target')
    if (id) onMove(id, slot)
  }
  const acceptDrag = (event: ReactDragEvent<HTMLElement>) => {
    const id = resolveToolDropId(dragging.current, knownIds)
    if (!id || !event.dataTransfer.types.includes('application/x-quirky-tool')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  return (
    <nav
      className={`tool-shell__stripe tool-shell__stripe--${slot}`}
      aria-label={`${SLOT_LABELS[slot]} tools`}
      onDragOver={acceptDrag}
      onDrop={handleDrop}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          event.currentTarget.removeAttribute('data-drop-target')
        }
      }}
      onDragEnter={(event) => {
        if (resolveToolDropId(dragging.current, knownIds) && event.dataTransfer.types.includes('application/x-quirky-tool')) {
          event.currentTarget.setAttribute('data-drop-target', 'true')
        }
      }}
    >
      <div ref={scroller} className="tool-shell__stripe-scroll">
        {tools.filter((tool) => placementById.get(tool.id) === slot).map((tool) => (
          <ToolItem
            key={tool.id}
            tool={tool}
            slot={slot}
            openId={openId}
            placement={placementById.get(tool.id) ?? slot}
            menuPosition={menuPositions[tool.id]}
            badges={badges}
            badgeTitles={badgeTitles}
            inboxCount={inboxCount}
            dragging={dragging}
            registerAnchor={registerAnchor}
            onOpen={onOpen}
            onClose={onClose}
            onMove={onMove}
          />
        ))}
      </div>
    </nav>
  )
}

type ResizeHandleProps = {
  label: string
  keyName: keyof UiToolResize
  value: number
  extent: number
  direction: 1 | -1
  orientation: 'vertical' | 'horizontal'
  className: string
  onPreview: (key: keyof UiToolResize, value: number | null) => void
  onCommit: (patch: UiToolResize) => void
}

function ResizeHandle({ label, keyName, value, extent, direction, orientation, className, onPreview, onCommit }: ResizeHandleProps) {
  const drag = useRef<{ pointerId: number; start: number; coordinate: number } | null>(null)
  const split = keyName.endsWith('Split')
  const { min, max } = RESIZE_BOUNDS[keyName]
  const commitValue = (next: number) => onCommit({ [keyName]: next } as UiToolResize)

  const coordinateOf = (event: ReactPointerEvent<HTMLDivElement>) => orientation === 'vertical' ? event.clientX : event.clientY
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || extent <= 0) return
    event.preventDefault()
    drag.current = { pointerId: event.pointerId, start: value, coordinate: coordinateOf(event) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const next = resizeFromPointerDelta(keyName, current.start, coordinateOf(event) - current.coordinate, direction, extent)
    onPreview(keyName, next)
  }
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    const next = resizeFromPointerDelta(keyName, current.start, coordinateOf(event) - current.coordinate, direction, extent)
    onPreview(keyName, null)
    if (commit && next !== current.start) commitValue(next)
  }
  const keyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let delta = 0
    if (orientation === 'vertical') {
      if (event.key === 'ArrowRight') delta = 1
      else if (event.key === 'ArrowLeft') delta = -1
    } else {
      if (event.key === 'ArrowDown') delta = 1
      else if (event.key === 'ArrowUp') delta = -1
    }
    if (delta !== 0) {
      event.preventDefault()
      const step = split ? 0.05 : 10
      const next = clampToolResize(keyName, value + delta * direction * step)
      if (next !== value) commitValue(next)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? min : max
      if (next !== value) commitValue(next)
    }
  }

  return (
    <div
      className={`tool-shell__resize ${className}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={extent <= 0 || undefined}
      tabIndex={extent > 0 ? 0 : -1}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={(event) => pointerEnd(event, true)}
      onPointerCancel={(event) => pointerEnd(event, false)}
      onLostPointerCapture={(event) => pointerEnd(event, false)}
      onKeyDown={keyboard}
    />
  )
}

function panelContent(entry: UiToolEntry): ReactNode {
  if (entry.id === 'host:inbox' && entry.contributionId === null) return <InboxPanel />
  if (entry.contributionId !== null) return <PluginSlot id={entry.contributionId} />
  return null
}

export function ToolShell({ geometry, sizes, onResizePreview, onResizeCommit }: ToolShellProps) {
  const host = usePluginHost()
  const { model, layout, badges, badgeTitles } = usePluginState()
  const { snapshot: attention } = useAttention()
  const inboxCount = attention.asks !== null && !attention.errors.asks ? attention.asks.length : null
  const toolLayout = layout.tools
  const tools = orderedTools(model?.tools ?? [], toolLayout)
  const placements = new Map(tools.flatMap((tool) => {
    const placement = effectiveToolPlacement(tool, toolLayout)
    return placement ? [[tool.id, placement] as const] : []
  }))
  const knownIds = new Set(tools.map((tool) => tool.id))
  const openSlots = getToolShellOpenSlots(tools, toolLayout)
  const dragging = useRef<string | null>(null)
  const move = useCallback((id: string, slot: UiToolSlot) => host.moveTool(id, slot), [host])
  const open = useCallback((id: string) => host.openTool(id), [host])
  const close = useCallback((slot: UiToolSlot) => host.closeTool(slot), [host])
  const horizontalExtent =
    geometry.leftRailWidth +
    geometry.leftPanelWidth +
    geometry.leftEdgeWidth +
    geometry.centerWidth +
    geometry.rightEdgeWidth +
    geometry.rightPanelWidth +
    geometry.rightRailWidth
  const verticalExtent =
    geometry.centerHeight +
    geometry.bottomPanelHeight +
    geometry.bottomEdgeHeight +
    geometry.bottomRailHeight
  const leftSplitExtent = Math.max(0, geometry.sideHeight - geometry.leftSplitHandleHeight)
  const rightSplitExtent = Math.max(0, geometry.sideHeight - geometry.rightSplitHandleHeight)

  const opened = UI_TOOL_SLOTS.flatMap((slot) => {
    const id = toolLayout?.open[slot]
    if (!id || !openSlots[slot] || !knownIds.has(id)) return []
    const entry = tools.find((tool) => tool.id === id)
    if (!entry || (entry.contributionId === null && entry.id !== 'host:inbox')) return []
    return [{ entry, slot }]
  })
  const openIds = new Set<string>()
  const uniqueOpened = opened.filter(({ entry }) => {
    if (openIds.has(entry.id)) return false
    openIds.add(entry.id)
    return true
  })

  return (
    <div className="tool-shell" role="group" aria-label="Tool windows">
      {UI_TOOL_SLOTS.map((slot) => (
        <ToolStripe
          key={slot}
          slot={slot}
          tools={tools}
          placementById={placements}
          openId={toolLayout?.open[slot] ?? null}
          badges={badges}
          badgeTitles={badgeTitles}
          inboxCount={inboxCount}
          knownIds={knownIds}
          dragging={dragging}
          onOpen={open}
          onClose={close}
          onMove={move}
        />
      ))}
      <div className="tool-shell__panels">
        {uniqueOpened.map(({ entry, slot }) => (
          <section className={`tool-shell__panel tool-shell__panel--${slot}`} data-tool-panel={entry.id} key={entry.id}>
            <ToolPanelFrame title={entry.title} onMinimize={() => close(slot)}>
              {panelContent(entry)}
            </ToolPanelFrame>
          </section>
        ))}
      </div>
      {openSlots['left-top'] && openSlots['left-bottom'] && (
        <ResizeHandle
          label="Resize left tool split"
          keyName="leftSplit"
          value={sizes.leftSplit}
          extent={leftSplitExtent}
          direction={1}
          orientation="horizontal"
          className="tool-shell__resize--left-split"
          onPreview={onResizePreview}
          onCommit={onResizeCommit}
        />
      )}
      {openSlots['right-top'] && openSlots['right-bottom'] && (
        <ResizeHandle
          label="Resize right tool split"
          keyName="rightSplit"
          value={sizes.rightSplit}
          extent={rightSplitExtent}
          direction={1}
          orientation="horizontal"
          className="tool-shell__resize--right-split"
          onPreview={onResizePreview}
          onCommit={onResizeCommit}
        />
      )}
      {openSlots['bottom-left'] && openSlots['bottom-right'] && (
        <ResizeHandle
          label="Resize bottom tool split"
          keyName="bottomSplit"
          value={sizes.bottomSplit}
          extent={geometry.bottomLeftStripeWidth + geometry.bottomRightStripeWidth}
          direction={1}
          orientation="vertical"
          className="tool-shell__resize--bottom-split"
          onPreview={onResizePreview}
          onCommit={onResizeCommit}
        />
      )}
      {(openSlots['left-top'] || openSlots['left-bottom']) && (
        <ResizeHandle
          label="Resize left tools"
          keyName="left"
          value={sizes.left}
          extent={horizontalExtent}
          direction={1}
          orientation="vertical"
          className="tool-shell__resize--left-edge"
          onPreview={onResizePreview}
          onCommit={onResizeCommit}
        />
      )}
      {(openSlots['right-top'] || openSlots['right-bottom']) && (
        <ResizeHandle
          label="Resize right tools"
          keyName="right"
          value={sizes.right}
          extent={horizontalExtent}
          direction={-1}
          orientation="vertical"
          className="tool-shell__resize--right-edge"
          onPreview={onResizePreview}
          onCommit={onResizeCommit}
        />
      )}
      {(openSlots['bottom-left'] || openSlots['bottom-right']) && (
        <ResizeHandle
          label="Resize bottom tools"
          keyName="bottom"
          value={sizes.bottom}
          extent={verticalExtent}
          direction={-1}
          orientation="horizontal"
          className="tool-shell__resize--bottom-edge"
          onPreview={onResizePreview}
          onCommit={onResizeCommit}
        />
      )}
    </div>
  )
}
