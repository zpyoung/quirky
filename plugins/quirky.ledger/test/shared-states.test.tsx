import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type {
  LedgerCandidate,
  LedgerControl,
  LedgerEntry,
  LedgerOperation,
  LedgerOwner,
  LedgerOwnerOption,
  LedgerRequest,
  LedgerResponse,
  LedgerSummary
} from '../src/ui/types'

const VIEW_ID = 'view:quirky.ledger/ledger'
const PANEL_ID = 'panel:quirky.ledger/ledger'
const SIDEBAR_ID = 'sidebar-section:quirky.ledger/ledger'
const CONTROL_ID = 'command:quirky.ledger/control'
const RUNTIME = { runtimeId: 'runtime-1', profileId: 'profile-1' }
const PROJECT_OWNER: LedgerOwner = { tier: 'project', id: 'repo-1' }
const OTHER_PROJECT: LedgerOwner = { tier: 'project', id: 'repo-2' }
const PROJECT_SUMMARY: LedgerSummary = {
  ledgerId: 'ledger-project', tier: 'project', owner: PROJECT_OWNER, formerOwner: null, revision: 4,
  entryCount: 3, nextSequence: 4, staleAfterDays: 30, name: 'quirky', ownerName: 'quirky', repoId: 'repo-1'
}
const DETACHED_SUMMARY: LedgerSummary = {
  ...PROJECT_SUMMARY, owner: null, formerOwner: PROJECT_OWNER, revision: 4
}
const REPOS = [
  { id: 'repo-1', name: 'quirky', kind: 'git' },
  { id: 'repo-2', name: 'other', kind: 'git' }
]
const GROUPS = [{ id: 'group-1', name: 'platform', repoIds: ['repo-1'] }]
const WORKSPACES = [
  { id: 'wt-1', repoId: 'repo-1', name: 'main', kind: 'git' },
  { id: 'wt-2', repoId: 'repo-2', name: 'other', kind: 'git' }
]
const LIVE_OWNERS: LedgerOwnerOption[] = [
  { tier: 'project', id: 'repo-2', name: 'Other project' },
  { tier: 'project', id: 'repo-3', name: 'Third project' }
]

type Mode = 'page' | 'panel'
type Call = { method: string; params: Record<string, unknown> }
type Responder = (params: Record<string, unknown>) => unknown
type Report = Record<string, unknown>
type RegisterControl = (handler: (control: LedgerControl) => Promise<void>, mode: Mode, instance: string) => () => void
type TestContext = UiPluginContext & { registerControl: RegisterControl }
type Controller = { mode: Mode; handler: (control: LedgerControl) => Promise<void> }
type Provided = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => () => void

type World = {
  context: TestContext
  calls: Call[]
  controllers: Map<string, Controller>
  providers: Map<string, Provided>
  reports: Report[]
  opened: Array<{ id: string; input?: unknown }>
  layout: UiLayout
  executeCommandCalls: number
  connectionId: number
  ledger: Partial<Record<LedgerOperation, Responder>>
  methods: Map<string, Responder>
  rawControl(control: LedgerControl, mode?: Mode): Promise<unknown>
  routerControl(args: unknown): Promise<unknown>
  activate(): void
  lastReport(mode: Mode): Report
  setLayout(next: UiLayout): void
}

let createRoot: typeof CreateRoot
let LedgerApp: typeof import('../src/ui/LedgerApp')['LedgerApp']
let activatePlugin: typeof import('../src/ui')['activate']
const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
const roots: Root[] = []
const routerCleanups: Array<() => void> = []

// Load DOM-sensitive modules only after Happy DOM installs the browser globals they inspect.
beforeAll(async () => {
  GlobalRegistrator.register()
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  createRoot = (await import('react-dom/client')).createRoot
  LedgerApp = (await import('../src/ui/LedgerApp')).LedgerApp
  activatePlugin = (await import('../src/ui')).activate
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount())
  await act(async () => {
    for (const cleanup of routerCleanups.splice(0).reverse()) cleanup()
    await Promise.resolve()
  })
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const entryAt = (id = 'bug-1', title = 'Title', revision = 1, sequence = 1): LedgerEntry => ({
  id, type: 'bug', sequence, revision, content: { title }, state: 'open', reviewed: false,
  origin: { workspaceId: 'wt-1', owner: PROJECT_OWNER, branch: 'main', revision: 'abc123', observedAt: '2026-10-30T00:00:00.000Z' },
  createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', history: []
})
const candidateAt = (entry: LedgerEntry): LedgerCandidate => ({ entry, stale: false, reason: 'unreviewed' })
const response = (ledger: LedgerSummary | null, fields: Partial<LedgerResponse> = {}): LedgerResponse => ({
  schemaVersion: 1, runtime: RUNTIME, ledger, ...fields
})
const baseEntries = [entryAt()]

function createWorld(options: { connectionId?: number; layout?: Partial<UiLayout> } = {}): World {
  const calls: Call[] = []
  const controllers = new Map<string, Controller>()
  const providers = new Map<string, Provided>()
  const reports: Report[] = []
  const opened: Array<{ id: string; input?: unknown }> = []
  const connectionId = options.connectionId ?? 37
  const layout = { worktree: 'wt-1', ...options.layout } as UiLayout
  const ledger: Partial<Record<LedgerOperation, Responder>> = {}
  const methods = new Map<string, Responder>()
  const layoutListeners = new Set<(next: UiLayout) => void>()
  let executeCommandCalls = 0

  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (methods.has(method)) return await methods.get(method)!(params)
      if (method === 'ui.window.self') return { connId: connectionId }
      if (method === 'ui.window.command.run') {
        if (params.connId !== connectionId || params.id !== CONTROL_ID) throw new Error('Unexpected exact-window command route.')
        const command = params.args as LedgerControl
        const routed = providers.get(CONTROL_ID) as unknown as ((args: unknown) => unknown) | undefined
        if (routed) return routed(command)
        const controller = controllers.get(command.instance ?? '')
        if (!controller) throw new Error('The addressed ledger controller is not mounted.')
        return controller.handler(command)
      }
      if (method === 'quirky.repo/list') return REPOS
      if (method === 'quirky.repo/groupList') return GROUPS
      if (method === 'quirky.worktree/list') return WORKSPACES
      if (method !== 'quirky.ledger/request') throw new Error(`Unexpected fake context method: ${method}`)

      const operation = params.operation as LedgerOperation
      const responder = ledger[operation] ?? ((request: Record<string, unknown>) => {
        switch (request.operation) {
          case 'catalog': return response(null, { ledgers: [PROJECT_SUMMARY], owners: LIVE_OWNERS })
          case 'list': return response(PROJECT_SUMMARY, { entries: baseEntries })
          case 'show': return response(PROJECT_SUMMARY, { entry: entryAt(String(request.id)) })
          case 'review': return response(PROJECT_SUMMARY, { candidates: [candidateAt(entryAt())] })
          default: return response(PROJECT_SUMMARY)
        }
      })
      return await responder(params)
    },
    getLayout: () => layout,
    onLayout: (listener: (next: UiLayout) => void) => {
      layoutListeners.add(listener)
      return () => { layoutListeners.delete(listener) }
    },
    subscribe: () => () => {},
    openView: (id: string, input?: unknown) => { opened.push({ id, input }) },
    registerControl: (handler: Controller['handler'], mode: Mode, instance: string) => {
      controllers.set(instance, { mode, handler })
      return () => { controllers.delete(instance) }
    },
    provide: (id: string, handler: Provided) => { providers.set(id, handler) },
    executeCommand: () => {
      executeCommandCalls++
      throw new Error('executeCommand must not forward auxiliary-window ledger controls.')
    }
  } as unknown as TestContext

  const world: World = {
    context, calls, controllers, providers, reports, opened, layout, connectionId, ledger, methods,
    get executeCommandCalls() { return executeCommandCalls },
    rawControl(control, mode) {
      const mounted = [...controllers.entries()].reverse().find(([, item]) => mode === undefined || item.mode === mode)
      const instance = control.instance ?? mounted?.[0]
      if (!instance) return Promise.reject(new Error('No mounted fake controller.'))
      return context.call('ui.window.command.run', { connId: connectionId, id: CONTROL_ID, args: { ...control, instance } })
    },
    routerControl(args) {
      const handler = providers.get(CONTROL_ID) as unknown as ((value: unknown) => Promise<unknown>) | undefined
      if (!handler) return Promise.reject(new Error('The router is not activated.'))
      return handler(args)
    },
    activate() { activatePlugin(context) },
    setLayout(next) {
      Object.assign(layout, next)
      for (const listener of [...layoutListeners]) listener(layout)
    },
    lastReport(mode) {
      const match = [...reports].reverse().find((item) => mode === 'panel' ? item.view === 'panel' : item.view !== 'panel')
      if (!match) throw new Error(`No ${mode} report has been emitted.`)
      return match
    }
  }
  return world
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve()
  })
}

async function sendControl(world: World, control: LedgerControl, mode?: Mode): Promise<unknown> {
  let result: unknown
  await act(async () => { result = await world.rawControl(control, mode) })
  return result
}

async function mountComponent(world: World, mode: Mode, input?: unknown): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(
    <LedgerApp context={world.context} input={input} mode={mode} report={(state) => world.reports.push(state as Report)} registerControl={world.context.registerControl} />
  ))
  return host
}

async function mountPage(world: World, input: unknown = { target: { ledgerId: 'ledger-project' } }): Promise<HTMLElement> {
  return mountComponent(world, 'page', input)
}

async function mountPanel(world: World): Promise<HTMLElement> {
  return mountComponent(world, 'panel')
}

async function mountRouterSlot(world: World, id: string, input?: unknown): Promise<HTMLElement> {
  const provide = world.providers.get(id)
  if (!provide) throw new Error(`No slot provider registered for ${id}.`)
  const host = document.createElement('div')
  document.body.append(host)
  let cleanup!: () => void
  await act(async () => {
    cleanup = provide(host, { input, report: (state) => world.reports.push(state as Report) })
  })
  routerCleanups.push(cleanup)
  return host
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => { element.click() })
  await settle()
}

function namedButton(root: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.getAttribute('aria-label') === name || button.textContent?.trim() === name
  )
}

function textButtonStarting(root: ParentNode, prefix: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim().startsWith(prefix))
}

function rowIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('.ledger-entry-row')].map((row) => row.dataset.entryId ?? '')
}

function operationCalls(world: World, operation: LedgerOperation): Call[] {
  return world.calls.filter((call) => call.method === 'quirky.ledger/request' && call.params.operation === operation)
}

function methodCalls(world: World, method: string): Call[] {
  return world.calls.filter((call) => call.method === method)
}

function inlineError(host: ParentNode, message: string): HTMLElement {
  const error = host.querySelector<HTMLElement>('.ui-inline-error')
  expect(error).toBeDefined()
  expect(error?.textContent).toContain(message)
  return error!
}

function expectRetry(error: HTMLElement): HTMLButtonElement {
  const retries = [...error.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === 'Retry')
  expect(retries).toHaveLength(1)
  return retries[0]!
}

function expectMutationCount(world: World, count: number): void {
  const mutations = ['file', 'edit', 'state', 'approve', 'revert', 'bulk-state', 'delete-entries', 'delete-ledger', 'attach'] as LedgerOperation[]
  expect(world.calls.filter((call) => call.method === 'quirky.ledger/request' && mutations.includes(call.params.operation as LedgerOperation))).toHaveLength(count)
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

function installControlledWindowTimers() {
  const originalSet = window.setTimeout
  const originalClear = window.clearTimeout
  let now = 0
  let nextId = 0
  const scheduled = new Map<number, { at: number; callback: () => void }>()
  window.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = ++nextId
    if (typeof callback === 'function') scheduled.set(id, { at: now + Number(delay), callback: callback as () => void })
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = ((id: number | string) => { scheduled.delete(Number(id)) }) as typeof window.clearTimeout
  return {
    advance(milliseconds: number) {
      now += milliseconds
      for (const [id, timer] of [...scheduled].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at <= now) {
          scheduled.delete(id)
          timer.callback()
        }
      }
    },
    restore() {
      window.setTimeout = originalSet
      window.clearTimeout = originalClear
      scheduled.clear()
    }
  }
}

const loadingBranches: Array<{
  name: string
  message: string
  mount(world: World): Promise<{ host: HTMLElement; release(): Promise<void> }>
}> = [
  {
    name: 'chooser catalog', message: 'Loading ledgers…',
    async mount(world) {
      const held = Promise.withResolvers<LedgerResponse>()
      world.ledger.catalog = () => held.promise
      const host = await mountPage(world, null)
      return {
        host,
        async release() {
          await act(async () => { held.resolve(response(null, { ledgers: [PROJECT_SUMMARY], owners: LIVE_OWNERS })); await held.promise })
          await settle()
        }
      }
    }
  },
  {
    name: 'page list', message: 'Loading ledger…',
    async mount(world) {
      const held = Promise.withResolvers<LedgerResponse>()
      world.ledger.list = () => held.promise
      const host = await mountPage(world)
      return {
        host,
        async release() {
          await act(async () => { held.resolve(response(PROJECT_SUMMARY, { entries: baseEntries })); await held.promise })
          await settle()
        }
      }
    }
  },
  {
    name: 'panel directory', message: 'Loading ledger…',
    async mount(world) {
      const held = Promise.withResolvers<unknown>()
      world.methods.set('quirky.repo/list', () => held.promise)
      const host = await mountPanel(world)
      return {
        host,
        async release() {
          await act(async () => { held.resolve(REPOS); await held.promise })
          await settle()
        }
      }
    }
  },
  {
    name: 'panel list after directory settlement', message: 'Loading ledger…',
    async mount(world) {
      const held = Promise.withResolvers<LedgerResponse>()
      world.ledger.list = () => held.promise
      const host = await mountPanel(world)
      await settle()
      return {
        host,
        async release() {
          await act(async () => { held.resolve(response(PROJECT_SUMMARY, { entries: baseEntries })); await held.promise })
          await settle()
        }
      }
    }
  },
  {
    name: 'pending detail show', message: 'Loading entry…',
    async mount(world) {
      const held = Promise.withResolvers<LedgerResponse>()
      world.ledger.show = () => held.promise
      const pageHost = await mountPage(world)
      await settle()
      await press(namedButton(pageHost, 'Show details: bug-1')!)
      const host = document.body
      return {
        host,
        async release() {
          await act(async () => { held.resolve(response(PROJECT_SUMMARY, { entry: entryAt() })); await held.promise })
          await settle()
        }
      }
    }
  }
]

for (const branch of loadingBranches) {
  test(`shared loading notice settles in ${branch.name}`, async () => {
    const world = createWorld()
    const pending = await branch.mount(world)
    const notice = pending.host.querySelector<HTMLElement>('.ui-notice-line')
    expect(notice?.textContent).toContain(branch.message)
    expect(pending.host.querySelector('.ledger-state-message')).toBeNull()
    await pending.release()
    expect(pending.host.querySelector('.ui-notice-line')).toBeNull()
  })
}

test('chooser, page, panel, and unattached-owner emptiness use EmptyState', async () => {
  const chooser = createWorld()
  chooser.ledger.catalog = () => response(null, { ledgers: [], owners: [] })
  const chooserHost = await mountPage(chooser, null)
  await settle()
  expect(chooserHost.querySelector('.ui-empty-state__message')?.textContent).toBe('No attached or detached ledgers yet. File an entry to create one.')

  const page = createWorld()
  page.ledger.list = () => response(PROJECT_SUMMARY, { entries: [] })
  const pageHost = await mountPage(page)
  await settle()
  expect(pageHost.querySelector('.ui-empty-state__message')?.textContent).toBe('No entries match this view.')
  expect(namedButton(pageHost, 'New entry')).toBeDefined()

  const panel = createWorld()
  panel.ledger.list = () => response(PROJECT_SUMMARY, { entries: [] })
  const panelHost = await mountPanel(panel)
  await settle()
  expect(panelHost.querySelector('.ui-empty-state__message')?.textContent).toBe('No entries match this view.')

  const detached = createWorld()
  detached.ledger.catalog = () => response(null, { ledgers: [DETACHED_SUMMARY], owners: [] })
  detached.ledger.list = () => response(DETACHED_SUMMARY, { entries: [] })
  const detachedHost = await mountPage(detached, { target: { ledgerId: 'ledger-project' } })
  await settle()
  expect(detachedHost.querySelector('.ui-empty-state__message')?.textContent).toBe('No unoccupied live owners are available.')
})

test('panel with no workspace shows the shared open-workspace EmptyState', async () => {
  const world = createWorld({ layout: { worktree: '' } })
  const host = await mountPanel(world)
  await settle()
  expect(host.querySelector('.ui-empty-state__message')?.textContent).toBe('Open a workspace to see its ledger.')
})

type ErrorScenario = {
  name: string
  message: string
  mount(world: World): Promise<HTMLElement>
  retry(world: World, host: HTMLElement): Promise<void>
  verify(world: World, before: number): void
}
const errorScenarios: ErrorScenario[] = [
  {
    name: 'chooser catalog', message: 'Ledger catalog could not be loaded: fixture failure',
    async mount(world) {
      let attempts = 0
      world.ledger.catalog = () => { if (attempts++ === 0) throw new Error('fixture failure'); return response(null, { ledgers: [PROJECT_SUMMARY], owners: LIVE_OWNERS }) }
      return mountPage(world, null)
    },
    async retry(world, host) { await press(expectRetry(inlineError(host, this.message))) },
    verify(world, before) { expect(operationCalls(world, 'catalog')).toHaveLength(before + 1) }
  },
  {
    name: 'page owner catalog', message: 'Owner catalog unavailable: fixture failure',
    async mount(world) {
      let attempts = 0
      world.ledger.catalog = () => { if (attempts++ === 0) throw new Error('fixture failure'); return response(null, { ledgers: [PROJECT_SUMMARY], owners: LIVE_OWNERS }) }
      return mountPage(world)
    },
    async retry(world, host) { await press(expectRetry(inlineError(host, this.message))) },
    verify(world, before) { expect(operationCalls(world, 'catalog')).toHaveLength(before + 1) }
  },
  {
    name: 'page directory with projects rejected', message: 'Location bases could not be loaded: projects: fixture failure',
    async mount(world) {
      let failures = 1
      world.methods.set('quirky.repo/list', () => { if (failures-- > 0) throw new Error('fixture failure'); return REPOS })
      return mountPage(world)
    },
    async retry(world, host) { await press(expectRetry(inlineError(host, this.message))) },
    verify(world, before) {
      expect(methodCalls(world, 'quirky.repo/list')).toHaveLength(before + 1)
      expect(methodCalls(world, 'quirky.repo/groupList')).toHaveLength(before + 1)
      expect(methodCalls(world, 'quirky.worktree/list')).toHaveLength(before + 1)
    }
  },
  {
    name: 'panel directory with projects rejected', message: 'Owner catalog could not be loaded: projects: fixture failure',
    async mount(world) {
      let failures = 1
      world.methods.set('quirky.repo/list', () => { if (failures-- > 0) throw new Error('fixture failure'); return REPOS })
      return mountPanel(world)
    },
    async retry(world, host) { await press(expectRetry(inlineError(host, this.message))) },
    verify(world, before) {
      expect(methodCalls(world, 'quirky.repo/list')).toHaveLength(before + 1)
      expect(methodCalls(world, 'quirky.repo/groupList')).toHaveLength(before + 1)
      expect(methodCalls(world, 'quirky.worktree/list')).toHaveLength(before + 1)
    }
  },
  {
    name: 'page list retries with its current target and filters', message: 'Ledger could not be loaded: fixture failure',
    async mount(world) {
      let attempts = 0
      world.ledger.list = () => { if (attempts++ < 2) throw new Error('fixture failure'); return response(PROJECT_SUMMARY, { entries: baseEntries }) }
      const host = await mountPage(world)
      await settle()
      await sendControl(world, { action: 'filters', filters: { type: 'bug' } }, 'page')
      await settle()
      return host
    },
    async retry(world, host) { await press(expectRetry(inlineError(host, this.message))) },
    verify(world, before) {
      expect(operationCalls(world, 'list')).toHaveLength(before + 1)
      expect(operationCalls(world, 'list').at(-1)?.params).toMatchObject({ target: { ledgerId: 'ledger-project' }, filters: { type: 'bug' } })
    }
  },
  {
    name: 'panel list retries with its workspace target and filters', message: 'Ledger could not be loaded. fixture failure',
    async mount(world) {
      let attempts = 0
      world.ledger.list = () => { if (attempts++ < 2) throw new Error('fixture failure'); return response(PROJECT_SUMMARY, { entries: baseEntries }) }
      const host = await mountPanel(world)
      await settle()
      await sendControl(world, { action: 'filters', filters: { type: 'bug' } }, 'panel')
      await settle()
      return host
    },
    async retry(world, host) { await press(expectRetry(inlineError(host, this.message))) },
    verify(world, before) {
      expect(operationCalls(world, 'list')).toHaveLength(before + 1)
      expect(operationCalls(world, 'list').at(-1)?.params).toMatchObject({ target: { workspaceId: 'wt-1' }, filters: { type: 'bug', workspaceId: 'wt-1' } })
    }
  },
  {
    name: 'pending detail retries its id when that id is absent from the list', message: 'fixture failure',
    async mount(world) {
      let attempts = 0
      world.ledger.show = (params) => { if (attempts++ === 0) throw new Error('fixture failure'); return response(PROJECT_SUMMARY, { entry: entryAt(String(params.id)) }) }
      await mountPage(world)
      await settle()
      await sendControl(world, { action: 'detail', id: 'not-in-list' }, 'page')
      await settle()
      return document.body
    },
    async retry(world, host) { await press(expectRetry(inlineError(host, this.message))) },
    verify(world, before) {
      expect(operationCalls(world, 'show')).toHaveLength(before + 1)
      expect(operationCalls(world, 'show').at(-1)?.params).toMatchObject({ id: 'not-in-list', target: { ledgerId: 'ledger-project' } })
    }
  }
]

for (const scenario of errorScenarios) {
  test(`shared error preserves cause and Retry route: ${scenario.name}`, async () => {
    const world = createWorld()
    const host = await scenario.mount(world)
    await settle()
    const error = inlineError(host, scenario.message)
    const retry = expectRetry(error)
    expect([...error.querySelectorAll('button')].filter((button) => button.textContent?.trim() === 'Retry')).toHaveLength(1)
    const before = scenario.name.includes('directory')
      ? methodCalls(world, 'quirky.repo/list').length
      : scenario.name.includes('detail') ? operationCalls(world, 'show').length
        : scenario.name.includes('list') ? operationCalls(world, 'list').length : operationCalls(world, 'catalog').length
    await press(retry)
    await settle()
    scenario.verify(world, before)
    expect(host.querySelector('.ui-inline-error')).toBeNull()
  })
}

const panelErrors = [
  ['workspace-missing', 'This workspace is not live in this runtime.'],
  ['owner-missing', 'The owning project or group no longer exists.'],
  ['owner-ambiguous', 'Ledger scope could not be resolved to a single project.'],
  ['group-ambiguous', 'Ledger scope could not be resolved to a single project.'],
  ['catalog-unavailable', 'The owner catalog is unavailable. Ledger could not be loaded.']
] as const
for (const [kind, message] of panelErrors) {
  test(`panel shared error preserves ${kind}`, async () => {
    const world = createWorld()
    world.ledger.list = () => { throw Object.assign(new Error('fixture failure'), { data: { kind } }) }
    const host = await mountPanel(world)
    await settle()
    expect(inlineError(host, message).textContent).toContain('Retry')
    expect(host.querySelector('.ui-empty-state')).toBeNull()
  })
}

test('a group-scoped panel with a live workspace but no group reports InlineError, not empty results', async () => {
  const world = createWorld()
  world.methods.set('quirky.repo/groupList', () => [])
  const host = await mountPanel(world)
  await settle()
  await sendControl(world, { action: 'scope', scope: 'group' }, 'panel')
  await settle()
  inlineError(host, 'This workspace has no group.')
  expect(host.querySelector('.ui-empty-state')).toBeNull()
  expect(host.textContent).not.toContain('No entries match this view.')
})

test('action failures use InlineError without an automatic mutation Retry', async () => {
  const world = createWorld()
  world.ledger.approve = () => { throw new Error('review action failed') }
  const host = await mountPage(world)
  await settle()
  const before = operationCalls(world, 'approve').length
  await press(namedButton(host, 'Review bug-1')!)
  inlineError(host, 'review action failed')
  expect(host.querySelector('.ui-inline-error button')).toBeNull()
  expect(operationCalls(world, 'approve')).toHaveLength(before + 1)
})

test('chooser and entry DOM controls keep refresh and choose requests on their current routes', async () => {
  const world = createWorld()
  const chooser = await mountPage(world, null)
  await settle()
  const catalogs = operationCalls(world, 'catalog').length
  await press(namedButton(chooser, 'Refresh ledger catalog')!)
  expect(operationCalls(world, 'catalog')).toHaveLength(catalogs + 1)
  const open = namedButton(chooser, 'Open ledger quirky')
  expect(open).toBeDefined()
  await press(open!)
  expect(chooser.querySelector('[data-ledger-view="page"]')).not.toBeNull()
  expect(operationCalls(world, 'list').at(-1)?.params.target).toEqual({ ledgerId: 'ledger-project' })
  const beforeList = operationCalls(world, 'list').length
  const target = operationCalls(world, 'list').at(-1)?.params.target
  const filters = operationCalls(world, 'list').at(-1)?.params.filters
  await press(namedButton(chooser, 'Refresh ledger')!)
  expect(operationCalls(world, 'list')).toHaveLength(beforeList + 1)
  expect(operationCalls(world, 'list').at(-1)?.params).toMatchObject({ target, filters })
})

test('catalog summaries do not authorize delete or attach before the selected ledger list answers', async () => {
  const world = createWorld()
  world.ledger.catalog = () => response(null, { ledgers: [DETACHED_SUMMARY], owners: LIVE_OWNERS })
  const held = Promise.withResolvers<LedgerResponse>()
  world.ledger.list = () => held.promise
  const host = await mountPage(world, null)
  await settle()
  await press(namedButton(host, 'Open ledger quirky')!)
  expect(host.querySelector('[data-ledger-view="page"]')).not.toBeNull()
  expect(namedButton(host, 'Delete ledger')).toBeUndefined()
  expect(host.querySelector('select[aria-label="Attach ledger to owner"]')).toBeNull()
  await act(async () => { held.resolve(response(DETACHED_SUMMARY, { entries: baseEntries })); await held.promise })
  await settle()
  expect(namedButton(host, 'Delete ledger')).toBeDefined()
  expect(host.querySelector('select[aria-label="Attach ledger to owner"]')).not.toBeNull()
})

test('chooser control clears page and triage selections and dialogs, then reloads catalog once', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await settle()
  await sendControl(world, { action: 'selection', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await sendControl(world, { action: 'triage' }, 'page')
  await settle()
  await sendControl(world, { action: 'selection', selectionScope: 'triage', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await settle()
  await sendControl(world, { action: 'prepare', kind: 'delete-entries', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await settle()
  expect(world.lastReport('page').dialog).toBe('confirm:delete-entries')
  const catalogs = operationCalls(world, 'catalog').length
  await sendControl(world, { action: 'chooser' }, 'page')
  await settle()
  expect(host.querySelector('[data-ledger-view="chooser"]')).not.toBeNull()
  expect(world.lastReport('page')).toMatchObject({ view: 'chooser', dialog: 'none', selection: [] })
  expect(operationCalls(world, 'catalog')).toHaveLength(catalogs + 1)
  expectMutationCount(world, 0)
  await press(namedButton(host, 'Open ledger quirky')!)
  await settle()
  expect(world.lastReport('page').selection).toEqual([])
})

test('the page DOM Open ledger button uses the chooser route and clears its pending detail', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await settle()
  await sendControl(world, { action: 'detail', id: 'bug-1' }, 'page')
  await settle()
  expect(world.lastReport('page').dialog).toBe('detail')
  const catalogCalls = operationCalls(world, 'catalog').length
  await press(namedButton(host, 'Open ledger')!)
  expect(host.querySelector('[data-ledger-view="chooser"]')).not.toBeNull()
  expect(world.lastReport('page')).toMatchObject({ dialog: 'none', selection: [] })
  expect(operationCalls(world, 'catalog')).toHaveLength(catalogCalls + 1)
})

test('chooser is rejected in panel mode without changing its view', async () => {
  const world = createWorld()
  const host = await mountPanel(world)
  await settle()
  await expect(sendControl(world, { action: 'chooser' }, 'panel')).rejects.toThrow('The ledger chooser is only available in page mode.')
  expect(host.querySelector('[data-ledger-view="panel"]')).not.toBeNull()
})

test('filter disclosure is idempotent, active filters keep it visible, and replace clears filter requests', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await settle()
  await press(namedButton(host, 'Filter ledger')!)
  expect(world.lastReport('page').filtersOpen).toBe(true)
  expect(host.querySelector('.ledger-filters')).not.toBeNull()
  await sendControl(world, { action: 'filters-open', open: true }, 'page')
  expect(world.lastReport('page').filtersOpen).toBe(true)
  await sendControl(world, { action: 'filters-open', open: false }, 'page')
  expect(host.querySelector('.ledger-filters')).toBeNull()
  await press(namedButton(host, 'Filter ledger')!)

  const type = host.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]')!
  await act(async () => setNativeValue(type, 'bug'))
  await settle()
  expect(host.querySelector('.ledger-filters')).not.toBeNull()
  await sendControl(world, { action: 'filters-open', open: false }, 'page')
  expect(host.querySelector('.ledger-filters')).not.toBeNull()
  await act(async () => setNativeValue(type, ''))
  await settle()
  expect(world.lastReport('page').filters).toEqual({})
  expect(operationCalls(world, 'list').at(-1)?.params.filters).not.toHaveProperty('type')

  await sendControl(world, { action: 'filters', filters: { type: 'bug' } }, 'page')
  await sendControl(world, { action: 'filters', replace: true, filters: {} }, 'page')
  await settle()
  expect(world.lastReport('page').filters).toEqual({})
  expect(operationCalls(world, 'list').at(-1)?.params.filters).not.toHaveProperty('type')
})

test('DOM Project tab clears panel target override and removes the implicit workspace-origin filter', async () => {
  const world = createWorld()
  const host = await mountPanel(world)
  await settle()
  await sendControl(world, { action: 'choose', target: { owner: OTHER_PROJECT } }, 'panel')
  await settle()
  expect(world.lastReport('panel').target).toEqual({ owner: OTHER_PROJECT })
  const projectTab = textButtonStarting(host, 'Project')
  expect(projectTab).toBeDefined()
  await press(projectTab!)
  await settle()
  expect(world.lastReport('panel').scope).toBe('project')
  expect(world.lastReport('panel').target).toEqual({ workspaceId: 'wt-1' })
  expect(operationCalls(world, 'list').at(-1)?.params).toMatchObject({ target: { workspaceId: 'wt-1' } })
  expect(operationCalls(world, 'list').at(-1)?.params.filters).not.toHaveProperty('workspaceId')
})

test('DOM filters/search/sort and explicit controls produce the same report and row order', async () => {
  const matching = [entryAt('bug-z', 'Title Z', 1, 1), entryAt('bug-a', 'Title A', 1, 2), entryAt('other', 'Unrelated', 1, 3)]
  const dom = createWorld()
  dom.ledger.list = () => response(PROJECT_SUMMARY, { entries: matching })
  const domHost = await mountPage(dom)
  await settle()
  await press(namedButton(domHost, 'Filter ledger')!)
  await act(async () => setNativeValue(domHost.querySelector<HTMLInputElement>('input[aria-label="Search ledger"]')!, 'Title'))
  await settle()
  await act(async () => setNativeValue(domHost.querySelector<HTMLSelectElement>('select[aria-label="Sort ledger entries"]')!, 'title'))
  await settle()

  const api = createWorld()
  api.ledger.list = () => response(PROJECT_SUMMARY, { entries: matching })
  const apiHost = await mountPage(api)
  await settle()
  await sendControl(api, { action: 'filters-open', open: true }, 'page')
  await sendControl(api, { action: 'filters', replace: true, filters: { search: 'Title' } }, 'page')
  await sendControl(api, { action: 'sort', sort: 'title' }, 'page')
  await settle()

  expect(dom.lastReport('page')).toMatchObject({ filtersOpen: true, filters: { search: 'Title' }, sort: 'title' })
  expect(api.lastReport('page')).toMatchObject({ filtersOpen: true, filters: { search: 'Title' }, sort: 'title' })
  expect(rowIds(domHost)).toEqual(['bug-a', 'bug-z'])
  expect(rowIds(domHost)).toEqual(rowIds(apiHost))
})

test('page and triage selection scopes retain their own snapshots, including cached titles', async () => {
  const world = createWorld()
  let lists = 0
  world.ledger.list = () => response(PROJECT_SUMMARY, { entries: [entryAt('bug-1', lists++ === 0 ? 'Title' : 'Changed title', 1)] })
  const host = await mountPage(world)
  await settle()
  await sendControl(world, { action: 'selection', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await sendControl(world, { action: 'triage' }, 'page')
  await settle()
  await sendControl(world, { action: 'selection', selectionScope: 'triage', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await settle()
  expect(world.lastReport('page').selection).toEqual([{ id: 'bug-1', revision: 1 }])
  await sendControl(world, { action: 'dismiss', dialog: 'triage' }, 'page')
  await settle()
  expect(world.lastReport('page').selection).toEqual([{ id: 'bug-1', revision: 1 }])
  await sendControl(world, { action: 'refresh', resource: 'entries' }, 'page')
  await settle()
  expect(rowIds(host)).toEqual(['bug-1'])
  await sendControl(world, { action: 'prepare', kind: 'delete-entries' }, 'page')
  await settle()
  expect(document.querySelector('.ledger-confirm-snapshots')?.textContent).toContain('bug-1 · revision 1 · Title')
  expectMutationCount(world, 0)
})

const confirmationCases: Array<{
  name: string
  operation: LedgerOperation
  prepare: LedgerControl
  expected: Record<string, unknown>
  configure?(world: World): void
  prepareDom?(world: World, host: HTMLElement): Promise<void>
}> = [
  {
    name: 'bulk-state resolved', operation: 'bulk-state',
    prepare: { action: 'prepare', kind: 'bulk-state', state: 'resolved', selections: [{ id: 'bug-1', revision: 1 }] },
    expected: { target: { ledgerId: 'ledger-project' }, state: 'resolved', selections: [{ id: 'bug-1', revision: 1 }] }
  },
  {
    name: 'bulk-state archived', operation: 'bulk-state',
    prepare: { action: 'prepare', kind: 'bulk-state', state: 'archived', selections: [{ id: 'bug-1', revision: 1 }] },
    expected: { target: { ledgerId: 'ledger-project' }, state: 'archived', selections: [{ id: 'bug-1', revision: 1 }] }
  },
  {
    name: 'delete entries', operation: 'delete-entries',
    prepare: { action: 'prepare', kind: 'delete-entries', selections: [{ id: 'bug-1', revision: 1 }] },
    expected: { target: { ledgerId: 'ledger-project' }, selections: [{ id: 'bug-1', revision: 1 }] }
  },
  {
    name: 'delete ledger', operation: 'delete-ledger',
    prepare: { action: 'prepare', kind: 'delete-ledger' },
    expected: { target: { ledgerId: 'ledger-project' }, ifLedgerRevision: 4 }
  },
  {
    name: 'attach chosen owner from a local draft', operation: 'attach',
    prepare: { action: 'prepare', kind: 'attach', attachTo: OTHER_PROJECT },
    expected: { target: { ledgerId: 'ledger-project' }, attachTo: OTHER_PROJECT, ifLedgerRevision: 4 },
    configure(world) {
      world.ledger.catalog = () => response(null, { ledgers: [DETACHED_SUMMARY], owners: LIVE_OWNERS })
      world.ledger.list = () => response(DETACHED_SUMMARY, { entries: baseEntries })
    },
    async prepareDom(_world, host) {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Attach ledger to owner"]')!
      await act(async () => setNativeValue(select, 'project:repo-2'))
      await press(namedButton(host, 'Attach')!)
    }
  }
]

for (const scenario of confirmationCases) {
  test(`prepare then confirm carries the immutable ${scenario.name} snapshot`, async () => {
    const world = createWorld()
    scenario.configure?.(world)
    const host = await mountPage(world)
    await settle()
    if (scenario.prepareDom) await scenario.prepareDom(world, host)
    else await sendControl(world, scenario.prepare, 'page')
    await settle()
    expect(world.lastReport('page').dialog).toBe(`confirm:${scenario.prepare.kind}`)
    expectMutationCount(world, 0)
    const snapshot = document.querySelector<HTMLElement>('.ledger-confirm-snapshots')
    expect(snapshot).toBeDefined()
    if (scenario.prepare.kind === 'delete-ledger') expect(snapshot?.textContent).toContain('ledger-project · ledger revision 4 · 3 entries')
    else if (scenario.prepare.kind === 'attach') expect(snapshot?.textContent).toContain('ledger-project · ledger revision 4 · attach to project repo-2')
    else expect(snapshot?.textContent).toContain('bug-1 · revision 1 · Title')

    await sendControl(world, { action: 'confirm' }, 'page')
    await settle()
    const mutation = operationCalls(world, scenario.operation).find((call) => call.method === 'quirky.ledger/request')
    expect(mutation?.params).toMatchObject({ ...scenario.expected, yes: true, confirmed: true })
  })
}

test('Cancel/dismiss clears a prepared confirmation without mutation', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await settle()
  await sendControl(world, { action: 'prepare', kind: 'bulk-state', state: 'resolved', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await settle()
  await press(namedButton(document, 'Cancel')!)
  expect(world.lastReport('page').dialog).toBe('none')
  expectMutationCount(world, 0)
})

test('synchronous duplicate confirm and confirmation dismissal reject while mutation is held', async () => {
  const world = createWorld()
  const held = Promise.withResolvers<LedgerResponse>()
  world.ledger['bulk-state'] = () => held.promise
  const host = await mountPage(world)
  await settle()
  await sendControl(world, { action: 'prepare', kind: 'bulk-state', state: 'resolved', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await settle()
  let first!: Promise<unknown>
  let failures: unknown[] = []
  await act(async () => {
    first = world.rawControl({ action: 'confirm' }, 'page')
    failures = await Promise.all([
      world.rawControl({ action: 'confirm' }, 'page').catch((reason: unknown) => reason),
      world.rawControl({ action: 'dismiss', dialog: 'confirmation' }, 'page').catch((reason: unknown) => reason)
    ])
  })
  for (const failure of failures) {
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('A ledger confirmation is already in progress.')
  }
  expect(operationCalls(world, 'bulk-state')).toHaveLength(1)
  await act(async () => { held.resolve(response(PROJECT_SUMMARY)); await first })
  await settle()
  expect(world.lastReport('page').dialog).toBe('none')
  expect(host.querySelector('.ui-inline-error')).toBeNull()
})

test('revision conflict closes the snapshot, clears selection, reloads once, and never retries mutation', async () => {
  const world = createWorld()
  let listRevision = 1
  world.ledger.list = () => response({ ...PROJECT_SUMMARY, revision: listRevision }, { entries: [entryAt('bug-1', 'Title', listRevision)] })
  world.ledger['bulk-state'] = () => { listRevision = 2; throw Object.assign(new Error('revision changed'), { data: { kind: 'conflict', currentRevision: 2 } }) }
  const host = await mountPage(world)
  await settle()
  await sendControl(world, { action: 'selection', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await sendControl(world, { action: 'prepare', kind: 'bulk-state', state: 'resolved' }, 'page')
  await settle()
  const lists = operationCalls(world, 'list').length
  await sendControl(world, { action: 'confirm' }, 'page')
  await settle()
  expect(world.lastReport('page').dialog).toBe('none')
  expect(world.lastReport('page').selection).toEqual([])
  inlineError(host, 'The ledger changed to revision 2. Review the refreshed revisions before confirming again.')
  expect(operationCalls(world, 'bulk-state')).toHaveLength(1)
  expect(operationCalls(world, 'list')).toHaveLength(lists + 1)
  expect(rowIds(host)).toEqual(['bug-1'])
})

for (const change of [
  { name: 'target', mode: 'page' as Mode, command: { action: 'choose', target: { ledgerId: 'ledger-other' } } as LedgerControl },
  { name: 'scope', mode: 'panel' as Mode, command: { action: 'scope', scope: 'project' } as LedgerControl }
]) {
  test(`target/scope invalidation rejects an immediate stale confirm after ${change.name} change`, async () => {
    const world = createWorld()
    const host = change.mode === 'panel' ? await mountPanel(world) : await mountPage(world)
    await settle()
    await sendControl(world, { action: 'prepare', kind: 'delete-ledger' }, change.mode)
    await settle()
    expect(world.lastReport(change.mode).dialog).toBe('confirm:delete-ledger')
    await act(async () => {
      await world.rawControl(change.command, change.mode)
      await expect(world.rawControl({ action: 'confirm' }, change.mode)).rejects.toThrow('There is no pending ledger confirmation.')
    })
    await settle()
    expectMutationCount(world, 0)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[data-ledger-view="page"], [data-ledger-view="panel"]')).not.toBeNull()
  })
}

test('ledger deletion and attachment preparation require an authoritative loaded summary', async () => {
  for (const kind of ['delete-ledger', 'attach'] as const) {
    const world = createWorld()
    world.ledger.list = () => response(null, { entries: [] })
    const host = await mountPage(world)
    await settle()
    await expect(sendControl(world, kind === 'attach'
      ? { action: 'prepare', kind, attachTo: OTHER_PROJECT }
      : { action: 'prepare', kind }, 'page')).rejects.toThrow('An authoritative ledger summary is required for this confirmation.')
    expect(world.lastReport('page').dialog).toBe('none')
    expectMutationCount(world, 0)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  }
})

test('entry preparation copies an explicit stale revision instead of substituting the current row revision', async () => {
  const world = createWorld()
  world.ledger.list = () => response(PROJECT_SUMMARY, { entries: [entryAt('bug-1', 'Current title', 2)] })
  const host = await mountPage(world)
  await settle()
  await sendControl(world, { action: 'prepare', kind: 'delete-entries', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await settle()
  expect(document.querySelector('.ledger-confirm-snapshots')?.textContent).toContain('bug-1 · revision 1')
  expect(document.querySelector('.ledger-confirm-snapshots')?.textContent).not.toContain('Current title')
  await sendControl(world, { action: 'confirm' }, 'page')
  await settle()
  expect(operationCalls(world, 'delete-entries').at(-1)?.params.selections).toEqual([{ id: 'bug-1', revision: 1 }])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('refresh entries uses a controlled 199/200 ms spinner threshold and settles it', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await settle()
  const held = Promise.withResolvers<LedgerResponse>()
  world.ledger.list = () => held.promise
  const timers = installControlledWindowTimers()
  try {
    let refresh!: Promise<unknown>
    await act(async () => { refresh = world.rawControl({ action: 'refresh', resource: 'entries' }, 'page') })
    await settle()
    const button = namedButton(host, 'Refresh ledger')!
    expect(button.getAttribute('aria-busy')).toBe('false')
    await act(async () => timers.advance(199))
    expect(button.getAttribute('aria-busy')).toBe('false')
    await act(async () => timers.advance(1))
    expect(button.getAttribute('aria-busy')).toBe('true')
    await act(async () => { held.resolve(response(PROJECT_SUMMARY, { entries: baseEntries })); await refresh })
    await settle()
    expect(button.getAttribute('aria-busy')).toBe('false')
  } finally {
    timers.restore()
  }
})

test('closing detail invalidates a held show response so it cannot reopen the dialog', async () => {
  const world = createWorld()
  const held = Promise.withResolvers<LedgerResponse>()
  world.ledger.show = () => held.promise
  const host = await mountPage(world)
  await settle()
  let detail!: Promise<unknown>
  await act(async () => { detail = world.rawControl({ action: 'detail', id: 'bug-1' }, 'page') })
  await settle()
  expect(world.lastReport('page').dialog).toBe('detail')
  await sendControl(world, { action: 'dismiss', dialog: 'detail' }, 'page')
  expect(world.lastReport('page').dialog).toBe('none')
  await act(async () => { held.resolve(response(PROJECT_SUMMARY, { entry: entryAt() })); await detail })
  await settle()
  expect(world.lastReport('page').dialog).toBe('none')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('form and triage dismiss controls clear their dialog and triage selection', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await sendControl(world, { action: 'new' }, 'page')
  await settle()
  expect(world.lastReport('page').dialog).toBe('new')
  await sendControl(world, { action: 'dismiss', dialog: 'form' }, 'page')
  expect(world.lastReport('page').dialog).toBe('none')
  await sendControl(world, { action: 'selection', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await sendControl(world, { action: 'triage' }, 'page')
  await settle()
  await sendControl(world, { action: 'selection', selectionScope: 'triage', selections: [{ id: 'bug-1', revision: 1 }] }, 'page')
  await settle()
  await sendControl(world, { action: 'dismiss', dialog: 'triage' }, 'page')
  expect(world.lastReport('page')).toMatchObject({ dialog: 'none', selection: [{ id: 'bug-1', revision: 1 }] })
  await sendControl(world, { action: 'triage' }, 'page')
  await settle()
  expect(world.lastReport('page').selection).toEqual([])
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Operation review')
})

test('detail, edit, new, triage, and settings controls retain their public outcomes', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await settle()
  await sendControl(world, { action: 'detail', id: 'bug-1' }, 'page')
  await settle()
  expect(world.lastReport('page').dialog).toBe('detail')
  await sendControl(world, { action: 'dismiss', dialog: 'detail' }, 'page')
  await sendControl(world, { action: 'edit', id: 'bug-1' }, 'page')
  await settle()
  expect(world.lastReport('page').dialog).toBe('edit')
  await sendControl(world, { action: 'dismiss', dialog: 'form' }, 'page')
  await sendControl(world, { action: 'new' }, 'page')
  await settle()
  expect(world.lastReport('page').dialog).toBe('new')
  await sendControl(world, { action: 'dismiss', dialog: 'form' }, 'page')
  await sendControl(world, { action: 'triage' }, 'page')
  await settle()
  expect(world.lastReport('page').dialog).toBe('triage')
  await sendControl(world, { action: 'dismiss', dialog: 'triage' }, 'page')
  await sendControl(world, { action: 'settings' }, 'page')
  expect(world.opened.at(-1)).toEqual({ id: 'view:quirky.ledger/settings', input: { repoId: 'repo-1' } })
  expect(host.querySelector('[data-ledger-view="page"]')).not.toBeNull()
})

function mountRouter(world: World): void {
  world.activate()
}

test('actual activate router addresses DOM panel controls, explicit instances, and focused legacy controls', async () => {
  const world = createWorld({ layout: { focus: 'view', view: { id: VIEW_ID }, panel: PANEL_ID, worktree: 'wt-2' } })
  mountRouter(world)
  const page = await mountRouterSlot(world, VIEW_ID, { target: { owner: PROJECT_OWNER } })
  const panel = await mountRouterSlot(world, PANEL_ID)
  await settle()
  expect(operationCalls(world, 'list').some((call) => JSON.stringify(call.params.target) === JSON.stringify({ owner: PROJECT_OWNER }))).toBe(true)
  expect(operationCalls(world, 'list').some((call) => JSON.stringify(call.params.target) === JSON.stringify({ workspaceId: 'wt-2' }))).toBe(true)
  const pageInstance = world.lastReport('page').instance as string
  const panelInstance = world.lastReport('panel').instance as string
  expect(typeof pageInstance).toBe('string')
  expect(typeof panelInstance).toBe('string')
  expect(panelInstance).not.toBe(pageInstance)

  await press(namedButton(panel, 'Filter ledger')!)
  expect(world.lastReport('panel').filtersOpen).toBe(true)
  expect(world.lastReport('page').filtersOpen).toBe(false)
  await world.routerControl({ action: 'filters-open', open: true, instance: pageInstance })
  await settle()
  expect(world.lastReport('page').filtersOpen).toBe(true)
  expect(world.lastReport('panel').filtersOpen).toBe(true)

  await world.routerControl({ action: 'filters-open', open: false })
  await settle()
  expect(world.lastReport('page').filtersOpen).toBe(false)
  expect(world.lastReport('panel').filtersOpen).toBe(true)
})

test('auxiliary-window DOM controls use their own exact numeric connection and never executeCommand', async () => {
  const world = createWorld({ connectionId: 83 })
  const host = await mountPage(world)
  await settle()
  await press(namedButton(host, 'Filter ledger')!)
  expect(world.executeCommandCalls).toBe(0)
  expect(methodCalls(world, 'ui.window.self').at(-1)?.params).toEqual({})
  const exact = methodCalls(world, 'ui.window.command.run').at(-1)!
  expect(exact.params).toMatchObject({ connId: 83, id: CONTROL_ID, args: { action: 'filters-open', open: true, instance: world.lastReport('page').instance } })
})

test('actual activate rejects stale explicit instance without fallback, opening, or queueing', async () => {
  const world = createWorld({ layout: { focus: 'view', view: { id: VIEW_ID }, panel: PANEL_ID } })
  mountRouter(world)
  const page = await mountRouterSlot(world, VIEW_ID, { target: { owner: PROJECT_OWNER } })
  await mountRouterSlot(world, PANEL_ID)
  await settle()
  const stale = world.lastReport('panel').instance
  const cleanup = routerCleanups.pop()!
  await act(async () => { cleanup(); await Promise.resolve() })
  const opens = world.opened.length
  await expect(world.routerControl({ action: 'chooser', instance: stale })).rejects.toThrow('Ledger UI instance is no longer mounted.')
  expect(world.opened).toHaveLength(opens)
  expect(page.querySelector('[data-ledger-view="page"]')).not.toBeNull()
})

test('actual activate requires a mounted controller for prepare, confirm, and dismiss', async () => {
  const world = createWorld()
  mountRouter(world)
  for (const command of [
    { action: 'prepare', kind: 'delete-ledger' },
    { action: 'confirm' },
    { action: 'dismiss', dialog: 'detail' }
  ]) {
    await expect(world.routerControl(command)).rejects.toThrow('Ledger action requires a mounted ledger.')
  }
  expect(world.opened).toHaveLength(0)
  expect(operationCalls(world, 'delete-ledger')).toHaveLength(0)
})

test('unaddressed legacy router commands keep focused open-and-queue behavior', async () => {
  const world = createWorld({ layout: { focus: 'view', view: { id: VIEW_ID } } })
  mountRouter(world)
  const queued = world.routerControl({ action: 'choose', target: { ledgerId: 'ledger-project' } })
  await settle()
  expect(world.opened).toEqual([{ id: VIEW_ID, input: { target: { ledgerId: 'ledger-project' } } }])
  const host = await mountRouterSlot(world, VIEW_ID, { target: { ledgerId: 'ledger-project' } })
  await queued
  await settle()
  expect(host.querySelector('[data-ledger-view="page"]')).not.toBeNull()
  expect(world.lastReport('page').target).toEqual({ ledgerId: 'ledger-project' })
})

test('actual activate validates malformed and missing command context before any side effect', async () => {
  const world = createWorld()
  mountRouter(world)
  const invalid: Array<[unknown, string]> = [
    [{ action: 'refresh', resource: 'toString' }, 'Ledger refresh resource is not supported.'],
    [{ action: 'toString' }, 'Ledger control action is not supported.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: {} }, 'Ledger selections must be an array of id/revision snapshots.'],
    [{ action: 'filters-open', open: 'true' }, 'Ledger filters-open requires a boolean open value.'],
    [{ action: 'filters-open' }, 'Ledger filters-open requires a boolean open value.'],
    [{ action: 'filters', replace: 'yes' }, 'Ledger filters replace must be boolean.'],
    [{ action: 'prepare' }, 'Ledger prepare requires a confirmation kind.'],
    [{ action: 'prepare', kind: 'remove-all' }, 'Ledger confirmation kind is not supported.'],
    [{ action: 'prepare', kind: 'bulk-state' }, 'Ledger bulk-state preparation requires a state.'],
    [{ action: 'prepare', kind: 'bulk-state', state: 'open' }, 'Ledger bulk state must be resolved or archived.'],
    [{ action: 'choose' }, 'Ledger choose requires a target.'],
    [{ action: 'dismiss', dialog: 'unknown' }, 'Ledger dialog is not supported.'],
    [{ action: 'dismiss' }, 'Ledger dismiss requires a dialog.'],
    [{ action: 'prepare', kind: 'attach', attachTo: { tier: 'owner', id: 'x' } }, 'Ledger owner must include a project/group tier and id.'],
    [{ action: 'prepare', kind: 'attach', attachTo: { tier: 'project', id: '' } }, 'Ledger owner must include a project/group tier and id.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: [] }, 'Ledger preparation requires 1 to 10000 entry snapshots.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: Array.from({ length: 10_001 }, (_, index) => ({ id: `id-${index}`, revision: 1 })) }, 'Ledger preparation requires 1 to 10000 entry snapshots.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: [{ id: 'same', revision: 1 }, { id: 'same', revision: 2 }] }, 'Ledger preparation selections cannot contain duplicate entry ids.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: [{ id: '', revision: 1 }] }, 'Ledger preparation selections require nonempty ids and positive safe revisions.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: [{ id: 'bug-1', revision: 0 }] }, 'Ledger preparation selections require nonempty ids and positive safe revisions.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: [{ id: 'bug-1', revision: Number.MAX_SAFE_INTEGER + 1 }] }, 'Ledger preparation selections require nonempty ids and positive safe revisions.'],
    [{ action: 'choose', target: { owner: { tier: 'invalid', id: 'x' } } }, 'Ledger owner must include a project/group tier and id.'],
    [{ action: 'prepare', kind: 'delete-ledger', target: { ledgerId: 'ledger-other' } }, 'Ledger prepare cannot include a target.'],
    [{ action: 'confirm', target: { ledgerId: 'ledger-other' } }, 'Ledger confirm cannot include a target.'],
    [{ action: 'dismiss', dialog: 'detail', target: { ledgerId: 'ledger-other' } }, 'Ledger dismiss cannot include a target.'],
    [{ action: 'confirm', operation: 'bulk-state' }, 'Ledger confirm does not accept a confirmation body.'],
    [{ action: 'chooser', instance: '   ' }, 'Ledger UI instance must be a nonempty string.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: [{ id: 'bug-1', revision: 1.5 }] }, 'Ledger preparation selections require nonempty ids and positive safe revisions.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: [{ id: 'bug-1', revision: Number.NaN }] }, 'Ledger preparation selections require nonempty ids and positive safe revisions.'],
    [{ action: 'prepare', kind: 'constructor' }, 'Ledger confirmation kind is not supported.'],
    [{ action: 'refresh', resource: 'constructor' }, 'Ledger refresh resource is not supported.'],
    [{ action: 'prepare', kind: 'delete-entries', selections: [{ id: 'bug-1', revision: '1' }] }, 'Ledger preparation selections require nonempty ids and positive safe revisions.'],
  ]
  const openedBefore = world.opened.length
  for (const [args, message] of invalid) {
    await expect(world.routerControl(args)).rejects.toThrow(message)
    expect(world.opened).toHaveLength(openedBefore)
  }
  expect(operationCalls(world, 'list')).toHaveLength(0)
  expect(world.controllers.size).toBe(0)
})

test('router-mounted confirmation rejects when absent and prepare rejects without authoritative data', async () => {
  const world = createWorld({ layout: { focus: 'view', view: { id: VIEW_ID } } })
  world.ledger.list = () => response(null, { entries: [] })
  mountRouter(world)
  const host = await mountRouterSlot(world, VIEW_ID, { target: { ledgerId: 'ledger-project' } })
  await settle()
  await expect(world.routerControl({ action: 'confirm', instance: world.lastReport('page').instance })).rejects.toThrow('There is no pending ledger confirmation.')
  await expect(world.routerControl({ action: 'prepare', kind: 'delete-ledger', instance: world.lastReport('page').instance })).rejects.toThrow('An authoritative ledger summary is required for this confirmation.')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expectMutationCount(world, 0)
})

test('sidebar Ledger button retains its existing public view route', async () => {
  const world = createWorld()
  mountRouter(world)
  const host = await mountRouterSlot(world, SIDEBAR_ID)
  await settle()
  await press(namedButton(host, 'Ledger')!)
  expect(world.opened.at(-1)).toEqual({ id: VIEW_ID, input: undefined })
})
test('legacy selection normalization cannot smuggle duplicate ids into implicit destructive preparation', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await settle()
  const selections = [{ id: 'bug-1', revision: 1 }, { id: 'bug-1', revision: 2 }]
  await sendControl(world, { action: 'selection', selections }, 'page')
  expect(world.lastReport('page').selection).toEqual(selections)
  await expect(sendControl(world, { action: 'prepare', kind: 'delete-entries' }, 'page')).rejects.toThrow()
  await settle()
  expect(world.lastReport('page').dialog).toBe('none')
  expectMutationCount(world, 0)
  expect(host.querySelector('[role=\"dialog\"]')).toBeNull()
})

test('chooser cannot refresh entries without a target through the actual router', async () => {
  const world = createWorld({ layout: { focus: 'view', view: { id: VIEW_ID } } })
  mountRouter(world)
  const host = await mountRouterSlot(world, VIEW_ID)
  await settle()
  expect(host.querySelector('[data-ledger-view=\"chooser\"]')).not.toBeNull()
  const instance = world.lastReport('page').instance
  await expect(world.routerControl({ action: 'refresh', resource: 'entries', instance })).rejects.toThrow()
  expect(operationCalls(world, 'list')).toHaveLength(0)
  expect(host.querySelector('[data-ledger-view=\"chooser\"]')).not.toBeNull()
  expect(world.opened).toHaveLength(0)
})

test('same-tick choose invalidates the authoritative summary before destructive preparation', async () => {
  const world = createWorld()
  const host = await mountPage(world)
  await settle()
  await act(async () => {
    await world.rawControl({ action: 'choose', target: { ledgerId: 'ledger-other' } }, 'page')
    await expect(world.rawControl({ action: 'prepare', kind: 'delete-ledger' }, 'page'))
      .rejects.toThrow('An authoritative ledger summary is required for this confirmation.')
  })
  await settle()
  expect(world.lastReport('page').dialog).toBe('none')
  expectMutationCount(world, 0)
  expect(host.querySelector('[role=\"dialog\"]')).toBeNull()
})

test('same-tick workspace change invalidates panel confirmation before confirm can dispatch', async () => {
  const world = createWorld()
  const host = await mountPanel(world)
  await settle()
  await sendControl(world, { action: 'prepare', kind: 'delete-ledger' }, 'panel')
  await settle()
  expect(world.lastReport('panel').dialog).toBe('confirm:delete-ledger')
  await act(async () => {
    world.setLayout({ ...world.layout, worktree: 'wt-2' })
    await expect(world.rawControl({ action: 'confirm' }, 'panel')).rejects.toThrow('There is no pending ledger confirmation.')
  })
  await settle()
  expectMutationCount(world, 0)
  expect(host.querySelector('[role=\"dialog\"]')).toBeNull()
})

for (const failedMethod of ['ui.window.self', 'ui.window.command.run']) {
  test(`failed ${failedMethod} dispatch surfaces its cause without executeCommand fallback`, async () => {
    const world = createWorld({ connectionId: 83 })
    const host = await mountPage(world)
    await settle()
    world.methods.set(failedMethod, () => { throw new Error(`${failedMethod} disconnected`) })
    await press(namedButton(host, 'Filter ledger')!)
    inlineError(host, `${failedMethod} disconnected`)
    expect(world.executeCommandCalls).toBe(0)
    expect(methodCalls(world, 'ui.command.run')).toHaveLength(0)
    if (failedMethod === 'ui.window.self') expect(methodCalls(world, 'ui.window.command.run')).toHaveLength(0)
    else expect(methodCalls(world, 'ui.window.command.run')).toHaveLength(1)
  })
}
