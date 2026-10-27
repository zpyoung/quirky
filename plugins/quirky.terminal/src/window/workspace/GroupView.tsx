import { useRef, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { displayTitle } from '../../layout/titles'
import { dropZone, paneLeaves, roundRatio } from '../../layout/tree'
import type { DropZone } from '../../layout/tree'
import { GROUP_RATIO_MAX, GROUP_RATIO_MIN, TAB_COLOR_HEX } from '../../layout/types'
import type { Group, GroupNode, Tab } from '../../layout/types'
import { CollapseIcon, CloseIcon, PinIcon } from './icons'
import { hasCommandDrop, type ControllerState, type WorkspaceController } from './controller'
import { activeTabOf, byPaneId, groupRects, px } from './model'
import type { GroupDividerRect } from './model'
import { InlineField, PaneLayer } from './PaneLayer'
import { StatusGlyph, UnreadBell, useNow } from './StatusGlyph'
import { useBoxSize } from './useBoxSize'

type Common = { controller: WorkspaceController; state: ControllerState }

function TabItem({ controller, state, group, tab, index, others, now }: Common & { group: Group; tab: Tab; index: number; others: Tab[]; now: number }) {
  const ws = state.workspace!
  const selected = group.activeTab === tab.id
  const leaves = paneLeaves(tab.root)
  const lead = leaves.find((leaf) => leaf.id === tab.activePane) ?? leaves[0]
  const session = lead ? state.sessions[lead.session] : undefined
  const unread = leaves.map((leaf) => state.sessions[leaf.session]?.unread).find((reason) => reason)
  const title = displayTitle(tab)
  const renaming = state.rename?.kind === 'tab' && state.rename.id === tab.id
  const drag = state.tabDrag
  const mark = drag?.over?.kind === 'strip' && drag.over.group === group.id && others[drag.over.index]?.id === tab.id
  const paneTarget = state.paneDrag?.target?.kind === 'tab' && state.paneDrag.target.tab === tab.id

  const indexFor = (event: DragEvent): number => {
    const at = others.findIndex((candidate) => candidate.id === tab.id)
    if (at < 0) return others.length
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX > rect.left + rect.width / 2 ? at + 1 : at
  }

  return (
    <div
      role="tab"
      aria-selected={selected}
      className={`qt-tab${selected ? ' qt-selected' : ''}${selected && ws.activeGroup === group.id ? ' qt-focused' : ''}${mark ? ' qt-drop-before' : ''}${paneTarget ? ' qt-drop-target' : ''}`}
      data-tab={tab.id}
      data-pinned={tab.pinned ? 'true' : undefined}
      title={`${title}${index < 9 ? ` (⌘${index + 1})` : ''}`}
      draggable={!renaming}
      onClick={() => void controller.activateTab(tab.id)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        void controller.closeTab(tab.id)
      }}
      onDoubleClick={() => controller.renameTab(tab.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        controller.openMenu('tab', tab.id, { x: event.clientX, y: event.clientY })
      }}
      onDragStart={(event) => {
        event.dataTransfer?.setData('text/plain', tab.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
        controller.beginTabDrag(tab.id)
      }}
      onDragEnd={() => controller.endTabDrag()}
      onDragOver={(event) => {
        if (!drag) return
        event.preventDefault()
        event.stopPropagation()
        controller.overTabDrag({ kind: 'strip', group: group.id, index: indexFor(event) })
      }}
      onDrop={(event) => {
        if (!drag) return
        event.preventDefault()
        event.stopPropagation()
        void controller.dropTab({ kind: 'strip', group: group.id, index: indexFor(event) })
      }}
    >
      {unread ? <UnreadBell reason={unread} /> : <StatusGlyph session={session} now={now} />}
      {renaming ? (
        <InlineField label="Tab title" initial={displayTitle(tab)} className="qt-rename" onCommit={(value) => void controller.commitRename(value)} onCancel={() => controller.cancelRename()} />
      ) : (
        <span className="qt-tab-title">{title}</span>
      )}
      {Object.entries(session?.badges ?? {}).map(([key, badge]) =>
        badge.command ? (
          <button
            key={key}
            type="button"
            className="qt-badge"
            title={badge.tooltip}
            onClick={(event) => {
              event.stopPropagation()
              void controller.context.executeCommand(badge.command!, badge.args)
            }}
          >
            {badge.label}
          </button>
        ) : (
          <span key={key} className="qt-badge" title={badge.tooltip}>
            {badge.label}
          </span>
        )
      )}
      {tab.expandedPane !== null ? (
        <button
          type="button"
          className="qt-icon qt-collapse"
          aria-label="Collapse expanded pane"
          title="Collapse expanded pane"
          onClick={(event) => {
            event.stopPropagation()
            void controller.toggleExpand(tab.expandedPane!)
          }}
        >
          <CollapseIcon />
        </button>
      ) : null}
      {tab.color !== 'none' ? <span className="qt-color" data-color={tab.color} style={{ background: TAB_COLOR_HEX[tab.color] }} title={tab.color} /> : null}
      {tab.pinned ? (
        <span className="qt-pin" role="img" aria-label="Pinned">
          <PinIcon />
        </span>
      ) : (
        <button
          type="button"
          className="qt-icon qt-tab-close"
          aria-label={`Close ${title}`}
          title="Close"
          onClick={(event) => {
            event.stopPropagation()
            void controller.closeTab(tab.id)
          }}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  )
}

function EmptyGroup({ controller, group }: { controller: WorkspaceController; group: Group }) {
  const minimize = () => void controller.context.call('quirky.terminal/setFloating', { open: false }).catch(() => {})
  if (controller.floating) {
    return (
      <div className="qt-empty">
        <button type="button" onClick={() => void controller.newTab({ group: group.id })}>
          <span>New Terminal</span>
          <span className="qt-menu-key">⌘T</span>
        </button>
        <button type="button" onClick={minimize}>
          <span>Minimize</span>
          <span className="qt-menu-key">⌘W</span>
        </button>
      </div>
    )
  }
  return (
    <div className="qt-empty">
      <p className="qt-muted">No terminals open.</p>
      <button type="button" className="qt-primary" onClick={() => void controller.newTab({ group: group.id })}>
        New Terminal
      </button>
    </div>
  )
}

function zoneStyle(zone: DropZone): Record<string, string> {
  if (zone === 'left') return { left: '0', top: '0', width: '50%', height: '100%' }
  if (zone === 'right') return { left: '50%', top: '0', width: '50%', height: '100%' }
  if (zone === 'up') return { left: '0', top: '0', width: '100%', height: '50%' }
  if (zone === 'down') return { left: '0', top: '50%', width: '100%', height: '50%' }
  return { left: '0', top: '0', width: '100%', height: '100%' }
}

function GroupView({ controller, state, group }: Common & { group: Group }) {
  const ws = state.workspace!
  const body = useRef<HTMLDivElement>(null)
  const tab = activeTabOf(group)
  const drag = state.tabDrag
  const menu = state.menu
  const dragged = drag?.tab
  const others = group.tabs.filter((candidate) => candidate.id !== dragged)
  const zone = drag?.over?.kind === 'zone' && drag.over.group === group.id ? drag.over.zone : null
  const stripEnd = drag?.over?.kind === 'strip' && drag.over.group === group.id && drag.over.index >= others.length
  const split = ws.root.kind === 'split'
  const now = useNow()

  const zoneAt = (event: DragEvent): DropZone => {
    const rect = body.current!.getBoundingClientRect()
    return dropZone(rect, { x: event.clientX, y: event.clientY }, split)
  }

  const toggle = (kind: string, event: ReactMouseEvent) => {
    event.stopPropagation()
    if (menu?.kind === kind && menu.target === group.id) controller.closeMenu()
    else controller.openMenu(kind, group.id)
  }

  return (
    <div className={`qt-group${ws.activeGroup === group.id ? ' qt-active' : ''}`} data-group={group.id}>
      <div
        className={`qt-strip${stripEnd ? ' qt-drop-end' : ''}`}
        onDragOver={(event) => {
          if (!drag) {
            const transfer = event.dataTransfer
            if (hasCommandDrop(transfer)) {
              event.preventDefault()
              transfer.dropEffect = 'copy'
            }
            return
          }
          event.preventDefault()
          controller.overTabDrag({ kind: 'strip', group: group.id, index: others.length })
        }}
        onDrop={(event) => {
          if (!drag) {
            const transfer = event.dataTransfer
            if (!hasCommandDrop(transfer)) return
            event.preventDefault()
            event.stopPropagation()
            void controller.dropCommand(transfer, group.id)
            return
          }
          event.preventDefault()
          void controller.dropTab({ kind: 'strip', group: group.id, index: others.length })
        }}
      >
        <div className="qt-tabs" role="tablist">
          {group.tabs.map((entry, index) => (
            <TabItem key={entry.id} controller={controller} state={state} group={group} tab={entry} index={index} others={others} now={now} />
          ))}
        </div>
        <button type="button" className="qt-icon qt-plus" data-plus={group.id} aria-label="New tab" title="New tab" aria-haspopup="menu" aria-expanded={menu?.kind === 'plus' && menu.target === group.id} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => toggle('plus', event)}>
          +
        </button>
        {controller.options.stripExtras?.(group)}
        <button type="button" className="qt-icon qt-actions" data-actions={group.id} aria-label="Pane actions" title="Pane actions" aria-haspopup="menu" aria-expanded={menu?.kind === 'actions' && menu.target === group.id} disabled={!split} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => toggle('actions', event)}>
          …
        </button>
      </div>
      <div
        ref={body}
        className="qt-body"
        data-group-body={group.id}
        onDragOver={(event) => {
          if (!drag) {
            const transfer = event.dataTransfer
            if (hasCommandDrop(transfer)) {
              event.preventDefault()
              transfer.dropEffect = 'copy'
            }
            return
          }
          event.preventDefault()
          controller.overTabDrag({ kind: 'zone', group: group.id, zone: zoneAt(event) })
        }}
        onDrop={(event) => {
          if (!drag) {
            const transfer = event.dataTransfer
            if (!hasCommandDrop(transfer)) return
            event.preventDefault()
            event.stopPropagation()
            void controller.dropCommand(transfer, group.id)
            return
          }
          event.preventDefault()
          void controller.dropTab({ kind: 'zone', group: group.id, zone: zoneAt(event) })
        }}
      >
        {tab ? <PaneLayer key={tab.id} controller={controller} state={state} group={group} tab={tab} /> : <EmptyGroup controller={controller} group={group} />}
        {zone ? <div className="qt-zone" data-zone={zone} style={zoneStyle(zone)} /> : null}
      </div>
    </div>
  )
}

/**
 * The workspace's groups. Every group is a direct child of one flat container, keyed by its ID and
 * absolutely positioned from rectangles computed off the group tree, so a split or a close changes
 * rectangles and never re-parents the terminals of a group that stays.
 */
export function GroupTree({ controller, state, node }: Common & { node: GroupNode }) {
  const container = useRef<HTMLDivElement>(null)
  const size = useBoxSize(container)
  const thickness = state.settings['divider-thickness']
  const laidOut = size.width > 0 && size.height > 0
  const { groups, dividers } = laidOut ? groupRects(node, size.width, size.height, thickness) : { groups: [], dividers: [] }

  const startDivider = (divider: GroupDividerRect, event: ReactMouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const element = container.current
    if (!element) return
    const split = divider.split
    const horizontal = split.direction === 'right'
    let latest: { kind: 'group'; split: string; ratio: number } | null = null
    const onMove = (move: MouseEvent) => {
      const rect = element.getBoundingClientRect()
      const raw = horizontal ? (move.clientX - rect.left - divider.area.x) / divider.area.width : (move.clientY - rect.top - divider.area.y) / divider.area.height
      const ratio = Math.min(GROUP_RATIO_MAX, Math.max(GROUP_RATIO_MIN, raw))
      latest = { kind: 'group', split: split.id, ratio: roundRatio(ratio) }
      controller.previewDivider(latest)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      void controller.endDividerDrag(latest, latest !== null && latest.ratio !== split.ratio)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div ref={container} className="qt-groups">
      {byPaneId(groups.map((rect) => ({ id: rect.group.id, rect }))).map(({ rect }) => {
        const left = px(rect.x)
        const top = px(rect.y)
        return (
          <div key={rect.group.id} className="qt-group-slot" style={{ left, top, width: px(rect.x + rect.width) - left, height: px(rect.y + rect.height) - top }}>
            <GroupView controller={controller} state={state} group={rect.group} />
          </div>
        )
      })}
      {dividers.map((divider) => (
        <div
          key={divider.split.id}
          className={`qt-group-divider qt-group-divider-${divider.split.direction}`}
          role="separator"
          aria-orientation={divider.split.direction === 'right' ? 'vertical' : 'horizontal'}
          aria-label="Resize groups"
          data-group-divider={divider.split.id}
          style={{ left: px(divider.x), top: px(divider.y), width: divider.split.direction === 'right' ? thickness : divider.width, height: divider.split.direction === 'right' ? divider.height : thickness }}
          onMouseDown={(event) => startDivider(divider, event)}
          onDoubleClick={() => void controller.resetDivider(divider.split.id)}
        />
      ))}
    </div>
  )
}
