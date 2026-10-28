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

function setup(enabled = true) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const opened: { id: string; input?: unknown }[] = []
  const provided = new Map<string, unknown>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layout: { view: { id: string; input?: unknown } | null } = { view: null }
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
      if (method === 'quirky.agent-status/dashboard') return snapshotFor(params)
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
    onConnection: () => () => {},
    confirm: async () => true,
    toast() {},
    setPanelBadge() {},
    getSetting: (name: string) => (name === 'dashboard-enabled' || name === 'setting:quirky.agent-status/dashboard-enabled' ? enabled : undefined),
    createCommandDrag: () => 'drag',
    consumeCommandDrag: () => null,
    cancelCommandDrag() {},
    setContext() {},
    mountView: () => () => {}
  } as unknown as UiPluginContext

  activate(context)
  return {
    calls,
    opened,
    provided,
    layout,
    async mount(id: string, input?: unknown) {
      let cleanup = () => {}
      await act(async () => {
        const implementation = provided.get(id) as ((element: HTMLElement, props: { input?: unknown }) => () => void) | undefined
        if (!implementation) throw new Error(`no UI mount for ${id}`)
        cleanup = implementation(host, { input })
      })
      if (id === VIEW) await act(async () => waitForRenderedElement('[data-dashboard-column="attention"]'))
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


test('Dashboard navigation is setting-gated and the public open/toggle commands preserve view input', async () => {
  const hidden = setup(false)
  const hiddenCleanup = await hidden.mount(SIDEBAR)
  expect(host.querySelector('button.dashboard-navigation')).toBeNull()
  await hiddenCleanup()

  const h = setup(true)
  const cleanup = await h.mount(SIDEBAR)
  const navigation = host.querySelector<HTMLButtonElement>('button.dashboard-navigation')!
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
  expect([...host.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['Needs you', 'Working', 'Done'])
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
test('opening a Dashboard card acknowledges its exact Activity turn and navigates to its exact session', async () => {
  const h = setup()
  const cleanup = await h.mount(VIEW)
  await click(host.querySelector<HTMLButtonElement>('button[aria-label=\"Open dashboard thread s-wait\"]')!)

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

  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Clear dashboard filters"]')!)
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: { showIdle: true } })
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search dashboard"]')?.value).toBe('')
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Project"]')?.value).toBe('')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Workspace status"]')?.value).toBe('')
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="GitHub review status"]')?.value).toBe('')
  await cleanup()
})
