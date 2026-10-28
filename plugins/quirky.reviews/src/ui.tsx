import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { CHECKS_PANEL, CREATE_VIEW, REVIEW_VIEW, SETTINGS_VIEW, type JsonRecord, type ReviewsState } from './contracts'
import { ReviewPage } from './detail/ReviewPage'
import { ChecksPanel, ChecksAgentDialog } from './checks/ChecksPanel'
import { CreateReview } from './create/CreateReview'
import { HostingSettings } from './create/HostingSettings'
import './reviews.css'

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
  for (const section of [detail, checks]) if (!Array.isArray(section.expandedChecks) || !Array.isArray(section.queuedComments) || typeof section.commentDraft !== 'string' || typeof section.fetchedAt !== 'number') throw new Error('The daemon returned invalid review controls.')
  if (!Array.isArray(detail.pending) || !Array.isArray(detail.collapsedFiles) || typeof detail.fileFilter !== 'string' || typeof detail.fileTreeVisible !== 'boolean' || typeof checks.height !== 'number' || !Array.isArray(creation.bases) || typeof creation.title !== 'string' || typeof creation.body !== 'string' || typeof creation.base !== 'string' || typeof creation.head !== 'string' || typeof creation.generating !== 'boolean' || typeof creation.submitting !== 'boolean') throw new Error('The daemon returned invalid review content.')
  for (const key of ['draft', 'useTemplate', 'generateDetailsOnOpen', 'openAfterCreate']) if (typeof raw.defaults[key] !== 'boolean') throw new Error('The daemon returned invalid review defaults.')
  // The authenticated daemon owns the remaining opaque provider records; each feature validates its own wire data.
  const state = raw as unknown as ReviewsState
  return state
}

function Surface({ context, kind, report }: { context: UiPluginContext; kind: 'detail' | 'checks' | 'create' | 'settings'; report?: (state: unknown) => void }) {
  const [state, setState] = useState<ReviewsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const next = stateValue(await context.call('quirky.reviews/state'))
      setState((old) => !old || next.revision >= old.revision ? next : old)
      setError(null)
      report?.({ surface: kind, state: next })
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Review state is unavailable.') }
  }, [context, kind, report])
  useEffect(() => {
    void refresh()
    const offEvent = context.subscribe((event) => { if (event.type === 'quirky.reviews/changed') void refresh() })
    const offConnection = context.onConnection((status) => { if (status === 'connected') void refresh() })
    return () => { offEvent(); offConnection() }
  }, [context, refresh])
  const fail = (failure: unknown) => context.toast('Reviews', failure instanceof Error ? failure.message : 'The action failed.', { kind: 'error' })
  return <section className="reviews-surface" data-review-surface={kind}>
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

function mount(context: UiPluginContext, kind: 'detail' | 'checks' | 'create' | 'settings'): MountFunction {
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
