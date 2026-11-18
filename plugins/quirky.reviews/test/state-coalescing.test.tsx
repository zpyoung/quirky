import { afterAll, afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { CHECKS_PANEL, type ReviewsState } from '../src/contracts'
import { activate } from '../src/ui'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE_A = '/work/tree-a'
const WORKTREE_B = '/work/tree-b'
const roots: Array<() => void> = []
const timers = jest as typeof jest & {
  advanceTimersByTime(milliseconds: number): void
  setSystemTime(date: Date): void
}

afterEach(async () => {
  await act(async () => {
    for (const unmount of roots.splice(0)) unmount()
  })
  document.body.innerHTML = ''
  jest.useRealTimers()
})

beforeEach(() => {
  document.body.innerHTML = ''
  jest.useFakeTimers()
  timers.setSystemTime(new Date(0))
})

afterAll(() => GlobalRegistrator.unregister())

function stateFor(worktree: string, title: string, revision: number, missingOrigin = false): ReviewsState {
  const review = {
    provider: 'github', number: 12, url: 'https://github.com/test-owner/test-repo/pull/12', title, body: '',
    state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
    mergeable: 'MERGEABLE', checksStatus: 'passing', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
    autoMergeRequest: null, stack: null, mergeMethods: null
  }
  const detail = {
    target: null, tab: 'conversation', audience: 'all', generation: 0, loading: false, error: null, review: null, details: null,
    checks: null, comments: null, files: null, expandedChecks: [], queuedComments: [], checksCollapsed: false, commentDraft: '',
    fetchedAt: 0, pending: [], collapsedFiles: [], fileFilter: '', fileTreeVisible: true
  }
  const checks = {
    worktree, generation: 1, loading: false, error: null,
    lookup: missingOrigin
      ? { kind: 'unsupported', reason: 'missing_origin' }
      : { kind: 'found', gitStatus: { branch: 'feature', head: 'a'.repeat(40) } },
    eligibility: null, review,
    checks: { number: 12, headSha: 'a'.repeat(40), rollup: 'success', partial: false, partialFailures: [], checks: [] },
    comments: null, conflicts: null, audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [],
    checksCollapsed: false, commentDraft: '', titleDraft: null, height: 320, fetchedAt: Date.now(), agentDialog: null
  }
  const creation = { worktree, generation: 0, loading: false, error: null, bases: [], title: '', body: '', base: '', head: '', generating: false, submitting: false }
  const settings = { generation: 0, loading: false, error: null }
  return {
    revision, detail, checks, creation, settings,
    defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false },
    repoDefaults: {}, botOverrides: [], links: {}, suppressed: {}
  } as unknown as ReviewsState
}

type Call = { method: string; params?: unknown; at: number }
type ChangedEvent = { type: 'quirky.reviews/changed'; data: { revision: number; worktree?: string }; worktreeId?: string }
type Subscription = {
  listener: (event: ChangedEvent) => void | Promise<void>
  options?: { worktreeId?: string | null }
  active: boolean
}
type FakeOptions = {
  state?: (worktree: string, callNumber: number) => unknown | Promise<unknown>
  holdChecksRefresh?: boolean
}
type ReviewsTestContext = {
  calls: Call[]
  subscriptions: Subscription[]
  provided: Map<string, unknown>
  setWorktree(next: string): void
  emit(worktreeId?: string): void
  connect(status: string): void
  resolveChecksRefresh(worktree: string, result: unknown): void
}


function fakeContext(options: FakeOptions = {}): ReviewsTestContext {
  const calls: Call[] = []
  const subscriptions: Subscription[] = []
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const connectionListeners = new Set<(status: string) => void>()
  const provided = new Map<string, unknown>()
  const checksRefreshResolvers = new Map<string, Array<(result: unknown) => void>>()
  let layout = {
    worktree: WORKTREE_A, view: null, panel: null, sidebar: true, focus: null,
    tools: { open: { right: CHECKS_PANEL } }
  } as unknown as UiLayout
  let stateCallNumber = 0

  const fake = {
    calls,
    subscriptions,
    provided,
    setWorktree(next: string) {
      layout = { ...layout, worktree: next }
      for (const listener of [...layoutListeners]) listener(layout)
    },
    emit(worktreeId?: string) {
      const event: ChangedEvent = {
        type: 'quirky.reviews/changed', data: { revision: 1, ...(worktreeId === undefined ? {} : { worktree: worktreeId }) },
        ...(worktreeId === undefined ? {} : { worktreeId })
      }
      for (const subscription of [...subscriptions]) {
        if (!subscription.active) continue
        const scope = subscription.options?.worktreeId
        if (scope !== undefined && typeof worktreeId === 'string' && worktreeId !== scope) continue
        void subscription.listener(event)
      }
    },
    connect(status: string) {
      for (const listener of [...connectionListeners]) listener(status)
    },
    resolveChecksRefresh(worktree: string, result: unknown) {
      const pending = checksRefreshResolvers.get(worktree)?.shift()
      if (!pending) throw new Error(`No checks refresh is pending for ${worktree}.`)
      pending(result)
    },
    context: {
      pluginId: 'quirky.reviews',
      provide(id: string, implementation: unknown) { provided.set(id, implementation) },
      async call(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params, at: Date.now() })
        if (method === 'ui.window.self') return { connId: 42 }
        if (method === 'ui.window.command.run') {
          const request = params as { id: string; args: unknown }
          const handler = provided.get(request.id)
          if (typeof handler !== 'function') throw new Error(`Missing provided command: ${request.id}`)
          return { result: await handler(request.args) }
        }
        if (method === 'quirky.reviews/state') {
          const worktree = typeof params.worktree === 'string' ? params.worktree : String(layout.worktree ?? '')
          const callNumber = ++stateCallNumber
          return options.state
            ? options.state(worktree, callNumber)
            : stateFor(worktree, `Review ${worktree} ${callNumber}`, callNumber)
        }
        if (method === 'quirky.reviews/checksRefresh') {
          if (!options.holdChecksRefresh) return { ok: true }
          const worktree = String(params.worktree)
          const pending = Promise.withResolvers<unknown>()
          const resolvers = checksRefreshResolvers.get(worktree) ?? []
          resolvers.push(pending.resolve)
          checksRefreshResolvers.set(worktree, resolvers)
          return pending.promise
        }
        return { ok: true }
      },
      subscribe(listener: Subscription['listener'], subscribeOptions?: Subscription['options']) {
        const subscription = { listener, options: subscribeOptions, active: true }
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
  activate(fake.context as unknown as UiPluginContext)
  return fake
}

async function mountSurface(fake: ReviewsTestContext) {
  const mount = fake.provided.get(CHECKS_PANEL)
  if (typeof mount !== 'function') throw new Error(`activate did not provide ${CHECKS_PANEL}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | null = null
  await act(async () => { cleanup = mount(element, {}) })
  const unmount = () => {
    cleanup?.()
    cleanup = null
    element.remove()
  }
  roots.push(unmount)
  await settle()
  return { element, unmount }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => {})
}

async function advanceClock(milliseconds: number) {
  await act(async () => { timers.advanceTimersByTime(milliseconds) })
  await settle()
}

async function emitChanged(fake: ReviewsTestContext, worktree?: string) {
  await act(async () => fake.emit(worktree))
  await settle()
}

async function switchWorktree(fake: ReviewsTestContext, worktree: string) {
  await act(async () => fake.setWorktree(worktree))
  await settle()
}

async function completeManualRefresh(element: HTMLElement) {
  const button = element.querySelector<HTMLButtonElement>('button[aria-label="Refresh checks"]')
  expect(button).not.toBeNull()
  expect(button!.disabled).toBe(false)
  await act(async () => { button!.click() })
  await settle()
}

function stateCalls(fake: ReviewsTestContext) {
  return fake.calls.filter(({ method }) => method === 'quirky.reviews/state')
}

function checksRefreshCalls(fake: ReviewsTestContext) {
  return fake.calls.filter(({ method }) => method === 'quirky.reviews/checksRefresh')
}

test('Checks mounted during disconnection recovers once on its first connected event and keeps the cooldown', async () => {
  const fake = fakeContext({ holdChecksRefresh: true, state: (worktree, callNumber) => {
    if (callNumber === 1) throw new Error('Not connected')
    return stateFor(worktree, 'Recovered connection', callNumber)
  } })
  fake.connect('reconnecting')
  const surface = await mountSurface(fake)
  expect(stateCalls(fake)).toHaveLength(1)

  await act(async () => fake.connect('connected'))
  await settle()
  expect(stateCalls(fake)).toHaveLength(2)
  expect(surface.element.textContent).toContain('Recovered connection')

  await act(async () => fake.connect('connected'))
  await settle()
  expect(stateCalls(fake)).toHaveLength(2)

  await emitChanged(fake, WORKTREE_A)
  await advanceClock(2_999)
  expect(stateCalls(fake)).toHaveLength(2)
  await advanceClock(1)
  expect(stateCalls(fake)).toHaveLength(3)
})

test('a first connected event during an unknown initial read recovers when that read later fails', async () => {
  const initial = Promise.withResolvers<ReviewsState>()
  const fake = fakeContext({
    state: (worktree, callNumber) => callNumber === 1
      ? initial.promise
      : callNumber === 2
        ? Promise.reject(new Error('Not connected'))
        : stateFor(worktree, 'Recovered after initial failure', callNumber)
  })
  const surface = await mountSurface(fake)
  expect(stateCalls(fake)).toHaveLength(1)

  await act(async () => fake.connect('connected'))
  await settle()
  expect(stateCalls(fake)).toHaveLength(1)

  await act(async () => { initial.reject(new Error('Not connected')) })
  await settle()
  expect(stateCalls(fake)).toHaveLength(2)
  expect(surface.element.textContent).toContain('Not connected')

  await act(async () => fake.connect('connected'))
  await settle()
  expect(stateCalls(fake)).toHaveLength(2)
})

test('a successful initial read treats duplicate connected events as no-ops', async () => {
  const fake = fakeContext()
  await mountSurface(fake)
  expect(stateCalls(fake)).toHaveLength(1)

  await act(async () => {
    fake.connect('connected')
    fake.connect('connected')
  })
  await settle()
  expect(stateCalls(fake)).toHaveLength(1)
})

test('a remount reads successfully after a connected edge was missed while unmounted', async () => {
  const fake = fakeContext({ state: (worktree, callNumber) => {
    if (callNumber === 1) throw new Error('Not connected')
    return stateFor(worktree, 'Recovered after remount', callNumber)
  } })
  fake.connect('reconnecting')
  const first = await mountSurface(fake)
  expect(stateCalls(fake)).toHaveLength(1)
  await act(async () => first.unmount())

  fake.connect('connected')
  await advanceClock(3_000)
  const remounted = await mountSurface(fake)
  expect(stateCalls(fake)).toHaveLength(2)
  expect(remounted.element.textContent).toContain('Recovered after remount')

  await act(async () => fake.connect('connected'))
  await settle()
  expect(stateCalls(fake)).toHaveLength(2)
})


test('ten settled scoped changes coalesce with the immediate manual completion read', async () => {
  const fake = fakeContext()
  const surface = await mountSurface(fake)
  expect(stateCalls(fake)).toHaveLength(1)
  expect(fake.subscriptions.some(({ active, options }) => active && options?.worktreeId === WORKTREE_A)).toBe(true)

  await emitChanged(fake, WORKTREE_B)
  expect(stateCalls(fake)).toHaveLength(1)
  for (let index = 0; index < 10; index += 1) {
    await emitChanged(fake, WORKTREE_A)
    if (index < 9) await advanceClock(10)
  }

  await completeManualRefresh(surface.element)
  expect(stateCalls(fake).map(({ params }) => params)).toEqual([
    { worktree: WORKTREE_A }, { worktree: WORKTREE_A }
  ])
  expect(checksRefreshCalls(fake).map(({ params }) => params)).toEqual([
    { worktree: WORKTREE_A, force: true }
  ])
})

test('a manual fresh read renders before an older automatic read settles', async () => {
  const older = Promise.withResolvers<ReviewsState>()
  const fake = fakeContext({
    state: (worktree, callNumber) => callNumber === 2
      ? older.promise
      : stateFor(worktree, callNumber === 1 ? 'Initial state' : 'Fresh manual state', callNumber)
  })
  const surface = await mountSurface(fake)
  await emitChanged(fake, WORKTREE_A)
  await advanceClock(3_000)
  expect(stateCalls(fake)).toHaveLength(2)

  await completeManualRefresh(surface.element)
  expect(stateCalls(fake)).toHaveLength(3)
  expect(surface.element.textContent).toContain('Fresh manual state')

  await act(async () => { older.resolve(stateFor(WORKTREE_A, 'Late automatic state', 99)) })
  await settle()
  expect(surface.element.textContent).toContain('Fresh manual state')
  expect(surface.element.textContent).not.toContain('Late automatic state')
})

test('worktree changes and reconnects read immediately while fencing an old target response', async () => {
  const oldA = Promise.withResolvers<ReviewsState>()
  const fake = fakeContext({
    holdChecksRefresh: true,
    state: (worktree, callNumber) => worktree === WORKTREE_A && callNumber === 2
      ? oldA.promise
      : stateFor(worktree, worktree === WORKTREE_B ? `Current ${worktree}` : `State ${callNumber}`, callNumber)
  })
  const surface = await mountSurface(fake)
  await emitChanged(fake, WORKTREE_A)
  await advanceClock(3_000)
  expect(stateCalls(fake)).toHaveLength(2)

  await switchWorktree(fake, WORKTREE_B)
  expect(stateCalls(fake).map(({ params }) => params)).toEqual([
    { worktree: WORKTREE_A }, { worktree: WORKTREE_A }, { worktree: WORKTREE_B }
  ])
  expect(checksRefreshCalls(fake).map(({ params }) => params)).toEqual([
    { worktree: WORKTREE_B, force: true }
  ])
  expect(surface.element.textContent).toContain(`Current ${WORKTREE_B}`)
  await emitChanged(fake, WORKTREE_A)
  expect(stateCalls(fake)).toHaveLength(3)

  await act(async () => {
    fake.connect('reconnecting')
    fake.connect('connected')
  })
  await settle()
  expect(stateCalls(fake)).toHaveLength(4)
  expect(stateCalls(fake)[3]?.params).toEqual({ worktree: WORKTREE_B })
  await act(async () => fake.connect('connected'))
  await settle()
  expect(stateCalls(fake)).toHaveLength(4)

  await act(async () => { oldA.resolve(stateFor(WORKTREE_A, 'Late A response', 99)) })
  await settle()
  expect(surface.element.textContent).toContain(`Current ${WORKTREE_B}`)
  expect(surface.element.textContent).not.toContain('Late A response')

  await act(async () => fake.resolveChecksRefresh(WORKTREE_B, { ok: true }))
  await settle()
  expect(stateCalls(fake).map(({ params }) => params)).toEqual([
    { worktree: WORKTREE_A }, { worktree: WORKTREE_A },
    { worktree: WORKTREE_B }, { worktree: WORKTREE_B }, { worktree: WORKTREE_B }
  ])
})

test('a fresh completion resets the automatic deadline', async () => {
  const fake = fakeContext()
  const surface = await mountSurface(fake)
  const initialStart = stateCalls(fake)[0]!.at

  await advanceClock(2_000)
  await completeManualRefresh(surface.element)
  expect(stateCalls(fake)).toHaveLength(2)
  expect(stateCalls(fake)[1]!.at).toBe(initialStart + 2_000)

  await emitChanged(fake, WORKTREE_A)
  await advanceClock(2_999)
  expect(stateCalls(fake)).toHaveLength(2)
  await advanceClock(1)
  expect(stateCalls(fake)).toHaveLength(3)
  expect(stateCalls(fake)[2]!.at).toBe(initialStart + 5_000)
})

test('sustained changes keep one dirty read and do not invalidate a publishable in-flight response', async () => {
  const inFlight = Promise.withResolvers<ReviewsState>()
  const fake = fakeContext({
    state: (worktree, callNumber) => callNumber === 2
      ? inFlight.promise
      : stateFor(worktree, `State ${callNumber}`, callNumber)
  })
  const surface = await mountSurface(fake)
  await emitChanged(fake, WORKTREE_A)
  await advanceClock(3_000)
  expect(stateCalls(fake)).toHaveLength(2)

  for (let index = 0; index < 5; index += 1) {
    await advanceClock(500)
    await emitChanged(fake, WORKTREE_A)
  }
  expect(stateCalls(fake)).toHaveLength(2)

  await act(async () => { inFlight.resolve(stateFor(WORKTREE_A, 'Accepted in-flight state', 2)) })
  await settle()
  expect(surface.element.textContent).toContain('Accepted in-flight state')
  expect(stateCalls(fake)).toHaveLength(2)

  await advanceClock(499)
  expect(stateCalls(fake)).toHaveLength(2)
  await advanceClock(1)
  expect(stateCalls(fake)).toHaveLength(3)
  expect(stateCalls(fake)[2]!.at).toBe(stateCalls(fake)[0]!.at + 6_000)
})

test('unmount cancels an automatic trailing read', async () => {
  const fake = fakeContext()
  const surface = await mountSurface(fake)
  await emitChanged(fake, WORKTREE_A)
  await act(async () => surface.unmount())

  await advanceClock(3_000)
  expect(stateCalls(fake)).toHaveLength(1)
  expect(fake.subscriptions.every(({ active }) => !active)).toBe(true)
})

test('transient remounts retain the activation target deadline', async () => {
  const fake = fakeContext()
  const first = await mountSurface(fake)
  await emitChanged(fake, WORKTREE_A)
  await advanceClock(1_000)
  await act(async () => first.unmount())

  const remounted = await mountSurface(fake)
  expect(stateCalls(fake)).toHaveLength(1)
  await advanceClock(1_999)
  expect(stateCalls(fake)).toHaveLength(1)
  await advanceClock(1)
  expect(stateCalls(fake)).toHaveLength(2)
  expect(stateCalls(fake)[1]!.at).toBe(stateCalls(fake)[0]!.at + 3_000)
  await act(async () => remounted.unmount())
})

for (const completesBeforeSwitch of [true, false]) {
  test(`entry completions ${completesBeforeSwitch ? 'before' : 'after'} a worktree switch refresh only active targets`, async () => {
    const fake = fakeContext({
      holdChecksRefresh: true,
      state: (worktree, callNumber) => stateFor(worktree, `Missing origin ${worktree}`, callNumber, true)
    })
    const surface = await mountSurface(fake)
    expect(checksRefreshCalls(fake).map(({ params }) => params)).toEqual([
      { worktree: WORKTREE_A, force: true }
    ])

    if (completesBeforeSwitch) {
      await act(async () => fake.resolveChecksRefresh(WORKTREE_A, { ok: true }))
      await settle()
      expect(stateCalls(fake).map(({ params }) => params)).toEqual([
        { worktree: WORKTREE_A }, { worktree: WORKTREE_A }
      ])
    }

    await switchWorktree(fake, WORKTREE_B)
    expect(checksRefreshCalls(fake).map(({ params }) => params)).toEqual([
      { worktree: WORKTREE_A, force: true }, { worktree: WORKTREE_B, force: true }
    ])
    if (!completesBeforeSwitch) {
      await act(async () => fake.resolveChecksRefresh(WORKTREE_A, { ok: true }))
      await settle()
      expect(stateCalls(fake).map(({ params }) => params)).toEqual([
        { worktree: WORKTREE_A }, { worktree: WORKTREE_B }
      ])
    }

    await act(async () => fake.resolveChecksRefresh(WORKTREE_B, { ok: true }))
    await settle()
    expect(checksRefreshCalls(fake).map(({ params }) => params)).toEqual([
      { worktree: WORKTREE_A, force: true }, { worktree: WORKTREE_B, force: true }
    ])
    expect(stateCalls(fake).map(({ params }) => params)).toEqual(completesBeforeSwitch
      ? [{ worktree: WORKTREE_A }, { worktree: WORKTREE_A }, { worktree: WORKTREE_B }, { worktree: WORKTREE_B }]
      : [{ worktree: WORKTREE_A }, { worktree: WORKTREE_B }, { worktree: WORKTREE_B }])
    expect(surface.element.textContent).toContain(`Missing origin ${WORKTREE_B}`)
  })
}
