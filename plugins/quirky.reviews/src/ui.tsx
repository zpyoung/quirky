import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { Button, InlineError, NoticeLine } from '@quirky/ui'
import '@quirky/ui/styles.css'
import { CHECKS_PANEL, CREATE_VIEW, REVIEW_VIEW, SETTINGS_VIEW, type JsonRecord, type ReviewsState } from './contracts'
import { ReviewPage } from './detail/ReviewPage'
import { ChecksPanel, ChecksAgentDialog } from './checks/ChecksPanel'
import { CreateReview } from './create/CreateReview'
import { HostingSettings } from './create/HostingSettings'
import { ChecksSummary } from './StatusBarItem'
import {
  copyReviewsText,
  listReviewsUiControls,
  registerReviewsUiControl,
  requestOpenSitter,
  requestReviewsUiControl,
  REVIEWS_UI_CONTROL,
  runReviewsUiControl,
  subscribeReviewsUiControls,
  type ReviewsUiControlDescriptor
} from './checks/data'
import { nextDraftTick } from './draft-field'
const SURFACE_IDS: Record<SurfaceKind, string> = {
  detail: REVIEW_VIEW,
  checks: CHECKS_PANEL,
  create: CREATE_VIEW,
  settings: SETTINGS_VIEW
}

function shellControlTarget(kind: SurfaceKind, state: ReviewsState | null, layoutWorktree: string | null): string {
  const rawWorktree = kind === 'detail'
    ? state?.detail.target?.worktree
    : kind === 'checks'
      ? layoutWorktree
      : kind === 'create'
        ? state?.creation.worktree
        : state?.settings.worktree
  const worktree = typeof rawWorktree === 'string' && rawWorktree.trim() !== '' ? rawWorktree : layoutWorktree
  const review = kind === 'detail' ? state?.detail.review : kind === 'checks' && state?.checks.worktree === layoutWorktree ? state?.checks.review : null
  const target = kind === 'detail' ? state?.detail.target : null
  const repositoryValue = review?.prRepo ?? target?.prRepo
  const repository = record(repositoryValue)
    && typeof repositoryValue.host === 'string'
    && typeof repositoryValue.owner === 'string'
    && typeof repositoryValue.repo === 'string'
    ? { host: repositoryValue.host, owner: repositoryValue.owner, repo: repositoryValue.repo }
    : null
  const numberValue = review?.number ?? target?.number
  const number = typeof numberValue === 'number' && Number.isSafeInteger(numberValue) ? numberValue : null
  const headOid = typeof review?.headRefOid === 'string' ? review.headRefOid : null
  return JSON.stringify([SURFACE_IDS[kind], 'shell', worktree, repository, number, headOid, null])
}

function shellUiControls(context: UiPluginContext, kind: SurfaceKind): ReviewsUiControlDescriptor[] {
  return listReviewsUiControls(context, SURFACE_IDS[kind])
}

function Surface({ context, kind, report }: { context: UiPluginContext; kind: SurfaceKind; report?: (state: unknown) => void }) {
  const [loaded, setLoaded] = useState<{ state: ReviewsState; snapshot: number } | null>(null)
  const state = loaded?.state ?? null
  const snapshot = loaded?.snapshot
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const [layoutWorktree, setLayoutWorktree] = useState<string | null>(() => kind === 'checks' ? worktreeOf(context.getLayout()) : null)
  const layoutWorktreeRef = useRef(layoutWorktree)
  layoutWorktreeRef.current = layoutWorktree
  const [controlRevision, setControlRevision] = useState(0)
  const surfaceId = SURFACE_IDS[kind]
  const target = shellControlTarget(kind, state, layoutWorktree)
  const errorRef = useRef(error)
  errorRef.current = error
  const registrationRef = useRef<{ target: string; generation: number; changed(): void; dispose(): void } | null>(null)
  useEffect(() => {
    if (kind !== 'checks') return
    setLayoutWorktree(worktreeOf(context.getLayout()))
    return context.onLayout((layout) => setLayoutWorktree(worktreeOf(layout)))
  }, [context, kind])
  const refresh = useCallback(async () => {
    const epoch = ++request.current
    try {
      const worktree = layoutWorktreeRef.current
      const tick = nextDraftTick()
      const next = stateValue(await context.call('quirky.reviews/state', kind === 'checks' && worktree !== null ? { worktree } : undefined))
      if (epoch !== request.current) return
      setLoaded((old) => old && next.revision < old.state.revision ? old : { state: next, snapshot: tick })
      setError(null)
    } catch (failure) { if (epoch === request.current) setError(failure instanceof Error ? failure.message : 'Review state is unavailable.') }
  }, [context, kind])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    void refresh()
    const options = kind === 'checks'
      ? (layoutWorktree === null ? undefined : { worktreeId: layoutWorktree })
      : { worktreeId: null }
    const offEvent = context.subscribe((event) => { if (event.type === 'quirky.reviews/changed') void refresh() }, options)
    const offConnection = context.onConnection((status) => {
      if (status === 'connected') { request.current++; setLoaded(null); void refresh() }
    })
    return () => { request.current++; offEvent(); offConnection() }
  }, [context, refresh, kind, layoutWorktree])
  useEffect(() => subscribeReviewsUiControls(context, () => setControlRevision((revision) => revision + 1)), [context])
  useEffect(() => {
    const registration = registerReviewsUiControl(context, {
      surface: surfaceId,
      slot: 'shell',
      target,
      actions: () => [{ action: 'retry', enabled: errorRef.current !== null }],
      run: async (control, isCurrent) => {
        if (control.value !== undefined) throw new Error('Retry does not accept command arguments.')
        if (!isCurrent() || errorRef.current === null) return undefined
        await refreshRef.current()
        if (!isCurrent()) return undefined
      }
    })
    registrationRef.current = { target, generation: registration.generation, changed: registration.changed, dispose: registration.dispose }
    return () => {
      if (registrationRef.current?.generation === registration.generation) registrationRef.current = null
      registration.dispose()
    }
  }, [context, surfaceId, target])
  useEffect(() => { registrationRef.current?.changed() }, [error, target])
  useEffect(() => {
    if (!report) return
    const uiControls = shellUiControls(context, kind)
    if (state) report({ ...surfaceSummary(kind, state, error !== null), uiControls })
    else report({
      surface: kind,
      revision: null,
      stateMethod: 'quirky.reviews/state',
      worktree: layoutWorktree,
      loading: error === null,
      errorPresent: error !== null,
      uiControls
    })
  }, [state, kind, report, error, layoutWorktree, context, controlRevision])
  const retryControl = shellUiControls(context, kind).find((control) => control.slot === 'shell' && control.target === target)
  const requestRetry = (descriptor: ReviewsUiControlDescriptor) => {
    const isSameLease = () => registrationRef.current?.target === descriptor.target
      && registrationRef.current.generation === descriptor.generation
    void requestReviewsUiControl(context, {
      target: descriptor.target,
      generation: descriptor.generation,
      action: 'retry'
    }).then((result) => {
      if (result.delivered || !isSameLease()) return
      const message = result.reason === 'disabled'
        ? 'Retry is currently unavailable. Try again when this Reviews surface is ready.'
        : result.reason === 'unknown-action'
          ? 'Retry is no longer supported by this Reviews surface. Reload the surface and try again.'
          : 'The Reviews surface changed before Retry was delivered. Retry from the current surface.'
      setError(message)
    }).catch((failure) => {
      if (isSameLease()) setError(failure instanceof Error ? failure.message : 'Retry could not be delivered to this Reviews window.')
    })
  }
  const retryAction = error !== null && retryControl?.actions.some((action) => action.action === 'retry' && action.enabled)
    ? { label: 'Retry', onAction: () => requestRetry(retryControl) }
    : undefined
  const fail = (failure: unknown) => context.toast('Reviews', failure instanceof Error ? failure.message : 'The action failed.', { kind: 'error' })
  return <section
    className="ui-stack"
    data-review-surface={kind}
    data-review-control-target={retryControl?.target}
    data-review-control-generation={retryControl?.generation}
    style={{ height: '100%', minHeight: 0, overflow: 'auto', padding: 'var(--ui-space-12)' }}
  >
    {kind === 'checks' && state === null && error === null && <NoticeLine>Loading review…</NoticeLine>}
    {kind === 'checks' && error !== null && <InlineError message={error} action={retryAction} />}
    {kind === 'detail' && state === null && error === null && <NoticeLine>Loading review…</NoticeLine>}
    {kind === 'detail' && error !== null && <InlineError message={error} action={retryAction} />}
    {kind === 'create' && state === null && error === null && <NoticeLine>Loading review…</NoticeLine>}
    {kind === 'create' && error !== null && <InlineError message={error} action={retryAction} />}
    {kind === 'settings' && state === null && error === null && <NoticeLine>Loading review…</NoticeLine>}
    {kind === 'settings' && error !== null && <InlineError message={error} action={retryAction} />}
    {kind === 'detail' && state !== null && <ReviewPage context={context} state={state} snapshot={snapshot} refresh={refresh} />}
    {kind === 'checks' && state !== null && <ChecksPanel context={context} state={state} snapshot={snapshot} refresh={refresh} />}
    {kind === 'create' && state !== null && <><Button onClick={() => { void context.call('quirky.reviews/close').catch(fail) }}>Back</Button><CreateReview context={context} state={state} snapshot={snapshot} refresh={refresh} /></>}
    {kind === 'settings' && state !== null && <><Button onClick={() => { void context.call('quirky.reviews/close').catch(fail) }}>Back</Button><HostingSettings context={context} state={state} snapshot={snapshot} refresh={refresh} /></>}
    {state !== null && (kind === 'detail' || kind === 'checks') && state.checks.agentDialog && state.checks.agentDialog.visible !== false && (state.checks.agentDialog.surface ?? 'checks') === kind && <ChecksAgentDialog context={context} state={state} snapshot={snapshot} refresh={refresh} />}
  </section>
}
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

const CHECKS_STATUS_BAR = 'status-bar:quirky.reviews/checks'

function worktreeOf(layout: { worktree?: unknown }): string | null {
  return typeof layout.worktree === 'string' && layout.worktree.trim() !== '' ? layout.worktree : null
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
  context.provide(CHECKS_STATUS_BAR, (element: HTMLElement) => {
    const root = createRoot(element)
    root.render(<ChecksSummary context={context} />)
    return () => root.unmount()
  })
  context.provide(CREATE_VIEW, mount(context, 'create'))
  context.provide(SETTINGS_VIEW, mount(context, 'settings'))
  context.provide(REVIEWS_UI_CONTROL, (input?: unknown) => runReviewsUiControl(context, input))
  context.provide('command:quirky.reviews/show-checks', () => context.call('quirky.reviews/showChecks'))
  context.provide('command:quirky.reviews/open-sitter', async (input?: unknown) => {
    const requestedWorktree = record(input) && typeof input.worktree === 'string' && input.worktree.trim() !== ''
      ? input.worktree
      : worktreeOf(context.getLayout())
    requestOpenSitter(requestedWorktree)
    const openPanels = Object.values(context.getLayout().tools?.open ?? {})
    if (!openPanels.includes(CHECKS_PANEL)) await context.call('quirky.reviews/showChecks')
  })
  context.provide('command:quirky.reviews/arm-sitter', (input?: unknown) =>
    context.call('quirky.reviews/checksSitterArm', record(input) ? input : {}))
  context.provide('command:quirky.reviews/approve-sitter', (input?: unknown) =>
    context.call('quirky.reviews/checksSitterApprove', record(input) ? input : {}))
  context.provide('command:quirky.reviews/stop-sitter', (input?: unknown) =>
    context.call('quirky.reviews/checksSitterStop', record(input) ? input : {}))
  context.provide('command:quirky.reviews/stop-all-sitters', async () => {
    const result = await context.call('quirky.reviews/checksSitterStopAll', {})
    if (record(result) && typeof result.warning === 'string' && result.warning.trim() !== '') throw new Error(result.warning)
    return result
  })
  context.provide('command:quirky.reviews/copy-sitter-debug', async (input?: unknown) => {
    const result = await context.call('quirky.reviews/checksSitterDebugReport', record(input) ? input : {})
    const report = record(result) ? result.report : null
    if (report === null || typeof report !== 'object') throw new Error('The PR Sitter debug report is unavailable.')
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error('Clipboard access is unavailable in this window.')
    }
    const text = JSON.stringify(report, null, 2)
    if (typeof text !== 'string') throw new Error('The PR Sitter debug report could not be serialized.')
    await navigator.clipboard.writeText(text)
    return { copied: true }
  })
  context.provide('command:quirky.reviews/open-review', (input?: unknown) => {
    if (!record(input)) throw new Error('Select a review target.')
    return context.call('quirky.reviews/open', input)
  })
  context.provide('command:quirky.reviews/open-create', (input?: unknown) => {
    const params: JsonRecord = record(input) ? { ...input } : {}
    if (params.worktree === undefined) {
      const selected = context.getLayout().worktree
      if (typeof selected === 'string' && selected.trim() !== '') params.worktree = selected
    }
    if (typeof params.worktree !== 'string' || params.worktree.length === 0) throw new Error('Select a workspace before creating a pull request.')
    return context.call('quirky.reviews/createOpen', params)
  })
  context.provide('command:quirky.reviews/open-settings', (input?: unknown) => context.call('quirky.reviews/settingsOpen', record(input) ? input : {}))
  context.provide('command:quirky.reviews/copy-text', async (input?: unknown) => {
    if (!record(input)) throw new Error('Invalid clipboard text.')
    await copyReviewsText(input.text)
    return { copied: true }
  })
  context.provide('command:quirky.reviews/open-link', async (input?: unknown) => {
    if (!record(input) || typeof input.url !== 'string' || input.url.length > 8192) throw new Error('Select an HTTP(S) review link.')
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Select an HTTP(S) review link without credentials.')
    if (typeof input.worktree !== 'string' || input.worktree.trim() === '' || input.worktree.length > 4096) throw new Error('Select a review workspace before opening its link.')
    const invert = input.invert === true
    return context.call('quirky.browser/openLink', { url: url.href, worktree: input.worktree, modifier: invert, shift: invert })
  })
}
