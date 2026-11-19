import { EmptyState, InlineError } from '@quirky/ui'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcErrorCode, type MountFunction, type QuirkyEvent, type Session, type UiPluginContext } from '@quirky/protocol'
// under `bun test`, Bun.build fails to resolve ./window/model when ./window/chat is imported before it
import {
  forgetShowAllEvents,
  rememberShowAllEvents,
  RUN_BADGE_COMMAND,
  SHOW_ALL_EVENTS_COMMAND,
  WORKTREE_VIEW_ID,
  WorktreeSessions
} from './window/model'
import { ChatView } from './window/chat/ChatView'
import { chatHandler } from './window/chat/controls'
import { newChatCommand, resetNewChatDialog } from './window/chat/newChat'
import { NewChatOverlay } from './window/chat/NewChatOverlay'
import { WorktreeView } from './window/WorktreeView'

const PLUGIN_ID = 'quirky.session'
const STRUCTURED_VIEW_ID = `view:${PLUGIN_ID}/structured`
const CHAT_OVERLAY_ID = `overlay:${PLUGIN_ID}/chat-dialogs`
const TAB_SHORTCUTS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
const ELEMENT_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/
const MAX_LABEL_CHARS = 120

/** The selected worktree, if any. */
function layoutWorktree(context: UiPluginContext): string | null {
  const worktree = context.getLayout().worktree
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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

type Loaded =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'failed'; failure: string }
  | { status: 'ready'; session: Session }

/** Reads one structured session, distinguishing absence from a failed read. */
async function readSession(context: UiPluginContext, id: string): Promise<Exclude<Loaded, { status: 'loading' }>> {
  try {
    const session = (await context.call('quirky.session/get', { session: id })) as Session
    return { status: 'ready', session }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === RpcErrorCode.NotFound) return { status: 'missing' }
    return { status: 'failed', failure: messageOf(error) }
  }
}

/** One structured session's chat, re-read whenever the session changes or goes away. */
function StructuredSession({ context, id }: { context: UiPluginContext; id: string | null }) {
  const [loaded, setLoaded] = useState<Loaded>(id === null ? { status: 'missing' } : { status: 'loading' })
  const latest = useRef(0)
  const cancelled = useRef(false)

  function load(): void {
    if (id === null) return
    setLoaded((current) => current.status === 'failed' ? { status: 'loading' } : current)
    const attempt = ++latest.current
    void readSession(context, id).then((result) => {
      if (cancelled.current || attempt !== latest.current) return
      setLoaded((current) => result.status === 'failed' && current.status === 'ready' ? current : result)
    })
  }

  useEffect(() => {
    if (id === null) return
    cancelled.current = false
    const unsubscribe = context.subscribe((event) => {
      if (touches(event, id)) load()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') load()
    })
    load()
    return () => {
      cancelled.current = true
      latest.current++
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, id])

  if (loaded.status === 'missing') return <EmptyState message="Session not found" />
  if (loaded.status === 'loading') return <EmptyState message="Loading session…" />
  if (loaded.status === 'failed') {
    return <InlineError message={`Could not load the session: ${loaded.failure}`} action={{ label: 'Retry', onAction: load }} />
  }
  return <ChatView context={context} session={loaded.session} />
}

/**
 * Activates the session plugin's window code: the worktree view with its tabs, terminal and
 * transcript, the structured session view other views can embed, and the commands that act on
 * the open view.
 */
export function activate(context: UiPluginContext): void {
  context.subscribe((event) => {
    if (event.type !== 'quirky.session/removed') return
    const data = event.data
    if (data === null || typeof data !== 'object' || !('sessionId' in data)) return
    const sessionId = data.sessionId
    if (typeof sessionId === 'string') forgetShowAllEvents(sessionId)
  })

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

  const mountChatDialogs: MountFunction = (element) => {
    const root = createRoot(element)
    root.render(<NewChatOverlay context={context} />)
    return () => {
      resetNewChatDialog()
      queueMicrotask(() => root.unmount())
    }
  }

  const selectTab = (index: number) => {
    const target = current?.tab(index)
    if (target) current?.open(target.id)
  }

  context.provide(WORKTREE_VIEW_ID, mountView)
  context.provide(STRUCTURED_VIEW_ID, mountStructured)
  context.provide(CHAT_OVERLAY_ID, mountChatDialogs)
  context.provide(`command:${PLUGIN_ID}/new-chat`, (args?: unknown) => newChatCommand(context, args))
  context.provide(`command:${PLUGIN_ID}/new-shell`, async () => {
    const store = current
    const worktree = store?.report().worktree ?? layoutWorktree(context)
    if (worktree === null) return undefined
    await context.call('quirky.worktree/wake', { worktree })
    if (store) return store.create('shell', '', false)
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
  context.provide(SHOW_ALL_EVENTS_COMMAND, async (args?: unknown) => {
    const { session: sessionId, enabled } = args as { session: string; enabled: boolean }
    const session = (await context.call('quirky.session/get', { session: sessionId })) as Session
    rememberShowAllEvents(session, enabled)
    return { session: sessionId, enabled }
  })
  context.provide(`command:${PLUGIN_ID}/chat-point`, async (args?: unknown) => {
    const { session, viewId, version, element, label } = (args ?? {}) as Record<string, unknown>
    if (typeof session !== 'string' || session === '') throw new Error('session must be a non-empty string')
    if (typeof viewId !== 'string' || viewId === '') throw new Error('viewId must be a non-empty string')
    if (!isVersion(version)) throw new Error('version must be a positive integer')
    if (typeof element !== 'string' || !ELEMENT_KEY.test(element)) throw new Error('element must be 1 to 80 lowercase letters, digits, dots, colons or dashes')
    if (typeof label !== 'string' || label.length > MAX_LABEL_CHARS) throw new Error(`label must be a string of at most ${MAX_LABEL_CHARS} characters`)
    const point = chatHandler(session, 'point')
    if (!point) throw new Error(`the chat of session ${session} is not open`)
    const record = (await context.call('quirky.view/get', { viewId, version }).catch(() => null)) as { title?: unknown } | null
    point({ viewId, version, element }, { title: typeof record?.title === 'string' ? record.title : 'Visual', label })
  })
  context.provide(`command:${PLUGIN_ID}/chat-expand-visual`, (args?: unknown) => {
    const { session, viewId, version } = (args ?? {}) as Record<string, unknown>
    if (typeof session !== 'string' || session === '') throw new Error('session must be a non-empty string')
    if (typeof viewId !== 'string' || viewId === '') throw new Error('viewId must be a non-empty string')
    if (version !== undefined && !isVersion(version)) throw new Error('version must be a positive integer')
    const expand = chatHandler(session, 'expand')
    if (!expand) throw new Error(`the chat of session ${session} is not open`)
    expand(viewId, version)
  })
  context.provide(RUN_BADGE_COMMAND, async (args?: unknown) => {
    const { session: sessionId, badge: badgeKey } = args as { session: string; badge: string }
    const session = (await context.call('quirky.session/get', { session: sessionId })) as Session
    const badge = session.badges?.[badgeKey]
    if (!badge?.command) throw new Error(`session ${sessionId} has no badge ${badgeKey} with a command`)
    await context.executeCommand(badge.command, badge.args)
  })
}
