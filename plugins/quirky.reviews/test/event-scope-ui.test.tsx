import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import { CHECKS_PANEL, CREATE_VIEW, REVIEW_VIEW, SETTINGS_VIEW, type ReviewsState } from '../src/contracts'
import { activate } from '../src/ui'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE_A = '/work/tree-a'
const WORKTREE_B = '/work/tree-b'
const roots: Array<() => void> = []

afterEach(async () => {
  await act(async () => { for (const unmount of roots.splice(0)) unmount() })
  document.body.innerHTML = ''
})

afterAll(() => GlobalRegistrator.unregister())

type Call = { method: string; params?: unknown }
type SubscribeOptions = { worktreeId?: string | null }
type Subscription = {
  listener: (event: QuirkyEvent) => void | Promise<void>
  options?: SubscribeOptions
  active: boolean
}
const DEFAULTS = { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }

function stateFor(worktree: string | null): ReviewsState {
  const detail = {
    target: null, tab: 'conversation', audience: 'all', generation: 0, loading: false, error: null, review: null, details: null,
    checks: null, comments: null, files: null, expandedChecks: [], queuedComments: [], checksCollapsed: false,
    selectedFile: null, diffMode: 'inline', collapsedFiles: [], fileFilter: '', fileTreeVisible: true,
    commentDraft: '', bodyDraft: null, pending: [], fetchedAt: 0
  }
  const checks = {
    worktree, generation: 0, loading: false, error: null, lookup: worktree === null ? null : { kind: 'folder' },
    eligibility: null, review: null, checks: null, comments: null, conflicts: null, audience: 'all', grouping: 'grouped',
    expandedChecks: [], queuedComments: [], checksCollapsed: false, commentDraft: '', titleDraft: null, height: 320,
    fetchedAt: Date.now(), agentDialog: null
  }
  const creation = {
    worktree, generation: 0, loading: false, error: null, eligibility: null, title: '', body: '', base: '', head: '',
    draft: false, useTemplate: false, bases: [], generating: false, requestId: null, submitting: false, generated: false,
    result: null, defaults: DEFAULTS
  }
  const settings = {
    worktree, generation: 0, loading: false, error: null, diagnostics: null, accounts: null, configuration: null, budget: null, fetchedAt: 0
  }
  return {
    revision: 1, previousView: null, detail, checks, creation, settings,
    defaults: DEFAULTS, repoDefaults: {}, botOverrides: [], links: {}, suppressed: {}
  } as unknown as ReviewsState
}


function fakeContext(worktree: string | null) {
  const calls: Call[] = []
  const subscriptions: Subscription[] = []
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const connectionListeners = new Set<(status: string) => void>()
  const provided = new Map<string, unknown>()
  let layout = { worktree } as UiLayout
  const fake = {
    calls,
    subscriptions,
    provided,
    setWorktree(next: string | null) {
      layout = { ...layout, worktree: next }
      for (const listener of [...layoutListeners]) listener(layout)
    },
    emit(event: QuirkyEvent) {
      for (const subscription of [...subscriptions]) {
        if (!subscription.active) continue
        const scope = subscription.options?.worktreeId
        const eventWorktreeId = 'worktreeId' in event ? event.worktreeId : undefined
        if (scope !== undefined && event.type.includes('/') && typeof eventWorktreeId === 'string' && eventWorktreeId !== scope) continue
        void subscription.listener(event)
      }
    },
    connect(status: string) {
      for (const listener of [...connectionListeners]) listener(status)
    },
    activeConnectionCount() { return connectionListeners.size },
    context: {
      provide(id: string, implementation: unknown) { provided.set(id, implementation) },
      async call(method: string, params?: unknown) {
        calls.push({ method, params })
        if (method === 'quirky.reviews/state') {
          const requested = typeof params === 'object' && params !== null && 'worktree' in params && typeof params.worktree === 'string' ? params.worktree : null
          const selected = typeof layout.worktree === 'string' ? layout.worktree : null
          return stateFor(requested ?? selected)
        }
        if (method === 'quirky.worktree/list') return []
        if (method === 'quirky.reviews/creationDefaults') return { defaults: DEFAULTS, repoId: 'fixture/repo', overrides: {} }
        if (method === 'quirky.reviews/hostingSettingsRefresh') return {}
        throw new Error(`Unexpected UI test call: ${method}`)
      },
      subscribe(listener: Subscription['listener'], options?: SubscribeOptions) {
        const subscription = { listener, options, active: true }
        subscriptions.push(subscription)
        return () => { subscription.active = false }
      },
      getLayout() { return layout },
      onLayout(listener: (next: UiLayout) => void) {
        layoutListeners.add(listener)
        return () => layoutListeners.delete(listener)
      },
      onConnection(listener: (status: string) => void) {
        connectionListeners.add(listener)
        return () => connectionListeners.delete(listener)
      },
      getSetting() { return undefined },
      toast() {}
    }
  }
  return fake
}

async function mountSurface(fake: ReturnType<typeof fakeContext>, view: string) {
  activate(fake.context as unknown as UiPluginContext)
  const mount = fake.provided.get(view)
  if (typeof mount !== 'function') throw new Error(`activate did not provide ${view}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | void
  await act(async () => { cleanup = mount(element, {}) })
  roots.push(() => { cleanup?.(); cleanup = undefined })
  await settle()
  return {
    element,
    async unmount() {
      const remove = cleanup
      cleanup = undefined
      await act(async () => { remove?.() })
    }
  }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => {})
}

function stateCalls(fake: ReturnType<typeof fakeContext>): Call[] {
  return fake.calls.filter(({ method }) => method === 'quirky.reviews/state')
}

function scopedSubscriptions(fake: ReturnType<typeof fakeContext>): Subscription[] {
  return fake.subscriptions.filter(({ options }) => options?.worktreeId !== undefined)
}

function changed(worktreeId?: string): QuirkyEvent {
  return {
    type: 'quirky.reviews/changed',
    data: { revision: 1, ...(worktreeId === undefined ? {} : { worktree: worktreeId }) },
    ...(worktreeId === undefined ? {} : { worktreeId })
  } as unknown as QuirkyEvent
}

test('Checks scopes refreshes to its selected worktree and keeps connection and cleanup behavior', async () => {
  const fake = fakeContext(WORKTREE_A)
  const surface = await mountSurface(fake, CHECKS_PANEL)

  expect(stateCalls(fake).map(({ params }) => params)).toEqual([{ worktree: WORKTREE_A }])
  expect(scopedSubscriptions(fake).map(({ options }) => options)).toEqual([{ worktreeId: WORKTREE_A }])

  await act(async () => fake.emit(changed(WORKTREE_B)))
  await settle()
  expect(stateCalls(fake)).toHaveLength(1)

  await act(async () => fake.emit(changed(WORKTREE_A)))
  await settle()
  expect(stateCalls(fake).map(({ params }) => params)).toEqual([{ worktree: WORKTREE_A }, { worktree: WORKTREE_A }])

  await act(async () => fake.emit(changed()))
  await settle()
  expect(stateCalls(fake)).toHaveLength(3)

  await act(async () => fake.connect('connected'))
  await settle()
  expect(stateCalls(fake)).toHaveLength(4)

  await surface.unmount()
  expect(fake.subscriptions.every(({ active }) => !active)).toBe(true)
  expect(fake.activeConnectionCount()).toBe(0)
  await act(async () => fake.connect('connected'))
  await settle()
  expect(stateCalls(fake)).toHaveLength(4)
})

test('Checks replaces its subscription and state selector when layout worktree changes', async () => {
  const fake = fakeContext(WORKTREE_A)
  const surface = await mountSurface(fake, CHECKS_PANEL)
  const previous = scopedSubscriptions(fake)[0]

  await act(async () => fake.setWorktree(WORKTREE_B))
  await settle()

  expect(previous?.active).toBe(false)
  expect(scopedSubscriptions(fake).map(({ options, active }) => ({ options, active }))).toEqual([
    { options: { worktreeId: WORKTREE_A }, active: false },
    { options: { worktreeId: WORKTREE_B }, active: true }
  ])
  expect(stateCalls(fake).map(({ params }) => params)).toEqual([{ worktree: WORKTREE_A }, { worktree: WORKTREE_B }])

  await act(async () => fake.emit(changed(WORKTREE_A)))
  await settle()
  expect(stateCalls(fake)).toHaveLength(2)

  await act(async () => fake.emit(changed(WORKTREE_B)))
  await settle()
  expect(stateCalls(fake).map(({ params }) => params)).toEqual([
    { worktree: WORKTREE_A }, { worktree: WORKTREE_B }, { worktree: WORKTREE_B }
  ])
  await surface.unmount()
  expect(fake.subscriptions.every(({ active }) => !active)).toBe(true)
})

test('Checks without a selection subscribes unscoped and refreshes the latest entry', async () => {
  const fake = fakeContext(null)
  const surface = await mountSurface(fake, CHECKS_PANEL)

  expect(stateCalls(fake).map(({ params }) => params)).toEqual([undefined])
  expect(fake.subscriptions.some(({ active, options }) => active && options === undefined)).toBe(true)

  await act(async () => fake.emit(changed(WORKTREE_A)))
  await settle()
  expect(stateCalls(fake).map(({ params }) => params)).toEqual([undefined, undefined])
  await surface.unmount()
})

for (const [name, view] of [
  ['review', REVIEW_VIEW],
  ['create', CREATE_VIEW],
  ['settings', SETTINGS_VIEW]
] as const) {
  test(`${name} ignores tagged review changes and accepts shared changes`, async () => {
    const fake = fakeContext(WORKTREE_A)
    const surface = await mountSurface(fake, view)

    const initialStateCalls = stateCalls(fake).length
    expect(initialStateCalls).toBeGreaterThanOrEqual(1)
    expect(scopedSubscriptions(fake).map(({ options }) => options)).toEqual([{ worktreeId: null }])

    await act(async () => fake.emit(changed(WORKTREE_A)))
    await act(async () => fake.emit(changed(WORKTREE_B)))
    await settle()
    expect(stateCalls(fake)).toHaveLength(initialStateCalls)

    await act(async () => fake.emit(changed()))
    await settle()
    expect(stateCalls(fake)).toHaveLength(initialStateCalls + 1)
    await surface.unmount()
  })
}
