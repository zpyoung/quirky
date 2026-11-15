import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { ReviewPage } from '../src/detail/ReviewPage'
import { Comments } from '../src/detail/Comments'
import type { ReviewData, ReviewsState } from '../src/contracts'
import { listReviewsUiControls, requestReviewsUiControl, type ReviewsUiControlResult } from '../src/checks/data'
import { activate } from '../src/ui'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOST = 'github.com'
const WORKTREE = '/work/a'
const REPO = { host: HOST, owner: 'test-owner', repo: 'test-repo' }
const roots: Root[] = []

type Call = { method: string; params: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
type RenderProps = { context: UiPluginContext; state: ReviewsState; refresh(): Promise<void>; snapshot?: number }
type Mounted = {
  element: HTMLElement
  context: UiPluginContext
  calls: Call[]
  render(state: ReviewsState, snapshot?: number): void
  unmount(): void
  holdNext(method: string): Deferred<unknown>
  initialHold(method: string): Deferred<unknown> | undefined
  provided(id: string): unknown
  holdConfirmation(): Deferred<boolean>
  replyNext(method: string, value: unknown): void
  toasts: string[]
}

type StateOptions = {
  owner?: boolean
  review?: ReviewData | null
  worktree?: string
  number?: number
  generation?: number
  headOid?: string
  viewerCanUpdate?: boolean
  detailLoading?: boolean
  detailError?: string | null
  checksLoading?: boolean
  checksError?: string | null
  detailComments?: unknown
  checksComments?: unknown
  detailAudience?: 'all' | 'humans' | 'bots'
  checksAudience?: 'all' | 'humans' | 'bots'
  detailGrouping?: 'grouped' | 'timeline'
  checksGrouping?: 'grouped' | 'timeline'
  detailDraft?: string
  detailBody?: string
  details?: unknown
  assignmentData?: 'known' | 'unknown'
}

function reviewFor(body = 'old body', number = 12, headOid = 'a'.repeat(40)): ReviewData {
  return {
    provider: 'github', number, url: `https://${HOST}/test-owner/test-repo/pull/${number}`,
    title: `Review ${number}`, body, state: 'open', headRefName: 'feature', baseRefName: 'main',
    headRefOid: headOid, baseRefOid: 'b'.repeat(40), mergeable: 'MERGEABLE',
    checksStatus: 'passing', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
    autoMergeRequest: null, stack: null, mergeMethods: null, prRepo: REPO,
    assignees: [], requestedReviewers: [], reviews: [],
  } as ReviewData
}

function commentsEnvelope(comments: unknown[] = [], number = 12) {
  return { number, comments, partial: false, partialFailures: [] }
}

function stateFor(options: StateOptions = {}): ReviewsState {
  const number = options.number ?? 12
  const worktree = options.worktree ?? WORKTREE
  const generation = options.generation ?? 1
  const headOid = options.headOid ?? 'a'.repeat(40)
  const sourceReview = options.review === undefined ? reviewFor(options.detailBody, number, headOid) : options.review
  const review = sourceReview === null || options.assignmentData !== 'unknown'
    ? sourceReview
    : { ...sourceReview, assignees: null, requestedReviewers: null, reviews: null } as ReviewData
  const hasOwner = options.owner !== false
  const assignment = options.assignmentData === 'unknown'
    ? { assignees: null, requestedReviewers: null, reviews: null }
    : { assignees: [], requestedReviewers: [], reviews: [] }
  const details = options.details === undefined
    ? { item: { viewerCanUpdate: options.viewerCanUpdate ?? true, ...assignment }, participants: [{ login: 'alice' }] }
    : options.details
  const commentValues = commentsEnvelope([], number)
  return {
    revision: 1,
    previousView: null,
    detail: {
      target: hasOwner ? { worktree, number, prRepo: REPO } : null,
      tab: 'conversation', generation, loading: options.detailLoading ?? false,
      error: options.detailError ?? null, review: hasOwner ? review : null, details,
      checks: { number, headSha: headOid, rollup: 'success', checks: [], partial: false, partialFailures: [] },
      comments: options.detailComments === undefined ? commentValues : options.detailComments,
      files: { number, files: [], truncated: false, filesUnavailable: false, partialFailures: [] },
      audience: options.detailAudience ?? 'all', grouping: options.detailGrouping ?? 'grouped',
      expandedChecks: [], queuedComments: [], checksCollapsed: false, selectedFile: null, diffMode: 'inline',
      collapsedFiles: [], fileFilter: '', fileTreeVisible: true, commentDraft: options.detailDraft ?? '',
      bodyDraft: null, pending: [], fetchedAt: Date.now(),
    },
    checks: {
      worktree, generation, loading: options.checksLoading ?? false,
      error: options.checksError ?? null, lookup: null, eligibility: null, review,
      checks: { number, headSha: headOid, rollup: 'success', checks: [], partial: false, partialFailures: [] },
      comments: options.checksComments === undefined ? commentValues : options.checksComments,
      conflicts: null, audience: options.checksAudience ?? 'all', grouping: options.checksGrouping ?? 'grouped',
      expandedChecks: [], queuedComments: [], checksCollapsed: false, commentDraft: '',
      titleDraft: null, height: 320, fetchedAt: Date.now(), agentDialog: null,
    },
    creation: {
      worktree, generation: 1, loading: false, error: null,
      eligibility: { eligible: true, confirmedAt: Date.now() }, title: 'Create title', body: 'Create body',
      base: 'main', head: 'feature', draft: false, useTemplate: false,
      bases: ['main'], generating: false, requestId: null, submitting: false, generated: false,
      result: null, defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false },
    },
    settings: { worktree, generation: 1, loading: false, error: null, diagnostics: null, accounts: null, configuration: null, budget: null, fetchedAt: 0 },
    defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false },
    repoDefaults: {}, botOverrides: [], links: {}, suppressed: {},
  } as unknown as ReviewsState
}

function deferred<T = unknown>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function mount(renderNode: (props: RenderProps) => ReactNode, initialState = stateFor(), initialHolds: string[] = []): Mounted {
  const calls: Call[] = []
  const provided = new Map<string, unknown>()
  const held = new Map<string, Deferred<unknown>[]>()
  const initialHeld = new Map<string, Deferred<unknown>>()
  const replies = new Map<string, unknown[]>()
  const confirmations: Deferred<boolean>[] = []
  const toasts: string[] = []
  for (const method of initialHolds) {
    const request = deferred<unknown>()
    initialHeld.set(method, request)
    held.set(method, [request])
  }
  const layout = {
    view: { id: 'view:quirky.reviews/review' }, worktree: WORKTREE,
    panel: null, sidebar: true, focus: 'view', tools: { open: {} },
  } as unknown as UiLayout
  let state = initialState
  const context = {
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    pluginId: 'quirky.reviews',
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      const request = held.get(method)?.shift()
      if (held.get(method)?.length === 0) held.delete(method)
      if (request) return request.promise
      if (replies.get(method)?.length) return replies.get(method)!.shift()
      if (method === 'ui.window.self') return { connId: 42 }
      if (method === 'ui.window.command.run') {
        const handler = provided.get(String(params.id))
        if (typeof handler !== 'function') throw new Error(`Missing provided command: ${String(params.id)}`)
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.tasks/state') return { workspaces: [] }
      if (method === 'quirky.reviews/detailSetCommentDraft' || method === 'quirky.reviews/detailSetBodyDraft') return { applied: true }
      return {}
    },
    getLayout: () => layout,
    onLayout: () => () => {},
    onConnection: () => () => {},
    subscribe: () => () => {},
    getSetting: () => undefined,
    toast(_title: string, body: string) { toasts.push(body) },
    confirm: async () => confirmations.shift()?.promise ?? false,
    log() {},
  } as unknown as UiPluginContext
  activate(context)
  const refresh = async () => { await context.call('quirky.reviews/state', { worktree: WORKTREE }) }
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  let snapshot: number | undefined = 0
  const draw = () => root.render(renderNode({ context, state, refresh, snapshot }))
  act(draw)
  return {
    element, context, calls, toasts,
    initialHold: (method) => initialHeld.get(method),
    provided: (id) => provided.get(id),
    holdConfirmation() { const value = deferred<boolean>(); confirmations.push(value); return value },
    replyNext(method, value) { replies.set(method, [...(replies.get(method) ?? []), value]) },
    unmount() {
      roots.splice(roots.indexOf(root), 1)
      act(() => root.unmount())
      element.remove()
    },
    render(next, nextSnapshot = 0) {
      state = next
      snapshot = nextSnapshot
      act(draw)
    },
    holdNext(method) {
      const request = deferred<unknown>()
      held.set(method, [...(held.get(method) ?? []), request])
      return request
    },
  }
}

function mountPage(state = stateFor(), initialHolds: string[] = []): Mounted {
  return mount((props) => <ReviewPage {...props} />, state, initialHolds)
}


async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => {})
}

async function advanceDebounce(milliseconds: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, milliseconds + 20)) })
  await settle()
}

async function click(node: HTMLButtonElement) {
  await act(async () => { node.click() })
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label)
  if (!found) throw new Error(`Could not find the ${label} button.`)
  return found
}

function changeValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  node.value = value
  const key = Object.getOwnPropertyNames(node).find((candidate) => candidate.startsWith('__reactProps$'))
  if (!key) throw new Error('Could not find React event handlers on the rendered field.')
  const onChange = (node as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key]!.onChange
  if (!onChange) throw new Error('The rendered field does not have an onChange handler.')
  act(() => onChange({ target: node, currentTarget: node }))
}

afterEach(async () => {
  await settle()
  for (const root of [...roots]) act(() => root.unmount())
  roots.length = 0
  document.body.replaceChildren()
  await settle()
})

afterAll(() => GlobalRegistrator.unregister())

test('B1: detail absence, loading, empty description, and retained failure use shared states', async () => {
  const absent = mountPage(stateFor({ owner: false, review: null }))
  const absentState = absent.element.querySelector('.ui-empty-state')
  expect(absentState?.textContent).toContain('No pull request selected')
  expect(absentState?.textContent).toContain('Open a pull request from Tasks or the Checks panel to view its details.')

  const loading = mountPage(stateFor({ review: null, detailLoading: true }))
  expect(loading.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading pull request…')

  const unavailable = mountPage(stateFor({ review: null }))
  expect(unavailable.element.querySelector('.ui-inline-error')?.textContent).toContain('Pull request details are unavailable.')
  const failed = mountPage(stateFor({ review: null, detailError: 'detail fixture failed' }))

  const detailError = failed.element.querySelector('.ui-inline-error')
  expect(detailError?.textContent).toContain('detail fixture failed')
  expect(detailError?.textContent).toContain('Retry')
  expect(failed.element.textContent?.match(/detail fixture failed/g)).toHaveLength(1)

  const retained = mountPage(stateFor({ detailError: 'detail fixture failed' }))
  expect(retained.element.textContent).toContain('Review 12')
  expect(retained.element.querySelector('.ui-inline-error')?.textContent).toContain('detail fixture failed')
  expect(retained.element.querySelector('.ui-inline-error')?.textContent).toContain('Retry')
  const emptyDescription = mountPage(stateFor({ detailBody: '' }))
  expect(emptyDescription.element.querySelector('.ui-empty-state')?.textContent).toContain('No description.')
  await settle()
})

test('B1 and B9: the mounted page publishes and dispatches its exact-window refresh lease', async () => {
  const ui = mountPage()
  expect(typeof ui.provided('command:quirky.reviews/ui-control')).toBe('function')
  const root = ui.element.querySelector<HTMLElement>('[data-review-control-target]')
  expect(root?.dataset.reviewControlTarget).toBeTruthy()
  expect(Number(root?.dataset.reviewControlGeneration)).toBeGreaterThan(0)
  const descriptor = listReviewsUiControls(ui.context, 'view:quirky.reviews/review').find((control) => control.slot === 'review-page')
  expect(descriptor).toBeDefined()
  let response!: ReviewsUiControlResult
  await act(async () => {
    response = await requestReviewsUiControl(ui.context, {
      target: descriptor!.target, generation: descriptor!.generation, action: 'refresh',
    })
  })
  expect(response).toMatchObject({ delivered: true })
  expect(ui.calls.filter((call) => call.method === 'ui.window.command.run').at(-1)?.params.connId).toBe(42)
  const refresh = ui.calls.filter((call) => call.method === 'quirky.reviews/detailRefresh').at(-1)
  expect(refresh?.params).toMatchObject({ surface: 'detail', worktree: WORKTREE, number: 12, prRepo: REPO })
})

test('B2: workspace discovery stays pending and failure offers a shared retry state', async () => {
  const ui = mountPage(stateFor(), ['quirky.tasks/state'])
  const read = ui.initialHold('quirky.tasks/state')!
  await settle()
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toContain('Checking linked workspace…')
  expect(button(ui.element, 'Start workspace').disabled).toBe(true)

  await act(async () => read.reject(new Error('workspace fixture failed')))
  await settle()
  const failure = ui.element.querySelector('.ui-inline-error')
  expect(failure?.textContent).toContain('Workspace link status unavailable: workspace fixture failed')
  expect(failure?.textContent).toContain('Start and Resume are disabled until the link can be checked.')
  expect(failure?.textContent).toContain('Retry')
  expect(button(ui.element, 'Start workspace').disabled).toBe(true)
})

test('B3: assignment absence and unavailable catalogs are distinct shared states', async () => {
  const empty = mountPage()
  expect([...empty.element.querySelectorAll('.ui-empty-state')].map((node) => node.textContent).join(' ')).toContain('No one assigned.')
  expect([...empty.element.querySelectorAll('.ui-empty-state')].map((node) => node.textContent).join(' ')).toContain('No reviewers requested.')
  expect([...empty.element.querySelectorAll('.ui-empty-state')].map((node) => node.textContent).join(' ')).toContain('No reviews submitted yet.')

  const unavailable = mountPage(stateFor({ assignmentData: 'unknown' }))
  const errors = [...unavailable.element.querySelectorAll('.ui-inline-error')].map((node) => node.textContent).join(' ')
  expect(errors).toContain('Assignee data is unavailable.')
  expect(errors).toContain('Requested reviewer data is unavailable.')
  expect(errors).toContain('Review status is unavailable.')
  await settle()
})

test('B3: opening assignment search reports pending, successful empty, and failed catalog reads', async () => {
  const ui = mountPage()
  const read = ui.holdNext('quirky.hosting/assignees')
  await click(button(ui.element, 'Edit assignees'))
  await advanceDebounce(120)
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toContain('Finding assignable users…')
  await act(async () => read.resolve({ assignees: [] }))
  await settle()
  expect([...ui.element.querySelectorAll('.ui-empty-state')].some((node) => node.textContent?.includes('No matching assignable users.'))).toBe(true)

  await click(button(ui.element, 'Done'))
  const failed = ui.holdNext('quirky.hosting/assignees')
  await click(button(ui.element, 'Edit assignees'))
  await advanceDebounce(120)
  await act(async () => failed.reject(new Error('catalog fixture failed')))
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('catalog fixture failed')
})

test('B4: failed description save uses shared error UI and retains the current text', async () => {
  const ui = mountPage()
  await click(button(ui.element, 'Edit description'))
  const editor = ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')!
  changeValue(editor, 'draft body retained')
  const write = ui.holdNext('quirky.reviews/detailUpdateBody')
  await click(button(ui.element, 'Save description'))
  await settle()
  await act(async () => write.reject(new Error('body fixture failed')))
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('body fixture failed')
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')?.value).toBe('draft body retained')
})


function commentFor(kind: 'issue_comment' | 'review_comment' | 'review' = 'issue_comment', id: number | string = 42) {
  return { kind, id, author: 'alice', body: 'Existing comment', createdAt: null, state: null, path: null, line: null, startLine: null, threadId: kind === 'review_comment' ? 'thread-7' : null, isResolved: kind === 'review_comment' ? false : null, isOutdated: null, reactionSubjectId: null, reactions: [], url: 'https://github.com/test-owner/test-repo/pull/12#issuecomment-42' }
}
function mountComments(surface: 'detail' | 'checks' = 'detail', state = stateFor(), initialHolds: string[] = []) {
  return mount((props) => <Comments {...props} surface={surface} />, state, initialHolds)
}
function control(ui: Mounted, slot: string) {
  const descriptor = listReviewsUiControls(ui.context, 'view:quirky.reviews/review').concat(listReviewsUiControls(ui.context, 'panel:quirky.reviews/checks')).find((entry) => entry.slot === slot || entry.slot.startsWith(`${slot}:`))
  if (!descriptor) throw new Error(`Missing ${slot} control`)
  return descriptor
}
function invoke(ui: Mounted, slot: string, action: string, value?: Record<string, unknown>) {
  const descriptor = control(ui, slot)
  return invokeCaptured(ui, { target: descriptor.target, generation: descriptor.generation, action, ...(value === undefined ? {} : { value }) })
}
function invokeCaptured(ui: Mounted, args: unknown): Promise<unknown> {
  const handler = ui.provided('command:quirky.reviews/ui-control')
  if (typeof handler !== 'function') throw new Error('Missing public Reviews UI handler')
  return Promise.resolve(handler(args))
}
function callCount(ui: Mounted, method: string) { return ui.calls.filter((entry) => entry.method === method).length }
function withComments(comments = [commentFor()]) {
  return stateFor({ detailComments: commentsEnvelope(comments), checksComments: commentsEnvelope(comments) })
}
function changedOwner(state: ReviewsState, kind: 'worktree' | 'repository' | 'number' | 'generation' | 'head') {
  const copy = structuredClone(state)
  if (kind === 'worktree') { copy.detail.target!.worktree = '/work/b'; copy.checks.worktree = '/work/b' }
  if (kind === 'repository') {
    const repo = { ...REPO, owner: 'other' }
    copy.detail.target = { ...copy.detail.target!, prRepo: repo }
    for (const review of [copy.detail.review, copy.checks.review]) if (review) { review.prRepo = repo; review.url = 'https://github.com/other/test-repo/pull/12' }
  }
  if (kind === 'number') {
    copy.detail.target!.number = 13
    for (const review of [copy.detail.review, copy.checks.review]) if (review) { review.number = 13; review.url = 'https://github.com/test-owner/test-repo/pull/13' }
    copy.detail.comments = { ...commentsEnvelope([commentFor()]), number: 13 }
    copy.checks.comments = { ...commentsEnvelope([commentFor()]), number: 13 }
  }
  if (kind === 'generation') { copy.detail.generation++; copy.checks.generation++ }
  if (kind === 'head') for (const review of [copy.detail.review, copy.checks.review]) if (review) review.headRefOid = 'c'.repeat(40)
  return copy
}

for (const surface of ['detail', 'checks'] as const) {
  test(`B5 ${surface}: pending, idle, malformed and failed reads use distinct shared states`, async () => {
    const loading = mountComments(surface, stateFor({ detailComments: null, checksComments: null, detailLoading: true, checksLoading: true }))
    expect(loading.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading comments…')
    const idle = mountComments(surface, stateFor({ detailComments: null, checksComments: null }))
    expect(idle.element.querySelector('.ui-empty-state')?.textContent).toContain('Comments have not been loaded yet.')
    await click(button(idle.element, 'Load comments'))
    expect(idle.calls.find((call) => call.method === 'quirky.reviews/detailRefresh')?.params).toMatchObject({ surface, worktree: WORKTREE, number: 12, prRepo: REPO })
    const malformed = mountComments(surface, stateFor({ detailComments: { invalid: true }, checksComments: { invalid: true }, detailLoading: true, checksLoading: true }))
    expect(malformed.element.querySelector('.ui-inline-error')?.textContent).toContain('The comments response is invalid.')
    const failure = mountComments(surface, stateFor({ detailComments: null, checksComments: null, detailLoading: true, checksLoading: true, detailError: 'read fixture failed', checksError: 'read fixture failed' }))
    expect(failure.element.querySelector('.ui-inline-error')?.textContent).toContain('read fixture failed')
    expect(failure.element.textContent).not.toContain('Loading comments…')
    const retained = withComments()
    retained[surface].error = 'retained fixture failed'
    const retainedUi = mountComments(surface, retained)
    expect(retainedUi.element.textContent).toContain('Existing comment')
    expect(retainedUi.element.querySelector('.ui-inline-error')?.textContent).toContain('Showing the last available comments where present.')
  })
  test(`B5 ${surface}: all audience and ordering empties are shared`, () => {
    for (const audience of ['all', 'humans', 'bots'] as const) for (const grouping of ['grouped', 'timeline'] as const) {
      const ui = mountComments(surface, stateFor({ detailAudience: audience, checksAudience: audience, detailGrouping: grouping, checksGrouping: grouping }))
      expect(ui.element.querySelector('.ui-empty-state')?.textContent).toBe(audience === 'all' ? 'No comments yet.' : audience === 'humans' ? 'No human comments.' : 'No bot comments.')
      ui.unmount()
    }
  })
  test(`B8 ${surface}: queue opens only the existing surface-specific dialog`, async () => {
    const state = stateFor(); state[surface].queuedComments = ['42']
    const ui = mountComments(surface, state)
    await click(button(ui.element, 'Send 1 queued comments to AI'))
    expect(ui.calls.find((call) => call.method === 'quirky.reviews/checksSetAgentDialog')?.params).toEqual(surface === 'checks' ? { surface, worktree: WORKTREE, action: 'comments' } : { surface, action: 'comments' })
    const noOwner = structuredClone(state); noOwner.detail.target = null; noOwner.checks.worktree = null
    ui.render(noOwner)
    await click(button(ui.element, 'Send 1 queued comments to AI'))
    expect(callCount(ui, 'quirky.reviews/checksSetAgentDialog')).toBe(1)
    expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('No pull request is selected.')
  })
}

test('B6: mentions distinguish pending and failed lookup, retain local matches, and reject arbitrary selections', async () => {
  const ui = mountComments('detail', stateFor({ detailDraft: '@ali' }), ['quirky.hosting/assignees'])
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toContain('Finding mention suggestions…')
  await advanceDebounce(180)
  await act(async () => ui.initialHold('quirky.hosting/assignees')!.reject(new Error('mention fixture failed')))
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Some repository suggestions could not be loaded: mention fixture failed')
  await act(async () => { await expect(invoke(ui, 'comment-composer', 'mention-select', { login: 'mallory' })).rejects.toThrow() })
  await act(async () => { await invoke(ui, 'comment-composer', 'mention-select', { login: 'alice' }) })
  await settle()
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')?.value).toBe('@alice ')
})

test('B6: removing a mention invalidates an in-flight read without a successor lookup', async () => {
  const ui = mountComments('detail', stateFor({ detailDraft: '@ali' }), ['quirky.hosting/assignees'])
  await advanceDebounce(180)
  const editor = ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')!
  changeValue(editor, 'no mention')
  await act(async () => ui.initialHold('quirky.hosting/assignees')!.reject(new Error('obsolete mention failure')))
  expect(ui.element.textContent).not.toContain('obsolete mention failure')
  expect(ui.element.querySelector('[aria-label="Mention suggestions"]')).toBeNull()
})

test('B7: composer command and submit share one draft-gated mutation and preserve failed text', async () => {
  const ui = mountComments('detail', stateFor({ detailDraft: 'hello' }))
  const write = ui.holdNext('quirky.reviews/detailPostComment')
  let posting!: Promise<unknown>
  await act(async () => { posting = invoke(ui, 'comment-composer', 'comment-send'); await Promise.resolve() })
  await act(async () => { expect(await invoke(ui, 'comment-composer', 'comment-send')).toEqual({ delivered: false, reason: 'disabled' }) })
  expect(callCount(ui, 'quirky.reviews/detailPostComment')).toBe(1)
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailPostComment')?.params).toMatchObject({ surface: 'detail', worktree: WORKTREE, number: 12, body: 'hello', prRepo: REPO })
  await act(async () => { expect(await posting).toEqual({ delivered: true, result: { accepted: true } }); write.reject(new Error('post fixture failed')) })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('post fixture failed')
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')?.value).toBe('hello')
})

test('B7: image validation, insertion and reopened sessions use the shared draft lane', async () => {
  const ui = mountComments('detail', stateFor({ detailDraft: 'hello' }))
  await act(async () => { await invoke(ui, 'comment-composer', 'image-open') })
  const old = control(ui, 'comment-image')
  for (const [url, message] of [['file:///tmp/a.png', 'Enter an HTTP or HTTPS image URL.'], ['https://x.test/' + 'é'.repeat(4096), 'Image URL must be no longer than 8 KiB.']]) {
    await act(async () => { await expect(invoke(ui, 'comment-image', 'image-insert', { url })).rejects.toThrow(message) })
    expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain(message)
  }
  await act(async () => { await invoke(ui, 'comment-image', 'image-insert', { url: 'https://x.test/a.png' }) })
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')?.value).toBe('hello\n![image](<https://x.test/a.png>)')
  await act(async () => { await invoke(ui, 'comment-image', 'image-close'); await invoke(ui, 'comment-composer', 'image-open') })
  await act(async () => { expect(await invokeCaptured(ui, { target: old.target, generation: old.generation, action: 'image-insert', value: { url: 'https://x.test/stale.png' } })).toEqual({ delivered: false, reason: 'target-unavailable' }) })
})

test('B8: current resources determine edit, queue, thread, bot and safe-link mutations', async () => {
  const issue = commentFor(); const thread = commentFor('review_comment', 43)
  const ui = mountComments('detail', withComments([issue, thread]))
  await act(async () => { await invoke(ui, 'comments', 'edit-open', { comment: { kind: 'issue_comment', id: 42 } }) })
  await act(async () => { await invoke(ui, 'comment-edit', 'edit-save', { body: 'edited body' }) })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailEditComment')?.params).toMatchObject({ commentId: 42, body: 'edited body', worktree: WORKTREE, number: 12 })
  for (const [action, value] of [['queue-set', { queued: true }], ['thread-set', { resolved: true }], ['bot-set', { bot: true }], ['comment-open', {}]] as const) {
    await act(async () => { await invoke(ui, 'comments', action, { comment: { kind: 'review_comment', id: 43 }, ...value }) })
  }
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailQueueComment')?.params).toMatchObject({ commentId: 'thread-7', queued: true })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailResolveThread')?.params).toMatchObject({ threadId: 'thread-7', resolved: true })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailSetBotOverride')?.params).toEqual({ author: 'alice', bot: true })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/openLink')?.params.url).toBe(thread.url)
  for (const value of [{ comment: { kind: 'issue_comment', id: 999 }, queued: true }, { comment: { kind: 'issue_comment', id: 42 }, queued: true, commentId: 'arbitrary' }]) {
    await act(async () => { await expect(invoke(ui, 'comments', 'queue-set', value)).rejects.toThrow() })
  }
  await act(async () => { await expect(invoke(ui, 'comments', 'reply-open', { comment: { kind: 'issue_comment', id: 42 } })).rejects.toThrow() })
})

for (const replacement of ['worktree', 'repository', 'number', 'generation', 'head', 'roundtrip', 'removed', 'unmount'] as const) {
  test(`B8/B10: delete confirmation cannot act after ${replacement} replacement`, async () => {
    const state = withComments(); const ui = mountComments('detail', state)
    const confirmation = ui.holdConfirmation()
    let deleting!: Promise<unknown>
    await act(async () => { deleting = invoke(ui, 'comments', 'comment-delete', { comment: { kind: 'issue_comment', id: 42 } }); await Promise.resolve() })
    if (replacement === 'unmount') ui.unmount()
    else if (replacement === 'removed') ui.render(stateFor())
    else if (replacement === 'roundtrip') { ui.render(changedOwner(state, 'number')); ui.render(state) }
    else ui.render(changedOwner(state, replacement))
    await act(async () => { confirmation.resolve(true); await deleting })
    expect(callCount(ui, 'quirky.reviews/detailDeleteComment')).toBe(0)
  })
}

test('B8: confirmation reserves exclusion and cancel or rejection releases it', async () => {
  const ui = mountComments('detail', withComments())
  const confirmation = ui.holdConfirmation()
  let deleting!: Promise<unknown>
  await act(async () => { deleting = invoke(ui, 'comments', 'comment-delete', { comment: { kind: 'issue_comment', id: 42 } }); await Promise.resolve() })
  await act(async () => { expect(await invoke(ui, 'comments', 'comment-delete', { comment: { kind: 'issue_comment', id: 42 } })).toEqual({ delivered: false, reason: 'disabled' }) })
  await act(async () => { confirmation.resolve(false); await deleting })
  expect(callCount(ui, 'quirky.reviews/detailDeleteComment')).toBe(0)
  const rejection = ui.holdConfirmation()
  await act(async () => { deleting = invoke(ui, 'comments', 'comment-delete', { comment: { kind: 'issue_comment', id: 42 } }); await Promise.resolve() })
  await act(async () => { expect(await deleting).toEqual({ delivered: true, result: { accepted: true } }); rejection.reject(new Error('confirm fixture failed')) })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('confirm fixture failed')
  await act(async () => { await invoke(ui, 'comments', 'comment-delete', { comment: { kind: 'issue_comment', id: 42 } }) })
})

test('B9: page buttons use the auxiliary exact-window route and failed delivery has no local fallback', async () => {
  const ui = mountPage()
  await settle()
  const before = callCount(ui, 'quirky.reviews/detailRefresh')
  ui.replyNext('ui.window.command.run', { result: { delivered: false, reason: 'disabled' } })
  await click(button(ui.element, 'Refresh pull request'))
  expect(callCount(ui, 'quirky.reviews/detailRefresh')).toBe(before)
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('not currently available')
  const failed = ui.holdNext('ui.window.command.run')
  await click(button(ui.element, 'Refresh pull request'))
  await act(async () => failed.reject(new Error('bridge fixture failed')))
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailRefresh')).toBe(before)
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('bridge fixture failed')
  await click(button(ui.element, 'Refresh pull request'))
  expect(callCount(ui, 'quirky.reviews/detailRefresh')).toBe(before + 1)
  expect(ui.calls.filter((call) => call.method === 'ui.window.command.run').every((call) => call.params.connId === 42)).toBe(true)
})

for (const kind of ['worktree', 'repository', 'number', 'generation', 'head'] as const) {
  test(`B10: page and composer leases reject ${kind} A→B→A replacement`, async () => {
    const state = stateFor()
    const ui = mountPage(state)
    await settle()
    const page = control(ui, 'review-page')
    const composer = control(ui, 'comment-composer')
    ui.render(changedOwner(state, kind)); ui.render(state)
    await settle()
    for (const [descriptor, action] of [[page, 'refresh'], [composer, 'image-open']] as const) {
      await act(async () => { expect(await invokeCaptured(ui, { target: descriptor.target, generation: descriptor.generation, action })).toEqual({ delivered: false, reason: 'target-unavailable' }) })
    }
    expect(control(ui, 'review-page').generation).not.toBe(page.generation)
  })
}

test('B10: held self discovery captures the old page descriptor and cannot refresh its replacement', async () => {
  const state = stateFor(); const ui = mountPage(state)
  await settle()
  const before = callCount(ui, 'quirky.reviews/detailRefresh')
  const self = ui.holdNext('ui.window.self')
  await click(button(ui.element, 'Refresh pull request'))
  ui.render(changedOwner(state, 'number')); ui.render(state)
  await act(async () => self.resolve({ connId: 42 }))
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailRefresh')).toBe(before)
})

test('B2: workspace recovery and commands preserve current explicit review identity', async () => {
  const ui = mountPage(stateFor(), ['quirky.tasks/state'])
  await act(async () => ui.initialHold('quirky.tasks/state')!.reject(new Error('workspace fixture failed')))
  await act(async () => { await invoke(ui, 'review-page', 'workspace-retry') })
  await settle()
  ui.replyNext('quirky.tasks/workspace', { kind: 'composer' })
  await act(async () => { await invoke(ui, 'review-page', 'workspace-start') })
  const start = ui.calls.find((call) => call.method === 'quirky.tasks/workspace')!
  expect(start.params.action).toBe('start')
  expect(JSON.stringify(start.params)).toContain('test-owner')
  const linked = mountPage(stateFor(), ['quirky.tasks/state'])
  await act(async () => linked.initialHold('quirky.tasks/state')!.resolve({ links: { fixture: {
    worktree: '/fixture/link', name: 'Fixture workspace', url: reviewFor().url, repoId: 'fixture-repo',
  } } }))
  expect(linked.element.textContent).toContain('Fixture workspace')
  linked.replyNext('quirky.tasks/workspace', { kind: 'resumed' })
  await act(async () => { await invoke(linked, 'review-page', 'workspace-resume') })
  linked.replyNext('quirky.tasks/workspace', { kind: 'composer' })
  await act(async () => { await invoke(linked, 'review-page', 'workspace-start-new') })
  expect(linked.calls.filter((call) => call.method === 'quirky.tasks/workspace').map((call) => call.params.action)).toEqual(['resume', 'start'])
  expect(linked.calls.filter((call) => call.method === 'quirky.tasks/workspace').at(-1)?.params.newWorkspace).toBe(true)
})

test('B3: assignment commands validate selections, deduplicate writes and parse manual reviewer text', async () => {
  const ui = mountPage()
  ui.replyNext('quirky.hosting/assignees', { assignees: [{ login: 'alice' }, { login: 'bob' }] })
  await act(async () => { await invoke(ui, 'assignments', 'assignees-open') })
  await advanceDebounce(120)
  await act(async () => { await invoke(ui, 'assignee-form', 'assignee-select', { login: 'alice', selected: true }) })
  const write = ui.holdNext('quirky.reviews/detailUpdateAssignees')
  let saving!: Promise<unknown>
  await act(async () => { saving = invoke(ui, 'assignee-form', 'assignees-save'); await Promise.resolve() })
  await act(async () => { await invoke(ui, 'assignee-form', 'assignees-save') })
  expect(callCount(ui, 'quirky.reviews/detailUpdateAssignees')).toBe(1)
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailUpdateAssignees')?.params).toMatchObject({ surface: 'detail', action: 'set', logins: ['alice'], worktree: WORKTREE, number: 12, prRepo: REPO })
  await act(async () => { write.resolve({}); await saving })
  await act(async () => { await invoke(ui, 'assignments', 'reviewers-open') })
  for (const [text, message] of [['x'.repeat(2049), 'Reviewer input is limited to 2 KiB.'], [Array.from({ length: 16 }, (_, i) => `user${i}`).join(' '), 'Request up to 15 reviewers.'], ['bad.login', 'Reviewer logins may contain letters, numbers, and hyphens only.']]) {
    await act(async () => { await expect(invoke(ui, 'reviewer-form', 'reviewers-add', { text })).rejects.toThrow(message) })
  }
  expect(callCount(ui, 'quirky.reviews/detailUpdateReviewers')).toBe(0)
  await act(async () => { await invoke(ui, 'reviewer-form', 'reviewers-add', { text: '@alice, alice bob' }) })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailUpdateReviewers')?.params).toMatchObject({ action: 'add', logins: ['alice', 'bob'], worktree: WORKTREE, number: 12, prRepo: REPO })
  await act(async () => { expect(await invoke(ui, 'assignments', 'reviewer-remove', { login: 'not-requested' })).toEqual({ delivered: false, reason: 'disabled' }) })
  expect(callCount(ui, 'quirky.reviews/detailUpdateReviewers')).toBe(1)
})

test('B3/B10: closing and reopening an assignment form fences an already-started catalog read', async () => {
  const ui = mountPage()
  const read = ui.holdNext('quirky.hosting/assignees')
  await act(async () => { await invoke(ui, 'assignments', 'assignees-open') })
  const old = control(ui, 'assignee-form')
  await advanceDebounce(120)
  await act(async () => { await invoke(ui, 'assignee-form', 'assignees-close'); await invoke(ui, 'assignments', 'assignees-open') })
  await act(async () => read.reject(new Error('obsolete catalog failure')))
  expect(ui.element.textContent).not.toContain('obsolete catalog failure')
  await act(async () => { expect(await invokeCaptured(ui, { target: old.target, generation: old.generation, action: 'assignees-save' })).toEqual({ delivered: false, reason: 'target-unavailable' }) })
})

test('B4/B10: a body save waiting on its draft cannot mutate a new owner', async () => {
  const state = stateFor(); const ui = mountPage(state)
  await act(async () => { await invoke(ui, 'review-page', 'body-open') })
  const draft = ui.holdNext('quirky.reviews/detailSetBodyDraft')
  changeValue(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')!, 'held body')
  let save!: Promise<unknown>
  await act(async () => { save = invoke(ui, 'review-body', 'body-save'); await Promise.resolve() })
  ui.render(changedOwner(state, 'generation'))
  await act(async () => { draft.resolve({ applied: true }); await save })
  expect(callCount(ui, 'quirky.reviews/detailUpdateBody')).toBe(0)
})

test('B4: permission changes disable body controls without deleting the open draft', async () => {
  const state = stateFor(); const ui = mountPage(state)
  await act(async () => { await invoke(ui, 'review-page', 'body-open') })
  changeValue(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')!, 'permission draft')
  const readonly = structuredClone(state)
  readonly.detail.details = { item: { viewerCanUpdate: false, assignees: [], requestedReviewers: [], reviews: [] } }
  ui.render(readonly)
  await act(async () => { expect(await invoke(ui, 'review-body', 'body-save')).toEqual({ delivered: false, reason: 'disabled' }) })
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')?.value).toBe('permission draft')
  expect(callCount(ui, 'quirky.reviews/detailUpdateBody')).toBe(0)
})

test('B9/B10: unknown actions and malformed payloads reject without renewing a live page lease', async () => {
  const ui = mountPage(); await settle()
  const page = control(ui, 'review-page')
  await act(async () => { expect(await invoke(ui, 'review-page', 'not-an-action')).toEqual({ delivered: false, reason: 'unknown-action' }) })
  for (const value of [{ tab: 'bad' }, { tab: 'checks', extra: true }, { tab: 1 }]) {
    await act(async () => { await expect(invoke(ui, 'review-page', 'tab-set', value)).rejects.toThrow() })
  }
  expect(control(ui, 'review-page').generation).toBe(page.generation)
  expect(callCount(ui, 'quirky.reviews/detailSetTab')).toBe(0)
})

test('B7/B9: all send entry points reach one exact-window action on both surfaces', async () => {
  for (const surface of ['detail', 'checks'] as const) for (const entry of ['command', 'button', 'submit', 'shortcut']) {
    const state = stateFor({ detailDraft: 'hello' }); state.checks.commentDraft = 'hello'
    const ui = mountComments(surface, state)
    await act(async () => {
      if (entry === 'command') await invoke(ui, 'comment-composer', 'comment-send')
      else if (entry === 'button') button(ui.element, 'Send comment').click()
      else if (entry === 'submit') ui.element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      else {
        const editor = ui.element.querySelector('textarea')!
        const key = Object.getOwnPropertyNames(editor).find((name) => name.startsWith('__reactProps$'))!
        const handlers = (editor as unknown as Record<string, { onKeyDown(event: unknown): void }>)[key]!
        handlers.onKeyDown({ key: 'Enter', metaKey: true, preventDefault() {}, stopPropagation() {} })
      }
    })
    await settle()
    expect(callCount(ui, 'quirky.reviews/detailPostComment')).toBe(1)
    if (entry !== 'command') expect(ui.calls.some((call) => call.method === 'ui.window.command.run' && call.params.connId === 42)).toBe(true)
    ui.unmount()
  }
})

test('B8/B10: reopened edit and image sessions reject delayed descriptors', async () => {
  const ui = mountComments('detail', withComments())
  await act(async () => { await invoke(ui, 'comments', 'edit-open', { comment: { kind: 'issue_comment', id: 42 } }) })
  const edit = control(ui, 'comment-edit')
  await act(async () => { await invoke(ui, 'comment-edit', 'edit-cancel') })
  await act(async () => { await invoke(ui, 'comments', 'edit-open', { comment: { kind: 'issue_comment', id: 42 } }) })
  await act(async () => { expect(await invokeCaptured(ui, { target: edit.target, generation: edit.generation, action: 'edit-save', value: { body: 'obsolete edit' } })).toEqual({ delivered: false, reason: 'target-unavailable' }) })
  for (const body of ['', 'x'.repeat(65537)]) await act(async () => { await expect(invoke(ui, 'comment-edit', 'edit-save', { body })).rejects.toThrow() })
  expect(callCount(ui, 'quirky.reviews/detailEditComment')).toBe(0)
  await act(async () => { await invoke(ui, 'comment-composer', 'image-open') })
  const image = control(ui, 'comment-image')
  const self = ui.holdNext('ui.window.self')
  let delivery!: Promise<unknown>
  await act(async () => { delivery = requestReviewsUiControl(ui.context, { target: image.target, generation: image.generation, action: 'image-insert', value: { url: 'https://x.test/stale.png' } }); await Promise.resolve() })
  await act(async () => { await invoke(ui, 'comment-image', 'image-close') })
  await act(async () => { await invoke(ui, 'comment-composer', 'image-open') })
  await act(async () => { self.resolve({ connId: 42 }); expect(await delivery).toEqual({ delivered: false, reason: 'target-unavailable' }) })
  expect(callCount(ui, 'quirky.reviews/detailSetCommentDraft')).toBe(0)
})

test('B8/B10: obsolete confirmation completion cannot release a replacement operation token', async () => {
  const state = withComments(); state.detail.commentDraft = 'hello'
  const ui = mountComments('detail', state)
  const first = ui.holdConfirmation(); let old!: Promise<unknown>
  await act(async () => { old = invoke(ui, 'comments', 'comment-delete', { comment: { kind: 'issue_comment', id: 42 } }); await Promise.resolve() })
  ui.render(changedOwner(state, 'number'))
  const second = ui.holdConfirmation(); let current!: Promise<unknown>
  await act(async () => { current = invoke(ui, 'comments', 'comment-delete', { comment: { kind: 'issue_comment', id: 42 } }); await Promise.resolve() })
  await act(async () => { first.resolve(true); await old })
  await act(async () => { expect(await invoke(ui, 'comment-composer', 'comment-send')).toEqual({ delivered: false, reason: 'disabled' }) })
  await act(async () => { second.resolve(false); await current })
  expect(callCount(ui, 'quirky.reviews/detailDeleteComment')).toBe(0)
  await act(async () => { await invoke(ui, 'comment-composer', 'comment-send') })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailPostComment')?.params.number).toBe(13)
})

test('B8: resource and payload validation rejects unsafe links and hidden or string-only reply targets', async () => {
  const unsafe = { ...commentFor(), url: 'javascript:alert(1)' }
  const state = withComments([unsafe, commentFor('review_comment', 'remote-id')]); state.detail.queuedComments = ['42']
  const ui = mountComments('detail', state)
  await act(async () => { await expect(invoke(ui, 'comments', 'comment-open', { comment: { kind: 'issue_comment', id: 42 } })).rejects.toThrow('safe HTTP or HTTPS') })
  await act(async () => { await expect(invoke(ui, 'comments', 'reply-open', { comment: { kind: 'review_comment', id: 'remote-id' } })).rejects.toThrow() })
  await act(async () => { await expect(invoke(ui, 'comments', 'queue-send', { body: 'arbitrary prompt' })).rejects.toThrow() })
  expect(callCount(ui, 'quirky.reviews/openLink')).toBe(0)
  expect(callCount(ui, 'quirky.reviews/detailPostComment')).toBe(0)
  expect(callCount(ui, 'quirky.reviews/checksSetAgentDialog')).toBe(0)
})

test('B9: page copy stays in the clicking window and navigation retains explicit targets', async () => {
  const ui = mountPage(); await settle()
  const copied: string[] = []
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  try {
    await click(button(ui.element, 'Copy pull request link'))
    await settle()
    expect(copied).toEqual([reviewFor().url])
    expect(callCount(ui, 'quirky.reviews/copyText')).toBe(0)
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
  await act(async () => { await invoke(ui, 'review-page', 'tab-set', { tab: 'checks' }) })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailSetTab')?.params).toMatchObject({ tab: 'checks' })
  await act(async () => { await invoke(ui, 'review-page', 'open-link', { invert: true }) })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/openLink')?.params).toMatchObject({ url: reviewFor().url, worktree: WORKTREE, invert: true })
  await act(async () => { await invoke(ui, 'review-page', 'back') })
  expect(callCount(ui, 'quirky.reviews/close')).toBe(1)
})

test('B2/B10: obsolete workspace discovery cannot overwrite the replacement read', async () => {
  const state = stateFor(); const ui = mountPage(state, ['quirky.tasks/state'])
  const replacement = ui.holdNext('quirky.tasks/state')
  ui.render(changedOwner(state, 'number'))
  await act(async () => ui.initialHold('quirky.tasks/state')!.resolve({ links: { old: {
    worktree: '/old', name: 'Obsolete workspace', url: reviewFor().url, repoId: 'old',
  } } }))
  expect(ui.element.textContent).not.toContain('Obsolete workspace')
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toContain('Checking linked workspace…')
  await act(async () => replacement.reject(new Error('replacement workspace failure')))
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('replacement workspace failure')
})

test('B3: invalid catalog retry remains in the same form lease', async () => {
  const ui = mountPage()
  ui.replyNext('quirky.hosting/assignees', { invalid: true })
  await act(async () => { await invoke(ui, 'assignments', 'reviewers-open') })
  const form = control(ui, 'reviewer-form')
  await advanceDebounce(120)
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('The hosting API returned invalid reviewer suggestions.')
  ui.replyNext('quirky.hosting/assignees', { assignees: [] })
  await act(async () => { await invoke(ui, 'reviewer-form', 'reviewers-retry') })
  await advanceDebounce(120)
  expect(control(ui, 'reviewer-form').generation).toBe(form.generation)
  expect(ui.element.textContent).toContain('No matching assignable users.')
})

test('B3: only current requested reviewers can be removed', async () => {
  const state = stateFor(); state.detail.review!.requestedReviewers = ['alice']
  const ui = mountPage(state)
  await act(async () => { await invoke(ui, 'assignments', 'reviewer-remove', { login: 'alice' }) })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailUpdateReviewers')?.params).toMatchObject({ action: 'remove', logins: ['alice'] })
  await act(async () => { await expect(invoke(ui, 'assignments', 'reviewer-remove', { login: 'bob' })).rejects.toThrow() })
  expect(callCount(ui, 'quirky.reviews/detailUpdateReviewers')).toBe(1)
})

test('B4: permission is rechecked after awaiting the body draft', async () => {
  const state = stateFor(); const ui = mountPage(state)
  await act(async () => { await invoke(ui, 'review-page', 'body-open') })
  const draft = ui.holdNext('quirky.reviews/detailSetBodyDraft')
  changeValue(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')!, 'held permission draft')
  let saving!: Promise<unknown>
  await act(async () => { saving = invoke(ui, 'review-body', 'body-save'); await Promise.resolve() })
  const readonly = structuredClone(state); readonly.detail.details = { item: { viewerCanUpdate: false } }
  ui.render(readonly)
  await act(async () => { expect(await saving).toEqual({ delivered: true, result: { accepted: true } }); draft.resolve({ applied: true }) })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('no longer edit')
  expect(callCount(ui, 'quirky.reviews/detailUpdateBody')).toBe(0)
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pull request description"]')?.value).toBe('held permission draft')
})

test('B4/B10: cancel and reopen invalidate a description Save held in window discovery', async () => {
  const ui = mountPage()
  await act(async () => { await invoke(ui, 'review-page', 'body-open') })
  const old = control(ui, 'review-body')
  const self = ui.holdNext('ui.window.self')
  await click(button(ui.element, 'Save description'))
  await act(async () => { await invoke(ui, 'review-body', 'body-cancel') })
  await act(async () => { await invoke(ui, 'review-page', 'body-open') })
  await act(async () => self.resolve({ connId: 42 }))
  await settle()
  expect(control(ui, 'review-body').generation).not.toBe(old.generation)
  expect(ui.element.querySelector('textarea[aria-label="Pull request description"]')).not.toBeNull()
  expect(callCount(ui, 'quirky.reviews/detailUpdateBody')).toBe(0)
})

test('B6: successful empty mention reads are shared empties, combined matching is bounded and case-insensitive', async () => {
  const empty = mountComments('detail', stateFor({ detailDraft: '@zzz' }))
  empty.replyNext('quirky.hosting/assignees', { assignees: [] })
  await advanceDebounce(180)
  expect(empty.element.textContent).toContain('No matching participants.')
  expect(empty.element.querySelector('.ui-notice-line')).toBeNull()
  const ui = mountComments('detail', stateFor({ detailDraft: '@a' }))
  ui.replyNext('quirky.hosting/assignees', { assignees: [{ login: 'ALICE' }, ...Array.from({ length: 10 }, (_, i) => ({ login: `a-user-${i}` }))] })
  await advanceDebounce(180)
  expect(ui.element.querySelectorAll('[role="option"]')).toHaveLength(8)
  expect([...ui.element.querySelectorAll('[role="option"]')].filter((node) => node.textContent?.toLowerCase() === '@alice')).toHaveLength(1)
})

test('B3: scripted assignee saves enforce current membership and bounds while allowing clear without catalog', async () => {
  const state = stateFor(); state.detail.review!.assignees = ['alice']
  const ui = mountPage(state)
  await act(async () => { await invoke(ui, 'assignments', 'assignees-open') })
  for (const logins of [['mallory'], [''], ['x'.repeat(257)], Array.from({ length: 101 }, (_, i) => `user${i}`)]) {
    await act(async () => { await expect(invoke(ui, 'assignee-form', 'assignees-save', { logins })).rejects.toThrow() })
  }
  expect(callCount(ui, 'quirky.reviews/detailUpdateAssignees')).toBe(0)
  await act(async () => { await invoke(ui, 'assignee-form', 'assignees-save', { logins: [] }) })
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailUpdateAssignees')?.params.logins).toEqual([])
})

test('B6: a same-tick draft edit cannot select an option for the previous mention prefix', async () => {
  const ui = mountComments('detail', stateFor({ detailDraft: '@ali' }), ['quirky.hosting/assignees'])
  let selection!: Promise<unknown>
  await act(async () => {
    changeValue(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')!, '@bob')
    selection = invoke(ui, 'comment-composer', 'mention-select', { login: 'alice' })
    await expect(selection).rejects.toThrow()
  })
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')?.value).toBe('@bob')
})

test('B8: a scripted edit body stages into the current form and survives a failed save', async () => {
  const ui = mountComments('detail', withComments())
  await act(async () => { await invoke(ui, 'comments', 'edit-open', { comment: { kind: 'issue_comment', id: 42 } }) })
  changeValue(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment #42"]')!, '')
  const write = ui.holdNext('quirky.reviews/detailEditComment')
  let saving!: Promise<unknown>
  await act(async () => { saving = invoke(ui, 'comment-edit', 'edit-save', { body: 'scripted edit retained' }); await Promise.resolve() })
  expect(callCount(ui, 'quirky.reviews/detailEditComment')).toBe(1)
  await act(async () => { expect(await saving).toEqual({ delivered: true, result: { accepted: true } }); write.reject(new Error('edit fixture failed')) })
  await settle()
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment #42"]')?.value).toBe('scripted edit retained')
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('edit fixture failed')
})

function deadlineBridge(ui: Mounted) {
  const original = ui.context.call.bind(ui.context)
  const deadlines = new Set<Deferred<never>>()
  ui.context.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method !== 'ui.window.command.run') return original(method, params)
    ui.calls.push({ method, params })
    const handler = ui.provided(String(params.id))
    if (typeof handler !== 'function') throw new Error('Missing actual activated command handler.')
    const deadline = deferred<never>()
    deadlines.add(deadline)
    try {
      return { result: await Promise.race([Promise.resolve(handler(params.args)), deadline.promise]) }
    } finally { deadlines.delete(deadline) }
  }) as UiPluginContext['call']
  return {
    pendingReplies: () => deadlines.size,
    expire() { for (const deadline of deadlines) deadline.reject(new Error('the window did not answer')) },
  }
}

for (const outcome of ['cancel', 'confirm', 'reject', 'replacement'] as const) {
  test(`Rework: held Delete ${outcome} is acknowledged before the window deadline`, async () => {
    const state = withComments(); state.detail.commentDraft = 'hello'
    const ui = mountComments('detail', state)
    const confirmation = ui.holdConfirmation()
    const bridge = deadlineBridge(ui)
    await click(button(ui.element, 'Delete'))
    await settle()
    const pendingReplies = bridge.pendingReplies()
    await act(async () => bridge.expire())
    await settle()
    expect(pendingReplies).toBe(0)
    expect(ui.element.textContent).not.toContain('the window did not answer')
    expect(button(ui.element, 'Delete').disabled).toBe(true)
    expect(button(ui.element, 'Send comment').disabled).toBe(true)
    expect(callCount(ui, 'quirky.reviews/detailDeleteComment')).toBe(0)
    if (outcome === 'replacement') ui.render(changedOwner(state, 'number'))
    await act(async () => {
      if (outcome === 'reject') confirmation.reject(new Error('owned confirmation failed'))
      else confirmation.resolve(outcome !== 'cancel')
    })
    await settle()
    expect(callCount(ui, 'quirky.reviews/detailDeleteComment')).toBe(outcome === 'confirm' ? 1 : 0)
    expect(ui.element.textContent).not.toContain('the window did not answer')
    if (outcome === 'reject') expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('owned confirmation failed')
    expect(button(ui.element, 'Delete').disabled).toBe(false)
  })
}

const slowControls: Array<{
  slot: string; action: string; method: string; value?: Record<string, unknown>; success?: unknown
}> = [
  { slot: 'comment-composer', action: 'comment-send', method: 'quirky.reviews/detailPostComment' },
  { slot: 'comment-edit', action: 'edit-save', method: 'quirky.reviews/detailEditComment', value: { body: 'slow edit' } },
  { slot: 'comments', action: 'queue-set', method: 'quirky.reviews/detailQueueComment', value: { comment: { kind: 'issue_comment', id: 42 }, queued: true } },
  { slot: 'comments', action: 'comments-retry', method: 'quirky.reviews/detailRefresh' },
  { slot: 'review-page', action: 'refresh', method: 'quirky.reviews/detailRefresh' },
  { slot: 'review-page', action: 'tab-set', method: 'quirky.reviews/detailSetTab', value: { tab: 'checks' } },
  { slot: 'review-page', action: 'workspace-start', method: 'quirky.tasks/workspace', success: { kind: 'composer' } },
  { slot: 'review-page', action: 'open-link', method: 'quirky.reviews/openLink' },
  { slot: 'review-body', action: 'body-save', method: 'quirky.reviews/detailUpdateBody' },
  { slot: 'assignee-form', action: 'assignees-save', method: 'quirky.reviews/detailUpdateAssignees', value: { logins: [] } },
  { slot: 'reviewer-form', action: 'reviewers-add', method: 'quirky.reviews/detailUpdateReviewers', value: { text: 'alice' } },
]

for (const scenario of slowControls) for (const outcome of ['success', 'failure'] as const) {
  test(`Rework: slow ${scenario.action} ${outcome} has prompt delivery and owned completion`, async () => {
    const state = withComments(); state.detail.commentDraft = 'hello'
    const ui = scenario.slot.startsWith('comment') ? mountComments('detail', state) : mountPage(state)
    await settle()
    if (scenario.slot === 'comment-edit') await act(async () => { await invoke(ui, 'comments', 'edit-open', { comment: { kind: 'issue_comment', id: 42 } }) })
    if (scenario.slot === 'review-body') await act(async () => { await invoke(ui, 'review-page', 'body-open') })
    if (scenario.slot === 'assignee-form') await act(async () => { await invoke(ui, 'assignments', 'assignees-open') })
    if (scenario.slot === 'reviewer-form') await act(async () => { await invoke(ui, 'assignments', 'reviewers-open') })
    const provider = ui.holdNext(scenario.method)
    const bridge = deadlineBridge(ui)
    const descriptor = control(ui, scenario.slot)
    let delivery!: Promise<ReviewsUiControlResult>
    await act(async () => {
      delivery = requestReviewsUiControl(ui.context, {
        target: descriptor.target, generation: descriptor.generation, action: scenario.action,
        ...(scenario.value === undefined ? {} : { value: scenario.value }),
      })
      void delivery.catch(() => {})
      await Promise.resolve()
    })
    await settle()
    const pendingReplies = bridge.pendingReplies()
    await act(async () => bridge.expire())
    await settle()
    expect(pendingReplies).toBe(0)
    expect(await delivery).toEqual({ delivered: true, result: { accepted: true } })
    expect(callCount(ui, scenario.method)).toBeGreaterThanOrEqual(1)
    expect(ui.element.textContent).not.toContain('the window did not answer')
    await act(async () => {
      if (outcome === 'failure') provider.reject(new Error(`owned ${scenario.action} failed`))
      else provider.resolve(scenario.success ?? {})
    })
    await settle()
    if (outcome === 'failure') {
      expect([...ui.element.querySelectorAll('.ui-inline-error')].some((element) => element.textContent?.includes(`owned ${scenario.action} failed`))).toBe(true)
    } else {
      expect(ui.element.textContent).not.toContain(`owned ${scenario.action} failed`)
      if (scenario.action === 'comment-send') expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')?.value).toBe('')
      if (scenario.action === 'edit-save') expect(ui.element.querySelector('textarea[aria-label="Edit comment #42"]')).toBeNull()
      if (scenario.action === 'body-save') expect(ui.element.querySelector('textarea[aria-label="Pull request description"]')).toBeNull()
      if (scenario.action === 'assignees-save') expect(listReviewsUiControls(ui.context, 'view:quirky.reviews/review').some((entry) => entry.slot === 'assignee-form')).toBe(false)
    }
  })
}

test('Rework: deadline admission preserves malformed and disabled refusals', async () => {
  const ui = mountComments('detail', withComments())
  const bridge = deadlineBridge(ui)
  await act(async () => { await expect(invoke(ui, 'comments', 'comment-delete', { comment: { kind: 'issue_comment', id: 999 } })).rejects.toThrow() })
  await act(async () => { expect(await invoke(ui, 'comment-composer', 'comment-send')).toEqual({ delivered: false, reason: 'disabled' }) })
  expect(bridge.pendingReplies()).toBe(0)
  expect(callCount(ui, 'quirky.reviews/detailDeleteComment')).toBe(0)
  expect(callCount(ui, 'quirky.reviews/detailPostComment')).toBe(0)
})

for (const surface of ['detail', 'checks'] as const) {
  test(`Rework: ${surface} comment states retain shared rendering and polite announcements`, async () => {
    const ui = mountComments(surface, stateFor({ detailComments: null, checksComments: null, detailLoading: true, checksLoading: true }))
    const loading = ui.element.querySelector('.ui-notice-line')
    expect(loading?.textContent).toContain('Loading comments…')
    expect(loading?.closest('[role="status"], [aria-live="polite"]')).not.toBeNull()
    ui.render(stateFor({ detailComments: null, checksComments: null }))
    const idle = ui.element.querySelector('.ui-empty-state')
    expect(idle?.textContent).toContain('Comments have not been loaded yet.')
    expect(idle?.closest('[role="status"], [aria-live="polite"]')).not.toBeNull()
    for (const audience of ['all', 'humans', 'bots'] as const) for (const grouping of ['grouped', 'timeline'] as const) {
      ui.render(stateFor({ detailAudience: audience, checksAudience: audience, detailGrouping: grouping, checksGrouping: grouping }))
      const empty = ui.element.querySelector('.ui-empty-state')
      expect(empty?.textContent).toBe(audience === 'all' ? 'No comments yet.' : audience === 'humans' ? 'No human comments.' : 'No bot comments.')
      expect(empty?.closest('[role="status"], [aria-live="polite"]')).not.toBeNull()
    }
  })
}

test('Rework: detail and workspace loading retain shared rendering and announcements', async () => {
  const detail = mountPage(stateFor({ review: null, detailLoading: true }))
  const loading = detail.element.querySelector('.ui-notice-line')
  expect(loading?.textContent).toContain('Loading pull request…')
  expect(loading?.closest('[role="status"], [aria-live="polite"]')).not.toBeNull()
  detail.unmount()
  const workspace = mountPage(stateFor(), ['quirky.tasks/state'])
  const discovery = workspace.element.querySelector('.ui-notice-line')
  expect(discovery?.textContent).toContain('Checking linked workspace…')
  expect(discovery?.closest('[role="status"], [aria-live="polite"]')).not.toBeNull()
})

for (const lane of ['comment', 'body'] as const) for (const replacement of [false, true]) {
  test(`Rework: ${lane} draft settlement is owned after prompt acceptance${replacement ? ' across replacement' : ''}`, async () => {
    const state = withComments()
    const ui = lane === 'comment' ? mountComments('detail', state) : mountPage(state)
    await settle()
    if (lane === 'body') await act(async () => { await invoke(ui, 'review-page', 'body-open') })
    const write = ui.holdNext(lane === 'comment' ? 'quirky.reviews/detailSetCommentDraft' : 'quirky.reviews/detailSetBodyDraft')
    const editor = ui.element.querySelector<HTMLTextAreaElement>(lane === 'comment' ? 'textarea[aria-label="Add a comment"]' : 'textarea[aria-label="Pull request description"]')!
    changeValue(editor, `latest ${lane} draft`)
    const bridge = deadlineBridge(ui)
    const descriptor = control(ui, lane === 'comment' ? 'comment-composer' : 'review-body')
    let delivery!: Promise<ReviewsUiControlResult>
    await act(async () => {
      delivery = requestReviewsUiControl(ui.context, {
        target: descriptor.target, generation: descriptor.generation, action: lane === 'comment' ? 'comment-send' : 'body-save',
      })
      void delivery.catch(() => {})
      await Promise.resolve()
    })
    await settle()
    const pendingReplies = bridge.pendingReplies()
    await act(async () => bridge.expire())
    await settle()
    expect(pendingReplies).toBe(0)
    expect(await delivery).toEqual({ delivered: true, result: { accepted: true } })
    const method = lane === 'comment' ? 'quirky.reviews/detailPostComment' : 'quirky.reviews/detailUpdateBody'
    expect(callCount(ui, method)).toBe(0)
    if (replacement) ui.render(changedOwner(state, 'generation'))
    await act(async () => write.resolve({ applied: true }))
    await settle()
    expect(callCount(ui, method)).toBe(replacement ? 0 : 1)
    if (!replacement) expect(ui.calls.find((call) => call.method === method)?.params.body).toBe(`latest ${lane} draft`)
    expect(ui.element.textContent).not.toContain('the window did not answer')
  })
}

test('Rework: an accepted obsolete post cannot publish errors or release the replacement post', async () => {
  const state = withComments(); state.detail.commentDraft = 'hello'
  const ui = mountComments('detail', state)
  const old = ui.holdNext('quirky.reviews/detailPostComment')
  await act(async () => { expect(await invoke(ui, 'comment-composer', 'comment-send')).toEqual({ delivered: true, result: { accepted: true } }) })
  ui.render(changedOwner(state, 'number'))
  const current = ui.holdNext('quirky.reviews/detailPostComment')
  await act(async () => { await invoke(ui, 'comment-composer', 'comment-send') })
  await act(async () => old.reject(new Error('obsolete accepted post failed')))
  await settle()
  expect(ui.element.textContent).not.toContain('obsolete accepted post failed')
  expect(button(ui.element, 'Send comment').disabled).toBe(true)
  await act(async () => current.resolve({}))
  await settle()
  expect(ui.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')?.value).toBe('')
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/detailPostComment').map((call) => call.params.number)).toEqual([12, 13])
})
