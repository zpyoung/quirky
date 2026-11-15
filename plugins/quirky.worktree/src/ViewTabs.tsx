import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { ContextMenu, ControlIcon, IconButton, PopupMenu, type ContextMenuItem, type PopupItem } from '@quirky/ui'
import { registerUiControlScope, requestUiControl, type ScopedUiControlArgs, type UiControlResult } from './ui-control'
import type { SavedView, ViewId } from './view-types'

const SCOPE = 'view-tabs'
const TARGET = 'views'

type Props = {
  context: UiPluginContext
  views: readonly SavedView[]
  needsYouHidden: boolean
  needsYouCount: number
  needsYouErrored: boolean
  activeId: ViewId
  /** Views whose on-screen spec differs from the saved one; their tab shows a dot. */
  changedIds: ReadonlySet<ViewId>
  writeBusy?: boolean
  onSelect(id: ViewId): void
  onHideNeedsYou(hidden: boolean): void
  onStar(id: string, starred: boolean): void
  onDelete(id: string): void
}

type Tab = { id: ViewId; label: string; count?: number }
type ViewMenu = { session: number; x: number; y: number; id: ViewId; trigger: HTMLButtonElement }
type ControllerState = {
  context: UiPluginContext
  owner: string
  views: readonly SavedView[]
  needsYouHidden: boolean
  needsYouCount: number
  needsYouErrored: boolean
  activeId: ViewId
  writeBusy: boolean
  listSession: number | null
  viewMenu: ViewMenu | null
  tabRevision: number
}
type Registration = { context: UiPluginContext; owner: string; active: boolean }
type TabData = { views: readonly SavedView[]; needsYouHidden: boolean; needsYouCount: number; activeId: ViewId; writeBusy: boolean }

function invalidControl(): never {
  throw new Error('Invalid view-tabs control.')
}


function onlyKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(payload).some((key) => !allowed.includes(key))) invalidControl()
}

function nonBlankString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.trim() === '') return invalidControl()
  return value
}

function optionalSafeInteger(payload: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(payload, key)) return undefined
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalidControl()
  return value
}

function actionableTab(id: ViewId, views: readonly SavedView[], needsYouHidden: boolean, activeId: ViewId): boolean {
  if (id === 'all') return false
  if (id === 'needs-you') return !needsYouHidden
  const view = views.find((candidate) => candidate.id === id)
  return view !== undefined && (view.starred || view.id === activeId)
}

function deliveredCount(result: UiControlResult): number {
  if (!Number.isSafeInteger(result.delivered) || result.delivered < 0) {
    throw new Error('The window returned no UI control result.')
  }
  return result.delivered
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The view strip owns only its list and per-view context-menu sessions. */
export function ViewTabs({
  context, views, needsYouHidden, needsYouCount, needsYouErrored, activeId, changedIds, writeBusy = false,
  onSelect, onHideNeedsYou, onStar, onDelete
}: Props) {
  const chevron = useRef<HTMLButtonElement>(null)
  const tabList = useRef<HTMLDivElement>(null)
  const owner = useMemo(() => crypto.randomUUID(), [context])
  const [listSession, setListSession] = useState<number | null>(null)
  const [viewMenu, setViewMenu] = useState<ViewMenu | null>(null)
  const [listRenderVersion, setListRenderVersion] = useState(0)
  const [viewMenuRenderVersion, setViewMenuRenderVersion] = useState(0)
  const sessions = useRef(0)
  const revision = useRef(0)
  const previousTabData = useRef<TabData | null>(null)
  const current = useRef<ControllerState | null>(null)
  const handler = useRef<(args: ScopedUiControlArgs) => boolean>(() => false)
  const registration = useRef<Registration | null>(null)
  const previousContext = useRef(context)

  const tabs = useMemo<Tab[]>(() => {
    const result: Tab[] = [{ id: 'all', label: 'All' }]
    if (!needsYouHidden) result.push({ id: 'needs-you', label: 'Needs you', count: needsYouCount })
    for (const view of views) if (view.starred || view.id === activeId) result.push({ id: view.id, label: view.name })
    return result
  }, [views, needsYouHidden, needsYouCount, activeId])

  const nextSession = () => {
    sessions.current += 1
    return sessions.current
  }

  const setList = (session: number | null) => {
    const state = current.current
    if (state) current.current = { ...state, listSession: session }
    setListSession(session)
  }

  const setCurrentViewMenu = (menu: ViewMenu | null) => {
    const state = current.current
    if (state) current.current = { ...state, viewMenu: menu }
    setViewMenu(menu)
  }

  const tabButton = (id: ViewId): HTMLButtonElement | null => {
    const list = tabList.current
    if (!list) return null
    return [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.dataset.viewId === id) ?? null
  }

  const preserveRetryableClose = (operation: string, session: unknown) => {
    if (typeof session !== 'number') return
    if (operation === 'close-list' && current.current?.listSession === session) {
      setListRenderVersion((version) => version + 1)
    }
    if (operation === 'close-view-menu' && current.current?.viewMenu?.session === session) {
      setViewMenuRenderVersion((version) => version + 1)
    }
  }

  const send = (operation: string, payload: Record<string, unknown>) => {
    const requestContext = context
    const requestOwner = owner
    const args = {
      action: 'control' as const,
      scope: SCOPE,
      target: TARGET,
      operation,
      payload: { ...payload, owner: requestOwner }
    }
    const isCurrentRegistration = () => {
      const active = registration.current
      return active?.active === true && active.context === requestContext && active.owner === requestOwner
    }

    void requestUiControl(requestContext, args).then((result) => {
      if (!isCurrentRegistration()) return
      const delivered = deliveredCount(result)
      if (delivered === 0) {
        requestContext.log(`worktree: ${operation} reached no mounted target`)
        preserveRetryableClose(operation, payload.session)
      }
    }).catch((error: unknown) => {
      if (!isCurrentRegistration()) return
      requestContext.toast('Could not update view controls', messageOf(error))
      preserveRetryableClose(operation, payload.session)
    })
  }

  const handleControl = (args: ScopedUiControlArgs): boolean => {
    if (args.target !== TARGET) return false
    if (args.action !== 'control' || args.scope !== SCOPE) return invalidControl()
    const payload = args.payload
    const state = current.current
    if (!state) return false
    if (Object.hasOwn(payload, 'owner') && nonBlankString(payload, 'owner') !== state.owner) return false

    switch (args.operation) {
      case 'open-list': {
        onlyKeys(payload, ['owner'])
        if (state.listSession !== null || !chevron.current?.isConnected) return false
        setList(nextSession())
        return true
      }
      case 'close-list': {
        onlyKeys(payload, ['owner', 'session'])
        const session = optionalSafeInteger(payload, 'session')
        if (state.listSession === null || (session !== undefined && session !== state.listSession)) return false
        setList(null)
        return true
      }
      case 'open-view-menu': {
        onlyKeys(payload, ['owner', 'id', 'x', 'y', 'revision'])
        const id = nonBlankString(payload, 'id')
        const dataRevision = optionalSafeInteger(payload, 'revision')
        const hasX = Object.hasOwn(payload, 'x')
        const hasY = Object.hasOwn(payload, 'y')
        if (hasX !== hasY) return invalidControl()
        let x: number | undefined
        let y: number | undefined
        if (hasX && hasY) {
          if (typeof payload.x !== 'number' || !Number.isFinite(payload.x) || typeof payload.y !== 'number' || !Number.isFinite(payload.y)) {
            return invalidControl()
          }
          x = payload.x
          y = payload.y
        }
        if (dataRevision !== undefined && dataRevision !== state.tabRevision) return false
        if (state.viewMenu !== null || !actionableTab(id, state.views, state.needsYouHidden, state.activeId)) return false
        const trigger = tabButton(id)
        if (!trigger?.isConnected) return false
        const bounds = trigger.getBoundingClientRect()
        const menuX = x ?? bounds.left
        const menuY = y ?? bounds.bottom
        if (!Number.isFinite(menuX) || !Number.isFinite(menuY)) return false
        setCurrentViewMenu({ session: nextSession(), x: menuX, y: menuY, id, trigger })
        return true
      }
      case 'close-view-menu': {
        onlyKeys(payload, ['owner', 'session'])
        const session = optionalSafeInteger(payload, 'session')
        if (state.viewMenu === null || (session !== undefined && session !== state.viewMenu.session)) return false
        setCurrentViewMenu(null)
        return true
      }
      default:
        return invalidControl()
    }
  }

  useLayoutEffect(() => {
    const previous = previousTabData.current
    if (previous === null) {
      revision.current = 1
    } else if (
      previous.views !== views ||
      previous.needsYouHidden !== needsYouHidden ||
      previous.needsYouCount !== needsYouCount ||
      previous.activeId !== activeId ||
      previous.writeBusy !== writeBusy
    ) {
      revision.current += 1
    }
    previousTabData.current = { views, needsYouHidden, needsYouCount, activeId, writeBusy }

    let currentViewMenu = viewMenu
    if (currentViewMenu && !actionableTab(currentViewMenu.id, views, needsYouHidden, activeId)) {
      currentViewMenu = null
      setViewMenu(null)
    }
    current.current = {
      context, owner, views, needsYouHidden, needsYouCount, needsYouErrored, activeId, writeBusy,
      listSession, viewMenu: currentViewMenu, tabRevision: revision.current
    }
    handler.current = handleControl
  })

  useLayoutEffect(() => {
    if (previousContext.current === context) return
    previousContext.current = context
    const state = current.current
    if (state) current.current = { ...state, listSession: null, viewMenu: null }
    setListSession(null)
    setViewMenu(null)
  }, [context])

  useLayoutEffect(() => {
    const mounted: Registration = { context, owner, active: true }
    registration.current = mounted
    const unregister = registerUiControlScope(context, SCOPE, (args) => mounted.active && handler.current(args))
    return () => {
      mounted.active = false
      if (registration.current === mounted) registration.current = null
      unregister()
    }
  }, [context, owner])

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (target === null) return
    event.preventDefault()
    const nextIndex = (target + tabs.length) % tabs.length
    const next = tabs[nextIndex]
    if (next) {
      onSelect(next.id)
      const button = tabButton(next.id)
      if (button?.isConnected && tabButton(next.id) === button) button.focus()
    }
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
      enabled: !writeBusy,
      onSelect: () => onHideNeedsYou(!needsYouHidden)
    }
  ]

  const contextItems = (id: ViewId): ContextMenuItem[] => {
    if (id === 'needs-you') return [{ label: 'Hide Needs you', enabled: !writeBusy, onSelect: () => onHideNeedsYou(true) }]
    const view = views.find((candidate) => candidate.id === id)
    if (!view) return []
    return [
      { label: view.starred ? 'Remove from tabs' : 'Show as a tab', enabled: !writeBusy, onSelect: () => onStar(view.id, !view.starred) },
      { label: 'Delete view', danger: true, separatorBefore: true, enabled: !writeBusy, onSelect: () => onDelete(view.id) }
    ]
  }

  return (
    <div className="worktree-tree-view-tabs">
      <div ref={tabList} className="worktree-tree-view-tabs__list" role="tablist" aria-label="Views">
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
                send('open-view-menu', {
                  id: tab.id,
                  x: event.clientX,
                  y: event.clientY,
                  revision: current.current?.tabRevision ?? revision.current
                })
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
        aria-expanded={listSession !== null}
        onClick={() => {
          if (listSession === null) send('open-list', {})
          else send('close-list', { session: listSession })
        }}
      >
        <ControlIcon name="caret-down" />
      </IconButton>
      {listSession !== null && chevron.current ? (
        <PopupMenu
          key={`${listSession}:${listRenderVersion}`}
          anchor={chevron.current}
          title="Views"
          items={menuItems()}
          onClose={() => send('close-list', { session: listSession })}
        />
      ) : null}
      {viewMenu ? (
        <ContextMenu
          key={`${viewMenu.session}:${viewMenuRenderVersion}`}
          items={contextItems(viewMenu.id)}
          label="View actions"
          x={viewMenu.x}
          y={viewMenu.y}
          returnFocusTo={tabButton(viewMenu.id) === viewMenu.trigger && viewMenu.trigger.isConnected ? viewMenu.trigger : undefined}
          onClose={() => send('close-view-menu', { session: viewMenu.session })}
        />
      ) : null}
    </div>
  )
}
