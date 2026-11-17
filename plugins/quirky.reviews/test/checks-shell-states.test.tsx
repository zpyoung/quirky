import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import { CHECKS_PANEL, CREATE_VIEW, REVIEW_VIEW, SETTINGS_VIEW, type ReviewsState } from '../src/contracts'
import { activate } from '../src/ui'
import * as controls from '../src/checks/data'

const {
  copyReviewsText,
  listReviewsUiControls,
  registerReviewsUiControl,
  requestReviewsUiControl,
  REVIEWS_UI_CONTROL,
  reviewsUiControlDescriptor,
  runReviewsUiControl,
  subscribeReviewsUiControls
} = controls

type ReviewsUiControlRequest = {
  target: string
  generation: number
  action: string
  value?: Record<string, unknown>
}
type ReviewsUiControlRegistration = {
  surface: string
  slot: string
  target: string
  actions(): Array<{ action: string; enabled: boolean }>
  run(request: ReviewsUiControlRequest, isCurrent: () => boolean): unknown | Promise<unknown>
}

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: Array<() => void> = []
const CONTROL_COMMAND = 'command:quirky.reviews/ui-control'
const PANEL_SURFACE = 'panel:quirky.reviews/checks'
const WORKTREE = '/work/tree'
const REPO = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
const DEFAULTS = { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false }

const review = {
  provider: 'github', number: 12, url: 'https://github.com/test-owner/test-repo/pull/12', title: 'Review 12', body: '',
  state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
  mergeable: 'MERGEABLE', checksStatus: 'passing', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
  autoMergeRequest: null, stack: null, mergeMethods: null, prRepo: REPO
}

function reviewsState(): ReviewsState {
  const checks = {
    number: 12, headSha: 'a'.repeat(40), rollup: 'success', partial: false, partialFailures: [], checks: []
  }
  return {
    revision: 1,
    detail: {
      target: { worktree: WORKTREE, number: 12, prRepo: REPO }, tab: 'conversation', generation: 1, loading: false, error: null,
      review: { ...review, assignees: [], requestedReviewers: [], reviews: [] }, details: { item: { viewerCanUpdate: true } }, checks,
      comments: { number: 12, comments: [], partial: false, partialFailures: [] },
      files: { number: 12, files: [], truncated: false, filesUnavailable: false, partialFailures: [] },
      audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [], checksCollapsed: false,
      selectedFile: null, diffMode: 'inline', collapsedFiles: [], fileFilter: '', fileTreeVisible: true,
      commentDraft: '', bodyDraft: null, pending: [], fetchedAt: 1
    },
    checks: {
      worktree: WORKTREE, generation: 1, loading: false, error: null, lookup: null, eligibility: null, review,
      checks, comments: { number: 12, comments: [], partial: false, partialFailures: [] }, conflicts: null,
      audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [], checksCollapsed: false,
      commentDraft: '', titleDraft: null, height: 320, fetchedAt: 1, agentDialog: null
    },
    creation: {
      worktree: WORKTREE, generation: 1, loading: false, error: null,
      eligibility: { eligible: true, confirmedAt: 1 }, title: 'Create title', body: 'Create body', base: 'main', head: 'feature',
      draft: false, useTemplate: false, bases: ['main', 'release'], generating: false, requestId: null,
      submitting: false, generated: false, result: null, defaults: DEFAULTS
    },
    settings: {
      worktree: WORKTREE, generation: 1, loading: false, error: null, diagnostics: null, accounts: null,
      configuration: null, budget: null, fetchedAt: 0
    },
    defaults: DEFAULTS, repoDefaults: {}, botOverrides: [], links: {}, suppressed: {}
  } as unknown as ReviewsState
}

type Call = { method: string; params: Record<string, unknown> }
type Method = (params: Record<string, unknown>) => unknown | Promise<unknown>

function makeContext(connId = 41, worktree: string | null = WORKTREE) {
  const providers = new Map<string, (args?: unknown) => unknown>()
  const methods = new Map<string, Method>()
  const calls: Call[] = []
  const eventListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  let layout = { worktree, view: { id: 'view:fixture' }, panel: null, sidebar: true, focus: 'view' } as unknown as UiLayout
  let executeCommandCalls = 0
  const context = {
    pluginId: 'quirky.reviews',
    provide(id: string, implementation: unknown) {
      providers.set(id, implementation as (args?: unknown) => unknown)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const implementation = methods.get(method)
      if (implementation) return await implementation(params)
      if (method === 'ui.window.self') return { connId }
      if (method === 'ui.window.command.run') {
        if (params.connId !== connId || params.id !== CONTROL_COMMAND) throw new Error('Unexpected exact-window command route.')
        const handler = providers.get(CONTROL_COMMAND)
        if (!handler) throw new Error('The generic UI control handler is not provided.')
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.reviews/state') return reviewsState()
      if (method === 'quirky.worktree/list') return []
      if (method === 'quirky.reviews/creationDefaults') return { defaults: DEFAULTS }
      if (method === 'quirky.tasks/state') return {}
      return undefined
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onConnection: () => () => {},
    onLayout(listener: (layout: UiLayout) => void) { layoutListeners.add(listener); return () => layoutListeners.delete(listener) },
    getLayout: () => layout,
    getSetting: () => undefined,
    toast() {},
    log() {},
    async executeCommand() { executeCommandCalls += 1 }
  } as unknown as UiPluginContext
  return {
    context, providers, methods, calls, eventListeners,
    executeCommandCalls: () => executeCommandCalls,
    selectWorktree(worktree: string) {
      layout = { ...layout, worktree }
      for (const listener of layoutListeners) listener(layout)
    },
    async emitChanged() {
      for (const listener of eventListeners) await listener({ type: 'quirky.reviews/changed', data: {} } as QuirkyEvent)
    }
  }
}

const surfaces = [
  { kind: 'checks', id: CHECKS_PANEL, child: '.ui-tool-panel-frame' },
  { kind: 'detail', id: REVIEW_VIEW, child: 'main[aria-label="Pull request detail"]' },
  { kind: 'create', id: CREATE_VIEW, child: '[aria-label="Create pull request"]' },
  { kind: 'settings', id: SETTINGS_VIEW, child: 'main[aria-label="Hosting settings"]' }
] as const

type Report = Record<string, unknown>
function isRecord(value: unknown): value is Report {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function mountSurface(harness: ReturnType<typeof makeContext>, id: string, reports: unknown[] = []) {
  activate(harness.context)
  const mount = harness.providers.get(id) as ((element: HTMLElement, props: { report(state: unknown): void }) => (() => void) | void) | undefined
  if (!mount) throw new Error(`activate did not provide ${id}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | void
  await act(async () => {
    cleanup = mount(element, { report: (value) => reports.push(value) })
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  })
  return { element, reports }
}

async function settle() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
}

function latestShellControl(reports: unknown[], id: string): Report {
  for (const report of reports.slice().reverse()) {
    if (!isRecord(report) || !Array.isArray(report.uiControls)) continue
    const control = report.uiControls.find((item) => isRecord(item) && item.surface === id && item.slot === 'shell')
    if (isRecord(control)) return control
  }
  throw new Error(`No shell control was reported for ${id}.`)
}
function latestChecksControl(harness: ReturnType<typeof makeContext>) {
  const control = listReviewsUiControls(harness.context, CHECKS_PANEL).find((item) => item.slot === 'checks')
  if (!control) throw new Error('No Checks control was registered.')
  return control
}

for (const surface of surfaces) {
  test(`${surface.kind} shell reports loading, failed read, exact-window Retry, and recovered child`, async () => {
    const pending = Promise.withResolvers<unknown>()
    const harness = makeContext(42)
    let stateReads = 0
    harness.methods.set('quirky.reviews/state', () => {
      stateReads += 1
      return stateReads === 1 ? pending.promise : reviewsState()
    })
    const reports: unknown[] = []
    const { element } = await mountSurface(harness, surface.id, reports)
    expect(element.querySelector('.ui-notice-line')?.textContent).toContain('Loading review…')
    expect(element.querySelector('.ui-inline-error')).toBeNull()

    await act(async () => {
      pending.reject(new Error('offline fixture'))
      await pending.promise.catch(() => {})
    })
    expect(element.querySelectorAll('.ui-inline-error')).toHaveLength(1)
    expect(element.querySelector('.ui-inline-error')?.textContent).toContain('offline fixture')
    expect(element.querySelector('.ui-notice-line')).toBeNull()

    const control = latestShellControl(reports, surface.id)
    expect(typeof control.target).toBe('string')
    expect(control.generation).toBeGreaterThan(0)
    const retry = element.querySelector<HTMLButtonElement>('.ui-inline-error__action')
    expect(retry?.textContent).toBe('Retry')
    await act(async () => { retry?.click(); await Promise.resolve() })
    await settle()

    expect(stateReads).toBeGreaterThan(1)
    expect(element.querySelector('.ui-inline-error')).toBeNull()
    expect(element.querySelector('.ui-notice-line')).toBeNull()
    expect(element.querySelector(surface.child)).not.toBeNull()
    expect(harness.calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(1)
    expect(harness.calls.find((call) => call.method === 'ui.window.command.run')?.params).toEqual({
      connId: 42,
      id: CONTROL_COMMAND,
      args: { target: control.target, generation: control.generation, action: 'retry' }
    })
    expect(harness.executeCommandCalls()).toBe(0)
  })
}

test('a failed refresh retains the loaded shell child beside the shared error', async () => {
  const originalNow = Date.now
  const originalGlobalSetTimeout = globalThis.setTimeout
  const originalGlobalClearTimeout = globalThis.clearTimeout
  const originalWindowSetTimeout = window.setTimeout
  const originalWindowClearTimeout = window.clearTimeout
  let now = originalNow()
  let nextTimer = 0
  const scheduled = new Map<number, { deadline: number; run(): void }>()
  const schedule = (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = --nextTimer
    scheduled.set(id, {
      deadline: now + Number(delay ?? 0),
      run: () => { if (typeof handler === 'function') handler(...args) }
    })
    return id
  }
  const clearScheduled = (id: unknown) => {
    if (typeof id !== 'number') return false
    return scheduled.delete(id)
  }
  Date.now = () => now
  globalThis.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
    if (delay < 1_000) return Reflect.apply(originalGlobalSetTimeout, globalThis, [handler, delay, ...args])
    return schedule(handler, delay, ...args)
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((id: unknown) => {
    if (!clearScheduled(id)) Reflect.apply(originalGlobalClearTimeout, globalThis, [id])
  }) as typeof globalThis.clearTimeout
  window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
    if (delay < 1_000) return Reflect.apply(originalWindowSetTimeout, window, [handler, delay, ...args])
    return schedule(handler, delay, ...args)
  }) as typeof window.setTimeout
  window.clearTimeout = ((id: unknown) => {
    if (!clearScheduled(id)) Reflect.apply(originalWindowClearTimeout, window, [id])
  }) as typeof window.clearTimeout
  const advanceAutomaticState = async () => {
    now += 3_000
    const due = [...scheduled.entries()].filter(([, timer]) => timer.deadline <= now)
    if (due.length === 0) throw new Error('No automatic Checks state refresh reached its deadline.')
    await act(async () => {
      for (const [id, timer] of due) {
        scheduled.delete(id)
        timer.run()
      }
      await Promise.resolve()
    })
    await settle()
  }
  try {
    const harness = makeContext()
    let stateReads = 0
    harness.methods.set('quirky.reviews/state', () => {
      stateReads += 1
      if (stateReads === 1) return reviewsState()
      throw new Error('later read failed')
    })
    const { element } = await mountSurface(harness, CHECKS_PANEL)
    await settle()
    expect(element.querySelector('.ui-tool-panel-frame')).not.toBeNull()

    await act(async () => { await harness.emitChanged() })
    await advanceAutomaticState()
    expect(element.querySelector('.ui-inline-error')?.textContent).toContain('later read failed')
    expect(element.querySelector('.ui-tool-panel-frame')).not.toBeNull()
    expect(element.querySelector('.ui-notice-line')).toBeNull()
  } finally {
    Date.now = originalNow
    globalThis.setTimeout = originalGlobalSetTimeout
    globalThis.clearTimeout = originalGlobalClearTimeout
    window.setTimeout = originalWindowSetTimeout
    window.clearTimeout = originalWindowClearTimeout
  }
})

test('a retained Checks shell cannot retry a replacement layout worktree through its old descriptor', async () => {
  const harness = makeContext()
  let offline = false
  harness.methods.set('quirky.reviews/state', () => {
    if (offline) throw new Error('offline fixture')
    return reviewsState()
  })
  const reports: unknown[] = []
  await mountSurface(harness, CHECKS_PANEL, reports)
  offline = true
  await act(async () => harness.emitChanged())
  const oldControl = latestShellControl(reports, CHECKS_PANEL)
  await act(async () => harness.selectWorktree('/replacement/tree'))
  const readsBefore = harness.calls.filter((call) => call.method === 'quirky.reviews/state').length
  const handler = harness.providers.get(CONTROL_COMMAND)!
  expect(await handler({ target: oldControl.target, generation: oldControl.generation, action: 'retry' }))
    .toEqual({ delivered: false, reason: 'target-unavailable' })
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/state')).toHaveLength(readsBefore)
  const current = latestShellControl(reports, CHECKS_PANEL)
  expect(current.generation).not.toBe(oldControl.generation)
  expect(JSON.parse(String(current.target))[2]).toBe('/replacement/tree')
})

const fixtureTarget = (id: string) => JSON.stringify([PANEL_SURFACE, 'fixture-child', WORKTREE, REPO, 12, 'a'.repeat(40), null]) + id
function fixtureRegistration(target: string, run: ReviewsUiControlRegistration['run'], actions: ReviewsUiControlRegistration['actions'] = () => [{ action: 'fixture-action', enabled: true }]): ReviewsUiControlRegistration {
  return { surface: PANEL_SURFACE, slot: 'fixture-child', target, actions, run }
}

function validRequest(target: string, generation: number, action = 'fixture-action'): ReviewsUiControlRequest {
  return { target, generation, action }
}

async function invokeExactWindow(harness: ReturnType<typeof makeContext>, args: ReviewsUiControlRequest) {
  return await requestReviewsUiControl(harness.context, args)
}

test('generic activation dispatch publishes synthetic controls and isolates two contexts', async () => {
  const owner = makeContext(41)
  const auxiliary = makeContext(42)
  const ownerReports: unknown[] = []
  const auxiliaryReports: unknown[] = []
  await mountSurface(owner, CHECKS_PANEL, ownerReports)
  await mountSurface(auxiliary, CHECKS_PANEL, auxiliaryReports)
  await settle()

  let liveValue = 'first'
  const invocations: unknown[] = []
  let registration!: { generation: number; dispose(): void }
  await act(async () => {
    registration = registerReviewsUiControl(owner.context, fixtureRegistration(
      fixtureTarget('same'),
      (request, isCurrent) => {
        invocations.push(request)
        return { liveValue, current: isCurrent() }
      }
    ))
  })
  await settle()
  const reported = latestShellControl(ownerReports, PANEL_SURFACE)
  expect(reported.generation).toBeGreaterThan(0)
  const controls = listReviewsUiControls(owner.context, PANEL_SURFACE)
  expect(controls.some((item) => item.slot === 'fixture-child' && item.target === fixtureTarget('same'))).toBe(true)
  expect(ownerReports.some((report) => isRecord(report) && Array.isArray(report.uiControls)
    && report.uiControls.some((item) => isRecord(item) && item.target === fixtureTarget('same')))).toBe(true)
  expect(auxiliaryReports.some((report) => isRecord(report) && Array.isArray(report.uiControls)
    && report.uiControls.some((item) => isRecord(item) && item.target === fixtureTarget('same')))).toBe(false)

  const args = validRequest(fixtureTarget('same'), registration.generation)
  expect(reviewsUiControlDescriptor(args)).toEqual({ command: REVIEWS_UI_CONTROL, args })
  expect(await invokeExactWindow(owner, args)).toEqual({ delivered: true, result: { liveValue: 'first', current: true } })
  liveValue = 'latest ref value'
  expect(await invokeExactWindow(owner, args)).toEqual({ delivered: true, result: { liveValue: 'latest ref value', current: true } })
  expect(invocations).toHaveLength(2)
  expect(owner.calls.filter((call) => call.method === 'ui.window.command.run').at(-1)?.params).toEqual({
    connId: 41, id: CONTROL_COMMAND, args
  })
  expect(owner.executeCommandCalls()).toBe(0)
  expect(await invokeExactWindow(auxiliary, args)).toEqual({ delivered: false, reason: 'target-unavailable' })
  expect(auxiliary.calls.filter((call) => call.method === 'ui.window.command.run').at(-1)?.params.connId).toBe(42)

  await act(async () => registration.dispose())
  await settle()
  expect(listReviewsUiControls(owner.context, PANEL_SURFACE).some((item) => item.target === args.target)).toBe(false)
  const lastReport = ownerReports.at(-1) as Report
  expect(Array.isArray(lastReport.uiControls)).toBe(true)
  expect((lastReport.uiControls as Report[]).some((item) => item.target === args.target)).toBe(false)
})

test('registration changes notify reports without renewing leases and cleanup cannot remove a replacement', async () => {
  const harness = makeContext()
  let notifications = 0
  const unsubscribe = subscribeReviewsUiControls(harness.context, () => { notifications += 1 })
  const target = fixtureTarget('replace')
  const first = registerReviewsUiControl(harness.context, fixtureRegistration(target, (_request, isCurrent) => isCurrent()))
  const firstGeneration = first.generation
  expect(firstGeneration).toBeGreaterThan(0)
  first.changed()
  expect(notifications).toBe(2)

  const replacement = registerReviewsUiControl(harness.context, fixtureRegistration(target, (_request, isCurrent) => isCurrent()))
  expect(replacement.generation).toBeGreaterThan(firstGeneration)
  first.dispose()
  expect(listReviewsUiControls(harness.context, PANEL_SURFACE).find((item) => item.target === target)?.generation).toBe(replacement.generation)
  expect(await runReviewsUiControl(harness.context, validRequest(target, firstGeneration))).toEqual({ delivered: false, reason: 'target-unavailable' })
  expect(await runReviewsUiControl(harness.context, validRequest(target, replacement.generation))).toEqual({ delivered: true, result: true })
  replacement.dispose()
  expect(await runReviewsUiControl(harness.context, validRequest(target, replacement.generation))).toEqual({ delivered: false, reason: 'target-unavailable' })
  unsubscribe()
})

test('a delivered control may dispose its own session without losing acknowledgement', async () => {
  const harness = makeContext()
  activate(harness.context)
  let dispose = () => {}
  const target = fixtureTarget('self-disposing')
  const lease = registerReviewsUiControl(harness.context, fixtureRegistration(target, () => {
    dispose()
    return 'session closed'
  }))
  dispose = lease.dispose
  const handler = harness.providers.get(CONTROL_COMMAND)!
  expect(await handler(validRequest(target, lease.generation))).toEqual({ delivered: true, result: 'session closed' })
  expect(await handler(validRequest(target, lease.generation))).toEqual({ delivered: false, reason: 'target-unavailable' })
})

test('A to B to A registrations receive fresh generations and disabled or unknown actions do not run', async () => {
  const harness = makeContext()
  const ran: string[] = []
  const targetA = fixtureTarget('A')
  const targetB = fixtureTarget('B')
  const firstA = registerReviewsUiControl(harness.context, fixtureRegistration(targetA, () => { ran.push('first-A') }))
  const oldA = validRequest(targetA, firstA.generation)
  firstA.dispose()
  const b = registerReviewsUiControl(harness.context, fixtureRegistration(targetB, () => { ran.push('B') }))
  b.dispose()
  const lastA = registerReviewsUiControl(harness.context, fixtureRegistration(targetA, () => { ran.push('last-A') }))
  expect(lastA.generation).toBeGreaterThan(firstA.generation)
  expect(await runReviewsUiControl(harness.context, oldA)).toEqual({ delivered: false, reason: 'target-unavailable' })

  expect(await runReviewsUiControl(harness.context, validRequest(targetA, lastA.generation, 'unknown'))).toEqual({ delivered: false, reason: 'unknown-action' })
  const disabled = registerReviewsUiControl(harness.context, fixtureRegistration(
    fixtureTarget('disabled'), () => { ran.push('disabled') }, () => [{ action: 'fixture-action', enabled: false }]
  ))
  expect(await runReviewsUiControl(harness.context, validRequest(fixtureTarget('disabled'), disabled.generation))).toEqual({ delivered: false, reason: 'disabled' })
  expect(ran).toEqual([])
})

test('malformed control arguments reject instead of being treated as an unavailable target', async () => {
  const harness = makeContext()
  const invalid: unknown[] = [
    null,
    [],
    {},
    { target: '', generation: 1, action: 'fixture-action' },
    { target: 'fixture', generation: 0, action: 'fixture-action' },
    { target: 'fixture', generation: Number.MAX_SAFE_INTEGER + 1, action: 'fixture-action' },
    { target: 'fixture', generation: 1.5, action: 'fixture-action' },
    { target: 'fixture', generation: 1, action: '' },
    { target: 'fixture', generation: 1, action: 'fixture-action', value: [] },
    { target: 'fixture', generation: 1, action: 'fixture-action', extra: true }
  ]
  for (const input of invalid) await expect(runReviewsUiControl(harness.context, input)).rejects.toThrow()
})

for (const delayedMethod of ['ui.window.self', 'ui.window.command.run'] as const) {
  test(`a target replaced while ${delayedMethod} is pending cannot receive the stale command`, async () => {
    const harness = makeContext(42)
    activate(harness.context)
    const target = fixtureTarget(delayedMethod)
    let mutations = 0
    const old = registerReviewsUiControl(harness.context, fixtureRegistration(target, (_request, isCurrent) => {
      if (isCurrent()) mutations += 1
      return 'old'
    }))
    const args = validRequest(target, old.generation)
    const bridge = Promise.withResolvers<unknown>()
    const started = Promise.withResolvers<void>()
    harness.methods.set(delayedMethod, async (params) => {
      started.resolve()
      const value = await bridge.promise
      if (delayedMethod === 'ui.window.self') return value
      const handler = harness.providers.get(CONTROL_COMMAND)!
      return { result: await handler(params.args) }
    })

    const pending = invokeExactWindow(harness, args)
    if (delayedMethod === 'ui.window.command.run') await started.promise
    old.dispose()
    registerReviewsUiControl(harness.context, fixtureRegistration(target, () => { mutations += 1; return 'replacement' }))
    if (delayedMethod === 'ui.window.self') bridge.resolve({ connId: 42 })
    else bridge.resolve(undefined)

    expect(await pending).toEqual({ delivered: false, reason: 'target-unavailable' })
    expect(mutations).toBe(0)
  })
}

test('the existing copy-text command uses the shared validated local clipboard helper', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  try {
    await expect(copyReviewsText('local helper text')).resolves.toBeUndefined()
    const harness = makeContext()
    activate(harness.context)
    const copy = harness.providers.get('command:quirky.reviews/copy-text')!
    expect(await copy({ text: 'existing command text' })).toEqual({ copied: true })
    expect(writes).toEqual(['local helper text', 'existing command text'])
    await expect(copy({ text: 'x'.repeat(1_048_577) })).rejects.toThrow('Invalid clipboard text.')
    expect(writes).toHaveLength(2)
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

for (const [label, update, selector, message] of [
  ['initial lookup loading', (state: ReviewsState) => { state.checks.review = null; state.checks.loading = true }, '.ui-notice-line', 'Checking pull request status…'],
  ['eligible branch without review', (state: ReviewsState) => { state.checks.review = null; state.checks.lookup = { kind: 'no-review', gitStatus: { branch: 'feature', head: review.headRefOid } }; state.checks.eligibility = { eligible: true, worktree: WORKTREE, confirmedAt: Date.now(), head: 'feature', headOid: review.headRefOid } }, '.ui-empty-state', 'No pull request found'],
  ['lookup failure', (state: ReviewsState) => { state.checks.review = null; state.checks.lookup = { kind: 'unavailable', reason: 'lookup_unavailable', message: 'lookup fixture failed' } }, '.ui-inline-error', 'lookup fixture failed'],
  ['retained review failure', (state: ReviewsState) => { state.checks.error = 'retained fixture failed' }, '.ui-inline-error', 'Showing the last known review status.'],
  ['stack failure', (state: ReviewsState) => { state.checks.review = { ...state.checks.review!, stack: { available: false, reason: 'stack_unavailable', message: 'loading provider fixture failed' } } }, '.ui-inline-error', 'loading provider fixture failed'],
  ['stack mismatch', (state: ReviewsState) => { state.checks.review = { ...state.checks.review!, stack: { available: false, reason: 'stack_mismatch' } } }, '.ui-inline-error', 'The provider stack did not match the selected pull request.'],
  ['incomplete canonical stack', (state: ReviewsState) => { state.checks.review = { ...state.checks.review!, stack: { available: true, entries: [] } } }, '.ui-inline-error', 'The canonical stack response is incomplete.'],
  ['pending canonical stack', (state: ReviewsState) => { state.checks.review = { ...state.checks.review!, stack: { number: 1, position: 1, size: 2 } } }, '.ui-notice-line', 'Loading the canonical stack member list…'],
  ['conflict lookup loading', (state: ReviewsState) => { state.checks.review = { ...state.checks.review!, mergeable: 'CONFLICTING' }; state.checks.conflicts = { status: 'loading' } }, '.ui-notice-line', 'Loading conflict paths…'],
] as const) {
  test(`the activated Checks surface uses a shared state for ${label}`, async () => {
    const state = reviewsState()
    update(state)
    const harness = makeContext(42)
    harness.methods.set('quirky.reviews/state', () => state)
    const { element } = await mountSurface(harness, CHECKS_PANEL)
    await settle()
    const messages = [...element.querySelectorAll(selector)].map((node) => node.textContent).join(' ')
    expect(messages).toContain(message)
    if (label === 'eligible branch without review') expect([...element.querySelectorAll('button')].find((button) => button.textContent === 'Create PR')?.disabled).toBe(false)
    if (label === 'lookup failure') expect([...element.querySelectorAll('button')].some((button) => button.textContent === 'Create PR')).toBe(false)
    if (label === 'retained review failure') expect(element.textContent).toContain('Review 12')
  })
}

function checksWithoutReview(diagnostics: Record<string, unknown>, provider?: string): ReviewsState {
  const state = reviewsState()
  state.checks.review = null
  state.checks.lookup = {
    kind: 'unsupported',
    reason: 'not_authenticated',
    ...(provider ? { provider } : {}),
    authDiagnostics: diagnostics,
  }
  state.checks.eligibility = {
    eligible: false,
    reason: 'authentication_required',
    ...(provider ? { provider } : {}),
    authDiagnostics: diagnostics,
  }
  return state
}

test('Checks scopes unavailable GitHub CLI feedback and preserves exact-window copy and Retry', async () => {
  const account = { user: 'fixture-user', host: 'github.example.test', source: 'fixture', active: true }
  const state = checksWithoutReview({
    ghAvailable: false,
    requiredHost: 'github.example.test',
    activeAccount: account,
    accounts: [account],
  })
  const harness = makeContext(42)
  harness.methods.set('quirky.reviews/state', () => state)
  harness.methods.set('quirky.hosting/refresh', () => ({ kind: 'queued' }))
  harness.methods.set('quirky.reviews/checksRefresh', () => ({ ok: true }))
  const { element } = await mountSurface(harness, CHECKS_PANEL)
  await settle()

  const accountStatus = element.querySelector<HTMLElement>('[aria-label="GitHub account status"]')
  expect(accountStatus).not.toBeNull()
  const errors = accountStatus!.querySelectorAll('.ui-inline-error__message')
  expect(errors).toHaveLength(1)
  expect(errors[0]?.textContent).toBe('GitHub CLI (gh) is unavailable. Install it, then retry.')
  expect(accountStatus!.textContent).toContain('Required host: github.example.test')
  expect(accountStatus!.textContent).toContain('fixture-user · github.example.test · fixture · active')

  const copy = [...accountStatus!.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Copy gh auth status')
  const retry = [...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Retry')
  expect(copy?.disabled).toBe(false)
  expect(retry?.disabled).toBe(false)

  const control = latestChecksControl(harness)
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text) } },
  })
  try {
    await act(async () => { copy!.click() })
    await settle()
    expect(copied).toEqual(['gh auth status'])

    await act(async () => { retry!.click() })
    await settle()
    expect(harness.calls.filter((call) => call.method === 'ui.window.command.run').map((call) => call.params)).toEqual([
      {
        connId: 42,
        id: CONTROL_COMMAND,
        args: {
          target: control.target,
          generation: control.generation,
          action: 'copy-link',
          value: { source: 'auth-status' },
        },
      },
      {
        connId: 42,
        id: CONTROL_COMMAND,
        args: {
          target: control.target,
          generation: control.generation,
          action: 'refresh',
        },
      },
    ])
    expect(harness.calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(2)
    expect(harness.executeCommandCalls()).toBe(0)
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

for (const fixture of [
  {
    label: 'GitHub with an available CLI',
    provider: undefined,
    diagnostics: {
      ghAvailable: true,
      requiredHost: 'github.example.test',
      activeAccount: { user: 'fixture-user', host: 'github.example.test', source: 'fixture', active: true },
      accounts: [{ user: 'fixture-user', host: 'github.example.test', source: 'fixture', active: true }],
    },
    section: 'GitHub account status',
    copy: 'Copy gh auth status',
  },
  {
    label: 'GitLab diagnostics',
    provider: 'gitlab',
    diagnostics: {
      provider: 'gitlab',
      ghAvailable: false,
      requiredHost: 'gitlab.example.test',
      activeAccount: { user: 'fixture-user', host: 'gitlab.example.test', source: 'fixture', active: true },
      accounts: [{ user: 'fixture-user', host: 'gitlab.example.test', source: 'fixture', active: true }],
    },
    section: 'GitLab account status',
    copy: 'Copy glab auth status',
  },
] as const) {
  test(`Checks omits the GitHub CLI alert for ${fixture.label}`, async () => {
    const state = checksWithoutReview(fixture.diagnostics, fixture.provider)
    const harness = makeContext()
    harness.methods.set('quirky.reviews/state', () => state)
    const { element } = await mountSurface(harness, CHECKS_PANEL)
    await settle()

    const accountStatus = element.querySelector<HTMLElement>(`[aria-label="${fixture.section}"]`)
    expect(accountStatus).not.toBeNull()
    expect(accountStatus!.querySelectorAll('.ui-inline-error__message')).toHaveLength(0)
    expect(accountStatus!.textContent).toContain(fixture.diagnostics.requiredHost)
    expect(accountStatus!.textContent).toContain(`${fixture.diagnostics.accounts[0]!.user} · ${fixture.diagnostics.accounts[0]!.host} · ${fixture.diagnostics.accounts[0]!.source} · active`)
    const copyButton = [...accountStatus!.querySelectorAll('button')].find((button) => button.textContent?.trim() === fixture.copy)
    expect(copyButton).not.toBeUndefined()
    if (fixture.provider === 'gitlab') {
      const control = latestChecksControl(harness)
      const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      const copied: string[] = []
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { copied.push(text) } },
      })
      try {
        await act(async () => { copyButton!.click() })
        await settle()
        expect(copied).toEqual(['glab auth status'])
        expect(harness.calls.filter((call) => call.method === 'ui.window.command.run').map((call) => call.params)).toEqual([
          {
            connId: 41,
            id: CONTROL_COMMAND,
            args: {
              target: control.target,
              generation: control.generation,
              action: 'copy-link',
              value: { source: 'auth-status' },
            },
          },
        ])
        expect(harness.calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(1)
        expect(harness.executeCommandCalls()).toBe(0)
      } finally {
        if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
        else Reflect.deleteProperty(navigator, 'clipboard')
      }
    }
  })
}

for (const fixture of [
  {
    label: 'a provider-conflicting review with a supplied preview message',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    message: 'preview fixture failed',
    expectedMessage: 'preview fixture failed',
  },
  {
    label: 'a local unavailable preview without a string message',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    message: null,
    expectedMessage: 'Conflict paths are unavailable from the read-only preview.',
  },
] as const) {
  test(`Checks renders one shared error and retains conflict data for ${fixture.label}`, async () => {
    const state = reviewsState()
    state.checks.review = { ...state.checks.review!, mergeable: fixture.mergeable, mergeStateStatus: fixture.mergeStateStatus }
    state.checks.conflicts = {
      status: 'unavailable',
      message: fixture.message,
      files: [{ path: 'provider.ts' }],
      localFiles: [{ path: 'local.ts' }],
      truncated: true,
    }
    const harness = makeContext(42)
    harness.methods.set('quirky.reviews/state', () => state)
    harness.methods.set('quirky.reviews/checksSetAgentDialog', () => ({ ok: true }))
    const { element } = await mountSurface(harness, CHECKS_PANEL)
    await settle()

    const conflicts = element.querySelector<HTMLElement>('[aria-label="Merge conflicts"]')
    expect(conflicts).not.toBeNull()
    expect(conflicts!.querySelectorAll('.ui-inline-error')).toHaveLength(1)
    const messages = conflicts!.querySelectorAll('.ui-inline-error__message')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.textContent).toBe(fixture.expectedMessage)
    expect(conflicts!.querySelector('.ui-notice-line')).toBeNull()
    expect(element.textContent).toContain('Review 12')
    expect(conflicts!.textContent).toContain('provider.ts')
    expect(conflicts!.textContent).toContain('Active workspace conflicts')
    expect(conflicts!.textContent).toContain('local.ts')
    expect(conflicts!.textContent).toContain('Conflict file list is truncated at 100 entries.')

    if (fixture.mergeable === 'CONFLICTING') {
      const resolve = [...element.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Resolve')
      expect(resolve?.disabled).toBe(false)
      const control = latestChecksControl(harness)
      await act(async () => { resolve!.click() })
      await settle()
      expect(harness.calls.filter((call) => call.method === 'ui.window.command.run').map((call) => call.params)).toEqual([
        {
          connId: 42,
          id: CONTROL_COMMAND,
          args: {
            target: control.target,
            generation: control.generation,
            action: 'agent-open',
            value: { action: 'conflicts' },
          },
        },
      ])
      expect(harness.calls.find((call) => call.method === 'quirky.reviews/checksSetAgentDialog')?.params).toEqual({
        surface: 'checks',
        worktree: WORKTREE,
        action: 'conflicts',
      })
      expect(harness.executeCommandCalls()).toBe(0)
    }
  })
}

test('Checks keeps conflict loading in NoticeLine rather than error styling', async () => {
  const state = reviewsState()
  state.checks.review = { ...state.checks.review!, mergeable: 'CONFLICTING' }
  state.checks.conflicts = { status: 'loading' }
  const harness = makeContext()
  harness.methods.set('quirky.reviews/state', () => state)
  const { element } = await mountSurface(harness, CHECKS_PANEL)
  await settle()

  const conflicts = element.querySelector<HTMLElement>('[aria-label="Merge conflicts"]')
  expect(conflicts).not.toBeNull()
  expect(conflicts!.querySelectorAll('.ui-notice-line')).toHaveLength(1)
  expect(conflicts!.querySelector('.ui-notice-line')?.textContent).toBe('Loading conflict paths…')
  expect(conflicts!.querySelector('.ui-inline-error')).toBeNull()
})

test('Checks keeps ready preview advice and paths as loaded content', async () => {
  const state = reviewsState()
  state.checks.review = { ...state.checks.review!, mergeable: 'CONFLICTING' }
  state.checks.conflicts = {
    status: 'ready', available: true, conflicting: false,
    files: [{ path: 'provider.ts' }], localFiles: [{ path: 'local.ts' }],
  }
  const harness = makeContext()
  harness.methods.set('quirky.reviews/state', () => state)
  const { element } = await mountSurface(harness, CHECKS_PANEL)
  await settle()
  const conflicts = element.querySelector<HTMLElement>('[aria-label="Merge conflicts"]')!
  expect(conflicts.textContent).toContain('Git’s read-only preview found no conflicting paths; refresh the review metadata before merging.')
  expect(conflicts.textContent).toContain('provider.ts')
  expect(conflicts.textContent).toContain('local.ts')
  expect(conflicts.querySelector('.ui-inline-error')).toBeNull()
  expect(conflicts.querySelector('.ui-notice-line')).toBeNull()
})

function agentState(): ReviewsState {
  const state = reviewsState()
  state.checks.agentDialog = {
    visible: true, surface: 'checks', target: { worktree: WORKTREE, number: 12, prRepo: REPO },
    headOid: review.headRefOid, action: 'fix', prompt: 'Fix the fixture check.'
  }
  return state
}

for (const catalog of ['pending', 'empty', 'failed'] as const) {
  test(`the activated agent dialog distinguishes a ${catalog} catalog`, async () => {
    const harness = makeContext()
    harness.methods.set('quirky.reviews/state', agentState)
    harness.methods.set('quirky.agents/list', () => catalog === 'pending' ? new Promise(() => {}) : catalog === 'failed' ? Promise.reject(new Error('catalog fixture failed')) : { agents: [] })
    const { element } = await mountSurface(harness, CHECKS_PANEL)
    await settle()
    const scope = document.querySelector('[role="dialog"]') ?? element
    const selector = catalog === 'pending' ? '.ui-notice-line' : catalog === 'empty' ? '.ui-empty-state' : '.ui-inline-error'
    expect(scope.querySelector(selector)?.textContent).toContain(catalog === 'pending' ? 'Detecting agents…' : catalog === 'empty' ? 'No enabled agents' : 'catalog fixture failed')
    const start = [...scope.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Start agent')
    expect(start?.disabled).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toEqual([])
  })
}

test('the reported agent command settles its draft once and rejects a concurrent launch', async () => {
  const harness = makeContext(42)
  harness.methods.set('quirky.reviews/state', agentState)
  harness.methods.set('quirky.agents/list', () => ({ agents: [{ id: 'fixture', enabled: true, installed: true }], defaultAgent: 'fixture' }))
  const draft = Promise.withResolvers<unknown>()
  harness.methods.set('quirky.reviews/checksSetAgentDialog', () => draft.promise)
  harness.methods.set('quirky.reviews/checksLaunchAgent', () => ({ delivered: false, error: 'delivery fixture failed' }))
  await mountSurface(harness, CHECKS_PANEL)
  await settle()
  const control = listReviewsUiControls(harness.context, CHECKS_PANEL).find((control) => control.slot === 'agent')!
  expect(control).toBeDefined()
  const request = { target: control.target, generation: control.generation, action: 'agent-start' }
  const handler = harness.providers.get(CONTROL_COMMAND)!
  let first!: Promise<unknown>
  await act(async () => {
    first = Promise.resolve(handler(request))
    expect(await handler(request)).toEqual({ delivered: false, reason: 'disabled' })
  })
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksLaunchAgent')).toEqual([])
  expect(await handler(request)).toEqual({ delivered: false, reason: 'disabled' })
  expect(harness.calls.filter((call) => call.method === 'quirky.reviews/checksSetAgentDialog')).toHaveLength(1)
  await act(async () => { draft.resolve({ ok: true }); await first })
  const launches = harness.calls.filter((call) => call.method === 'quirky.reviews/checksLaunchAgent')
  expect(launches).toHaveLength(1)
  expect(launches[0]?.params).toMatchObject({ worktree: WORKTREE, agent: 'fixture' })
  expect(document.querySelector('.ui-inline-error')?.textContent).toContain('delivery fixture failed')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

afterEach(async () => {
  await act(async () => { for (const cleanup of cleanups.splice(0)) cleanup() })
  document.body.innerHTML = ''
})

afterAll(() => GlobalRegistrator.unregister())

test('Checks without a selected workspace renders genuine absence', async () => {
  const harness = makeContext(41, null)
  const { element } = await mountSurface(harness, CHECKS_PANEL)
  expect(element.querySelector('.ui-empty-state')?.textContent).toContain('Select a workspace to view checks.')
  expect(element.querySelector('.ui-notice-line')).toBeNull()
})

for (const surface of surfaces) {
  test(`${surface.kind} shell rejects invalid state and recovers through its reported Retry`, async () => {
    const harness = makeContext(42)
    let reads = 0
    harness.methods.set('quirky.reviews/state', () => ++reads === 1 ? {} : reviewsState())
    const reports: unknown[] = []
    const { element } = await mountSurface(harness, surface.id, reports)
    expect(element.querySelectorAll('.ui-inline-error')).toHaveLength(1)
    expect(element.querySelector('.ui-inline-error')?.textContent).toContain('The daemon returned invalid review state.')
    expect(element.querySelector('.ui-notice-line')).toBeNull()
    const descriptor = latestShellControl(reports, surface.id)
    await act(async () => {
      expect(await requestReviewsUiControl(harness.context, { target: String(descriptor.target), generation: Number(descriptor.generation), action: 'retry' })).toEqual({ delivered: true })
    })
    expect(reads).toBeGreaterThan(1)
    expect(element.querySelector('.ui-inline-error')).toBeNull()
    expect(element.querySelector(surface.child)).not.toBeNull()
  })
}
