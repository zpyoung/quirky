import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { AgentCapabilities, AgentKey, Session, UiPluginContext, VisualLevel } from '@quirky/protocol'
import { Badge, ControlIcon, EmptyState, IconButton } from '@quirky/ui'
import { AgentsCard } from './AgentsCard'
import { listedAgents, type AgentView } from './agents'
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
  version?: number
  latestVersion?: number
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
const CARD_MIN_UNITS = 300
const GAP_UNITS = 12

const DRAWING_KINDS = new Set(['open', 'update', 'patch'])

const PLAN = 'plan'
const AGENTS = 'agents'

/** What the panel needs to show the Agents card: the chat's agents, the one to select, and a counter that bumps on each request to focus the card. */
export type AgentsFocus = { views: Map<AgentKey, AgentView>; selected: AgentKey | null; nonce: number }

const readRecords = (loaded: unknown): VisualRecord[] =>
  (Array.isArray(loaded) ? (loaded as Partial<VisualRecord>[]) : []).flatMap((record) =>
    typeof record.viewId === 'string'
      ? [{
          viewId: record.viewId,
          title: typeof record.title === 'string' ? record.title : 'Visual',
          placement: record.placement === 'inline' ? ('inline' as const) : ('pane' as const),
          closed: record.closed === true,
          ...(typeof record.version === 'number' ? { version: record.version } : {}),
          ...(typeof record.latestVersion === 'number' ? { latestVersion: record.latestVersion } : {})
        }]
      : []
  )

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

const divider = {
  flex: '0 0 auto',
  alignSelf: 'stretch',
  width: 'var(--ui-space-4)',
  cursor: 'col-resize',
  touchAction: 'none',
  background: 'var(--ui-transparent)',
  borderInlineStart: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const dividerActive = { ...divider, borderInlineStart: 'var(--ui-border-width) solid var(--ui-accent)' } satisfies CSSProperties
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
const grid = {
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(calc(${CARD_MIN_UNITS} * var(--ui-length-unit)), 1fr))`,
  gap: 'var(--ui-space-8)',
  alignItems: 'start'
} satisfies CSSProperties
const planCell = { gridColumn: '1 / -1', minWidth: 0 } satisfies CSSProperties
const stack = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)', minWidth: 0 } satisfies CSSProperties
const strip = { display: 'flex', gap: 'var(--ui-space-6)', overflowX: 'auto', paddingBlockEnd: 'var(--ui-space-6)' } satisfies CSSProperties
const tile = (focused: boolean): CSSProperties => ({
  display: 'flex',
  flex: '0 0 calc(120 * var(--ui-length-unit))',
  flexDirection: 'column',
  gap: 'var(--ui-space-2)',
  minWidth: 0,
  padding: 'var(--ui-space-4)',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)',
  border: `var(--ui-border-width) solid ${focused ? 'var(--ui-accent)' : 'var(--ui-border)'}`,
  borderRadius: 'var(--ui-radius-window)',
  font: 'inherit',
  fontSize: 'var(--ui-font-label)',
  textAlign: 'start',
  cursor: 'pointer'
})
const tileName = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } satisfies CSSProperties
const tilePreview = { maxHeight: 'calc(72 * var(--ui-length-unit))', overflow: 'hidden', pointerEvents: 'none' } satisfies CSSProperties
const card = (focused: boolean): CSSProperties => ({
  minWidth: 0,
  overflow: 'hidden',
  background: 'var(--ui-surface)',
  border: `var(--ui-border-width) solid ${focused ? 'var(--ui-accent)' : 'var(--ui-border)'}`,
  borderRadius: 'var(--ui-radius-window)'
})
const agentsBody = { padding: 'var(--ui-space-8)' } satisfies CSSProperties
const empty = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--ui-space-8)', padding: 'var(--ui-space-16)' } satisfies CSSProperties
const level = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties

/** The input that mounts a view's card in the panel: `surface` and, only when set, the version it is pinned to and its flags. */
function cardInput(viewId: string, surface: 'panel' | 'thumbnail', options: { version?: number; drawing?: boolean; focused?: boolean } = {}) {
  return {
    viewId,
    ...(options.version === undefined ? {} : { version: options.version }),
    surface,
    ...(options.drawing === true ? { drawing: true } : {}),
    ...(options.focused === true ? { focused: true } : {})
  }
}

/**
 * The docked panel beside a chat's transcript: the plan first when one is open, then the visuals the
 * agent placed in the pane. A panel wide enough for two cards lays them out in a grid; a narrower one
 * shows the focused card with a filmstrip above it. The newest visual drawn takes focus, a card is
 * `drawing` while the session works on it, and the panel starts collapsed in a narrow chat. Collapsed it
 * is a rail counting what was drawn since. Dragging the divider sets the width, which is remembered
 * across chats through `quirky.session/setUiPref`. `focus` asks the panel to show one visual at one
 * version, as when a message chip is clicked. Once the chat has an agent, `agents` adds the Agents card
 * after the plan, and a new `agents.nonce` opens the panel on it with `agents.selected` chosen.
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
  agents = null,
  capabilities = null,
  now = 0
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
  /** The chat's agents, or null until it has one. */
  agents?: AgentsFocus | null
  capabilities?: AgentCapabilities | null
  /** The time agents' elapsed figures count to. */
  now?: number
}) {
  const [ratio, setRatio] = useState(DEFAULT_RATIO)
  const [dragging, setDragging] = useState(false)
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [pinned, setPinned] = useState<Record<string, number>>({})
  const [drawing, setDrawing] = useState<ReadonlySet<string>>(new Set())
  const [fresh, setFresh] = useState(0)
  const [agentSelected, setAgentSelected] = useState<AgentKey | null>(null)
  const ratioRef = useRef(ratio)
  const dragged = useRef(false)
  const workingRef = useRef(working)
  workingRef.current = working
  const body = useRef<HTMLDivElement>(null)

  const narrow = bodyWidth > 0 && bodyWidth < COLLAPSE_BELOW_UNITS * unit
  const collapsed = userCollapsed ?? narrow
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  const visible = useMemo(() => views.filter((view) => view.placement === 'pane' && !view.closed), [views])
  const panelWidth = bodyWidth > 0 ? Math.max(PANEL_MIN_UNITS * unit, Math.min(ratio * bodyWidth, bodyWidth - TRANSCRIPT_MIN_UNITS * unit)) : 0
  const wide = panelWidth >= (2 * CARD_MIN_UNITS + GAP_UNITS) * unit

  const setWidth = (next: number) => {
    ratioRef.current = next
    setRatio(next)
  }
  const saveWidth = () => {
    context.call('quirky.session/setUiPref', { key: WIDTH_RATIO_KEY, value: Math.round(ratioRef.current * 1000) / 1000 }).catch(() => {})
  }

  useEffect(() => {
    setUserCollapsed(null)
    setFocusedId(null)
    setPinned({})
    setDrawing(new Set())
    setFresh(0)
    setAgentSelected(null)
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
        const data = event.data as { sessionId?: string; viewId?: unknown; kind?: unknown } | undefined
        if (data?.sessionId !== undefined && data.sessionId !== session.id) return
        if (typeof data?.viewId !== 'string') return
        const kind = typeof data.kind === 'string' ? data.kind : 'update'
        if (!DRAWING_KINDS.has(kind)) return
        const viewId = data.viewId
        setFocusedId(viewId)
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

  const planVersion = plan?.version.version ?? null
  useEffect(() => {
    if (planVersion === null) return
    setUserCollapsed(false)
    setFocusedId(PLAN)
  }, [planVersion])

  useEffect(() => {
    if (agents === null || agents.nonce === 0) return
    setUserCollapsed(false)
    setFocusedId(AGENTS)
    setAgentSelected(agents.selected)
  }, [agents?.nonce])

  useEffect(() => {
    if (focus === null) return
    setUserCollapsed(false)
    setFocusedId(focus.viewId)
    setPinned((current) => {
      const { [focus.viewId]: _dropped, ...rest } = current
      return focus.version === null ? rest : { ...rest, [focus.viewId]: focus.version }
    })
  }, [focus?.nonce])

  const agentCount = agents === null ? 0 : listedAgents(agents.views).length
  const hasAgents = agents !== null && agentCount > 0
  const focusedKey =
    focusedId === PLAN && plan !== null ? PLAN
    : focusedId === AGENTS && hasAgents ? AGENTS
    : focusedId !== null && visible.some((view) => view.viewId === focusedId) ? focusedId
    : (visible.at(-1)?.viewId ?? (plan !== null ? PLAN : hasAgents ? AGENTS : null))

  useEffect(() => {
    if (!wide || focusedKey === null) return
    const target = [...(body.current?.querySelectorAll<HTMLElement>('[data-focused="true"]') ?? [])][0]
    if (typeof target?.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
  }, [wide, focusedKey, collapsed])

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
  const onFocusCard = (key: string) => setFocusedId(key)
  const onSelectAgent = (id: AgentKey) => setAgentSelected(id)

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

  const recordOf = (viewId: string) => visible.find((view) => view.viewId === viewId)
  const planCard = plan && (
    <section aria-label="Plan" data-focused={focusedKey === PLAN || undefined}>
      <PlanPanel context={context} session={session} version={plan.version} isNewest={plan.isNewest} onClose={onClosePlan} />
    </section>
  )
  const agentsCard = hasAgents && agents && (
    <section aria-label="Agents" data-focused={focusedKey === AGENTS || undefined} style={card(focusedKey === AGENTS)}>
      <div style={agentsBody}>
        <AgentsCard context={context} session={session} capabilities={capabilities} agents={agents.views} selected={agentSelected} now={now} onSelect={onSelectAgent} />
      </div>
    </section>
  )
  const visualCard = (view: VisualRecord) => {
    const focused = focusedKey === view.viewId
    return (
      <section key={view.viewId} aria-label={view.title} data-visual={view.viewId} data-focused={focused || undefined} style={card(focused)}>
        <Embedded
          context={context}
          viewId={VIEW_RENDER_VIEW}
          input={cardInput(view.viewId, 'panel', { version: pinned[view.viewId], drawing: drawing.has(view.viewId), focused })}
          fallback="Visuals are turned off."
        />
      </section>
    )
  }

  const nothing = plan === null && visible.length === 0 && !hasAgents
  const focusedView = focusedKey === null || focusedKey === PLAN ? undefined : recordOf(focusedKey)

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize visual panel"
        aria-valuemin={Math.round(MIN_RATIO * 100)}
        aria-valuemax={Math.round(MAX_RATIO * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        style={dragging ? dividerActive : divider}
        onPointerDown={onStartDrag}
        onKeyDown={onDividerKey}
      />
      <aside style={panel(ratio)} aria-label="Visual panel">
        <header style={header}>
          <h3 style={heading}>Visuals</h3>
          <IconButton label="Collapse visual panel" onClick={onCollapsePanel}>
            <ControlIcon name="caret-right" />
          </IconButton>
        </header>
        <div ref={body} style={scroller}>
          {nothing ? (
            <div style={empty}>
              <EmptyState message="Pictures the agent draws to explain its work, and the plan, show up here." />
              <span style={level}>{`Visual level: ${visualLevelLabel(visualLevel)}`}</span>
            </div>
          ) : wide ? (
            <div style={grid}>
              {planCard && <div style={planCell}>{planCard}</div>}
              {agentsCard && <div style={planCell}>{agentsCard}</div>}
              {visible.map(visualCard)}
            </div>
          ) : (
            <div style={stack}>
              <div style={strip} role="tablist" aria-label="Visuals">
                {plan && (
                  <button type="button" role="tab" aria-selected={focusedKey === PLAN} style={tile(focusedKey === PLAN)} onClick={() => onFocusCard(PLAN)}>
                    <span style={tileName}>{`Plan v${plan.version.version}`}</span>
                  </button>
                )}
                {hasAgents && (
                  <button type="button" role="tab" aria-selected={focusedKey === AGENTS} style={tile(focusedKey === AGENTS)} onClick={() => onFocusCard(AGENTS)}>
                    <span style={tileName}>{`Agents ${agentCount}`}</span>
                  </button>
                )}
                {visible.map((view) => (
                  <button key={view.viewId} type="button" role="tab" aria-selected={focusedKey === view.viewId} aria-label={view.title} style={tile(focusedKey === view.viewId)} onClick={() => onFocusCard(view.viewId)}>
                    <span style={tilePreview}>
                      <Embedded context={context} viewId={VIEW_RENDER_VIEW} input={cardInput(view.viewId, 'thumbnail')} fallback="" />
                    </span>
                    <span style={tileName}>{view.title}</span>
                  </button>
                ))}
              </div>
              {focusedKey === PLAN ? planCard : focusedKey === AGENTS ? agentsCard : focusedView ? visualCard(focusedView) : null}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
