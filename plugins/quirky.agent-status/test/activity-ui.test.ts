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
        return {
          threads: data
            .filter((entry) => !params.worktree || entry.worktreeId === params.worktree)
            .filter((entry) => !params.unreadOnly || entry.unread)
            .filter((entry) => !text || [entry.prompt, entry.agent, entry.worktreeName, entry.sessionName].some((value) => value.toLocaleLowerCase().includes(text)))
            .map((entry) => ({ ...entry }))
        }
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
        const completed = data.filter((entry) => entry.display === 'done' && (!params.worktree || params.worktree === entry.worktreeId))
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
    async mount(id: string, input?: unknown) {
      let cleanup = () => {}
      await act(async () => {
        const implementation = provided.get(id)
        if (typeof implementation !== 'function') throw new Error(`no UI mount for ${id}`)
        cleanup = implementation(host, { input })
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


test('Activity navigation opens the grouped feed; filters, children and clear-completed act on visible threads', async () => {
  const h = setup()
  const cleanup = await h.mount(SIDEBAR)
  const navigation = host.querySelector<HTMLButtonElement>('button[aria-label^="Activity"]')!
  expect(navigation.textContent).toContain('Activity')
  await click(navigation)
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: { group: 'status' } })
  const openActivity = h.provided.get(OPEN_ACTIVITY) as (args?: unknown) => void
  await act(async () => openActivity({ worktree: '', text: ' ', group: 'status' }))
  expect(h.opened.at(-1)).toEqual({ id: VIEW, input: { group: 'status' } })
  await cleanup()

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

  await click(host.querySelector('button[aria-label="Clear completed activity"]')!)
  expect(h.calls.some((call) => call.method === 'quirky.agent-status/clearCompleted')).toBe(true)
  expect(host.querySelector('[data-session-id="s-done"]')).toBeNull()
  expect(host.querySelector('[data-session-id="s-work"]')).not.toBeNull()
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
