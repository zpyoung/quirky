import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { MountFunction, QuirkyEvent, UiLayout, UiPluginContext } from '../../../packages/protocol/src'

type DirtyResult = {
  worktreeId: string | null
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

function status(worktreeId: string | null, count: number, capped: boolean, title: string): DirtyResult {
  return { worktreeId, count, capped, title, dirty: count > 0, available: true }
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function makeTransport(responses: DirtyResponse[]) {
  const provided = new Map<string, unknown>()
  const calls: Call[] = []
  const dirtyRequests: Promise<DirtyResult>[] = []
  const dirtyCallWaiters = new Map<number, () => void>()
  const dirtyCallCount = () => calls.filter((call) => call.method === 'quirky.sidebar-extras/dirty').length
  const panelToggles: { id: string; open?: boolean }[] = []
  const eventListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  let currentLayout = layout('wt-fix')

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
          active: typeof worktreeId === 'string' ? { worktreeId, instanceId: 'ui-test-instance' } : null,
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
    }
  }
}

async function mountItem(responses: DirtyResponse[]) {
  const transport = makeTransport(responses)
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
