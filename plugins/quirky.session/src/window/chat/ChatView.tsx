import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react'
import { RpcErrorCode, type AgentCapabilities, type Session, type StructuredMessage, type UiPluginContext } from '@quirky/protocol'
import { Dialog, EmptyState, InlineError, NoticeLine } from '@quirky/ui'
import { rememberShowAllEvents, SHOW_ALL_EVENTS_COMMAND, showAllEventsFor, subscribeShowAllEvents } from '../model'
import { mergeMessages } from '../transcript'
import { Composer } from './Composer'
import { Embedded } from './Embedded'
import { currentMode, planVersions, previousMode } from './plan'
import { PlanChip } from './PlanChip'
import { PlanPanel } from './PlanPanel'
import { groupChatTurns } from './turns'
import { TurnView, VIEW_PANE_VIEW } from './Turn'

const NO_MESSAGES: StructuredMessage[] = []
type MessagePhase = { status: 'loading' } | { status: 'ready' } | { status: 'off' } | { status: 'failed'; message: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The transcript column's width plus the Views pane's, in length units; a narrower body shows the plan in a sheet. */
const PLAN_ASIDE_MIN_UNITS = 720 + 320

/** How far from the end the transcript may be scrolled and still follow new content. */
const BOTTOM_SLACK = 24

/** How many levels below the transcript column a reading anchor may sit. */
const ANCHOR_DEPTH = 6

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
const transcript = { position: 'relative', display: 'flex', flex: 1, minHeight: 0, minWidth: 0 } satisfies CSSProperties
const jump = {
  position: 'absolute',
  insetBlockEnd: 'var(--ui-space-12)',
  insetInlineStart: '50%',
  transform: 'translateX(-50%)',
  padding: 'var(--ui-space-4) var(--ui-space-12)',
  color: 'var(--ui-surface)',
  background: 'var(--ui-accent)',
  border: 0,
  borderRadius: 'var(--ui-radius-window)',
  boxShadow: '0 var(--ui-space-4) var(--ui-space-12) var(--ui-shadow)',
  fontSize: 'var(--ui-font-label)',
  fontWeight: 600,
  cursor: 'pointer'
} satisfies CSSProperties
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
const plan = {
  display: 'flex',
  flex: '0 0 calc(380 * var(--ui-length-unit))',
  flexDirection: 'column',
  minHeight: 0,
  minWidth: 0,
  borderInlineStart: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const headerEnd = { display: 'flex', alignItems: 'center', gap: 'var(--ui-space-8)', flexShrink: 0 } satisfies CSSProperties
const header = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--ui-space-8)',
  minHeight: 'var(--ui-row-single)',
  paddingInline: 'var(--ui-space-8)'
} satisfies CSSProperties
const heading = {
  margin: 0,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--ui-text)',
  fontSize: 'var(--ui-font-label)',
  fontWeight: 700
} satisfies CSSProperties

/** Whether `element` is scrolled to its end, give or take a few lines. */
export function atBottom(element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK
}

/**
 * The deepest element at the top of `scroller` that is still in view, with its offset from the
 * scroller's top. Holding that offset steady keeps the reader's place when content above it resizes.
 */
function readingAnchor(scroller: HTMLElement, column: HTMLElement): { element: Element; offset: number } | null {
  const top = scroller.getBoundingClientRect().top
  let node: Element = column
  for (let depth = 0; depth < ANCHOR_DEPTH; depth++) {
    const next = [...node.children].find((child) => child.getBoundingClientRect().bottom > top)
    if (!next) break
    node = next
    if (next.getBoundingClientRect().top >= top) break
  }
  return node === column ? null : { element: node, offset: node.getBoundingClientRect().top - top }
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

/**
 * Whether `ref`'s element is wide enough to hold the plan panel beside the transcript. An element
 * with no layout yet counts as wide, so the panel never flashes in a sheet before the first measure.
 */
function usePlanFits(ref: RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const width = element.getBoundingClientRect().width
      if (width === 0) return
      const unit = Number.parseFloat(getComputedStyle(element).getPropertyValue('--ui-length-unit'))
      setFits(width >= PLAN_ASIDE_MIN_UNITS * (Number.isFinite(unit) ? unit : 1))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return fits
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

type EarlierChat = { session: Session; messages: StructuredMessage[] }

/**
 * The messages of every session `session` was resumed from, oldest first. Resume starts a new
 * Quirky session with its own journal, so without these a resumed chat would open empty. A
 * session that cannot be read ends the walk and keeps what was found before it.
 */
function useEarlierChats(context: UiPluginContext, session: Session): EarlierChat[] {
  const [earlier, setEarlier] = useState<EarlierChat[]>([])
  useEffect(() => {
    let cancelled = false
    setEarlier([])
    const walk = async () => {
      const found: EarlierChat[] = []
      const seen = new Set([session.id])
      let next = session.resumedFrom
      while (typeof next === 'string' && !seen.has(next)) {
        seen.add(next)
        try {
          const record = (await context.call('quirky.session/get', { session: next })) as Session
          const messages = (await context.call('quirky.structured/messages', { session: record.id })) as StructuredMessage[]
          found.unshift({ session: record, messages })
          next = record.resumedFrom
        } catch {
          break
        }
      }
      if (!cancelled) setEarlier(found)
    }
    void walk()
    return () => {
      cancelled = true
    }
  }, [context, session.id, session.resumedFrom])
  return earlier
}

/**
 * A structured session as a chat: turns with prose, folded activity, cards, asks and views, the
 * Views pane and the plan panel beside them and the composer below. A resumed chat shows the turns of
 * the sessions it was resumed from first. The plan panel shows the newest plan version, opens when a
 * version waits on load or any newer one arrives, and is a sheet when the chat is too narrow for it.
 * Messages without a chat item still show as plain rows, and the transcript follows new content only
 * while it is scrolled to the end.
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
  const columnRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const lastTop = useRef(0)
  const anchor = useRef<{ element: Element; offset: number } | null>(null)
  const [behind, setBehind] = useState(false)
  const showAllId = useId()
  const capabilities = useCapabilities(context, session.agent)
  const paneViews = usePaneViews(context, session.id)
  const earlier = useEarlierChats(context, session)
  const turns = useMemo(
    () => {
      const chats = [...earlier, { session, messages: stored }]
      const grouped = groupChatTurns(chats.map((chat) => chat.messages), { showAll })
      return chats.flatMap((chat, index) => grouped[index]!.map((turn) => ({ owner: chat.session, key: `${chat.session.id}:${turn.key}`, turn })))
    },
    [earlier, session, stored, showAll]
  )
  const history = useMemo(() => [...earlier.flatMap((chat) => chat.messages), ...stored], [earlier, stored])
  const versions = useMemo(() => planVersions(history), [history])
  const mode = useMemo(() => currentMode(history), [history])
  const modeBeforePlan = useMemo(() => previousMode(history), [history])
  const newest = versions.at(-1)
  const [panelOpen, setPanelOpen] = useState(false)
  const [viewed, setViewed] = useState<number | null>(null)
  const lastSeen = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const fits = usePlanFits(bodyRef)
  const shown = versions.find((entry) => entry.version === viewed) ?? newest
  const closePanel = () => setPanelOpen(false)
  const planPanel =
    panelOpen && shown ? (
      <PlanPanel
        key={shown.version}
        context={context}
        sessionId={session.id}
        version={shown}
        isNewest={shown.version === newest?.version}
        onClose={closePanel}
        framed={fits}
      />
    ) : null
  const autoAvailable = mode !== null ? mode.autoAvailable === true : stored.length === 0 ? undefined : false
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
    lastSeen.current = null
    setPanelOpen(false)
    setViewed(null)
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

  useEffect(() => {
    if (phase.status !== 'ready') return
    const latestVersion = newest?.version ?? 0
    if (lastSeen.current === null) {
      lastSeen.current = latestVersion
      setPanelOpen(newest?.status === 'waiting')
    } else if (latestVersion > lastSeen.current) {
      lastSeen.current = latestVersion
      setViewed(null)
      setPanelOpen(true)
    }
  }, [phase.status, newest?.version, newest?.status])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [turns])

  // WKWebView has no overflow-anchor, so a reader scrolled up is held in place by hand
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const column = columnRef.current
    if (!scroller || !column || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (following.current) {
        scroller.scrollTop = scroller.scrollHeight
        return
      }
      const held = anchor.current
      if (held && column.contains(held.element)) {
        const drift = held.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - held.offset
        if (drift !== 0) scroller.scrollTop += drift
      }
      anchor.current = readingAnchor(scroller, column)
    })
    observer.observe(column)
    return () => observer.disconnect()
  }, [phase.status === 'off'])

  function onScrolled(element: HTMLElement): void {
    // only a scroll upward leaves the end, so a smooth scroll back down is not mistaken for a reader leaving it
    following.current = atBottom(element) || (following.current && element.scrollTop >= lastTop.current)
    lastTop.current = element.scrollTop
    const column = columnRef.current
    anchor.current = following.current || !column ? null : readingAnchor(element, column)
    setBehind(!following.current)
  }

  function onJumpToLatest(): void {
    const element = scrollRef.current
    if (!element) return
    following.current = true
    anchor.current = null
    setBehind(false)
    if (typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    else element.scrollTop = element.scrollHeight
  }

  if (phase.status === 'off') return <EmptyState message="Structured sessions are off" />

  return (
    <div style={layout}>
      <header style={header}>
        <h2 style={heading}>{session.title}</h2>
        <div style={headerEnd}>
          {newest && (
            <PlanChip
              newest={newest}
              open={panelOpen}
              onToggle={() => {
                setViewed(null)
                setPanelOpen(!panelOpen)
              }}
            />
          )}
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
        </div>
      </header>
      <div ref={bodyRef} style={body}>
        <div style={transcript}>
          <div ref={scrollRef} style={scroller} role="log" aria-live="polite" aria-label="Transcript" onScroll={(event) => onScrolled(event.currentTarget)}>
            <div ref={columnRef} style={column}>
              {phase.status === 'loading' && turns.length === 0 && <NoticeLine>Loading messages…</NoticeLine>}
              {phase.status === 'failed' && (
                <InlineError message={`Could not load messages: ${phase.message}`} action={{ label: 'Retry', onAction: load }} />
              )}
              {phase.status === 'ready' && turns.length === 0 && <EmptyState message="No messages yet." />}
              {turns.map(({ owner, key, turn }, index) => (
                <TurnView
                  key={key}
                  context={context}
                  session={owner}
                  capabilities={capabilities}
                  data={turn}
                  index={index}
                  onOpenPlan={(version) => {
                    setViewed(version === newest?.version ? null : version)
                    setPanelOpen(true)
                  }}
                />
              ))}
            </div>
          </div>
          {behind && (
            <button type="button" style={jump} aria-label="Jump to latest" onClick={onJumpToLatest}>
              Jump to latest
            </button>
          )}
        </div>
        {paneViews > 0 && (
          <aside style={pane} aria-label="Views">
            <Embedded context={context} viewId={VIEW_PANE_VIEW} input={{ session: session.id }} fallback="" />
          </aside>
        )}
        {planPanel !== null && fits && (
          <aside style={plan} aria-label="Plan">
            {planPanel}
          </aside>
        )}
      </div>
      {planPanel !== null && !fits && (
        <Dialog open title="Plan" variant="sheet" scrollBody onClose={closePanel}>
          {planPanel}
        </Dialog>
      )}
      <Composer
        context={context}
        session={session}
        capabilities={capabilities}
        working={working}
        reportedMode={mode?.mode}
        autoAvailable={autoAvailable}
        previousMode={modeBeforePlan}
      />
    </div>
  )
}
