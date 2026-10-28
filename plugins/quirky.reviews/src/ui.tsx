import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { CHECKS_PANEL, CREATE_VIEW, REVIEW_VIEW, SETTINGS_VIEW, type JsonRecord, type ReviewsState } from './contracts'
import { ReviewPage } from './detail/ReviewPage'
import { ChecksPanel, ChecksAgentDialog } from './checks/ChecksPanel'
import { CreateReview } from './create/CreateReview'
import { HostingSettings } from './create/HostingSettings'
import { REVIEWS_STYLE } from './style'

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stateValue(raw: unknown): ReviewsState {
  if (!record(raw) || typeof raw.revision !== 'number' || !record(raw.detail) || !record(raw.checks) || !record(raw.creation) || !record(raw.settings) || !record(raw.defaults) || !record(raw.repoDefaults) || !record(raw.links) || !record(raw.suppressed) || !Array.isArray(raw.botOverrides)) throw new Error('The daemon returned invalid review state.')
  const detail = raw.detail
  const checks = raw.checks
  const creation = raw.creation
  for (const section of [detail, checks, creation, raw.settings]) if (typeof section.generation !== 'number' || typeof section.loading !== 'boolean' || (section.error !== null && typeof section.error !== 'string')) throw new Error('The daemon returned invalid review request state.')
  if (!['conversation', 'checks', 'files'].includes(String(detail.tab)) || !['all', 'humans', 'bots'].includes(String(detail.audience)) || !['all', 'humans', 'bots'].includes(String(checks.audience))) throw new Error('The daemon returned invalid review navigation.')
  for (const section of [detail, checks]) if (!Array.isArray(section.expandedChecks) || !Array.isArray(section.queuedComments) || typeof section.checksCollapsed !== 'boolean' || typeof section.commentDraft !== 'string' || typeof section.fetchedAt !== 'number') throw new Error('The daemon returned invalid review controls.')
  if (!Array.isArray(detail.pending) || !Array.isArray(detail.collapsedFiles) || typeof detail.fileFilter !== 'string' || typeof detail.fileTreeVisible !== 'boolean' || typeof checks.height !== 'number' || !Array.isArray(creation.bases) || typeof creation.title !== 'string' || typeof creation.body !== 'string' || typeof creation.base !== 'string' || typeof creation.head !== 'string' || typeof creation.generating !== 'boolean' || typeof creation.submitting !== 'boolean') throw new Error('The daemon returned invalid review content.')
  for (const key of ['draft', 'useTemplate', 'generateDetailsOnOpen', 'openAfterCreate']) if (typeof raw.defaults[key] !== 'boolean') throw new Error('The daemon returned invalid review defaults.')
  // The authenticated daemon owns the remaining opaque provider records; each feature validates its own wire data.
  const state = raw as unknown as ReviewsState
  return state
}

type SurfaceKind = 'detail' | 'checks' | 'create' | 'settings'

function itemCount(value: JsonRecord | null, key: string): number | null {
  const items = value?.[key]
  return Array.isArray(items) ? items.length : null
}

/** Slot reports have a 64-KiB bound; full bodies and provider records stay in reviews/state. */
function surfaceSummary(kind: SurfaceKind, state: ReviewsState, connectionError: boolean) {
  const current = kind === 'detail' ? state.detail : kind === 'checks' ? state.checks : kind === 'create' ? state.creation : state.settings
  const review = kind === 'detail' ? state.detail.review : kind === 'checks' ? state.checks.review : null
  return {
    surface: kind, revision: state.revision, stateMethod: 'quirky.reviews/state',
    worktree: kind === 'detail' ? state.detail.target?.worktree ?? null : kind === 'checks' ? state.checks.worktree : kind === 'create' ? state.creation.worktree : state.settings.worktree,
    number: review?.number ?? null, reviewState: review?.state ?? null,
    loading: current.loading, errorPresent: connectionError || current.error !== null,
    tab: kind === 'detail' ? state.detail.tab : null,
    audience: kind === 'detail' ? state.detail.audience : kind === 'checks' ? state.checks.audience : null,
    grouping: kind === 'detail' ? state.detail.grouping : kind === 'checks' ? state.checks.grouping : null,
    checksCount: kind === 'detail' ? itemCount(state.detail.checks, 'checks') : kind === 'checks' ? itemCount(state.checks.checks, 'checks') : null,
    checksCollapsed: kind === 'detail' ? state.detail.checksCollapsed : kind === 'checks' ? state.checks.checksCollapsed : null,
    commentsCount: kind === 'detail' ? itemCount(state.detail.comments, 'comments') : kind === 'checks' ? itemCount(state.checks.comments, 'comments') : null,
    filesCount: kind === 'detail' ? itemCount(state.detail.files, 'files') : null,
    queuedCommentsCount: kind === 'detail' ? state.detail.queuedComments.length : kind === 'checks' ? state.checks.queuedComments.length : null,
    generating: kind === 'create' ? state.creation.generating : null,
    submitting: kind === 'create' ? state.creation.submitting : null
  }
}

function Surface({ context, kind, report }: { context: UiPluginContext; kind: SurfaceKind; report?: (state: unknown) => void }) {
  const [state, setState] = useState<ReviewsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const epoch = ++request.current
    try {
      const next = stateValue(await context.call('quirky.reviews/state'))
      if (epoch !== request.current) return
      setState((old) => !old || next.revision >= old.revision ? next : old)
      setError(null)
    } catch (failure) { if (epoch === request.current) setError(failure instanceof Error ? failure.message : 'Review state is unavailable.') }
  }, [context])
  useEffect(() => {
    void refresh()
    const offEvent = context.subscribe((event) => { if (event.type === 'quirky.reviews/changed') void refresh() })
    const offConnection = context.onConnection((status) => {
      if (status === 'connected') { request.current++; setState(null); void refresh() }
    })
    return () => { request.current++; offEvent(); offConnection() }
  }, [context, refresh])
  useEffect(() => { if (state && report) report(surfaceSummary(kind, state, error !== null)) }, [state, kind, report, error])
  const fail = (failure: unknown) => context.toast('Reviews', failure instanceof Error ? failure.message : 'The action failed.', { kind: 'error' })
  return <section className="reviews-surface" data-review-surface={kind}>
    <style>{REVIEWS_STYLE}</style>
    {error && <div role="alert">{error}<button onClick={() => { void refresh() }}>Retry</button></div>}
    {!state ? <p role="status">Loading review…</p> : <>
      {kind === 'detail' && <ReviewPage context={context} state={state} refresh={refresh} />}
      {kind === 'checks' && <ChecksPanel context={context} state={state} refresh={refresh} />}
      {kind === 'create' && <><button onClick={() => { void context.call('quirky.reviews/close').catch(fail) }}>Back</button><CreateReview context={context} state={state} refresh={refresh} /></>}
      {kind === 'settings' && <><button onClick={() => { void context.call('quirky.reviews/close').catch(fail) }}>Back</button><HostingSettings context={context} state={state} refresh={refresh} /></>}
      {(kind === 'detail' || kind === 'checks') && state.checks.agentDialog && state.checks.agentDialog.visible !== false && (state.checks.agentDialog.surface ?? 'checks') === kind && <ChecksAgentDialog context={context} state={state} refresh={refresh} />}
    </>}
  </section>
}

function mount(context: UiPluginContext, kind: SurfaceKind): MountFunction {
  return (element, props) => {
    const root = createRoot(element)
    root.render(<Surface context={context} kind={kind} report={props.report} />)
    return () => root.unmount()
  }
}

export function activate(context: UiPluginContext): void {
  context.provide(REVIEW_VIEW, mount(context, 'detail'))
  context.provide(CHECKS_PANEL, mount(context, 'checks'))
  context.provide(CREATE_VIEW, mount(context, 'create'))
  context.provide(SETTINGS_VIEW, mount(context, 'settings'))
  context.provide('command:quirky.reviews/show-checks', () => context.call('quirky.reviews/showChecks'))
  context.provide('command:quirky.reviews/open-review', (input?: unknown) => {
    if (!record(input)) throw new Error('Select a review target.')
    return context.call('quirky.reviews/open', input)
  })
  context.provide('command:quirky.reviews/open-create', (input?: unknown) => {
    const params: JsonRecord = record(input) ? { ...input } : {}
    if (params.worktree === undefined) {
      const active = context.getLayout().view?.input
      if (record(active) && typeof active.worktree === 'string') params.worktree = active.worktree
    }
    if (typeof params.worktree !== 'string' || params.worktree.length === 0) throw new Error('Select a workspace before creating a pull request.')
    return context.call('quirky.reviews/createOpen', params)
  })
  context.provide('command:quirky.reviews/open-settings', (input?: unknown) => context.call('quirky.reviews/settingsOpen', record(input) ? input : {}))
  context.provide('command:quirky.reviews/copy-text', async (input?: unknown) => {
    if (!record(input) || typeof input.text !== 'string' || input.text.length > 1_048_576) throw new Error('Invalid clipboard text.')
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this window.')
    await navigator.clipboard.writeText(input.text)
    return { copied: true }
  })
  context.provide('command:quirky.reviews/open-link', async (input?: unknown) => {
    if (!record(input) || typeof input.url !== 'string') throw new Error('Select an HTTP(S) review link.')
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Select an HTTP(S) review link without credentials.')
    const inApp = context.getSetting('quirky.browser/openLinksInApp') === true
    if (inApp !== (input.invert === true)) throw new Error('In-app link routing requires the browser-pane feature; this review stays selected. Open the system link without the inversion modifier.')
    await context.call('quirky.terminal/openExternal', { target: url.href })
    return { opened: true, destination: 'system' }
  })
}
