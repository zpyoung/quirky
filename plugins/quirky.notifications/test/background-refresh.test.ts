import { afterEach, describe, expect, test } from 'bun:test'
import type { PluginContext, PluginNotification, QuirkyEvent, UiState } from '@quirky/protocol'
import { NotificationsService } from '../src/service'

const idle: UiState = { windows: [], layout: { view: null, panel: null, sidebar: true, focus: null }, toasts: [], slots: [] }
const unread = (id: string, name = id) => ({ id, name, kind: 'git', unread: true, removing: false })
const refreshDiagnostic = (line: string) => JSON.parse(line.slice('notification-worktree-refresh '.length)) as Record<string, unknown>

function manualClock() {
  let time = 0
  let nextHandle = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => time,
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
    },
    activeTimers: () => timers.size
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve()
}

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function setup(overrides: Record<string, unknown> = {}) {
  const clock = manualClock()
  const notifications: PluginNotification[] = []
  const logs: string[] = []
  const events: { event: string; data: unknown }[] = []
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
  const table: Record<string, unknown> = {
    'ui.state': idle,
    'status.get': { clients: [{ role: 'desktop' }] },
    'quirky.worktree/list': [],
    'quirky.session/list': [],
    'quirky.ask/list': [],
    'quirky.session/setUnread': {},
    'quirky.worktree/set': {},
    ...overrides
  }
  const context = {
    pluginId: 'quirky.notifications',
    dir: '/plugin',
    log: (message: string) => logs.push(message),
    emit: (event: string, data: unknown) => {
      events.push({ event, data })
      return true
    },
    getSetting: (name: string) => settings[name],
    notify: (notification: PluginNotification) => notifications.push(notification),
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind, code: kind === 'conflict' ? -32009 : -32602 }),
    call: (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (!(method in table)) return Promise.reject(Object.assign(new Error(`unknown method: ${method}`), { code: -32601 }))
      const answer = table[method]
      try {
        return Promise.resolve(typeof answer === 'function' ? (answer as (params?: Record<string, unknown>) => unknown)(params) : answer)
      } catch (error) {
        return Promise.reject(error)
      }
    }
  } as unknown as PluginContext
  const service = new NotificationsService(context, {
    now: clock.now,
    monotonicNow: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    lookupTimeoutMs: 40
  })
  return { service, clock, notifications, logs, events, calls }
}

const settingChanged = (): QuirkyEvent => ({ type: 'setting.changed', id: 'setting:quirky.notifications/enabled', value: true }) as QuirkyEvent
const listCalls = (calls: { method: string }[]) => calls.filter(({ method }) => method === 'quirky.worktree/list')
const changedEvents = (events: { event: string; data: unknown }[]) => events.filter(({ event }) => event === 'changed')
const diagnostics = (logs: string[]) => logs.filter((line) => line.startsWith('notification-worktree-refresh ')).map(refreshDiagnostic)

const activeServices = new Set<NotificationsService>()
afterEach(() => {
  for (const service of activeServices) service.shutdown()
  activeServices.clear()
})

function register(service: NotificationsService): void {
  activeServices.add(service)
}

describe('background worktree refresh integration', () => {
  test('startup discovery does not block delivery and the first unread snapshot publishes its badge', async () => {
    const read = deferred<unknown[]>()
    const h = setup({ 'quirky.worktree/list': () => read.promise })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    expect(listCalls(h.calls)).toHaveLength(1)

    const delivery = h.service.test()
    await flushMicrotasks()
    await expect(delivery).resolves.toEqual({ delivered: true, reason: 'delivered' })
    expect(h.notifications).toHaveLength(1)
    expect(changedEvents(h.events)).toEqual([])

    h.clock.advance(2000)
    await flushMicrotasks()
    expect(diagnostics(h.logs).map(({ event }) => event)).toEqual(['slow'])

    h.clock.advance(500)
    read.resolve([unread('w1')])
    await flushMicrotasks()
    expect(changedEvents(h.events)).toEqual([{ event: 'changed', data: { badge: 1 } }])
    expect(diagnostics(h.logs).map(({ event, outcome, elapsedMs }) => ({ event, outcome, elapsedMs }))).toEqual([
      { event: 'slow', outcome: undefined, elapsedMs: 2000 },
      { event: 'finished', outcome: 'ok', elapsedMs: 2500 }
    ])
    expect(listCalls(h.calls)).toHaveLength(1)
  })

  test('direct status shares the background read but keeps its own deadline', async () => {
    const read = deferred<unknown[]>()
    const h = setup({ 'quirky.worktree/list': () => read.promise })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    const status = h.service.status()
    await flushMicrotasks()

    h.clock.advance(40)
    await flushMicrotasks()
    await expect(status).rejects.toMatchObject({
      kind: 'conflict',
      code: -32009,
      message: 'worktree status is temporarily unavailable'
    })
    expect(listCalls(h.calls)).toHaveLength(1)
    expect(h.logs).toContain('quirky.worktree/list failed: quirky.worktree/list did not answer within 40ms')
    await expect(h.service.test()).resolves.toEqual({ delivered: true, reason: 'delivered' })

    read.resolve([unread('w1')])
    await flushMicrotasks()
    expect(changedEvents(h.events)).toEqual([{ event: 'changed', data: { badge: 1 } }])
    expect(listCalls(h.calls)).toHaveLength(1)
  })

  test('a slow refresh retains the warm badge, coalesces dirty requests, and applies the eventual result', async () => {
    const held = deferred<unknown[]>()
    let listRead = 0
    const h = setup({
      'quirky.worktree/list': () => {
        listRead += 1
        if (listRead === 1) return [unread('w1')]
        if (listRead === 2) return held.promise
        return [unread('w1'), unread('w2')]
      }
    })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    expect(changedEvents(h.events)).toEqual([{ event: 'changed', data: { badge: 1 } }])

    h.service.onEvent(settingChanged())
    await flushMicrotasks()
    expect(listCalls(h.calls)).toHaveLength(2)
    h.clock.advance(500)
    await flushMicrotasks()
    await expect(h.service.test()).resolves.toEqual({ delivered: true, reason: 'delivered' })
    expect(changedEvents(h.events)).toEqual([{ event: 'changed', data: { badge: 1 } }])

    h.clock.advance(1500)
    await flushMicrotasks()
    for (let event = 0; event < 20; event++) h.service.onEvent(settingChanged())
    await flushMicrotasks()
    expect(listCalls(h.calls)).toHaveLength(2)
    expect(changedEvents(h.events)).toEqual([{ event: 'changed', data: { badge: 1 } }])

    h.clock.advance(500)
    held.resolve([unread('w1'), unread('w2')])
    await flushMicrotasks()
    expect(changedEvents(h.events)).toEqual([
      { event: 'changed', data: { badge: 1 } },
      { event: 'changed', data: { badge: 2 } }
    ])
    expect(listCalls(h.calls)).toHaveLength(3)
    await flushMicrotasks()
    expect(listCalls(h.calls)).toHaveLength(3)
    expect(diagnostics(h.logs).map(({ event, outcome, elapsedMs }) => ({ event, outcome, elapsedMs }))).toEqual([
      { event: 'slow', outcome: undefined, elapsedMs: 2000 },
      { event: 'finished', outcome: 'ok', elapsedMs: 2500 }
    ])
  })

  test('a worktree invalidation prevents adoption of the superseded read and applies one current follow-up', async () => {
    const stale = deferred<unknown[]>()
    let listRead = 0
    const h = setup({
      'quirky.worktree/list': () => {
        listRead += 1
        if (listRead === 1) return [unread('w1')]
        if (listRead === 2) return stale.promise
        return [unread('w1'), unread('w2')]
      }
    })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    h.service.onEvent(settingChanged())
    await flushMicrotasks()
    expect(listCalls(h.calls)).toHaveLength(2)

    h.service.onEvent({ type: 'quirky.worktree/changed', data: { worktreeId: 'w1', unread: true } } as QuirkyEvent)
    await flushMicrotasks()
    stale.resolve([])
    await flushMicrotasks()

    expect(listCalls(h.calls)).toHaveLength(3)
    expect(changedEvents(h.events)).toEqual([
      { event: 'changed', data: { badge: 1 } },
      { event: 'changed', data: { badge: 2 } }
    ])
    expect(changedEvents(h.events)).not.toContainEqual({ event: 'changed', data: { badge: 0 } })
  })

  test('a catalog invalidation prevents an in-flight reconciliation from publishing its old snapshot', async () => {
    const heldUi = deferred<UiState>()
    let uiRead = 0
    let listRead = 0
    const h = setup({
      'ui.state': () => {
        uiRead += 1
        return uiRead === 2 ? heldUi.promise : idle
      },
      'quirky.worktree/list': () => {
        listRead += 1
        return listRead === 1 ? [unread('w1')] : [unread('w1'), unread('w2')]
      }
    })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    expect(uiRead).toBe(2)
    h.service.onEvent({ type: 'quirky.repo/changed', data: {} } as QuirkyEvent)
    await flushMicrotasks()
    expect(listCalls(h.calls)).toHaveLength(2)

    heldUi.resolve(idle)
    await flushMicrotasks()

    expect(changedEvents(h.events)).toEqual([{ event: 'changed', data: { badge: 2 } }])
  })

  test('shutdown suppresses a status reconciliation already waiting on an async lookup', async () => {
    const heldUi = deferred<UiState>()
    let uiRead = 0
    const h = setup({
      'ui.state': () => {
        uiRead += 1
        return uiRead === 2 ? heldUi.promise : idle
      },
      'quirky.worktree/list': [unread('w1')]
    })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    expect(uiRead).toBe(2)
    h.service.shutdown()
    heldUi.resolve(idle)
    await flushMicrotasks()

    expect(changedEvents(h.events)).toEqual([])
  })

  test('auto-read reconciliation mutates only a private snapshot copy', async () => {
    const held = deferred<unknown[]>()
    let listRead = 0
    const h = setup({
      'ui.state': {
        ...idle,
        windows: [{ connId: 1, focused: true, inputAt: 1, present: true }],
        layout: { ...idle.layout, view: { id: 'view:quirky.session/worktree', input: { worktree: 'w1' } } }
      },
      'quirky.worktree/list': () => {
        listRead += 1
        return listRead === 1 ? [unread('w1')] : held.promise
      }
    })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    const unreadWrites = () => h.calls.filter(({ method, params }) =>
      method === 'quirky.worktree/set' && params?.unread === false
    )
    expect(unreadWrites()).toHaveLength(1)

    h.service.onEvent(settingChanged())
    await flushMicrotasks()

    expect(listCalls(h.calls)).toHaveLength(2)
    expect(unreadWrites()).toHaveLength(2)
    h.service.shutdown()
  })

  test('a failed refresh logs an error, retains its snapshot, and leaves delivery available', async () => {
    let listRead = 0
    const h = setup({
      'quirky.worktree/list': () => {
        listRead += 1
        if (listRead === 1) return [unread('w1')]
        return Promise.reject(new Error('list fixture failed'))
      }
    })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    h.service.onEvent(settingChanged())
    await flushMicrotasks()
    await expect(h.service.test()).resolves.toEqual({ delivered: true, reason: 'delivered' })

    expect(changedEvents(h.events)).toEqual([{ event: 'changed', data: { badge: 1 } }])
    expect(h.logs).toContain('quirky.worktree/list failed: list fixture failed')
    expect(diagnostics(h.logs).map(({ event, outcome }) => ({ event, outcome }))).toEqual([{ event: 'finished', outcome: 'error' }])
    expect(listCalls(h.calls)).toHaveLength(2)
  })

  test('shutdown prevents a pending refresh from emitting, logging late, or requesting follow-up work', async () => {
    const held = deferred<unknown[]>()
    let listRead = 0
    const h = setup({
      'quirky.worktree/list': () => {
        listRead += 1
        if (listRead === 1) return [unread('w1')]
        return held.promise
      }
    })

    h.service.start()
    await flushMicrotasks()
    h.service.onEvent(settingChanged())
    await flushMicrotasks()
    expect(listCalls(h.calls)).toHaveLength(2)
    const eventsBeforeStop = changedEvents(h.events)
    const logsBeforeStop = [...h.logs]

    h.service.shutdown()
    held.resolve([unread('w2')])
    await flushMicrotasks()
    h.clock.advance(31_000)
    await flushMicrotasks()

    expect(changedEvents(h.events)).toEqual(eventsBeforeStop)
    expect(h.logs).toEqual(logsBeforeStop)
    expect(listCalls(h.calls)).toHaveLength(2)
    expect(h.clock.activeTimers()).toBe(0)
  })

  test('fresh status rejects Conflict when its worktree list fails instead of returning stale or empty status', async () => {
    let listRead = 0
    const h = setup({
      'quirky.worktree/list': () => {
        listRead += 1
        return listRead === 1 ? [unread('w1')] : Promise.reject(new Error('list fixture failed'))
      }
    })
    register(h.service)

    h.service.start()
    await flushMicrotasks()
    await expect(h.service.status()).rejects.toMatchObject({
      kind: 'conflict',
      code: -32009,
      message: 'worktree status is temporarily unavailable'
    })
    expect(changedEvents(h.events)).toEqual([{ event: 'changed', data: { badge: 1 } }])
    expect(listCalls(h.calls)).toHaveLength(2)
  })

  test('a missing worktree-list method is a Conflict rather than an empty status', async () => {
    const h = setup({
      'quirky.worktree/list': () => Promise.reject(Object.assign(new Error('missing method'), { code: -32601 }))
    })
    register(h.service)

    await expect(h.service.status()).rejects.toMatchObject({
      kind: 'conflict',
      code: -32009,
      message: 'worktree status is temporarily unavailable'
    })
    expect(h.logs).toEqual([])
  })
})
