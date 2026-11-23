import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Session, UiPluginContext, VisualLevel } from '@quirky/protocol'
import { Badge, ControlIcon, EmptyState, IconButton, INITIAL_DECK_FOCUS, VisualDeckTabs, deckFocusReducer, orderDeckEntries, type DeckClosedEntry, type DeckEntry, type DeckEvent } from '@quirky/ui'
import { visualLevelLabel } from './controls'
import { Embedded } from './Embedded'
import { PlanPanel } from './PlanPanel'
import type { PlanVersion } from './plan'
import { VIEW_RENDER_VIEW } from './Turn'

/** A view of the session as `quirky.view/list` reports it; the fields past `closed` come from newer versions of that plugin. */
export type VisualRecord = {
  viewId: string
  title: string
  placement: 'inline' | 'pane'
  closed: boolean
  /** The short tab label the agent gave, when it gave one. */
  label?: string
  /** Whether the agent or the user marked the view done; false from a daemon that does not say. */
  done: boolean
  version?: number
  latestVersion?: number
  /** When the view last changed, in milliseconds; orders the closed views. */
  updatedAt?: number
}

/** The session's views once read: `loading` before the first answer, `unavailable` when quirky.view cannot be asked. */
export type ViewIndex = { status: 'loading' | 'unavailable' | 'ready'; views: VisualRecord[]; byId: Map<string, VisualRecord> }

/** What a `quirky.view/changed` event says about a view; `kind` is missing from events of older versions of that plugin. */
export type ViewChange = { viewId: string; kind: string | undefined }

const NO_VIEWS: VisualRecord[] = []
const LOADING: ViewIndex = { status: 'loading', views: NO_VIEWS, byId: new Map() }

/** The pref key and bounds the daemon accepts for the panel's share of the chat body. */
export const WIDTH_RATIO_KEY = 'chat.visual-panel.width-ratio'
const DEFAULT_RATIO = 0.45
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8
const RATIO_STEP = 0.02

/** The panel's narrowest width and the transcript's, in length units. */
const PANEL_MIN_UNITS = 280
const TRANSCRIPT_MIN_UNITS = 420
/** Below this body width the panel starts collapsed. */
const COLLAPSE_BELOW_UNITS = 720

const DRAWING_KINDS = new Set(['open', 'update', 'patch'])

const PLAN = 'plan'

const readLabel = (record: { label?: unknown; spec?: { label?: unknown } | null }): string | undefined => {
  const label = typeof record.label === 'string' ? record.label : record.spec?.label
  return typeof label === 'string' && label !== '' ? label : undefined
}

const readRecords = (loaded: unknown): VisualRecord[] =>
  (Array.isArray(loaded) ? (loaded as (Partial<VisualRecord> & { spec?: { label?: unknown } | null; updatedAt?: unknown })[]) : []).flatMap((record) => {
    if (typeof record.viewId !== 'string') return []
    const label = readLabel(record)
    const updated = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : record.updatedAt
    return [{
      viewId: record.viewId,
      title: typeof record.title === 'string' ? record.title : 'Visual',
      placement: record.placement === 'inline' ? ('inline' as const) : ('pane' as const),
      closed: record.closed === true,
      done: record.done === true,
      ...(label === undefined ? {} : { label }),
      ...(typeof record.version === 'number' ? { version: record.version } : {}),
      ...(typeof record.latestVersion === 'number' ? { latestVersion: record.latestVersion } : {}),
      ...(typeof updated === 'number' && Number.isFinite(updated) ? { updatedAt: updated } : {})
    }]
  })

/**
 * The session's views, read again whenever one of them changes. `onChange` hears each change event of
 * this session, after the list is asked for again.
 */
export function useViews(context: UiPluginContext, sessionId: string, onChange?: (change: ViewChange) => void): ViewIndex {
  const [index, setIndex] = useState<ViewIndex>(LOADING)
  const heard = useRef(onChange)
  heard.current = onChange
  useEffect(() => {
    let cancelled = false
    let latest = 0
    const load = () => {
      const attempt = ++latest
      context
        .call('quirky.view/list', { session: sessionId })
        .then((loaded) => {
          if (cancelled || attempt !== latest) return
          const views = readRecords(loaded)
          setIndex({ status: 'ready', views, byId: new Map(views.map((view) => [view.viewId, view])) })
        })
        .catch(() => {
          if (!cancelled && attempt === latest) setIndex((current) => (current.status === 'ready' ? current : { status: 'unavailable', views: NO_VIEWS, byId: new Map() }))
        })
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.view/changed') return
      const data = event.data as { sessionId?: string; viewId?: unknown; kind?: unknown } | undefined
      if (data?.sessionId !== undefined && data.sessionId !== sessionId) return
      load()
      if (typeof data?.viewId === 'string') heard.current?.({ viewId: data.viewId, kind: typeof data.kind === 'string' ? data.kind : undefined })
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') load()
    })
    setIndex(LOADING)
    load()
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, sessionId])
  return index
}

/**
 * The width of `ref`'s element in pixels and the size of one length unit in pixels. A width of 0 means
 * the element has had no layout yet.
 */
export function useBodyMetrics(ref: RefObject<HTMLElement | null>): { width: number; unit: number } {
  const [metrics, setMetrics] = useState({ width: 0, unit: 1 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const width = element.getBoundingClientRect().width
      // a hidden element reports 0, and its last width is still the right one when it returns
      if (width === 0) return
      const unit = Number.parseFloat(getComputedStyle(element).getPropertyValue('--ui-length-unit'))
      const next = { width, unit: Number.isFinite(unit) && unit > 0 ? unit : 1 }
      setMetrics((current) => (current.width === next.width && current.unit === next.unit ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return metrics
}

const clampRatio = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))

const dividerZone = { position: 'relative', display: 'flex', flex: '0 0 auto', alignSelf: 'stretch' } satisfies CSSProperties
// the slot stays focusable while hidden, so tabbing to it shows it; pointer events stay off so the hidden button never eats a drag
const collapseSlot = (shown: boolean): CSSProperties => ({
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 1,
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-surface)',
  opacity: shown ? 1 : 0,
  pointerEvents: shown ? 'auto' : 'none',
  transition: 'opacity 120ms ease-out'
})
const divider = {
  display: 'flex',
  justifyContent: 'center',
  flex: '0 0 auto',
  alignSelf: 'stretch',
  width: 'var(--ui-space-12)',
  cursor: 'col-resize',
  touchAction: 'none',
  outline: 'none',
  background: 'var(--ui-transparent)'
} satisfies CSSProperties
/** Whether `element` got focus from the keyboard; the lit line stands in for the outline, so a click must not leave it lit. */
const focusVisible = (element: HTMLElement): boolean => {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}
const dividerLine = (lit: boolean): CSSProperties => ({
  width: lit ? 'var(--ui-space-2)' : 'var(--ui-border-width)',
  background: lit ? 'var(--ui-accent)' : 'var(--ui-border)',
  pointerEvents: 'none'
})
const rail = {
  display: 'flex',
  flex: '0 0 auto',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-8) var(--ui-space-4)',
  borderInlineStart: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const panel = (ratio: number): CSSProperties => ({
  display: 'flex',
  flex: `0 0 ${ratio * 100}%`,
  flexDirection: 'column',
  minHeight: 0,
  minWidth: `calc(${PANEL_MIN_UNITS} * var(--ui-length-unit))`,
  maxWidth: `calc(100% - ${TRANSCRIPT_MIN_UNITS} * var(--ui-length-unit))`
})
const header = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--ui-space-8)',
  minHeight: 'var(--ui-row-single)',
  paddingInline: 'var(--ui-space-8)',
  borderBlockEnd: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const heading = { margin: 0, color: 'var(--ui-text)', fontSize: 'var(--ui-font-label)', fontWeight: 700 } satisfies CSSProperties
const scroller = { flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', padding: 'var(--ui-space-8)' } satisfies CSSProperties
const card = {
  minWidth: 0,
  overflow: 'hidden',
  background: 'var(--ui-surface)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-window)'
} satisfies CSSProperties
const empty = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--ui-space-8)', padding: 'var(--ui-space-16)' } satisfies CSSProperties
const level = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties

/** The input that mounts a view's card in the panel: `surface` and, only when set, the version it is pinned to and its flags. */
function cardInput(viewId: string, surface: 'panel', options: { version?: number; drawing?: boolean; focused?: boolean } = {}) {
  return {
    viewId,
    ...(options.version === undefined ? {} : { version: options.version }),
    surface,
    ...(options.drawing === true ? { drawing: true } : {}),
    ...(options.focused === true ? { focused: true } : {})
  }
}

/** Where focus goes when `gone` leaves the deck: the nearest tab to its left that remains, else the first that remains. */
const focusAfterRemoval = (before: readonly string[], gone: string, remaining: readonly string[]): string | null =>
  before.slice(0, Math.max(0, before.indexOf(gone))).reverse().find((id) => remaining.includes(id)) ?? remaining[0] ?? null

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The docked panel beside a chat's transcript: one visual at a time under a tab row, with the plan as
 * the pinned first tab when one is open and the visuals the agent placed in the pane after it. The tab
 * row follows the agent's newest visual until the user picks a tab, then marks what changed with dots
 * until the next message sent resumes following. Closed visuals can be reopened from the row's menu.
 * A card is `drawing` while the session works on it, and the panel starts collapsed in a narrow chat.
 * Collapsed it is a rail counting what was drawn since. A visual the user moves into the panel, a new
 * plan version and a message chip's `focus` always take focus and open the panel. Dragging the divider
 * sets the width, which is remembered across chats through `quirky.session/setUiPref`. `focus` asks the
 * panel to show one visual at one version, as when a message chip is clicked, and `sentNonce` changes
 * each time the user sends a message.
 */
export function VisualPanel({
  context,
  session,
  views,
  plan,
  onClosePlan,
  working,
  level: visualLevel,
  bodyRef,
  bodyWidth,
  unit,
  focus,
  sentNonce
}: {
  context: UiPluginContext
  session: Session
  views: VisualRecord[]
  plan: { version: PlanVersion; isNewest: boolean } | null
  onClosePlan: () => void
  working: boolean
  level: VisualLevel
  bodyRef: RefObject<HTMLElement | null>
  /** The chat body's width in pixels, 0 before it has layout. */
  bodyWidth: number
  /** One length unit in pixels. */
  unit: number
  focus: { viewId: string; version: number | null; nonce: number } | null
  sentNonce: number
}) {
  const [ratio, setRatio] = useState(DEFAULT_RATIO)
  const [dragging, setDragging] = useState(false)
  const [dividerHover, setDividerHover] = useState(false)
  const [dividerFocus, setDividerFocus] = useState(false)
  const [collapseFocus, setCollapseFocus] = useState(false)
  const dividerLit = dragging || dividerHover || dividerFocus
  const collapseShown = !dragging && (dividerHover || dividerFocus || collapseFocus)
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null)
  const [deck, setDeck] = useState(INITIAL_DECK_FOCUS)
  const [pinned, setPinned] = useState<Record<string, number>>({})
  const [drawing, setDrawing] = useState<ReadonlySet<string>>(new Set())
  const [fresh, setFresh] = useState(0)
  const ratioRef = useRef(ratio)
  const dragged = useRef(false)
  const workingRef = useRef(working)
  workingRef.current = working
  const dispatch = (event: DeckEvent) => setDeck((current) => deckFocusReducer(current, event))

  const narrow = bodyWidth > 0 && bodyWidth < COLLAPSE_BELOW_UNITS * unit
  const collapsed = userCollapsed ?? narrow
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  const visible = useMemo(() => views.filter((view) => view.placement === 'pane' && !view.closed), [views])
  const planVersion = plan?.version.version ?? null

  const entries = useMemo<DeckEntry[]>(() => {
    const visuals = views.flatMap((view, created) =>
      view.placement === 'pane' && !view.closed
        ? [{ id: view.viewId, label: view.label ?? view.title, title: view.title, created, done: view.done }]
        : []
    )
    return planVersion === null ? visuals : [{ id: PLAN, label: `Plan v${planVersion}`, title: `Plan v${planVersion}`, created: -1, pinned: true }, ...visuals]
  }, [views, planVersion])
  const closedEntries = useMemo<DeckClosedEntry[]>(
    () =>
      views.flatMap((view, index) =>
        view.placement === 'pane' && view.closed ? [{ id: view.viewId, label: view.label ?? view.title, title: view.title, closedOrder: view.updatedAt ?? index }] : []
      ),
    [views]
  )
  const orderedIds = useMemo(() => orderDeckEntries(entries).map((entry) => entry.id), [entries])
  const previousOrder = useRef<string[]>([])

  const newestLive = visible.findLast((view) => !view.done) ?? undefined
  const focusedKey =
    deck.focusedId !== null && entries.some((entry) => entry.id === deck.focusedId) ? deck.focusedId
    : (newestLive?.viewId ?? (planVersion !== null ? PLAN : (visible.at(-1)?.viewId ?? null)))

  const setWidth = (next: number) => {
    ratioRef.current = next
    setRatio(next)
  }
  const saveWidth = () => {
    context.call('quirky.session/setUiPref', { key: WIDTH_RATIO_KEY, value: Math.round(ratioRef.current * 1000) / 1000 }).catch(() => {})
  }

  useEffect(() => {
    setUserCollapsed(null)
    setDeck(INITIAL_DECK_FOCUS)
    setPinned({})
    setDrawing(new Set())
    setFresh(0)
  }, [session.id])

  useEffect(() => {
    let cancelled = false
    context
      .call('quirky.session/uiPref', { key: WIDTH_RATIO_KEY })
      .then((found) => {
        const value = (found as { value?: unknown } | null)?.value
        if (!cancelled && !dragged.current && typeof value === 'number' && value >= MIN_RATIO && value <= MAX_RATIO) setWidth(value)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [context])

  useEffect(
    () =>
      context.subscribe((event) => {
        if (event.type !== 'quirky.view/changed') return
        const data = event.data as { sessionId?: string; viewId?: unknown; kind?: unknown; placement?: unknown } | undefined
        if (data?.sessionId !== undefined && data.sessionId !== session.id) return
        if (typeof data?.viewId !== 'string') return
        const kind = typeof data.kind === 'string' ? data.kind : 'update'
        const viewId = data.viewId
        if (kind === 'move') {
          if (data.placement !== 'pane') return
          setUserCollapsed(false)
          setDeck((current) => deckFocusReducer(current, { type: 'asked', id: viewId }))
          return
        }
        if (!DRAWING_KINDS.has(kind)) return
        if (data.placement !== 'inline') setDeck((current) => deckFocusReducer(current, { type: 'drawn', id: viewId }))
        setPinned((current) => {
          if (!(viewId in current)) return current
          const { [viewId]: _dropped, ...rest } = current
          return rest
        })
        if (collapsedRef.current) setFresh((count) => count + 1)
        if (workingRef.current) setDrawing((current) => (current.has(viewId) ? current : new Set(current).add(viewId)))
      }),
    [context, session.id]
  )

  useEffect(() => {
    if (!working) setDrawing((current) => (current.size === 0 ? current : new Set()))
  }, [working])

  useEffect(() => {
    if (!collapsed) setFresh(0)
  }, [collapsed])

  useEffect(() => {
    if (planVersion === null) return
    setUserCollapsed(false)
    dispatch({ type: 'asked', id: PLAN })
  }, [planVersion])

  useEffect(() => {
    if (focus === null) return
    setUserCollapsed(false)
    dispatch({ type: 'asked', id: focus.viewId })
    setPinned((current) => {
      const { [focus.viewId]: _dropped, ...rest } = current
      return focus.version === null ? rest : { ...rest, [focus.viewId]: focus.version }
    })
  }, [focus?.nonce])

  const heardNonce = useRef(sentNonce)
  useEffect(() => {
    if (heardNonce.current === sentNonce) return
    heardNonce.current = sentNonce
    dispatch({ type: 'sent' })
  }, [sentNonce])

  useEffect(() => {
    if (deck.focusedId === null && focusedKey !== null) dispatch({ type: 'asked', id: focusedKey })
  }, [deck.focusedId, focusedKey])

  useEffect(() => {
    const before = previousOrder.current
    previousOrder.current = orderedIds
    const id = deck.focusedId
    if (id === null || !before.includes(id) || orderedIds.includes(id)) return
    dispatch({ type: 'removed', id, next: focusAfterRemoval(before, id, orderedIds) })
  }, [orderedIds])

  const onStartDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const host = bodyRef.current
    if (!host) return
    event.preventDefault()
    dragged.current = true
    setDragging(true)
    const move = (moved: MouseEvent) => {
      const rect = host.getBoundingClientRect()
      if (rect.width > 0) setWidth(clampRatio((rect.right - moved.clientX) / rect.width))
    }
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      setDragging(false)
      saveWidth()
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  }

  const onDividerKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    dragged.current = true
    setWidth(clampRatio(ratioRef.current + (event.key === 'ArrowLeft' ? RATIO_STEP : -RATIO_STEP)))
    saveWidth()
  }

  const onShowPanel = () => setUserCollapsed(false)
  const onCollapsePanel = () => setUserCollapsed(true)
  const onPickTab = (id: string) => dispatch({ type: 'picked', id })
  const onCloseTab = (id: string) => {
    context
      .call('quirky.view/close', { viewId: id })
      .then(() => dispatch({ type: 'removed', id, next: focusAfterRemoval(orderedIds, id, orderedIds.filter((other) => other !== id)) }))
      .catch((error) => context.toast('Could not close the visual', messageOf(error)))
  }
  const onReopenTab = (id: string) => {
    context
      .call('quirky.view/reopen', { viewId: id })
      .then(() => dispatch({ type: 'picked', id }))
      .catch((error) => context.toast('Could not reopen the visual', messageOf(error)))
  }

  if (collapsed) {
    return (
      <aside style={rail} aria-label="Visual panel" data-collapsed="true">
        <IconButton label="Show visual panel" onClick={onShowPanel}>
          <ControlIcon name="caret-left" />
        </IconButton>
        {fresh > 0 && <Badge tone="accent">{`${fresh} new`}</Badge>}
      </aside>
    )
  }

  const focusedView = focusedKey === null || focusedKey === PLAN ? undefined : visible.find((view) => view.viewId === focusedKey)
  const nothing = entries.length === 0
  const reopenable = closedEntries.length > 0

  return (
    <>
      <div style={dividerZone} onPointerEnter={() => setDividerHover(true)} onPointerLeave={() => setDividerHover(false)}>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize visual panel"
          aria-valuemin={Math.round(MIN_RATIO * 100)}
          aria-valuemax={Math.round(MAX_RATIO * 100)}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={0}
          data-lit={dividerLit ? 'true' : undefined}
          style={divider}
          onPointerDown={onStartDrag}
          onFocus={(event) => setDividerFocus(focusVisible(event.currentTarget))}
          onBlur={() => setDividerFocus(false)}
          onKeyDown={onDividerKey}
        >
          <span style={dividerLine(dividerLit)} />
        </div>
        <div style={collapseSlot(collapseShown)} data-shown={collapseShown ? 'true' : undefined}>
          <IconButton label="Collapse visual panel" onClick={onCollapsePanel} onFocus={() => setCollapseFocus(true)} onBlur={() => setCollapseFocus(false)}>
            <ControlIcon name="caret-right" />
          </IconButton>
        </div>
      </div>
      <aside style={panel(ratio)} aria-label="Visual panel">
        {nothing && !reopenable ? (
          <header style={header}>
            <h3 style={heading}>Visuals</h3>
          </header>
        ) : (
          <VisualDeckTabs
            label="Visuals"
            entries={entries}
            closed={closedEntries}
            focusedId={focusedKey}
            dots={deck.dots}
            onPick={onPickTab}
            onClose={onCloseTab}
            onReopen={onReopenTab}
          />
        )}
        <div style={scroller}>
          {nothing ? (
            <div style={empty}>
              <EmptyState message="Pictures the agent draws to explain its work, and the plan, show up here." />
              <span style={level}>{`Visual level: ${visualLevelLabel(visualLevel)}`}</span>
            </div>
          ) : focusedKey === PLAN && plan ? (
            <section aria-label="Plan" data-focused="true">
              <PlanPanel context={context} session={session} version={plan.version} isNewest={plan.isNewest} onClose={onClosePlan} />
            </section>
          ) : focusedView ? (
            <section aria-label={focusedView.title} data-visual={focusedView.viewId} data-focused="true" style={card}>
              <Embedded
                context={context}
                viewId={VIEW_RENDER_VIEW}
                input={cardInput(focusedView.viewId, 'panel', { version: pinned[focusedView.viewId], drawing: drawing.has(focusedView.viewId), focused: true })}
                fallback="Visuals are turned off."
              />
            </section>
          ) : null}
        </div>
      </aside>
    </>
  )
}
