import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { RpcErrorCode, type AgentCapabilities, type Session, type StructuredMessage, type UiPluginContext } from '@quirky/protocol'
import { EmptyState, InlineError, NoticeLine, SectionHeader } from '@quirky/ui'
import { rememberShowAllEvents, SHOW_ALL_EVENTS_COMMAND, showAllEventsFor, subscribeShowAllEvents } from '../model'
import { mergeMessages } from '../transcript'
import { Composer } from './Composer'
import { Embedded } from './Embedded'
import { groupTurns } from './turns'
import { TurnView, VIEW_PANE_VIEW } from './Turn'

const NO_MESSAGES: StructuredMessage[] = []
type MessagePhase = { status: 'loading' } | { status: 'ready' } | { status: 'off' } | { status: 'failed'; message: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** How far from the end the transcript may be scrolled and still follow new content. */
const BOTTOM_SLACK = 24

const layout = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  minHeight: 0,
  minWidth: 0,
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)'
} satisfies CSSProperties
const body = { display: 'flex', flex: 1, minHeight: 0, minWidth: 0 } satisfies CSSProperties
const scroller = { flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', padding: 'var(--ui-space-16) 0 var(--ui-space-24)' } satisfies CSSProperties
const column = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  maxWidth: 'calc(720 * var(--ui-length-unit))',
  minWidth: 0,
  margin: '0 auto',
  padding: '0 var(--ui-space-16)'
} satisfies CSSProperties
const pane = {
  display: 'flex',
  flex: '0 0 calc(320 * var(--ui-length-unit))',
  flexDirection: 'column',
  minHeight: 0,
  minWidth: 0,
  borderInlineStart: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const headerInset = { paddingInline: 'var(--ui-space-8)' } satisfies CSSProperties

/** Whether `element` is scrolled to its end, give or take a few lines. */
export function atBottom(element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK
}

/** The number of this session's views the agent placed in the pane, read again whenever views change. */
function usePaneViews(context: UiPluginContext, sessionId: string): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    let latest = 0
    const load = () => {
      const attempt = ++latest
      context
        .call('quirky.view/list', { session: sessionId })
        .then((records) => {
          if (cancelled || attempt !== latest) return
          const views = Array.isArray(records) ? (records as { placement?: string; closed?: boolean }[]) : []
          setCount(views.filter((view) => view.placement === 'pane' && view.closed !== true).length)
        })
        .catch(() => {
          if (!cancelled && attempt === latest) setCount(0)
        })
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.view/changed') return
      const changed = (event.data as { sessionId?: string } | undefined)?.sessionId
      if (changed === undefined || changed === sessionId) load()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') load()
    })
    setCount(0)
    load()
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, sessionId])
  return count
}

/** The static feature set of `agent`, or null while it loads or when it cannot be read. */
function useCapabilities(context: UiPluginContext, agent: string): AgentCapabilities | null {
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null)
  useEffect(() => {
    let cancelled = false
    setCapabilities(null)
    context
      .call('quirky.structured/capabilities', { agent })
      .then((loaded) => {
        if (!cancelled) setCapabilities(loaded as AgentCapabilities)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [context, agent])
  return capabilities
}

/**
 * A structured session as a chat: turns with prose, folded activity, cards, asks and views, the
 * Views pane beside them and the composer below. Messages without a chat item still show as
 * plain rows, and the transcript follows new content only while it is scrolled to the end.
 */
export function ChatView({ context, session }: { context: UiPluginContext; session: Session }) {
  const [stored, setStored] = useState<StructuredMessage[]>(NO_MESSAGES)
  const [phase, setPhase] = useState<MessagePhase>({ status: 'loading' })
  const showAll = useSyncExternalStore(
    subscribeShowAllEvents,
    () => showAllEventsFor(session),
    () => showAllEventsFor(session)
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const showAllId = useId()
  const capabilities = useCapabilities(context, session.agent)
  const paneViews = usePaneViews(context, session.id)
  const turns = useMemo(() => groupTurns(stored, { showAll }), [stored, showAll])
  const working = session.status === 'working' || session.status === 'waiting'

  const latest = useRef(0)
  const cancelled = useRef(false)
  const loadedOnce = useRef(false)
  const add = (incoming: StructuredMessage[]) => setStored((current) => mergeMessages(current, incoming))

  // the daemon answers MethodNotFound while quirky.structured is off, so each load re-derives `off`
  function load(): void {
    const attempt = ++latest.current
    if (!loadedOnce.current) setPhase({ status: 'loading' })
    context
      .call('quirky.structured/messages', { session: session.id })
      .then((loaded) => {
        if (cancelled.current || attempt !== latest.current) return
        loadedOnce.current = true
        setPhase({ status: 'ready' })
        add(loaded as StructuredMessage[])
      })
      .catch((error: { code?: unknown }) => {
        if (cancelled.current || attempt !== latest.current) return
        if (error?.code === RpcErrorCode.MethodNotFound) {
          loadedOnce.current = false
          setPhase({ status: 'off' })
        } else if (!loadedOnce.current) {
          setPhase({ status: 'failed', message: messageOf(error) })
        }
      })
  }

  useEffect(() => {
    cancelled.current = false
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'plugin.changed') {
        load()
        return
      }
      if (cancelled.current) return
      if (event.type === 'quirky.structured/message') {
        const message = (event.data as { message?: StructuredMessage } | undefined)?.message
        if (message && message.sessionId === session.id) {
          loadedOnce.current = true
          setPhase({ status: 'ready' })
          add([message])
        }
        return
      }
      if (event.type === 'quirky.structured/settled') {
        if ((event.data as { sessionId?: string } | undefined)?.sessionId === session.id) load()
      }
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
  }, [context, session.id])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [turns])

  if (phase.status === 'off') return <EmptyState message="Structured sessions are off" />

  return (
    <div style={layout}>
      <SectionHeader
        title={session.title}
        style={headerInset}
        actions={
          <label className="ui-checkbox-label" htmlFor={showAllId}>
            <input
              id={showAllId}
              type="checkbox"
              checked={showAll}
              onChange={(event) => {
                const enabled = event.target.checked
                rememberShowAllEvents(session, enabled)
                void context.executeCommand(SHOW_ALL_EVENTS_COMMAND, { session: session.id, enabled }, { activateOwner: false })
              }}
            />
            <span>Show all events</span>
          </label>
        }
      />
      <div style={body}>
        <div
          ref={scrollRef}
          style={scroller}
          role="log"
          aria-live="polite"
          aria-label="Transcript"
          onScroll={(event) => {
            following.current = atBottom(event.currentTarget)
          }}
        >
          <div style={column}>
            {phase.status === 'loading' && turns.length === 0 && <NoticeLine>Loading messages…</NoticeLine>}
            {phase.status === 'failed' && (
              <InlineError message={`Could not load messages: ${phase.message}`} action={{ label: 'Retry', onAction: load }} />
            )}
            {phase.status === 'ready' && turns.length === 0 && <EmptyState message="No messages yet." />}
            {turns.map((turn, index) => (
              <TurnView key={turn.key} context={context} session={session} capabilities={capabilities} data={turn} index={index} />
            ))}
          </div>
        </div>
        {paneViews > 0 && (
          <aside style={pane} aria-label="Views">
            <Embedded context={context} viewId={VIEW_PANE_VIEW} input={{ session: session.id }} fallback="" />
          </aside>
        )}
      </div>
      <Composer context={context} session={session} capabilities={capabilities} working={working} />
    </div>
  )
}
