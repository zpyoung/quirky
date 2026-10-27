import { useRef, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { displayTitle } from '../../layout/titles'
import { dropZone, paneLeaves, roundRatio } from '../../layout/tree'
import type { DropZone } from '../../layout/tree'
import { GROUP_RATIO_MAX, GROUP_RATIO_MIN, TAB_COLOR_HEX } from '../../layout/types'
import type { Group, GroupNode, GroupSplit, Tab } from '../../layout/types'
import { CollapseIcon, CloseIcon, PinIcon } from './icons'
import type { ControllerState, WorkspaceController } from './controller'
import { activeTabOf, displayStatus } from './model'
import { InlineField, PaneLayer } from './PaneLayer'

type Common = { controller: WorkspaceController; state: ControllerState }

function TabItem({ controller, state, group, tab, index, others }: Common & { group: Group; tab: Tab; index: number; others: Tab[] }) {
  const ws = state.workspace!
  const selected = group.activeTab === tab.id
  const leaves = paneLeaves(tab.root)
  const lead = leaves.find((leaf) => leaf.id === tab.activePane) ?? leaves[0]
  const session = lead ? state.sessions[lead.session] : undefined
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
      <span className={`qt-dot qt-dot-${session ? displayStatus(session.status) : 'running'}`} role="img" aria-label={session ? displayStatus(session.status) : 'running'} />
      {renaming ? (
        <InlineField label="Tab title" initial={displayTitle(tab)} className="qt-rename" onCommit={(value) => void controller.commitRename(value)} onCancel={() => controller.cancelRename()} />
      ) : (
        <span className="qt-tab-title">{title}</span>
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
          if (!drag) return
          event.preventDefault()
          controller.overTabDrag({ kind: 'strip', group: group.id, index: others.length })
        }}
        onDrop={(event) => {
          if (!drag) return
          event.preventDefault()
          void controller.dropTab({ kind: 'strip', group: group.id, index: others.length })
        }}
      >
        <div className="qt-tabs" role="tablist">
          {group.tabs.map((entry, index) => (
            <TabItem key={entry.id} controller={controller} state={state} group={group} tab={entry} index={index} others={others} />
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
          if (!drag) return
          event.preventDefault()
          controller.overTabDrag({ kind: 'zone', group: group.id, zone: zoneAt(event) })
        }}
        onDrop={(event) => {
          if (!drag) return
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

function SplitView({ controller, state, node }: Common & { node: GroupSplit }) {
  const element = useRef<HTMLDivElement>(null)
  const horizontal = node.direction === 'right'
  const thickness = state.settings['divider-thickness']

  const start = (event: ReactMouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const container = element.current
    if (!container) return
    let latest: { kind: 'group'; split: string; ratio: number } | null = null
    const onMove = (move: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const raw = horizontal ? (move.clientX - rect.left) / rect.width : (move.clientY - rect.top) / rect.height
      const ratio = Math.min(GROUP_RATIO_MAX, Math.max(GROUP_RATIO_MIN, raw))
      latest = { kind: 'group', split: node.id, ratio: roundRatio(ratio) }
      controller.previewDivider(latest)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      void controller.endDividerDrag(latest, latest !== null && latest.ratio !== node.ratio)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div ref={element} className={`qt-split qt-split-${node.direction}`} data-split={node.id}>
      <div className="qt-split-side" style={{ flex: `${node.ratio} 1 0%` }}>
        <GroupTree controller={controller} state={state} node={node.first} />
      </div>
      <div
        className={`qt-group-divider qt-group-divider-${node.direction}`}
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        data-group-divider={node.id}
        style={horizontal ? { width: thickness } : { height: thickness }}
        onMouseDown={start}
        onDoubleClick={() => void controller.resetDivider(node.id)}
      />
      <div className="qt-split-side" style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <GroupTree controller={controller} state={state} node={node.second} />
      </div>
    </div>
  )
}

/** The workspace's groups: splits with draggable dividers, and a tab strip over a pane layer in each group. */
export function GroupTree({ controller, state, node }: Common & { node: GroupNode }) {
  return node.kind === 'group' ? <GroupView controller={controller} state={state} group={node} /> : <SplitView controller={controller} state={state} node={node} />
}
