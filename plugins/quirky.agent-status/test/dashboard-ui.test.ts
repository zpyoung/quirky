import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ActivityThread } from '../src/activity-types'
import type { DashboardCard, DashboardSnapshot } from '../src/dashboard-types'

const SIDEBAR = 'sidebar-section:quirky.agent-status/dashboard'
const VIEW = 'view:quirky.agent-status/dashboard'
const OPEN = 'command:quirky.agent-status/openDashboard'
const TOGGLE = 'command:quirky.agent-status/toggleDashboard'
const REVIEW_UNAVAILABLE = 'GitHub review status unavailable for wt3: authentication unavailable'

let activate: (context: UiPluginContext) => void
let act: (callback: () => unknown) => Promise<void>
let host: HTMLElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The test DOM must exist before React DOM and the plugin module are loaded.
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})

const thread = (sessionId: string, display: ActivityThread['display'], detail: string, unread = true): ActivityThread => ({
  sessionId,
  worktreeId: sessionId === 's-work' ? 'wt2' : sessionId === 's-idle' ? 'wt3' : 'wt1',
  worktreeName: sessionId === 's-work' ? 'feature' : 'main',
  sessionName: sessionId,
  agent: 'claude',
  turn: `turn-${sessionId}`,
  turnStartedAt: 10,
  updatedAt: 20,
  display,
  label: display,
  prompt: `prompt ${sessionId}`,
  detail,
  children: [],
  unread,
  live: true
})

const allCards: DashboardCard[] = [
  { bucket: 'attention', thread: thread('s-wait', 'waiting', 'Bash: git status') },
  { bucket: 'working', thread: thread('s-work', 'working', 'Editing routes') },
  { bucket: 'done', thread: thread('s-done', 'done', 'Completed', false) },
  { bucket: 'idle', thread: thread('s-idle', 'idle', 'No recent update', false) }
]
type DashboardCall = (
  params: Record<string, unknown>,
  attempt: number,
  fallback: DashboardSnapshot
) => DashboardSnapshot | Promise<DashboardSnapshot>

type SetupOptions = {
  dashboardCall?: DashboardCall
}

function setup(enabled = true, openAs: 'in-window' | 'pop-out' = 'in-window', options: SetupOptions = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const windows: Record<string, unknown>[] = []
  const opened: { id: string; input?: unknown }[] = []
  const provided = new Map<string, unknown>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const layout: { view: { id: string; input?: unknown } | null } = { view: null }
  let latestDashboardCall: Promise<DashboardSnapshot> | undefined
  const dashboardCalls = new Set<Promise<DashboardSnapshot>>()
  const snapshotFor = (query: Record<string, unknown>): DashboardSnapshot => {
    const showIdle = query.showIdle === true
    const cards = showIdle ? allCards : allCards.filter(({ bucket }) => bucket !== 'idle')
    return {
      cards,
      total: 4,
      hiddenIdle: showIdle ? 0 : 1,
      unavailable: query.reviewStatus === 'open' ? [REVIEW_UNAVAILABLE] : []
    }
  }
  const context = {
    pluginId: 'quirky.agent-status',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.agent-status/dashboard') {
        const attempt = calls.filter((call) => call.method === method).length
        const fallback = snapshotFor(params)
        const dashboardCall = Promise.resolve().then(() =>
          options.dashboardCall ? options.dashboardCall(params, attempt, fallback) : fallback
        )
        latestDashboardCall = dashboardCall
        dashboardCalls.add(dashboardCall)
        void dashboardCall.then(
          () => dashboardCalls.delete(dashboardCall),
          () => dashboardCalls.delete(dashboardCall)
        )
        return dashboardCall
      }
      if (method === 'desktop.window.open') {
        windows.push(params)
        return { windowId: `window-${windows.length}` }
      }
      if (method === 'quirky.session/get') {
        const target = allCards.find(({ thread: entry }) => entry.sessionId === params.session)?.thread
        if (!target) throw new Error('session unavailable')
        return { id: target.sessionId, kind: 'terminal', worktreeId: target.worktreeId, status: 'working' }
      }
      if (method === 'quirky.worktree/resolve') return { id: String(params.selector).replace(/^id:/, '') }
      if (method === 'quirky.agent-status/acknowledge') return { acknowledged: 1 }
      throw new Error(`unexpected call ${method}`)
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    executeCommand: async (id: string, args?: unknown) => {
      const command = provided.get(id) as ((args?: unknown) => unknown) | undefined
      if (!command) throw new Error(`unknown command ${id}`)
      await command(args)
    },
    openView(id: string, input?: unknown) {
      layout.view = { id, input }
      opened.push({ id, input })
    },
    closeView() {
      layout.view = null
    },
    togglePanel() {},
    getLayout: () => ({ ...layout, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection(listener: (status: 'connected' | 'reconnecting') => void) {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
    confirm: async () => true,
    toast() {},
    setPanelBadge() {},
    getSetting: (name: string) => {
      if (name === 'dashboard-enabled' || name === 'setting:quirky.agent-status/dashboard-enabled') return enabled
      if (name === 'dashboard-open-as' || name === 'setting:quirky.agent-status/dashboard-open-as') return openAs
      return undefined
    },
    createCommandDrag: () => 'drag',
    consumeCommandDrag: () => null,
    cancelCommandDrag() {},
    setContext() {},
    mountView: () => () => {}
  } as unknown as UiPluginContext

  activate(context)
  return {
    calls,
    emit(event: QuirkyEvent) {
      for (const listener of listeners) void listener(event)
    },
    emitConnection(status: 'connected' | 'reconnecting') {
      for (const listener of connectionListeners) listener(status)
    },
    async settleDashboardCalls() {
      await Promise.all([...dashboardCalls].map((dashboardCall) => dashboardCall.then(() => undefined, () => undefined)))
    },
    async settleLatestDashboardCall() {
      await latestDashboardCall?.then(() => undefined, () => undefined)
    },
    opened,
    provided,
    windows,
    layout,
    async mount(id: string, input?: unknown, waitForColumns = true) {
      let cleanup = () => {}
      await act(async () => {
        const implementation = provided.get(id) as ((element: HTMLElement, props: { input?: unknown }) => () => void) | undefined
        if (!implementation) throw new Error(`no UI mount for ${id}`)
        cleanup = implementation(host, { input })
      })
      if (id === VIEW && waitForColumns) await act(async () => waitForRenderedElement('[data-dashboard-column="attention"]'))
      return () => act(async () => cleanup())
    }
  }
}

function waitForRenderedElement(selector: string): Promise<Element> {
  const existing = host.querySelector(selector)
  if (existing) return Promise.resolve(existing)
  const { promise, resolve } = Promise.withResolvers<Element>()
  const observer = new MutationObserver(() => {
    const element = host.querySelector(selector)
    if (!element) return
    observer.disconnect()
    resolve(element)
  })
  observer.observe(host, { childList: true, subtree: true })
  return promise
}

const click = (element: Element) => act(async () => void (element as HTMLElement).click())
const typeInto = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const selectValue = (select: HTMLSelectElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })

test('Dashboard renders EmptyState while the initial load is pending', async () => {
  const pending = Promise.withResolvers<DashboardSnapshot>()
  const h = setup(true, 'in-window', { dashboardCall: () => pending.promise })
  const cleanup = await h.mount(VIEW, undefined, false)

  try {
    expect(host.querySelector('.ui-empty-state')?.textContent).toContain('Loading Agent Dashboard…')
    expect(host.querySelector('.ui-text-muted')).toBeNull()
  } finally {
    pending.resolve({ cards: [], total: 0, hiddenIdle: 0, unavailable: [] })
    await cleanup()
  }
})

test('Dashboard initial load failure offers Retry and restores columns', async () => {
  const h = setup(true, 'in-window', {
    dashboardCall: (_params, attempt, fallback) => {
      if (attempt === 1) throw new Error('dashboard query failed')
      return fallback
    }
  })
  const cleanup = await h.mount(VIEW, undefined, false)

  try {
    await act(async () => h.settleDashboardCalls())
    const error = host.querySelector<HTMLElement>('.ui-inline-error[role="alert"]')
    const retry = error?.querySelector<HTMLButtonElement>('.ui-inline-error__action')
    expect(error?.textContent).toContain('dashboard query failed')
    expect(error?.querySelector('.ui-inline-error__dismiss')).toBeNull()
    expect(retry?.textContent).toBe('Retry')

    if (retry) await click(retry)
    expect(host.querySelector('[data-dashboard-column="attention"]')).not.toBeNull()
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard')).toHaveLength(2)
  } finally {
    await cleanup()
  }
})

test('Dashboard refresh failure keeps fetched columns visible and offers Retry', async () => {
  const h = setup(true, 'in-window', {
    dashboardCall: (_params, attempt, fallback) => {
      if (attempt === 2) throw new Error('dashboard query failed')
      return fallback
    }
  })
  const cleanup = await h.mount(VIEW)

  try {
    expect(host.querySelector('[data-dashboard-column="attention"]')).not.toBeNull()
    await act(async () => {
      h.emit({ type: 'quirky.agent-status/changed', data: {} })
      await h.settleDashboardCalls()
    })

    const error = host.querySelector<HTMLElement>('.ui-inline-error[role="alert"]')
    const retry = error?.querySelector<HTMLButtonElement>('.ui-inline-error__action')
    expect(error?.textContent).toContain('dashboard query failed')
    expect(error?.querySelector('.ui-inline-error__dismiss')).toBeNull()
    expect(retry?.textContent).toBe('Retry')
    expect(host.querySelector('[data-dashboard-column="attention"]')).not.toBeNull()

    if (retry) await click(retry)
    expect(host.querySelector('[data-dashboard-column="attention"]')).not.toBeNull()
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard')).toHaveLength(3)
  } finally {
    await cleanup()
  }
})
test('Dashboard ignores an older query result when newer filters finish first', async () => {
  const pending = Promise.withResolvers<DashboardSnapshot>()
  const h = setup(true, 'in-window', {
    dashboardCall: (_params, attempt, fallback) => {
      if (attempt === 1) return pending.promise
      const card = fallback.cards[0]!
      return {
        ...fallback,
        cards: [{ ...card, thread: { ...card.thread, sessionId: 's-current-filter', sessionName: 'Filtered result' } }],
        total: 1,
        hiddenIdle: 0
      }
    }
  })
  const cleanup = await h.mount(VIEW, { text: 'old' }, false)

  try {
    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Search dashboard"]')!, 'new')
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="Apply dashboard filters"]')!)
    await act(async () => h.settleLatestDashboardCall())
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard')).toHaveLength(2)
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard').at(-1)?.params).toEqual({ text: 'new' })

    pending.resolve({ cards: allCards, total: 99, hiddenIdle: 0, unavailable: [] })
    await act(async () => h.settleDashboardCalls())
    expect(host.querySelector('[data-session-id="s-current-filter"]')).not.toBeNull()
    expect(host.querySelector('[data-session-id="s-wait"]')).toBeNull()
    expect(host.textContent).toContain('1 total')
  } finally {
    pending.resolve({ cards: allCards, total: 99, hiddenIdle: 0, unavailable: [] })
    await cleanup()
  }
})

test('Dashboard reloads when the connection is restored', async () => {
  const h = setup()
  const cleanup = await h.mount(VIEW)

  try {
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard')).toHaveLength(1)
    await act(async () => {
      h.emitConnection('reconnecting')
      await h.settleDashboardCalls()
    })
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard')).toHaveLength(1)
    await act(async () => {
      h.emitConnection('connected')
      await h.settleDashboardCalls()
    })
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard')).toHaveLength(2)
  } finally {
    await cleanup()
  }
})

test('Dashboard unavailable notice offers Retry through the dashboard query', async () => {
  const h = setup()
  const cleanup = await h.mount(VIEW, { reviewStatus: 'open' })

  try {
    const unavailable = host.querySelector<HTMLElement>('.ui-inline-error[role="alert"]')
    const retry = unavailable?.querySelector<HTMLButtonElement>('.ui-inline-error__action')
    expect(unavailable?.textContent).toContain(`Unavailable: ${REVIEW_UNAVAILABLE}`)
    expect(unavailable?.querySelector('.ui-inline-error__dismiss')).toBeNull()
    expect(retry?.textContent).toBe('Retry')

    const previousCalls = h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard').length
    if (retry) await click(retry)
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard')).toHaveLength(previousCalls + 1)
  } finally {
    await cleanup()
  }
})


test('Dashboard navigation is setting-gated and the public open/toggle commands preserve view input', async () => {
  const hidden = setup(false)
  const hiddenCleanup = await hidden.mount(SIDEBAR)
  expect(host.querySelector('button[aria-label^="Agent Dashboard"]')).toBeNull()
  await hiddenCleanup()

  const h = setup(true)
  const cleanup = await h.mount(SIDEBAR)
  const navigation = host.querySelector<HTMLButtonElement>('button[aria-label^="Agent Dashboard"]')!
  expect(navigation.getAttribute('aria-label')).toContain('Agent Dashboard')
  await click(navigation)
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: {} })

  const open = h.provided.get(OPEN) as (args?: unknown) => void
  const toggle = h.provided.get(TOGGLE) as (args?: unknown) => void
  await act(async () => open({ text: 'release', project: 'repo-a', showIdle: true }))
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: { text: 'release', project: 'repo-a', showIdle: true } })
  await act(async () => toggle({ text: 'release', project: 'repo-a', showIdle: true }))
  expect(h.layout.view).toBeNull()
  await act(async () => toggle({ text: 'release', project: 'repo-a', showIdle: true }))
  expect(h.layout.view).toEqual({ id: VIEW, input: { text: 'release', project: 'repo-a', showIdle: true } })
  await cleanup()
})

test('Dashboard renders three status columns, truthful hidden-idle total, readable detail and reveal', async () => {
  const h = setup()
  const cleanup = await h.mount(VIEW, { text: 'release' })
  const columns = [...host.querySelectorAll<HTMLElement>('[data-dashboard-column]')]
  expect(columns.map((column) => column.dataset.dashboardColumn)).toEqual(['attention', 'working', 'done'])
  expect(host.querySelector('[data-session-id="s-done"]')?.textContent).toContain('Completed')
  expect(host.querySelector('[data-session-id="s-wait"]')?.textContent).toContain('Bash: git status')
  expect(host.textContent).toContain('4 total')
  expect(host.textContent).toContain('1 idle hidden')
  expect(host.querySelector('[data-session-id="s-idle"]')).toBeNull()

  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Show idle threads (1)"]')!)
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: { text: 'release', showIdle: true } })
  expect(host.querySelector('[data-dashboard-column="idle"]')).not.toBeNull()
  expect(host.querySelector('[data-session-id="s-idle"]')?.textContent).toContain('No recent update')
  expect(host.textContent).toContain('4 total')
  await cleanup()
})
test('Dashboard draws its title once, with Pop out in the frame header and the idle toggle on the rail', async () => {
  const h = setup()
  const cleanup = await h.mount(VIEW, { text: 'release' })
  const titles = [...host.querySelectorAll('h2')].filter((heading) => heading.textContent === 'Agent Dashboard')
  expect(titles).toHaveLength(1)
  expect(titles[0].closest('.ui-tool-panel-frame__header')).not.toBeNull()
  expect(host.querySelector('button[aria-label="Pop out"]')?.closest('.ui-tool-panel-frame__header .ui-tool-panel-frame__actions')).not.toBeNull()
  expect(host.querySelector('button[aria-label="Show idle threads (1)"]')?.closest('.ui-tool-panel-frame__rail')).not.toBeNull()
  expect(host.querySelector('[data-dashboard-column="attention"] .ui-section-header__title')?.textContent).toBe('Needs you')
  await cleanup()
})
test('opening a Dashboard card acknowledges its exact Activity turn and navigates to its exact session', async () => {
  const h = setup()
  const cleanup = await h.mount(VIEW)
  const card = host.querySelector<HTMLElement>('[data-session-id="s-wait"]')!
  await click(card.querySelector<HTMLButtonElement>('button')!)

  expect(h.calls.filter((call) => call.method === 'quirky.session/get').at(-1)?.params).toEqual({ session: 's-wait' })
  expect(h.calls.filter((call) => call.method === 'quirky.worktree/resolve').at(-1)?.params).toEqual({ selector: 'id:wt1' })
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/acknowledge').at(-1)?.params).toEqual({
    session: 's-wait',
    turn: 'turn-s-wait'
  })
  expect(h.opened.at(-1)).toEqual({ id: 'view:quirky.session/worktree', input: { worktree: 'wt1', session: 's-wait' } })
  await cleanup()
})


test('Dashboard filter controls follow scriptable input, report unavailable review data and clear only filters', async () => {
  const h = setup()
  const input = { text: 'release', project: 'repo-a', workspaceStatus: 'in-review', reviewStatus: 'open', showIdle: true }
  const cleanup = await h.mount(VIEW, input)
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search dashboard"]')?.value).toBe('release')
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Project"]')?.value).toBe('repo-a')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Workspace status"]')?.value).toBe('in-review')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="GitHub review status"]')?.value).toBe('open')
  expect(h.calls.find((call) => call.method === 'quirky.agent-status/dashboard')?.params).toEqual(input)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('authentication unavailable')

  await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Search dashboard"]')!, 'alpha')
  await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Project"]')!, 'repo-b')
  await selectValue(host.querySelector<HTMLSelectElement>('select[aria-label="Workspace status"]')!, 'todo')
  await selectValue(host.querySelector<HTMLSelectElement>('select[aria-label="GitHub review status"]')!, 'no-review')

  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Apply dashboard filters"]')!)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/dashboard').at(-1)?.params).toEqual({
    text: 'alpha', project: 'repo-b', workspaceStatus: 'todo', reviewStatus: 'no-review', showIdle: true
  })
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: { text: 'alpha', project: 'repo-b', workspaceStatus: 'todo', reviewStatus: 'no-review', showIdle: true } })
  await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Search dashboard"]')!, 'unsaved search')
  await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Project"]')!, 'unsaved project')
  await selectValue(host.querySelector<HTMLSelectElement>('select[aria-label="Workspace status"]')!, 'done')
  await selectValue(host.querySelector<HTMLSelectElement>('select[aria-label="GitHub review status"]')!, 'merged')

  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Clear dashboard filters"]')!)
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: { showIdle: true } })
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search dashboard"]')?.value).toBe('')
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Project"]')?.value).toBe('')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Workspace status"]')?.value).toBe('')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="GitHub review status"]')?.value).toBe('')
  await cleanup()
})
