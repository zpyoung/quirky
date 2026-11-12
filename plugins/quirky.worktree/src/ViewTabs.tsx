import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ContextMenu, ControlIcon, IconButton, PopupMenu, type ContextMenuItem, type PopupItem } from '@quirky/ui'
import type { SavedView, ViewId } from './view-types'

type Props = {
  views: readonly SavedView[]
  needsYouHidden: boolean
  needsYouCount: number
  needsYouErrored: boolean
  activeId: ViewId
  /** Views whose on-screen spec differs from the saved one; their tab shows a dot. */
  changedIds: ReadonlySet<ViewId>
  onSelect(id: ViewId): void
  onHideNeedsYou(hidden: boolean): void
  onStar(id: string, starred: boolean): void
  onDelete(id: string): void
}

type Tab = { id: ViewId; label: string; count?: number }

/** The view strip: All, Needs you and starred views as tabs, with a chevron menu listing every view. */
export function ViewTabs({ views, needsYouHidden, needsYouCount, needsYouErrored, activeId, changedIds, onSelect, onHideNeedsYou, onStar, onDelete }: Props) {
  const chevron = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [context, setContext] = useState<{ x: number; y: number; id: ViewId; trigger: HTMLElement } | null>(null)

  const tabs = useMemo<Tab[]>(() => {
    const result: Tab[] = [{ id: 'all', label: 'All' }]
    if (!needsYouHidden) result.push({ id: 'needs-you', label: 'Needs you', count: needsYouCount })
    for (const view of views) if (view.starred || view.id === activeId) result.push({ id: view.id, label: view.name })
    return result
  }, [views, needsYouHidden, needsYouCount, activeId])

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (target === null) return
    event.preventDefault()
    const next = tabs[(target + tabs.length) % tabs.length]
    if (next) onSelect(next.id)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')
    buttons?.[(target + tabs.length) % tabs.length]?.focus()
  }

  const menuItems = (): PopupItem[] => [
    { label: 'All', checked: activeId === 'all', onSelect: () => onSelect('all') },
    ...(needsYouHidden ? [] : [{
      label: 'Needs you',
      checked: activeId === 'needs-you',
      badge: needsYouCount > 0 ? needsYouCount : undefined,
      onSelect: () => onSelect('needs-you')
    }]),
    ...views.map((view) => ({ label: view.name, checked: activeId === view.id, onSelect: () => onSelect(view.id) })),
    {
      label: needsYouHidden ? 'Show Needs you' : 'Hide Needs you',
      separatorBefore: true,
      onSelect: () => onHideNeedsYou(!needsYouHidden)
    }
  ]

  const contextItems = (id: ViewId): ContextMenuItem[] => {
    if (id === 'needs-you') return [{ label: 'Hide Needs you', onSelect: () => onHideNeedsYou(true) }]
    const view = views.find((candidate) => candidate.id === id)
    if (!view) return []
    return [
      { label: view.starred ? 'Remove from tabs' : 'Show as a tab', onSelect: () => onStar(view.id, !view.starred) },
      { label: 'Delete view', danger: true, separatorBefore: true, onSelect: () => onDelete(view.id) }
    ]
  }

  return (
    <div className="worktree-tree-view-tabs">
      <div className="worktree-tree-view-tabs__list" role="tablist" aria-label="Views">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const changed = changedIds.has(tab.id)
          const items = tab.id === 'all' ? [] : contextItems(tab.id)
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="worktree-tree-view-tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-view-id={tab.id}
              data-changed={changed ? '' : undefined}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => move(event, index)}
              onContextMenu={items.length === 0 ? undefined : (event) => {
                event.preventDefault()
                setContext({ x: event.clientX, y: event.clientY, id: tab.id, trigger: event.currentTarget })
              }}
            >
              <span className="worktree-tree-view-tab__label">{tab.label}</span>
              {tab.count !== undefined && tab.count > 0 ? (
                <span className="worktree-tree-view-tab__count" data-tone={needsYouErrored ? 'error' : 'waiting'} aria-label={`${tab.count} need you${needsYouErrored ? ', some errored' : ''}`}>
                  {tab.count}
                </span>
              ) : null}
              {changed ? <span className="worktree-tree-view-tab__dot" role="img" aria-label="Changed" /> : null}
            </button>
          )
        })}
      </div>
      <IconButton
        ref={chevron}
        className="worktree-tree-view-tabs__more"
        label="All views"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <ControlIcon name="caret-down" />
      </IconButton>
      {menuOpen && chevron.current ? <PopupMenu anchor={chevron.current} title="Views" items={menuItems()} onClose={() => setMenuOpen(false)} /> : null}
      {context ? (
        <ContextMenu
          items={contextItems(context.id)}
          label="View actions"
          x={context.x}
          y={context.y}
          returnFocusTo={context.trigger}
          onClose={() => setContext(null)}
        />
      ) : null}
    </div>
  )
}
