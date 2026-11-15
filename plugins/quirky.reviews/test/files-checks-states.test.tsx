import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { FilesChanged } from '../src/detail/FilesChanged'
import { ChecksList } from '../src/detail/ChecksList'
import { CHECKS_PANEL, REVIEW_VIEW, type ReviewData, type ReviewsState } from '../src/contracts'
import { listReviewsUiControls, requestReviewsUiControl, type ReviewsUiControlResult } from '../src/checks/data'
import { activate } from '../src/ui'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE = '/work/a'
const HOST = 'github.com'
const REPO = { host: HOST, owner: 'owner', repo: 'repo' }
const CHECKS_CONTROL = 'command:quirky.reviews/ui-control'
const roots: Root[] = []

type Call = { method: string; params: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
type Method = (params: Record<string, unknown>) => unknown | Promise<unknown>
type Options = {
  owner?: boolean
  worktree?: string
  number?: number
  generation?: number
  headOid?: string
  detailLoading?: boolean
  detailError?: string | null
  files?: unknown
  checks?: unknown
  fileFilter?: string
  expandedChecks?: string[]
  checksExpanded?: string[]
}
type Mounted = {
  element: HTMLElement
  context: UiPluginContext
  calls: Call[]
  render(state: ReviewsState): void
  unmount(): void
  holdNext(method: string): Deferred<unknown>
  setMethod(method: string, implementation: Method): void
  provided(id: string): unknown
}

type Control = { surface: string; slot: string; target: string; generation: number; actions: Array<{ action: string; enabled: boolean }> }

function deferred<T = unknown>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function reviewFor(number = 12, headOid = 'a'.repeat(40)): ReviewData {
  return {
    provider: 'github', number, url: `https://${HOST}/owner/repo/pull/${number}`,
    title: `Review ${number}`, body: '', state: 'open', headRefName: 'feature', baseRefName: 'main',
    headRefOid: headOid, baseRefOid: 'b'.repeat(40), mergeable: 'MERGEABLE', checksStatus: 'failure',
    reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'CLEAN', autoMergeRequest: null,
    stack: null, mergeMethods: null, prRepo: REPO,
  } as ReviewData
}

function file(path = 'src/a.ts', viewed: boolean | null = false) {
  return {
    path, status: 'modified', additions: 2, deletions: 1, changes: 3,
    patch: '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+last', isBinary: false,
    patchUnavailable: false, viewed, coordinates: [],
  }
}

function filesEnvelope(files: unknown[] = [file()], options: { unavailable?: boolean; partialFailures?: string[]; truncated?: boolean } = {}) {
  return {
    number: 12, files, truncated: options.truncated ?? false, filesUnavailable: options.unavailable ?? false,
    partialFailures: options.partialFailures ?? [],
  }
}

function check(name = 'build', overrides: Record<string, unknown> = {}) {
  return {
    kind: 'check_run', name, status: 'completed', conclusion: 'failure',
    url: 'https://github.com/owner/repo/checks/23', checkRunId: 23, workflowRunId: 24, suiteId: null,
    ...overrides,
  }
}

function checksEnvelope(checks: unknown[] = [check()], options: { partial?: boolean; partialFailures?: string[]; truncated?: boolean; detailsById?: unknown } = {}) {
  return {
    number: 12, headSha: 'a'.repeat(40), rollup: 'failure', checks, partial: options.partial ?? false,
    partialFailures: options.partialFailures ?? [], ...(options.truncated ? { truncated: true } : {}),
    ...(options.detailsById === undefined ? {} : { detailsById: options.detailsById }),
  }
}

function checkDetail(options: {
  check?: Record<string, unknown>
  jobs?: Record<string, unknown>[]
  tails?: Array<{ jobId: number; jobName: string; tail: string }>
  partialFailures?: string[]
  truncated?: boolean
} = {}) {
  return {
    check: { id: 23, name: 'build', status: 'completed', conclusion: 'failure', url: 'https://example.test/check', detailsUrl: 'https://example.test/default-details', ...options.check },
    annotations: [], jobs: options.jobs ?? [{ id: 41, name: 'unit tests', conclusion: 'failure' }],
    logTails: options.tails ?? [{ jobId: 41, jobName: 'unit tests', tail: 'failed: assertion' }],
    partialFailures: options.partialFailures ?? [], truncated: options.truncated ?? false,
  }
}

function reviewState(options: Options = {}): ReviewsState {
  const number = options.number ?? 12
  const worktree = options.worktree ?? WORKTREE
  const generation = options.generation ?? 1
  const headOid = options.headOid ?? 'a'.repeat(40)
  const hasOwner = options.owner !== false
  const review = hasOwner ? reviewFor(number, headOid) : null
  const checks = options.checks === undefined ? checksEnvelope([]) : options.checks
  return {
    revision: 1, previousView: null,
    detail: {
      target: hasOwner ? { worktree, number, prRepo: REPO } : null, tab: 'files', generation,
      loading: options.detailLoading ?? false, error: options.detailError ?? null, review, details: null,
      checks, comments: { number, comments: [], partial: false, partialFailures: [] },
      files: options.files === undefined ? filesEnvelope([]) : options.files,
      audience: 'all', grouping: 'grouped', expandedChecks: options.expandedChecks ?? [], queuedComments: [], checksCollapsed: false,
      selectedFile: null, diffMode: 'inline', collapsedFiles: [], fileFilter: options.fileFilter ?? '', fileTreeVisible: true,
      commentDraft: '', bodyDraft: null, pending: [], fetchedAt: 1,
    },
    checks: {
      worktree: hasOwner ? worktree : null, generation, loading: options.detailLoading ?? false, error: options.detailError ?? null,
      lookup: null, eligibility: null, review, checks, comments: null, conflicts: null,
      audience: 'all', grouping: 'grouped', expandedChecks: options.checksExpanded ?? [], queuedComments: [],
      checksCollapsed: false, commentDraft: '', titleDraft: null, height: 320, fetchedAt: 1, agentDialog: null,
    },
    creation: {
      worktree, generation: 1, loading: false, error: null, eligibility: null, title: '', body: '', base: 'main', head: 'feature',
      draft: false, useTemplate: false, bases: [], generating: false, requestId: null, submitting: false, generated: false,
      result: null, defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false },
    },
    settings: { worktree, generation: 1, loading: false, error: null, diagnostics: null, accounts: null, configuration: null, budget: null, fetchedAt: 0 },
    defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false },
    repoDefaults: {}, botOverrides: [], links: {}, suppressed: {},
  } as unknown as ReviewsState
}

function mount(renderNode: (props: { context: UiPluginContext; state: ReviewsState; refresh(): Promise<void>; snapshot: number }) => ReactNode, initialState: ReviewsState, initialMethods: Record<string, Method> = {}): Mounted {
  const calls: Call[] = []
  const provided = new Map<string, unknown>()
  const methods = new Map<string, Method>()
  for (const [method, implementation] of Object.entries(initialMethods)) methods.set(method, implementation)
  const held = new Map<string, Deferred<unknown>[]>()
  let state = initialState
  const layout = { view: { id: REVIEW_VIEW }, worktree: WORKTREE, panel: null, sidebar: true, focus: 'view' } as unknown as UiLayout
  const context = {
    pluginId: 'quirky.reviews',
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const pending = held.get(method)?.shift()
      if (held.get(method)?.length === 0) held.delete(method)
      if (pending) return pending.promise
      const implementation = methods.get(method)
      if (implementation) return await implementation(params)
      if (method === 'ui.window.self') return { connId: 42 }
      if (method === 'ui.window.command.run') {
        if (params.connId !== 42 || params.id !== CHECKS_CONTROL) throw new Error('Unexpected exact-window command route.')
        const handler = provided.get(CHECKS_CONTROL)
        if (typeof handler !== 'function') throw new Error('The generic UI control handler is not provided.')
        return { result: await (handler as (input: unknown) => unknown)(params.args) }
      }
      return {}
    },
    getLayout: () => layout,
    onLayout: () => () => {}, onConnection: () => () => {}, subscribe: () => () => {},
    getSetting: () => undefined, toast() {}, log() {},
  } as unknown as UiPluginContext
  activate(context)
  const refresh = async () => {}
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  roots.push(root)
  const draw = () => root.render(renderNode({ context, state, refresh, snapshot: 0 }))
  act(draw)
  return {
    element, context, calls,
    render(next) { state = next; act(draw) },
    unmount() { roots.splice(roots.indexOf(root), 1); act(() => root.unmount()); element.remove() },
    holdNext(method) { const request = deferred<unknown>(); held.set(method, [...(held.get(method) ?? []), request]); return request },
    setMethod(method, implementation) { methods.set(method, implementation) },
    provided(id) { return provided.get(id) },
  }
}

const mountFiles = (state = reviewState()) => mount((props) => <FilesChanged {...props} />, state)
const mountChecks = (
  state = reviewState(),
  surface: 'detail' | 'checks' = 'detail',
  compact = false,
  initialMethods: Record<string, Method> = {},
) => mount((props) => <ChecksList {...props} surface={surface} compact={compact} />, state, initialMethods)

async function settle() {
  for (let index = 0; index < 6; index += 1) await act(async () => {})
}

function control(ui: Mounted, slot: string, surface = REVIEW_VIEW): Control {
  const descriptor = listReviewsUiControls(ui.context, surface).find((item) => item.slot === slot)
  if (!descriptor) throw new Error(`Missing ${surface}/${slot} control.`)
  return descriptor
}

async function invoke(ui: Mounted, slot: string, action: string, value?: Record<string, unknown>, surface = REVIEW_VIEW): Promise<ReviewsUiControlResult> {
  let result: ReviewsUiControlResult | null = null
  const descriptor = control(ui, slot, surface)
  await act(async () => {
    result = await requestReviewsUiControl(ui.context, {
      target: descriptor.target, generation: descriptor.generation, action,
      ...(value === undefined ? {} : { value }),
    })
  })
  if (result === null) throw new Error('The exact-window command returned no delivery result.')
  return result
}

function invokeDetached(ui: Mounted, descriptor: Control, action: string, value?: Record<string, unknown>) {
  return requestReviewsUiControl(ui.context, {
    target: descriptor.target, generation: descriptor.generation, action,
    ...(value === undefined ? {} : { value }),
  })
}

function callCount(ui: Mounted, method: string) { return ui.calls.filter((call) => call.method === method).length }
function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
function labelledInput(root: ParentNode, label: string) {
  const found = [...root.querySelectorAll<HTMLInputElement>('input')].find((item) =>
    item.getAttribute('aria-label') === label || item.labels?.[0]?.textContent?.trim() === label)
  if (!found) throw new Error(`Missing input labeled ${label}.`)
  return found
}
async function click(node: HTMLElement) {
  await act(async () => { node.click() })
  await settle()
}
function checkbox(root: ParentNode, path: string) {
  const found = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) => item.id === `review-viewed-${path}`)
  if (!found) throw new Error(`Missing viewed checkbox for ${path}.`)
  return found
}
function changeValue(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  node.value = value
  const key = Object.getOwnPropertyNames(node).find((candidate) => candidate.startsWith('__reactProps$'))
  if (!key) throw new Error('Could not find React event handlers on the rendered field.')
  const onChange = (node as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key]!.onChange
  if (!onChange) throw new Error('The field has no onChange handler.')
  act(() => onChange({ target: node, currentTarget: node }))
}
function errorTexts(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>('.ui-inline-error')].map((node) => node.textContent ?? '')
}
function expectError(root: ParentNode, text: string) {
  expect(errorTexts(root).some((message) => message.includes(text))).toBe(true)
}
function withOwner(state: ReviewsState, options: { worktree?: string; generation?: number; headOid?: string; number?: number } = {}) {
  const next = structuredClone(state)
  const worktree = options.worktree ?? next.detail.target?.worktree ?? WORKTREE
  const number = options.number ?? next.detail.target?.number ?? 12
  next.detail.target = { worktree, number, prRepo: REPO }
  next.detail.generation = options.generation ?? next.detail.generation
  next.detail.review = reviewFor(number, options.headOid ?? next.detail.review?.headRefOid ?? 'a'.repeat(40))
  next.checks.worktree = worktree
  next.checks.generation = next.detail.generation
  next.checks.review = next.detail.review
  return next
}

const rootProps = (ui: Mounted) => ui.element.querySelector<HTMLElement>('[data-review-control-target]')
const CHECK_ID = 'check:23'
const detailForChecks = (items: Record<string, unknown>, expanded = [CHECK_ID]) => {
  const state = reviewState({ checks: checksEnvelope([check()], { detailsById: { '23': checkDetail(items) } }), expandedChecks: expanded })
  return state
}

let clipboardWrites: string[] = []
let previousClipboard: Clipboard | undefined

afterEach(async () => {
  await settle()
  for (const root of [...roots]) act(() => root.unmount())
  roots.length = 0
  document.body.replaceChildren()
  if (previousClipboard === undefined) delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard
  else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard })
  previousClipboard = undefined
  clipboardWrites = []
  await settle()
})

afterAll(() => GlobalRegistrator.unregister())

test('FilesChanged without an owner uses the shared empty state', () => {
  const ui = mountFiles(reviewState({ owner: false, files: null }))
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No pull request is selected.')
  expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
  expect(callCount(ui, 'quirky.reviews/detailRefresh')).toBe(0)
})

test('FilesChanged distinguishes loading, never-requested, malformed and unavailable file branches', async () => {
  const loading = mountFiles(reviewState({ files: null, detailLoading: true, detailError: 'background read failed' }))
  expect(loading.element.querySelector('.ui-empty-state')?.textContent).toContain('Loading changed files…')
  expectError(loading.element, 'background read failed')
  const emptyLoading = mountFiles(reviewState({ files: filesEnvelope([]), detailLoading: true, detailError: 'empty read failed' }))
  expect(emptyLoading.element.querySelector('.ui-empty-state')?.textContent).toContain('Loading changed files…')
  expectError(emptyLoading.element, 'empty read failed')

  const idle = mountFiles(reviewState({ files: null }))
  expect(idle.element.querySelector('.ui-empty-state')?.textContent).toContain('Changed files have not loaded yet.')
  expect(button(idle.element, 'Load files')).toBeTruthy()

  const malformed = mountFiles(reviewState({ files: { number: 12, files: [{ path: 'bad' }] } }))
  expectError(malformed.element, 'Couldn’t load changed files.')
  expect(button(malformed.element, 'Retry')).toBeTruthy()

  const unavailable = mountFiles(reviewState({ files: filesEnvelope([], { unavailable: true, partialFailures: ['provider timeout'] }), detailError: 'read failed' }))
  expectError(unavailable.element, 'Couldn’t load changed files.')
  expectError(unavailable.element, 'read failed')
  expectError(unavailable.element, 'provider timeout')
  expect(button(unavailable.element, 'Retry')).toBeTruthy()
})

test('FilesChanged preserves empty, filtered-empty, detail and partial errors without dropping the toolbar', () => {
  const empty = mountFiles(reviewState({ files: filesEnvelope([]), detailError: 'refresh failed' }))
  expect(empty.element.querySelector('.ui-empty-state')?.textContent).toContain('No files changed.')
  expectError(empty.element, 'refresh failed')
  expect(button(empty.element, 'Refresh files')).toBeTruthy()

  const filtered = mountFiles(reviewState({
    files: filesEnvelope([file()], { partialFailures: ['one file could not be read'] }),
    fileFilter: 'does-not-match', detailError: 'detail failed',
  }))
  expect(filtered.element.querySelector('.ui-empty-state')?.textContent).toContain('No files match this filter.')
  expectError(filtered.element, 'detail failed')
  expectError(filtered.element, 'one file could not be read')
  expect(button(filtered.element, 'Refresh files')).toBeTruthy()
  expect(labelledInput(filtered.element, 'Filter files')).toBeTruthy()
})

test('FilesChanged dispatches exact-window actions from its canonical target and root lease', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  const registered = control(ui, 'files-changed')
  const expected = [REVIEW_VIEW, 'files-changed', WORKTREE, REPO, 12, 'a'.repeat(40), null]
  expect(JSON.parse(registered.target)).toEqual(expected)
  expect(rootProps(ui)?.dataset.reviewControlTarget).toBe(registered.target)
  expect(rootProps(ui)?.dataset.reviewControlGeneration).toBe(String(registered.generation))
  expect(registered.actions.map((item) => item.action)).toEqual(expect.arrayContaining([
    'refresh', 'tree-toggle', 'collapse-all', 'expand-all', 'diff-mode-set', 'file-select',
    'file-toggle-collapse', 'file-set-viewed', 'range-start-set', 'inline-comment-open',
  ]))
  expect(await invoke(ui, 'files-changed', 'tree-toggle', { visible: false })).toMatchObject({ delivered: true })
  expect(ui.calls.some((call) => call.method === 'ui.window.self' && Object.keys(call.params).length === 0)).toBe(true)
  expect(ui.calls.some((call) => call.method === 'ui.window.command.run' && call.params.connId === 42 && call.params.id === CHECKS_CONTROL)).toBe(true)
  expect(callCount(ui, 'quirky.reviews/detailSetFilesView')).toBe(1)
  expect(await invoke(ui, 'files-changed', 'file-select', { path: null })).toMatchObject({ delivered: true })
  expect(await invoke(ui, 'files-changed', 'file-toggle-collapse', { path: 'src/a.ts' })).toMatchObject({ delivered: true })
  expect(await invoke(ui, 'files-changed', 'collapse-all')).toMatchObject({ delivered: true })
  expect(await invoke(ui, 'files-changed', 'expand-all')).toMatchObject({ delivered: true })
})

test('FilesChanged synthesizes malformed payload errors and surfaces every error on visible files', () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()], { partialFailures: ['patch read failed'], truncated: true }), detailError: 'refresh failed' }))
  expectError(ui.element, 'refresh failed')
  expectError(ui.element, 'patch read failed')
  expect(ui.element.querySelectorAll('.ui-notice-line').length).toBeGreaterThan(0)

  const invalid = mountFiles(reviewState({ files: { number: 99, files: [], truncated: false, filesUnavailable: false, partialFailures: [] } }))
  expectError(invalid.element, 'Couldn’t load changed files.')
})

test('FilesChanged dispatches Retry failures into shared errors in null, unavailable and empty branches', async () => {
  for (const files of [null, filesEnvelope([], { unavailable: true }), filesEnvelope([])]) {
    const ui = mountFiles(reviewState({ files, detailError: 'read failed' }))
    ui.setMethod('quirky.reviews/detailRefresh', () => Promise.reject(new Error('retry fixture failed')))
    await invoke(ui, 'files-changed', 'refresh')
    await settle()
    expectError(ui.element, 'retry fixture failed')
  }
})
test('FilesChanged maps delivered-false and current dispatch failures into visible branch errors', async () => {
  for (const [reason, message] of [
    ['target-unavailable', 'Target review control is no longer available.'],
    ['disabled', 'That review control is currently disabled.'],
    ['unknown-action', 'Unsupported review control action.'],
  ] as const) {
    const ui = mountFiles(reviewState({ files: null }))
    ui.setMethod('ui.window.command.run', async () => ({ result: { delivered: false, reason } }))
    await click(button(ui.element, 'Load files'))
    expectError(ui.element, message)
  }

  const rejected = mountFiles(reviewState({ files: null }))
  rejected.setMethod('ui.window.command.run', () => Promise.reject(new Error('window dispatch failed')))
  await click(button(rejected.element, 'Load files'))
  expectError(rejected.element, 'window dispatch failed')
})
test('FilesChanged suppresses same-tick duplicate refresh commands', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([]) }))
  const pending = ui.holdNext('quirky.reviews/detailRefresh')
  await act(async () => {
    button(ui.element, 'Refresh files').click()
    button(ui.element, 'Refresh files').click()
    await Promise.resolve()
  })
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailRefresh')).toBe(1)
  await act(async () => { pending.resolve({}); await pending.promise })
  await settle()
})
test('FilesChanged locks viewed state per file, keeps null as toggleable, and sends the strict method payload', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file('src/a.ts', null), file('src/b.md', false)]) }))
  const a = ui.holdNext('quirky.reviews/detailSetFileViewed')
  let first!: Promise<ReviewsUiControlResult>
  await act(async () => { first = invokeDetached(ui, control(ui, 'files-changed'), 'file-set-viewed', { path: 'src/a.ts' }); await Promise.resolve() })
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailSetFileViewed')).toBe(1)
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailSetFileViewed')?.params).toEqual({
    worktree: WORKTREE, number: 12, prRepo: REPO, surface: 'detail', path: 'src/a.ts', viewed: true,
  })
  await invoke(ui, 'files-changed', 'file-set-viewed', { path: 'src/a.ts' }).catch(() => {})
  expect(callCount(ui, 'quirky.reviews/detailSetFileViewed')).toBe(1)
  const b = ui.holdNext('quirky.reviews/detailSetFileViewed')
  let second!: Promise<ReviewsUiControlResult>
  await act(async () => { second = invokeDetached(ui, control(ui, 'files-changed'), 'file-set-viewed', { path: 'src/b.md', viewed: true }); await Promise.resolve() })
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailSetFileViewed')).toBe(2)
  expect(checkbox(ui.element, 'src/a.ts').disabled).toBe(true)
  expect(checkbox(ui.element, 'src/b.md').disabled).toBe(true)

  await act(async () => { a.reject(new Error('a write failed')); await a.promise.catch(() => {}) })
  await settle()
  expectError(ui.element, 'a write failed')
  expect(checkbox(ui.element, 'src/a.ts').disabled).toBe(false)
  expect(checkbox(ui.element, 'src/b.md').disabled).toBe(true)
  await act(async () => { b.resolve({}); await b.promise })
  await Promise.all([first, second])
  await settle()
  expect(checkbox(ui.element, 'src/b.md').disabled).toBe(false)
})

test('FilesChanged old viewed settlement cannot unlock or poison its A to B to A replacement', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  const oldWrite = ui.holdNext('quirky.reviews/detailSetFileViewed')
  let oldRequest!: Promise<ReviewsUiControlResult>
  await act(async () => { oldRequest = invokeDetached(ui, control(ui, 'files-changed'), 'file-set-viewed', { path: 'src/a.ts' }); await Promise.resolve() })
  await settle()
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { worktree: '/work/b', generation: 2 }))
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { worktree: WORKTREE, generation: 1 }))
  expect(checkbox(ui.element, 'src/a.ts').disabled).toBe(false)
  const newWrite = ui.holdNext('quirky.reviews/detailSetFileViewed')
  let newRequest!: Promise<ReviewsUiControlResult>
  await act(async () => { newRequest = invokeDetached(ui, control(ui, 'files-changed'), 'file-set-viewed', { path: 'src/a.ts' }); await Promise.resolve() })
  await settle()
  await act(async () => { oldWrite.reject(new Error('old viewed failure')); await oldWrite.promise.catch(() => {}) })
  await oldRequest
  await settle()
  expect(checkbox(ui.element, 'src/a.ts').disabled).toBe(true)
  expect(errorTexts(ui.element).join(' ')).not.toContain('old viewed failure')
  await act(async () => { newWrite.resolve({}); await newWrite.promise })
  await newRequest
  await settle()
})
test('FilesChanged refuses viewed changes without a verified head and forged file paths', async () => {
  const invalidHead = mountFiles(reviewState({ headOid: 'g'.repeat(40), files: filesEnvelope([file()]) }))
  await invoke(invalidHead, 'files-changed', 'file-set-viewed', { path: 'src/a.ts' })
  expectError(invalidHead.element, 'current pull request head is unavailable')
  expect(callCount(invalidHead, 'quirky.reviews/detailSetFileViewed')).toBe(0)
  await expect(invoke(invalidHead, 'files-changed', 'file-set-viewed', { path: 'not-in-list.ts' })).rejects.toThrow()
  expect(callCount(invalidHead, 'quirky.reviews/detailSetFileViewed')).toBe(0)
  const valid64 = mountFiles(reviewState({ headOid: 'c'.repeat(64), files: filesEnvelope([file()]) }))
  await invoke(valid64, 'files-changed', 'file-set-viewed', { path: 'src/a.ts' })
  expect(valid64.calls.find((call) => call.method === 'quirky.reviews/detailSetFileViewed')?.params).toEqual({
    worktree: WORKTREE, number: 12, prRepo: REPO, surface: 'detail', path: 'src/a.ts', viewed: true,
  })
})

test('FilesChanged rejects malformed action payloads and old or forged control IDs', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['refresh', { extra: true }], ['collapse-all', { extra: true }], ['expand-all', { extra: true }],
    ['tree-toggle', { visible: 'no' }], ['tree-toggle', { visible: true, extra: 1 }],
    ['diff-mode-set', { mode: 'other' }], ['diff-mode-set', { mode: 'inline', extra: true }],
    ['file-select', { path: 'elsewhere.ts' }], ['file-select', { path: null, extra: true }],
    ['file-toggle-collapse', { path: 'missing.ts' }], ['file-toggle-collapse', { path: 'src/a.ts', collapsed: 1 }],
    ['file-set-viewed', { path: 'src/a.ts', viewed: null }], ['range-start-set', { path: 'src/a.ts', line: '2' }],
    ['range-start-set', { path: 'src/a.ts', line: 2, extra: true }],
    ['inline-comment-open', { path: 'src/a.ts', line: 2, startLine: 4 }],
    ['inline-comment-open', { path: 'src/a.ts', line: 2, startLine: null }],
    ['inline-comment-open', { path: 'src/a.ts', line: 2, extra: true }],
  ]
  for (const [action, value] of invalid) await expect(invoke(ui, 'files-changed', action, value)).rejects.toThrow()
  expect(await invoke(ui, 'files-changed', 'forged-action')).toEqual({ delivered: false, reason: 'unknown-action' })
  const old = control(ui, 'files-changed')
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { worktree: '/work/b' }))
  expect(await invokeDetached(ui, old, 'refresh')).toEqual({ delivered: false, reason: 'target-unavailable' })
  expect(callCount(ui, 'quirky.reviews/detailSetFileViewed')).toBe(0)
})

test('FilesChanged validates rendered right-side range endpoints and preserves the same-file start', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  await invoke(ui, 'files-changed', 'range-start-set', { path: 'src/a.ts', line: 2 })
  await expect(invoke(ui, 'files-changed', 'range-start-set', { path: 'src/a.ts', line: 99 })).rejects.toThrow()
  await expect(invoke(ui, 'files-changed', 'range-start-set', { path: 'src/a.ts', line: 0 })).rejects.toThrow()
  await expect(invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 3, startLine: 99 })).rejects.toThrow()
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 3 })
  expect(ui.element.querySelector('form')?.textContent).toContain('Comment on src/a.ts:2–3')
  const inline = control(ui, 'files-inline-comment')
  expect(JSON.parse(inline.target)).toEqual([REVIEW_VIEW, 'files-inline-comment', WORKTREE, REPO, 12, 'a'.repeat(40), 'inline-comment:src/a.ts:2-3'])
  const form = ui.element.querySelector<HTMLFormElement>('form')!
  expect(form.dataset.reviewInlineControlTarget).toBe(inline.target)
  expect(form.dataset.reviewInlineControlGeneration).toBe(String(inline.generation))

  const binary = mountFiles(reviewState({ files: filesEnvelope([{ ...file('src/bin.dat'), isBinary: true }]) }))
  await expect(invoke(binary, 'files-changed', 'range-start-set', { path: 'src/bin.dat', line: 2 })).rejects.toThrow()
  const unavailable = mountFiles(reviewState({ files: filesEnvelope([{ ...file(), patchUnavailable: true, patch: null }]) }))
  await expect(invoke(unavailable, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 2 })).rejects.toThrow()
})
test('FilesChanged clears a range start when its owner is replaced', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  await invoke(ui, 'files-changed', 'range-start-set', { path: 'src/a.ts', line: 2 })
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { worktree: '/work/b', generation: 2 }))
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { worktree: WORKTREE, generation: 1 }))
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 3 })
  expect(ui.element.querySelector('form')?.textContent).toContain('Comment on src/a.ts:3')
})

test('FilesChanged merges diff mode with a pending live file-view draft', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  const save = ui.holdNext('quirky.reviews/detailSetFilesView')
  const filter = labelledInput(ui.element, 'Filter files')
  changeValue(filter, 'src/')
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailSetFilesView')).toBe(1)
  await invoke(ui, 'files-changed', 'diff-mode-set', { mode: 'side-by-side' })
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailSetFilesView')).toBe(1)
  await act(async () => { save.resolve({ applied: true }); await save.promise })
  await settle()
  const writes = ui.calls.filter((call) => call.method === 'quirky.reviews/detailSetFilesView')
  expect(writes.at(-1)?.params).toMatchObject({ fileFilter: 'src/', diffMode: 'side-by-side' })
})

test('FilesChanged owner generation resets its file-view draft and fences a delayed write failure', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  const save = ui.holdNext('quirky.reviews/detailSetFilesView')
  changeValue(labelledInput(ui.element, 'Filter files'), 'stale draft')
  await settle()
  const replacement = withOwner(reviewState({ files: filesEnvelope([file()]) }), { generation: 2 })
  ui.render(replacement)
  await act(async () => { save.reject(new Error('old view failed')); await save.promise.catch(() => {}) })
  await settle()
  expect(labelledInput(ui.element, 'Filter files').value).toBe('')
  expect(errorTexts(ui.element).join(' ')).not.toContain('old view failed')
})
test('FilesChanged keeps a current files-view failure visible in every content branch', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  ui.setMethod('quirky.reviews/detailSetFilesView', () => Promise.reject(new Error('current view failed')))
  changeValue(labelledInput(ui.element, 'Filter files'), 'src/')
  await settle()
  expectError(ui.element, 'current view failed')
  for (const files of [null, filesEnvelope([], { unavailable: true }), filesEnvelope([]), filesEnvelope([file('other.ts')])]) {
    ui.render(reviewState({ files, fileFilter: 'src/' }))
    expectError(ui.element, 'current view failed')
  }
})

test('FilesChanged inline submit is synchronous, blocks retarget and cancel, and sends the captured range', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  await invoke(ui, 'files-changed', 'range-start-set', { path: 'src/a.ts', line: 2 })
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 3 })
  await invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: '  comment body  ' })
  const submit = ui.holdNext('quirky.reviews/detailInlineComment')
  let sending!: Promise<ReviewsUiControlResult>
  await act(async () => { sending = invokeDetached(ui, control(ui, 'files-inline-comment'), 'inline-comment-submit'); await Promise.resolve() })
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailInlineComment')).toBe(1)
  expect(ui.calls.find((call) => call.method === 'quirky.reviews/detailInlineComment')?.params).toEqual({
    worktree: WORKTREE, number: 12, prRepo: REPO, surface: 'detail', expectedHead: 'a'.repeat(40),
    path: 'src/a.ts', line: 3, startLine: 2, body: '  comment body  ',
  })
  expect(await invoke(ui, 'files-inline-comment', 'inline-comment-submit')).toEqual({ delivered: false, reason: 'disabled' })
  expect(await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 3 })).toEqual({ delivered: false, reason: 'disabled' })
  expect(await invoke(ui, 'files-changed', 'range-start-set', { path: 'src/a.ts', line: 2 })).toEqual({ delivered: false, reason: 'disabled' })
  expect(await invoke(ui, 'files-inline-comment', 'inline-comment-cancel')).toEqual({ delivered: false, reason: 'disabled' })
  await act(async () => { submit.resolve({}); await submit.promise })
  await sending
  await settle()
  expect(ui.element.querySelector('form')).toBeNull()
})

test('FilesChanged inline draft schema, UTF-8 bounds and rejected submission retain the form', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 2 })
  await expect(invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: 'valid', extra: true })).rejects.toThrow()
  await expect(invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: 4 })).rejects.toThrow()
  await invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: 'valid body' })
  await expect(invoke(ui, 'files-inline-comment', 'inline-comment-submit', { extra: true })).rejects.toThrow()
  await expect(invoke(ui, 'files-inline-comment', 'inline-comment-cancel', { extra: true })).rejects.toThrow()
  ui.setMethod('quirky.reviews/detailInlineComment', () => Promise.reject(new Error('comment rejected')))
  await invoke(ui, 'files-inline-comment', 'inline-comment-submit')
  await settle()
  expectError(ui.element, 'comment rejected')
  expect(ui.element.querySelector('form')?.textContent).toContain('Comment on src/a.ts:2')
  expect(ui.element.textContent).toContain('valid body')

  const long = '😀'.repeat(16_385)
  await expect(invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: long })).rejects.toThrow()
})

test('FilesChanged A to B to A stale submit cannot clear the reopened same-anchor draft', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 2 })
  await invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: 'old body' })
  const oldSubmit = ui.holdNext('quirky.reviews/detailInlineComment')
  let oldRequest!: Promise<ReviewsUiControlResult>
  await act(async () => { oldRequest = invokeDetached(ui, control(ui, 'files-inline-comment'), 'inline-comment-submit'); await Promise.resolve() })
  await settle()
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { worktree: '/work/b', generation: 2 }))
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { generation: 1 }))
  expect(ui.element.querySelector('form')).toBeNull()
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 2 })
  await invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: 'new body' })
  await act(async () => { oldSubmit.resolve({}); await oldSubmit.promise })
  await oldRequest
  await settle()
  expect(ui.element.querySelector('form')?.textContent).toContain('Comment on src/a.ts:2')
  expect(ui.element.textContent).toContain('new body')
  expect(ui.element.textContent).not.toContain('old body')
})

test('FilesChanged ignores stale inline dispatch failure after A to B to A', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 2 })
  const heldCommand = ui.holdNext('ui.window.command.run')
  await click(button(ui.element, 'Cancel'))
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { worktree: '/work/b', generation: 2 }))
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { worktree: WORKTREE, generation: 1 }))
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 2 })
  await act(async () => { heldCommand.reject(new Error('old exact-window failure')); await heldCommand.promise.catch(() => {}) })
  await settle()
  expect(ui.element.querySelector('form')).not.toBeNull()
  expect(errorTexts(ui.element).join(' ')).not.toContain('old exact-window failure')
})

test('FilesChanged same-owner inline close and reopen fences a stale delivery failure', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 2 })
  await invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: 'pending body' })
  const heldCommand = ui.holdNext('ui.window.command.run')
  await click(button(ui.element, 'Add review comment'))
  await click(button(ui.element, 'Cancel'))
  expect(ui.element.querySelector('form')).toBeNull()
  await invoke(ui, 'files-changed', 'inline-comment-open', { path: 'src/a.ts', line: 2 })
  await invoke(ui, 'files-inline-comment', 'inline-comment-draft', { body: 'replacement body' })
  await act(async () => { heldCommand.reject(new Error('old inline delivery failed')); await heldCommand.promise.catch(() => {}) })
  await settle()
  expect(ui.element.querySelector('form')?.textContent).toContain('Comment on src/a.ts:2')
  expect(ui.element.textContent).toContain('replacement body')
  expect(errorTexts(ui.element).join(' ')).not.toContain('old inline delivery failed')
})

test('FilesChanged renews leases on owner, head and generation replacements but not local draft renders', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([file()]) }))
  const original = control(ui, 'files-changed')
  await invoke(ui, 'files-changed', 'diff-mode-set', { mode: 'side-by-side' })
  expect(control(ui, 'files-changed').generation).toBe(original.generation)
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { generation: 2 }))
  expect(control(ui, 'files-changed').generation).not.toBe(original.generation)
  const current = control(ui, 'files-changed')
  ui.render(withOwner(reviewState({ files: filesEnvelope([file()]) }), { generation: 2, headOid: 'c'.repeat(40) }))
  expect(control(ui, 'files-changed').generation).not.toBe(current.generation)
})

test('FilesChanged origin-fences rejected dispatch after A to B to A', async () => {
  const ui = mountFiles(reviewState({ files: null }))
  const heldCommand = ui.holdNext('ui.window.command.run')
  await click(button(ui.element, 'Load files'))
  ui.render(withOwner(reviewState({ files: filesEnvelope([]) }), { worktree: '/work/b', generation: 2 }))
  ui.render(withOwner(reviewState({ files: null }), { worktree: WORKTREE, generation: 1 }))
  await act(async () => { heldCommand.reject(new Error('stale dispatch rejected')); await heldCommand.promise.catch(() => {}) })
  await settle()
  expect(errorTexts(ui.element).join(' ')).not.toContain('stale dispatch rejected')
})
test('FilesChanged releases the old refresh token without letting it unlock A to B to A refresh', async () => {
  const ui = mountFiles(reviewState({ files: filesEnvelope([]) }))
  const oldRefresh = ui.holdNext('quirky.reviews/detailRefresh')
  let oldRequest!: Promise<ReviewsUiControlResult>
  await act(async () => { oldRequest = invokeDetached(ui, control(ui, 'files-changed'), 'refresh'); await Promise.resolve() })
  await settle()
  ui.render(withOwner(reviewState({ files: filesEnvelope([]) }), { worktree: '/work/b', generation: 2 }))
  ui.render(withOwner(reviewState({ files: filesEnvelope([]) }), { worktree: WORKTREE, generation: 1 }))
  const newRefresh = ui.holdNext('quirky.reviews/detailRefresh')
  let newRequest!: Promise<ReviewsUiControlResult>
  await act(async () => { newRequest = invokeDetached(ui, control(ui, 'files-changed'), 'refresh'); await Promise.resolve() })
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailRefresh')).toBe(2)
  await act(async () => { oldRefresh.resolve({}); await oldRefresh.promise })
  await oldRequest
  await settle()
  expect(button(ui.element, 'Refresh files').disabled).toBe(true)
  await act(async () => { newRefresh.resolve({}); await newRefresh.promise })
  await newRequest
  await settle()
  expect(button(ui.element, 'Refresh files').disabled).toBe(false)
})

test('ChecksList without an owner uses the shared empty state', () => {
  const ui = mountChecks(reviewState({ owner: false, checks: null }), 'checks')
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No pull request is selected.')
  expect(callCount(ui, 'quirky.reviews/detailRefreshChecks')).toBe(0)
})

test('ChecksList distinguishes loading, idle and malformed null-row states with retry errors visible', async () => {
  const loading = mountChecks(reviewState({ checks: null, detailLoading: true, detailError: 'check query failed' }), 'checks')
  expect(loading.element.querySelector('.ui-empty-state')?.textContent).toContain('Loading checks…')
  expectError(loading.element, 'check query failed')

  const idle = mountChecks(reviewState({ checks: null }), 'checks')
  expect(idle.element.querySelector('.ui-empty-state')?.textContent).toContain('Check data has not been requested yet.')
  expect(button(idle.element, 'Load checks')).toBeTruthy()

  const malformed = mountChecks(reviewState({ checks: { number: 12, checks: [{ name: 'bad' }] } }), 'checks')
  expectError(malformed.element, 'Couldn’t load checks.')
  expect(button(malformed.element, 'Retry')).toBeTruthy()

  malformed.setMethod('quirky.reviews/detailRefreshChecks', () => Promise.reject(new Error('retry checks failed')))
  await invoke(malformed, 'checks-list', 'refresh', undefined, CHECKS_PANEL)
  await settle()
  expectError(malformed.element, 'retry checks failed')
})

test('ChecksList partial provider failures and detail errors always use shared errors', () => {
  const partial = mountChecks(reviewState({ checks: checksEnvelope([check()], { partial: true, partialFailures: ['check query timeout'] }) }))
  expectError(partial.element, 'check query timeout')
  expect(partial.element.querySelector('.ui-notice-line')).toBeNull()

  const detailErrors = detailForChecks({ partialFailures: ['job 41 log unavailable'], tails: [] })
  const details = mountChecks(detailErrors)
  expectError(details.element, 'job 41 log unavailable')
  expectError(details.element, 'Couldn’t load logs.')
})

test('ChecksList shows only a loading or empty state when no rows are reported', () => {
  const loading = mountChecks(reviewState({ checks: checksEnvelope([]), detailLoading: true }), 'checks')
  expect(loading.element.querySelector('.ui-empty-state')?.textContent).toContain('Loading checks…')
  expect(loading.element.textContent).not.toContain('No checks reported for this pull request.')

  const empty = mountChecks(reviewState({ checks: checksEnvelope([]) }), 'checks')
  expect(empty.element.querySelector('.ui-empty-state')?.textContent).toContain('No checks reported for this pull request.')
  expect(empty.element.querySelectorAll('.ui-empty-state')).toHaveLength(1)
})

test('ChecksList target reflects surface, owner, head and compact rerun availability', async () => {
  const full = mountChecks(reviewState({ checks: checksEnvelope([check()]) }), 'checks')
  const registered = control(full, 'checks-list', CHECKS_PANEL)
  expect(JSON.parse(registered.target)).toEqual([CHECKS_PANEL, 'checks-list', WORKTREE, REPO, 12, 'a'.repeat(40), null])
  expect(rootProps(full)?.dataset.reviewControlTarget).toBe(registered.target)
  expect(rootProps(full)?.dataset.reviewControlGeneration).toBe(String(registered.generation))
  expect(registered.actions.map((item) => item.action)).toEqual(expect.arrayContaining(['rerun-failed', 'rerun-all', 'refresh', 'check-toggle']))

  const compact = mountChecks(reviewState({ checks: checksEnvelope([check()]) }), 'detail', true)
  expect(control(compact, 'checks-list').actions.map((item) => item.action)).not.toContain('rerun-failed')
  expect(control(compact, 'checks-list').actions.map((item) => item.action)).not.toContain('rerun-all')
  expect(await invoke(compact, 'checks-list', 'rerun-failed')).toEqual({ delivered: false, reason: 'unknown-action' })
  expect(button(compact.element, 'Fix checks')).toBeTruthy()
})

test('ChecksList malformed action values and forged check/job IDs reject without daemon effects', async () => {
  const ui = mountChecks(detailForChecks({}), 'detail')
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['refresh', { extra: true }], ['summary-toggle', { collapsed: 'yes' }], ['summary-toggle', { collapsed: true, extra: true }],
    ['rerun-failed', { checkId: CHECK_ID }], ['rerun-all', { extra: true }], ['fix-checks', { extra: true }],
    ['check-toggle', { checkId: 'check:missing' }], ['check-toggle', { checkId: CHECK_ID, expanded: 'true' }],
    ['check-toggle', { checkId: CHECK_ID, extra: true }],
    ['check-open', { checkId: 'check:missing' }], ['check-open', { checkId: CHECK_ID, extra: 1 }],
    ['check-details-open', { checkRunId: -1 }], ['check-details-open', { checkRunId: 23, extra: true }],
    ['copy-job-log', { checkRunId: 23, jobId: -1 }], ['copy-job-log', { checkRunId: 23, jobId: 999 }],
    ['copy-job-log', { checkRunId: 23, jobId: 41, extra: true }],
  ]
  for (const [action, value] of invalid) await expect(invoke(ui, 'checks-list', action, value)).rejects.toThrow()
  expect(await invoke(ui, 'checks-list', 'unknown')).toEqual({ delivered: false, reason: 'unknown-action' })
  expect(callCount(ui, 'quirky.reviews/detailRerunChecks')).toBe(0)
  expect(callCount(ui, 'quirky.reviews/openLink')).toBe(0)
  expect(callCount(ui, 'quirky.reviews/detailLoadCheckDetails')).toBe(0)
})

test('ChecksList rerun actions require actionable rows and dispatch exact payloads when available', async () => {
  const empty = mountChecks(reviewState({ checks: checksEnvelope([check('passed', { status: 'completed', conclusion: 'success', checkRunId: 25, workflowRunId: null })]) }))
  expect(await invoke(empty, 'checks-list', 'rerun-failed')).toEqual({ delivered: false, reason: 'disabled' })
  expect(await invoke(empty, 'checks-list', 'rerun-all')).toMatchObject({ delivered: true })
  expect(empty.calls.find((call) => call.method === 'quirky.reviews/detailRerunChecks')?.params).toMatchObject({ failedOnly: false })

  const failing = mountChecks(reviewState({ checks: checksEnvelope([check()]) }))
  await invoke(failing, 'checks-list', 'rerun-failed')
  expect(failing.calls.find((call) => call.method === 'quirky.reviews/detailRerunChecks')?.params).toMatchObject({
    surface: 'detail', worktree: WORKTREE, number: 12, prRepo: REPO, failedOnly: true,
  })
})

test('ChecksList locks same-tick refresh, rerun, summary and fix actions synchronously', async () => {
  const scenarios = [
    { action: 'refresh', method: 'quirky.reviews/detailRefreshChecks', value: undefined },
    { action: 'rerun-failed', method: 'quirky.reviews/detailRerunChecks', value: undefined },
    { action: 'rerun-all', method: 'quirky.reviews/detailRerunChecks', value: undefined },
    { action: 'summary-toggle', method: 'quirky.reviews/detailSetChecksCollapsed', value: { collapsed: true } },
    { action: 'fix-checks', method: 'quirky.reviews/checksSetAgentDialog', value: undefined },
  ] as const
  for (const scenario of scenarios) {
    const ui = mountChecks(reviewState({ checks: checksEnvelope([check()]) }))
    const held = ui.holdNext(scenario.method)
    let first!: Promise<ReviewsUiControlResult>
    let second!: Promise<ReviewsUiControlResult>
    await act(async () => {
      first = invokeDetached(ui, control(ui, 'checks-list'), scenario.action, scenario.value)
      second = invokeDetached(ui, control(ui, 'checks-list'), scenario.action, scenario.value)
      await Promise.resolve()
    })
    await settle()
    expect(callCount(ui, scenario.method)).toBe(1)
    expect(await invoke(ui, 'checks-list', scenario.action, scenario.value)).toEqual({ delivered: false, reason: 'disabled' })
    await act(async () => { held.resolve({}); await held.promise })
    await Promise.all([first, second])
    await settle()
  }
})

test('ChecksList Fix uses checksSetAgentDialog with surface-specific target fields', async () => {
  const detail = mountChecks(reviewState({ checks: checksEnvelope([check()]) }), 'detail')
  await invoke(detail, 'checks-list', 'fix-checks')
  expect(detail.calls.find((call) => call.method === 'quirky.reviews/checksSetAgentDialog')?.params).toEqual({ surface: 'detail', action: 'fix' })

  const checks = mountChecks(reviewState({ checks: checksEnvelope([check()]) }), 'checks')
  await invoke(checks, 'checks-list', 'fix-checks', undefined, CHECKS_PANEL)
  expect(checks.calls.find((call) => call.method === 'quirky.reviews/checksSetAgentDialog')?.params).toEqual({ surface: 'checks', worktree: WORKTREE, action: 'fix' })
})

test('ChecksList gates auto-refresh by surface, verified head and owner attempt, but manual refresh is head-independent', async () => {
  const failed = mountChecks(reviewState({ checks: null }), 'detail', false, {
    'quirky.reviews/detailRefreshChecks': () => Promise.reject(new Error('auto refresh failed')),
  })
  await settle()
  expect(callCount(failed, 'quirky.reviews/detailRefreshChecks')).toBe(1)
  expectError(failed.element, 'auto refresh failed')
  failed.render(reviewState({ checks: null }))
  await settle()
  expect(callCount(failed, 'quirky.reviews/detailRefreshChecks')).toBe(1)
  failed.render(withOwner(reviewState({ checks: null }), { worktree: '/work/b', generation: 2 }))
  await settle()
  expect(callCount(failed, 'quirky.reviews/detailRefreshChecks')).toBe(2)

  const activeLoading = mountChecks(reviewState({ checks: null, detailLoading: true }))
  await settle()
  expect(callCount(activeLoading, 'quirky.reviews/detailRefreshChecks')).toBe(0)

  const invalidHead = mountChecks(reviewState({ checks: null, headOid: 'not-a-sha' }))
  await settle()
  expect(callCount(invalidHead, 'quirky.reviews/detailRefreshChecks')).toBe(0)
  expect(invalidHead.element.querySelector('.ui-empty-state')?.textContent).toContain('Check data has not been requested yet.')

  const panel = mountChecks(reviewState({ checks: null }), 'checks')
  await settle()
  expect(callCount(panel, 'quirky.reviews/detailRefreshChecks')).toBe(0)

  const manual = mountChecks(reviewState({ checks: checksEnvelope([check()]), headOid: 'not-a-sha' }))
  await invoke(manual, 'checks-list', 'refresh')
  expect(callCount(manual, 'quirky.reviews/detailRefreshChecks')).toBe(1)
  expect(manual.calls.find((call) => call.method === 'quirky.reviews/detailRefreshChecks')?.params).toMatchObject({ worktree: WORKTREE, number: 12 })
})

test('ChecksList does not continue a check expansion after A to B to A owner replacement', async () => {
  const ui = mountChecks(reviewState({ checks: checksEnvelope([check()]) }))
  const expansion = ui.holdNext('quirky.reviews/detailExpandCheck')
  let request!: Promise<ReviewsUiControlResult>
  await act(async () => { request = invokeDetached(ui, control(ui, 'checks-list'), 'check-toggle', { checkId: CHECK_ID, expanded: true }); await Promise.resolve() })
  await settle()
  ui.render(withOwner(reviewState({ checks: checksEnvelope([check()]) }), { worktree: '/work/b', generation: 2 }))
  ui.render(withOwner(reviewState({ checks: checksEnvelope([check()]) }), { generation: 1 }))
  await act(async () => { expansion.resolve({}); await expansion.promise })
  await request
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailExpandCheck')).toBe(1)
  expect(callCount(ui, 'quirky.reviews/detailLoadCheckDetails')).toBe(0)
})

test('ChecksList expands with a verified head, exposes loading and retryable detail failures', async () => {
  const ui = mountChecks(reviewState({ checks: checksEnvelope([check()]) }))
  ui.setMethod('quirky.reviews/detailExpandCheck', () => {
    ui.render(reviewState({ checks: checksEnvelope([check()]), expandedChecks: [CHECK_ID] }))
    return {}
  })
  const loading = ui.holdNext('quirky.reviews/detailLoadCheckDetails')
  let request!: Promise<ReviewsUiControlResult>
  await act(async () => { request = invokeDetached(ui, control(ui, 'checks-list'), 'check-toggle', { checkId: CHECK_ID, expanded: true }); await Promise.resolve() })
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailLoadCheckDetails')).toBe(1)
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('Loading check details…')
  await act(async () => { loading.reject(new Error('details unavailable')); await loading.promise.catch(() => {}) })
  await request
  await settle()
  expectError(ui.element, 'details unavailable')
  expect(button(ui.element, 'Retry check details')).toBeTruthy()
  expect(ui.element.querySelector('.ui-empty-state')).toBeNull()
})

test('ChecksList refuses detail expansion on an invalid head and checks current check IDs', async () => {
  const ui = mountChecks(reviewState({ checks: checksEnvelope([check()]), headOid: 'bad' }))
  await invoke(ui, 'checks-list', 'check-toggle', { checkId: CHECK_ID, expanded: true })
  expectError(ui.element, 'verified pull request head')
  expect(callCount(ui, 'quirky.reviews/detailLoadCheckDetails')).toBe(0)
  expect(callCount(ui, 'quirky.reviews/detailExpandCheck')).toBe(0)
  await expect(invoke(ui, 'checks-list', 'check-toggle', { checkId: 'workflow:24' })).rejects.toThrow()
})

test('ChecksList uses loaded CheckDetail URL priority and rejects unsafe URLs', async () => {
  const loaded = mountChecks(detailForChecks({ check: { detailsUrl: 'https://example.test/details', htmlUrl: 'https://example.test/html', url: 'https://example.test/raw' } }))
  await invoke(loaded, 'checks-list', 'check-details-open', { checkRunId: 23 })
  expect(loaded.calls.find((call) => call.method === 'quirky.reviews/openLink')?.params.url).toBe('https://example.test/details')
  await click(button(loaded.element, 'View full details'))
  expect(loaded.calls.filter((call) => call.method === 'quirky.reviews/openLink').at(-1)?.params.url).toBe('https://example.test/details')
  expect(await invoke(loaded, 'checks-list', 'check-open', { checkId: CHECK_ID })).toMatchObject({ delivered: true })
  expect(loaded.calls.filter((call) => call.method === 'quirky.reviews/openLink').at(-1)?.params.url).toBe('https://github.com/owner/repo/checks/23')
  const unsafe = mountChecks(detailForChecks({ check: { detailsUrl: 'javascript:alert(1)', htmlUrl: 'https://safe.test/fallback' } }))
  await invoke(unsafe, 'checks-list', 'check-details-open', { checkRunId: 23 }).catch(() => null)
  expect(callCount(unsafe, 'quirky.reviews/openLink')).toBe(0)
})

test('ChecksList copies only expanded, bounded log tails to a fake local clipboard', async () => {
  previousClipboard = navigator.clipboard
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { clipboardWrites.push(text) } } })
  const ui = mountChecks(detailForChecks({}))
  await click(button(ui.element, 'Copy log excerpt'))
  expect(clipboardWrites).toEqual(['failed: assertion'])
  expect(callCount(ui, 'quirky.reviews/copyText')).toBe(0)
  expect(callCount(ui, 'ui.window.command.run')).toBeGreaterThan(0)
  const emptyTail = mountChecks(reviewState({
    checks: checksEnvelope([check()], { detailsById: { '23': checkDetail({ tails: [{ jobId: 41, jobName: 'unit tests', tail: '' }] }) } }),
  }))
  await invoke(emptyTail, 'checks-list', 'copy-job-log', { checkRunId: 23, jobId: 41 }).catch(() => null)
  const oversized = mountChecks(reviewState({
    checks: checksEnvelope([check()], {
      detailsById: { '23': checkDetail({ tails: [{ jobId: 41, jobName: 'unit tests', tail: 'x'.repeat(1_048_577) }] }) },
    }),
  }))
  await invoke(oversized, 'checks-list', 'copy-job-log', { checkRunId: 23, jobId: 41 }).catch(() => null)
  const collapsed = mountChecks(reviewState({
    checks: checksEnvelope([check()], { detailsById: { '23': checkDetail() } }),
    expandedChecks: [],
  }))
  await invoke(collapsed, 'checks-list', 'copy-job-log', { checkRunId: 23, jobId: 41 }).catch(() => null)
  expect(clipboardWrites).toEqual(['failed: assertion'])
})

test('ChecksList turns local clipboard rejection into an origin-fenced shared error', async () => {
  previousClipboard = navigator.clipboard
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('clipboard unavailable') } } })
  const ui = mountChecks(detailForChecks({}))
  await click(button(ui.element, 'Copy log excerpt'))
  await settle()
  expectError(ui.element, 'clipboard unavailable')
  expect(callCount(ui, 'quirky.reviews/copyText')).toBe(0)
})

test('JobLog empty, bounded and failed branches use the right shared component', () => {
  const noLog = mountChecks(detailForChecks({ jobs: [{ id: 41, name: 'unit tests', conclusion: 'success' }], tails: [] }))
  expect(noLog.element.querySelector('.ui-empty-state')?.textContent).toContain('Log output is not available yet.')
  const emptyLog = mountChecks(detailForChecks({ jobs: [{ id: 41, name: 'unit tests', conclusion: 'failure' }], tails: [{ jobId: 41, jobName: 'unit tests', tail: '' }] }))
  expect(emptyLog.element.querySelector('.ui-empty-state')?.textContent).toContain('No log output was returned.')
  const bounded = mountChecks(detailForChecks({ jobs: [{ id: 41, name: 'unit tests', conclusion: 'failure' }], tails: [], truncated: true }))
  expect(bounded.element.querySelector('.ui-notice-line')?.textContent).toContain('At most five failed-job excerpts')
  expect(bounded.element.querySelector('.ui-empty-state')).toBeNull()
  const failed = mountChecks(detailForChecks({ jobs: [{ id: 41, name: 'unit tests', conclusion: 'failure' }], tails: [], partialFailures: ['job 41 log failed'] }))
  expectError(failed.element, 'Couldn’t load logs.')
  expectError(failed.element, 'job 41 log failed')
  expect(failed.element.querySelector('.ui-notice-line')).toBeNull()
})

test('ChecksList surfaces delivered-false diagnostics and fences stale dispatch failures', async () => {
  const ui = mountChecks(reviewState({ checks: null }), 'checks')
  ui.setMethod('ui.window.command.run', async () => ({ result: { delivered: false, reason: 'disabled' } }))
  await click(button(ui.element, 'Load checks'))
  expectError(ui.element, 'That review control is currently disabled.')
  expect(button(ui.element, 'Retry')).toBeTruthy()
  const stale = mountChecks(reviewState({ checks: checksEnvelope([check()]) }))
  const held = stale.holdNext('ui.window.command.run')
  await click(button(stale.element, 'Refresh checks'))
  stale.render(withOwner(reviewState({ checks: checksEnvelope([check()]) }), { worktree: '/work/b', generation: 2 }))
  stale.render(withOwner(reviewState({ checks: checksEnvelope([check()]) }), { worktree: WORKTREE, generation: 1 }))
  await act(async () => { held.reject(new Error('obsolete checks dispatch')); await held.promise.catch(() => {}) })
  await settle()
  expect(errorTexts(stale.element).join(' ')).not.toContain('obsolete checks dispatch')
})

test('ChecksList does not load a check removed while expansion is pending', async () => {
  const ui = mountChecks(reviewState({ checks: checksEnvelope([check()]) }))
  const expansion = ui.holdNext('quirky.reviews/detailExpandCheck')
  let request!: Promise<ReviewsUiControlResult>
  await act(async () => {
    request = invokeDetached(ui, control(ui, 'checks-list'), 'check-toggle', { checkId: CHECK_ID, expanded: true })
    await Promise.resolve()
  })
  await settle()
  ui.render(reviewState({ checks: checksEnvelope([]), expandedChecks: [CHECK_ID] }))
  await act(async () => { expansion.resolve({}); await expansion.promise })
  await request
  await settle()
  expect(callCount(ui, 'quirky.reviews/detailLoadCheckDetails')).toBe(0)
})
