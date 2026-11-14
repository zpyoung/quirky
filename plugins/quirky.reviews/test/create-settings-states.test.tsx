import { afterAll, afterEach, expect, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { CreateReview } from '../src/create/CreateReview'
import { HostingSettings } from '../src/create/HostingSettings'
import { CREATE_VIEW, SETTINGS_VIEW, type ReviewsState } from '../src/contracts'
import { isRecord, listReviewsUiControls, requestReviewsUiControl, type ReviewsUiControlResult } from '../src/checks/data'
import { activate } from '../src/ui'
import { nextDraftTick } from '../src/draft-field'
const CONTROL_COMMAND = 'command:quirky.reviews/ui-control'
const ROOTS: Root[] = []
const SURFACE_CLEANUPS: Array<() => void> = []

type RecordValue = Record<string, unknown>
type SurfaceMount = (element: HTMLElement, props: { report(value: unknown): void }) => (() => void) | void
type MountedSurface = { element: HTMLElement; reports: unknown[]; unmount(): Promise<void> }
type HarnessSetup = {
  holdNext(method: string): Deferred<unknown>
  replyNext(method: string, value: unknown): void
  setMethod(method: string, implementation: Method): void
}
type ConfigureHarness = (controls: HarnessSetup) => void
type UiControlDescriptor = {
  surface: string
  slot: string
  target: string
  generation: number
  actions: Array<{ action: string; enabled: boolean }>
}

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE_A = '/work/a'
const DEFAULTS = { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }
const DEFAULTS_TRUE = { draft: true, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }

type Call = { method: string; params: Record<string, unknown> }
type Method = (params: Record<string, unknown>) => unknown | Promise<unknown>
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
type Harness = {
  context: UiPluginContext
  element: HTMLElement
  calls: Call[]
  holdNext(method: string): Deferred<unknown>
  replyNext(method: string, value: unknown): void
  setMethod(method: string, implementation: Method): void
  getProvider(id: string): unknown
  mountSurface(id: string): MountedSurface
  executeCommandCalls(): number
  refreshes: number
  render(state: ReviewsState, worktree?: string | null): void
  unmount(): Promise<void>
}

function deferred<T = unknown>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function stateFor(options: {
  worktree?: string | null
  creation?: Partial<ReviewsState['creation']>
  settings?: Partial<ReviewsState['settings']>
  defaults?: ReviewsState['defaults']
  repoDefaults?: ReviewsState['repoDefaults']
} = {}): ReviewsState {
  const worktree = options.worktree === undefined ? WORKTREE_A : options.worktree
  const creation = {
    worktree, generation: 1, loading: false, error: null,
    eligibility: { eligible: true, confirmedAt: Date.now(), stackSupported: false },
    title: 'Create title', body: 'Create body', base: 'main', head: 'feature', draft: false, useTemplate: false,
    bases: ['main', 'release'], generating: false, requestId: null, submitting: false, generated: false,
    result: null, defaults: DEFAULTS, ...options.creation
  }
  const settings = {
    worktree, generation: 1, loading: false, error: null,
    diagnostics: {
      ghAvailable: true, requiredHost: 'github.com', requiredHostAuthenticated: true,
      missingScopes: [], requiredScopes: ['repo'], envTokenInProcess: false, activeAccount: null
    },
    accounts: { requiredHost: 'github.com', accounts: [] },
    configuration: { account: null },
    budget: {
      core: { limit: 5000, remaining: 4000, resetAt: Date.now() + 3_600_000 },
      search: { limit: 30, remaining: 20, resetAt: Date.now() + 3_600_000 },
      graphql: { limit: 5000, remaining: 3000, resetAt: Date.now() + 3_600_000 },
      fetchedAt: Date.now()
    },
    fetchedAt: Date.now(), ...options.settings
  }
  return {
    revision: 1, previousView: null,
    detail: {
      target: null, tab: 'conversation', generation: 1, loading: false, error: null, review: null,
      details: null, checks: null, comments: null, files: null, audience: 'all', grouping: 'grouped',
      expandedChecks: [], queuedComments: [], checksCollapsed: false, selectedFile: null, diffMode: 'inline',
      collapsedFiles: [], fileFilter: '', fileTreeVisible: true, commentDraft: '', bodyDraft: null, pending: [], fetchedAt: Date.now()
    },
    checks: {
      worktree, generation: 1, loading: false, error: null, lookup: null, eligibility: null, review: null,
      checks: null, comments: null, conflicts: null, audience: 'all', grouping: 'grouped', expandedChecks: [],
      queuedComments: [], checksCollapsed: false, commentDraft: '', titleDraft: null, height: 320,
      fetchedAt: Date.now(), agentDialog: null
    },
    creation, settings, defaults: options.defaults ?? DEFAULTS, repoDefaults: options.repoDefaults ?? {},
    botOverrides: [], links: {}, suppressed: {}
  } as unknown as ReviewsState
}

function defaultReply(method: string, params: Record<string, unknown>): unknown {
  if (method === 'quirky.worktree/list') return [{ kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' }]
  if (method === 'quirky.reviews/creationDefaults') return params.scope === 'repository'
    ? { defaults: DEFAULTS, repoId: 'owner/repo', overrides: {} }
    : { defaults: DEFAULTS }
  if (method === 'quirky.reviews/createOpen') return { opened: true }
  if (method === 'quirky.reviews/createDraft') return { updated: true }
  if (method === 'quirky.reviews/createBase') return { base: params.base }
  if (method === 'quirky.reviews/createGenerate') return { title: 'Generated title', body: 'Generated body' }
  if (method === 'quirky.reviews/resetCreationDefaults') return { defaults: DEFAULTS }
  return undefined
}

function mount(
  renderNode: (props: { context: UiPluginContext; state: ReviewsState; refresh(): Promise<void>; snapshot: number }) => ReactNode,
  initialState = stateFor(),
  initialWorktree: string | null = initialState.checks.worktree,
  setup?: ConfigureHarness,
  connectionId = 42
): Harness {
  const calls: Call[] = []
  const methods = new Map<string, Method>()
  const held = new Map<string, Deferred<unknown>[]>()
  const replies = new Map<string, unknown[]>()
  const provided = new Map<string, unknown>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const surfaceCleanups: Array<() => void> = []
  let state = initialState
  let worktree = initialWorktree
  let refreshes = 0
  let executeCommandCount = 0
  let layout = { worktree, view: { id: 'view:fixture' }, panel: null, sidebar: true, focus: 'view' } as unknown as UiLayout
  const context = {
    pluginId: 'quirky.reviews',
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const pending = held.get(method)?.shift()
      if (held.get(method)?.length === 0) held.delete(method)
      if (pending) return pending.promise
      const queued = replies.get(method)
      if (queued?.length) return queued.shift()
      const implementation = methods.get(method)
      if (implementation) return await implementation(params)
      if (method === 'quirky.reviews/state') return state
      if (method === 'ui.window.self') return { connId: connectionId }
      if (method === 'ui.window.command.run') {
        if (params.connId !== connectionId || params.id !== CONTROL_COMMAND) throw new Error('Unexpected exact-window command route.')
        const handler = provided.get(CONTROL_COMMAND)
        if (typeof handler !== 'function') throw new Error('The generic UI control handler is not provided.')
        const run = handler as (input?: unknown) => unknown | Promise<unknown>
        return { result: await run(params.args) }
      }
      return defaultReply(method, params)
    },
    getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) { layoutListeners.add(listener); return () => layoutListeners.delete(listener) },
    onConnection: () => () => {},
    subscribe: () => () => {},
    getSetting: () => undefined,
    toast() {},
    log() {},
    async executeCommand() { executeCommandCount += 1 }
  } as unknown as UiPluginContext
  const controls: HarnessSetup = {
    holdNext(method: string) {
      const request = deferred<unknown>()
      held.set(method, [...(held.get(method) ?? []), request])
      return request
    },
    replyNext(method: string, value: unknown) { replies.set(method, [...(replies.get(method) ?? []), value]) },
    setMethod(method: string, implementation: Method) { methods.set(method, implementation) }
  }
  setup?.(controls)
  activate(context)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  ROOTS.push(root)
  const refresh = async () => { refreshes += 1 }
  const draw = () => root.render(renderNode({ context, state, refresh, snapshot: 0 }))
  act(draw)
  const mountSurface = (id: string): MountedSurface => {
    const implementation = provided.get(id)
    if (typeof implementation !== 'function') throw new Error(`Missing activated surface: ${id}`)
    const surfaceElement = document.createElement('div')
    document.body.appendChild(surfaceElement)
    const reports: unknown[] = []
    const mountFunction = implementation as SurfaceMount
    let cleanup: (() => void) | void = undefined
    act(() => { cleanup = mountFunction(surfaceElement, { report: (value) => reports.push(value) }) })
    const unmount = async () => {
      await act(async () => {
        if (typeof cleanup === 'function') cleanup()
        surfaceElement.remove()
        await Promise.resolve()
      })
      if (typeof cleanup === 'function') {
        const localIndex = surfaceCleanups.indexOf(cleanup)
        if (localIndex >= 0) surfaceCleanups.splice(localIndex, 1)
        const globalIndex = SURFACE_CLEANUPS.indexOf(cleanup)
        if (globalIndex >= 0) SURFACE_CLEANUPS.splice(globalIndex, 1)
      }
    }
    if (typeof cleanup === 'function') {
      surfaceCleanups.push(cleanup)
      SURFACE_CLEANUPS.push(cleanup)
    }
    return { element: surfaceElement, reports, unmount }
  }
  return {
    context,
    calls,
    ...controls,
    getProvider(id: string) { return provided.get(id) },
    mountSurface,
    executeCommandCalls: () => executeCommandCount,
    get refreshes() { return refreshes },
    element,
    render(next, nextWorktree = worktree) {
      state = next
      worktree = nextWorktree
      layout = { ...layout, worktree } as UiLayout
      for (const listener of [...layoutListeners]) listener(layout)
      act(draw)
    },
    async unmount() {
      ROOTS.splice(ROOTS.indexOf(root), 1)
      const cleanups = surfaceCleanups.splice(0).reverse()
      await act(async () => {
        for (const cleanup of cleanups) cleanup()
        root.unmount()
        await Promise.resolve()
      })
      for (const cleanup of cleanups) {
        const globalIndex = SURFACE_CLEANUPS.indexOf(cleanup)
        if (globalIndex >= 0) SURFACE_CLEANUPS.splice(globalIndex, 1)
      }
    }
  }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    await act(async () => { await promise })
  }
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
  await settle()
}
function reactProps(node: HTMLElement): Record<string, (...args: never[]) => void> {
  const key = Object.getOwnPropertyNames(node).find((candidate) => candidate.startsWith('__reactProps$'))
  if (!key) throw new Error('Could not find React event handlers on the rendered control.')
  return (node as unknown as Record<string, Record<string, (...args: never[]) => void>>)[key]!
}

function changeValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  node.value = value
  const onChange = reactProps(node).onChange
  if (!onChange) throw new Error('The rendered field does not have an onChange handler.')
  act(() => onChange({ target: node, currentTarget: node } as never))
}
function changeChecked(node: HTMLInputElement, checked: boolean) {
  node.checked = checked
  const onChange = reactProps(node).onChange
  if (!onChange) throw new Error('The rendered checkbox does not have an onChange handler.')
  act(() => onChange({ target: node, currentTarget: node } as never))
}

function pressCtrlEnter(node: HTMLTextAreaElement) {
  const onKeyDown = reactProps(node).onKeyDown
  if (!onKeyDown) throw new Error('The rendered description does not have a keyboard handler.')
  act(() => onKeyDown({
    key: 'Enter',
    ctrlKey: true,
    metaKey: false,
    currentTarget: node,
    preventDefault() {}
  } as never))
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
function latestControl(reports: unknown[], surface: string, slot: string): UiControlDescriptor {
  for (const report of reports.slice().reverse()) {
    if (!isRecord(report) || !Array.isArray(report.uiControls)) continue
    const control = report.uiControls.find((item) => isRecord(item) && item.surface === surface && item.slot === slot)
    if (!isRecord(control) || typeof control.target !== 'string' || typeof control.generation !== 'number' || !Array.isArray(control.actions)) continue
    const actions: UiControlDescriptor['actions'] = []
    for (const item of control.actions) {
      if (!isRecord(item) || typeof item.action !== 'string' || typeof item.enabled !== 'boolean') {
        throw new Error(`Invalid reported action for ${surface}/${slot}.`)
      }
      actions.push({ action: item.action, enabled: item.enabled })
    }
    return { surface, slot, target: control.target, generation: control.generation, actions }
  }
  throw new Error(`No reported UI control for ${surface}/${slot}.`)
}

function findControlRoot(root: ParentNode, descriptor: UiControlDescriptor): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('[data-review-control-target]')].find((item) =>
    item.dataset.reviewControlTarget === descriptor.target
      && item.dataset.reviewControlGeneration === String(descriptor.generation)) ?? null
}

async function requestControl(
  harness: Harness,
  descriptor: UiControlDescriptor,
  action: string,
  value?: RecordValue
): Promise<ReviewsUiControlResult> {
  let result: ReviewsUiControlResult | null = null
  await act(async () => {
    result = await requestReviewsUiControl(harness.context, {
      target: descriptor.target,
      generation: descriptor.generation,
      action,
      ...(value === undefined ? {} : { value })
    })
  })
  if (result === null) throw new Error('The exact-window command returned no delivery result.')
  return result
}

function requestReportedControl(
  harness: Harness,
  reports: unknown[],
  surface: string,
  slot: string,
  action: string,
  value?: RecordValue
): Promise<ReviewsUiControlResult> {
  return requestControl(harness, latestControl(reports, surface, slot), action, value)
}
function registeredControl(harness: Harness, surface: string, slot: string): UiControlDescriptor {
  const control = listReviewsUiControls(harness.context, surface).find((item) => item.slot === slot)
  if (!control) throw new Error(`No registered UI control for ${surface}/${slot}.`)
  return {
    surface: control.surface,
    slot: control.slot,
    target: control.target,
    generation: control.generation,
    actions: control.actions
  }
}

function requestRegisteredControl(
  harness: Harness,
  surface: string,
  slot: string,
  action: string,
  value?: RecordValue
): Promise<ReviewsUiControlResult> {
  return requestControl(harness, registeredControl(harness, surface, slot), action, value)
}

function create(
  initial: ReviewsState,
  worktree: string | null = WORKTREE_A,
  setup?: ConfigureHarness,
  connectionId = 42
) {
  return mount((props) => <CreateReview {...props} />, initial, worktree, setup, connectionId)
}

function settings(
  initial: ReviewsState,
  worktree: string | null = WORKTREE_A,
  setup?: ConfigureHarness,
  connectionId = 42
) {
  return mount((props) => <HostingSettings {...props} />, initial, worktree, setup, connectionId)
}
type ActivatedSurface = { harness: Harness; mounted: MountedSurface }

function mountActivatedSurface(
  surface: string,
  initial: ReviewsState = stateFor(),
  worktree: string | null = initial.checks.worktree,
  setup?: ConfigureHarness,
  connectionId = 42
): ActivatedSurface {
  const harness = mount(() => <div />, initial, worktree, setup, connectionId)
  return { harness, mounted: harness.mountSurface(surface) }
}

afterEach(async () => {
  const cleanups = SURFACE_CLEANUPS.splice(0).reverse()
  const roots = ROOTS.splice(0).reverse()
  await act(async () => {
    for (const cleanup of cleanups) cleanup()
    for (const root of roots) root.unmount()
    await Promise.resolve()
  })
  await settle()
})
afterAll(() => GlobalRegistrator.unregister())

test('creation without a selected target is a neutral empty state and sends no create request', async () => {
  const ui = create(stateFor({ worktree: null, creation: { worktree: null } }), null)
  await settle()
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('Select a Git worktree before creating a pull request.')
  expect(ui.element.querySelector('[role="alert"]')).toBeNull()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/createOpen')).toHaveLength(0)
})

test('creation confirmation distinguishes an in-flight read from a failed read and retries it', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let opens = 0
  const ui = create(stateFor({ creation: { worktree: null, loading: false, error: null } }), WORKTREE_A, (h) => {
    h.setMethod('quirky.reviews/createOpen', () => (++opens === 1 ? first.promise : second.promise))
  })
  await settle()
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Confirming this worktree and its current branch…')
  expect(ui.element.querySelector('.ui-inline-error')).toBeNull()

  await act(async () => { first.reject(new Error('confirmation fixture failed')); await first.promise.catch(() => {}) })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('confirmation fixture failed')
  expect(ui.element.querySelector('.ui-notice-line')).toBeNull()
  expect(button(ui.element, 'Retry confirmation')).toBeTruthy()

  const retry = button(ui.element, 'Retry confirmation')
  await act(async () => { retry.click(); retry.click() })
  expect(opens).toBe(2)
  await settle()
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toBe('Confirming this worktree and its current branch…')
  await act(async () => { second.resolve({ opened: true }); await second.promise })
  await settle()
  expect(ui.refreshes).toBe(1)
})

test('an empty remote base list is explicit while drafts remain visible and submission is disabled', async () => {
  const ui = create(stateFor({ creation: { bases: [] } }))
  await settle()
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No remote base branches are available.')
  expect(ui.element.querySelector<HTMLInputElement>('#review-title')?.value).toBe('Create title')
  expect(ui.element.querySelector<HTMLTextAreaElement>('#review-body')?.value).toBe('Create body')
  expect(button(ui.element, 'Create PR').disabled).toBe(true)
  expect(ui.element.querySelector('input[list="review-base-options"]')).not.toBeNull()
  expect(ui.element.querySelector('datalist#review-base-options')).not.toBeNull()
})

test('creation state failures use shared errors and preserve result and draft content', async () => {
  const failed = create(stateFor({ creation: { error: 'eligibility fixture failed', title: 'Retained title', body: 'Retained body' } }))
  await settle()
  expect(failed.element.querySelector('.ui-inline-error')?.textContent).toContain('eligibility fixture failed')
  expect(failed.element.querySelector('.ui-notice-line')).toBeNull()
  expect(failed.element.querySelector<HTMLInputElement>('#review-title')?.value).toBe('Retained title')
  expect(failed.element.querySelector<HTMLTextAreaElement>('#review-body')?.value).toBe('Retained body')

  const partial = create(stateFor({ creation: {
    result: { status: 'partial', review: { number: 8, url: 'https://github.com/owner/repo/pull/8' } },
    error: 'Pull request created; stack registration was incomplete.'
  } }))
  await settle()
  expect(partial.element.querySelector('.ui-inline-error')?.textContent).toContain('Pull request created; stack registration was incomplete.')
  expect(partial.element.textContent).toContain('Pull request #8')
  expect(button(partial.element, 'Open review')).toBeTruthy()
})

test('field write failures are associated with the failing field', async () => {
  const ui = create(stateFor())
  const save = ui.holdNext('quirky.reviews/createDraft')
  const title = ui.element.querySelector<HTMLInputElement>('#review-title')!
  changeValue(title, 'Changed title')
  await settle()
  await act(async () => { save.reject(new Error('title write failed')); await save.promise.catch(() => {}) })
  await settle()
  const titleInput = ui.element.querySelector<HTMLInputElement>('#review-title')!
  const errorId = `${titleInput.id}-error`
  expect(titleInput.getAttribute('aria-invalid')).toBe('true')
  expect(titleInput.getAttribute('aria-describedby')?.split(' ')).toContain(errorId)
  expect(ui.element.querySelector(`#${errorId}`)?.textContent).toContain('title write failed')
})

test('a stack capability read failure uses shared error UI', async () => {
  const ui = create(stateFor({ creation: { eligibility: { eligible: true, confirmedAt: Date.now(), stackSupported: true, stackLookupError: 'stack fixture failed' } } }))
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Stack capability could not be confirmed: stack fixture failed')
})

test('registered worktrees show pending, genuine empty and recoverable failed outcomes', async () => {
  const pending = deferred<unknown>()
  const ui = settings(stateFor(), WORKTREE_A, (h) => { h.setMethod('quirky.worktree/list', () => pending.promise) })
  await settle()
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading registered worktrees…')
  await act(async () => { pending.resolve([{ kind: 'folder' }]); await pending.promise })
  await settle()
  expect(ui.element.querySelector('.ui-empty-state')?.textContent).toContain('No registered Git worktrees are available. Global creation defaults remain available.')
  expect(ui.element.querySelector('.ui-notice-line')).toBeNull()
})

test('registered-worktree failures stop loading and Retry worktrees rereads without remounting', async () => {
  let reads = 0
  const ui = settings(stateFor(), WORKTREE_A, (h) => {
    h.setMethod('quirky.worktree/list', () => ++reads === 1 ? Promise.reject(new Error('workspace fixture failed')) : [])
  })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Could not list registered worktrees: workspace fixture failed')
  expect(ui.element.querySelector('.ui-notice-line')).toBeNull()
  await click(button(ui.element, 'Retry worktrees'))
  expect(reads).toBe(2)
  expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
})

test('malformed workspace results preserve the established validation message', async () => {
  const ui = settings(stateFor(), WORKTREE_A, (h) => { h.setMethod('quirky.worktree/list', () => [{ kind: 'git', id: 7 }]) })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('The worktree service returned an invalid workspace list.')
  expect(ui.element.textContent).not.toContain('No registered Git worktrees are available.')
})

test('no selected worktree keeps global defaults usable without repository failures', async () => {
  const ui = settings(stateFor({ worktree: null, settings: { worktree: null, diagnostics: null, accounts: null, configuration: null, budget: null } }), null, (h) => {
    h.setMethod('quirky.worktree/list', () => [])
  })
  await settle()
  expect([...ui.element.querySelectorAll('.ui-empty-state')].some((item) => item.textContent?.includes('Select a registered Git worktree to inspect repository hosting.'))).toBe(true)
  expect(ui.element.querySelectorAll('[role="alert"]')).toHaveLength(0)
  expect(button(ui.element, 'Save creation defaults').disabled).toBe(false)
  expect(ui.calls.some((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toBe(false)
  expect(ui.calls.some((call) => call.method === 'quirky.reviews/creationDefaults' && call.params.scope === 'repository')).toBe(false)
})

test('defaults reads expose pending and failed states with a retry', async () => {
  const pending = deferred<unknown>()
  let globalReads = 0
  const ui = settings(stateFor({ worktree: null, settings: {
    worktree: null, diagnostics: null, accounts: null, configuration: null, budget: null
  } }), null, (h) => {
    h.setMethod('quirky.worktree/list', () => [])
    h.setMethod('quirky.reviews/creationDefaults', () => {
      globalReads += 1
      return globalReads === 1 ? pending.promise : { defaults: DEFAULTS }
    })
  })
  await settle()
  expect(ui.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading creation defaults…')
  expect(button(ui.element, 'Save creation defaults').disabled).toBe(true)
  await act(async () => { pending.reject(new Error('defaults fixture failed')); await pending.promise.catch(() => {}) })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('defaults fixture failed')
  expect(ui.element.querySelector('.ui-notice-line')).toBeNull()
  await click(button(ui.element, 'Retry defaults'))
  expect(globalReads).toBe(2)
  expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
})

test('malformed defaults are errors and cannot be saved as fallback booleans', async () => {
  const ui = settings(stateFor(), WORKTREE_A, (h) => {
    h.setMethod('quirky.reviews/creationDefaults', () => ({ defaults: { draft: 'yes' } }))
  })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Creation defaults returned invalid booleans.')
  expect(button(ui.element, 'Save creation defaults').disabled).toBe(true)
  expect(ui.calls.some((call) => call.method === 'quirky.reviews/setCreationDefaults')).toBe(false)
})

test('global defaults remain editable when only repository defaults fail', async () => {
  const ui = settings(stateFor(), WORKTREE_A, (h) => {
    h.setMethod('quirky.reviews/creationDefaults', (params) => params.scope === 'repository'
      ? Promise.reject(new Error('repository defaults fixture failed'))
      : { defaults: DEFAULTS_TRUE })
  })
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('repository defaults fixture failed')
  expect(button(ui.element, 'Save creation defaults').disabled).toBe(false)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-repository')?.disabled).toBe(true)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-draft')?.checked).toBe(true)
})

test('repository scope inherits exact global defaults and malformed reset remains an error', async () => {
  const ui = settings(stateFor(), WORKTREE_A, (h) => {
    h.setMethod('quirky.reviews/creationDefaults', (params) => params.scope === 'repository'
      ? { defaults: DEFAULTS_TRUE, repoId: 'owner/repo', overrides: {} }
      : { defaults: DEFAULTS_TRUE })
    h.setMethod('quirky.reviews/setCreationDefaults', () => ({ saved: true }))
    h.setMethod('quirky.reviews/resetCreationDefaults', () => ({ defaults: { draft: 'bad' } }))
  })
  await settle()
  await click(ui.element.querySelector<HTMLInputElement>('#creation-default-repository')!)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-draft')?.checked).toBe(true)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-useTemplate')?.checked).toBe(false)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-generateDetailsOnOpen')?.checked).toBe(false)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-openAfterCreate')?.checked).toBe(false)
  await click(ui.element.querySelector<HTMLInputElement>('#creation-default-useTemplate')!)
  await click(button(ui.element, 'Save creation defaults'))
  const saved = ui.calls.find((call) => call.method === 'quirky.reviews/setCreationDefaults')
  expect(saved?.params).toEqual({
    scope: 'repository', worktree: WORKTREE_A,
    defaults: { draft: true, useTemplate: true, generateDetailsOnOpen: false, openAfterCreate: false }
  })
  await click(button(ui.element, 'Reset repository defaults to global'))
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('Reset did not return the inherited defaults.')
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-repository')?.checked).toBe(true)
})

test('hosting observations finish loading visibly and retained valid budget remains on errors', async () => {
  const pending = deferred<unknown>()
  const initial = stateFor({ settings: {
    diagnostics: null, accounts: null, configuration: null, budget: null, loading: true, error: null
  } })
  const ui = settings(initial, WORKTREE_A, (h) => { h.setMethod('quirky.reviews/hostingSettingsRefresh', () => pending.promise) })
  await settle()
  expect(ui.element.textContent).toContain('Checking GitHub readiness…')
  expect(ui.element.textContent).toContain('Loading GitHub API budget…')
  expect(ui.element.querySelectorAll('.ui-notice-line').length).toBeGreaterThanOrEqual(2)
  await act(async () => { pending.resolve({}); await pending.promise })
  await settle()
  ui.render(stateFor({ settings: { diagnostics: null, accounts: null, configuration: null, budget: null, loading: false, error: null } }))
  await settle()
  expect(ui.element.querySelector('.ui-notice-line')).toBeNull()
  expect(ui.element.querySelectorAll('.ui-inline-error').length).toBeGreaterThanOrEqual(1)
  expect(ui.element.textContent).toContain('GitHub diagnostics are unavailable.')
  expect(ui.element.textContent).toContain('GitHub API budget is unavailable.')
  expect(ui.element.textContent).toContain('GitHub accounts are unavailable.')
  expect(ui.element.textContent).toContain('Repository hosting configuration is unavailable.')

  const rejected = settings(stateFor({ settings: {
    diagnostics: null, accounts: null, configuration: null, budget: null, loading: true, error: null
  } }), WORKTREE_A, (h) => {
    h.setMethod('quirky.reviews/hostingSettingsRefresh', () => Promise.reject(new Error('hosting fixture failed')))
  })
  await settle()
  expect(rejected.element.querySelector('.ui-notice-line')).toBeNull()
  expect(rejected.element.textContent).toContain('GitHub diagnostics are unavailable.')
  expect(rejected.element.textContent).toContain('GitHub API budget is unavailable.')

  const retained = settings(stateFor({ settings: { error: 'provider fixture failed' } }))
  await settle()
  expect(retained.element.querySelector('.ui-inline-error')?.textContent).toContain('Hosting observations may be stale: provider fixture failed')
  expect(retained.element.textContent).toContain('4000 / 5000 remaining')
  expect(retained.element.textContent).toContain('20 / 30 remaining')
  expect(retained.element.textContent).toContain('3000 / 5000 remaining')
})

test('an unavailable saved account binding remains explicit and fails closed', async () => {
  const ui = settings(stateFor({ settings: {
    configuration: { account: { host: 'github.com', user: 'missing-user' } },
    accounts: { requiredHost: 'github.com', accounts: [] }
  } }))
  await settle()
  expect(ui.element.querySelector('.ui-inline-error')?.textContent).toContain('The saved binding to missing-user @ github.com is unavailable.')
  expect(ui.element.textContent).toContain('no ambient-account fallback is used')
  expect(ui.element.querySelector<HTMLSelectElement>('#hosting-account')?.value).toContain('missing-user')
})
for (const surface of [
  { kind: 'creation', id: CREATE_VIEW, slot: 'creation', action: 'refresh-eligibility', value: undefined },
  { kind: 'settings', id: SETTINGS_VIEW, slot: 'settings-workspace', action: 'workspace-select', value: { worktree: null } }
] as const) {
  test(`${surface.kind} mounted control is reported and delivered to its exact window in isolated contexts`, async () => {
    const state = stateFor()
    const owner = mountActivatedSurface(surface.id, state, WORKTREE_A, undefined, 41)
    const auxiliary = mountActivatedSurface(surface.id, state, WORKTREE_A, undefined, 42)
    await settle()

    const ownerControl = latestControl(owner.mounted.reports, surface.id, surface.slot)
    const auxiliaryControl = latestControl(auxiliary.mounted.reports, surface.id, surface.slot)
    expect(JSON.parse(ownerControl.target)).toEqual([
      surface.id, surface.slot, WORKTREE_A, null, null, surface.kind === 'creation' ? 'feature' : null, null
    ])
    expect(findControlRoot(owner.mounted.element, ownerControl)).not.toBeNull()
    expect(findControlRoot(auxiliary.mounted.element, auxiliaryControl)).not.toBeNull()
    expect(typeof auxiliary.harness.getProvider(CONTROL_COMMAND)).toBe('function')

    const result = await requestControl(auxiliary.harness, auxiliaryControl, surface.action, surface.value)
    await settle()
    expect(result).toEqual({ delivered: true })
    expect(auxiliary.harness.calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(1)
    expect(auxiliary.harness.calls.filter((call) => call.method === 'ui.window.command.run').map((call) => call.params)).toEqual([{
      connId: 42,
      id: CONTROL_COMMAND,
      args: {
        target: auxiliaryControl.target,
        generation: auxiliaryControl.generation,
        action: surface.action,
        ...(surface.value === undefined ? {} : { value: surface.value })
      }
    }])
    expect(owner.harness.calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(0)
    expect(owner.harness.executeCommandCalls()).toBe(0)
    expect(auxiliary.harness.executeCommandCalls()).toBe(0)
  })
}

for (const scenario of [
  {
    action: 'refresh-eligibility',
    state: stateFor(),
    expectedMethod: 'quirky.reviews/createOpen',
    value: undefined,
    expectedParams: { worktree: WORKTREE_A }
  },
  {
    action: 'open-result',
    state: stateFor({ creation: { result: { status: 'created', review: { number: 8, url: 'https://github.com/owner/repo/pull/8' } } } }),
    expectedMethod: 'quirky.reviews/createOpen',
    value: undefined,
    expectedParams: { worktree: WORKTREE_A }
  },
  {
    action: 'generate',
    state: stateFor(),
    expectedMethod: 'quirky.reviews/createGenerate',
    value: undefined,
    expectedParams: { worktree: WORKTREE_A }
  },
  {
    action: 'stop-generation',
    state: stateFor({ creation: { generating: true } }),
    expectedMethod: 'quirky.reviews/createCancelGenerate',
    value: undefined,
    expectedParams: { worktree: WORKTREE_A }
  },
  {
    action: 'base-set',
    state: stateFor(),
    expectedMethod: 'quirky.reviews/createBase',
    value: { base: 'release' },
    expectedParams: { worktree: WORKTREE_A, base: 'release', generation: 1 }
  },
  {
    action: 'stack-set',
    state: stateFor({ creation: {
      eligibility: { eligible: true, confirmedAt: Date.now(), stackSupported: true, stackParentNumber: 7, stackEnabled: false }
    } }),
    expectedMethod: 'quirky.reviews/createBase',
    value: { enabled: true },
    expectedParams: { worktree: WORKTREE_A, base: 'main', stack: true, generation: 1 }
  }
] as const) {
  test(`creation ${scenario.action} runs through the mounted control handler`, async () => {
    const { harness, mounted } = mountActivatedSurface(CREATE_VIEW, scenario.state)
    await settle()
    const descriptor = latestControl(mounted.reports, CREATE_VIEW, 'creation')
    expect(descriptor.actions.some((item) => item.action === scenario.action && item.enabled)).toBe(true)
    const result = await requestControl(harness, descriptor, scenario.action, scenario.value)
    await settle()
    expect(result).toEqual({ delivered: true })
    const call = harness.calls.find((item) => item.method === scenario.expectedMethod)
    expect(call?.params).toMatchObject(scenario.expectedParams)
    expect(harness.executeCommandCalls()).toBe(0)
  })
}

for (const entry of ['button', 'keyboard'] as const) {
  test(`creation ${entry} submission routes through submit without a second draft payload`, async () => {
    const { harness, mounted } = mountActivatedSurface(CREATE_VIEW)
    await settle()
    harness.calls.splice(0)
    if (entry === 'button') await click(button(mounted.element, 'Create PR'))
    else pressCtrlEnter(mounted.element.querySelector<HTMLTextAreaElement>('#review-body')!)
    await settle()

    const route = harness.calls.find((call) => call.method === 'ui.window.command.run')
    expect(route?.params.id).toBe(CONTROL_COMMAND)
    const args = route?.params.args
    expect(isRecord(args) ? args.action : null).toBe('submit')
    expect(isRecord(args) && Object.hasOwn(args, 'value')).toBe(false)
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(1)
    expect(harness.executeCommandCalls()).toBe(0)
  })
}

test('creation submit waits for the latest drafts, writes base and full payload before one createSubmit', async () => {
  const { harness, mounted } = mountActivatedSurface(CREATE_VIEW)
  await settle()
  const descriptor = latestControl(mounted.reports, CREATE_VIEW, 'creation')
  const title = mounted.element.querySelector<HTMLInputElement>('#review-title')!
  const body = mounted.element.querySelector<HTMLTextAreaElement>('#review-body')!
  const base = mounted.element.querySelector<HTMLInputElement>('#review-base')!
  const draft = mounted.element.querySelector<HTMLInputElement>('#review-create-draft')!
  const template = mounted.element.querySelector<HTMLInputElement>('#review-use-template')!
  const heldTitleWrite = harness.holdNext('quirky.reviews/createDraft')
  changeValue(title, 'Latest title')
  changeValue(body, 'Latest body')
  changeValue(base, 'release')
  changeChecked(draft, true)
  changeChecked(template, true)
  await settle()

  const heldSubmit = harness.holdNext('quirky.reviews/createSubmit')
  const delivered = await requestControl(harness, descriptor, 'submit')
  expect(delivered).toEqual({ delivered: true })
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(0)
  expect(button(mounted.element, 'Creating…').disabled).toBe(true)
  expect(await requestControl(harness, descriptor, 'submit')).toEqual({ delivered: false, reason: 'disabled' })
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(0)

  await act(async () => { heldTitleWrite.resolve({ updated: true }); await heldTitleWrite.promise })
  await settle()
  const methods = harness.calls.map((call) => call.method)
  const baseIndex = methods.lastIndexOf('quirky.reviews/createBase')
  const draftIndex = methods.lastIndexOf('quirky.reviews/createDraft')
  const submitIndex = methods.lastIndexOf('quirky.reviews/createSubmit')
  expect(baseIndex).toBeGreaterThan(-1)
  expect(draftIndex).toBeGreaterThan(baseIndex)
  expect(submitIndex).toBeGreaterThan(draftIndex)
  expect(harness.calls[baseIndex]?.params).toMatchObject({ worktree: WORKTREE_A, base: 'release', generation: 1 })
  expect(harness.calls[draftIndex]?.params).toEqual({
    worktree: WORKTREE_A,
    title: 'Latest title',
    body: 'Latest body',
    draft: true,
    useTemplate: true,
    generation: 1
  })
  await act(async () => { heldSubmit.resolve({ submitted: true }); await heldSubmit.promise })
  await settle()
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(1)
})
for (const [label, creation] of [
  ['blank title', { title: '' }],
  ['missing base', { base: '' }],
  ['base absent from remote refs', { base: 'other', bases: ['main', 'release'] }],
  ['base equal to head', { base: 'feature', bases: ['feature'] }],
  ['loading eligibility', { loading: true }],
  ['generation in progress', { generating: true }],
  ['submission in progress', { submitting: true }],
  ['stale eligibility', { eligibility: { eligible: true, confirmedAt: Date.now() - 300_001 } }]
] satisfies Array<[string, Partial<ReviewsState['creation']>]>) {
  test(`creation submit is disabled for ${label} in both the command and rendered form`, async () => {
    const { harness, mounted } = mountActivatedSurface(CREATE_VIEW, stateFor({ creation }))
    await settle()
    const descriptor = latestControl(mounted.reports, CREATE_VIEW, 'creation')
    expect(descriptor.actions.find((item) => item.action === 'submit')?.enabled).toBe(false)
    const result = await requestControl(harness, descriptor, 'submit')
    expect(result).toEqual({ delivered: false, reason: 'disabled' })
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(0)
    const submit = mounted.element.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (submit) expect(submit.disabled).toBe(true)
  })
}

test('creation command rejects unknown actions and malformed values without mutations', async () => {
  const { harness, mounted } = mountActivatedSurface(CREATE_VIEW, stateFor({ creation: {
    eligibility: { eligible: true, confirmedAt: Date.now(), stackSupported: true, stackParentNumber: 7 }
  } }))
  await settle()
  const descriptor = latestControl(mounted.reports, CREATE_VIEW, 'creation')
  expect(await requestControl(harness, descriptor, 'not-an-action')).toEqual({ delivered: false, reason: 'unknown-action' })
  await expect(requestControl(harness, descriptor, 'submit', { extra: true })).rejects.toThrow()
  await expect(requestControl(harness, descriptor, 'base-set', { base: 'release', extra: true })).rejects.toThrow()
  await expect(requestControl(harness, descriptor, 'stack-set', { enabled: true, extra: true })).rejects.toThrow()
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createBase')).toHaveLength(0)
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(0)
})

test('creation submit rechecks the five-minute confirmation bound at dispatch', async () => {
  const originalNow = Date.now
  Date.now = () => 1_000_000
  try {
    const within = mountActivatedSurface(CREATE_VIEW, stateFor({
      creation: { eligibility: { eligible: true, confirmedAt: 700_000 } }
    }))
    await settle()
    const withinControl = latestControl(within.mounted.reports, CREATE_VIEW, 'creation')
    expect(withinControl.actions.find((item) => item.action === 'submit')?.enabled).toBe(true)
    expect(await requestControl(within.harness, withinControl, 'submit')).toEqual({ delivered: true })
    await settle()
    expect(within.harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(1)

    const expired = mountActivatedSurface(CREATE_VIEW, stateFor({
      creation: { eligibility: { eligible: true, confirmedAt: 700_000 } }
    }))
    await settle()
    const expiredControl = latestControl(expired.mounted.reports, CREATE_VIEW, 'creation')
    Date.now = () => 1_000_001
    expect(expiredControl.actions.find((item) => item.action === 'submit')?.enabled).toBe(true)
    expect(await requestControl(expired.harness, expiredControl, 'submit')).toEqual({ delivered: false, reason: 'disabled' })
    expect(expired.harness.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(0)

    Date.now = () => 1_000_000
    const outside = mountActivatedSurface(CREATE_VIEW, stateFor({
      creation: { eligibility: { eligible: true, confirmedAt: 699_999 } }
    }))
    await settle()
    const outsideControl = latestControl(outside.mounted.reports, CREATE_VIEW, 'creation')
    expect(outsideControl.actions.find((item) => item.action === 'submit')?.enabled).toBe(false)
    expect(await requestControl(outside.harness, outsideControl, 'submit')).toEqual({ delivered: false, reason: 'disabled' })
  } finally {
    Date.now = originalNow
  }
})
test('settings workspace commands select only listed Git worktrees and return to global scope', async () => {
  const { harness, mounted } = mountActivatedSurface(SETTINGS_VIEW, stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => [
      { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
      { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' },
      { kind: 'folder' }
    ])
  })
  await settle()
  const selector = mounted.element.querySelector<HTMLSelectElement>('#settings-worktree')!
  expect(selector.value).toBe(WORKTREE_A)
  expect([...selector.options].some((option) => option.value === 'folder')).toBe(false)
  const initial = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-workspace')

  harness.calls.splice(0)
  expect(await requestControl(harness, initial, 'workspace-select', { worktree: '/work/b' })).toEqual({ delivered: true })
  await settle()
  expect(selector.value).toBe('/work/b')
  expect(harness.calls).toContainEqual({
    method: 'quirky.reviews/creationDefaults',
    params: { scope: 'repository', worktree: '/work/b' }
  })
  expect(harness.calls).toContainEqual({
    method: 'quirky.reviews/hostingSettingsRefresh',
    params: { worktree: '/work/b', forceBudget: true }
  })

  const selected = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-workspace')
  harness.calls.splice(0)
  expect(await requestControl(harness, selected, 'workspace-select', { worktree: null })).toEqual({ delivered: true })
  await settle()
  expect(selector.value).toBe('')
  expect(harness.calls.some((call) => call.method === 'quirky.reviews/creationDefaults' && call.params.scope === 'repository')).toBe(false)
  expect(harness.calls.some((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toBe(false)
})

test('settings defaults edit locally, save all booleans, and reset to returned inherited values', async () => {
  const inherited = { draft: false, useTemplate: true, generateDetailsOnOpen: true, openAfterCreate: false }
  const { harness, mounted } = mountActivatedSurface(SETTINGS_VIEW, stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.reviews/creationDefaults', (params) => params.scope === 'repository'
      ? { defaults: DEFAULTS_TRUE, repoId: 'owner/repo', overrides: {} }
      : { defaults: DEFAULTS_TRUE })
    controls.setMethod('quirky.reviews/setCreationDefaults', () => ({ saved: true }))
    controls.setMethod('quirky.reviews/resetCreationDefaults', () => ({ defaults: inherited }))
  })
  await settle()
  const global = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-defaults-global')
  expect(global.actions.some((item) => item.action === 'defaults-reset')).toBe(false)
  await expect(requestControl(harness, global, 'defaults-scope', { scope: 'unknown' })).rejects.toThrow()
  await expect(requestControl(harness, global, 'defaults-set', { key: 'unknown', value: true })).rejects.toThrow()
  await expect(requestControl(harness, global, 'defaults-set', { key: 'draft', value: 'true' })).rejects.toThrow()
  expect(await requestControl(harness, global, 'defaults-reset')).toEqual({ delivered: false, reason: 'unknown-action' })

  harness.calls.splice(0)
  expect(await requestControl(harness, global, 'defaults-scope', { scope: 'repository' })).toEqual({ delivered: true })
  const repository = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-defaults-repository')
  expect(await requestControl(harness, repository, 'defaults-set', { key: 'useTemplate', value: true })).toEqual({ delivered: true })
  expect(harness.calls.some((call) => call.method === 'quirky.reviews/setCreationDefaults')).toBe(false)
  expect(await requestControl(harness, repository, 'defaults-save')).toEqual({ delivered: true })
  await settle()
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/setCreationDefaults')?.params).toEqual({
    scope: 'repository',
    worktree: WORKTREE_A,
    defaults: { draft: true, useTemplate: true, generateDetailsOnOpen: false, openAfterCreate: false }
  })

  const savedRepository = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-defaults-repository')
  expect(savedRepository.actions.some((item) => item.action === 'defaults-reset' && item.enabled)).toBe(true)
  expect(await requestControl(harness, savedRepository, 'defaults-reset')).toEqual({ delivered: true })
  await settle()
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/resetCreationDefaults')?.params).toEqual({
    scope: 'repository', worktree: WORKTREE_A
  })
  expect(mounted.element.querySelector<HTMLInputElement>('#creation-default-global')?.checked).toBe(true)
  expect(mounted.element.querySelector<HTMLInputElement>('#creation-default-draft')?.checked).toBe(false)
  expect(mounted.element.querySelector<HTMLInputElement>('#creation-default-useTemplate')?.checked).toBe(true)
  expect(mounted.element.querySelector<HTMLInputElement>('#creation-default-generateDetailsOnOpen')?.checked).toBe(true)
  expect(mounted.element.querySelector<HTMLInputElement>('#creation-default-openAfterCreate')?.checked).toBe(false)
})

test('settings retry controls reread failed worktree and defaults operations', async () => {
  let worktreeReads = 0
  let defaultsReads = 0
  const { harness, mounted } = mountActivatedSurface(SETTINGS_VIEW, stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => ++worktreeReads === 1
      ? Promise.reject(new Error('list offline'))
      : [{ kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' }])
    controls.setMethod('quirky.reviews/creationDefaults', (params) => {
      if (params.scope === 'global' && ++defaultsReads <= 2) throw new Error('defaults offline')
      return params.scope === 'repository'
        ? { defaults: DEFAULTS, repoId: 'owner/repo', overrides: {} }
        : { defaults: DEFAULTS }
    })
  })
  await settle()
  const workspace = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-workspace')
  const defaults = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-defaults-global')
  expect(await requestControl(harness, workspace, 'workspaces-retry')).toEqual({ delivered: true })
  await settle()
  expect(worktreeReads).toBe(2)
  const retryDefaults = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-defaults-global')
  expect(await requestControl(harness, retryDefaults, 'defaults-retry')).toEqual({ delivered: true })
  await settle()
  expect(defaultsReads).toBeGreaterThan(1)
  expect(mounted.element.querySelector('.ui-inline-error')).toBeNull()
  expect(defaults.actions.some((item) => item.action === 'defaults-retry' && item.enabled)).toBe(true)
})
test('settings hosting controls validate account identity and route bind, unbind, recheck, and budget reads', async () => {
  const state = stateFor({ settings: {
    accounts: { requiredHost: 'github.com', accounts: [
      { host: 'github.com', user: 'octo', source: 'keyring', bindable: true, scopes: ['repo'] }
    ] },
    configuration: { account: null }
  } })
  const { harness, mounted } = mountActivatedSurface(SETTINGS_VIEW, state)
  await settle()
  const hosting = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-hosting')

  await expect(requestControl(harness, hosting, 'account-select', { host: 'github.com', user: '' })).rejects.toThrow()
  await expect(requestControl(harness, hosting, 'account-select', { host: 'other.example', user: 'octo' })).rejects.toThrow()
  await expect(requestControl(harness, hosting, 'account-select', { host: 'github.com', user: 'missing' })).rejects.toThrow()
  await expect(requestControl(harness, hosting, 'account-select', { host: 'github.com', user: 'octo', token: 'secret' })).rejects.toThrow()
  await expect(requestControl(harness, hosting, 'account-select', { ambient: true, host: 'github.com', user: 'octo' })).rejects.toThrow()
  await expect(requestControl(harness, hosting, 'account-select', { key: 'github.com\u0000octo' })).rejects.toThrow()
  expect(JSON.stringify(mounted.reports)).not.toContain('octo')

  harness.calls.splice(0)
  expect(await requestControl(harness, hosting, 'account-select', { host: 'GitHub.com', user: 'octo' })).toEqual({ delivered: true })
  expect(harness.calls.some((call) => call.method === 'quirky.reviews/hostingBindAccount')).toBe(false)
  expect(await requestControl(harness, hosting, 'account-save')).toEqual({ delivered: true })
  await settle()
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/hostingBindAccount')?.params).toEqual({
    worktree: WORKTREE_A, host: 'github.com', user: 'octo'
  })
  expect(harness.calls).toContainEqual({
    method: 'quirky.reviews/hostingSettingsRefresh',
    params: { worktree: WORKTREE_A, forceBudget: true }
  })

  harness.calls.splice(0)
  expect(await requestControl(harness, hosting, 'account-select', { ambient: true })).toEqual({ delivered: true })
  expect(await requestControl(harness, hosting, 'account-save')).toEqual({ delivered: true })
  await settle()
  expect(harness.calls).toContainEqual({ method: 'quirky.reviews/hostingUnbindAccount', params: { worktree: WORKTREE_A } })

  harness.calls.splice(0)
  expect(await requestControl(harness, hosting, 'provider-recheck')).toEqual({ delivered: true })
  await settle()
  expect(harness.calls).toContainEqual({
    method: 'quirky.reviews/hostingSettingsRefresh',
    params: { worktree: WORKTREE_A, forceBudget: true }
  })
  harness.calls.splice(0)
  expect(await requestControl(harness, hosting, 'budget-refresh')).toEqual({ delivered: true })
  await settle()
  expect(harness.calls).toContainEqual({
    method: 'quirky.reviews/hostingBudget',
    params: { worktree: WORKTREE_A, force: true }
  })
})
test('creation base-set reports an unavailable remote ref without mutating the base', async () => {
  const { harness, mounted } = mountActivatedSurface(CREATE_VIEW)
  await settle()
  const descriptor = latestControl(mounted.reports, CREATE_VIEW, 'creation')
  expect(await requestControl(harness, descriptor, 'base-set', { base: 'not-a-ref' })).toEqual({ delivered: true })
  await settle()
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createBase')).toHaveLength(0)
  expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toContain('Choose a remote base branch from the available refs.')
})

test('settings workspace-select rejects unknown IDs and payload fields without changing selection', async () => {
  const { harness, mounted } = mountActivatedSurface(SETTINGS_VIEW, stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => [
      { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' }
    ])
  })
  await settle()
  const descriptor = latestControl(mounted.reports, SETTINGS_VIEW, 'settings-workspace')
  await expect(requestControl(harness, descriptor, 'workspace-select', { worktree: '/work/unknown' })).rejects.toThrow()
  await expect(requestControl(harness, descriptor, 'workspace-select', { worktree: WORKTREE_A, extra: true })).rejects.toThrow()
  expect(mounted.element.querySelector<HTMLSelectElement>('#settings-worktree')?.value).toBe(WORKTREE_A)
  expect(harness.calls.some((call) => call.method === 'quirky.reviews/hostingSettingsRefresh' && call.params.worktree === '/work/unknown')).toBe(false)
})
for (const scenario of [
  { action: 'defaults-save', slot: 'settings-defaults-global', method: 'quirky.reviews/setCreationDefaults', state: stateFor(), reply: { saved: true } },
  { action: 'defaults-reset', slot: 'settings-defaults-repository', method: 'quirky.reviews/resetCreationDefaults', state: stateFor(), reply: { defaults: DEFAULTS } },
  { action: 'account-save', slot: 'settings-hosting', method: 'quirky.reviews/hostingUnbindAccount', state: stateFor(), reply: { unbound: true } },
  { action: 'provider-recheck', slot: 'settings-hosting', method: 'quirky.reviews/hostingSettingsRefresh', state: stateFor(), reply: {} },
  { action: 'budget-refresh', slot: 'settings-hosting', method: 'quirky.reviews/hostingBudget', state: stateFor(), reply: {} }
] as const) {
  test(`settings refuses a same-tick duplicate ${scenario.action} operation`, async () => {
    const { harness, mounted } = mountActivatedSurface(SETTINGS_VIEW, scenario.state, WORKTREE_A, (controls) => {
      if (scenario.action === 'defaults-reset') {
        controls.setMethod('quirky.reviews/creationDefaults', (params) => params.scope === 'repository'
          ? { defaults: DEFAULTS_TRUE, repoId: 'owner/repo', overrides: { draft: true } }
          : { defaults: DEFAULTS_TRUE })
      }
    })
    await settle()
    harness.calls.splice(0)
    const pending = harness.holdNext(scenario.method)
    const descriptor = latestControl(mounted.reports, SETTINGS_VIEW, scenario.slot)
    const request = {
      target: descriptor.target,
      generation: descriptor.generation,
      action: scenario.action
    }
    let results: ReviewsUiControlResult[] = []
    await act(async () => {
      results = await Promise.all([
        requestReviewsUiControl(harness.context, request),
        requestReviewsUiControl(harness.context, request)
      ])
    })
    expect(results).toContainEqual({ delivered: true })
    expect(results).toContainEqual({ delivered: false, reason: 'disabled' })
    expect(harness.calls.filter((call) => call.method === scenario.method)).toHaveLength(1)
    await act(async () => { pending.resolve(scenario.reply); await pending.promise })
    await settle()
  })
}
const bridgeFailures = [
  {
    name: 'self rejection',
    method: 'ui.window.self',
    implementation: () => Promise.reject(new Error('window self failed'))
  },
  {
    name: 'run rejection',
    method: 'ui.window.command.run',
    implementation: () => Promise.reject(new Error('window run failed'))
  },
  {
    name: 'unavailable run target',
    method: 'ui.window.command.run',
    implementation: () => ({ result: { delivered: false, reason: 'target-unavailable' } })
  }
] as const

for (const surface of [
  { kind: 'creation', id: CREATE_VIEW, buttonLabel: 'Refresh eligibility', mutation: 'quirky.reviews/createOpen' },
  { kind: 'settings', id: SETTINGS_VIEW, buttonLabel: 'Re-check GitHub', mutation: 'quirky.reviews/hostingSettingsRefresh' }
] as const) {
  for (const failure of bridgeFailures) {
    test(`${surface.kind} shows ${failure.name} delivery failure without a local fallback`, async () => {
      const { harness, mounted } = mountActivatedSurface(surface.id, stateFor(), WORKTREE_A, (controls) => {
        controls.setMethod(failure.method, failure.implementation)
      })
      await settle()
      harness.calls.splice(0)
      await click(button(mounted.element, surface.buttonLabel))
      expect(mounted.element.querySelector('.ui-inline-error')?.textContent).toBeTruthy()
      expect(harness.calls.filter((call) => call.method === surface.mutation)).toHaveLength(0)
      expect(harness.executeCommandCalls()).toBe(0)
    })
  }
}
test('creation session and head identity renew the lease even on the same worktree', async () => {
  const firstOid = 'a'.repeat(40)
  const secondOid = 'b'.repeat(40)
  const ui = create(stateFor({ creation: {
    eligibility: { eligible: true, confirmedAt: Date.now(), headOid: firstOid }
  } }))
  await settle()
  const first = registeredControl(ui, CREATE_VIEW, 'creation')
  expect(JSON.parse(first.target)[5]).toBe(firstOid)

  ui.render(stateFor({ creation: {
    generation: 2,
    eligibility: { eligible: true, confirmedAt: Date.now(), headOid: secondOid }
  } }), WORKTREE_A)
  await settle()
  const second = registeredControl(ui, CREATE_VIEW, 'creation')
  expect(second.target).not.toBe(first.target)
  expect(second.generation).toBeGreaterThan(first.generation)
  expect(await requestControl(ui, first, 'refresh-eligibility')).toEqual({ delivered: false, reason: 'target-unavailable' })
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/createOpen')).toHaveLength(0)

  ui.render(stateFor({ creation: {
    generation: 3,
    eligibility: { eligible: true, confirmedAt: Date.now(), headOid: firstOid }
  } }), WORKTREE_A)
  await settle()
  const returned = registeredControl(ui, CREATE_VIEW, 'creation')
  expect(returned.target).toBe(first.target)
  expect(returned.generation).toBeGreaterThan(first.generation)
  expect(await requestControl(ui, first, 'refresh-eligibility')).toEqual({ delivered: false, reason: 'target-unavailable' })
})

test('creation draft and error renders keep the logical control lease', async () => {
  const ui = create(stateFor())
  await settle()
  const original = registeredControl(ui, CREATE_VIEW, 'creation')
  ui.render(stateFor({ creation: { title: 'New draft text', error: 'retained error' } }), WORKTREE_A)
  await settle()
  const current = registeredControl(ui, CREATE_VIEW, 'creation')
  expect(current.target).toBe(original.target)
  expect(current.generation).toBe(original.generation)
  expect(await requestControl(ui, original, 'refresh-eligibility')).toEqual({ delivered: true })
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/createOpen')).toHaveLength(1)
})

test('settings A to B to A renews workspace and default-scope leases', async () => {
  const ui = settings(stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => [
      { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
      { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' }
    ])
  })
  await settle()
  const firstWorkspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  const firstGlobal = registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-global')
  await requestControl(ui, firstWorkspace, 'workspace-select', { worktree: '/work/b' })
  await settle()
  const onB = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  await requestControl(ui, onB, 'workspace-select', { worktree: WORKTREE_A })
  await settle()
  const returnedWorkspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  expect(returnedWorkspace.target).toBe(firstWorkspace.target)
  expect(returnedWorkspace.generation).toBeGreaterThan(firstWorkspace.generation)
  expect(await requestControl(ui, firstWorkspace, 'workspace-select', { worktree: '/work/b' })).toEqual({
    delivered: false, reason: 'target-unavailable'
  })

  const globalNow = registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-global')
  await requestControl(ui, globalNow, 'defaults-scope', { scope: 'repository' })
  const repository = registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-repository')
  await requestControl(ui, repository, 'defaults-scope', { scope: 'global' })
  const globalAgain = registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-global')
  expect(globalAgain.target).toBe(firstGlobal.target)
  expect(globalAgain.generation).toBeGreaterThan(firstGlobal.generation)
  expect(await requestControl(ui, firstGlobal, 'defaults-scope', { scope: 'repository' })).toEqual({
    delivered: false, reason: 'target-unavailable'
  })

  const hosting = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
  ui.render(stateFor({ settings: { generation: 99 } }), WORKTREE_A)
  await settle()
  const afterObservation = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
  expect(afterObservation.target).toBe(hosting.target)
  expect(afterObservation.generation).toBe(hosting.generation)
})

test('unmount and remount invalidates the previous creation descriptor', async () => {
  const { harness, mounted } = mountActivatedSurface(CREATE_VIEW)
  await settle()
  const previous = latestControl(mounted.reports, CREATE_VIEW, 'creation')
  await mounted.unmount()
  await settle()

  const replacement = harness.mountSurface(CREATE_VIEW)
  await settle()
  const current = latestControl(replacement.reports, CREATE_VIEW, 'creation')
  expect(current.target).toBe(previous.target)
  expect(current.generation).toBeGreaterThan(previous.generation)
  expect(await requestControl(harness, previous, 'refresh-eligibility')).toEqual({
    delivered: false, reason: 'target-unavailable'
  })
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/createOpen')).toHaveLength(0)
})
for (const bridge of ['ui.window.self', 'ui.window.command.run'] as const) {
  test(`a creation bridge completion from a replaced session cannot set error or run a fallback: ${bridge}`, async () => {
    const oidA = 'a'.repeat(40)
    const oidB = 'b'.repeat(40)
    const ui = create(stateFor({ creation: {
      eligibility: { eligible: true, confirmedAt: Date.now(), headOid: oidA }
    } }))
    await settle()
    const descriptor = registeredControl(ui, CREATE_VIEW, 'creation')
    const release = deferred<void>()
    const entered = deferred<void>()
    let heldSelf: Deferred<unknown> | null = null
    if (bridge === 'ui.window.self') heldSelf = ui.holdNext(bridge)
    else {
      ui.setMethod(bridge, async (params) => {
        entered.resolve()
        await release.promise
        const implementation = ui.getProvider(CONTROL_COMMAND)
        if (typeof implementation !== 'function') throw new Error('Missing activated command handler.')
        const run = implementation as (input?: unknown) => unknown | Promise<unknown>
        return { result: await run(params.args) }
      })
    }

    await click(button(ui.element, 'Refresh eligibility'))
    if (bridge === 'ui.window.command.run') {
      const calls = ui.calls.filter((call) => call.method === bridge)
      if (calls.length === 0) {
        release.resolve()
        expect(calls).toHaveLength(1)
        return
      }
      await entered.promise
    }

    ui.render(stateFor({ creation: {
      generation: 2,
      eligibility: { eligible: true, confirmedAt: Date.now(), headOid: oidB }
    } }), WORKTREE_A)
    await settle()
    if (heldSelf) await act(async () => { heldSelf?.resolve({ connId: 42 }); await heldSelf?.promise })
    else release.resolve()
    await settle()
    expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
    expect(ui.calls.filter((call) => call.method === 'quirky.reviews/createOpen')).toHaveLength(0)
    expect(descriptor.target).not.toBe(registeredControl(ui, CREATE_VIEW, 'creation').target)
  })
}

test('a draft settlement from an old creation session cannot continue into createSubmit', async () => {
  const ui = create(stateFor({ creation: {
    eligibility: { eligible: true, confirmedAt: Date.now(), headOid: 'a'.repeat(40) }
  } }))
  await settle()
  const descriptor = registeredControl(ui, CREATE_VIEW, 'creation')
  const title = ui.element.querySelector<HTMLInputElement>('#review-title')!
  const heldWrite = ui.holdNext('quirky.reviews/createDraft')
  changeValue(title, 'old-session title')
  await settle()
  const pending = requestControl(ui, descriptor, 'submit')
  expect(await pending).toEqual({ delivered: true })

  ui.render(stateFor({ creation: {
    generation: 2,
    eligibility: { eligible: true, confirmedAt: Date.now(), headOid: 'b'.repeat(40) }
  } }), WORKTREE_A)
  await settle()
  await act(async () => { heldWrite.resolve({ updated: true }); await heldWrite.promise })
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/createBase')).toHaveLength(0)
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/createSubmit')).toHaveLength(0)
  expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
})
test('an account save captured for A cannot recheck or clear a newer B save', async () => {
  const account = { host: 'github.com', user: 'octo', source: 'keyring', bindable: true, scopes: ['repo'] }
  const accounts = { requiredHost: 'github.com', accounts: [account] }
  const aState = stateFor({ settings: { accounts, configuration: { account: null } } })
  const bState = stateFor({ worktree: '/work/b', settings: { worktree: '/work/b', accounts, configuration: { account: null } } })
  const ui = settings(aState, WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => [
      { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
      { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' }
    ])
  })
  await settle()
  const aHosting = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
  const workspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  const bindA = ui.holdNext('quirky.reviews/hostingUnbindAccount')
  const bindB = ui.holdNext('quirky.reviews/hostingUnbindAccount')
  ui.calls.splice(0)
  expect(await requestControl(ui, aHosting, 'account-save')).toEqual({ delivered: true })
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/hostingUnbindAccount')).toHaveLength(1)

  expect(await requestControl(ui, workspace, 'workspace-select', { worktree: '/work/b' })).toEqual({ delivered: true })
  ui.render(bState, '/work/b')
  await settle()
  const bHosting = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
  expect(await requestControl(ui, bHosting, 'account-save')).toEqual({ delivered: true })
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/hostingUnbindAccount')).toHaveLength(2)
  const rechecksBeforeOldCompletion = ui.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh').length
  const refreshesBeforeOldCompletion = ui.refreshes

  await act(async () => { bindA.resolve({ unbound: true }); await bindA.promise })
  await settle()
  expect(ui.refreshes).toBe(refreshesBeforeOldCompletion)
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toHaveLength(rechecksBeforeOldCompletion)
  expect(registeredControl(ui, SETTINGS_VIEW, 'settings-hosting').actions.find((item) => item.action === 'account-save')?.enabled).toBe(false)
  expect(ui.element.querySelector('.ui-inline-error')).toBeNull()

  await act(async () => { bindB.resolve({ unbound: true }); await bindB.promise })
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/hostingSettingsRefresh')).toHaveLength(rechecksBeforeOldCompletion + 1)
  expect(ui.calls.at(-1)?.params).toMatchObject({ worktree: '/work/b', forceBudget: true })
})

test('a repository reset from the replaced worktree cannot overwrite B defaults or refresh B', async () => {
  const inheritedFromA = { draft: false, useTemplate: true, generateDetailsOnOpen: true, openAfterCreate: true }
  const ui = settings(stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => [
      { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
      { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' }
    ])
    controls.setMethod('quirky.reviews/creationDefaults', (params) => params.scope === 'repository'
      ? params.worktree === WORKTREE_A
        ? { defaults: DEFAULTS_TRUE, repoId: 'owner/a', overrides: { draft: true } }
        : { defaults: DEFAULTS_TRUE, repoId: 'owner/b', overrides: {} }
      : { defaults: DEFAULTS_TRUE })
    controls.setMethod('quirky.reviews/resetCreationDefaults', () => reset.promise)
  })
  const reset = deferred<unknown>()
  await settle()
  const oldDefaults = registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-repository')
  const workspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  ui.calls.splice(0)
  expect(await requestControl(ui, oldDefaults, 'defaults-reset')).toEqual({ delivered: true })
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/resetCreationDefaults')).toHaveLength(1)

  expect(await requestControl(ui, workspace, 'workspace-select', { worktree: '/work/b' })).toEqual({ delivered: true })
  ui.render(stateFor({ worktree: '/work/b', settings: { worktree: '/work/b' } }), '/work/b')
  await settle()
  const refreshesBeforeRelease = ui.refreshes
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-global')?.checked).toBe(true)
  expect(button(ui.element, 'Save creation defaults').disabled).toBe(false)
  await act(async () => { reset.resolve({ defaults: inheritedFromA }); await reset.promise })
  await settle()
  expect(ui.refreshes).toBe(refreshesBeforeRelease)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-draft')?.checked).toBe(true)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-useTemplate')?.checked).toBe(false)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-generateDetailsOnOpen')?.checked).toBe(false)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-openAfterCreate')?.checked).toBe(false)
  expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
})

test('an old budget response cannot refresh or clear B budget busy state', async () => {
  const budgetA = deferred<unknown>()
  const budgetB = deferred<unknown>()
  const providerB = deferred<unknown>()
  const ui = settings(stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => [
      { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
      { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' }
    ])
    controls.setMethod('quirky.reviews/hostingBudget', (params) => params.worktree === WORKTREE_A ? budgetA.promise : budgetB.promise)
    controls.setMethod('quirky.reviews/hostingSettingsRefresh', (params) => params.worktree === '/work/b' ? providerB.promise : {})
  })
  await settle()
  const oldHosting = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
  const workspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  ui.calls.splice(0)
  expect(await requestControl(ui, oldHosting, 'budget-refresh')).toEqual({ delivered: true })
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/hostingBudget')).toHaveLength(1)

  expect(await requestControl(ui, workspace, 'workspace-select', { worktree: '/work/b' })).toEqual({ delivered: true })
  ui.render(stateFor({ worktree: '/work/b', settings: { worktree: '/work/b' } }), '/work/b')
  await settle()
  await act(async () => { providerB.resolve({}); await providerB.promise })
  await settle()
  const bHosting = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
  expect(await requestControl(ui, bHosting, 'budget-refresh')).toEqual({ delivered: true })
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/hostingBudget')).toHaveLength(2)
  const refreshesBeforeOldResponse = ui.refreshes

  await act(async () => { budgetA.resolve({}); await budgetA.promise })
  await settle()
  expect(ui.refreshes).toBe(refreshesBeforeOldResponse)
  expect(button(ui.element, 'Refreshing…').disabled).toBe(true)
  expect(registeredControl(ui, SETTINGS_VIEW, 'settings-hosting').actions.find((item) => item.action === 'budget-refresh')?.enabled).toBe(false)

  await act(async () => { budgetB.resolve({}); await budgetB.promise })
  await settle()
  expect(button(ui.element, 'Refresh budget').disabled).toBe(false)
  expect(ui.refreshes).toBe(refreshesBeforeOldResponse + 1)
})
test('a budget response from the first A lease cannot refresh or clear busy state after A to B to A', async () => {
  const ui = settings(stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => [
      { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
      { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' }
    ])
  })
  await settle()
  const oldBudget = ui.holdNext('quirky.reviews/hostingBudget')
  const newBudget = ui.holdNext('quirky.reviews/hostingBudget')
  const oldHosting = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
  const firstWorkspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  ui.calls.splice(0)
  expect(await requestControl(ui, oldHosting, 'budget-refresh')).toEqual({ delivered: true })
  await settle()

  expect(await requestControl(ui, firstWorkspace, 'workspace-select', { worktree: '/work/b' })).toEqual({ delivered: true })
  await settle()
  const bWorkspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  expect(await requestControl(ui, bWorkspace, 'workspace-select', { worktree: WORKTREE_A })).toEqual({ delivered: true })
  await settle()
  const returnedHosting = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
  expect(returnedHosting.target).toBe(oldHosting.target)
  expect(returnedHosting.generation).toBeGreaterThan(oldHosting.generation)
  expect(await requestControl(ui, returnedHosting, 'budget-refresh')).toEqual({ delivered: true })
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/hostingBudget')).toHaveLength(2)
  const refreshesBeforeOldCompletion = ui.refreshes

  await act(async () => { oldBudget.resolve({}); await oldBudget.promise })
  await settle()
  expect(ui.refreshes).toBe(refreshesBeforeOldCompletion)
  expect(registeredControl(ui, SETTINGS_VIEW, 'settings-hosting').actions.find((item) => item.action === 'budget-refresh')?.enabled).toBe(false)
  expect(button(ui.element, 'Refreshing…').disabled).toBe(true)

  await act(async () => { newBudget.resolve({}); await newBudget.promise })
  await settle()
  expect(button(ui.element, 'Refresh budget').disabled).toBe(false)
  expect(ui.refreshes).toBe(refreshesBeforeOldCompletion + 1)
})

test('a reset response from the first A lease cannot overwrite defaults after A to B to A', async () => {
  const staleDefaults = { draft: false, useTemplate: true, generateDetailsOnOpen: true, openAfterCreate: true }
  const ui = settings(stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.worktree/list', () => [
      { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
      { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' }
    ])
    controls.setMethod('quirky.reviews/creationDefaults', (params) => params.scope === 'repository'
      ? { defaults: DEFAULTS_TRUE, repoId: 'owner/repo', overrides: { draft: true } }
      : { defaults: DEFAULTS_TRUE })
  })
  const reset = ui.holdNext('quirky.reviews/resetCreationDefaults')
  await settle()
  const oldDefaults = registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-repository')
  const firstWorkspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  const refreshesBefore = ui.refreshes
  expect(await requestControl(ui, oldDefaults, 'defaults-reset')).toEqual({ delivered: true })
  await settle()
  expect(await requestControl(ui, firstWorkspace, 'workspace-select', { worktree: '/work/b' })).toEqual({ delivered: true })
  await settle()
  const bWorkspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
  expect(await requestControl(ui, bWorkspace, 'workspace-select', { worktree: WORKTREE_A })).toEqual({ delivered: true })
  await settle()
  const returnedDefaults = registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-repository')
  expect(returnedDefaults.target).toBe(oldDefaults.target)
  expect(returnedDefaults.generation).toBeGreaterThan(oldDefaults.generation)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-repository')?.checked).toBe(true)
  const refreshesAfterReturn = ui.refreshes

  await act(async () => { reset.resolve({ defaults: staleDefaults }); await reset.promise })
  await settle()
  expect(ui.refreshes).toBe(refreshesAfterReturn)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-repository')?.checked).toBe(true)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-draft')?.checked).toBe(true)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-useTemplate')?.checked).toBe(false)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-generateDetailsOnOpen')?.checked).toBe(false)
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-openAfterCreate')?.checked).toBe(false)
})
for (const bridge of ['ui.window.self', 'ui.window.command.run'] as const) {
  test(`a settings bridge completion after A to B replacement cannot report an error in B: ${bridge}`, async () => {
    const accounts = { requiredHost: 'github.com', accounts: [] }
    const settingsA = stateFor({ settings: { accounts, configuration: { account: null } } })
    const settingsB = stateFor({ worktree: '/work/b', settings: {
      worktree: '/work/b', accounts, configuration: { account: null }
    } })
    const ui = settings(settingsA, WORKTREE_A, (controls) => {
      controls.setMethod('quirky.worktree/list', () => [
        { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
        { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' }
      ])
    })
    await settle()
    ui.calls.splice(0)
    const release = deferred<void>()
    const entered = deferred<void>()
    let heldSelf: Deferred<unknown> | null = null
    if (bridge === 'ui.window.self') heldSelf = ui.holdNext(bridge)
    else {
      let holdFirstRun = true
      ui.setMethod(bridge, async (params) => {
        if (holdFirstRun) {
          holdFirstRun = false
          entered.resolve()
          await release.promise
        }
        const implementation = ui.getProvider(CONTROL_COMMAND)
        if (typeof implementation !== 'function') throw new Error('Missing activated command handler.')
        const run = implementation as (input?: unknown) => unknown | Promise<unknown>
        return { result: await run(params.args) }
      })
    }

    await click(button(ui.element, 'Re-check GitHub'))
    const bridgeCalls = ui.calls.filter((call) => call.method === bridge)
    if (bridgeCalls.length === 0) {
      release.resolve()
      expect(bridgeCalls).toHaveLength(1)
      return
    }
    if (bridge === 'ui.window.command.run') await entered.promise
    const workspace = registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
    expect(await requestControl(ui, workspace, 'workspace-select', { worktree: '/work/b' })).toEqual({ delivered: true })
    ui.render(settingsB, '/work/b')
    await settle()
    const replacement = registeredControl(ui, SETTINGS_VIEW, 'settings-hosting')
    expect(JSON.parse(replacement.target)[2]).toBe('/work/b')
    const oldWorktreeRefreshes = ui.calls.filter((call) =>
      call.method === 'quirky.reviews/hostingSettingsRefresh' && call.params.worktree === WORKTREE_A).length

    if (heldSelf) await act(async () => { heldSelf?.resolve({ connId: 42 }); await heldSelf?.promise })
    else release.resolve()
    await settle()
    expect(ui.calls.filter((call) =>
      call.method === 'quirky.reviews/hostingSettingsRefresh' && call.params.worktree === WORKTREE_A).length).toBe(oldWorktreeRefreshes)
    expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
  })
}

test('repository edits inherit globals saved after the repository read', async () => {
  const ui = settings(stateFor())
  await settle()
  await requestRegisteredControl(ui, SETTINGS_VIEW, 'settings-defaults-global', 'defaults-set', { key: 'draft', value: true })
  await requestRegisteredControl(ui, SETTINGS_VIEW, 'settings-defaults-global', 'defaults-save')
  await settle()
  await requestRegisteredControl(ui, SETTINGS_VIEW, 'settings-defaults-global', 'defaults-scope', { scope: 'repository' })
  await settle()
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-draft')?.checked).toBe(true)
  await requestRegisteredControl(ui, SETTINGS_VIEW, 'settings-defaults-repository', 'defaults-set', { key: 'useTemplate', value: true })
  await requestRegisteredControl(ui, SETTINGS_VIEW, 'settings-defaults-repository', 'defaults-save')
  await settle()
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/setCreationDefaults').at(-1)?.params).toEqual({
    scope: 'repository', worktree: WORKTREE_A,
    defaults: { draft: true, useTemplate: true, generateDetailsOnOpen: false, openAfterCreate: false }
  })
})

test('global editing preserves repository read failure and its retry', async () => {
  let repositoryReads = 0
  const ui = settings(stateFor(), WORKTREE_A, (controls) => {
    controls.setMethod('quirky.reviews/creationDefaults', (params) => {
      if (params.scope === 'global') return { defaults: DEFAULTS }
      if (++repositoryReads === 1) throw new Error('repository read remains failed')
      return { defaults: DEFAULTS, repoId: 'owner/repo', overrides: {} }
    })
  })
  await settle()
  await requestRegisteredControl(ui, SETTINGS_VIEW, 'settings-defaults-global', 'defaults-set', { key: 'draft', value: true })
  await settle()
  expect(ui.element.textContent).toContain('repository read remains failed')
  expect(registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-global').actions.find((entry) => entry.action === 'defaults-retry')?.enabled).toBe(true)
  await requestRegisteredControl(ui, SETTINGS_VIEW, 'settings-defaults-global', 'defaults-retry')
  await settle()
  expect(repositoryReads).toBe(2)
  expect(ui.element.textContent).not.toContain('repository read remains failed')
  expect(ui.element.querySelector<HTMLInputElement>('#creation-default-repository')?.disabled).toBe(false)
})

for (const replacement of ['scope', 'worktree'] as const) {
  test(`a same-turn ${replacement} replacement rejects the old defaults descriptor before mutation`, async () => {
    const ui = settings(stateFor(), WORKTREE_A, (controls) => {
      controls.setMethod('quirky.worktree/list', () => [
        { kind: 'git', id: WORKTREE_A, name: 'a', path: WORKTREE_A, branch: 'feature' },
        { kind: 'git', id: '/work/b', name: 'b', path: '/work/b', branch: 'topic' }
      ])
    })
    await settle()
    const defaults = registeredControl(ui, SETTINGS_VIEW, 'settings-defaults-global')
    const selector = replacement === 'scope' ? defaults : registeredControl(ui, SETTINGS_VIEW, 'settings-workspace')
    const implementation = ui.getProvider(CONTROL_COMMAND)
    if (typeof implementation !== 'function') throw new Error('Missing actual UI control handler.')
    const run = implementation as (request: unknown) => Promise<ReviewsUiControlResult>
    let oldResult: ReviewsUiControlResult | undefined
    await act(async () => {
      const first = run({
        target: selector.target, generation: selector.generation,
        action: replacement === 'scope' ? 'defaults-scope' : 'workspace-select',
        value: replacement === 'scope' ? { scope: 'repository' } : { worktree: '/work/b' }
      })
      const second = run({ target: defaults.target, generation: defaults.generation, action: 'defaults-save' })
      expect(await first).toEqual({ delivered: true })
      oldResult = await second
    })
    await settle()
    expect(oldResult).toEqual({ delivered: false, reason: 'target-unavailable' })
    expect(ui.calls.filter((call) => call.method === 'quirky.reviews/setCreationDefaults')).toHaveLength(0)
  })
}

for (const completion of ['resolve', 'reject'] as const) {
  test(`a replaced same-worktree generation retires its draft actions after ${completion}`, async () => {
    const generated = deferred<unknown>()
    const initial = stateFor({ creation: {
      eligibility: { eligible: true, confirmedAt: Date.now(), headOid: 'a'.repeat(40) }
    } })
    const ui = mount((props) => <CreateReview {...props} snapshot={undefined} />, initial, WORKTREE_A, (controls) => {
      controls.setMethod('quirky.reviews/createGenerate', () => generated.promise)
    })
    await settle()
    await requestRegisteredControl(ui, CREATE_VIEW, 'creation', 'generate')
    await settle()
    expect(ui.calls.filter((call) => call.method === 'quirky.reviews/createGenerate')).toHaveLength(1)
    const replacement = stateFor({ creation: {
      generation: 2, title: 'New session title', body: 'New session body',
      eligibility: { eligible: true, confirmedAt: Date.now(), headOid: 'b'.repeat(40) }
    } })
    ui.render(replacement)
    await settle()
    const refreshes = ui.refreshes
    await act(async () => {
      if (completion === 'resolve') generated.resolve({ title: 'Stale generated title', body: 'Stale generated body' })
      else generated.reject(new Error('stale generation rejection'))
      await generated.promise.catch(() => {})
    })
    await settle()
    ui.render({
      ...replacement,
      creation: { ...replacement.creation, title: 'Fresh remote title', body: 'Fresh remote body' }
    })
    await settle()
    expect(ui.element.querySelector<HTMLInputElement>('#review-title')?.value).toBe('Fresh remote title')
    expect(ui.element.querySelector<HTMLTextAreaElement>('#review-body')?.value).toBe('Fresh remote body')
    expect(ui.refreshes).toBe(refreshes)
    expect(ui.element.querySelector('.ui-inline-error')).toBeNull()
  })
}

test('same-head confirmation renewal preserves a held base draft', async () => {
  const initial = stateFor({ creation: {
    eligibility: { eligible: true, confirmedAt: Date.now(), headOid: 'a'.repeat(40) }
  } })
  const ui = create(initial)
  await settle()
  changeValue(ui.element.querySelector<HTMLInputElement>('#review-base')!, 'rel')
  await settle()
  ui.render({ ...initial, creation: { ...initial.creation, generation: 2 } })
  await settle()
  expect(ui.element.querySelector<HTMLInputElement>('#review-base')?.value).toBe('rel')
  expect(ui.calls.filter((call) => call.method === 'quirky.reviews/createBase')).toHaveLength(0)
})

test('session retirement reconciles its already-fetched numeric replacement snapshot', async () => {
  const generated = deferred<unknown>()
  let snapshot = nextDraftTick()
  const initial = stateFor({ creation: {
    eligibility: { eligible: true, confirmedAt: Date.now(), headOid: 'a'.repeat(40) }
  } })
  const ui = mount((props) => <CreateReview {...props} snapshot={snapshot} />, initial, WORKTREE_A, (controls) => {
    controls.setMethod('quirky.reviews/createGenerate', () => generated.promise)
  })
  await settle()
  await requestRegisteredControl(ui, CREATE_VIEW, 'creation', 'generate')
  await settle()
  snapshot = nextDraftTick()
  ui.render(stateFor({ creation: {
    generation: 2, title: 'Accepted replacement title', body: 'Accepted replacement body',
    eligibility: { eligible: true, confirmedAt: Date.now(), headOid: 'b'.repeat(40) }
  } }))
  await settle()
  expect(ui.element.querySelector<HTMLInputElement>('#review-title')?.value).toBe('Accepted replacement title')
  expect(ui.element.querySelector<HTMLTextAreaElement>('#review-body')?.value).toBe('Accepted replacement body')
  const refreshes = ui.refreshes
  await act(async () => {
    generated.resolve({ title: 'Discarded generation', body: 'Discarded body' })
    await generated.promise
  })
  await settle()
  expect(ui.element.querySelector<HTMLInputElement>('#review-title')?.value).toBe('Accepted replacement title')
  expect(ui.refreshes).toBe(refreshes)
})
