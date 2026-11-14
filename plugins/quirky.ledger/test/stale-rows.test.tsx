import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { LedgerControl } from '../src/ui/types'
import type { LedgerCandidate, LedgerEntry, LedgerOwner, LedgerRequest, LedgerResponse, LedgerSummary } from '../src/types'

type LedgerModule = typeof import('../src/ui/LedgerApp')
let createRoot: typeof CreateRoot
let LedgerApp: LedgerModule['LedgerApp']

const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
const roots: Root[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  createRoot = (await import('react-dom/client')).createRoot
  LedgerApp = (await import('../src/ui/LedgerApp')).LedgerApp
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount())
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type Operation = LedgerRequest['operation']
type Call = { method: string; params: Record<string, unknown> }
type Responder = (params: Record<string, unknown>) => LedgerResponse | Promise<LedgerResponse>
type CallWaiter = { operation: Operation; after: number; resolve(): void }
type RegisterControl = (handler: (control: LedgerControl) => Promise<void>, mode: 'page' | 'panel', instance: string) => () => void
type TestContext = UiPluginContext & { registerControl: RegisterControl }
type Fake = {
  context: TestContext
  calls: Call[]
  on: Partial<Record<Operation, Responder>>
  emit(type: string): void
  whenCalled(operation: Operation, after: number): Promise<void>
  pending: Set<Promise<void>>
}

type Listener = (event: { type: string; data: unknown }) => void | Promise<void>

const RUNTIME: LedgerResponse['runtime'] = { runtimeId: 'runtime-1', profileId: 'profile-1' }
const PROJECT_OWNER: LedgerOwner = { tier: 'project', id: 'repo-1' }
const GROUP_OWNER: LedgerOwner = { tier: 'group', id: 'grp-1' }
const projectSummary: LedgerSummary = {
  ledgerId: 'ledger-project', tier: 'project', owner: PROJECT_OWNER, formerOwner: null, revision: 4,
  entryCount: 1, nextSequence: 2, staleAfterDays: 30, name: 'quirky', ownerName: 'quirky'
}
const groupSummary: LedgerSummary = {
  ledgerId: 'ledger-group', tier: 'group', owner: GROUP_OWNER, formerOwner: null, revision: 2,
  entryCount: 1, nextSequence: 2, staleAfterDays: 30, name: 'platform', ownerName: 'platform'
}
const detachedGroupSummary: LedgerSummary = {
  ...groupSummary, owner: null, formerOwner: GROUP_OWNER, revision: 3
}
const entryAt = (revision: number): LedgerEntry => ({
  id: 'bug-1', type: 'bug', sequence: 1, revision, content: { title: 'Stale row record' }, state: 'open', reviewed: false,
  origin: { workspaceId: 'wt-1', owner: PROJECT_OWNER, branch: 'main', revision: 'abc123', observedAt: '2026-10-30T00:00:00.000Z' },
  createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', history: [],
  latestContentActor: { kind: 'agent', model: 'test-model' }
})
const candidateAt = (revision: number): LedgerCandidate => ({
  entry: entryAt(revision), stale: false, reason: 'unreviewed', evidence: { available: false, workspaceId: 'wt-1', note: 'No recorded evidence.' }
})
const response = (ledger: LedgerSummary | null, fields: Partial<LedgerResponse> = {}): LedgerResponse => ({
  schemaVersion: 1, runtime: RUNTIME, ledger, ...fields
})

function operationCount(world: Pick<Fake, 'calls'>, operation: Operation): number {
  return world.calls.filter((call) => call.method === 'quirky.ledger/request' && call.params.operation === operation).length
}

function fake(): Fake {
  const calls: Call[] = []
  const listeners = new Set<Listener>()
  const waiters = new Set<CallWaiter>()
  const pending = new Set<Promise<void>>()
  const controllers = new Map<string, (control: LedgerControl) => Promise<void>>()
  const on: Fake['on'] = {
    catalog: () => response(null, { ledgers: [projectSummary], owners: [] }),
    list: () => response(projectSummary, { entries: [entryAt(1)] }),
    review: () => response(projectSummary, { candidates: [candidateAt(1)] }),
    approve: () => response(projectSummary),
    'bulk-state': () => response(projectSummary)
  }
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 23 }
      if (method === 'ui.window.command.run') {
        if (params.connId !== 23 || params.id !== 'command:quirky.ledger/control') throw new Error('Unexpected exact-window command route.')
        const command = params.args as LedgerControl
        const handler = controllers.get(command.instance ?? '')
        if (!handler) throw new Error('The addressed ledger controller is not mounted.')
        return handler(command)
      }
      if (method === 'quirky.repo/list') return [{ id: 'repo-1', name: 'quirky', kind: 'git' }]
      if (method === 'quirky.repo/groupList') return []
      if (method === 'quirky.worktree/list') return [{ id: 'wt-1', repoId: 'repo-1', name: 'main', kind: 'git' }]
      if (method !== 'quirky.ledger/request') return []

      const operation = params.operation as Operation
      for (const waiter of [...waiters]) {
        if (waiter.operation === operation && operationCount({ calls }, operation) > waiter.after) {
          waiters.delete(waiter)
          waiter.resolve()
        }
      }
      const responder = on[operation]
      if (!responder) throw new Error(`No fake response configured for ledger operation ${String(params.operation)}.`)
      const answer = responder(params)
      const settled = Promise.resolve(answer).then(() => undefined, () => undefined)
      pending.add(settled)
      try {
        return await answer
      } finally {
        pending.delete(settled)
      }
    },
    getLayout: () => ({ worktree: 'wt-1' }),
    onLayout: () => () => {},
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    openView: () => {},
    registerControl: (handler: (command: LedgerControl) => Promise<void>, _mode: 'page' | 'panel', instance: string) => {
      controllers.set(instance, handler)
      return () => { controllers.delete(instance) }
    }
  } as unknown as TestContext

  return {
    context,
    calls,
    on,
    pending,
    whenCalled(operation, after) {
      if (operationCount({ calls }, operation) > after) return Promise.resolve()
      const waiting = Promise.withResolvers<void>()
      waiters.add({ operation, after, resolve: waiting.resolve })
      return waiting.promise
    },
    emit(type) {
      for (const listener of [...listeners]) void listener({ type, data: {} })
    }
  }
}

/** Drain requests and promise continuations without waiting on wall-clock time. */
async function flushRequests(world: Fake): Promise<void> {
  await act(async () => {
    while (world.pending.size > 0) await Promise.all([...world.pending])
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountPage(context: TestContext, input?: unknown): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<LedgerApp context={context} mode="page" input={input} registerControl={context.registerControl} />))
  return host
}


const namedButton = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)
const dialog = (title: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((item) => item.textContent?.includes(title))
const press = (element: HTMLElement) => act(async () => { element.click() })

async function openTriageWithSelection(world: Fake): Promise<{ host: HTMLElement; triage: HTMLElement }> {
  const host = await mountPage(world.context, { target: { owner: PROJECT_OWNER } })
  await flushRequests(world)
  await press(namedButton(host, 'Triage')!)
  await flushRequests(world)
  const triage = dialog('Operation review')!
  await press(triage.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  expect(namedButton(triage, 'Approve review (1)')).toBeDefined()
  return { host, triage }
}

async function releaseReloads(
  world: Fake,
  list: PromiseWithResolvers<LedgerResponse>,
  review: PromiseWithResolvers<LedgerResponse>
): Promise<void> {
  await act(async () => {
    list.resolve(response(projectSummary, { entries: [entryAt(2)] }))
    review.resolve(response(projectSummary, { candidates: [candidateAt(2)] }))
    await Promise.all([list.promise, review.promise])
  })
  await flushRequests(world)
}

test('an attached chooser row opens by ledger id and withholds catalog-derived actions until the list answers', async () => {
  const world = fake()
  const heldList = Promise.withResolvers<LedgerResponse>()
  world.on.catalog = () => response(null, {
    ledgers: [groupSummary],
    owners: [{ tier: 'group', id: 'grp-live', name: 'Live group' }]
  })
  world.on.list = () => heldList.promise
  const host = await mountPage(world.context)
  await flushRequests(world)
  const listsBefore = operationCount(world, 'list')
  const listStarted = world.whenCalled('list', listsBefore)
  let released = false

  try {
    await press(namedButton(host, 'Open ledger platform')!)
    await act(async () => { await listStarted })

    const listCall = world.calls.filter((call) => call.params.operation === 'list').at(-1)!
    expect(listCall.params.target).toEqual({ ledgerId: 'ledger-group' })
    expect(listCall.params.target).not.toHaveProperty('owner')
    expect(host.querySelector('h2')?.textContent).toBe('platform')
    expect(host.querySelector('.ledger-summary')?.textContent).toMatch(/^Group · /)
    expect(namedButton(host, 'Delete ledger')).toBeUndefined()

    released = true
    await act(async () => {
      heldList.resolve(response(detachedGroupSummary, { entries: [entryAt(1)] }))
      await heldList.promise
    })
    await flushRequests(world)
    expect(namedButton(host, 'Delete ledger')).toBeDefined()
    expect(host.querySelector('select[aria-label="Attach ledger to owner"]')).not.toBeNull()
  } finally {
    if (!released) {
      heldList.resolve(response(detachedGroupSummary, { entries: [entryAt(1)] }))
      await flushRequests(world)
    }
  }
})

test('a chooser row for a deleted ledger shows not-found, retry, and a route back to the chooser', async () => {
  const world = fake()
  world.on.catalog = () => response(null, { ledgers: [groupSummary], owners: [] })
  world.on.list = () => { throw new Error('ledger ledger-group not found') }
  const host = await mountPage(world.context)
  await flushRequests(world)
  const listStarted = world.whenCalled('list', operationCount(world, 'list'))

  await press(namedButton(host, 'Open ledger platform')!)
  await act(async () => { await listStarted })
  await flushRequests(world)

  expect(host.textContent).toContain('Ledger could not be loaded: ledger ledger-group not found')
  expect(namedButton(host, 'Retry')).toBeDefined()
  expect(namedButton(host, 'Open ledger')).toBeDefined()
  await press(namedButton(host, 'Open ledger')!)
  await flushRequests(world)
  expect(host.querySelector('[data-ledger-view="chooser"]')).not.toBeNull()
  expect(host.querySelector('h2')?.textContent).toBe('Open ledger')
})

test('a conflicted confirmed bulk action clears triage candidates while the entry list is held', async () => {
  const world = fake()
  const { triage } = await openTriageWithSelection(world)
  const heldList = Promise.withResolvers<LedgerResponse>()
  const heldReview = Promise.withResolvers<LedgerResponse>()
  const listsBefore = operationCount(world, 'list')
  const listStarted = world.whenCalled('list', listsBefore)
  world.on.list = () => heldList.promise
  world.on.review = () => heldReview.promise
  world.on['bulk-state'] = () => {
    throw Object.assign(new Error('ledger revision conflict'), { data: { kind: 'conflict', currentRevision: 2 } })
  }
  let released = false

  try {
    await press(namedButton(triage, 'Resolve')!)
    await press(namedButton(dialog('Confirm ledger action')!, 'Confirm')!)
    await act(async () => { await listStarted })

    const refreshed = dialog('Operation review')!
    expect(refreshed.querySelector('[role="alert"]')).not.toBeNull()
    expect(refreshed.textContent).not.toContain('revision 1')
    expect(refreshed.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(namedButton(refreshed, 'Approve review (0)')).toBeDefined()

    await releaseReloads(world, heldList, heldReview)
    released = true
    const reloaded = dialog('Operation review')!
    expect(reloaded.textContent).toContain('revision 2')
    expect(reloaded.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
  } finally {
    if (!released) await releaseReloads(world, heldList, heldReview)
  }
})

test('a changed revision event drops a selection not present in the reloaded candidates', async () => {
  const world = fake()
  const { triage } = await openTriageWithSelection(world)
  const reviewsBefore = operationCount(world, 'review')
  const reviewStarted = world.whenCalled('review', reviewsBefore)
  world.on.list = () => response(projectSummary, { entries: [entryAt(2)] })
  world.on.review = () => response(projectSummary, { candidates: [candidateAt(2)] })

  await act(async () => world.emit('quirky.ledger/changed'))
  await act(async () => { await reviewStarted })
  await flushRequests(world)

  const refreshed = dialog('Operation review')!
  expect(refreshed.textContent).toContain('revision 2')
  expect(namedButton(refreshed, 'Approve review (0)')).toBeDefined()
  expect(namedButton(refreshed, 'Approve review (1)')).toBeUndefined()
  expect(refreshed.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  expect(triage).toBe(refreshed)
})

test('an unchanged revision event preserves the selected candidate', async () => {
  const world = fake()
  const { triage } = await openTriageWithSelection(world)
  const reviewsBefore = operationCount(world, 'review')
  const reviewStarted = world.whenCalled('review', reviewsBefore)
  await act(async () => world.emit('quirky.ledger/changed'))
  await act(async () => { await reviewStarted })
  await flushRequests(world)

  const refreshed = dialog('Operation review')!
  expect(refreshed.textContent).toContain('revision 1')
  expect(namedButton(refreshed, 'Approve review (1)')).toBeDefined()
  expect(refreshed.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
  expect(triage).toBe(refreshed)
})

test('a successful approval clears candidates while its entry list reload is held', async () => {
  const world = fake()
  const { triage } = await openTriageWithSelection(world)
  const heldList = Promise.withResolvers<LedgerResponse>()
  const heldReview = Promise.withResolvers<LedgerResponse>()
  const listsBefore = operationCount(world, 'list')
  const listStarted = world.whenCalled('list', listsBefore)
  world.on.list = () => heldList.promise
  world.on.review = () => heldReview.promise
  let released = false

  try {
    await press(namedButton(triage, 'Approve review (1)')!)
    await act(async () => { await listStarted })

    const refreshed = dialog('Operation review')!
    expect(refreshed.textContent).not.toContain('revision 1')
    expect(refreshed.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(namedButton(refreshed, 'Approve review (0)')).toBeDefined()

    await releaseReloads(world, heldList, heldReview)
    released = true
    expect(dialog('Operation review')?.textContent).toContain('revision 2')
  } finally {
    if (!released) await releaseReloads(world, heldList, heldReview)
  }
})

test('a successful confirmed bulk action clears candidates while list and review reloads are held', async () => {
  const world = fake()
  const { triage } = await openTriageWithSelection(world)
  const heldList = Promise.withResolvers<LedgerResponse>()
  const heldReview = Promise.withResolvers<LedgerResponse>()
  const listsBefore = operationCount(world, 'list')
  const listStarted = world.whenCalled('list', listsBefore)
  world.on.list = () => heldList.promise
  world.on.review = () => heldReview.promise
  let released = false

  try {
    await press(namedButton(triage, 'Resolve')!)
    await press(namedButton(dialog('Confirm ledger action')!, 'Confirm')!)
    await act(async () => { await listStarted })

    const refreshed = dialog('Operation review')!
    expect(refreshed.textContent).not.toContain('revision 1')
    expect(refreshed.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(namedButton(refreshed, 'Approve review (0)')).toBeDefined()

    await releaseReloads(world, heldList, heldReview)
    released = true
    expect(dialog('Operation review')?.textContent).toContain('revision 2')
  } finally {
    if (!released) await releaseReloads(world, heldList, heldReview)
  }
})
