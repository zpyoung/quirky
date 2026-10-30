import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { UiKeybinding, UiToolEntry, UiToolLayout, UiToolPlacement, UiToolResize, UiToolSlot } from '@quirky/protocol'
import { UI_TOOL_SLOTS } from '@quirky/protocol'
import { Badge, ContextMenu, ControlIcon, IconButton, PopupMenu, ToolIcon, ToolPanelFrame, type ContextMenuItem, type PopupItem } from '../design-system'
import { usePluginHost, usePluginState } from '../context'
import { PluginSlot } from '../plugins/PluginSlot'
import { useRegion } from '../plugins/useRegion'
import { InboxPanel } from './ShellChrome'
import { SLOT_LABELS } from './tool-slot-labels'
import { useAttention } from './attention'
import { trackPanelFocus } from './panel-focus'
import './tool-shell.css'

export type ToolShellChrome = {
  rail: number
  splitter: number
  centerMinWidth: number
  centerMinHeight: number
  /** Space between cards; falls back to `splitter` when a caller doesn't measure it. */
  gap?: number
}

export type ToolShellOpenSlots = Record<UiToolSlot, boolean>

export type ToolShellGeometry = {
  cardGap: number
  leftRailWidth: number
  leftPanelWidth: number
  leftEdgeWidth: number
  centerWidth: number
  rightEdgeWidth: number
  rightPanelWidth: number
  rightRailWidth: number
  bottomPanelHeight: number
  bottomEdgeHeight: number
  centerHeight: number
  sideHeight: number
  leftTopHeight: number
  leftBottomHeight: number
  leftBottomTop: number
  leftSplitHandleHeight: number
  rightTopHeight: number
  rightBottomHeight: number
  rightBottomTop: number
  rightSplitHandleHeight: number
  bottomLeftPanelWidth: number
  bottomRightPanelWidth: number
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

function splitHeights(total: number, topOpen: boolean, bottomOpen: boolean, ratio: number, gap: number) {
  if (topOpen && bottomOpen) {
    const handle = Math.min(total, gap)
    const usable = Math.max(0, total - handle)
    const top = usable * ratio
    return { top, bottom: usable - top, bottomTop: top + handle, handle }
  }
  if (topOpen) return { top: total, bottom: 0, bottomTop: total, handle: 0 }
  if (bottomOpen) return { top: 0, bottom: total, bottomTop: 0, handle: 0 }
  return { top: 0, bottom: 0, bottomTop: total, handle: 0 }
}

/**
 * Sizes every card from the window. The side stripes run the full height, so the bottom panels
 * span only the width between them, and a gap of `chrome.gap` separates each pair of open cards.
 */
export function fitToolShellGeometry(
  sizes: UiToolLayout['sizes'],
  viewport: { width: number; height: number },
  open: ToolShellOpenSlots,
  chrome: ToolShellChrome
): ToolShellGeometry {
  const width = positive(viewport.width)
  const height = positive(viewport.height)
  const rail = positive(chrome.rail)
  const cardGap = positive(chrome.gap ?? chrome.splitter)
  const leftOpen = open['left-top'] || open['left-bottom']
  const rightOpen = open['right-top'] || open['right-bottom']
  const bottomLeftOpen = open['bottom-left']
  const bottomRightOpen = open['bottom-right']
  const bottomOpen = bottomLeftOpen || bottomRightOpen
  const leftRailWidth = Math.min(rail, width / 2)
  const rightRailWidth = leftRailWidth
  const horizontalSpace = Math.max(0, width - leftRailWidth - rightRailWidth)
  const activeEdges = Number(leftOpen) + Number(rightOpen)
  const edgeWidth = activeEdges === 0 ? 0 : Math.min(cardGap, horizontalSpace / activeEdges)
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

  const bottomEdgeHeight = bottomOpen ? Math.min(cardGap, height) : 0
  const verticalSpace = Math.max(0, height - bottomEdgeHeight)
  const centerMinimumHeight = Math.min(positive(chrome.centerMinHeight), verticalSpace)
  const bottomPanelHeight = bottomOpen
    ? Math.min(clampToolResize('bottom', sizes.bottom), Math.max(0, verticalSpace - centerMinimumHeight))
    : 0
  const centerHeight = Math.max(0, height - bottomEdgeHeight - bottomPanelHeight)
  const sideHeight = centerHeight

  const leftSplit = clampToolResize('leftSplit', sizes.leftSplit)
  const rightSplit = clampToolResize('rightSplit', sizes.rightSplit)
  const bottomSplit = clampToolResize('bottomSplit', sizes.bottomSplit)
  const leftRows = splitHeights(sideHeight, open['left-top'], open['left-bottom'], leftSplit, cardGap)
  const rightRows = splitHeights(sideHeight, open['right-top'], open['right-bottom'], rightSplit, cardGap)

  const bottomSpace = horizontalSpace
  const bottomSplitHandleWidth = bottomLeftOpen && bottomRightOpen
    ? Math.min(cardGap, bottomSpace)
    : 0
  const bottomUsableWidth = Math.max(0, bottomSpace - bottomSplitHandleWidth)
  const splitLeftWidth = bottomUsableWidth * bottomSplit
  const splitRightWidth = bottomUsableWidth - splitLeftWidth
  const bottomLeftPanelWidth = bottomLeftOpen ? (bottomRightOpen ? splitLeftWidth : bottomSpace) : 0
  const bottomRightPanelWidth = bottomRightOpen ? (bottomLeftOpen ? splitRightWidth : bottomSpace) : 0
  const bottomPanelTop = sideHeight + bottomEdgeHeight

  return {
    cardGap,
    leftRailWidth,
    leftPanelWidth,
    leftEdgeWidth,
    centerWidth,
    rightEdgeWidth,
    rightPanelWidth,
    rightRailWidth,
    bottomPanelHeight,
    bottomEdgeHeight,
    centerHeight,
    sideHeight,
    leftTopHeight: leftRows.top,
    leftBottomHeight: leftRows.bottom,
    leftBottomTop: leftRows.bottomTop,
    leftSplitHandleHeight: leftRows.handle,
    rightTopHeight: rightRows.top,
    rightBottomHeight: rightRows.bottom,
    rightBottomTop: rightRows.bottomTop,
    rightSplitHandleHeight: rightRows.handle,
    bottomLeftPanelWidth,
    bottomRightPanelWidth,
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
    centerMinHeight: read('--tool-shell-center-min-height'),
    gap: read('--tool-shell-card-gap')
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
    '--tool-side-height': geometry.sideHeight,
    '--tool-left-top-height': geometry.leftTopHeight,
    '--tool-left-bottom-height': geometry.leftBottomHeight,
    '--tool-left-bottom-top': geometry.leftBottomTop,
    '--tool-left-split-handle-height': geometry.leftSplitHandleHeight,
    '--tool-right-top-height': geometry.rightTopHeight,
    '--tool-right-bottom-height': geometry.rightBottomHeight,
    '--tool-right-bottom-top': geometry.rightBottomTop,
    '--tool-right-split-handle-height': geometry.rightSplitHandleHeight,
    '--tool-bottom-left-panel-width': geometry.bottomLeftPanelWidth,
    '--tool-bottom-right-panel-width': geometry.bottomRightPanelWidth,
    '--tool-bottom-split-handle-width': geometry.bottomSplitHandleWidth,
    '--tool-bottom-panel-top': geometry.bottomPanelTop,
  } as CSSProperties & Record<`--tool-${string}`, number>
}

function sortByLayoutOrder(candidates: readonly UiToolEntry[], layout: UiToolLayout | undefined): UiToolEntry[] {
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

function uniqueTools(tools: readonly UiToolEntry[], keep: (tool: UiToolEntry) => boolean): UiToolEntry[] {
  const seen = new Set<string>()
  return tools.filter((tool) => {
    if (seen.has(tool.id) || !keep(tool)) return false
    seen.add(tool.id)
    return true
  })
}

function orderedTools(tools: readonly UiToolEntry[], layout: UiToolLayout | undefined): UiToolEntry[] {
  return sortByLayoutOrder(uniqueTools(tools, (tool) => effectiveToolPlacement(tool, layout) !== null), layout)
}

function removedTools(tools: readonly UiToolEntry[], layout: UiToolLayout | undefined): UiToolEntry[] {
  return sortByLayoutOrder(uniqueTools(tools, (tool) => layout?.placements[tool.id] === 'overflow'), layout)
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


const CHORD_GLYPHS: Record<string, string> = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }

/** A canonical chord such as `mod+shift+g` as the platform shows it, here `⌘⇧G`. */
export function formatChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => CHORD_GLYPHS[part] ?? (part.length === 1 || /^f\d+$/.test(part) ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
    .join('')
}

/** The shortcut of the first active binding aimed at the tool or one of its contribution IDs, or null. */
export function toolShortcut(tool: UiToolEntry, keybindings: readonly UiKeybinding[]): string | null {
  const targets = new Set([tool.id, ...(tool.contributionId === null ? [] : [tool.contributionId]), ...tool.aliases])
  const binding = keybindings.find((candidate) => candidate.status === 'active' && targets.has(candidate.command))
  return binding ? formatChord(binding.key) : null
}

/**
 * The tools a stripe must hide to fit `capacity` rows. Trailing tools of the lower group go first,
 * then trailing tools of the upper group; a `pinned` tool (one that is open) is never chosen.
 */
export function hideTrailingTools({ upper, lower, pinned, capacity }: {
  upper: readonly string[]
  lower: readonly string[]
  pinned: ReadonlySet<string>
  capacity: number
}): string[] {
  let excess = upper.length + lower.length - Math.floor(capacity)
  const hidden: string[] = []
  for (const id of [...lower].reverse().concat([...upper].reverse())) {
    if (excess <= 0) break
    if (pinned.has(id)) continue
    hidden.push(id)
    excess -= 1
  }
  return hidden
}

type StripeSide = 'left' | 'right'
type StripePosition = 'upper' | 'lower' | 'foot'

const STRIPE_SLOTS: Record<StripeSide, Record<StripePosition, UiToolSlot>> = {
  left: { upper: 'left-top', lower: 'left-bottom', foot: 'bottom-left' },
  right: { upper: 'right-top', lower: 'right-bottom', foot: 'bottom-right' }
}
const STRIPE_POSITIONS: readonly StripePosition[] = ['upper', 'lower', 'foot']
const STRIPE_LABELS: Record<StripeSide, string> = { left: 'Left tools', right: 'Right tools' }

/**
 * How many tools the stripe's upper and lower groups can show: those showing now plus the whole
 * rows left over in the spacer, or fewer when the stripe overflows. Null while the stripe has no
 * measurable size, so a hidden or unlaid-out stripe never hides anything.
 */
function stripeCapacity(nav: HTMLElement, pitchCache: { current: number }): number | null {
  const group = nav.querySelector<HTMLElement>('.tool-shell__group')
  const spacer = nav.querySelector<HTMLElement>('.tool-shell__spacer')
  const rowGap = group ? positive(Number.parseFloat(getComputedStyle(group).rowGap)) : 0
  const toolHeight = nav.querySelector<HTMLElement>('.tool-shell__tool')?.getBoundingClientRect().height ?? 0
  if (toolHeight > 0) pitchCache.current = toolHeight + rowGap
  const pitch = pitchCache.current
  if (pitch <= 0 || !spacer || nav.clientHeight <= 0) return null
  const shown = nav.querySelectorAll('.tool-shell__group--upper .tool-shell__tool, .tool-shell__group--lower .tool-shell__tool').length
  const overflow = Math.max(0, nav.scrollHeight - nav.clientHeight)
  const slack = spacer.getBoundingClientRect().height - overflow
  return shown + Math.floor(slack / pitch)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function ToolItem({
  tool,
  slot,
  openId,
  placement,
  badges,
  badgeTitles,
  inboxCount,
  activityItemIds,
  dragging,
  onOpen,
  onClose,
  onMove
}: {
  tool: UiToolEntry
  slot: UiToolSlot
  openId: string | null
  placement: UiToolSlot
  badges: Record<string, number>
  badgeTitles: Record<string, string>
  inboxCount: number | null
  activityItemIds: ReadonlySet<string>
  dragging: { current: string | null }
  onOpen: (id: string) => void
  onClose: (slot: UiToolSlot) => void
  onMove: (id: string, placement: UiToolPlacement) => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const provider = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const menuWasOpen = useRef(false)
  const closeMenu = useCallback(() => setMenuPosition(null), [])
  const menuItems = useMemo<ContextMenuItem[]>(() => [
    ...UI_TOOL_SLOTS.map((destination) => ({
      id: destination,
      label: SLOT_LABELS[destination],
      enabled: destination !== placement,
      onSelect: () => onMove(tool.id, destination)
    })),
    { id: 'overflow', label: 'Remove from stripe', separatorBefore: true, onSelect: () => onMove(tool.id, 'overflow') }
  ], [onMove, placement, tool.id])

  useLayoutEffect(() => {
    if (menuPosition) {
      menuWasOpen.current = true
      return
    }
    if (!menuWasOpen.current) return
    menuWasOpen.current = false
    const focusTarget = button.current ?? provider.current?.querySelector<HTMLButtonElement>('button')
    if (focusTarget?.isConnected) focusTarget.focus()
  }, [menuPosition])

  const selected = openId === tool.id
  const activityItemId = tool.aliases.find((id) => id !== tool.contributionId && activityItemIds.has(id))
  const badge = activityItemId ? null : toolBadge(tool, badges, badgeTitles, inboxCount)
  const handleDragStart = (event: ReactDragEvent<HTMLElement>) => {
    dragging.current = tool.id
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-quirky-tool', tool.id)
  }
  const handleDragEnd = () => { dragging.current = null }

  return (
    <div className="tool-shell__tool" data-selected={selected}>
      {activityItemId
        ? (
          <div
            ref={provider}
            className="tool-shell__tool-provider"
            draggable
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenuPosition({ x: event.clientX, y: event.clientY })
            }}
            onKeyDown={(event) => {
              if (!((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu')) return
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              setMenuPosition({ x: bounds.left, y: bounds.bottom })
            }}
          >
            <ToolIcon name={tool.icon} hue={tool.hue} />
            <PluginSlot id={activityItemId} />
          </div>
        )
        : (
          <IconButton
            ref={button}
            className="tool-shell__tool-button"
            label={tool.title}
            title={tool.title}
            aria-pressed={selected}
            aria-haspopup="menu"
            aria-expanded={menuPosition !== null}
            draggable
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenuPosition({ x: event.clientX, y: event.clientY })
            }}
            onKeyDown={(event) => {
              if (!((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu')) return
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              setMenuPosition({ x: bounds.left, y: bounds.bottom })
            }}
            onClick={() => selected ? onClose(slot) : onOpen(tool.id)}
          >
            <ToolIcon name={tool.icon} hue={tool.hue} />
          </IconButton>
        )}
      {!activityItemId && badge && <Badge tone="needs-you" label={badge.title}>{badge.count}</Badge>}
      {menuPosition && (
        <ContextMenu
          label={`Move ${tool.title}`}
          items={menuItems}
          x={menuPosition.x}
          y={menuPosition.y}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

function OverflowButton({ tools, keybindings, onOpen }: {
  tools: readonly UiToolEntry[]
  keybindings: readonly UiKeybinding[]
  onOpen: (id: string) => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const items = useMemo<PopupItem[]>(() => {
    if (tools.length === 0) return [{ id: 'none', label: 'No hidden tools', enabled: false }]
    return tools.map((tool) => ({
      id: tool.id,
      label: tool.title,
      lead: <ToolIcon name={tool.icon} hue={tool.hue} />,
      trailing: toolShortcut(tool, keybindings) ?? undefined,
      onSelect: () => onOpen(tool.id)
    }))
  }, [keybindings, onOpen, tools])
  const dismiss = useCallback(() => setAnchor(null), [])

  return (
    <div className="tool-shell__overflow">
      <IconButton
        className="tool-shell__overflow-button"
        label="More tools"
        title="More tools"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(anchor === null ? event.currentTarget : null)}
      >
        <ControlIcon name="dots-three" />
      </IconButton>
      {anchor && <PopupMenu anchor={anchor} items={items} title="More tools" onClose={dismiss} />}
    </div>
  )
}

function StripeGroup({
  position,
  slot,
  tools,
  openId,
  placementById,
  badges,
  badgeTitles,
  inboxCount,
  activityItemIds,
  knownIds,
  dragging,
  onOpen,
  onClose,
  onMove
}: {
  position: StripePosition
  slot: UiToolSlot
  tools: readonly UiToolEntry[]
  openId: string | null
  placementById: ReadonlyMap<string, UiToolSlot>
  badges: Record<string, number>
  badgeTitles: Record<string, string>
  inboxCount: number | null
  activityItemIds: ReadonlySet<string>
  knownIds: ReadonlySet<string>
  dragging: { current: string | null }
  onOpen: (id: string) => void
  onClose: (slot: UiToolSlot) => void
  onMove: (id: string, placement: UiToolPlacement) => void
}) {
  const accepts = (event: ReactDragEvent<HTMLElement>) =>
    resolveToolDropId(dragging.current, knownIds) !== null && event.dataTransfer.types.includes('application/x-quirky-tool')
  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    const id = resolveToolDropId(dragging.current, knownIds)
    dragging.current = null
    event.currentTarget.removeAttribute('data-drop-target')
    if (id) onMove(id, slot)
  }

  return (
    <div
      className={`tool-shell__group tool-shell__group--${position}`}
      data-slot={slot}
      onDragOver={(event) => {
        if (!accepts(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={handleDrop}
      onDragEnter={(event) => {
        if (accepts(event)) event.currentTarget.setAttribute('data-drop-target', 'true')
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          event.currentTarget.removeAttribute('data-drop-target')
        }
      }}
    >
      {tools.map((tool) => (
        <ToolItem
          key={tool.id}
          tool={tool}
          slot={slot}
          openId={openId}
          placement={placementById.get(tool.id) ?? slot}
          badges={badges}
          badgeTitles={badgeTitles}
          inboxCount={inboxCount}
          activityItemIds={activityItemIds}
          dragging={dragging}
          onOpen={onOpen}
          onClose={onClose}
          onMove={onMove}
        />
      ))}
    </div>
  )
}

function ToolStripe({
  side,
  tools,
  placementById,
  open,
  hidden,
  overflowTools,
  keybindings,
  badges,
  badgeTitles,
  inboxCount,
  activityItemIds,
  knownIds,
  dragging,
  onHiddenChange,
  onOpen,
  onClose,
  onMove
}: {
  side: StripeSide
  tools: readonly UiToolEntry[]
  placementById: ReadonlyMap<string, UiToolSlot>
  open: UiToolLayout['open'] | undefined
  hidden: readonly string[]
  overflowTools: readonly UiToolEntry[]
  keybindings: readonly UiKeybinding[]
  badges: Record<string, number>
  badgeTitles: Record<string, string>
  inboxCount: number | null
  activityItemIds: ReadonlySet<string>
  knownIds: ReadonlySet<string>
  dragging: { current: string | null }
  onHiddenChange: (side: StripeSide, ids: string[]) => void
  onOpen: (id: string) => void
  onClose: (slot: UiToolSlot) => void
  onMove: (id: string, placement: UiToolPlacement) => void
}) {
  const nav = useRef<HTMLElement>(null)
  const pitch = useRef(0)
  const slots = STRIPE_SLOTS[side]
  const hiddenIds = new Set(hidden)
  const inGroup = (position: StripePosition) => tools.filter((tool) => placementById.get(tool.id) === slots[position])
  const groups = { upper: inGroup('upper'), lower: inGroup('lower'), foot: inGroup('foot') }
  const pinned = new Set(STRIPE_POSITIONS.flatMap((position) => open?.[slots[position]] ?? []))
  const signature = [
    ...STRIPE_POSITIONS.map((position) => groups[position].map((tool) => tool.id).join(',')),
    [...pinned].sort().join(',')
  ].join('|')
  const latest = useRef({ upper: [] as string[], lower: [] as string[], pinned })
  latest.current = { upper: groups.upper.map((tool) => tool.id), lower: groups.lower.map((tool) => tool.id), pinned }

  useLayoutEffect(() => {
    const element = nav.current
    if (!element) return
    const fit = () => {
      const capacity = stripeCapacity(element, pitch)
      onHiddenChange(side, capacity === null ? [] : hideTrailingTools({ ...latest.current, capacity }))
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(element)
    window.addEventListener('resize', fit)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [side, signature, onHiddenChange])

  const group = (position: StripePosition) => (
    <StripeGroup
      position={position}
      slot={slots[position]}
      tools={groups[position].filter((tool) => !hiddenIds.has(tool.id))}
      openId={open?.[slots[position]] ?? null}
      placementById={placementById}
      badges={badges}
      badgeTitles={badgeTitles}
      inboxCount={inboxCount}
      activityItemIds={activityItemIds}
      knownIds={knownIds}
      dragging={dragging}
      onOpen={onOpen}
      onClose={onClose}
      onMove={onMove}
    />
  )

  return (
    <nav ref={nav} className={`tool-shell__stripe tool-shell__stripe--${side}`} aria-label={STRIPE_LABELS[side]}>
      {group('upper')}
      <div className="tool-shell__separator" role="separator" aria-orientation="horizontal" />
      {group('lower')}
      {side === 'left' && <OverflowButton tools={overflowTools} keybindings={keybindings} onOpen={onOpen} />}
      <div className="tool-shell__spacer" />
      {group('foot')}
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
  const panelRegion = useRegion('panel')
  const { snapshot: attention } = useAttention()
  const inboxCount = attention.asks !== null && !attention.errors.asks ? attention.asks.length : null
  const toolLayout = layout.tools
  const tools = orderedTools(model?.tools ?? [], toolLayout)
  const activityItemIds = new Set(
    (model?.activityItems ?? []).filter(({ module }) => module !== null).map(({ id }) => id)
  )
  const placements = new Map(tools.flatMap((tool) => {
    const placement = effectiveToolPlacement(tool, toolLayout)
    return placement ? [[tool.id, placement] as const] : []
  }))
  const knownIds = new Set(tools.map((tool) => tool.id))
  const openSlots = getToolShellOpenSlots(tools, toolLayout)
  const dragging = useRef<string | null>(null)
  const [hidden, setHidden] = useState<Record<StripeSide, string[]>>({ left: [], right: [] })
  const move = useCallback((id: string, placement: UiToolPlacement) => host.moveTool(id, placement), [host])
  const open = useCallback((id: string) => host.openTool(id), [host])
  const close = useCallback((slot: UiToolSlot) => host.closeTool(slot), [host])
  const updateHidden = useCallback((side: StripeSide, ids: string[]) => {
    setHidden((current) => (sameIds(current[side], ids) ? current : { ...current, [side]: ids }))
  }, [])
  useEffect(() => trackPanelFocus(document), [])

  const hiddenIds = new Set([...hidden.left, ...hidden.right])
  const overflowTools = uniqueTools(
    [...removedTools(model?.tools ?? [], toolLayout), ...tools.filter((tool) => hiddenIds.has(tool.id))],
    () => true
  )
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
    geometry.bottomEdgeHeight
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
      {(['left', 'right'] as const).map((side) => (
        <ToolStripe
          key={side}
          side={side}
          tools={tools}
          placementById={placements}
          open={toolLayout?.open}
          hidden={hidden[side]}
          overflowTools={overflowTools}
          keybindings={model?.keybindings ?? []}
          badges={badges}
          badgeTitles={badgeTitles}
          inboxCount={inboxCount}
          activityItemIds={activityItemIds}
          knownIds={knownIds}
          dragging={dragging}
          onHiddenChange={updateHidden}
          onOpen={open}
          onClose={close}
          onMove={move}
        />
      ))}
      <div className="tool-shell__overlay-button-anchor" data-overlay-button-anchor aria-hidden="true" />
      <aside className="tool-shell__panels" {...panelRegion}>
        {uniqueOpened.map(({ entry, slot }) => (
          <section className={`tool-shell__panel tool-shell__panel--${slot}`} data-tool-panel={entry.id} key={entry.id}>
            <ToolPanelFrame title={entry.title} onMinimize={() => close(slot)}>
              {panelContent(entry)}
            </ToolPanelFrame>
          </section>
        ))}
      </aside>
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
          extent={geometry.bottomLeftPanelWidth + geometry.bottomRightPanelWidth}
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
