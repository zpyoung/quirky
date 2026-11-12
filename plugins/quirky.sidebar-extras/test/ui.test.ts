import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { MountFunction, QuirkyEvent, UiLayout, UiPluginContext } from '../../../packages/protocol/src'

type DirtyResult = {
  worktreeId: string | null
  instanceId: string | null
  count: number
  capped: boolean
  title: string
  dirty: boolean
  available: boolean
  error?: string
}

type DirtyResponse = () => Promise<DirtyResult>
type Call = { method: string; params: Record<string, unknown> }

const SLOT = 'activity-item:quirky.sidebar-extras/source-control'
const PANEL = 'panel:quirky.git/source-control'
const STOCK_TITLE = 'Source Control'

let activate: (context: UiPluginContext) => void
let unmountItem: (() => void) | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Load after happy-dom installs window globals, matching the mounted plugin runtime.
  ;({ activate } = await import('../src/ui'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (unmountItem) {
    const cleanup = unmountItem
    unmountItem = null
    await act(async () => cleanup())
  }
  document.body.innerHTML = ''
})

function layout(worktree: string | null): UiLayout {
  return {
    view: worktree === null ? null : { id: 'view:global' },
    worktree,
    panel: null,
    sidebar: true,
    focus: null
  }
}

function status(
  worktreeId: string | null,
  count: number,
  capped: boolean,
  title: string,
  instanceId: string | null = worktreeId === null ? null : 'ui-test-instance'
): DirtyResult {
  return { worktreeId, instanceId, count, capped, title, dirty: count > 0, available: true }
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}
async function waitForMacrotask(): Promise<void> {
  // Event-triggered work is chained through microtasks; one timer turn makes call counts final.
  const macrotask = Promise.withResolvers<void>()
  setTimeout(macrotask.resolve, 0)
  await macrotask.promise
}

function makeTransport(responses: DirtyResponse[], initialLayout: UiLayout = layout('wt-fix')) {
  const provided = new Map<string, unknown>()
  const calls: Call[] = []
  const dirtyRequests: Promise<DirtyResult>[] = []
  const dirtyCallWaiters = new Map<number, () => void>()
  const dirtyCallCount = () => calls.filter((call) => call.method === 'quirky.sidebar-extras/dirty').length
  const panelToggles: { id: string; open?: boolean }[] = []
  const eventListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const activationInstanceIds = new Map<string, string>()
  let activationError: string | null = null
  let currentLayout = initialLayout

  const context = {
    pluginId: 'quirky.sidebar-extras',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation)
    },
    call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ method, params })
      if (method === 'quirky.sidebar-extras/dirty') {
        for (const [count, resolve] of dirtyCallWaiters) {
          if (dirtyCallCount() < count) continue
          dirtyCallWaiters.delete(count)
          resolve()
        }
        const next = responses.shift()
        if (!next) return Promise.reject(new Error('unexpected dirty status request'))
        const request = next()
        dirtyRequests.push(request)
        return request
      }
      if (method === 'quirky.session/get') return Promise.resolve({ worktreeId: 'wt-session' })
      if (method === 'quirky.sidebar-extras/activate') {
        if (activationError !== null) return Promise.reject(new Error(activationError))
        const worktree = params.worktree
        const worktreeId = typeof worktree === 'string' && worktree.startsWith('id:') ? worktree.slice(3) : worktree
        return Promise.resolve({
          client: 'desktop',
          preferences: {
            workspaceActivityWindow: 'all',
            workspaceActivityCustomDays: 30,
            alwaysShowDefaultBranchWorkspace: true,
            workspaceActivityWindowBeforeLiveOnly: 'all'
          },
          active: typeof worktreeId === 'string'
            ? { worktreeId, instanceId: activationInstanceIds.get(worktreeId) ?? 'ui-test-instance' }
            : null,
          visits: {},
          exits: {}
        })
      }
      return Promise.reject(new Error(`unexpected call ${method}`))
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    getSetting: () => undefined,
    executeCommand: async () => {},
    openView() {},
    closeView() {},
    togglePanel(id: string, open?: boolean) {
      panelToggles.push({ id, open })
    },
    getLayout: () => currentLayout,
    onLayout(listener: (value: UiLayout) => void) {
      layoutListeners.add(listener)
      return () => void layoutListeners.delete(listener)
    },
    onStream: () => () => {},
    onConnection(listener: (value: 'connected' | 'reconnecting') => void) {
      connectionListeners.add(listener)
      return () => void connectionListeners.delete(listener)
    },
    confirm: async () => true,
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView: () => () => {}
  } as unknown as UiPluginContext

  return {
    context,
    provided,
    calls,
    dirtyRequests,
    panelToggles,
    dirtyCallCount,
    waitForDirtyCalls(count: number) {
      if (dirtyCallCount() >= count) return Promise.resolve()
      const gate = Promise.withResolvers<void>()
      dirtyCallWaiters.set(count, gate.resolve)
      return gate.promise
    },
    setActivationInstanceId(worktreeId: string, instanceId: string) {
      activationInstanceIds.set(worktreeId, instanceId)
    },
    setActivationError(message: string | null) {
      activationError = message
    },
    setLayoutSilently(next: UiLayout) {
      currentLayout = next
    },
    async deliverEvent(type: string, data: unknown = {}) {
      const event = { type, data } as QuirkyEvent
      await act(async () => {
        for (const listener of [...eventListeners]) await listener(event)
      })
      await waitForMacrotask()
    },
    async setLayout(next: UiLayout) {
      currentLayout = next
      await act(async () => {
        for (const listener of [...layoutListeners]) listener(next)
        await Promise.resolve()
      })
    },
    async reconnect() {
      await act(async () => {
        for (const listener of [...connectionListeners]) listener('connected')
        await Promise.resolve()
      })
      await waitForMacrotask()
    }
  }
}

async function mountItem(responses: DirtyResponse[], initialLayout: UiLayout = layout('wt-fix')) {
  const transport = makeTransport(responses, initialLayout)
  activate(transport.context)
  const mount = transport.provided.get(SLOT) as MountFunction | undefined
  if (!mount) throw new Error(`the extras UI did not provide ${SLOT}`)

  const element = document.createElement('div')
  document.body.append(element)
  const reports: unknown[] = []
  await act(async () => {
    const cleanup = mount(element, { report: (report) => reports.push(report) })
    unmountItem = typeof cleanup === 'function' ? cleanup : null
  })
  return { ...transport, element, reports }
}



function expectAccessibleTitle(element: HTMLElement, title: string): void {
  const button = element.querySelector('button')
  expect(button).not.toBeNull()
  expect(element.querySelector('svg')).toBeNull()
  expect(button?.getAttribute('title')).toBe(title)
  expect(button?.getAttribute('aria-label')).toContain(title)
}

test('the mounted activity item reports singular, plural and capped status and clears stale decoration on errors', async () => {
  const singular = status('wt-fix', 1, false, 'Source Control — 1 uncommitted change')
  const plural = status('wt-other', 2, false, 'Source Control — 2 uncommitted changes')
  const capped = status('wt-many', 1_000, true, 'Source Control — 1000+ uncommitted changes')
  const singularResponse = deferred<DirtyResult>()
  const pluralResponse = deferred<DirtyResult>()
  const cappedResponse = deferred<DirtyResult>()
  const failedResponse = deferred<DirtyResult>()
  const item = await mountItem([
    () => singularResponse.promise,
    () => pluralResponse.promise,
    () => cappedResponse.promise,
    () => failedResponse.promise
  ])

  await item.waitForDirtyCalls(1)
  await act(async () => {
    singularResponse.resolve(singular)
    await item.dirtyRequests[0]!
  })
  expectAccessibleTitle(item.element, singular.title)
  expect(item.element.textContent).toContain('1')
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: singular.worktreeId,
    count: 1,
    capped: false,
    title: singular.title,
    available: true
  })

  await item.setLayout(layout('wt-other'))
  await item.waitForDirtyCalls(2)
  await act(async () => {
    pluralResponse.resolve(plural)
    await item.dirtyRequests[1]!
  })
  expectAccessibleTitle(item.element, plural.title)
  expect(item.element.textContent).toContain('2')
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: 'wt-other', count: 2, capped: false, title: plural.title, available: true })

  await item.setLayout(layout('wt-many'))
  await item.waitForDirtyCalls(3)
  await act(async () => {
    cappedResponse.resolve(capped)
    await item.dirtyRequests[2]!
  })
  expectAccessibleTitle(item.element, capped.title)
  expect(item.element.textContent).toContain('1000+')
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: 'wt-many', count: 1_000, capped: true, title: capped.title, available: true })

  await item.reconnect()
  await item.waitForDirtyCalls(4)
  await act(async () => {
    failedResponse.reject(new Error('Git status unavailable'))
    await item.dirtyRequests[3]!.catch(() => undefined)
  })
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-many',
    count: 0,
    capped: false,
    title: STOCK_TITLE,
    available: false,
    error: expect.stringContaining('Git status unavailable')
  })
  expectAccessibleTitle(item.element, STOCK_TITLE)
  expect(item.element.textContent).not.toContain('1000+')

  await act(async () => item.element.querySelector('button')?.click())
  expect(item.panelToggles.at(-1)?.id).toBe(PANEL)
})


test('the item leaves its icon to the host and keeps only the button, the dirty count and a failure dot', async () => {
  const dirty = status('wt-fix', 3, false, 'Source Control — 3 uncommitted changes')
  const item = await mountItem([() => Promise.resolve(dirty)])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  expect(item.element.querySelector('svg')).toBeNull()
  expect(item.element.querySelectorAll('button')).toHaveLength(1)
  expect(item.element.querySelector('.ui-badge')?.textContent).toBe('3')
  expect(item.element.querySelector('.ui-status-dot')).toBeNull()
})

test('a clean worktree still says so to assistive tech, with no dot or badge on the stripe', async () => {
  const item = await mountItem([() => Promise.resolve(status('wt-fix', 0, false, 'Source Control'))])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  const button = item.element.querySelector('button')
  expect(button?.getAttribute('aria-label')).toBe('Source Control — no uncommitted changes')
  expect(button?.getAttribute('title')).toBe('Source Control')
  expect(item.element.querySelector('.ui-badge')).toBeNull()
  expect(item.element.querySelector('.ui-status-dot')).toBeNull()
})

test('a delayed dirty response cannot overwrite a newer workspace status', async () => {
  const delayed = deferred<DirtyResult>()
  const latest = deferred<DirtyResult>()
  const newer = status('wt-other', 0, false, STOCK_TITLE)
  const item = await mountItem([() => delayed.promise, () => latest.promise])
  await item.waitForDirtyCalls(1)

  await item.setLayout(layout('wt-other'))
  await item.waitForDirtyCalls(2)
  await act(async () => {
    latest.resolve(newer)
    await item.dirtyRequests[1]!
  })
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-other',
    count: 0,
    capped: false,
    title: STOCK_TITLE,
    available: true
  })

  await act(async () => {
    delayed.resolve(status('wt-fix', 3, false, 'Source Control — 3 uncommitted changes'))
    await item.dirtyRequests[0]!
  })
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-other',
    count: 0,
    title: STOCK_TITLE,
    available: true
  })
  expectAccessibleTitle(item.element, STOCK_TITLE)
  expect(item.element.textContent).not.toContain('3')
})

test('a structured session projects its own workspace instead of the retained layout selection', async () => {
  const staleResponse = deferred<DirtyResult>()
  const sessionStatus = status('wt-session', 1, false, 'Source Control — 1 uncommitted change')
  const item = await mountItem([() => staleResponse.promise, () => Promise.resolve(sessionStatus)])
  await item.waitForDirtyCalls(1)

  await item.setLayout({
    ...layout('wt-layout'),
    view: { id: 'view:quirky.session/structured', input: { session: 'session-1' } }
  })
  await item.waitForDirtyCalls(2)
  await act(async () => { await item.dirtyRequests[1]! })

  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate').at(-1)).toMatchObject({
    params: { worktree: 'id:wt-session' }
  })
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: 'wt-session', count: 1, available: true })

  await act(async () => {
    staleResponse.resolve(status('wt-fix', 3, false, 'Source Control — 3 uncommitted changes'))
    await item.dirtyRequests[0]!
  })
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: 'wt-session', count: 1, available: true })
})

test('unmounting ignores an in-flight status response and unsubscribes layout refreshes', async () => {
  const initialResponse = deferred<DirtyResult>()
  const delayed = deferred<DirtyResult>()
  const initial = status('wt-fix', 0, false, STOCK_TITLE)
  const item = await mountItem([() => initialResponse.promise, () => delayed.promise])
  await item.waitForDirtyCalls(1)
  await act(async () => {
    initialResponse.resolve(initial)
    await item.dirtyRequests[0]!
  })
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-fix',
    count: 0,
    capped: false,
    title: STOCK_TITLE,
    available: true
  })

  await item.setLayout(layout('wt-other'))
  await item.waitForDirtyCalls(2)
  const reportCount = item.reports.length
  const cleanup = unmountItem
  unmountItem = null
  await act(async () => cleanup?.())

  await act(async () => {
    delayed.resolve(status('wt-other', 4, false, 'Source Control — 4 uncommitted changes'))
    await item.dirtyRequests[1]!
  })
  await item.setLayout(layout('wt-third'))
  await item.reconnect()

  expect(item.dirtyCallCount()).toBe(2)
  expect(item.reports).toHaveLength(reportCount)
  expect(item.element.querySelector('button')).toBeNull()
})

test('reads status with the activated workspace for layout, structured-session and no-workspace targets', async () => {
  const item = await mountItem([
    () => Promise.resolve(status('wt-fix', 0, false, STOCK_TITLE)),
    () => Promise.resolve(status('wt-session', 1, false, 'Source Control — 1 uncommitted change')),
    () => Promise.resolve(status(null, 0, false, STOCK_TITLE))
  ])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  await item.setLayout({
    ...layout('wt-layout'),
    view: { id: 'view:quirky.session/structured', input: { session: 'session-1' } }
  })
  await item.waitForDirtyCalls(2)
  expect(item.dirtyCallCount()).toBe(2)
  await act(async () => { await item.dirtyRequests[1]! })

  await item.setLayout(layout(null))
  await item.waitForDirtyCalls(3)
  expect(item.dirtyCallCount()).toBe(3)
  await act(async () => { await item.dirtyRequests[2]! })

  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate').map((call) => call.params)).toEqual([
    { worktree: 'wt-fix' },
    { worktree: 'id:wt-session' },
    { worktree: null }
  ])
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/dirty').map((call) => call.params)).toEqual([
    { worktree: 'id:wt-fix' },
    { worktree: 'id:wt-session' },
    { worktree: null }
  ])
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: null, count: 0, available: true })
})

test('an own-workspace change rereads without reactivation or a transient cleared report', async () => {
  const worktreeRefresh = deferred<DirtyResult>()
  const gitRefresh = deferred<DirtyResult>()
  const item = await mountItem([
    () => Promise.resolve(status('wt-fix', 0, false, STOCK_TITLE)),
    () => worktreeRefresh.promise,
    () => gitRefresh.promise
  ])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  const activationCount = item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate').length
  const reportsBeforeWorktree = item.reports.length
  await item.deliverEvent('quirky.worktree/changed', { repoId: 'repo-1', worktreeId: 'wt-fix' })
  expect(item.dirtyCallCount()).toBe(2)
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(activationCount)
  expect(item.reports.slice(reportsBeforeWorktree)).not.toContain(null)
  expect(item.reports).toHaveLength(reportsBeforeWorktree)
  expect(item.element.querySelector('button')).not.toBeNull()
  expect(item.element.querySelector('button')?.getAttribute('data-available')).not.toBe('unknown')
  await act(async () => {
    worktreeRefresh.resolve(status('wt-fix', 1, false, 'Source Control — 1 uncommitted change'))
    await item.dirtyRequests[1]!
  })
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: 'wt-fix', count: 1, available: true })

  const reportsBeforeGit = item.reports.length
  await item.deliverEvent('quirky.git/changed', { worktreeId: 'wt-fix' })
  expect(item.dirtyCallCount()).toBe(3)
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(activationCount)
  expect(item.reports.slice(reportsBeforeGit)).not.toContain(null)
  expect(item.reports).toHaveLength(reportsBeforeGit)
  expect(item.element.querySelector('button')?.getAttribute('data-available')).not.toBe('unknown')
  await act(async () => {
    gitRefresh.resolve(status('wt-fix', 2, false, 'Source Control — 2 uncommitted changes'))
    await item.dirtyRequests[2]!
  })
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: 'wt-fix', count: 2, available: true })
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/dirty').map((call) => call.params)).toEqual([
    { worktree: 'id:wt-fix' },
    { worktree: 'id:wt-fix' },
    { worktree: 'id:wt-fix' }
  ])
})

test('changes naming another workspace do not call the daemon', async () => {
  const item = await mountItem([() => Promise.resolve(status('wt-fix', 0, false, STOCK_TITLE))])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  const callsBefore = item.calls.length
  await item.deliverEvent('quirky.worktree/changed', { repoId: 'repo-1', worktreeId: 'wt-other' })
  expect(item.calls).toHaveLength(callsBefore)
  await item.deliverEvent('quirky.git/changed', { worktreeId: 'wt-other' })
  expect(item.calls).toHaveLength(callsBefore)
})

test('session, agent-status and structured-message traffic does not call the daemon', async () => {
  const item = await mountItem([() => Promise.resolve(status('wt-fix', 0, false, STOCK_TITLE))])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  const callsBefore = item.calls.length
  for (const type of [
    'quirky.session/changed',
    'quirky.session/removed',
    'quirky.agent-status/changed',
    'quirky.structured/message'
  ]) {
    await item.deliverEvent(type, { sessionId: 'session-1', arbitrary: true })
    expect(item.calls).toHaveLength(callsBefore)
  }
})

test('workspace-less worktree, repository and setting changes each perform one read', async () => {
  const item = await mountItem([
    () => Promise.resolve(status('wt-fix', 0, false, STOCK_TITLE)),
    () => Promise.resolve(status('wt-fix', 1, false, 'Source Control — 1 uncommitted change')),
    () => Promise.resolve(status('wt-fix', 2, false, 'Source Control — 2 uncommitted changes')),
    () => Promise.resolve(status('wt-fix', 3, false, 'Source Control — 3 uncommitted changes'))
  ])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  const activationCount = item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate').length
  const cases = [
    { type: 'quirky.worktree/changed', data: { repoId: 'repo-1' } },
    { type: 'quirky.repo/changed', data: { repoId: 'repo-1' } },
    { type: 'setting.changed', data: { key: 'setting' } }
  ]
  for (const [index, event] of cases.entries()) {
    await item.deliverEvent(event.type, event.data)
    expect(item.dirtyCallCount()).toBe(index + 2)
    expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(activationCount)
    expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/dirty').at(-1)?.params).toEqual({
      worktree: 'id:wt-fix'
    })
    await act(async () => { await item.dirtyRequests[index + 1]! })
  }
})

test('a named workspace change is ignored when the activated target is no workspace', async () => {
  const item = await mountItem(
    [() => Promise.resolve(status(null, 0, false, STOCK_TITLE))],
    layout(null)
  )
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')[0]?.params).toEqual({
    worktree: null
  })
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/dirty')[0]?.params).toEqual({
    worktree: null
  })

  const callsBefore = item.calls.length
  await item.deliverEvent('quirky.git/changed', { worktreeId: 'wt-fix' })
  expect(item.calls).toHaveLength(callsBefore)
  await item.deliverEvent('quirky.worktree/changed', { repoId: 'repo-1', worktreeId: 'wt-fix' })
  expect(item.calls).toHaveLength(callsBefore)
})

test('ui.state.changed reads only after getLayout reports a different workspace', async () => {
  const item = await mountItem([
    () => Promise.resolve(status('wt-fix', 0, false, STOCK_TITLE)),
    () => Promise.resolve(status('wt-other', 1, false, 'Source Control — 1 uncommitted change'))
  ])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  const callsBefore = item.calls.length
  item.setLayoutSilently({ ...layout('wt-fix'), sidebar: false })
  await item.deliverEvent('ui.state.changed')
  expect(item.calls).toHaveLength(callsBefore)

  item.setLayoutSilently(layout('wt-other'))
  await item.deliverEvent('ui.state.changed')
  expect(item.dirtyCallCount()).toBe(2)
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate').map((call) => call.params)).toEqual([
    { worktree: 'wt-fix' },
    { worktree: 'wt-other' }
  ])
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/dirty').at(-1)?.params).toEqual({
    worktree: 'id:wt-other'
  })
  await act(async () => { await item.dirtyRequests[1]! })
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: 'wt-other', count: 1, available: true })
})

test('a replacement workspace instance is reactivated at the next read only', async () => {
  const item = await mountItem([
    () => Promise.resolve(status('wt-fix', 0, false, STOCK_TITLE)),
    () => Promise.resolve(status('wt-fix', 1, false, 'Source Control — 1 uncommitted change', 'instance-2')),
    () => Promise.resolve(status('wt-fix', 2, false, 'Source Control — 2 uncommitted changes', 'instance-2')),
    () => Promise.resolve(status('wt-fix', 3, false, 'Source Control — 3 uncommitted changes', 'instance-2'))
  ])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  await item.deliverEvent('quirky.worktree/changed', { repoId: 'repo-1', worktreeId: 'wt-fix' })
  expect(item.dirtyCallCount()).toBe(2)
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(1)
  await act(async () => { await item.dirtyRequests[1]! })
  expect(item.reports.at(-1)).toMatchObject({ worktreeId: 'wt-fix', count: 1, available: true })

  item.setActivationInstanceId('wt-fix', 'instance-2')
  const passStart = item.calls.length
  await item.deliverEvent('quirky.worktree/changed', { repoId: 'repo-1', worktreeId: 'wt-fix' })
  expect(item.dirtyCallCount()).toBe(3)
  expect(item.calls.slice(passStart).map((call) => call.method)).toEqual([
    'quirky.sidebar-extras/activate',
    'quirky.sidebar-extras/dirty'
  ])
  expect(item.calls.slice(passStart).map((call) => call.params)).toEqual([
    { worktree: 'wt-fix' },
    { worktree: 'id:wt-fix' }
  ])
  await act(async () => { await item.dirtyRequests[2]! })
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(2)

  await item.deliverEvent('quirky.worktree/changed', { repoId: 'repo-1', worktreeId: 'wt-fix' })
  expect(item.dirtyCallCount()).toBe(4)
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(2)
  await act(async () => { await item.dirtyRequests[3]! })
})

test('an unavailable status with no instance id preserves the activation', async () => {
  const unavailable: DirtyResult = {
    ...status('wt-fix', 0, false, STOCK_TITLE, null),
    available: false,
    error: 'no worktree matches id:wt-fix'
  }
  const item = await mountItem([
    () => Promise.resolve(unavailable),
    () => Promise.resolve(status('wt-fix', 1, false, 'Source Control — 1 uncommitted change'))
  ])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-fix',
    available: false,
    error: 'no worktree matches id:wt-fix'
  })

  await item.deliverEvent('quirky.repo/changed', { repoId: 'repo-1' })
  expect(item.dirtyCallCount()).toBe(2)
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(1)
  await act(async () => { await item.dirtyRequests[1]! })
})

test('a rejected activation reports unavailable and named workspace events recover an unknown target', async () => {
  const item = await mountItem([
    () => Promise.resolve(status('wt-fix', 0, false, STOCK_TITLE)),
    () => Promise.resolve(status('wt-fix', 1, false, 'Source Control — 1 uncommitted change')),
    () => Promise.resolve(status('wt-fix', 2, false, 'Source Control — 2 uncommitted changes'))
  ])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })

  item.setActivationError('daemon is restarting')
  await item.reconnect()
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(2)
  expect(item.dirtyCallCount()).toBe(1)
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-fix',
    count: 0,
    available: false,
    error: 'daemon is restarting',
    title: STOCK_TITLE
  })

  item.setActivationError(null)
  const gitPassStart = item.calls.length
  await item.deliverEvent('quirky.git/changed', { worktreeId: 'wt-other' })
  expect(item.dirtyCallCount()).toBe(2)
  expect(item.calls.slice(gitPassStart).map((call) => call.method)).toEqual([
    'quirky.sidebar-extras/activate',
    'quirky.sidebar-extras/dirty'
  ])
  expect(item.calls.slice(gitPassStart).map((call) => call.params)).toEqual([
    { worktree: 'wt-fix' },
    { worktree: 'id:wt-fix' }
  ])
  await act(async () => { await item.dirtyRequests[1]! })

  item.setActivationError('daemon is restarting')
  await item.reconnect()
  expect(item.calls.filter((call) => call.method === 'quirky.sidebar-extras/activate')).toHaveLength(4)
  expect(item.dirtyCallCount()).toBe(2)
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-fix',
    count: 0,
    available: false,
    error: 'daemon is restarting',
    title: STOCK_TITLE
  })

  item.setActivationError(null)
  const worktreePassStart = item.calls.length
  await item.deliverEvent('quirky.worktree/changed', { repoId: 'repo-1', worktreeId: 'wt-other' })
  expect(item.dirtyCallCount()).toBe(3)
  expect(item.calls.slice(worktreePassStart).map((call) => call.method)).toEqual([
    'quirky.sidebar-extras/activate',
    'quirky.sidebar-extras/dirty'
  ])
  expect(item.calls.slice(worktreePassStart).map((call) => call.params)).toEqual([
    { worktree: 'wt-fix' },
    { worktree: 'id:wt-fix' }
  ])
  await act(async () => { await item.dirtyRequests[2]! })
  const callsAfterRecovery = item.calls.length
  await item.deliverEvent('quirky.git/changed', { worktreeId: 'wt-other' })
  expect(item.calls).toHaveLength(callsAfterRecovery)
})

test('missing and non-string instance ids are rejected as invalid dirty statuses', async () => {
  const missing = status('wt-fix', 1, false, 'Source Control — 1 uncommitted change') as
    Omit<DirtyResult, 'instanceId'> & { instanceId?: unknown }
  delete missing.instanceId
  const nonString = {
    ...status('wt-fix', 1, false, 'Source Control — 1 uncommitted change'),
    instanceId: 42
  } as unknown as DirtyResult
  const invalidError = 'sidebar-extras returned an invalid dirty status'
  const item = await mountItem([
    () => Promise.resolve(missing as DirtyResult),
    () => Promise.resolve(nonString)
  ])
  await item.waitForDirtyCalls(1)
  await act(async () => { await item.dirtyRequests[0]! })
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-fix',
    available: false,
    error: invalidError
  })

  await item.reconnect()
  expect(item.dirtyCallCount()).toBe(2)
  await act(async () => { await item.dirtyRequests[1]! })
  expect(item.reports.at(-1)).toMatchObject({
    worktreeId: 'wt-fix',
    available: false,
    error: invalidError
  })
})
