import { afterAll, afterEach, expect, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { CreateReview } from '../src/create/CreateReview'
import { HostingSettings } from '../src/create/HostingSettings'
import type { ReviewsState } from '../src/contracts'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE_A = '/work/a'
const DEFAULTS = { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }
const DEFAULTS_TRUE = { draft: true, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }
const ROOTS: Root[] = []

type Call = { method: string; params: Record<string, unknown> }
type Method = (params: Record<string, unknown>) => unknown | Promise<unknown>
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
type Harness = {
  context: UiPluginContext
  calls: Call[]
  holdNext(method: string): Deferred<unknown>
  replyNext(method: string, value: unknown): void
  setMethod(method: string, implementation: Method): void
  refreshes: number
  render(state: ReviewsState, worktree?: string | null): void
  element: HTMLElement
  unmount(): void
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
  setup?: (harness: Omit<Harness, 'element' | 'render' | 'unmount'>) => void
): Harness {
  const calls: Call[] = []
  const methods = new Map<string, Method>()
  const held = new Map<string, Deferred<unknown>[]>()
  const replies = new Map<string, unknown[]>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  let state = initialState
  let worktree = initialWorktree
  let refreshes = 0
  let layout = { worktree, view: { id: 'view:fixture' }, panel: null, sidebar: true, focus: 'view' } as unknown as UiLayout
  const context = {
    pluginId: 'quirky.reviews',
    provide() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const pending = held.get(method)?.shift()
      if (held.get(method)?.length === 0) held.delete(method)
      if (pending) return pending.promise
      const queued = replies.get(method)
      if (queued?.length) return queued.shift()
      const implementation = methods.get(method)
      if (implementation) return await implementation(params)
      return defaultReply(method, params)
    },
    getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) { layoutListeners.add(listener); return () => layoutListeners.delete(listener) },
    onConnection: () => () => {},
    subscribe: () => () => {},
    getSetting: () => undefined,
    toast() {}, log() {}
  } as unknown as UiPluginContext
  const controls = {
    context, calls,
    holdNext(method: string) {
      const request = deferred<unknown>()
      held.set(method, [...(held.get(method) ?? []), request])
      return request
    },
    replyNext(method: string, value: unknown) { replies.set(method, [...(replies.get(method) ?? []), value]) },
    setMethod(method: string, implementation: Method) { methods.set(method, implementation) },
    get refreshes() { return refreshes }
  }
  setup?.(controls)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  ROOTS.push(root)
  const refresh = async () => { refreshes += 1 }
  const draw = () => root.render(renderNode({ context, state, refresh, snapshot: 0 }))
  act(draw)
  return {
    ...controls,
    element,
    get refreshes() { return refreshes },
    render(next, nextWorktree = worktree) {
      state = next
      worktree = nextWorktree
      layout = { ...layout, worktree } as UiLayout
      for (const listener of [...layoutListeners]) listener(layout)
      act(draw)
    },
    unmount() {
      ROOTS.splice(ROOTS.indexOf(root), 1)
      act(() => root.unmount())
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

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

function create(initial: ReviewsState, worktree: string | null = WORKTREE_A, setup?: Parameters<typeof mount>[3]) {
  return mount((props) => <CreateReview {...props} />, initial, worktree, setup)
}

function settings(initial: ReviewsState, worktree: string | null = WORKTREE_A, setup?: Parameters<typeof mount>[3]) {
  return mount((props) => <HostingSettings {...props} />, initial, worktree, setup)
}

afterEach(() => {
  for (const root of ROOTS.splice(0).reverse()) act(() => root.unmount())
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
