import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { QuirkyEvent, Session, UiPluginContext } from '@quirky/protocol'
import type { ActivityThread } from '../src/activity-types'

const SIDEBAR = 'sidebar-section:quirky.agent-status/activity'
const VIEW = 'view:quirky.agent-status/activity'
const OPEN_ACTIVITY = 'command:quirky.agent-status/openActivity'
const OPEN_THREAD = 'command:quirky.agent-status/openActivityThread'
const SESSION_VIEW = 'view:quirky.session/worktree'

type Call = { method: string; params: Record<string, unknown> }
type SessionRow = Pick<Session, 'id' | 'kind' | 'worktreeId' | 'status'> & { name: string; title: string }

let activate: (context: UiPluginContext) => void
let act: (callback: () => unknown) => Promise<void>
let host: HTMLElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Load ReactDOM and the plugin after the test DOM has been registered.
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

const thread = (overrides: Partial<ActivityThread> = {}): ActivityThread => ({
  sessionId: 's-wait',
  worktreeId: 'wt1',
  worktreeName: 'main',
  sessionName: 'review',
  agent: 'claude',
  turn: 'turn-1',
  turnStartedAt: 10,
  updatedAt: 20,
  display: 'waiting',
  label: 'Waiting',
  prompt: 'release checklist',
  detail: 'Which branch?',
  children: [{ id: 'reviewer-9', kind: 'agent', state: 'waiting' }],
  unread: true,
  live: true,
  ...overrides
})

const makeSession = (id: string, worktreeId: string, status: Session['status'] = 'working'): SessionRow => ({
  id,
  kind: 'terminal',
  worktreeId,
  status,
  name: id,
  title: id
})

function setup() {
  const data: ActivityThread[] = [
    thread(),
    thread({
      sessionId: 's-work',
      worktreeId: 'wt2',
      worktreeName: 'feature',
      sessionName: 'implement',
      agent: 'codex',
      turn: 'turn-2',
      turnStartedAt: 30,
      display: 'working',
      label: 'Working',
      prompt: 'audit portal',
      detail: 'Editing routes',
      children: [],
      unread: true
    }),
    thread({
      sessionId: 's-done',
      turn: 'turn-3',
      turnStartedAt: 5,
      display: 'done',
      label: 'Done',
      prompt: 'finished release',
      detail: 'Completed',
      children: [],
      unread: false
    })
  ]
  const sessions = new Map<string, SessionRow>([
    ['s-wait', makeSession('s-wait', 'wt1')],
    ['s-work', makeSession('s-work', 'wt2')],
    ['s-done', makeSession('s-done', 'wt1', 'done')]
  ])
  const calls: Call[] = []
  const opened: { id: string; input?: unknown }[] = []
  const provided = new Map<string, unknown>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  let raceNextAcknowledge = false
  let nextClearGate: Promise<void> | null = null
  const activityCallWaiters: (() => void)[] = []

  const context = {
    pluginId: 'quirky.agent-status',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.agent-status/activity') {
        const text = typeof params.text === 'string' ? params.text.toLocaleLowerCase() : ''
        const result = {
          threads: data
            .filter((entry) => !params.worktree || entry.worktreeId === params.worktree)
            .filter((entry) => !params.unreadOnly || entry.unread)
            .filter((entry) => !text || [entry.prompt, entry.agent, entry.worktreeName, entry.sessionName].some((value) => value.toLocaleLowerCase().includes(text)))
            .map((entry) => ({ ...entry }))
        }
        for (const resolve of activityCallWaiters.splice(0)) resolve()
        return result
      }
      if (method === 'quirky.agent-status/acknowledge') {
        if (raceNextAcknowledge) {
          raceNextAcknowledge = false
          const old = data.find((entry) => entry.sessionId === params.session)
          if (old && old.turn === params.turn) {
            data[data.indexOf(old)] = { ...old, turn: 'turn-new', turnStartedAt: 40, prompt: 'new concurrent turn', unread: true }
          }
        }
        const entry = data.find((item) => item.sessionId === params.session && item.turn === params.turn)
        if (!entry || !entry.unread) return { acknowledged: 0 }
        entry.unread = false
        return { acknowledged: 1 }
      }
      if (method === 'quirky.agent-status/clearCompleted') {
        const gate = nextClearGate
        nextClearGate = null
        if (gate) await gate
        const completed = data.filter((entry) => (entry.display === 'done' || entry.display === 'failed' || entry.display === 'interrupted') && (!params.worktree || params.worktree === entry.worktreeId))
        for (const entry of completed) data.splice(data.indexOf(entry), 1)
        return { cleared: completed.length }
      }
      if (method === 'quirky.session/get') {
        const session = sessions.get(String(params.session))
        if (!session) throw new Error('session unavailable')
        return session
      }
      if (method === 'quirky.worktree/resolve') {
        const worktreeId = String(params.selector).replace(/^id:/, '')
        if (!['wt1', 'wt2'].includes(worktreeId)) throw new Error('workspace unavailable')
        return { id: worktreeId }
      }
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
      opened.push({ id, input })
    },
    closeView() {},
    togglePanel() {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => true,
    toast() {},
    setPanelBadge() {},
    getSetting: () => undefined,
    createCommandDrag: () => 'drag',
    consumeCommandDrag: () => null,
    cancelCommandDrag() {},
    setContext() {},
    mountView: () => () => {}
  } as unknown as UiPluginContext

  void activate(context)
  return {
    calls,
    data,
    opened,
    provided,
    sessions,
    makeRace: () => (raceNextAcknowledge = true),
    deferNextClear() {
      const gate = Promise.withResolvers<void>()
      nextClearGate = gate.promise
      return () => gate.resolve()
    },
    waitForNextActivityCall() {
      const waiter = Promise.withResolvers<void>()
      activityCallWaiters.push(waiter.resolve)
      return waiter.promise
    },
    async mount(id: string, input?: unknown, target: HTMLElement = host) {
      let cleanup = () => {}
      await act(async () => {
        const implementation = provided.get(id) as ((element: HTMLElement, options: { input?: unknown }) => () => void) | undefined
        if (!implementation) throw new Error(`no UI mount for ${id}`)
        cleanup = implementation(target, { input })
      })
      if (id === VIEW) await act(async () => waitForRenderedElement('[data-session-id="s-wait"]'))
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
  const element = host.querySelector(selector)
  if (element) {
    observer.disconnect()
    resolve(element)
  }
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


function waitForActivityText(text: string): Promise<void> {
  if (host.textContent?.includes(text)) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const observer = new MutationObserver(() => {
    if (!host.textContent?.includes(text)) return
    observer.disconnect()
    resolve()
  })
  observer.observe(host, { childList: true, characterData: true, subtree: true })
  return promise
}

test('Activity sidebar renders its empty state and disables clear-completed', async () => {
  const h = setup()
  h.data.splice(0)
  const cleanup = await h.mount(SIDEBAR)
  expect(host.querySelector('main')).not.toBeNull()
  await act(async () => waitForActivityText('No Activity threads yet.'))
  expect(host.querySelector('[role="status"]')?.textContent).toContain('No Activity threads yet.')
  expect(host.querySelector('input[aria-label="Worktree ID"]')).toBeNull()
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Clear completed activity"]')?.disabled).toBe(true)
  expect(h.opened).toEqual([])
  await cleanup()
})

test('Activity sidebar filters and groups its populated feed in place and clears completed threads', async () => {
  const h = setup()
  const cleanup = await h.mount(SIDEBAR)
  expect(host.querySelector('main')).not.toBeNull()
  await act(async () => waitForRenderedElement('[data-session-id="s-wait"]'))
  expect(host.querySelectorAll('[data-activity-group]')).toHaveLength(3)
  expect(host.querySelector('[data-session-id="s-done"]')).not.toBeNull()
  expect(host.querySelector('input[aria-label="Worktree ID"]')).toBeNull()
  expect(h.opened).toEqual([])

  const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear completed activity"]')!
  expect(clear.disabled).toBe(false)
  await click(clear)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/clearCompleted')).toHaveLength(1)
  expect(h.data.some((entry) => entry.display === 'done')).toBe(false)
  expect(host.querySelector('[data-session-id="s-done"]')).toBeNull()
  expect(clear.disabled).toBe(true)

  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search Activity"]')!
  await typeInto(search, 'audit')
  await click(host.querySelector('button[aria-label="Apply Activity filters"]')!)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/activity').at(-1)?.params).toMatchObject({ text: 'audit' })
  expect(host.querySelector('[data-session-id="s-wait"]')).toBeNull()
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()

  await selectValue(host.querySelector<HTMLSelectElement>('select[aria-label="Group Activity by"]')!, 'worktree')
  expect([...host.querySelectorAll<HTMLElement>('[data-activity-group]')].map((group) => group.dataset.activityGroup)).toEqual(['wt2'])
  const unread = host.querySelector<HTMLInputElement>('input[aria-label="Unread only"]')!
  await act(async () => unread.click())
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/activity').at(-1)?.params).toMatchObject({ text: 'audit', unreadOnly: true })
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()
  expect(h.opened).toEqual([])
  await cleanup()
})

test('Activity sidebar refreshes a completed clear with the latest filters', async () => {
  const h = setup()
  const cleanup = await h.mount(SIDEBAR)
  await act(async () => waitForRenderedElement('[data-session-id="s-wait"]'))
  const releaseClear = h.deferNextClear()
  await click(host.querySelector('button[aria-label="Clear completed activity"]')!)

  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search Activity"]')!
  await typeInto(search, 'audit')
  await click(host.querySelector('button[aria-label="Apply Activity filters"]')!)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/activity').at(-1)?.params).toMatchObject({ text: 'audit' })
  expect(host.querySelector('[data-session-id="s-wait"]')).toBeNull()
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()

  const nextRefresh = h.waitForNextActivityCall()
  releaseClear()
  await act(async () => nextRefresh)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/activity').at(-1)?.params).toMatchObject({ text: 'audit' })
  expect(host.querySelector('[data-session-id="s-wait"]')).toBeNull()
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()
  expect(h.opened).toEqual([])
  await cleanup()
})

for (const display of ['failed', 'interrupted'] as const) {
  test(`Activity sidebar enables clearing ${display} threads`, async () => {
    const h = setup()
    h.data.splice(0, h.data.length, thread({
      sessionId: `s-${display}`,
      turn: `turn-${display}`,
      display,
      label: display,
      children: [],
      unread: false
    }))
    const cleanup = await h.mount(SIDEBAR)
    await act(async () => waitForRenderedElement(`[data-session-id="s-${display}"]`))
    const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear completed activity"]')!
    expect(clear.disabled).toBe(false)
    await click(clear)
    expect(h.calls.filter((call) => call.method === 'quirky.agent-status/clearCompleted')).toHaveLength(1)
    expect(h.data).toHaveLength(0)
    expect(host.querySelector(`[data-session-id="s-${display}"]`)).toBeNull()
    expect(clear.disabled).toBe(true)
    expect(h.opened).toEqual([])
    await cleanup()
  })
}

test('Activity controls keep labels local when sidebar and center feeds are mounted together', async () => {
  const h = setup()
  const cleanupSidebar = await h.mount(SIDEBAR)
  const centerHost = document.createElement('div')
  document.body.append(centerHost)
  const cleanupCenter = await h.mount(VIEW, { group: 'status' }, centerHost)

  try {

    for (const surface of [host, centerHost]) {
      const fields = [
        ['Search Activity', 'input[aria-label="Search Activity"]'],
        ['Unread only', 'input[aria-label="Unread only"]'],
        ['Group by', 'select[aria-label="Group Activity by"]']
      ] as const
      for (const [labelText, selector] of fields) {
        const label = [...surface.querySelectorAll<HTMLLabelElement>('label')].find((entry) => entry.textContent?.trim() === labelText)!
        const control = surface.querySelector(selector)!
        expect(document.getElementById(label.htmlFor) === control).toBe(true)
      }
    }
  } finally {
    await cleanupCenter()
    await cleanupSidebar()
  }
})

test('Activity command opens the grouped center feed and center filters remain scriptable', async () => {
  const h = setup()
  const openActivity = h.provided.get(OPEN_ACTIVITY) as (args?: unknown) => void
  await act(async () => openActivity({ worktree: '', text: ' ', group: 'status' }))
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: { group: 'status' } })

  const unmount = await h.mount(VIEW, { group: 'status' })
  const groups = [...host.querySelectorAll<HTMLElement>('[data-activity-group]')].map((section) => section.dataset.activityGroup)
  expect(groups).toEqual(['waiting', 'working', 'done'])
  expect(host.querySelector('[data-child-id="reviewer-9"]')).toBeNull()
  await click(host.querySelector('button[aria-label="Show child agents for s-wait"]')!)
  expect(host.querySelector('[data-child-id="reviewer-9"]')?.textContent).toContain('waiting')
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/acknowledge').at(-1)?.params).toEqual({ session: 's-wait', turn: 'turn-1' })
  expect(h.data.find((entry) => entry.sessionId === 's-wait')?.unread).toBe(false)

  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search Activity"]')!
  await typeInto(search, 'audit')
  await click(host.querySelector('button[aria-label="Apply Activity filters"]')!)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/activity').at(-1)?.params).toMatchObject({ text: 'audit' })
  expect(h.opened.at(-1)?.input).toMatchObject({ text: 'audit', group: 'status' })
  expect(h.opened.at(-1)?.input).not.toHaveProperty('worktree')
  expect(host.querySelector('[data-session-id="s-wait"]')).toBeNull()
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()

  const group = host.querySelector<HTMLSelectElement>('select[aria-label="Group Activity by"]')!
  await selectValue(group, 'worktree')
  expect(h.opened.at(-1)?.input).toMatchObject({ text: 'audit', group: 'worktree' })
  expect(h.opened.at(-1)?.input).not.toHaveProperty('worktree')

  const unread = host.querySelector<HTMLInputElement>('input[aria-label="Unread only"]')!
  await act(async () => {
    unread.click()
  })
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/activity').at(-1)?.params).toMatchObject({ unreadOnly: true })
  expect(h.opened.at(-1)?.input).toMatchObject({ text: 'audit', unreadOnly: true, group: 'worktree' })
  expect(h.opened.at(-1)?.input).not.toHaveProperty('worktree')
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()

  await act(async () => {
    unread.click()
  })
  expect(h.opened.at(-1)?.input).not.toHaveProperty('worktree')

  const workspace = host.querySelector<HTMLInputElement>('input[aria-label="Worktree ID"]')!
  await typeInto(workspace, 'wt1')
  await click(host.querySelector('button[aria-label="Apply Activity filters"]')!)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/activity').at(-1)?.params).toMatchObject({ text: 'audit', worktree: 'wt1' })
  expect(host.querySelector('[data-session-id="s-work"]')).toBeNull()
  expect(host.querySelector('[role="status"]')).not.toBeNull()

  await typeInto(workspace, 'wt2')
  await click(host.querySelector('button[aria-label="Apply Activity filters"]')!)
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()

  await act(async () => {
    unread.click()
  })
  expect(h.opened.at(-1)?.input).toMatchObject({ text: 'audit', worktree: 'wt2', unreadOnly: true, group: 'worktree' })

  const ackCount = h.calls.filter((call) => call.method === 'quirky.agent-status/acknowledge').length
  await click(host.querySelector('button[aria-label="Mark all read"]')!)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/acknowledge')).toHaveLength(ackCount + 1)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/acknowledge').at(-1)?.params).toEqual({ session: 's-work', turn: 'turn-2' })
  expect(host.querySelector('[data-session-id="s-work"]')).toBeNull()
  expect(host.querySelector('[role="status"]')).not.toBeNull()

  await act(async () => {
    unread.click()
  })
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()
  await typeInto(search, '')
  await typeInto(workspace, '')
  await click(host.querySelector('button[aria-label="Apply Activity filters"]')!)
  expect(host.querySelector('[data-session-id="s-done"]')).not.toBeNull()
  const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear completed activity"]')!
  expect(clear.disabled).toBe(false)
  await click(clear)
  expect(h.calls.some((call) => call.method === 'quirky.agent-status/clearCompleted')).toBe(true)
  expect(host.querySelector('[data-session-id="s-done"]')).toBeNull()
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()
  expect(clear.disabled).toBe(true)

  await unmount()
})


test('Mark read acknowledges only the observed thread turn', async () => {
  const h = setup()
  const unmount = await h.mount(VIEW, { group: 'status' })
  const card = host.querySelector('[data-session-id="s-work"]')!
  const button = Array.from(card.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === 'Mark read')!
  await click(button)
  expect(h.calls.filter((call) => call.method === 'quirky.agent-status/acknowledge').at(-1)?.params).toEqual({ session: 's-work', turn: 'turn-2' })
  expect(h.data.find((entry) => entry.sessionId === 's-work')?.unread).toBe(false)
  await unmount()
})

test('opening an observed thread acknowledges its exact turn and navigates only to its exact live session', async () => {
  const h = setup()
  const command = h.provided.get(OPEN_THREAD) as (args: unknown) => Promise<void>
  h.makeRace()
  await act(async () => {
    await command({ sessionId: 's-wait', worktreeId: 'wt1', turn: 'turn-1' })
  })
  expect(h.calls.find((call) => call.method === 'quirky.agent-status/acknowledge')?.params).toEqual({ session: 's-wait', turn: 'turn-1' })
  expect(h.data.find((entry) => entry.sessionId === 's-wait')).toMatchObject({ turn: 'turn-new', unread: true })
  expect(h.opened.at(-1)).toEqual({ id: SESSION_VIEW, input: { worktree: 'wt1', session: 's-wait' } })

  const openedCount = h.opened.length
  h.sessions.set('s-wait', makeSession('s-wait', 'wt1', 'exited'))
  await expect(command({ sessionId: 's-wait', worktreeId: 'wt1', turn: 'turn-new' })).rejects.toThrow(/unavailable/i)
  expect(h.opened).toHaveLength(openedCount)
})
