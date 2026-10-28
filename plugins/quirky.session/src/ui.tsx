import { EmptyState } from '@quirky/ui'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcErrorCode, type MountFunction, type QuirkyEvent, type Session, type UiPluginContext } from '@quirky/protocol'
import { WORKTREE_VIEW_ID, WorktreeSessions } from './window/model'
import { StructuredView } from './window/StructuredView'
import { WorktreeView } from './window/WorktreeView'

const PLUGIN_ID = 'quirky.session'
const STRUCTURED_VIEW_ID = `view:${PLUGIN_ID}/structured`
const TAB_SHORTCUTS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

/** The worktree the layout's open session view names, if any. */
function layoutWorktree(context: UiPluginContext): string | null {
  const view = context.getLayout().view
  const worktree = view?.id === WORKTREE_VIEW_ID ? (view.input as { worktree?: unknown } | undefined)?.worktree : undefined
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

function parseInput(input: unknown): { worktree: string | null; session: string | undefined } {
  const { worktree, session } = (input ?? {}) as { worktree?: unknown; session?: unknown }
  return {
    worktree: typeof worktree === 'string' && worktree !== '' ? worktree : null,
    session: typeof session === 'string' && session !== '' ? session : undefined
  }
}

/** The session a structured view input names, or null. */
function structuredSessionId(input: unknown): string | null {
  const { session } = (input ?? {}) as { session?: unknown }
  return typeof session === 'string' && session !== '' ? session : null
}

/** Whether `event` says the session `id` changed or was closed. */
function touches(event: QuirkyEvent, id: string): boolean {
  const data = (event as { data?: unknown }).data as { session?: { id?: unknown }; sessionId?: unknown } | undefined
  if (event.type === 'quirky.session/changed') return data?.session?.id === id
  return event.type === 'quirky.session/removed' && data?.sessionId === id
}

type Loaded = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; session: Session }

/** One structured session's transcript and input, re-read whenever the session changes or goes away. */
function StructuredSession({ context, id }: { context: UiPluginContext; id: string | null }) {
  const [loaded, setLoaded] = useState<Loaded>(id === null ? { status: 'missing' } : { status: 'loading' })

  useEffect(() => {
    if (id === null) return
    let cancelled = false
    let latest = 0
    const load = () => {
      const attempt = ++latest
      context
        .call('quirky.session/get', { session: id })
        .then((session) => {
          if (!cancelled && attempt === latest) setLoaded({ status: 'ready', session: session as Session })
        })
        .catch((error: { code?: unknown }) => {
          if (!cancelled && attempt === latest && error?.code === RpcErrorCode.NotFound) setLoaded({ status: 'missing' })
        })
    }
    const unsubscribe = context.subscribe((event) => {
      if (touches(event, id)) load()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') load()
    })
    load()
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, id])

  if (loaded.status === 'missing') return <EmptyState message="Session not found" />
  if (loaded.status === 'loading') return null
  return <StructuredView context={context} session={loaded.session} />
}

/**
 * Activates the session plugin's window code: the worktree view with its tabs, terminal and
 * transcript, the structured session view other views can embed, and the commands that act on
 * the open view.
 */
export function activate(context: UiPluginContext): void {
  let current: WorktreeSessions | null = null

  const mountView: MountFunction = (element, { input, report }) => {
    const { worktree, session } = parseInput(input)
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const root = createRoot(element)
    if (worktree === null) {
      root.render(<EmptyState message="Pick a worktree to see its sessions." />)
      report?.({ worktree: null, tabs: [], active: null, visibleSessions: [] })
      return () => root.unmount()
    }
    const store = new WorktreeSessions(context, worktree, session)
    current = store
    const unsubscribe = store.subscribe(() => {
      if (store.getSnapshot().status !== 'loading') report?.(store.report())
    })
    store.start()
    root.render(<WorktreeView context={context} store={store} themeSource={element} />)
    return () => {
      if (current === store) current = null
      unsubscribe()
      store.stop()
      root.unmount()
    }
  }

  const mountStructured: MountFunction = (element, { input }) => {
    Object.assign(element.style, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' })
    const root = createRoot(element)
    root.render(<StructuredSession context={context} id={structuredSessionId(input)} />)
    return () => queueMicrotask(() => root.unmount())
  }

  const selectTab = (index: number) => {
    const target = current?.tab(index)
    if (target) current?.open(target.id)
  }

  context.provide(WORKTREE_VIEW_ID, mountView)
  context.provide(STRUCTURED_VIEW_ID, mountStructured)
  context.provide(`command:${PLUGIN_ID}/new-shell`, () => {
    if (current) return current.create('shell', '', false)
    const worktree = layoutWorktree(context)
    if (worktree === null) return undefined
    return new WorktreeSessions(context, worktree).create('shell', '', false)
  })
  context.provide(`command:${PLUGIN_ID}/close-session`, () => {
    const active = current?.getSnapshot().active
    if (current && active) return current.close(active)
    return undefined
  })
  context.provide(`command:${PLUGIN_ID}/select-tab`, (args?: unknown) => {
    selectTab(Number((args as { index?: unknown } | undefined)?.index))
  })
  for (const index of TAB_SHORTCUTS) context.provide(`command:${PLUGIN_ID}/select-tab-${index}`, () => selectTab(index))
}
