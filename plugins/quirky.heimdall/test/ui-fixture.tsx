import { afterAll, afterEach, beforeAll, expect } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { MountCleanup, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { FleetRow, FleetSnapshot, WatcherDetail, WatcherTarget } from '../src/control-contracts'
import type { Enrollment, JournalEntry, TickTrace } from '../src/contracts'
import { UI_CONTROL_COMMAND, type FleetControlArgs, type FleetControlResult } from '../src/ui-control'

export const FLEET_VIEW_ID = 'view:quirky.heimdall/fleet'
export const NAVIGATION_ID = 'sidebar-section:quirky.heimdall/navigation'
export const SESSION_VIEW_ID = 'view:quirky.session/worktree'
export const FLEET_METHOD = 'quirky.heimdall/fleet'
export const DETAIL_METHOD = 'quirky.heimdall/detail'
export const COMMAND_METHOD = 'quirky.heimdall/command'
export const DESCRIBE_METHOD = 'quirky.heimdall/describeCommand'
export const DEBUG_METHOD = 'quirky.heimdall/debugReport'

type Response = (params: Record<string, unknown>) => unknown | Promise<unknown>
type Mount = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => MountCleanup | void
type ViewCall = { id: string; input: unknown; updateInput?: boolean }
type MethodCall = { method: string; params: Record<string, unknown> }
type Toast = { title: string; body: string; kind?: string }
type Report = {
  view: 'fleet' | 'detail'
  instance: string
  generation: string | null
  target: WatcherTarget | null
  budgetEditor: 'open' | 'closed' | 'unavailable'
  budgetEditorRevision: number | null
  concurrencyDraft: 'clean' | 'changed' | 'unavailable'
  concurrencyRevision: number | null
}
type MountedView = { element: HTMLElement; cleanup: MountCleanup; report: unknown[] }

export type Fixture = {
  context: UiPluginContext
  provided: Map<string, unknown>
  calls: MethodCall[]
  views: ViewCall[]
  toasts: Toast[]
  confirms: { title: string; body?: string; confirmLabel?: string }[]
  reports: unknown[]
  clipboardWrites: string[]
  mounted: MountedView[]
  handlers: Map<string, Response>
  setHandler(method: string, handler: Response): void
  enqueue(method: string, ...responses: unknown[]): void
  emitSnapshot(snapshot: FleetSnapshot): void
  reconnect(): void
  answerConfirm(value: boolean): void
  answerNextSelf(value: unknown | Error): void
  holdNextSelf(): { promise: Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void }
  control(args: FleetControlArgs): Promise<FleetControlResult>
  mount(id?: string, input?: unknown): Promise<MountedView>
  mountFleet(input?: unknown): Promise<MountedView>
  mountNavigation(): Promise<MountedView>
  cleanup(): Promise<void>
  callsFor(method: string): MethodCall[]
}

export type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let activate: ((context: UiPluginContext) => void) | undefined
let previousActEnvironment: unknown
let hadActEnvironment = false
beforeAll(async () => {
  GlobalRegistrator.register()
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  hadActEnvironment = Object.prototype.hasOwnProperty.call(reactGlobal, 'IS_REACT_ACT_ENVIRONMENT')
  previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
  // React DOM must bind to Happy DOM globals before ui.tsx is imported.
  ;({ activate } = await import('../src/ui'))
})
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  document.body.innerHTML = ''
})

afterAll(async () => {
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  if (hadActEnvironment) reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment as boolean
  else delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

const fixtures: Fixture[] = []

function enrollment(watcherId: string, kind: 'hosted-review' | 'objective' = 'hosted-review', overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    watcherId,
    kind,
    workspaceKey: 'workspace',
    workspacePath: '/workspace',
    executionHostId: 'host',
    schedulerOwner: 'scheduler',
    kindPayload: kind === 'objective' ? { maxConcurrency: 4 } : {},
    enabled: true,
    paused: false,
    commandRevision: 1,
    capabilities: {},
    budget: { wallClockActiveMs: 90_000, turns: 4 },
    coordinator: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 10,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null,
    ...overrides
  }
}

export function makeRow(watcherId: string, overrides: Partial<FleetRow> = {}): FleetRow {
  const target = overrides.target ?? { watcherId }
  return {
    target,
    ownerFence: overrides.ownerFence ?? { executionHostId: 'host', schedulerOwner: 'scheduler', workspaceKey: 'workspace', revision: 1 },
    enrollment: overrides.enrollment ?? enrollment(watcherId),
    status: overrides.status ?? { state: 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
    name: overrides.name ?? `Watcher ${watcherId}`,
    workspaceName: overrides.workspaceName ?? 'Workspace',
    branch: overrides.branch === undefined ? 'main' : overrides.branch,
    phase: overrides.phase ?? null,
    ownerContact: overrides.ownerContact ?? 'live',
    observedAtMs: overrides.observedAtMs ?? 10_000,
    lastSuccessfulTickAtMs: overrides.lastSuccessfulTickAtMs ?? null,
    budget: overrides.budget ?? { activeMs: 30_000, turns: 1, exhausted: null },
    runningWorkers: overrides.runningWorkers ?? 0,
    maxConcurrency: overrides.maxConcurrency === undefined ? null : overrides.maxConcurrency,
    openEscalations: overrides.openEscalations ?? [],
    pendingQuestion: overrides.pendingQuestion ?? false,
    ...overrides
  }
}

export function makeSnapshot(rows: FleetRow[] = [], generatedAtMs = 1): FleetSnapshot {
  return {
    generatedAtMs,
    rows,
    actionHistory: [],
    buckets: { needsYou: 0, lostContact: 0, active: rows.length, inactive: 0 },
    activeCount: rows.length,
    attentionCount: 0
  }
}

export function makeDetail(watcherId: string, overrides: Partial<WatcherDetail> = {}): WatcherDetail {
  const target = overrides.target ?? { watcherId }
  const currentEnrollment = overrides.enrollment ?? enrollment(watcherId)
  return {
    readOnly: false,
    enrollment: currentEnrollment,
    status: { state: 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
    journal: [] as JournalEntry[],
    traces: [] as TickTrace[],
    summary: null,
    budget: { activeMs: 30_000, turns: 1, exhausted: null },
    target,
    ownerFence: { executionHostId: 'host', schedulerOwner: 'scheduler', workspaceKey: 'workspace', revision: currentEnrollment.commandRevision },
    ownerContact: 'live',
    observedAtMs: 10_000,
    name: `Watcher ${watcherId}`,
    workers: [],
    openEscalations: [],
    pendingControls: [],
    ...overrides
  }
}

export function makeFixture(): Fixture {
  const provided = new Map<string, unknown>()
  const calls: MethodCall[] = []
  const views: ViewCall[] = []
  const toasts: Toast[] = []
  const confirms: { title: string; body?: string; confirmLabel?: string }[] = []
  const reports: unknown[] = []
  const clipboardWrites: string[] = []
  const mounted: MountedView[] = []
  const handlers = new Map<string, Response>()
  const queued = new Map<string, unknown[]>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const confirmQueue: Deferred<boolean>[] = []
  const selfQueue: (unknown | Error | Deferred<unknown>)[] = []
  let activated = false
  let previousClipboardForFixture: PropertyDescriptor | undefined
  let clipboardCaptured = false
  const context = {
    pluginId: 'quirky.heimdall',
    provide(id: string, handler: unknown) { provided.set(id, handler) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.window.self') {
        const next = selfQueue.shift()
        if (next instanceof Error) throw next
        if (next && typeof next === 'object' && 'promise' in next) return (next as Deferred<unknown>).promise
        return next ?? { connId: 7 }
      }
      if (method === 'ui.window.command.run') {
        const pendingRun = queued.get(method)
        if (pendingRun?.length) {
          const next = pendingRun.shift()
          if (next instanceof Error) throw next
          if (typeof next === 'function') return (next as Response)(params)
          return next
        }
        const id = params.id
        if (typeof id !== 'string') throw new Error('Missing routed command ID')
        const handler = provided.get(id)
        if (typeof handler !== 'function') throw new Error(`Missing routed command: ${id}`)
        const result = await (handler as (args: unknown) => unknown)(params.args)
        return { result }
      }
      const pending = queued.get(method)
      if (pending?.length) {
        const next = pending.shift()
        if (next instanceof Error) throw next
        if (typeof next === 'function') return (next as Response)(params)
        return next
      }
      const handler = handlers.get(method)
      if (handler) return handler(params)
      if (method === FLEET_METHOD) return makeSnapshot()
      if (method === DETAIL_METHOD) return null
      if (method === DESCRIBE_METHOD) return 'Delete this watcher?'
      if (method === COMMAND_METHOD) return { kind: 'applied', appliedAtMs: Date.now() }
      if (method === DEBUG_METHOD) return { watcherId: 'debug' }
      if (method === 'quirky.session/get') return { worktreeId: 'worktree' }
      throw new Error(`Unexpected RPC method: ${method}`)
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onConnection(listener: (status: 'connected' | 'reconnecting') => void) {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
    openView(id: string, input?: unknown) {
      const opened: ViewCall = { id, input }
      views.push(opened)
      if (id !== FLEET_VIEW_ID) return
      const current = mounted.filter((item) => item.cleanup.updateInput).at(-1)
      if (!current) return
      const accepted = current.cleanup.updateInput?.(input) ?? false
      opened.updateInput = accepted
      if (!accepted) {
        current.cleanup()
        const index = mounted.indexOf(current)
        if (index >= 0) mounted.splice(index, 1)
        const element = current.element
        const implementation = provided.get(id)
        if (typeof implementation !== 'function') throw new Error(`Missing contribution ${id}`)
        const reportsForMount: unknown[] = []
        const cleanup = (implementation as Mount)(element, { input, report: (state) => { reportsForMount.push(state); reports.push(state) } })
        if (typeof cleanup !== 'function') throw new Error(`Contribution ${id} did not return cleanup`)
        mounted.push({ element, cleanup, report: reportsForMount })
      }
    },
    closeView() { views.push({ id: 'closeView', input: undefined }) },
    confirm(options: { title: string; body?: string; confirmLabel?: string }) {
      confirms.push(options)
      const result = deferred<boolean>()
      confirmQueue.push(result)
      return result.promise
    },
    toast(title: string, body: string, options?: { kind?: string }) {
      toasts.push({ title, body, kind: options?.kind })
    }
  } as unknown as UiPluginContext

  const fixture: Fixture = {
    context,
    provided,
    calls,
    views,
    toasts,
    confirms,
    reports,
    clipboardWrites,
    mounted,
    handlers,
    setHandler(method, handler) { handlers.set(method, handler) },
    enqueue(method, ...responses) { queued.set(method, [...(queued.get(method) ?? []), ...responses]) },
    emitSnapshot(snapshot) {
      const event = { type: 'quirky.heimdall/fleetChanged', data: snapshot } as QuirkyEvent
      for (const listener of [...listeners]) void listener(event)
    },
    reconnect() { for (const listener of [...connectionListeners]) listener('connected') },
    answerConfirm(value) {
      const next = confirmQueue.shift()
      if (!next) throw new Error('No confirmation is pending')
      next.resolve(value)
    },
    answerNextSelf(value) { selfQueue.push(value) },
    holdNextSelf() {
      const result = deferred<unknown>()
      selfQueue.push(result)
      return result
    },
    async control(args) {
      const response = await context.call('ui.window.command.run', { connId: 7, id: UI_CONTROL_COMMAND, args })
      return (response as { result: FleetControlResult }).result
    },
    async mount(id = FLEET_VIEW_ID, input) {
      if (!activated) {
        if (!activate) throw new Error('UI module was not initialized')
        activate(context)
        activated = true
      }
      const implementation = provided.get(id)
      if (typeof implementation !== 'function') throw new Error(`Missing contribution ${id}`)
      const element = document.createElement('div')
      document.body.append(element)
      const mountReports: unknown[] = []
      let cleanup: MountCleanup | undefined
      await act(async () => {
        const dispose = (implementation as Mount)(element, { input, report: (state) => { mountReports.push(state); reports.push(state) } })
        if (typeof dispose === 'function') cleanup = dispose
      })
      if (!cleanup) throw new Error(`Contribution ${id} did not return cleanup`)
      const mountedView = { element, cleanup, report: mountReports }
      mounted.push(mountedView)
      if (!clipboardCaptured) {
        previousClipboardForFixture = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
        clipboardCaptured = true
      }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { clipboardWrites.push(text) } }
      })
      return mountedView
    },
    mountFleet(input) { return fixture.mount(FLEET_VIEW_ID, input) },
    mountNavigation() { return fixture.mount(NAVIGATION_ID) },
    async cleanup() {
      const disposals = mounted.splice(0)
      await act(async () => {
        for (const item of disposals) {
          item.cleanup()
          item.element.remove()
        }
        await Promise.resolve()
      })
      if (clipboardCaptured) {
        if (previousClipboardForFixture) Object.defineProperty(navigator, 'clipboard', previousClipboardForFixture)
        else Reflect.deleteProperty(navigator, 'clipboard')
      }
      previousClipboardForFixture = undefined
      clipboardCaptured = false
    },
    callsFor(method) { return calls.filter((entry) => entry.method === method) }
  }
  fixtures.push(fixture)
  return fixture
}

export async function settleUi(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

export function button(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll('button')].find((entry) =>
    (entry.getAttribute('aria-label') ?? entry.textContent?.trim()) === label
  )
  if (!match) throw new Error(`Button not found: ${label}`)
  return match as HTMLButtonElement
}

export async function click(root: ParentNode, label: string): Promise<void> {
  await act(async () => { button(root, label).click() })
  await settleUi()
}

export async function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export async function flush(): Promise<void> {
  await settleUi()
}

export function latestReport(fixture: Fixture): Report {
  const report = fixture.reports.at(-1)
  if (!report || typeof report !== 'object') throw new Error('No mounted view report')
  return report as Report
}

export function expectNoInlineError(root: ParentNode): void {
  expect(root.querySelector('.ui-inline-error')).toBeNull()
}
