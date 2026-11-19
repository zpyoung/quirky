import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react'
import { RpcErrorCode, type AgentCapabilities, type Session, type StructuredMessage, type UiPluginContext } from '@quirky/protocol'
import { Button, ControlIcon, EmptyState, InlineError, NoticeLine } from '@quirky/ui'
import { showAllEventsFor, subscribeShowAllEvents } from '../model'
import { mergeMessages } from '../transcript'
import { ChatHeader } from './ChatHeader'
import { chatFrame, useChatLayout } from './chatLayout'
import { Composer } from './Composer'
import { defaultVisualLevel, registerChatHandle, useVisualLabels } from './controls'
import { newestUserAt } from './elapsed'
import { Embedded } from './Embedded'
import { currentMode, planVersions, previousMode } from './plan'
import { PlanChip } from './PlanChip'
import { PlanPanel } from './PlanPanel'
import { currentVisualLevel, groupChatTurns } from './turns'
import { TurnView, VIEW_RENDER_VIEW, type VisualActions } from './Turn'
import { useBodyMetrics, useViews, VisualPanel, type ViewIndex, type VisualRecord } from './VisualPanel'

const NO_MESSAGES: StructuredMessage[] = []
type MessagePhase = { status: 'loading' } | { status: 'ready' } | { status: 'off' } | { status: 'failed'; message: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
const bodyHidden = { ...body, display: 'none' } satisfies CSSProperties
const expandedBox = { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0 } satisfies CSSProperties
const expandedBar = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ui-space-8)',
  minHeight: 'var(--ui-row-single)',
  paddingInline: 'var(--ui-space-8)',
  borderBlockEnd: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const expandedHint = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties
const expandedCard = { flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' } satisfies CSSProperties
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
  minWidth: 0
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

/** Messages asked for per request, so no chat ever needs a reply too large for the daemon to send. */
export const CHAT_PAGE_SIZE = 1000

type HistoryState = { more: boolean; loading: boolean; error: string | null }

/**
 * Where Load earlier messages continues: below `beforeSeq` in `record`, or its predecessor once
 * `exhausted`. `until` is the newest time (epoch ms) a message may carry to belong to this chat's
 * history: a fork never shows what its source received after the fork was made.
 */
type HistoryCursor = { record: Session; beforeSeq?: number; exhausted: boolean; until?: number }

const replyTooLarge = (error: unknown) => (error as { data?: { reason?: unknown } } | null)?.data?.reason === 'reply_too_large'

/** One page of messages, halving `limit` while the daemon answers that the reply is too large to send. */
async function fetchPage(
  context: UiPluginContext,
  params: Record<string, unknown>,
  limit: number
): Promise<{ messages: StructuredMessage[]; limit: number }> {
  for (;;) {
    try {
      return { messages: (await context.call('quirky.structured/messages', { ...params, limit })) as StructuredMessage[], limit }
    } catch (error) {
      if (limit <= 1 || !replyTooLarge(error)) throw error
      limit = Math.ceil(limit / 2)
    }
  }
}

/** Adds `page` to `record`'s chat, which goes first when it is a session not shown yet. */
function prependEarlier(chats: EarlierChat[], record: Session, page: StructuredMessage[]): EarlierChat[] {
  const index = chats.findIndex((chat) => chat.session.id === record.id)
  if (index === -1) return [{ session: record, messages: page }, ...chats]
  return chats.map((chat, at) => (at === index ? { ...chat, messages: mergeMessages(chat.messages, page) } : chat))
}

/**
 * A structured session as a chat: turns with prose, folded activity, cards, asks and views, the
 * visual panel beside them and the composer below. It opens on the newest `CHAT_PAGE_SIZE` messages,
 * and Load earlier messages pages back through this session, then through the sessions it was resumed
 * from, oldest shown first. The visual panel holds the visuals the agent placed in the pane, with the
 * plan card first: that card shows the newest loaded plan version, opens when a version waits on load
 * or any newer one arrives. A visual the agent drew leaves a chip in the turn that drew it, which
 * opens that version in the panel, and a visual can expand to fill the chat above the composer until
 * Esc. Messages without a chat item still show as plain rows, and the transcript follows new content
 * only while it is scrolled to the end.
 */
export function ChatView({ context, session }: { context: UiPluginContext; session: Session }) {
  const [stored, setStored] = useState<StructuredMessage[]>(NO_MESSAGES)
  const [earlier, setEarlier] = useState<EarlierChat[]>([])
  const [phase, setPhase] = useState<MessagePhase>({ status: 'loading' })
  const [older, setOlder] = useState<HistoryState>({ more: false, loading: false, error: null })
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
  const keepDistanceFromEnd = useRef<number | null>(null)
  const capabilities = useCapabilities(context, session.agent)
  const [expanded, setExpanded] = useState<{ viewId: string; version?: number; foreign?: true } | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ viewId: string; version: number | null; nonce: number } | null>(null)
  const [visualizing, setVisualizing] = useState<number | null>(null)
  const sawWorking = useRef(false)
  const viewIndex = useViews(context, session.id, (change) => {
    if (change.kind === undefined || change.kind === 'open' || change.kind === 'update' || change.kind === 'patch') setVisualizing(null)
  })
  useVisualLabels(context)
  const chatLayout = useChatLayout(context)
  const turns = useMemo(
    () => {
      const chats = [...earlier, { session, messages: stored }]
      const grouped = groupChatTurns(chats.map((chat) => chat.messages), { showAll })
      return chats.flatMap((chat, index) => grouped[index]!.map((turn) => ({ owner: chat.session, key: `${chat.session.id}:${turn.key}`, turn })))
    },
    [earlier, session, stored, showAll]
  )
  const history = useMemo(() => [...earlier.flatMap((chat) => chat.messages), ...stored], [earlier, stored])
  const [otherViews, setOtherViews] = useState<Map<string, VisualRecord>>(() => new Map())
  const askedViews = useRef(new Set<string>())
  const turnsIndex = useMemo<ViewIndex>(() => {
    if (otherViews.size === 0) return viewIndex
    return { ...viewIndex, byId: new Map([...otherViews, ...viewIndex.byId]) }
  }, [viewIndex, otherViews])
  const versions = useMemo(() => planVersions(history), [history])
  const mode = useMemo(() => currentMode(history), [history])
  const journaledLevel = useMemo(() => currentVisualLevel(history), [history])
  const modeBeforePlan = useMemo(() => previousMode(history), [history])
  const newest = versions.at(-1)
  const [panelOpen, setPanelOpen] = useState(false)
  const [viewed, setViewed] = useState<number | null>(null)
  const lastSeen = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { width: bodyWidth, unit } = useBodyMetrics(bodyRef)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const { width: transcriptWidth } = useBodyMetrics(transcriptRef)
  const shown = versions.find((entry) => entry.version === viewed) ?? newest
  const closePanel = () => setPanelOpen(false)
  const planCard = panelOpen && shown ? { version: shown, isNewest: shown.version === newest?.version } : null
  const autoAvailable = mode !== null ? mode.autoAvailable === true : stored.length === 0 ? undefined : false
  const working = session.status === 'working' || session.status === 'waiting'
  const workingNow = useRef(working)
  workingNow.current = working

  const openVisual = (viewId: string, version: number) => {
    if (viewIndex.status === 'ready' && !viewIndex.byId.has(viewId)) {
      setExpanded({ viewId, version, foreign: true })
      return
    }
    const latestVersion = viewIndex.byId.get(viewId)?.latestVersion
    setExpanded(null)
    setFocusRequest((current) => ({ viewId, version: latestVersion !== undefined && version >= latestVersion ? null : version, nonce: (current?.nonce ?? 0) + 1 }))
  }
  const visualize = (seq: number, request: string) => {
    setVisualizing(seq)
    context.call('quirky.structured/send', { session: session.id, text: request, when: workingNow.current ? 'idle' : 'now' }).catch((error) => {
      setVisualizing(null)
      context.toast('Could not ask for a visual', messageOf(error))
    })
  }
  const visual: VisualActions = { views: turnsIndex, busySeq: visualizing, onVisualize: visualize, onOpen: openVisual }
  const expandRef = useRef((viewId: string, version?: number) => setExpanded({ viewId, ...(version === undefined ? {} : { version }) }))

  useEffect(() => registerChatHandle(session.id, { expand: (viewId, version) => expandRef.current(viewId, version) }), [session.id])

  useEffect(() => {
    setExpanded(null)
    setFocusRequest(null)
    setVisualizing(null)
    setOtherViews(new Map())
    askedViews.current = new Set()
  }, [session.id])

  // views an earlier chat of this conversation drew are not in this session's list, so each one is read by id
  useEffect(() => {
    if (viewIndex.status !== 'ready') return
    for (const message of history) {
      const viewId = message.item?.kind === 'view' ? message.item.viewId : undefined
      if (viewId === undefined || viewIndex.byId.has(viewId) || askedViews.current.has(viewId)) continue
      askedViews.current.add(viewId)
      context
        .call('quirky.view/get', { viewId })
        .then((loaded) => {
          const record = loaded as Partial<VisualRecord> | null
          if (typeof record?.title !== 'string') return
          const found: VisualRecord = {
            viewId,
            title: record.title,
            placement: record.placement === 'inline' ? 'inline' : 'pane',
            closed: record.closed === true,
            ...(typeof record.latestVersion === 'number' ? { latestVersion: record.latestVersion } : {})
          }
          setOtherViews((current) => new Map(current).set(viewId, found))
        })
        .catch(() => askedViews.current.delete(viewId))
    }
  }, [context, history, viewIndex])

  // a Visualize request is done once its visual arrives or the turn that took it ends, whichever is first
  useEffect(() => {
    if (visualizing === null) {
      sawWorking.current = false
      return
    }
    if (working) sawWorking.current = true
    else if (sawWorking.current) setVisualizing(null)
  }, [visualizing, working])

  useEffect(() => {
    if (expanded === null || expanded.foreign || viewIndex.status !== 'ready') return
    const record = viewIndex.byId.get(expanded.viewId)
    if (!record || record.closed) setExpanded(null)
  }, [expanded, viewIndex])

  const onLeaveExpanded = () => setExpanded(null)

  const onLayoutKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (expanded === null || event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    setExpanded(null)
  }

  const latest = useRef(0)
  const generation = useRef(0)
  const cancelled = useRef(false)
  const loadedOnce = useRef(false)
  const newestLoaded = useRef(0)
  const cursor = useRef<HistoryCursor | null>(null)
  const seen = useRef(new Set<string>())
  const paging = useRef(false)
  const add = (incoming: StructuredMessage[]) => {
    for (const message of incoming) newestLoaded.current = Math.max(newestLoaded.current, message.seq)
    setStored((current) => mergeMessages(current, incoming))
  }
  async function catchUp(attempt: number): Promise<void> {
    for (;;) {
      const { messages: page, limit } = await fetchPage(context, { session: session.id, afterSeq: newestLoaded.current }, CHAT_PAGE_SIZE)
      if (cancelled.current || attempt !== latest.current) return
      add(page)
      if (page.length < limit) return
    }
  }

  /**
   * Prepends up to `budget` older messages, moving to the session this one was resumed from once a
   * session runs out. A session that cannot be read ends the walk and keeps what was found.
   */
  async function loadEarlier(budget = CHAT_PAGE_SIZE): Promise<void> {
    if (paging.current || cursor.current === null) return
    paging.current = true
    const run = generation.current
    const stale = () => cancelled.current || run !== generation.current
    setOlder((now) => ({ ...now, loading: true, error: null }))
    let error: string | null = null
    try {
      let left = budget
      while (left > 0 && cursor.current !== null) {
        const at: HistoryCursor = cursor.current
        if (at.exhausted) {
          const next: string | null | undefined = at.record.resumedFrom
          if (typeof next !== 'string' || seen.current.has(next)) {
            cursor.current = null
            break
          }
          seen.current.add(next)
          try {
            const forkPoint = at.record.forked === true ? at.record.createdAt : undefined
            const until = forkPoint === undefined ? at.until : Math.min(forkPoint, at.until ?? forkPoint)
            cursor.current = {
              record: (await context.call('quirky.session/get', { session: next })) as Session,
              exhausted: false,
              ...(until === undefined ? {} : { until })
            }
          } catch {
            cursor.current = null
          }
          if (stale()) return
          continue
        }
        const { messages: page, limit } = await fetchPage(
          context,
          { session: at.record.id, tail: true, ...(at.beforeSeq === undefined ? {} : { beforeSeq: at.beforeSeq }) },
          left
        )
        if (stale()) return
        const shown = at.until === undefined ? page : page.filter((message) => message.at <= at.until!)
        if (at.record.id === session.id) add(shown)
        else if (shown.length > 0) setEarlier((chats) => prependEarlier(chats, at.record, shown))
        const oldest = page[0]?.seq ?? at.beforeSeq ?? 1
        cursor.current = {
          record: at.record,
          beforeSeq: oldest,
          exhausted: page.length < limit || oldest <= 1,
          ...(at.until === undefined ? {} : { until: at.until })
        }
        left -= shown.length
      }
    } catch (failure) {
      error = messageOf(failure)
    } finally {
      paging.current = false
    }
    if (stale()) return
    const more = cursor.current !== null && (!cursor.current.exhausted || typeof cursor.current.record.resumedFrom === 'string')
    setOlder({ more, loading: false, error })
  }

  async function loadNewest(attempt: number): Promise<void> {
    const { messages: page, limit } = await fetchPage(context, { session: session.id, tail: true }, CHAT_PAGE_SIZE)
    if (cancelled.current || attempt !== latest.current) return
    loadedOnce.current = true
    setPhase({ status: 'ready' })
    add(page)
    const oldest = page[0]?.seq ?? 1
    cursor.current = { record: session, beforeSeq: oldest, exhausted: page.length < limit || oldest <= 1 }
    if (page.length < limit) await loadEarlier(CHAT_PAGE_SIZE - page.length)
    else setOlder({ more: true, loading: false, error: null })
  }

  // the daemon answers MethodNotFound while quirky.structured is off, so each load re-derives `off`
  function load(): void {
    const attempt = ++latest.current
    const firstLoad = !loadedOnce.current
    if (firstLoad) setPhase({ status: 'loading' })
    ;(firstLoad ? loadNewest(attempt) : catchUp(attempt)).catch((error: { code?: unknown }) => {
      if (cancelled.current || attempt !== latest.current) return
      if (error?.code === RpcErrorCode.MethodNotFound) {
        loadedOnce.current = false
        setPhase({ status: 'off' })
      } else if (!loadedOnce.current) {
        setPhase({ status: 'failed', message: messageOf(error) })
      }
    })
  }

  function showEarlier(): void {
    const element = scrollRef.current
    keepDistanceFromEnd.current = element ? element.scrollHeight - element.scrollTop : null
    void loadEarlier()
  }

  useEffect(() => {
    lastSeen.current = null
    setPanelOpen(false)
    setViewed(null)
    cancelled.current = false
    generation.current++
    cursor.current = null
    seen.current = new Set([session.id])
    setEarlier([])
    setOlder({ more: false, loading: false, error: null })
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'plugin.changed') {
        load()
        return
      }
      if (cancelled.current) return
      if (event.type === 'quirky.structured/message') {
        const message = (event.data as { message?: StructuredMessage } | undefined)?.message
        if (message && message.sessionId === session.id) add([message])
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
      generation.current++
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
    if (!element) return
    if (keepDistanceFromEnd.current !== null && !older.loading) {
      element.scrollTop = element.scrollHeight - keepDistanceFromEnd.current
      keepDistanceFromEnd.current = null
    } else if (following.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [turns, older.loading])

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
    <div style={layout} onKeyDownCapture={onLayoutKeyDown}>
      <ChatHeader
        context={context}
        session={session}
        capabilities={capabilities}
        messages={history}
        showAll={showAll}
        layout={chatLayout}
        planChip={
          newest && (
            <PlanChip
              newest={newest}
              open={panelOpen}
              onToggle={() => {
                setViewed(null)
                setPanelOpen(!panelOpen)
              }}
            />
          )
        }
      />
      <div ref={bodyRef} style={expanded === null ? body : bodyHidden}>
        <div ref={transcriptRef} style={transcript}>
          <div ref={scrollRef} style={scroller} role="log" aria-live="polite" aria-label="Transcript" onScroll={(event) => onScrolled(event.currentTarget)}>
            <div ref={columnRef} style={{ ...column, ...chatFrame(chatLayout) }} data-chat-width={chatLayout.width} data-chat-align={chatLayout.align}>
              {older.more && (
                <Button type="button" disabled={older.loading} onClick={showEarlier}>
                  {older.loading ? 'Loading earlier messages…' : 'Load earlier messages'}
                </Button>
              )}
              {older.error !== null && (
                <InlineError message={`Could not load earlier messages: ${older.error}`} action={{ label: 'Retry', onAction: showEarlier }} />
              )}
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
                  visual={visual}
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
        <VisualPanel
          context={context}
          session={session}
          views={viewIndex.views}
          plan={planCard}
          onClosePlan={closePanel}
          working={working}
          level={journaledLevel ?? defaultVisualLevel(context)}
          bodyRef={bodyRef}
          bodyWidth={bodyWidth}
          unit={unit}
          focus={focusRequest}
        />
      </div>
      {expanded !== null && (
        <section style={expandedBox} aria-label="Expanded visual">
          <div style={expandedBar}>
            <Button onClick={onLeaveExpanded}>
              <ControlIcon name="caret-left" /> Back to chat
            </Button>
            <span style={expandedHint}>Esc</span>
          </div>
          <Embedded
            context={context}
            viewId={VIEW_RENDER_VIEW}
            input={{ viewId: expanded.viewId, ...(expanded.version === undefined ? {} : { version: expanded.version }), surface: 'expanded', focused: true }}
            fallback="Visuals are turned off."
            style={expandedCard}
          />
        </section>
      )}
      <Composer
        context={context}
        session={session}
        capabilities={capabilities}
        working={working}
        workStartedAt={newestUserAt(history)}
        reportedMode={mode?.mode}
        autoAvailable={autoAvailable}
        previousMode={modeBeforePlan}
        reportedLevel={journaledLevel ?? undefined}
        layout={chatLayout}
        endInset={expanded === null && bodyWidth > 0 && transcriptWidth > 0 ? bodyWidth - transcriptWidth : 0}
      />
    </div>
  )
}
