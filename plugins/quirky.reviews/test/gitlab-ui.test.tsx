import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { CHORD_PLATFORM, type UiLayout, type UiPluginContext } from '@quirky/protocol'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { discoverCandidates, discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'
import { parseCoverage, resolveRef, selectCandidate } from '../../../scripts/ui-scoreboard/audit-evidence'
import { auditPlugin } from '../../../scripts/ui-scoreboard/audit'
import type { Candidate, CoverageFile, Inventory, PluginInventory, Ref } from '../../../scripts/ui-scoreboard/contracts'
import { CHECKS_PANEL, CREATE_VIEW, REVIEW_VIEW, SETTINGS_VIEW, type ReviewsState } from '../src/contracts'
import { activate } from '../src/ui'
import { listReviewsUiControls, requestReviewsUiControl, type ReviewsUiControlDescriptor, type ReviewsUiControlResult } from '../src/checks/data'
import {
  createGitLabMethodHarness,
  GITLAB_BASE_OID, GITLAB_COMMENTS, GITLAB_DIAGNOSTICS, GITLAB_HEAD_OID, GITLAB_HOST,
  GITLAB_LOOKUP, GITLAB_REPOSITORY, GITLAB_REVIEW, GITLAB_THREADED_COMMENT, GITLAB_WORKTREE,
  gitlabComment, gitlabComments,
  type GitLabMethodHarness, type GitLabMethodHarnessOptions, type GitLabMethodReply,
} from './gitlab-support'
import { newChecksEntry, parentMethods } from '../src/env'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE = GITLAB_WORKTREE
const HOST = GITLAB_HOST
const REPO = GITLAB_REPOSITORY
const GITHUB_REPO = { host: 'github.example.test', owner: 'group', repo: 'proj' }
const GITHUB_DIAGNOSTICS: Record<string, unknown> = {
  ghAvailable: true, activeAccount: null, accounts: [], envTokenInProcess: false,
  missingScopes: [], requiredScopes: ['repo'], hasKeyringFallback: false,
  requiredHost: GITHUB_REPO.host, requiredHostAuthenticated: true,
}
const OTHER_REPO = { host: 'github.com', owner: 'group', repo: 'other' }
const NUMBER = GITLAB_REVIEW.number
const HEAD = GITLAB_HEAD_OID
const BASE = GITLAB_BASE_OID
const MERGE_REQUEST_URL = GITLAB_REVIEW.url
const CONTROL = 'command:quirky.reviews/ui-control'
const CREATE_DEFAULTS = { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }
const GITLAB_STATUS = {
  branch: 'feature',
  head: HEAD,
  detached: false,
  operation: 'none',
  entries: [],
  files: [],
  upstreamStatus: {},
  busy: null,
  capped: false,
}
const GITLAB_BRANCHES = { refs: [{ name: 'origin/main', kind: 'remote' }], current: 'feature' }
const GITLAB_ELIGIBILITY = { eligible: true, defaultBase: 'main', head: 'feature', title: 'Add x', body: 'body', blockers: [] }
const GITLAB_CHECKS_REPLY = { number: NUMBER, headSha: HEAD, rollup: 'success', checks: [], partial: false, partialFailures: [] }

function publicReplies(): NonNullable<GitLabMethodHarnessOptions['replies']> {
  return {
    'quirky.git/status': () => GITLAB_STATUS,
    'quirky.git/branches': () => GITLAB_BRANCHES,
    'quirky.hosting/review': () => ({ ...GITLAB_LOOKUP, review: reviewFor() }),
    'quirky.hosting/comments': () => commentsEnvelope(),
    'quirky.hosting/creationEligibility': () => GITLAB_ELIGIBILITY,
    'quirky.hosting/create': () => ({
      number: 6,
      url: `https://${HOST}/group/sub/proj/-/merge_requests/6`,
      existing: false,
    }),
    'quirky.hosting/updateReview': (params: Record<string, unknown> | undefined) => ({
      number: NUMBER,
      ...(params?.action === 'ready' ? { state: 'open' } : {}),
      ...(params?.action === 'close' ? { state: 'closed' } : {}),
      ...(params?.action === 'reopen' ? { state: 'open' } : {}),
      ...(typeof params?.body === 'string' ? { body: params.body } : {}),
      updated: true,
    }),
    'quirky.hosting/reviewConversation': (params: Record<string, unknown> | undefined) => {
      const id = params?.action === 'edit' && typeof params.commentId === 'number' ? params.commentId : 301
      return {
        number: NUMBER,
        action: params?.action,
        comment: { kind: 'issue_comment', id, body: params?.body, author: 'fixture-user', createdAt: '2026-11-16T00:01:00Z', url: `${MERGE_REQUEST_URL}#note_${id}` },
      }
    },
    'quirky.hosting/reviewComment': (params: Record<string, unknown> | undefined) => ({
      number: NUMBER,
      action: 'reply',
      comment: { id: 302, body: params?.body, path: null, line: null, startLine: null },
    }),
    'quirky.hosting/resolveThread': (params: Record<string, unknown> | undefined) => ({
      threadId: params?.threadId,
      action: params?.action,
      resolved: params?.action === 'resolve',
    }),
  }
}
const STATE_FRAGMENTS = [
  'plugins/quirky.reviews/ui-scoreboard/checks-shell.json',
  'plugins/quirky.reviews/ui-scoreboard/create-and-settings.json',
  'plugins/quirky.reviews/ui-scoreboard/review-and-comments.json',
]
const OWNED_UI = [
  'plugins/quirky.reviews/src/checks/ChecksPanel.tsx',
  'plugins/quirky.reviews/src/create/CreateReview.tsx',
  'plugins/quirky.reviews/src/create/HostingSettings.tsx',
  'plugins/quirky.reviews/src/detail/ReviewPage.tsx',
  'plugins/quirky.reviews/src/detail/Comments.tsx',
  'plugins/quirky.reviews/src/link-routing.tsx',
]
const PASS: Record<string, true> = {
  'state-covered': true,
  'state-not-applicable': true,
  'not-state': true,
  'action-routed': true,
  'action-transient': true,
  'action-not-user': true,
}
const STRICT_HOSTING_METHODS = new Set([
  'quirky.hosting/assignees',
  'quirky.hosting/diagnoseAuth',
  'quirky.hosting/refresh',
  'quirky.hosting/visibleRefreshCandidates',
])

const harnesses: Harness[] = []

type Call = { method: string; params: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
type Method = (params: Record<string, unknown>) => unknown | Promise<unknown>
type SurfaceMount = (element: HTMLElement, props: { report(value: unknown): void }) => (() => void) | void
type MountedSurface = { element: HTMLElement; reports: unknown[]; unmount(): void }
type HarnessOptions = {
  connectionId?: number
  initialState?: ReviewsState
  view?: string
  openChecks?: boolean
  methods?: Record<string, Method>
  backendReplies?: GitLabMethodHarnessOptions['replies']
  settings?: Record<string, boolean>
}
type Harness = {
  context: UiPluginContext
  backend: GitLabMethodHarness
  calls: Call[]
  reports: unknown[]
  toasts: string[]
  confirmations: unknown[]
  mountSurface(id: string): MountedSurface
  setMethod(method: string, implementation: Method): void
  setBackendReply(method: string, reply: GitLabMethodReply): void
  replyNext(method: string, value: unknown): void
  holdNext(method: string): Deferred<unknown>
  setState(state: ReviewsState): void
  setLayout(layout: UiLayout): void
  registered(surface: string, slot: string): ReviewsUiControlDescriptor
  clearCalls(): void
  disposeBackend(): Promise<void>
  unmount(): void
}

function deferred<T = unknown>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function diagnostics(overrides: Record<string, unknown> = {}) {
  return { ...GITLAB_DIAGNOSTICS, ...overrides }
}

function topLevelNote(id = 101, body = 'hello') {
  return { ...gitlabComment(id), body }
}

function threadNote() {
  return { ...GITLAB_THREADED_COMMENT, body: 'threaded note' }
}

function commentsEnvelope(comments: unknown[] = [GITLAB_COMMENTS.comments[0], threadNote()], partial = false, partialFailures: string[] = []) {
  return { ...GITLAB_COMMENTS, comments, partial, partialFailures }
}

function reviewFor(options: { repo?: typeof REPO; provider?: string; title?: string; body?: string; number?: number } = {}) {
  const repo = options.repo ?? REPO
  const number = options.number ?? NUMBER
  const provider = options.provider ?? GITLAB_REVIEW.provider
  return {
    ...structuredClone(GITLAB_REVIEW),
    provider,
    number,
    url: provider === 'github'
      ? `https://${repo.host}/${repo.owner}/${repo.repo}/pull/${number}`
      : repo === REPO ? MERGE_REQUEST_URL : `https://${repo.host}/${repo.owner}/${repo.repo}/-/merge_requests/${number}`,
    title: options.title ?? GITLAB_REVIEW.title,
    body: options.body ?? GITLAB_REVIEW.body,
    prRepo: repo,
    repository: repo,
    requestedReviewers: ['alice'],
    assignees: ['bob'],
  }
}

function stateFor(options: {
  worktree?: string
  repo?: typeof REPO
  provider?: string
  review?: ReturnType<typeof reviewFor> | null
  detailTab?: 'conversation' | 'checks' | 'files'
  comments?: unknown
  details?: Record<string, unknown> | null
  diagnostics?: Record<string, unknown>
} = {}): ReviewsState {
  const worktree = options.worktree ?? WORKTREE
  const review = options.review === undefined ? reviewFor({ repo: options.repo, provider: options.provider }) : options.review
  const comments = options.comments === undefined ? commentsEnvelope() : options.comments
  const eligibility = {
    eligible: true,
    confirmedAt: Date.now(),
    headOid: HEAD,
    provider: review?.provider ?? options.provider ?? 'gitlab',
    blockers: [],
  }
  return {
    revision: 1,
    previousView: null,
    detail: {
      target: { worktree, number: NUMBER, prRepo: options.repo ?? REPO },
      tab: options.detailTab ?? 'conversation',
      generation: 1,
      loading: false,
      error: null,
      review,
      details: options.details === undefined ? null : options.details,
      checks: { number: NUMBER, headSha: HEAD, rollup: 'unknown', checks: [], partial: false, partialFailures: [] },
      comments,
      files: null,
      audience: 'all',
      grouping: 'grouped',
      expandedChecks: [],
      queuedComments: [],
      checksCollapsed: false,
      selectedFile: null,
      diffMode: 'inline',
      collapsedFiles: [],
      fileFilter: '',
      fileTreeVisible: true,
      commentDraft: '',
      bodyDraft: null,
      pending: [],
      fetchedAt: Date.now(),
    },
    checks: {
      worktree,
      generation: 1,
      loading: false,
      error: null,
      lookup: { kind: 'found', gitStatus: { branch: 'feature', head: HEAD }, prRepo: options.repo ?? REPO },
      eligibility,
      review,
      checks: { number: NUMBER, headSha: HEAD, rollup: 'unknown', checks: [], partial: false, partialFailures: [] },
      comments,
      conflicts: null,
      audience: 'all',
      grouping: 'grouped',
      expandedChecks: [],
      queuedComments: [],
      checksCollapsed: false,
      commentDraft: '',
      titleDraft: null,
      height: 320,
      fetchedAt: Date.now(),
      agentDialog: null,
    },
    creation: {
      worktree,
      generation: 1,
      loading: false,
      error: null,
      eligibility,
      title: 'Add x',
      body: 'body',
      base: 'main',
      head: 'feature',
      draft: true,
      useTemplate: false,
      bases: ['main'],
      generating: false,
      requestId: null,
      submitting: false,
      generated: false,
      result: null,
      defaults: { ...CREATE_DEFAULTS },
    },
    settings: {
      worktree,
      generation: 1,
      loading: false,
      error: null,
      provider: 'gitlab',
      repository: options.repo ?? REPO,
      diagnostics: options.diagnostics ?? diagnostics(),
      accounts: null,
      configuration: null,
      budget: null,
      fetchedAt: Date.now(),
    },
    defaults: { ...CREATE_DEFAULTS },
    repoDefaults: {},
    botOverrides: [],
    links: {},
    suppressed: {},
  } as unknown as ReviewsState
}
function seedBackend(backend: GitLabMethodHarness, state: ReviewsState): void {
  const worktree = state.checks.worktree ?? WORKTREE
  const checks = newChecksEntry(worktree)
  Object.assign(checks, {
    generation: state.checks.generation,
    loading: state.checks.loading,
    error: state.checks.error,
    lookup: structuredClone(state.checks.lookup),
    eligibility: structuredClone(state.checks.eligibility),
    review: structuredClone(state.checks.review),
    checks: structuredClone(state.checks.checks),
    comments: structuredClone(state.checks.comments),
    conflicts: structuredClone(state.checks.conflicts),
    expandedChecks: structuredClone(state.checks.expandedChecks),
    queuedComments: structuredClone(state.checks.queuedComments),
    commentDraft: state.checks.commentDraft,
    titleDraft: state.checks.titleDraft,
    fetchedAt: state.checks.fetchedAt,
  })
  backend.env.update((store) => {
    store.detail = structuredClone(state.detail)
    store.creation = structuredClone(state.creation)
    store.settings = structuredClone(state.settings)
    store.defaults = structuredClone(state.defaults)
    store.repoDefaults = structuredClone(state.repoDefaults)
    store.botOverrides = structuredClone(state.botOverrides)
    store.links = structuredClone(state.links)
    store.suppressed = structuredClone(state.suppressed)
    store.checksByWorktree[worktree] = checks
    store.agentDialog = state.checks.agentDialog
    store.checksHeight = state.checks.height
    store.audience = state.checks.audience
    store.grouping = state.checks.grouping
    store.checksCollapsed = state.checks.checksCollapsed
  }, worktree)
}

function createHarness(options: HarnessOptions = {}): Harness {
  const connectionId = options.connectionId ?? 42
  const calls: Call[] = []
  const reports: unknown[] = []
  const toasts: string[] = []
  const confirmations: unknown[] = []
  const provided = new Map<string, unknown>()
  const methods = new Map<string, Method>(Object.entries(options.methods ?? {}))
  const held = new Map<string, Deferred<unknown>[]>()
  const replies = new Map<string, unknown[]>()
  const subscribers = new Set<(event: unknown) => void>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const surfaceCleanups: Array<() => void> = []
  const elements: HTMLElement[] = []
  let state = options.initialState ?? stateFor()
  const backendReplies: NonNullable<GitLabMethodHarnessOptions['replies']> = {
    ...publicReplies(),
    'quirky.hosting/diagnoseAuth': () => state.settings.diagnostics ?? GITLAB_DIAGNOSTICS,
    ...options.backendReplies,
  }
  const backendWorktree = { id: state.checks.worktree ?? WORKTREE, kind: 'git' as const, repoId: 'fixture-repo', path: `/worktrees/${WORKTREE}`, branch: 'feature', head: HEAD }
  const backend = createGitLabMethodHarness({ replies: backendReplies, worktree: backendWorktree })
  seedBackend(backend, state)
  const backendParentMethods = parentMethods(backend.env)
  let layout = {
    worktree: WORKTREE,
    view: { id: options.view ?? REVIEW_VIEW, input: {} },
    panel: null,
    sidebar: true,
    focus: 'view',
    tools: { open: options.openChecks ? { right: CHECKS_PANEL } : {} },
  } as unknown as UiLayout
  const context = {
    pluginId: 'quirky.reviews',
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method.startsWith('quirky.hosting/') && !STRICT_HOSTING_METHODS.has(method)) {
        throw new Error(`Unexpected hosting method: ${method}`)
      }
      const pending = held.get(method)?.shift()
      if (held.get(method)?.length === 0) held.delete(method)
      if (pending) return pending.promise
      const queued = replies.get(method)
      if (queued?.length) {
        const value = queued.shift()
        if (value instanceof Error) throw value
        return value
      }
      const implementation = methods.get(method)
      if (implementation) return await implementation(params)
      if (method === 'ui.window.self') return { connId: connectionId }
      if (method === 'ui.window.command.run') {
        if (params.connId !== connectionId || params.id !== CONTROL) throw new Error('Unexpected exact-window command route.')
        const handler = provided.get(CONTROL)
        if (typeof handler !== 'function') throw new Error('The activated Reviews control handler is missing.')
        return { result: await (handler as (input?: unknown) => unknown | Promise<unknown>)(params.args) }
      }
      if (method === 'quirky.reviews/state') {
        const worktree = typeof params.worktree === 'string' ? params.worktree : state.checks.worktree ?? WORKTREE
        return backend.env.view(worktree)
      }
      if (method === 'quirky.worktree/list') return [{ kind: 'git', id: WORKTREE, name: 'gitlab', path: WORKTREE, branch: 'feature' }]
      if (method === 'quirky.reviews/checksSitterGet') return { available: false }
      if (method === 'quirky.tasks/state') return { links: {} }
      if (method === 'quirky.reviews/openLink') return await backendParentMethods.openLink(params)
      if (method.startsWith('quirky.reviews/')) {
        const name = method.slice('quirky.reviews/'.length)
        const owner = (['checks', 'detail', 'create'] as const).find((surface) => Object.hasOwn(backend.methods[surface], name))
        if (owner) return await backend.invoke(owner, name, params)
      }
      if (method === 'quirky.hosting/diagnoseAuth') return GITLAB_DIAGNOSTICS
      if (method === 'quirky.hosting/visibleRefreshCandidates') {
        return { accepted: true, generation: params.generation, candidates: Array.isArray(params.candidates) ? params.candidates.length : 0 }
      }
      if (method === 'quirky.hosting/refresh') return { kind: 'found', review: GITLAB_REVIEW, fetchedAt: Date.now() }
      return {}
    },
    getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) { layoutListeners.add(listener); return () => layoutListeners.delete(listener) },
    onConnection: () => () => {},
    subscribe(listener: (event: unknown) => void) { subscribers.add(listener); return () => subscribers.delete(listener) },
    getSetting(id: string) {
      if (id === 'setting:quirky.browser/openLinksInApp') return options.settings?.openLinksInApp ?? true
      if (id === 'setting:quirky.browser/openLinksInAppModifierInverts') return options.settings?.modifierInverts ?? true
      return undefined
    },
    toast(title: string, body: string) { toasts.push(`${title}: ${body}`) },
    confirm(input: unknown) { confirmations.push(input); return Promise.resolve(false) },
    log() {},
  } as unknown as UiPluginContext
  activate(context)
  const harness: Harness = {
    context,
    backend,
    calls,
    reports,
    toasts,
    confirmations,
    mountSurface(id: string) {
      const mount = provided.get(id)
      if (typeof mount !== 'function') throw new Error(`activate did not provide ${id}`)
      const element = document.createElement('div')
      document.body.appendChild(element)
      elements.push(element)
      let cleanup: (() => void) | void = undefined
      const report = (value: unknown) => { reports.push(value) }
      act(() => { cleanup = (mount as SurfaceMount)(element, { report }) })
      let didUnmount = false
      const unmount = () => {
        if (didUnmount) return
        didUnmount = true
        const cleanupRoot = typeof cleanup === 'function' ? cleanup : undefined
        if (cleanupRoot) act(() => cleanupRoot())
        const index = surfaceCleanups.indexOf(unmount)
        if (index >= 0) surfaceCleanups.splice(index, 1)
        element.remove()
      }
      if (typeof cleanup === 'function') surfaceCleanups.push(unmount)
      return { element, reports, unmount }
    },
    setMethod(method, implementation) { methods.set(method, implementation) },
    setBackendReply(method, reply) { backendReplies[method] = reply },
    replyNext(method, value) { replies.set(method, [...(replies.get(method) ?? []), value]) },
    holdNext(method) {
      const request = deferred<unknown>()
      held.set(method, [...(held.get(method) ?? []), request])
      return request
    },
    setState(next) {
      act(() => {
        state = { ...next, revision: Math.max(next.revision, state.revision + 1) } as ReviewsState
        seedBackend(backend, state)
        for (const listener of [...subscribers]) listener({ type: 'quirky.reviews/changed' })
      })
    },
    setLayout(next) {
      act(() => {
        layout = next
        for (const listener of [...layoutListeners]) listener(layout)
      })
    },
    registered(surface, slot) {
      const control = listReviewsUiControls(context, surface).find((item) => item.slot === slot)
      if (!control) throw new Error(`No registered Reviews control for ${surface}/${slot}`)
      return control
    },
    clearCalls() { calls.splice(0); backend.calls.splice(0) },
    unmount() {
      for (const cleanup of surfaceCleanups.splice(0).reverse()) cleanup()
      for (const element of elements.splice(0)) element.remove()
    },
    disposeBackend() { return backend.env.dispose() },
  }
  harnesses.push(harness)
  return harness
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}

function currentControl(harness: Harness, surface: string, slot: string) {
  return harness.registered(surface, slot)
}

async function invoke(
  harness: Harness,
  descriptor: ReviewsUiControlDescriptor,
  action: string,
  value?: Record<string, unknown>,
): Promise<ReviewsUiControlResult> {
  let result!: ReviewsUiControlResult
  await act(async () => {
    result = await requestReviewsUiControl(harness.context, {
      target: descriptor.target,
      generation: descriptor.generation,
      action,
      ...(value === undefined ? {} : { value }),
    })
  })
  return result
}

function startInvoke(
  harness: Harness,
  descriptor: ReviewsUiControlDescriptor,
  action: string,
  value?: Record<string, unknown>,
) {
  let delivery!: Promise<ReviewsUiControlResult>
  act(() => {
    delivery = requestReviewsUiControl(harness.context, {
      target: descriptor.target,
      generation: descriptor.generation,
      action,
      ...(value === undefined ? {} : { value }),
    })
  })
  return delivery
}

async function invokeCurrent(
  harness: Harness,
  surface: string,
  slot: string,
  action: string,
  value?: Record<string, unknown>,
): Promise<ReviewsUiControlResult> {
  return invoke(harness, currentControl(harness, surface, slot), action, value)
}

function actionEnabled(descriptor: ReviewsUiControlDescriptor, action: string) {
  return descriptor.actions.find((item) => item.action === action)?.enabled ?? false
}

function button(root: ParentNode, label: string) {
  const found = [...root.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found as HTMLButtonElement
}

function reactProps(node: HTMLElement): Record<string, (event: never) => void> {
  const key = Object.getOwnPropertyNames(node).find((candidate) => candidate.startsWith('__reactProps$'))
  if (!key) throw new Error('Could not inspect the rendered control handler.')
  return (node as unknown as Record<string, Record<string, (event: never) => void>>)[key]!
}

function changeValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  node.value = value
  const onChange = reactProps(node).onChange
  if (!onChange) throw new Error('The rendered text field has no change handler.')
  act(() => onChange({ target: node, currentTarget: node } as never))
}

function changeChecked(node: HTMLInputElement, value: boolean) {
  node.checked = value
  const onChange = reactProps(node).onChange
  if (!onChange) throw new Error('The rendered checkbox has no change handler.')
  act(() => onChange({ target: node, currentTarget: node } as never))
}

function providerError(reason: string, message: string) {
  return Object.assign(new Error(message), { data: { reason } })
}

function unavailableChecksState() {
  const state = stateFor()
  state.checks.review = null
  state.checks.lookup = { kind: 'unsupported', reason: 'not_authenticated', authDiagnostics: diagnostics({ tokenSource: null, glabAvailable: false, activeAccount: null, accounts: [], envTokenInProcess: false, requiredHostAuthenticated: false }) }
  state.checks.eligibility = { eligible: false, confirmedAt: Date.now(), reason: 'authentication_required', authDiagnostics: state.checks.lookup.authDiagnostics as Record<string, unknown> }
  return state
}

const mountedRoots: Array<() => void> = []

// Keep the real activation route, but give each surface a fresh window identity and local public replies.
function mountSurface(harness: Harness, id: string) {
  const mounted = harness.mountSurface(id)
  mountedRoots.push(mounted.unmount)
  return mounted
}

afterEach(async () => {
  await settle()
  for (const unmount of mountedRoots.splice(0).reverse()) unmount()
  const mounted = harnesses.splice(0).reverse()
  for (const harness of mounted) harness.unmount()
  await Promise.all(mounted.map((harness) => harness.disposeBackend()))
  document.body.replaceChildren()
})

afterAll(() => GlobalRegistrator.unregister())

test('GitLab creation keeps MR wording and submits settled fields through its exact-window control', async () => {
  const harness = createHarness({ initialState: stateFor(), view: CREATE_VIEW, connectionId: 42 })
  const mounted = mountSurface(harness, CREATE_VIEW)
  await settle()

  expect(mounted.element.textContent).toContain('Create merge request')
  expect(mounted.element.textContent).toContain('Generate MR details with AI')
  expect(mounted.element.textContent).toContain('merge-request template')
  expect(mounted.element.textContent).toContain('Create MR')
  expect(mounted.element.textContent).not.toContain('Create pull request')
  expect(mounted.element.textContent).not.toContain('Create PR')
  const creation = currentControl(harness, CREATE_VIEW, 'creation')
  expect(actionEnabled(creation, 'submit')).toBe(true)
  expect(actionEnabled(creation, 'stack-set')).toBe(false)
  await invoke(harness, creation, 'refresh-eligibility')
  await settle()
  expect(harness.backend.env.read().creation.eligibility).toMatchObject({ provider: 'gitlab', stackSupported: false, stackEnabled: false })
  expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/creationEligibility')).toBe(true)
  const currentCreation = currentControl(harness, CREATE_VIEW, 'creation')

  harness.clearCalls()
  await invoke(harness, currentCreation, 'submit')
  await settle()
  const payload = harness.calls.filter((call) => call.method === 'quirky.reviews/createDraft')
  expect(payload.at(-1)?.params).toMatchObject({ worktree: WORKTREE, title: 'Add x', body: 'body', draft: true, useTemplate: false })
  const submitted = harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')
  expect(submitted).toHaveLength(1)
  expect(submitted[0]?.params).toEqual({ worktree: WORKTREE })
  expect(harness.calls.findIndex((call) => call.method === 'quirky.reviews/createDraft')).toBeLessThan(
    harness.calls.findIndex((call) => call.method === 'quirky.reviews/createSubmit'),
  )
  expect(harness.calls.find((call) => call.method === 'ui.window.command.run')?.params).toMatchObject({ connId: 42, id: CONTROL })
  const createCall = harness.backend.calls.find((call) => call.method === 'quirky.hosting/create')
  expect(createCall?.params).toMatchObject({ worktree: WORKTREE, base: 'main', head: 'feature', title: 'Add x', body: 'body', draft: true, useTemplate: false })
  expect(JSON.stringify(harness.reports)).not.toContain('GITLAB_TOKEN')
  expect(JSON.stringify(harness.reports)).not.toContain('body')
})

test('unknown creation provider never enables submit or hosting create dispatch', async () => {
  const state = stateFor()
  state.creation.eligibility = { ...state.creation.eligibility, provider: 'unknown' }
  const harness = createHarness({ initialState: state, view: CREATE_VIEW })
  const mounted = mountSurface(harness, CREATE_VIEW)
  await settle()
  const creation = currentControl(harness, CREATE_VIEW, 'creation')
  expect(actionEnabled(creation, 'submit')).toBe(false)
  expect(await invoke(harness, creation, 'submit')).toEqual({ delivered: false, reason: 'disabled' })
  const submitButtons = [...mounted.element.querySelectorAll<HTMLButtonElement>('button')].filter((button) => /Create (?:MR|PR)/.test(button.textContent ?? ''))
  expect(submitButtons.every((button) => button.disabled)).toBe(true)
  expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/create')).toBe(false)
})

test('GitLab settings report auth readiness without reading accounts, configuration, or API budgets', async () => {
  const harness = createHarness({ initialState: stateFor(), view: SETTINGS_VIEW, connectionId: 42 })
  const mounted = mountSurface(harness, SETTINGS_VIEW)
  await settle()

  expect(mounted.element.textContent).toContain('GitLab')
  expect(mounted.element.textContent).toContain('Connected')
  expect(mounted.element.textContent).toContain('GITLAB_TOKEN')
  expect(mounted.element.textContent).not.toContain('Not installed')
  expect(mounted.element.textContent).toContain('Account binding is unavailable for GitLab.')
  expect(mounted.element.textContent).toContain('API budget is unavailable for GitLab.')
  expect(mounted.element.textContent).not.toContain('REST')
  expect(mounted.element.textContent).not.toContain('GraphQL')
  const hosting = currentControl(harness, SETTINGS_VIEW, 'settings-hosting')
  for (const action of ['account-select', 'account-save', 'budget-refresh']) {
    expect(hosting.actions.some((item) => item.action === action)).toBe(true)
    expect(actionEnabled(hosting, action)).toBe(false)
    expect(await invoke(harness, hosting, action)).toEqual({ delivered: false, reason: 'disabled' })
  }
  harness.clearCalls()
  await invoke(harness, hosting, 'provider-recheck')
  await settle()
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toHaveLength(1)
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')?.params).toEqual({ worktree: WORKTREE, forceBudget: true })
  expect(harness.backend.calls.filter((call) => call.method === 'quirky.hosting/repository')).toHaveLength(1)
  expect(harness.backend.calls.filter((call) => call.method === 'quirky.hosting/diagnoseAuth')).toHaveLength(1)
  for (const method of ['quirky.hosting/accounts', 'quirky.hosting/configuration', 'quirky.hosting/configure', 'quirky.hosting/rateLimit']) {
    expect(harness.backend.calls.filter((call) => call.method === method)).toHaveLength(0)
  }
  expect(harness.calls.some((call) => /hosting(?:Accounts|Configuration|Budget)/.test(call.method))).toBe(false)
  expect(JSON.stringify(harness.reports)).not.toContain('fixture-user')
})

test('GitLab settings distinguish missing credentials, rejection, missing scopes, and unknown scopes', async () => {
  const cases = [
    {
      name: 'missing credentials',
      diagnostics: diagnostics({ tokenSource: null, glabAvailable: false, tokenRejected: false, activeAccount: null, accounts: [], envTokenInProcess: false, requiredHostAuthenticated: false }),
      expected: 'Set GITLAB_TOKEN or run glab auth login.',
    },
    {
      name: 'rejected credentials',
      diagnostics: diagnostics({ tokenRejected: true, requiredHostAuthenticated: false }),
      expected: 'GitLab rejected the configured token.',
    },
    {
      name: 'missing API scope',
      diagnostics: diagnostics({ missingScopes: ['api'], accounts: [{ host: HOST, user: 'fixture-user', source: 'env', active: true, scopes: [] }] }),
      expected: 'Missing GitLab scopes: api.',
    },
    {
      name: 'unknown observed scopes',
      diagnostics: diagnostics({ accounts: [{ host: HOST, user: 'fixture-user', source: 'env', active: true, scopes: [] }] }),
      expected: 'Scopes unknown',
    },
  ]
  for (const scenario of cases) {
    const initialState = stateFor({ diagnostics: scenario.diagnostics })
    const harness = createHarness({ initialState, view: SETTINGS_VIEW })
    const mounted = mountSurface(harness, SETTINGS_VIEW)
    await settle()
    expect(mounted.element.textContent, scenario.name).toContain(scenario.expected)
    expect(mounted.element.querySelector('.ui-inline-error'), scenario.name).toBeNull()
    harness.unmount()
  }
})

test('Checks authentication guidance follows GitLab diagnostics and never recommends gh', async () => {
  const harness = createHarness({ initialState: unavailableChecksState(), openChecks: true, view: CHECKS_PANEL })
  const mounted = mountSurface(harness, CHECKS_PANEL)
  await settle()

  expect(mounted.element.textContent).toContain('GITLAB_TOKEN')
  expect(mounted.element.textContent).toContain('glab auth login')
  expect(mounted.element.textContent).not.toContain('GitHub')
  expect(mounted.element.textContent).not.toContain('gh auth')
  expect(mounted.element.textContent).not.toContain('Install it')
  expect(JSON.stringify(harness.reports)).not.toContain('fixture-user')
})
test('GitLab Checks explains that PR Sitter is unavailable before fleet state is known', async () => {
  const harness = createHarness({
    initialState: stateFor(), view: CHECKS_PANEL, openChecks: true,
    methods: {
      'quirky.reviews/checksSitterGet': async () => ({ available: true, sitter: null, detail: null, activeCount: 0, otherActiveCount: 0 }),
    },
  })
  const mounted = mountSurface(harness, CHECKS_PANEL)
  await settle()
  expect(mounted.element.textContent).toContain('PR Sitter is unavailable for GitLab merge requests.')
  expect([...mounted.element.querySelectorAll('.ui-notice-line')].some((item) => item.textContent?.includes('PR Sitter is unavailable for GitLab merge requests.'))).toBe(true)
  expect([...mounted.element.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Arm PR Sitter')).toBe(false)
})


test('GitLab review details keep supported description and link actions while hiding unsupported workspace and assignment writes', async () => {
  const initialState = stateFor()
  initialState.detail.fetchedAt = 0
  const harness = createHarness({ initialState, view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await settle()

  expect(mounted.element.querySelector('main')?.getAttribute('aria-label')).toBe('Merge request detail')
  expect(mounted.element.textContent).toContain('Add x')
  expect(mounted.element.textContent).toContain('body')
  expect(mounted.element.textContent).toContain('group/sub / proj')
  expect(mounted.element.textContent).toContain('Unknown author')
  expect(mounted.element.textContent).toContain('alice')
  expect(mounted.element.textContent).toContain('bob')
  expect(mounted.element.textContent).toContain('Workspace creation is unavailable for GitLab merge requests.')
  expect(mounted.element.textContent).not.toContain('Start workspace')
  expect(mounted.element.textContent).not.toContain('Resume workspace')
  expect(mounted.element.textContent).not.toContain('Start new workspace')
  expect(harness.calls.some((call) => call.method === 'quirky.tasks/state')).toBe(false)
  expect(harness.calls.some((call) => call.method === 'quirky.hosting/assignees')).toBe(false)
  expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/review')).toBe(true)
  expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/comments')).toBe(true)
  expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/checks')).toBe(true)
  expect(harness.backend.calls.some((call) => ['quirky.hosting/workItemDetails', 'quirky.hosting/files', 'quirky.hosting/reviewStack'].includes(call.method))).toBe(false)

  const page = currentControl(harness, REVIEW_VIEW, 'review-page')
  expect(actionEnabled(page, 'body-open')).toBe(true)
  for (const action of ['workspace-start', 'workspace-resume', 'workspace-start-new']) {
    expect(actionEnabled(page, action)).toBe(false)
    expect(await invoke(harness, page, action)).toEqual({ delivered: false, reason: 'disabled' })
  }
  for (const [slot, action] of [['assignments', 'assignees-open'], ['assignments', 'reviewers-open']] as const) {
    const assignments = currentControl(harness, REVIEW_VIEW, slot)
    expect(actionEnabled(assignments, action)).toBe(false)
    expect(await invoke(harness, assignments, action)).toEqual({ delivered: false, reason: 'disabled' })
  }

  const link = button(mounted.element, 'Open on GitLab')
  const chord = CHORD_PLATFORM === 'darwin' ? 'Shift+Cmd-click' : 'Shift+Ctrl-click'
  expect(link.title).toBe(`Open on GitLab in Quirky Browser; ${chord} opens in system browser.`)
  await invoke(harness, page, 'open-link', { invert: true })
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/openLink')?.params).toEqual({ url: MERGE_REQUEST_URL, worktree: WORKTREE, invert: true })
  expect(harness.backend.calls.find((call) => call.method === 'ui.command.run')?.params).toEqual({
    id: 'command:quirky.reviews/open-link',
    args: { url: MERGE_REQUEST_URL, worktree: WORKTREE, invert: true },
  })
  expect(harness.calls.some((call) => call.method === 'quirky.browser/openLink')).toBe(false)

  const bodyOpen = await invoke(harness, page, 'body-open')
  expect(bodyOpen, JSON.stringify({ previous: page, current: currentControl(harness, REVIEW_VIEW, 'review-page') })).toMatchObject({ delivered: true })
  await settle()
  const bodyEditor = mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Merge request description"]')
  expect(bodyEditor).not.toBeNull()
  changeValue(bodyEditor!, 'edited body')
  await settle()
  const heldSave = deferred<unknown>()
  harness.setBackendReply('quirky.hosting/updateReview', () => heldSave.promise)
  await invokeCurrent(harness, REVIEW_VIEW, 'review-body', 'body-save')
  await settle()
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/detailUpdateBody')?.params).toEqual({
    surface: 'detail', worktree: WORKTREE, number: NUMBER, prRepo: REPO, body: 'edited body',
  })
  expect(harness.backend.calls.find((call) => call.method === 'quirky.hosting/updateReview')?.params).toMatchObject({
    worktree: WORKTREE, number: NUMBER, prRepo: REPO, action: 'edit', body: 'edited body',
  })
  await act(async () => { heldSave.reject(new Error('GitLab description write failed')); await heldSave.promise.catch(() => undefined) })
  await settle()
  expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain('GitLab description write failed')
  expect(mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Merge request description"]')?.value).toBe('edited body')
})

test('GitLab description controls require a valid selected merge-request identity', async () => {
  const initial = stateFor()
  initial.detail.review = {
    ...GITLAB_REVIEW,
    prRepo: REPO,
    url: `https://${HOST}/other/proj/-/merge_requests/${NUMBER}`,
  }
  const harness = createHarness({ initialState: initial, view: REVIEW_VIEW })
  mountSurface(harness, REVIEW_VIEW)
  await settle()
  const page = currentControl(harness, REVIEW_VIEW, 'review-page')
  expect(actionEnabled(page, 'body-open')).toBe(false)
  expect(await invoke(harness, page, 'body-open')).toEqual({ delivered: false, reason: 'disabled' })
  expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/updateReview')).toBe(false)
})

test('GitLab files navigation explains the missing capability without mounting changed-file controls', async () => {
  const harness = createHarness({ initialState: stateFor({ detailTab: 'files' }), view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await settle()
  expect(mounted.element.textContent).toContain('Changed files are unavailable for GitLab merge requests.')
  expect(mounted.element.querySelector('[aria-label="Files changed"]')).toBeNull()
  expect(listReviewsUiControls(harness.context, REVIEW_VIEW).map((control) => control.slot)).not.toContain('files-changed')
  expect(harness.backend.calls.filter((call) => call.method === 'quirky.hosting/files')).toHaveLength(0)
  const page = currentControl(harness, REVIEW_VIEW, 'review-page')
  expect(await invoke(harness, page, 'tab-set', { tab: 'files' })).toMatchObject({ delivered: true })
  expect(harness.calls.some((call) => call.method === 'quirky.reviews/detailSetTab' && call.params.tab === 'files')).toBe(true)
})

for (const surface of ['detail', 'checks'] as const) {
  test(`GitLab comments render on ${surface} with grouping and queue controls`, async () => {
    const id = surface === 'detail' ? REVIEW_VIEW : CHECKS_PANEL
    const harness = createHarness({ initialState: stateFor(), view: id, openChecks: surface === 'checks' })
    const mounted = mountSurface(harness, id)
    await settle()
    expect(mounted.element.textContent).toContain('hello')
    expect(mounted.element.textContent).toContain('threaded note')
    expect(mounted.element.textContent).toContain('Needs review')
    expect(mounted.element.querySelector('[aria-label="Merge request comments"]')).not.toBeNull()
    const commentSurface = surface === 'detail' ? REVIEW_VIEW : CHECKS_PANEL
    await invokeCurrent(harness, commentSurface, 'comments', 'grouping-set', { grouping: 'timeline' })
    await invokeCurrent(harness, commentSurface, 'comments', 'audience-set', { audience: 'humans' })
    await invokeCurrent(harness, commentSurface, 'comments', 'queue-set', { comment: { kind: 'issue_comment', id: 101 }, queued: true })
    expect(harness.calls.find((call) => call.method === 'quirky.reviews/detailSetGrouping')?.params).toMatchObject({ surface, grouping: 'timeline' })
    expect(harness.calls.find((call) => call.method === 'quirky.reviews/detailSetAudience')?.params).toMatchObject({ surface, audience: 'humans' })
    expect(harness.calls.find((call) => call.method === 'quirky.reviews/detailQueueComment')?.params).toMatchObject({ surface, commentId: '101', queued: true })
  })
}

test('GitLab comments disable Delete at the DOM and dispatch boundaries but permit edit, numeric reply, and thread resolve', async () => {
  const state = stateFor()
  state.detail.commentDraft = 'reply body'
  const harness = createHarness({ initialState: state, view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await settle()
  expect([...mounted.element.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Resolve')).toBe(true)
  expect([...mounted.element.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Delete')).toBe(false)
  const comments = currentControl(harness, REVIEW_VIEW, 'comments')
  expect(actionEnabled(comments, 'comment-delete')).toBe(false)
  expect(await invoke(harness, comments, 'comment-delete', { comment: { kind: 'issue_comment', id: 101 } })).toEqual({ delivered: false, reason: 'disabled' })
  expect(harness.confirmations).toHaveLength(0)
  expect(harness.calls.some((call) => call.method === 'quirky.reviews/detailDeleteComment')).toBe(false)

  await invokeCurrent(harness, REVIEW_VIEW, 'comments', 'edit-open', { comment: { kind: 'issue_comment', id: 101 } })
  await invokeCurrent(harness, REVIEW_VIEW, 'comment-edit:issue_comment:101', 'edit-save', { body: 'edited note' })
  expect(harness.backend.calls.find((call) => call.method === 'quirky.hosting/reviewConversation' && call.params?.action === 'edit')?.params).toMatchObject({
    worktree: WORKTREE, number: NUMBER, prRepo: REPO, action: 'edit', commentId: 101, body: 'edited note',
  })
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/detailEditComment')?.params).toMatchObject({ surface: 'detail', worktree: WORKTREE, number: NUMBER, prRepo: REPO, commentId: 101, body: 'edited note' })

  await invokeCurrent(harness, REVIEW_VIEW, 'comments', 'reply-open', { comment: { kind: 'issue_comment', id: 101 } })
  await settle()
  expect(mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to comment #101"]')).not.toBeNull()
  await invokeCurrent(harness, REVIEW_VIEW, 'comment-composer', 'comment-send')
  await settle()
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/detailPostComment')?.params).toMatchObject({
    surface: 'detail', worktree: WORKTREE, number: NUMBER, prRepo: REPO, body: 'reply body', replyToId: 101,
  })
  expect(harness.backend.calls.find((call) => call.method === 'quirky.hosting/reviewComment')?.params).toMatchObject({
    worktree: WORKTREE, number: NUMBER, prRepo: REPO, action: 'reply', replyToId: 101, body: 'reply body',
  })

  await invokeCurrent(harness, REVIEW_VIEW, 'comments', 'thread-set', { comment: { kind: 'review_comment', id: 201 }, resolved: true })
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/detailResolveThread')?.params).toMatchObject({
    surface: 'detail', worktree: WORKTREE, number: NUMBER, prRepo: REPO, threadId: 'a'.repeat(40), resolved: true,
  })
  expect(harness.backend.calls.find((call) => call.method === 'quirky.hosting/resolveThread')?.params).toMatchObject({
    worktree: WORKTREE, number: NUMBER, prRepo: REPO, threadId: 'a'.repeat(40), action: 'resolve',
  })
  const resolvedState = stateFor({ comments: commentsEnvelope([topLevelNote(), { ...threadNote(), isResolved: true }]) })
  const resolvedHarness = createHarness({ initialState: resolvedState, view: REVIEW_VIEW })
  const resolvedSurface = mountSurface(resolvedHarness, REVIEW_VIEW)
  await settle()
  expect([...resolvedSurface.element.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Unresolve')).toBe(true)
})

for (const scenario of [
  { action: 'add', body: 'new note', slot: 'comment-composer', controlAction: 'comment-send', providerMethod: 'quirky.hosting/reviewConversation', label: 'Add a comment' },
  { action: 'edit', body: 'edited note', slot: 'comment-edit:issue_comment:101', controlAction: 'edit-save', providerMethod: 'quirky.hosting/reviewConversation', label: 'Edit comment #101' },
  { action: 'reply', body: 'numeric reply', slot: 'comment-composer', controlAction: 'comment-send', providerMethod: 'quirky.hosting/reviewComment', label: 'Reply to comment #101' },
] as const) {
  test(`failed GitLab ${scenario.action} retains its current draft`, async () => {
    const state = stateFor()
    state.detail.commentDraft = scenario.action === 'add' ? 'new note' : scenario.action === 'reply' ? 'numeric reply' : ''
    const harness = createHarness({ initialState: state, view: REVIEW_VIEW })
    const mounted = mountSurface(harness, REVIEW_VIEW)
    await settle()
    if (scenario.action === 'edit') {
      await invokeCurrent(harness, REVIEW_VIEW, 'comments', 'edit-open', { comment: { kind: 'issue_comment', id: 101 } })
    }
    if (scenario.action === 'reply') {
      await invokeCurrent(harness, REVIEW_VIEW, 'comments', 'reply-open', { comment: { kind: 'issue_comment', id: 101 } })
      await settle()
    }
    harness.setBackendReply(scenario.providerMethod, () => { throw new Error(`GitLab ${scenario.action} failed`) })
    await invokeCurrent(harness, REVIEW_VIEW, scenario.slot, scenario.controlAction, { ...(scenario.action === 'edit' ? { body: scenario.body } : {}) })
    await settle()
    expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain(`GitLab ${scenario.action} failed`)
    expect(mounted.element.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${scenario.label}"]`)?.value).toBe(
      scenario.action === 'edit' ? scenario.body : scenario.action === 'add' ? 'new note' : 'numeric reply',
    )
    expect(harness.backend.calls.some((call) => call.method === scenario.providerMethod)).toBe(true)
    expect(harness.toasts.join('\n')).not.toContain('Comment posted')
  })
}

test('a held GitLab add completion cannot clear or toast into a replacement comment session', async () => {
  const state = stateFor()
  state.detail.commentDraft = 'old note'
  const harness = createHarness({ initialState: state, view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await settle()
  const providerReply = deferred<unknown>()
  harness.setBackendReply('quirky.hosting/reviewConversation', () => providerReply.promise)
  await invokeCurrent(harness, REVIEW_VIEW, 'comment-composer', 'comment-send')
  await settle()
  expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/reviewConversation' && call.params?.action === 'add')).toBe(true)

  const replacement = stateFor({ repo: OTHER_REPO, provider: 'github', review: reviewFor({ repo: OTHER_REPO, provider: 'github' }) })
  replacement.detail.commentDraft = 'replacement draft'
  harness.setState(replacement)
  await settle()
  await act(async () => {
    providerReply.resolve({
      number: NUMBER,
      action: 'add',
      comment: { kind: 'issue_comment', id: 301, body: 'old note', author: 'fixture-user', createdAt: '2026-11-16T00:01:00Z', url: `${MERGE_REQUEST_URL}#note_301` },
    })
    await providerReply.promise
  })
  await settle()

  expect(mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')?.value).toBe('replacement draft')
  expect(harness.toasts.join('\n')).not.toContain('Comment posted')
  expect(mounted.element.textContent).not.toContain('old note')
})

test('GitLab mention typing remains plain text and does not request the GitHub assignee catalog', async () => {
  const state = stateFor()
  state.detail.commentDraft = '@rev'
  const harness = createHarness({ initialState: state, view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)) })
  await settle()
  expect(harness.calls.some((call) => call.method === 'quirky.hosting/assignees')).toBe(false)
  const composer = currentControl(harness, REVIEW_VIEW, 'comment-composer')
  expect(actionEnabled(composer, 'mention-select')).toBe(false)
  expect(await invoke(harness, composer, 'mention-select', { login: 'reviewer' })).toEqual({ delivered: false, reason: 'disabled' })
  expect(mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')?.value).toBe('@rev')
})

test('GitLab partial comment ingestion displays the bounded 100-note set without claiming upstream page completeness', async () => {
  const envelope = gitlabComments(101, true, ['upstream partial fixture'])
  const harness = createHarness({ initialState: stateFor({ comments: envelope }), view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await settle()
  expect(mounted.element.querySelectorAll('article')).toHaveLength(100)
  expect(mounted.element.textContent).toContain('note 100')
  expect(mounted.element.textContent).not.toContain('note 101')
  expect(mounted.element.textContent).toContain('Showing a limited set of comments.')
  expect(mounted.element.textContent).toContain('upstream partial fixture')
  expect(mounted.element.textContent).not.toContain('Showing the first 100 comments per source')
})

test('GitLab UI controls use their mounted auxiliary window identity, not the owner connection', async () => {
  const owner = createHarness({ initialState: stateFor(), view: REVIEW_VIEW, connectionId: 41 })
  mountSurface(owner, REVIEW_VIEW)
  const auxiliary = createHarness({ initialState: stateFor(), view: REVIEW_VIEW, connectionId: 42 })
  const mounted = mountSurface(auxiliary, REVIEW_VIEW)
  await settle()
  auxiliary.clearCalls()
  owner.clearCalls()
  const page = currentControl(auxiliary, REVIEW_VIEW, 'review-page')
  await invoke(auxiliary, page, 'refresh')
  await settle()

  expect(auxiliary.calls.find((call) => call.method === 'ui.window.self')).toBeDefined()
  expect(auxiliary.calls.find((call) => call.method === 'ui.window.command.run')?.params).toMatchObject({ connId: 42, id: CONTROL })
  expect(owner.calls.some((call) => call.method === 'ui.window.command.run')).toBe(false)
  expect(auxiliary.calls.find((call) => call.method === 'quirky.reviews/detailRefresh')?.params).toMatchObject({ surface: 'detail', worktree: WORKTREE, number: NUMBER, prRepo: REPO })
  mounted.unmount()
})

test('held self and command-run deliveries cannot refresh a replacement provider or publish stale failures', async () => {
  const selfHarness = createHarness({ initialState: stateFor(), view: REVIEW_VIEW, connectionId: 42 })
  const selfSurface = mountSurface(selfHarness, REVIEW_VIEW)
  await settle()
  const oldPage = currentControl(selfHarness, REVIEW_VIEW, 'review-page')
  const heldSelf = selfHarness.holdNext('ui.window.self')
  const selfDelivery = startInvoke(selfHarness, oldPage, 'refresh')
  await settle()
  selfHarness.setState(stateFor({ repo: OTHER_REPO, provider: 'github', review: reviewFor({ repo: OTHER_REPO, provider: 'github' }) }))
  await settle()
  const selfOutcome: { value?: ReviewsUiControlResult } = {}
  await act(async () => {
    heldSelf.resolve({ connId: 42 })
    selfOutcome.value = await selfDelivery
  })
  expect(selfOutcome.value).toEqual({ delivered: false, reason: 'target-unavailable' })
  expect(selfHarness.calls.some((call) => call.method === 'quirky.reviews/detailRefresh')).toBe(false)
  expect(selfSurface.element.querySelector('.ui-inline-error')).toBeNull()

  const runHarness = createHarness({ initialState: stateFor(), view: REVIEW_VIEW, connectionId: 42 })
  const runSurface = mountSurface(runHarness, REVIEW_VIEW)
  await settle()
  const page = currentControl(runHarness, REVIEW_VIEW, 'review-page')
  const heldRun = runHarness.holdNext('ui.window.command.run')
  const runDelivery = startInvoke(runHarness, page, 'refresh')
  await settle()
  runHarness.setState(stateFor({ repo: OTHER_REPO, provider: 'github', review: reviewFor({ repo: OTHER_REPO, provider: 'github' }) }))
  await settle()
  const runOutcome: { value?: ReviewsUiControlResult } = {}
  await act(async () => {
    heldRun.resolve({ result: { delivered: false, reason: 'target-unavailable' } })
    runOutcome.value = await runDelivery
  })
  expect(runOutcome.value).toEqual({ delivered: false, reason: 'target-unavailable' })
  expect(runHarness.calls.some((call) => call.method === 'quirky.reviews/detailRefresh')).toBe(false)
  expect(runSurface.element.querySelector('.ui-inline-error')).toBeNull()
})

for (const bridge of ['ui.window.self', 'ui.window.command.run'] as const) {
  test(`current ${bridge} failure shows InlineError without a local refresh fallback`, async () => {
    const harness = createHarness({ initialState: stateFor(), view: REVIEW_VIEW })
    const mounted = mountSurface(harness, REVIEW_VIEW)
    await settle()
    harness.clearCalls()
    harness.setMethod(bridge, async () => { throw new Error(`${bridge} fixture failed`) })
    const refresh = [...mounted.element.querySelectorAll('button')].find((item) => /refresh (?:pull|merge) request/i.test(item.textContent?.trim() ?? ''))
    expect(refresh).toBeDefined()
    await act(async () => { refresh!.click() })
    await settle()
    expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain(`${bridge} fixture failed`)
    expect(harness.calls.some((call) => call.method === 'quirky.reviews/detailRefresh')).toBe(false)
  })
}

test('GitLab page descriptors are fenced through repository A to B to A replacement with the same MR and head', async () => {
  const firstState = stateFor()
  const harness = createHarness({ initialState: firstState, view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await settle()
  const original = currentControl(harness, REVIEW_VIEW, 'review-page')
  const nextState = stateFor({ repo: OTHER_REPO, provider: 'github' })
  harness.setState(nextState)
  await settle()
  harness.setState(firstState)
  await settle()
  const current = currentControl(harness, REVIEW_VIEW, 'review-page')
  expect(current.target).toBe(original.target)
  expect(current.generation).toBeGreaterThan(original.generation)
  expect(await invoke(harness, original, 'refresh')).toEqual({ delivered: false, reason: 'target-unavailable' })
  expect(harness.calls.some((call) => call.method === 'quirky.reviews/detailRefresh')).toBe(false)
  mounted.unmount()
})

test('held GitLab description and link completions cannot publish into a replacement repository', async () => {
  const harness = createHarness({ initialState: stateFor(), view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await settle()
  const page = currentControl(harness, REVIEW_VIEW, 'review-page')
  await invoke(harness, page, 'body-open')
  await settle()
  const editor = mounted.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Merge request description"]')!
  changeValue(editor, 'held edit')
  await settle()
  const bodySave = deferred<unknown>()
  harness.setBackendReply('quirky.hosting/updateReview', () => bodySave.promise)
  await invokeCurrent(harness, REVIEW_VIEW, 'review-body', 'body-save')
  await settle()
  expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/updateReview')).toBe(true)
  harness.setState(stateFor({ repo: OTHER_REPO, provider: 'github', review: reviewFor({ repo: OTHER_REPO, provider: 'github', body: 'replacement body' }) }))
  await settle()
  await act(async () => { bodySave.reject(new Error('obsolete description failure')); await bodySave.promise.catch(() => undefined) })
  await settle()
  expect(mounted.element.textContent).not.toContain('obsolete description failure')
  expect(mounted.element.textContent).toContain('replacement body')

  const currentPage = currentControl(harness, REVIEW_VIEW, 'review-page')
  const openLink = deferred<unknown>()
  harness.setBackendReply('ui.command.run', () => openLink.promise)
  await invoke(harness, currentPage, 'open-link')
  await settle()
  harness.setState(stateFor({ repo: REPO }))
  await settle()
  await act(async () => { openLink.reject(new Error('obsolete link failure')); await openLink.promise.catch(() => undefined) })
  await settle()
  expect(harness.toasts.join('\n')).not.toContain('obsolete link failure')
  expect(mounted.element.textContent).not.toContain('obsolete link failure')
})

function controlledWindowTimers() {
  const originalSet = window.setTimeout
  const originalClear = window.clearTimeout
  let nextId = 0
  const scheduled = new Map<number, () => void>()
  window.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
    const id = ++nextId
    scheduled.set(id, () => { if (typeof handler === 'function') handler(...args) })
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = ((id: number) => { scheduled.delete(id) }) as typeof window.clearTimeout
  return {
    runNext() {
      const first = scheduled.entries().next().value as [number, () => void] | undefined
      if (!first) throw new Error('The Checks polling runtime did not schedule an active refresh.')
      scheduled.delete(first[0])
      first[1]()
    },
    restore() { window.setTimeout = originalSet; window.clearTimeout = originalClear },
  }
}

function visibleCandidateCall(harness: Harness) {
  return harness.calls.find((call) => call.method === 'quirky.hosting/visibleRefreshCandidates')
}

test('GitLab Checks refresh uses the real Reviews method and preserves the MR and comments when checks are unsupported', async () => {
  const timers = controlledWindowTimers()
  try {
    const initialState = stateFor()
    initialState.checks.checks = null
    const harness = createHarness({ initialState, view: CHECKS_PANEL, openChecks: true })
    const mounted = mountSurface(harness, CHECKS_PANEL)
    await settle()
    harness.clearCalls()
    await invokeCurrent(harness, CHECKS_PANEL, 'checks', 'refresh')
    await settle()

    const checks = harness.backend.env.view(WORKTREE).checks
    expect(checks.loading).toBe(false)
    expect(checks.checks).toBeNull()
    expect(checks.review).toMatchObject({ provider: 'gitlab', number: NUMBER, title: 'Add x', body: 'body', prRepo: REPO })
    expect(checks.comments).toMatchObject({ number: NUMBER, comments: [{ id: 101, body: 'hello' }, { id: 201 }] })
    expect(mounted.element.textContent).toContain('Checks are unavailable for GitLab merge requests.')
    expect(mounted.element.textContent).toContain('hello')
    expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/review')).toBe(true)
    expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/comments')).toBe(true)
    expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/checks')).toBe(true)
    expect(harness.backend.calls.some((call) => ['quirky.hosting/reviewStack', 'quirky.hosting/workItemDetails', 'quirky.hosting/files'].includes(call.method))).toBe(false)
  } finally { timers.restore() }
})

test('manual GitLab refresh falls back to one direct read only after an explicit queue-capability refusal', async () => {
  const timers = controlledWindowTimers()
  try {
    const harness = createHarness({ initialState: stateFor(), view: CHECKS_PANEL, openChecks: true })
    const mounted = mountSurface(harness, CHECKS_PANEL)
    await settle()
    const report = visibleCandidateCall(harness)
    expect(report?.params).toMatchObject({ candidates: [{ worktree: WORKTREE, active: true, branch: 'feature', number: NUMBER, headOid: HEAD }] })
    expect((report?.params.generation as number) > 0).toBe(true)
    harness.clearCalls()
    harness.setMethod('quirky.hosting/refresh', async () => { throw providerError('unsupported_provider', 'queue unavailable fixture') })
    harness.setBackendReply('quirky.hosting/checks', GITLAB_CHECKS_REPLY)
    const checks = currentControl(harness, CHECKS_PANEL, 'checks')
    await invoke(harness, checks, 'refresh')
    await settle()

    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/refresh')).toHaveLength(1)
    expect(harness.calls.find((call) => call.method === 'quirky.hosting/refresh')?.params).toEqual({
      candidate: { worktree: WORKTREE, active: true, branch: 'feature', number: NUMBER, headOid: HEAD },
      reason: 'manual', priority: 80,
    })
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')).toHaveLength(1)
    expect(harness.calls.find((call) => call.method === 'quirky.reviews/checksRefresh')?.params).toEqual({ worktree: WORKTREE, force: true })
    expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/review')).toBe(true)
    expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/comments')).toBe(true)
    expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/checks')).toBe(true)
    expect(mounted.element.querySelector('.ui-inline-error')).toBeNull()
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/state').length).toBeGreaterThan(0)
  } finally { timers.restore() }
})

test('GitLab active polling uses the same candidate and active reason without an immediate retry', async () => {
  const timers = controlledWindowTimers()
  try {
    const harness = createHarness({ initialState: stateFor(), view: CHECKS_PANEL, openChecks: true })
    const mounted = mountSurface(harness, CHECKS_PANEL)
    await settle()
    const initialReport = visibleCandidateCall(harness)
    expect(initialReport?.params).toMatchObject({ candidates: [{ worktree: WORKTREE, active: true, branch: 'feature', number: NUMBER, headOid: HEAD }] })
    harness.clearCalls()
    harness.setMethod('quirky.hosting/refresh', async () => ({ kind: 'found', review: reviewFor(), fetchedAt: 1_000_000 }))
    harness.setBackendReply('quirky.hosting/checks', GITLAB_CHECKS_REPLY)
    await act(async () => { timers.runNext() })
    await settle()
    const queue = harness.calls.find((call) => call.method === 'quirky.hosting/refresh')
    expect(queue?.params).toEqual({
      candidate: { worktree: WORKTREE, active: true, branch: 'feature', number: NUMBER, headOid: HEAD },
      reason: 'active', priority: 80,
    })
    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/refresh')).toHaveLength(1)
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')).toHaveLength(1)
    expect(mounted.element.querySelector('.ui-inline-error')).toBeNull()
    expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/checks')).toBe(true)
  } finally { timers.restore() }
})

test('GitLab scheduler pause copy and error precedence preserve the direct read as authoritative', async () => {
  const originalNow = Date.now
  Date.now = () => 1_000_000
  try {
    for (const scenario of [
      { name: 'message-less pause', queue: { kind: 'paused', skippedReason: 'rate-limit', pausedUntil: 1_030_000 }, direct: { ok: true }, expected: 'GitLab refresh paused.', absent: 'GitHub refresh paused.' },
      { name: 'scheduler message', queue: { kind: 'paused', skippedReason: 'rate-limit', pausedUntil: 1_030_000, message: 'scheduler pause fixture' }, direct: { ok: true }, expected: 'scheduler pause fixture', absent: 'GitLab refresh paused.' },
      { name: 'direct read failure', queue: { kind: 'paused', skippedReason: 'rate-limit', pausedUntil: 1_030_000, message: 'scheduler pause fixture' }, direct: { ok: false, error: 'direct read fixture failed' }, expected: 'direct read fixture failed', absent: 'scheduler pause fixture' },
    ]) {
      const timers = controlledWindowTimers()
      try {
        const harness = createHarness({ initialState: stateFor(), view: CHECKS_PANEL, openChecks: true })
        const mounted = mountSurface(harness, CHECKS_PANEL)
        await settle()
        harness.setMethod('quirky.hosting/refresh', async () => scenario.queue)
        if (scenario.direct.ok) harness.setBackendReply('quirky.hosting/checks', GITLAB_CHECKS_REPLY)
        else harness.setBackendReply('quirky.hosting/checks', () => { throw new Error('direct read fixture failed') })
        harness.clearCalls()
        await invokeCurrent(harness, CHECKS_PANEL, 'checks', 'refresh')
        await settle()
        expect(mounted.element.querySelector('.ui-inline-error')?.textContent, scenario.name).toContain(scenario.expected)
        expect(mounted.element.textContent, scenario.name).not.toContain(scenario.absent)
        expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')).toHaveLength(1)
        expect(harness.calls.filter((call) => call.method === 'quirky.hosting/refresh')).toHaveLength(1)
        expect(harness.backend.calls.filter((call) => call.method === 'quirky.hosting/checks')).toHaveLength(1)
      } finally { timers.restore() }
    }
  } finally { Date.now = originalNow }
})
test('GitLab queue-capability fallback keeps a real direct-read failure visible', async () => {
  const timers = controlledWindowTimers()
  try {
    const harness = createHarness({ initialState: stateFor(), view: CHECKS_PANEL, openChecks: true })
    const mounted = mountSurface(harness, CHECKS_PANEL)
    await settle()
    harness.clearCalls()
    harness.setMethod('quirky.hosting/refresh', async () => { throw providerError('unsupported_provider', 'queue unavailable fixture') })
    harness.setBackendReply('quirky.hosting/checks', () => { throw new Error('direct GitLab read failed') })
    await invokeCurrent(harness, CHECKS_PANEL, 'checks', 'refresh')
    await settle()
    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/refresh')).toHaveLength(1)
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')).toHaveLength(1)
    expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain('direct GitLab read failed')
    expect(harness.backend.calls.filter((call) => call.method === 'quirky.hosting/checks')).toHaveLength(1)
    expect(mounted.element.textContent).not.toContain('queue unavailable fixture')
  } finally { timers.restore() }
})


test('non-capability GitLab queue failures do not fall back to a direct read', async () => {
  const harness = createHarness({ initialState: stateFor(), view: CHECKS_PANEL, openChecks: true })
  const mounted = mountSurface(harness, CHECKS_PANEL)
  await settle()
  harness.clearCalls()
  harness.setMethod('quirky.hosting/refresh', async () => { throw providerError('network_error', 'queue network fixture failed') })
  await invokeCurrent(harness, CHECKS_PANEL, 'checks', 'refresh')
  await settle()
  expect(harness.calls.filter((call) => call.method === 'quirky.hosting/refresh')).toHaveLength(1)
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')).toHaveLength(0)
  expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain('queue network fixture failed')
  expect(harness.backend.calls.filter((call) => call.method === 'quirky.hosting/checks')).toHaveLength(0)
})

test('visibility capability refusal stays retryable on a later visible session without immediate retries', async () => {
  const timers = controlledWindowTimers()
  try {
    const harness = createHarness({
      initialState: stateFor(), view: CHECKS_PANEL, openChecks: true,
      methods: { 'quirky.hosting/visibleRefreshCandidates': async (params) => {
        if (Array.isArray(params.candidates) && params.candidates.length === 0) {
          return { accepted: true, generation: params.generation, candidates: 0 }
        }
        throw providerError('unsupported_provider', 'visibility unavailable fixture')
      } },
    })
    const mounted = mountSurface(harness, CHECKS_PANEL)
    await settle()
    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/visibleRefreshCandidates' &&
      Array.isArray(call.params.candidates) && call.params.candidates.length > 0)).toHaveLength(1)
    const visible = harness.context.getLayout()
    harness.setLayout({ ...visible, view: { id: 'view:fixture' }, tools: { open: {} } } as UiLayout)
    await settle()
    expect(harness.calls.some((call) => call.method === 'quirky.hosting/visibleRefreshCandidates' &&
      Array.isArray(call.params.candidates) && call.params.candidates.length === 0)).toBe(true)
    harness.setLayout(visible)
    await settle()
    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/visibleRefreshCandidates' &&
      Array.isArray(call.params.candidates) && call.params.candidates.length > 0)).toHaveLength(2)
    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/refresh')).toHaveLength(0)
    expect(mounted.element.querySelector('.ui-inline-error')).toBeNull()
    expect(mounted.element.textContent).toContain('hello')
  } finally { timers.restore() }
})

test('visibility reports retain ordinary rejected and malformed result errors', async () => {
  for (const [name, reply, message] of [
    ['network rejection', () => { throw providerError('network_error', 'visibility network failure') }, 'visibility network failure'],
    ['not accepted', () => ({ accepted: false, generation: 1, candidates: 1 }), 'GitLab did not accept the Checks visibility candidate set.'],
  ] as const) {
    const timers = controlledWindowTimers()
    try {
      const harness = createHarness({
        initialState: stateFor(), view: CHECKS_PANEL, openChecks: true,
        methods: { 'quirky.hosting/visibleRefreshCandidates': async () => reply() },
      })
      const mounted = mountSurface(harness, CHECKS_PANEL)
      await settle()
      expect(harness.calls.filter((call) => call.method === 'quirky.hosting/visibleRefreshCandidates'), name).toHaveLength(1)
      expect(mounted.element.textContent, name).toContain(message)
    } finally { timers.restore() }
  }
})

test('held GitLab queue and visibility completions are fenced by replacement provider and repository identity', async () => {
  const timers = controlledWindowTimers()
  try {
    const firstState = stateFor()
    const initialReport = deferred<unknown>()
    let reports = 0
    const harness = createHarness({
      initialState: firstState, view: CHECKS_PANEL, openChecks: true,
      methods: {
        'quirky.hosting/visibleRefreshCandidates': async (params) => {
          reports += 1
          if (reports === 1) return initialReport.promise
          return { accepted: true, generation: params.generation, candidates: 1 }
        },
      },
    })
    const mounted = mountSurface(harness, CHECKS_PANEL)
    await settle()
    harness.setState(stateFor({ repo: OTHER_REPO, provider: 'github', review: reviewFor({ repo: OTHER_REPO, provider: 'github' }) }))
    await settle()
    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/visibleRefreshCandidates')).toHaveLength(2)
    await act(async () => { initialReport.resolve({ accepted: false, generation: 1, candidates: 1 }) })
    await settle()
    expect(mounted.element.textContent).not.toContain('did not accept')

    const current = currentControl(harness, CHECKS_PANEL, 'checks')
    const heldQueue = harness.holdNext('quirky.hosting/refresh')
    await invoke(harness, current, 'refresh')
    await settle()
    harness.setState(stateFor({ repo: REPO, provider: 'gitlab' }))
    await settle()
    const replacement = currentControl(harness, CHECKS_PANEL, 'checks')
    const freshQueue = harness.holdNext('quirky.hosting/refresh')
    await invoke(harness, replacement, 'refresh')
    await settle()
    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/refresh')).toHaveLength(2)
    await act(async () => { heldQueue.resolve({ kind: 'found', review: reviewFor(), fetchedAt: 1_000_000 }) })
    await settle()
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')).toHaveLength(0)
    expect(mounted.element.querySelector('.ui-inline-error')).toBeNull()
    expect(harness.calls.filter((call) => call.method === 'quirky.hosting/refresh')).toHaveLength(2)
    await act(async () => { freshQueue.resolve({ kind: 'found', review: reviewFor(), fetchedAt: 1_000_000 }) })
    await settle()
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')).toHaveLength(1)
  } finally { timers.restore() }
})

function settingsSnapshot(provider: 'github' | 'gitlab' | null): ReviewsState {
  const repo = provider === 'github' ? GITHUB_REPO : REPO
  const state = stateFor({ repo, provider: provider ?? 'gitlab' })
  state.settings = {
    ...state.settings, provider, repository: provider === null ? null : repo,
    diagnostics: provider === 'github' ? GITHUB_DIAGNOSTICS : provider === 'gitlab' ? diagnostics() : null,
    accounts: null, configuration: null, budget: null,
  }
  return state
}

test('resolving hosting identity does not cancel an in-flight defaults read', async () => {
  const defaults = deferred<unknown>()
  const refresh = deferred<unknown>()
  const harness = createHarness({
    initialState: settingsSnapshot(null), view: SETTINGS_VIEW,
    methods: {
      'quirky.reviews/hostingSettingsRefresh': () => refresh.promise,
      'quirky.reviews/creationDefaults': (params) => params.scope === 'repository'
        ? { defaults: CREATE_DEFAULTS, repoId: 'fixture-repo', overrides: {} } : defaults.promise,
    },
  })
  const mounted = mountSurface(harness, SETTINGS_VIEW)
  try {
    await settle()
    const reads = harness.calls.filter((call) => call.method === 'quirky.reviews/creationDefaults').length
    expect(reads).toBeGreaterThan(0)
    harness.setState(settingsSnapshot('gitlab'))
    await settle()
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/creationDefaults')).toHaveLength(reads)
    await act(async () => { defaults.resolve({ defaults: CREATE_DEFAULTS }); await defaults.promise })
    await settle()
    expect(actionEnabled(currentControl(harness, SETTINGS_VIEW, 'settings-defaults-global'), 'defaults-set')).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toHaveLength(1)
  } finally {
    mounted.unmount()
    await act(async () => {
      defaults.resolve({ defaults: CREATE_DEFAULTS })
      refresh.resolve({ worktree: WORKTREE, refreshed: true, fetchedAt: Date.now() })
      await Promise.all([defaults.promise, refresh.promise])
    })
  }
})

for (const provider of ['github', 'gitlab'] as const) {
  test(`${provider} settings retry failed initial discovery through the mounted control`, async () => {
    const initial = settingsSnapshot(null)
    initial.settings.fetchedAt = 0
    const harness = createHarness({
      initialState: initial, view: SETTINGS_VIEW, connectionId: 42,
      backendReplies: {
        'quirky.hosting/repository': () => { throw new Error('repository temporarily unavailable') },
        'quirky.hosting/diagnoseAuth': provider === 'github' ? GITHUB_DIAGNOSTICS : GITLAB_DIAGNOSTICS,
        'quirky.hosting/accounts': { requiredHost: GITHUB_REPO.host, accounts: [] },
        'quirky.hosting/configuration': { worktreeId: WORKTREE, issueSourcePreference: 'auto', account: null },
        'quirky.hosting/rateLimit': {
          core: { limit: 5000, remaining: 4999, resetAt: 1 },
          search: { limit: 30, remaining: 29, resetAt: 1 },
          graphql: { limit: 5000, remaining: 4999, resetAt: 1 },
          fetchedAt: 1,
        },
      },
    })
    const mounted = mountSurface(harness, SETTINGS_VIEW)
    await settle()
    expect(mounted.element.textContent).toContain('repository temporarily unavailable')
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toEqual([
      { method: 'quirky.reviews/hostingSettingsRefresh', params: { worktree: WORKTREE, forceBudget: true } },
    ])
    expect(harness.backend.env.view(WORKTREE).settings).toMatchObject({
      provider: null, repository: null, diagnostics: null, loading: false,
    })
    const hosting = currentControl(harness, SETTINGS_VIEW, 'settings-hosting')
    for (const action of ['account-select', 'account-save', 'budget-refresh']) {
      expect(actionEnabled(hosting, action)).toBe(false)
      expect(await invoke(harness, hosting, action)).toEqual({ delivered: false, reason: 'disabled' })
    }
    expect(harness.backend.calls.filter((call) => call.method.startsWith('quirky.hosting/'))).toEqual([
      { method: 'quirky.hosting/repository', params: { worktree: WORKTREE } },
    ])
    expect(actionEnabled(hosting, 'provider-recheck')).toBe(true)
    const retry = button(mounted.element, 'Retry hosting')
    expect(retry.disabled).toBe(false)
    const repo = provider === 'github' ? GITHUB_REPO : REPO
    harness.setBackendReply('quirky.hosting/repository', { provider, repository: repo })
    harness.clearCalls()
    act(() => retry.click())
    await settle()
    expect(harness.calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(1)
    expect(harness.calls.filter((call) => call.method === 'ui.window.command.run')).toEqual([
      { method: 'ui.window.command.run', params: {
        connId: 42, id: CONTROL,
        args: { target: hosting.target, generation: hosting.generation, action: 'provider-recheck' },
      } },
    ])
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toEqual([
      { method: 'quirky.reviews/hostingSettingsRefresh', params: { worktree: WORKTREE, forceBudget: true } },
    ])
    expect(harness.backend.calls.filter((call) => call.method === 'quirky.hosting/repository')).toEqual([
      { method: 'quirky.hosting/repository', params: { worktree: WORKTREE } },
    ])
    expect(harness.backend.calls.filter((call) => call.method === 'quirky.hosting/diagnoseAuth')).toEqual([
      { method: 'quirky.hosting/diagnoseAuth', params: { worktree: WORKTREE } },
    ])
    expect(harness.backend.env.view(WORKTREE).settings).toMatchObject({
      provider, repository: repo, diagnostics: provider === 'github' ? GITHUB_DIAGNOSTICS : GITLAB_DIAGNOSTICS,
      loading: false, error: null,
    })
    expect(mounted.element.textContent).not.toContain('repository temporarily unavailable')
    expect(mounted.element.textContent).not.toContain('Retry hosting')
    expect(mounted.element.querySelector(`article[aria-label="${provider === 'github' ? 'GitHub' : 'GitLab'}"]`)?.textContent).toContain('Connected')
    expect(button(mounted.element, provider === 'github' ? 'Re-check GitHub' : 'Re-check GitLab').disabled).toBe(false)
    if (provider === 'gitlab') {
      expect(harness.backend.calls.filter((call) => /\/(?:accounts|configuration|configure|rateLimit)$/.test(call.method))).toEqual([])
    }
  })

  test(`${provider} settings initialize once while unresolved identity becomes known`, async () => {
    const refresh = deferred<unknown>()
    const harness = createHarness({
      initialState: settingsSnapshot(null), view: SETTINGS_VIEW,
      methods: { 'quirky.reviews/hostingSettingsRefresh': () => refresh.promise },
    })
    const mounted = mountSurface(harness, SETTINGS_VIEW)
    try {
      await settle()
      expect(harness.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toHaveLength(1)
      expect(await invokeCurrent(harness, SETTINGS_VIEW, 'settings-defaults-global', 'defaults-scope', { scope: 'repository' })).toMatchObject({ delivered: true })
      const defaultsReads = harness.calls.filter((call) => call.method === 'quirky.reviews/creationDefaults').length
      expect(defaultsReads).toBeGreaterThan(0)
      harness.setState(settingsSnapshot(provider))
      await settle()
      expect(harness.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toHaveLength(1)
      expect(harness.calls.filter((call) => call.method === 'quirky.reviews/creationDefaults')).toHaveLength(defaultsReads)
      expect(currentControl(harness, SETTINGS_VIEW, 'settings-defaults-repository').slot).toBe('settings-defaults-repository')
      expect(mounted.element.querySelector<HTMLInputElement>('input[value="repository"]')?.checked).toBe(true)
    } finally {
      mounted.unmount()
      await act(async () => { refresh.resolve({ worktree: WORKTREE, refreshed: true, fetchedAt: Date.now() }); await refresh.promise })
    }
  })

  test(`${provider} settings keep provider errors and recheck in the selected card`, async () => {
    const refresh = deferred<unknown>()
    const state = settingsSnapshot(provider)
    state.settings.error = 'provider diagnosis fixture failed'
    const harness = createHarness({
      initialState: state, view: SETTINGS_VIEW,
      methods: { 'quirky.reviews/hostingSettingsRefresh': () => refresh.promise },
    })
    const mounted = mountSurface(harness, SETTINGS_VIEW)
    try {
      await settle()
      const name = provider === 'github' ? 'GitHub' : 'GitLab'
      const card = mounted.element.querySelector<HTMLElement>(`article[aria-label="${name}"]`)
      expect(card).not.toBeNull()
      expect(card?.querySelector('.ui-inline-error')?.textContent).toContain('provider diagnosis fixture failed')
      expect(card?.querySelector('button')?.textContent).toContain('Re-check')
      expect(listReviewsUiControls(harness.context, SETTINGS_VIEW).filter((control) => control.slot === 'settings-hosting')).toHaveLength(1)
      if (provider === 'gitlab') {
        const notices = [...mounted.element.querySelectorAll('.ui-notice-line')].map((node) => node.textContent)
        expect(notices).toContain('Account binding is unavailable for GitLab.')
        expect(notices).toContain('API budget is unavailable for GitLab.')
      }
    } finally {
      mounted.unmount()
      await act(async () => { refresh.resolve({ worktree: WORKTREE, refreshed: false, fetchedAt: 0, error: 'provider diagnosis fixture failed' }); await refresh.promise })
    }
  })
}

for (const identityShape of ['explicit-null', 'explicit-undefined', 'fresh-absent'] as const) {
  test(`unresolved settings ${identityShape} stay neutral without budget timers or reads`, async () => {
    const initial = settingsSnapshot(null)
    if (identityShape === 'explicit-undefined') {
      initial.settings.provider = undefined
      initial.settings.repository = undefined
    } else if (identityShape === 'fresh-absent') {
      delete initial.settings.provider
      delete initial.settings.repository
      initial.settings.fetchedAt = 0
    }
    const refresh = deferred<unknown>()
    const harness = createHarness({
      initialState: initial, view: SETTINGS_VIEW,
      methods: { 'quirky.reviews/hostingSettingsRefresh': () => refresh.promise },
    })
    const originalSet = window.setInterval
    const originalClear = window.clearInterval
    const intervals: number[] = []
    let mounted: MountedSurface | undefined
    try {
      window.setInterval = ((_handler: TimerHandler, delay?: number) => { intervals.push(delay ?? 0); return intervals.length }) as typeof window.setInterval
      window.clearInterval = (() => {}) as typeof window.clearInterval
      mounted = mountSurface(harness, SETTINGS_VIEW)
      await settle()
      expect(mounted.element.querySelector('article[aria-label="GitHub"]')?.textContent).not.toContain('Checking GitHub')
      expect(mounted.element.textContent).not.toContain('Loading GitHub API budget')
      expect(intervals).toHaveLength(0)
      const control = currentControl(harness, SETTINGS_VIEW, 'settings-hosting')
      expect(actionEnabled(control, 'budget-refresh')).toBe(false)
      expect(await invoke(harness, control, 'budget-refresh')).toEqual({ delivered: false, reason: 'disabled' })
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      await settle()
      expect(harness.calls.filter((call) => call.method === 'quirky.reviews/hostingBudget')).toHaveLength(0)
    } finally {
      mounted?.unmount()
      await act(async () => { refresh.resolve({ worktree: WORKTREE, refreshed: false, fetchedAt: 0 }); await refresh.promise })
      window.setInterval = originalSet
      window.clearInterval = originalClear
    }
  })
}

test('GitHub files navigation mounts the actual files control that GitLab omits', async () => {
  const harness = createHarness({ initialState: stateFor({ repo: GITHUB_REPO, provider: 'github', detailTab: 'files' }), view: REVIEW_VIEW })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  await settle()
  expect(mounted.element.querySelector('[aria-label="Files changed"]')).not.toBeNull()
  expect(listReviewsUiControls(harness.context, REVIEW_VIEW).map((control) => control.slot)).toContain('files-changed')
})

test('Checks auth copy identifies GitLab and preserves the GitHub CLI diagnostics label', async () => {
  const gitlab = createHarness({ initialState: unavailableChecksState(), view: CHECKS_PANEL, openChecks: true })
  const gitlabSurface = mountSurface(gitlab, CHECKS_PANEL)
  await settle()
  expect(gitlabSurface.element.textContent).toContain('Connect GitLab')
  expect(gitlabSurface.element.textContent).not.toContain('Connect GitHub')
  expect(gitlabSurface.element.textContent).not.toContain('gh auth login')
  const githubState = stateFor({ repo: GITHUB_REPO, provider: 'github' })
  githubState.checks.review = null
  githubState.checks.lookup = { kind: 'unsupported', reason: 'not_authenticated', authDiagnostics: GITHUB_DIAGNOSTICS }
  githubState.checks.eligibility = { eligible: false, reason: 'authentication_required', authDiagnostics: GITHUB_DIAGNOSTICS }
  const github = createHarness({ initialState: githubState, view: CHECKS_PANEL, openChecks: true })
  const githubSurface = mountSurface(github, CHECKS_PANEL)
  await settle()
  expect(githubSurface.element.textContent).toContain('GitHub CLI diagnostics')
})

for (const failures of [[], ['first partial fixture', 'second partial fixture']]) {
  test(`partial comment copy preserves ${failures.length} failures without doubled punctuation`, async () => {
    const harness = createHarness({ initialState: stateFor({ comments: commentsEnvelope(undefined, true, failures) }), view: REVIEW_VIEW })
    const mounted = mountSurface(harness, REVIEW_VIEW)
    await settle()
    const text = [...mounted.element.querySelectorAll('p')].find((node) => node.textContent?.startsWith('Showing a limited set of comments'))?.textContent
    expect(text).toBeDefined()
    expect(text).not.toMatch(/comments\.\.|comments\.;/)
    if (failures.length === 0) expect(text).toBe('Showing a limited set of comments.')
    for (const failure of failures) expect(text).toContain(failure)
  })
}

test('GitHub Resolve remains available during an independent comment operation', async () => {
  const pending = deferred<unknown>()
  const initial = stateFor({ repo: GITHUB_REPO, provider: 'github' })
  initial.detail.commentDraft = 'pending GitHub comment'
  const harness = createHarness({ initialState: initial, view: REVIEW_VIEW, backendReplies: { 'quirky.hosting/reviewConversation': () => pending.promise } })
  const mounted = mountSurface(harness, REVIEW_VIEW)
  try {
    await settle()
    await invokeCurrent(harness, REVIEW_VIEW, 'comment-composer', 'comment-send')
    await settle()
    expect(harness.backend.calls.some((call) => call.method === 'quirky.hosting/reviewConversation' && call.params?.action === 'add')).toBe(true)
    expect(actionEnabled(currentControl(harness, REVIEW_VIEW, 'comment-composer'), 'comment-send')).toBe(false)
    expect(button(mounted.element, 'Resolve').disabled).toBe(false)
    expect(actionEnabled(currentControl(harness, REVIEW_VIEW, 'comments'), 'thread-set')).toBe(true)
  } finally {
    await act(async () => { pending.reject(new Error('finish pending comment fixture')); await pending.promise.catch(() => undefined) })
  }
})

for (const provider of ['github', 'gitlab'] as const) {
  for (const outcome of ['paused', 'failed'] as const) {
    test(`${provider} refresh ${outcome} alert survives a same-MR head advance`, async () => {
      const queue = deferred<unknown>()
      const repo = provider === 'github' ? GITHUB_REPO : REPO
      const initial = stateFor({ repo, provider })
      const advanced = stateFor({ repo, provider })
      const nextHead = 'c'.repeat(40)
      advanced.checks.review = { ...reviewFor({ repo, provider }), headRefOid: nextHead }
      advanced.checks.lookup = { ...advanced.checks.lookup, gitStatus: { branch: 'feature', head: nextHead } }
      advanced.checks.checks = { ...GITLAB_CHECKS_REPLY, headSha: nextHead }
      const harness = createHarness({
        initialState: initial, view: CHECKS_PANEL, openChecks: true,
        backendReplies: {
          'quirky.hosting/repository': { provider, repository: repo },
          'quirky.hosting/review': { kind: 'found', review: advanced.checks.review, fetchedAt: Date.now() },
          'quirky.git/status': { ...GITLAB_STATUS, head: nextHead },
          'quirky.hosting/checks': { ...GITLAB_CHECKS_REPLY, headSha: nextHead },
          ...(provider === 'github' ? { 'quirky.hosting/reviewStack': { number: NUMBER, available: false, truncated: false, reason: 'stack_unavailable', message: 'No stack' } } : {}),
        },
      })
      const timers = controlledWindowTimers()
      let mounted: MountedSurface | undefined
      try {
        mounted = mountSurface(harness, CHECKS_PANEL)
        await settle()
        harness.clearCalls()
        harness.setMethod('quirky.hosting/refresh', () => queue.promise)
        await invokeCurrent(harness, CHECKS_PANEL, 'checks', 'refresh')
        await settle()
        expect(harness.calls.find((call) => call.method === 'quirky.hosting/refresh')?.params.candidate).toMatchObject({ headOid: HEAD })
        harness.setState(advanced)
        await settle()
        await act(async () => {
          if (outcome === 'paused') queue.resolve({ kind: 'paused', skippedReason: 'rate-limit', pausedUntil: Date.now() + 30_000 })
          else queue.reject(providerError('network_error', 'head advance refresh failed'))
          await queue.promise.catch(() => undefined)
        })
        await settle()
        expect(harness.backend.env.view(WORKTREE).checks.review?.headRefOid).toBe(nextHead)
        expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain(outcome === 'paused'
          ? `${provider === 'github' ? 'GitHub' : 'GitLab'} refresh paused.` : 'head advance refresh failed')
        expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')).toHaveLength(outcome === 'paused' ? 1 : 0)
      } finally {
        mounted?.unmount()
        queue.resolve({ kind: 'found', review: advanced.checks.review, fetchedAt: Date.now() })
        timers.restore()
      }
    })
  }
}

const FRAGMENT_PATH = 'plugins/quirky.reviews/ui-scoreboard/review-and-comments.json'
let inventory: Inventory
let plugin: PluginInventory
let uiFiles: string[]
let candidates: Candidate[]
const fragments = new Map<string, CoverageFile>()

function fragmentContent(subject: PluginInventory, file: string): string {
  return subject.coverageFragments?.find((entry) => entry.file === file)?.content ?? ''
}

function withFragment(subject: PluginInventory, file: string, value: CoverageFile): PluginInventory {
  return {
    ...subject,
    coverageFragments: subject.coverageFragments?.map((entry) => entry.file === file
      ? { ...entry, content: JSON.stringify(value) }
      : entry),
  }
}

function candidateAt(ref: Ref, category: Candidate['category'], anchor?: string): Candidate {
  const resolved = resolveRef(plugin, uiFiles, ref)
  if ('code' in resolved) throw new Error(resolved.message)
  const candidate = selectCandidate(resolved, candidates, category, anchor)
  if ('code' in candidate) throw new Error(candidate.message)
  return candidate
}

function auditFailures(subject: PluginInventory) {
  const graph = discoverUiFiles(subject)
  return auditPlugin(inventory, subject).flatMap((check) => check.evidence.filter((entry) => {
    if (PASS[entry.code]) return false
    if (entry.code === 'coverage-missing' && entry.source && graph.files.includes(entry.source.file) && !OWNED_UI.includes(entry.source.file)) return false
    return true
  }))
}

function missingCandidate(subject: PluginInventory, candidate: Candidate): boolean {
  const source = plugin.sources.find((entry) => entry.file === candidate.file)!
  const line = source.content.slice(0, candidate.anchorStart).split('\n').length
  return auditPlugin(inventory, subject).some((check) => check.evidence.some((entry) =>
    entry.code === 'coverage-missing' && entry.source?.file === candidate.file && entry.source.line === line))
}

function removeWitness(subject: PluginInventory, file: string, witness: CoverageFile['states'][number] | CoverageFile['actions'][number]) {
  const coverage = parseCoverage(fragmentContent(subject, file))
  const key = JSON.stringify(witness)
  if ('state' in witness) {
    let removed = false
    const states = coverage.states.filter((entry) => {
      if (removed || JSON.stringify(entry) !== key) return true
      removed = true
      return false
    })
    if (!removed) throw new Error('The selected state witness is not in its coverage fragment.')
    return withFragment(subject, file, { ...coverage, states })
  }
  let removed = false
  const actions = coverage.actions.filter((entry) => {
    if (removed || JSON.stringify(entry) !== key) return true
    removed = true
    return false
  })
  if (!removed) throw new Error('The selected action witness is not in its coverage fragment.')
  return withFragment(subject, file, { ...coverage, actions })
}

beforeAll(() => {
  inventory = collectInventory(resolve(import.meta.dir, '../../..'))
  expect(inventory.failures).toEqual([])
  plugin = inventory.plugins.find((entry) => entry.id === 'quirky.reviews')!
  expect(plugin).toBeDefined()
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  uiFiles = graph.files
  candidates = discoverCandidates(plugin, uiFiles)
  for (const file of STATE_FRAGMENTS) {
    const fragment = plugin.coverageFragments?.find((entry) => entry.file === file)
    expect(fragment, file).toBeDefined()
    fragments.set(file, parseCoverage(fragment!.content))
  }
})

test('the unfiltered production graph classifies every candidate in the six changed UI sources', () => {
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toContain('plugins/quirky.reviews/src/link-routing.tsx')
  const owned = candidates.filter((candidate) => OWNED_UI.includes(candidate.file))
  expect(owned.length).toBeGreaterThan(0)
  expect(auditFailures(plugin)).toEqual([])
  for (const file of OWNED_UI) expect(graph.files).toContain(file)
})

test('all three GitLab UI evidence fragments keep one physical line per entry', () => {
  for (const [file, coverage] of fragments) {
    const text = fragmentContent(plugin, file)
    const lines = text.split('\n')
    for (const section of ['states', 'notState', 'actions'] as const) {
      const start = lines.findIndex((line) => line.trim() === `"${section}": [`)
      const end = lines.findIndex((line, index) => index > start && ['],', ']'].includes(line.trim()))
      expect(start, `${file} ${section}`).toBeGreaterThanOrEqual(0)
      expect(end, `${file} ${section}`).toBeGreaterThan(start)
      const entries = lines.slice(start + 1, end).filter((line) => line.trim().startsWith('{'))
      expect(entries, `${file} ${section}`).toHaveLength(coverage[section].length)
      for (const line of entries) expect(line.trim()).toMatch(/^\{.*\},?$/)
    }
  }
})

test('removing one new GitLab state or action witness exposes its exact production candidate', () => {
  let checked = 0
  for (const [file, coverage] of fragments) {
    const witnesses = [...coverage.states, ...coverage.actions].filter((entry) =>
      OWNED_UI.includes(entry.site.file) && /gitlab|merge request/i.test(entry.site.quote))
    const witness = witnesses[0]
    if (!witness) continue
    const category = 'state' in witness ? 'state' : 'action'
    const candidate = candidateAt(witness.site, category, witness.anchor)
    expect(missingCandidate(removeWitness(plugin, file, witness), candidate)).toBe(true)
    checked += 1
  }
  expect(checked).toBeGreaterThan(0)
})
