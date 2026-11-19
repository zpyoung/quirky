import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentCapabilities, CacheTier, Session, StructuredMessage, UiPluginContext, UsageResult, UsageTotals } from '@quirky/protocol'
import { Badge, InlineError, Menu, StatusDot, TextField, type MenuEntry, type UiStatus } from '@quirky/ui'
import { rememberShowAllEvents, SHOW_ALL_EVENTS_COMMAND, WORKTREE_VIEW_ID } from '../model'
import { chatLayoutEntries, DEFAULT_CHAT_LAYOUT, type ChatLayout } from './chatLayout'
import { formatElapsed, newestUserAt, useClock, useTurnStart } from './elapsed'

const SESSION_INFO_COMMAND = 'command:quirky.session-info/open'
const FIVE_MINUTES = 300_000
const AMBER_MS = 60_000

/** Rough widths in length units, used to decide which figures fit; the real layout is not measured per item. */
const TITLE_MIN = 120
const MENU_WIDTH = 40
const PLAN_CHIP_WIDTH = 96
const ROW_PADDING = 16
const ITEM_GAP = 8
const DOT_WIDTH = 16
const CHAR_WIDTH = 7

const row = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ui-space-8)',
  minHeight: 'var(--ui-row-single)',
  minWidth: 0,
  paddingInline: 'var(--ui-space-8)'
} satisfies CSSProperties
const heading = { flex: '1 1 auto', margin: 0, minWidth: 0, color: 'var(--ui-text)', fontSize: 'var(--ui-font-label)', fontWeight: 700 } satisfies CSSProperties
const titleButton = {
  display: 'block',
  maxWidth: '100%',
  padding: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'inherit',
  background: 'none',
  border: 0,
  font: 'inherit',
  cursor: 'text'
} satisfies CSSProperties
const figures = { display: 'flex', alignItems: 'center', flexShrink: 0, gap: 'var(--ui-space-8)', fontSize: 'var(--ui-font-label)', color: 'var(--ui-muted)' } satisfies CSSProperties
const statusLine = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)', color: 'var(--ui-text)', whiteSpace: 'nowrap' } satisfies CSSProperties
const figure = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } satisfies CSSProperties
const frozen = { opacity: 0.5 } satisfies CSSProperties
const amber = { ...figure, color: 'var(--ui-needs-you)' } satisfies CSSProperties

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A token count as "842", "12.4k" or "1.2M". */
export function compactTokens(count: number): string {
  const trimmed = (value: number) => value.toFixed(1).replace(/\.0$/, '')
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${trimmed(count / 1000)}k`
  return `${trimmed(count / 1_000_000)}M`
}

/** "Input 12.4k · Output 9.8k · Cache read 141.2k · Cache write 20.6k · Total 184k". */
export function tokenBreakdown(totals: UsageTotals): string {
  return [
    `Input ${compactTokens(totals.input)}`,
    `Output ${compactTokens(totals.output)}`,
    `Cache read ${compactTokens(totals.cacheRead)}`,
    `Cache write ${compactTokens(totals.cacheWrite)}`,
    `Total ${compactTokens(totals.total)}`
  ].join(' · ')
}

const clock = (leftMs: number) => {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const minutes = (leftMs: number) => `${Math.max(0, Math.ceil(leftMs / 60_000))}m`

export type CacheDisplay =
  | { kind: 'warm'; text: string; amber: boolean; title: string }
  | { kind: 'cold' }

/**
 * What the cache timer shows at `now`: the soonest-expiring warm tier (5-minute as m:ss and amber in
 * its last minute, 1-hour as whole minutes and never amber), "cold" once every tier has expired, and
 * null when the chat has no tiers.
 */
export function cacheDisplay(tiers: readonly CacheTier[] | undefined, now: number): CacheDisplay | null {
  if (!tiers || tiers.length === 0) return null
  const live = tiers
    .map((tier) => ({ tier, left: tier.anchorAt + tier.ttlMs - now }))
    .filter((entry) => entry.left > 0)
    .sort((a, b) => a.left - b.left)
  const next = live[0]
  if (!next) return { kind: 'cold' }
  const short = next.tier.ttlMs === FIVE_MINUTES
  const label = (entry: (typeof live)[number]) => `${entry.tier.ttlMs === FIVE_MINUTES ? '5-minute' : '1-hour'} cache: ${entry.tier.ttlMs === FIVE_MINUTES ? clock(entry.left) : minutes(entry.left)} left`
  return {
    kind: 'warm',
    text: `Cache ${short ? clock(next.left) : minutes(next.left)}`,
    amber: short && next.left <= AMBER_MS,
    title: live.map(label).join(' · ')
  }
}

/** The usage of `sessionId`, loaded on mount and re-queried on each change and each reconnect. */
function useUsage(context: UiPluginContext, sessionId: string): { usage: UsageResult | null; settled: boolean } {
  const [loaded, setLoaded] = useState<{ usage: UsageResult | null; settled: boolean }>({ usage: null, settled: false })
  useEffect(() => {
    let cancelled = false
    let latest = 0
    setLoaded({ usage: null, settled: false })
    const load = () => {
      const attempt = ++latest
      context
        .call('quirky.structured/usage', { session: sessionId })
        .then((result) => {
          if (!cancelled && attempt === latest) setLoaded({ usage: result as UsageResult, settled: true })
        })
        .catch(() => {
          if (!cancelled && attempt === latest) setLoaded((current) => ({ ...current, settled: true }))
        })
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.structured/usageChanged') return
      if ((event.data as { sessionId?: string } | undefined)?.sessionId === sessionId) load()
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
  }, [context, sessionId])
  return loaded
}

/** Whether the daemon connection is down, plus the time it dropped so the figures can freeze there. */
function useOffline(context: UiPluginContext): { offline: boolean; since: number | null } {
  const [since, setSince] = useState<number | null>(null)
  useEffect(() => {
    setSince(null)
    return context.onConnection((status) => setSince(status === 'reconnecting' ? Date.now() : null))
  }, [context])
  return { offline: since !== null, since }
}

/** The row's width in length units, or null until it has layout; follows the row as it resizes. */
function useRowUnits(ref: { current: HTMLElement | null }): number | null {
  const [units, setUnits] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (entries?: ArrayLike<{ contentRect?: { width: number } }>) => {
      const width = entries?.[0]?.contentRect?.width ?? element.getBoundingClientRect().width
      if (!width) return
      const unit = Number.parseFloat(getComputedStyle(element).getPropertyValue('--ui-length-unit'))
      setUnits(width / (Number.isFinite(unit) && unit > 0 ? unit : 1))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => measure(entries))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return units
}

type Shown = { label: boolean; cache: boolean; tokens: boolean }

/** Which figures fit in `units`: tokens go first, then the cache timer, then the status label; the dot stays. */
function fit(units: number | null, chip: boolean, widths: { label: number; cache: number; tokens: number }): Shown {
  const shown = { label: true, cache: widths.cache > 0, tokens: widths.tokens > 0 }
  if (units === null) return shown
  const room = units - TITLE_MIN - MENU_WIDTH - ROW_PADDING - (chip ? PLAN_CHIP_WIDTH + ITEM_GAP : 0)
  const need = () =>
    DOT_WIDTH +
    (shown.label ? ITEM_GAP + widths.label : 0) +
    (shown.cache ? ITEM_GAP + widths.cache : 0) +
    (shown.tokens ? ITEM_GAP + widths.tokens : 0)
  if (shown.tokens && need() > room) shown.tokens = false
  if (shown.cache && need() > room) shown.cache = false
  if (shown.label && need() > room) shown.label = false
  return shown
}

type Status = { ui: UiStatus; label: string; announced: string }

/**
 * The row above a native chat's transcript: title (click to rename), plan chip, status, session
 * tokens, cache timer and the ⋯ menu with Rename, Fork chat, Session info, Show all events and the
 * chat width and alignment picks for `layout`. It is a normal flex row, so it never covers the
 * transcript. Figures a narrow pane cannot hold move to the top of the menu, and an offline
 * connection freezes and dims them.
 */
export function ChatHeader({
  context,
  session,
  capabilities,
  messages,
  showAll,
  layout = DEFAULT_CHAT_LAYOUT,
  planChip
}: {
  context: UiPluginContext
  session: Session
  capabilities: AgentCapabilities | null
  /** Every loaded message, oldest first; decides crashed versus ended and when the running turn began. */
  messages: readonly StructuredMessage[]
  showAll: boolean
  layout?: ChatLayout
  planChip?: ReactNode
}) {
  const { usage, settled } = useUsage(context, session.id)
  const working = session.status === 'working'
  const waiting = session.status === 'waiting'
  const exited = session.status === 'exited'
  const startedAt = useTurnStart(working, newestUserAt(messages))
  const tiers = usage?.cache?.tiers
  const ticking = working || (tiers !== undefined && tiers.some((tier) => tier.anchorAt + tier.ttlMs > Date.now()))
  const { offline, since } = useOffline(context)
  const now = useClock(ticking && !offline)
  const shownNow = offline && since !== null ? since : now

  const crashed = useMemo(() => {
    if (!exited) return false
    let lastUser = -1
    let lastError = -1
    messages.forEach((message, index) => {
      if (message.role === 'user' || message.item?.kind === 'user') lastUser = index
      if (message.item?.kind === 'error') lastError = index
    })
    return lastError > lastUser
  }, [exited, messages])

  const turns = usage?.turns ?? 0
  const ready = !exited && turns === 0
  const status: Status = offline
    ? { ui: 'needs-you', label: 'Reconnecting…', announced: 'Reconnecting…' }
    : exited
      ? crashed
        ? { ui: 'failing', label: 'Stopped unexpectedly', announced: 'Stopped unexpectedly' }
        : { ui: 'idle', label: 'Ended', announced: 'Ended' }
      : working
        ? { ui: 'working', label: `Working · ${formatElapsed(shownNow - (startedAt ?? shownNow))}`, announced: 'Working' }
        : waiting
          ? { ui: 'needs-you', label: 'Waiting on you', announced: 'Waiting on you' }
          : ready
            ? { ui: 'idle', label: 'Ready', announced: 'Ready' }
            : { ui: 'done', label: 'Done', announced: 'Done' }

  const conversation = usage?.conversation ?? null
  const tokensText = conversation !== null && turns >= 1 && conversation.total > 0 ? `${compactTokens(conversation.total)} tokens` : null
  const cache = working ? null : cacheDisplay(tiers, shownNow)
  const cacheText = cache === null ? null : cache.kind === 'cold' ? 'Cache cold' : cache.text

  const rowRef = useRef<HTMLElement | null>(null)
  const units = useRowUnits(rowRef)
  const shown = fit(units, planChip !== undefined && planChip !== null && planChip !== false, {
    label: status.label.length * CHAR_WIDTH,
    cache: (cacheText?.length ?? 0) * CHAR_WIDTH,
    tokens: (tokensText?.length ?? 0) * CHAR_WIDTH
  })
  const dropped = [!shown.tokens ? tokensText : null, !shown.cache ? cacheText : null].filter((text): text is string => text !== null)

  const cacheMode = cache === null ? null : cache.kind === 'cold' ? 'cold' : cache.amber ? 'amber' : null
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef<{ label: string; cache: typeof cacheMode } | null>(null)
  useEffect(() => {
    if (!settled) {
      previous.current = null
      return
    }
    if (previous.current === null) {
      previous.current = { label: status.announced, cache: cacheMode }
      return
    }
    const parts: string[] = []
    if (previous.current.label !== status.announced) parts.push(status.announced)
    if (previous.current.cache !== cacheMode) {
      if (cacheMode === 'amber') parts.push('Cache expires in under a minute')
      if (cacheMode === 'cold') parts.push('Cache cold')
    }
    previous.current = { label: status.announced, cache: cacheMode }
    if (parts.length > 0) setAnnouncement(parts.join('. '))
  }, [settled, status.announced, cacheMode])

  const [forkError, setForkError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [renameError, setRenameError] = useState<string | undefined>()
  const [savedTitle, setSavedTitle] = useState<string | null>(null)
  const saving = useRef(false)
  const cancelled = useRef(false)
  const input = useRef<HTMLInputElement | null>(null)
  const title = savedTitle ?? session.title
  useEffect(() => {
    setSavedTitle(null)
  }, [session.id, session.title])
  useEffect(() => {
    setEditing(false)
    setRenameError(undefined)
    setForkError(null)
  }, [session.id])
  useEffect(() => {
    if (!editing) return
    cancelled.current = false
    setRenameError(undefined)
    input.current?.focus()
    input.current?.select()
  }, [editing])

  const onRename = () => setEditing(true)
  const closeRename = () => {
    setEditing(false)
    setRenameError(undefined)
  }
  const saveRename = async () => {
    if (cancelled.current || saving.current) return
    const next = (input.current?.value ?? '').trim()
    if (next === '' || next === title) {
      closeRename()
      return
    }
    saving.current = true
    try {
      const saved = (await context.call('quirky.session/setTitle', { session: session.id, title: next })) as Session | undefined
      setSavedTitle(saved?.title ?? next)
      closeRename()
    } catch (error) {
      setRenameError(messageOf(error))
    } finally {
      saving.current = false
    }
  }

  const fork = async () => {
    setForkError(null)
    try {
      const forked = (await context.call('quirky.structured/fork', { session: session.id })) as Session
      context.openView(WORKTREE_VIEW_ID, { worktree: forked.worktreeId, session: forked.id })
    } catch (error) {
      setForkError(messageOf(error))
    }
  }

  const forkReason = offline
    ? 'Reconnecting…'
    : working || waiting
      ? 'Available when the turn ends'
      : capabilities !== null && !capabilities.fork.ok
        ? capabilities.fork.reason
        : undefined
  const droppedText = dropped.join(' · ')
  const items = useMemo<MenuEntry[]>(
    () => [
      ...(droppedText === '' ? [] : ([{ kind: 'note', id: 'dropped', label: droppedText }, { kind: 'separator', id: 'dropped-rule' }] as MenuEntry[])),
      { id: 'rename', label: 'Rename', disabled: offline, ...(offline ? { description: 'Reconnecting…' } : {}), onAction: onRename },
      { id: 'fork', label: 'Fork chat', disabled: forkReason !== undefined, ...(forkReason === undefined ? {} : { description: forkReason }), onAction: () => void fork() },
      { id: 'info', label: 'Session info', onAction: () => void context.executeCommand(SESSION_INFO_COMMAND, { session: session.id }) },
      { kind: 'separator', id: 'rule' },
      {
        id: 'show-all',
        label: 'Show all events',
        checked: showAll,
        onAction: () => {
          rememberShowAllEvents(session, !showAll)
          void context.executeCommand(SHOW_ALL_EVENTS_COMMAND, { session: session.id, enabled: !showAll }, { activateOwner: false })
        }
      },
      { kind: 'separator', id: 'layout-rule' },
      ...chatLayoutEntries(context, layout)
    ],
    [droppedText, offline, forkReason, showAll, layout, context, session, title]
  )

  return (
    <>
      <header ref={rowRef} style={row}>
        <h2 style={heading}>
          {editing ? (
            <TextField
              ref={input}
              label="Chat title"
              hideLabel
              defaultValue={title}
              maxLength={200}
              help="Enter to save · Esc to cancel"
              error={renameError}
              onBlur={() => void saveRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void saveRename()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelled.current = true
                  closeRename()
                }
              }}
            />
          ) : (
            <button type="button" style={titleButton} aria-label={`Rename chat: ${title}`} disabled={offline} onClick={onRename}>
              {title}
            </button>
          )}
        </h2>
        {planChip}
        <div style={figures}>
          <span style={{ ...statusLine, ...(offline ? frozen : {}) }} title={shown.label ? undefined : status.label}>
            <StatusDot status={status.ui} label={shown.label ? undefined : status.label} />
            {shown.label && <span>{status.label}</span>}
          </span>
          {shown.tokens && tokensText !== null && conversation !== null && (
            <span style={{ ...figure, ...(offline ? frozen : {}) }} title={tokenBreakdown(conversation)}>
              {tokensText}
            </span>
          )}
          {shown.cache && cache !== null && (
            <span
              style={{ ...(cache.kind === 'warm' && cache.amber ? amber : figure), ...(offline ? frozen : {}) }}
              title={cache.kind === 'warm' ? cache.title : 'The prompt cache has expired'}
            >
              {cache.kind === 'cold' ? <Badge label="Cache cold">Cache cold</Badge> : cache.text}
            </span>
          )}
          <Menu label="More actions" trigger="⋯" align="end" items={items} />
        </div>
      </header>
      {forkError !== null && <InlineError message={`Could not fork: ${forkError}`} action={{ label: 'Retry', onAction: () => void fork() }} />}
      <div className="ui-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </>
  )
}
