import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { parseContributionId } from '@quirky/protocol'

import { paneLeaves, paneRects, roundRatio } from '../../layout/tree'
import type { DividerRect, PaneRect } from '../../layout/tree'
import type { Edge, Group, PaneLeaf, PaneNode, Tab } from '../../layout/types'
import { TerminalPaneView } from '../pane/TerminalPaneView'
import { CollapseIcon, CloseIcon, ExpandIcon, GripIcon } from './icons'
import type { ControllerState, PaneDropTarget, WorkspaceController } from './controller'
import { STRUCTURED_VIEW_ID, byPaneId, px } from './model'
import { useBoxSize } from './useBoxSize'

/** The narrowest a pane may be drawn or dragged to, unless its pair is smaller. */
export const MIN_PANE_PX = 50
/** How far a pane header's handle must move before a drag starts. */
export const PANE_DRAG_THRESHOLD_PX = 5

type Props = {
  controller: WorkspaceController
  state: ControllerState
  group: Group
  tab: Tab
}

/**
 * An inline text field for a title: Enter commits, Escape cancels, leaving it commits, and an
 * Enter that confirms an IME candidate does nothing.
 */
export function InlineField({ label, initial, className, onCommit, onCancel }: { label: string; initial: string; className: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const finished = useRef(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const finish = (commit: boolean) => {
    if (finished.current) return
    finished.current = true
    if (commit) onCommit(value)
    else onCancel()
  }

  return (
    <input
      ref={input}
      className={className}
      aria-label={label}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    />
  )
}

function StructuredHost({ controller, session }: { controller: WorkspaceController; session: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const element = host.current
    if (!element) return
    try {
      return controller.context.mountView(STRUCTURED_VIEW_ID, element, { session })
    } catch {
      setFailed(true)
    }
  }, [controller, session])
  return (
    <div className="qt-structured">
      <div ref={host} className="qt-structured-body" />
      {failed ? <p className="qt-muted">The structured session view is not available.</p> : null}
    </div>
  )
}

type TerminalAccessory = { id: string; plugin: string; title: string; order: number; view: string }

function terminalAccessoriesOf(contributions: unknown, model: unknown): TerminalAccessory[] {
  if (!Array.isArray(contributions) || typeof model !== 'object' || model === null || Array.isArray(model) || !('views' in model)) {
    return []
  }
  const rawViews: unknown = model.views
  if (!Array.isArray(rawViews)) return []
  const views: unknown[] = rawViews
  const accessories: TerminalAccessory[] = []
  const entries: unknown[] = contributions
  for (const raw of entries) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      Array.isArray(raw) ||
      !('id' in raw) ||
      !('kind' in raw) ||
      !('plugin' in raw) ||
      !('status' in raw) ||
      !('data' in raw)
    ) {
      continue
    }
    const id = raw.id
    if (typeof id !== 'string') continue
    const parsedId = parseContributionId(id)
    if (parsedId?.kind !== 'terminal-accessory' || raw.kind !== 'terminal-accessory' || raw.status !== 'effective') continue
    if (typeof raw.plugin !== 'string') continue
    const data = raw.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
    if (Object.keys(data).some((key) => !['title', 'order', 'view'].includes(key))) continue
    const title = Reflect.get(data, 'title')
    const view = Reflect.get(data, 'view')
    const rawOrder = Reflect.get(data, 'order')
    if (typeof title !== 'string' || title.trim() === '' || typeof view !== 'string') continue
    const order = rawOrder === undefined ? 100 : rawOrder
    if (typeof order !== 'number' || !Number.isFinite(order) || parseContributionId(view)?.kind !== 'view') continue
    const available = views.some(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        'id' in candidate &&
        candidate.id === view &&
        'module' in candidate &&
        typeof candidate.module === 'string' &&
        candidate.module !== ''
    )
    if (!available) continue
    accessories.push({ id, plugin: raw.plugin, title, order, view })
  }
  accessories.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return accessories
}

function PaneAccessoryMount({
  controller,
  sessionId,
  paneId,
  accessory
}: {
  controller: WorkspaceController
  sessionId: string
  paneId: string
  accessory: TerminalAccessory
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = host.current
    if (!element) return
    let unmount: (() => void) | void
    try {
      unmount = controller.context.mountView(accessory.view, element, { sessionId, paneId })
    } catch (error) {
      controller.context.log(`terminal accessory ${accessory.id} could not mount: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    return () => {
      if (typeof unmount === 'function') unmount()
    }
  }, [controller, sessionId, paneId, accessory.id, accessory.plugin, accessory.view])
  return <div ref={host} className="qt-pane-accessory" data-terminal-accessory={accessory.id} aria-label={accessory.title} />
}

function PaneAccessories({ controller, sessionId, paneId }: { controller: WorkspaceController; sessionId: string; paneId: string }) {
  const [accessories, setAccessories] = useState<TerminalAccessory[]>([])
  useEffect(() => {
    let active = true
    let generation = 0
    const refresh = async () => {
      const request = ++generation
      try {
        const [contributions, model] = await Promise.all([
          controller.context.call('plugin.contributions', { kind: 'terminal-accessory' }),
          controller.context.call('ui.contributions', {})
        ])
        if (active && request === generation) setAccessories(terminalAccessoriesOf(contributions, model))
      } catch (error) {
        if (active && request === generation) {
          controller.context.log(`terminal accessory refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    const unsubscribe = controller.context.subscribe((event) => {
      if (event.type === 'plugin.changed') void refresh()
    })
    void refresh()
    return () => {
      active = false
      generation++
      unsubscribe()
    }
  }, [controller])
  useEffect(() => {
    controller.setMountedAccessories(paneId, accessories.map((accessory) => accessory.id))
  }, [controller, paneId, accessories])
  useEffect(() => () => controller.setMountedAccessories(paneId, []), [controller, paneId])
  return (
    <div className="qt-pane-accessories" data-pane-accessories={paneId}>
      {accessories.map((accessory) => (
        <PaneAccessoryMount
          key={`${accessory.id}:${accessory.plugin}:${accessory.view}`}
          controller={controller}
          sessionId={sessionId}
          paneId={paneId}
          accessory={accessory}
        />
      ))}
    </div>
  )
}

function exitText(exit: NonNullable<PaneLeaf['exit']>): string {
  if (exit.code !== null) return `The shell process ended with exit code ${exit.code}. Its output is preserved.`
  if (exit.signal) return `The shell process ended with signal ${exit.signal}. Its output is preserved.`
  return 'The shell process ended. Its output is preserved.'
}

function ExitOverlay({ controller, leaf }: { controller: WorkspaceController; leaf: PaneLeaf }) {
  return (
    <div className="qt-exit" role="alert" data-exit-overlay={leaf.id}>
      <strong>Terminal exited</strong>
      <span>{exitText(leaf.exit!)}</span>
      <div className="qt-exit-actions">
        <button type="button" onClick={() => void controller.closePane(leaf.id)}>
          Close
        </button>
        <button type="button" className="qt-primary" onClick={() => void controller.restartPane(leaf.id)}>
          Restart
        </button>
      </div>
    </div>
  )
}

function PaneHeader({ controller, state, tab, leaf, multi, onGrip }: { controller: WorkspaceController; state: ControllerState; tab: Tab; leaf: PaneLeaf; multi: boolean; onGrip: (event: ReactMouseEvent) => void }) {
  const renaming = state.rename?.kind === 'pane' && state.rename.id === leaf.id
  const expanded = tab.expandedPane !== null
  let close
  if (!multi) {
    close = (
      <button type="button" className="qt-icon" aria-label="Close tab" title="Close tab" onClick={() => void controller.closeTab(tab.id)}>
        <CloseIcon />
      </button>
    )
  } else if (leaf.title) {
    close = (
      <button type="button" className="qt-icon" aria-label="Remove title" title="Remove title" onClick={() => void controller.clearTitle(leaf.id)}>
        <CloseIcon />
      </button>
    )
  } else {
    close = (
      <button type="button" className="qt-icon" aria-label="Close Pane" title="Close Pane" onClick={() => void controller.closePane(leaf.id)}>
        <CloseIcon />
      </button>
    )
  }

  return (
    <div className="qt-pane-header" data-pane-header={leaf.id} onMouseDown={(event) => event.stopPropagation()}>
      {renaming ? (
        <InlineField label="Pane title" initial={leaf.title ?? ''} className="qt-title-field" onCommit={(value) => void controller.commitRename(value)} onCancel={() => controller.cancelRename()} />
      ) : leaf.title ? (
        <span className="qt-pane-title" title={leaf.title}>
          {leaf.title}
        </span>
      ) : null}
      {multi ? (
        <button type="button" className="qt-icon qt-grip" aria-label="Move pane" title="Move pane" onMouseDown={onGrip}>
          <GripIcon />
        </button>
      ) : null}
      {multi ? (
        <button
          type="button"
          className="qt-icon"
          aria-label={expanded ? 'Collapse pane' : 'Expand pane'}
          title={expanded ? 'Collapse pane' : 'Expand pane'}
          onClick={() => void controller.toggleExpand(leaf.id)}
        >
          {expanded ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      ) : null}
      {close}
    </div>
  )
}

function splitRatioOf(node: PaneNode, id: string): number | null {
  if (node.kind === 'pane') return null
  if (node.id === id) return node.ratio
  return splitRatioOf(node.first, id) ?? splitRatioOf(node.second, id)
}

/** The edge of a rectangle nearest the point, for a drop onto a pane. */
function nearestEdge(rect: PaneRect, x: number, y: number): Edge {
  const left = (x - rect.x) / rect.width
  const top = (y - rect.y) / rect.height
  const distances: [Edge, number][] = [
    ['left', left],
    ['right', 1 - left],
    ['top', top],
    ['bottom', 1 - top]
  ]
  return distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0]
}

/** The part of a pane a drop would fill: the half on the side it lands on. */
function halfOf(rect: PaneRect, edge: Edge): { left: number; top: number; width: number; height: number } {
  const halfW = rect.width / 2
  const halfH = rect.height / 2
  if (edge === 'left') return { left: rect.x, top: rect.y, width: halfW, height: rect.height }
  if (edge === 'right') return { left: rect.x + halfW, top: rect.y, width: halfW, height: rect.height }
  if (edge === 'top') return { left: rect.x, top: rect.y, width: rect.width, height: halfH }
  return { left: rect.x, top: rect.y + halfH, width: rect.width, height: halfH }
}

/**
 * The panes of a group's active tab. Every pane is a direct child of one flat container, keyed by
 * its ID and absolutely positioned from rectangles computed off the pane tree, so a split, close
 * or move changes rectangles and never re-parents a terminal.
 */
export function PaneLayer({ controller, state, group, tab }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const size = useBoxSize(container)
  const { settings, sessions, cwds, workspace } = state
  const root = controller.previewedPanes(tab.root)
  const leaves = paneLeaves(root)
  const expandedLeaf = tab.expandedPane === null ? null : (leaves.find((leaf) => leaf.id === tab.expandedPane) ?? null)
  const multi = leaves.length > 1
  const laidOut = size.width > 0 && size.height > 0
  const thickness = settings['divider-thickness']

  let rects: PaneRect[] = []
  let dividers: DividerRect[] = []
  if (laidOut) {
    if (expandedLeaf) rects = [{ pane: expandedLeaf.id, x: 0, y: 0, width: size.width, height: size.height }]
    else ({ panes: rects, dividers } = paneRects(root, size.width, size.height, MIN_PANE_PX, thickness))
  }
  const rectOf = new Map(rects.map((rect) => [rect.pane, rect]))
  const shown = byPaneId(expandedLeaf ? [expandedLeaf] : leaves).filter((leaf) => rectOf.has(leaf.id))
  const focusedGroup = workspace?.activeGroup === group.id

  const startDivider = (divider: DividerRect, event: ReactMouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const element = container.current
    if (!element) return
    const total = divider.direction === 'right' ? divider.area.width : divider.area.height
    const lowest = Math.min(MIN_PANE_PX, total / 2) / total
    const original = splitRatioOf(tab.root, divider.split)
    let latest: { kind: 'pane'; split: string; ratio: number } | null = null
    const onMove = (move: MouseEvent) => {
      const rect = element.getBoundingClientRect()
      const offset = divider.direction === 'right' ? move.clientX - rect.left - divider.area.x : move.clientY - rect.top - divider.area.y
      const ratio = Math.min(1 - lowest, Math.max(lowest, offset / total))
      latest = { kind: 'pane', split: divider.split, ratio: roundRatio(ratio) }
      controller.previewDivider(latest)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      void controller.endDividerDrag(latest, latest !== null && latest.ratio !== original)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const startPaneDrag = (paneId: string, event: ReactMouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const element = container.current
    if (!element) return
    const startX = event.clientX
    const startY = event.clientY
    let started = false
    let target: PaneDropTarget | null = null

    const resolve = (move: MouseEvent): PaneDropTarget | null => {
      const overTab = (move.target as Element | null)?.closest?.('[data-tab]')?.getAttribute('data-tab')
      if (overTab) return overTab === tab.id ? null : { kind: 'tab', tab: overTab }
      const rect = element.getBoundingClientRect()
      const x = move.clientX - rect.left
      const y = move.clientY - rect.top
      const hit = rects.find((candidate) => x >= candidate.x && x < candidate.x + candidate.width && y >= candidate.y && y < candidate.y + candidate.height)
      if (!hit || hit.pane === paneId) return null
      return { kind: 'edge', pane: hit.pane, edge: nearestEdge(hit, x, y) }
    }
    const onMove = (move: MouseEvent) => {
      if (!started) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < PANE_DRAG_THRESHOLD_PX) return
        started = true
      }
      target = resolve(move)
      controller.setPaneDrag({ pane: paneId, target })
    }
    const onUp = (up: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const dropped = started ? resolve(up) : null
      controller.setPaneDrag(null)
      if (dropped) void controller.movePane(paneId, dropped)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    controller.refocus()
  }, [controller, workspace?.revision])

  const drag = state.paneDrag
  const preview = drag?.target?.kind === 'edge' && rectOf.has(drag.target.pane) ? halfOf(rectOf.get(drag.target.pane)!, drag.target.edge) : null

  return (
    <div ref={container} className="qt-panes" data-panes={tab.id}>
      {shown.map((leaf) => {
        const rect = rectOf.get(leaf.id)!
        const left = px(rect.x)
        const top = px(rect.y)
        const session = sessions[leaf.session]
        const focused = focusedGroup && tab.activePane === leaf.id
        const structured = session?.kind === 'structured'
        return (
          <div
            key={leaf.id}
            className="qt-pane"
            data-pane={leaf.id}
            data-session={leaf.session}
            data-active={focused ? 'true' : 'false'}
            style={{ left, top, width: px(rect.x + rect.width) - left, height: px(rect.y + rect.height) - top }}
            onMouseDownCapture={structured ? () => void controller.focusPane(leaf.id) : undefined}
            onFocus={structured ? () => void controller.focusPane(leaf.id) : undefined}
            onContextMenu={(event) => {
              event.preventDefault()
              controller.openMenu('pane', leaf.id, { x: event.clientX, y: event.clientY })
            }}
          >
            {!session ? (
              <p className="qt-muted qt-pad">Loading session...</p>
            ) : session.kind === 'structured' ? (
              <StructuredHost controller={controller} session={leaf.session} />
            ) : (
              <TerminalPaneView
                key={state.epoch}
                ref={(handle) => controller.registerHandle(leaf.id, handle)}
                context={controller.context}
                sessionId={leaf.session}
                cwd={cwds[leaf.session] ?? session.cwd ?? ''}
                settings={settings}
                active={focused}
                interactive={leaf.exit === null && session.status !== 'exited'}
                dragging={state.dragging}
                onFocus={() => void controller.focusPane(leaf.id)}
                onState={(report) => controller.setPaneState(leaf.id, report)}
                themeSource={controller.options.themeSource ?? controller.root ?? undefined}
                createWebgl={controller.options.createWebgl}
              />
            )}
            {session ? <PaneAccessories controller={controller} sessionId={leaf.session} paneId={leaf.id} /> : null}
            {focused ? <PaneHeader controller={controller} state={state} tab={tab} leaf={leaf} multi={multi} onGrip={(event) => startPaneDrag(leaf.id, event)} /> : null}
            {leaf.exit ? <ExitOverlay controller={controller} leaf={leaf} /> : null}
          </div>
        )
      })}
      {dividers.map((divider) => (
        <div
          key={divider.split}
          className={`qt-divider qt-divider-${divider.direction}`}
          role="separator"
          aria-orientation={divider.direction === 'right' ? 'vertical' : 'horizontal'}
          aria-label="Resize panes"
          data-divider={divider.split}
          style={{ left: divider.x, top: divider.y, width: divider.width, height: divider.height }}
          onMouseDown={(event) => startDivider(divider, event)}
          onDoubleClick={() => void controller.resetDivider(divider.split)}
        />
      ))}
      {preview ? <div className="qt-drop-preview" data-drop-preview style={preview} /> : null}
    </div>
  )
}
