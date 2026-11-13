import { describe, expect, test } from 'bun:test'
import type { PluginContext, PluginNotification, QuirkyEvent, UiState } from '@quirky/protocol'
import { NotificationsService } from '../src/service'

const idle: UiState = { windows: [], layout: { view: null, panel: null, sidebar: true, focus: null }, toasts: [], slots: [] }
const never = () => new Promise<never>(() => {})

const answers = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  'ui.state': idle,
  'status.get': { clients: [{ role: 'desktop' }] },
  'quirky.worktree/resolve': { id: 'w1', name: 'fix-tests', repoId: 'repo_1', kind: 'git' },
  'quirky.repo/resolve': { name: 'quirky', displayName: null },
  'quirky.agents/get': { label: 'Codex' },
  'quirky.session/setUnread': {},
  'quirky.worktree/set': {},
  'quirky.worktree/list': [],
  'quirky.session/list': [],
  'quirky.ask/list': [],
  ...over
})

type ManualClock = {
  setTimeout(run: () => void, delay: number): number
  clearTimeout(handle: unknown): void
  advance(delay: number): void
}

function manualClock(): ManualClock {
  let time = 0
  let nextHandle = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    setTimeout(run: () => void, delay: number) {
      const handle = ++nextHandle
      timers.set(handle, { at: time + delay, run })
      return handle
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number)
    },
    advance(delay: number) {
      const target = time + delay
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) break
        time = next[1].at
        timers.delete(next[0])
        next[1].run()
      }
      time = target
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve()
}

function setup(table: Record<string, unknown>, clock?: ManualClock) {
  const notifications: PluginNotification[] = []
  const logs: string[] = []
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const settings: Record<string, unknown> = {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: false,
    terminalNotifications: true,
    sound: 'system',
    customSoundPath: '',
    volume: 100,
    suppressWhenFocused: true
  }
  const context = {
    pluginId: 'quirky.notifications',
    dir: '/plugin',
    log: (message: string) => logs.push(message),
    emit: () => true,
    getSetting: (name: string) => settings[name],
    notify: (n: PluginNotification) => notifications.push(n),
    error: (_kind: string, message: string) => new Error(message),
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (!(method in table)) throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 })
      const answer = table[method]
      return typeof answer === 'function' ? (answer as () => unknown)() : answer
    }
  } as unknown as PluginContext
  const service = new NotificationsService(context, {
    lookupTimeoutMs: 40,
    ...(clock ? { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } : {})
  })
  return { service, notifications, logs, calls }
}

const settled = (data: Record<string, unknown> = {}) =>
  ({ type: 'quirky.structured/settled', data: { sessionId: 's1', worktreeId: 'w1', agent: 'codex', state: 'done', at: 1, ...data } }) as QuirkyEvent

describe('lookups that never answer', () => {
  test('a never-answering agents lookup still sends the banner with the fallback label, and the queue keeps moving', async () => {
    const { service, notifications, logs } = setup(answers({ 'quirky.agents/get': never }))

    service.onEvent(settled())
    await Bun.sleep(200)
    expect(notifications).toMatchObject([{ title: 'quirky / fix-tests - Codex finished' }])
    expect(logs.some((line) => line.includes('quirky.agents/get'))).toBe(true)

    expect(await service.test()).toEqual({ delivered: true, reason: 'delivered' })
    expect(notifications).toHaveLength(2)
    service.shutdown()
  })

  test('a never-answering repo lookup leaves the repo out of the banner', async () => {
    const { service, notifications } = setup(answers({ 'quirky.repo/resolve': never }))

    service.onEvent(settled())
    await Bun.sleep(200)
    expect(notifications).toMatchObject([{ title: 'fix-tests - Codex finished' }])
    service.shutdown()
  })

  test('a never-answering ui.state is read as nobody viewing', async () => {
    const { service, notifications } = setup(answers({ 'ui.state': never }))

    service.onEvent(settled())
    await Bun.sleep(300)
    expect(notifications).toHaveLength(1)
    service.shutdown()
  })

  test('never-answering marker writes are logged and do not stall later notifications', async () => {
    const { service, notifications, logs } = setup(answers({ 'quirky.session/setUnread': never, 'quirky.worktree/set': never }))

    service.onEvent(settled())
    await Bun.sleep(400)
    expect(notifications).toHaveLength(1)
    expect(logs.some((line) => line.includes('could not mark session s1'))).toBe(true)
    expect(logs.some((line) => line.includes('could not mark worktree w1'))).toBe(true)

    expect(await service.test()).toEqual({ delivered: true, reason: 'delivered' })
    service.shutdown()
  })

  test('a never-answering status.get does not stall delivery', async () => {
    const { service, notifications } = setup(answers({ 'status.get': never }))

    service.onEvent(settled())
    await Bun.sleep(250)
    expect(notifications).toHaveLength(1)
    service.shutdown()
  })
})

describe('identical calls in flight', () => {
  test('four syncs share one never-answering worktree list lookup', async () => {
    const clock = manualClock()
    const { service, calls } = setup(answers({ 'quirky.worktree/list': never }), clock)

    for (let sync = 0; sync < 4; sync++) {
      service.onEvent({ type: 'quirky.session/changed', data: { sessionId: 's1' } } as QuirkyEvent)
      await flushMicrotasks()
      if (sync < 3) {
        clock.advance(120)
        await flushMicrotasks()
      }
    }
    clock.advance(40)
    await flushMicrotasks()

    expect(calls.filter(({ method }) => method === 'quirky.worktree/list')).toHaveLength(1)
    expect(calls.filter(({ method }) => method === 'ui.state').length).toBeGreaterThanOrEqual(4)
    service.shutdown()
  })

  test('identical unread sets share while unread false remains a separate call', async () => {
    const clock = manualClock()
    let uiState = idle
    const { service, calls } = setup(answers({
      'ui.state': () => uiState,
      'quirky.worktree/list': [{ id: 'w1', unread: true }],
      'quirky.worktree/set': never
    }), clock)

    for (let event = 0; event < 3; event++) {
      service.onEvent(settled())
      await flushMicrotasks()
      if (event < 2) {
        clock.advance(200)
        await flushMicrotasks()
      }
    }
    clock.advance(40)
    await flushMicrotasks()

    expect(calls.filter(({ method }) => method === 'quirky.worktree/set').map(({ params }) => params)).toEqual([
      { worktree: 'id:w1', unread: true, unreadSource: 'notifications' }
    ])

    uiState = {
      ...idle,
      windows: [{ connId: 1, focused: true, inputAt: 10, present: true }],
      layout: { ...idle.layout, view: { id: 'view:quirky.session/worktree', input: { worktree: 'w1' } } }
    }
    service.onEvent({ type: 'ui.state.changed' } as QuirkyEvent)
    await flushMicrotasks()
    clock.advance(40)
    await flushMicrotasks()

    expect(calls.filter(({ method }) => method === 'quirky.worktree/set').map(({ params }) => params)).toEqual([
      { worktree: 'id:w1', unread: true, unreadSource: 'notifications' },
      { worktree: 'id:w1', unread: false, unreadSource: 'notifications' }
    ])
    service.shutdown()
  })

  test('a settled worktree list call frees its key before the next sync', async () => {
    const clock = manualClock()
    const { service, calls } = setup(answers({
      'quirky.worktree/list': () => {
        const { promise, resolve } = Promise.withResolvers<unknown[]>()
        clock.setTimeout(() => resolve([]), 80)
        return promise
      }
    }), clock)

    const first = service.status()
    await flushMicrotasks()
    clock.advance(200)
    await flushMicrotasks()
    const second = service.status()
    await flushMicrotasks()
    clock.advance(40)
    await flushMicrotasks()
    await Promise.all([first, second])
    clock.advance(40)
    await flushMicrotasks()

    expect(calls.filter(({ method }) => method === 'quirky.worktree/list')).toHaveLength(2)
    service.shutdown()
  })

  test('each joined caller keeps its own timeout and the existing log message', async () => {
    const clock = manualClock()
    const { service, calls, logs } = setup(answers({ 'quirky.worktree/list': never }), clock)

    let firstSettled = false
    const first = service.status().then(() => { firstSettled = true })
    await flushMicrotasks()
    clock.advance(20)
    let secondSettled = false
    const second = service.status().then(() => { secondSettled = true })
    await flushMicrotasks()
    clock.advance(20)
    await flushMicrotasks()

    expect(firstSettled).toBe(true)
    expect(secondSettled).toBe(false)
    clock.advance(20)
    await flushMicrotasks()
    await Promise.all([first, second])

    expect(calls.filter(({ method }) => method === 'quirky.worktree/list')).toHaveLength(1)
    expect(logs).toEqual([
      'quirky.worktree/list failed: quirky.worktree/list did not answer within 40ms',
      'quirky.worktree/list failed: quirky.worktree/list did not answer within 40ms'
    ])
    service.shutdown()
  })
})
