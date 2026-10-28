import { describe, expect, test } from 'bun:test'
import type { Ask, PluginContext, PluginNotification, QuirkyEvent, UiState } from '@quirky/protocol'
import { NotificationsService } from '../src/service'

const ESCALATION_MS = 3 * 60 * 1000
const VIEW = 'view:quirky.session/worktree'
const IDLE: UiState = { windows: [], layout: { view: null, panel: null, sidebar: true, focus: null }, slots: [], toasts: [] }

function ask(id: string, sessionId = 'session_1', queued = false, seq = 1): Ask {
  return {
    id,
    spec: { title: 'Deploy?', questions: [{ id: 'go', type: 'confirm', question: 'Ship to prod?' }] },
    sessionId,
    worktreeId: 'worktree_1',
    createdAt: 10,
    envelope: { status: 'pending', askId: id, answers: {}, skipped: [], summary: '' },
    seq,
    queued,
    partial: {},
    expiresAt: null
  }
}

function focused(sessionId: string): UiState {
  return {
    windows: [{ connId: 1, focused: true, inputAt: 10, present: true }],
    layout: { view: { id: VIEW, input: { worktree: 'worktree_1' } }, panel: null, sidebar: true, focus: 'view' },
    slots: [{
      id: VIEW,
      kind: 'view',
      plugin: 'quirky.session',
      title: 'Session',
      shown: true,
      report: { worktree: 'worktree_1', active: sessionId, visibleSessions: [sessionId] }
    }],
    toasts: []
  }
}

type Timer = { at: number; delay: number; run: () => void }

function manualClock() {
  let time = 1_000_000
  let nextHandle = 0
  const timers = new Map<number, Timer>()
  const scheduled = new Map<number, ((handle: number) => void)[]>()
  const cleared = new Map<number, (() => void)[]>()
  return {
    now: () => time,
    setTimeout(run: () => void, delay: number) {
      const handle = ++nextHandle
      timers.set(handle, { at: time + delay, delay, run })
      for (const resolve of scheduled.get(delay) ?? []) resolve(handle)
      scheduled.delete(delay)
      return handle
    },
    clearTimeout(handle: unknown) {
      const id = handle as number
      timers.delete(id)
      for (const resolve of cleared.get(id) ?? []) resolve()
      cleared.delete(id)
    },
    whenScheduled(delay: number): Promise<number> {
      const existing = [...timers].find(([, timer]) => timer.delay === delay)
      if (existing) return Promise.resolve(existing[0])
      return new Promise((resolve) => {
        const listeners = scheduled.get(delay) ?? []
        listeners.push(resolve)
        scheduled.set(delay, listeners)
      })
    },
    whenCleared(handle: number): Promise<void> {
      if (!timers.has(handle)) return Promise.resolve()
      return new Promise((resolve) => {
        const listeners = cleared.get(handle) ?? []
        listeners.push(resolve)
        cleared.set(handle, listeners)
      })
    },
    activeCount: () => timers.size,
    advance(delay: number) {
      time += delay
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) return
        timers.delete(next[0])
        next[1].run()
      }
    }
  }
}

function setup(initial: Ask[] = []) {
  const clock = manualClock()
  let pending = [...initial]
  let uiState = IDLE
  const notifications: PluginNotification[] = []
  const events: { event: string; data: unknown }[] = []
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  let notifyResolve!: () => void
  const notified = new Promise<void>((resolve) => { notifyResolve = resolve })
  const settings: Record<string, unknown> = {
    enabled: true,
    agentTaskComplete: false,
    terminalBell: false,
    terminalNotifications: false,
    sound: 'system',
    customSoundPath: '',
    volume: 100,
    suppressWhenFocused: true
  }
  const context = {
    pluginId: 'quirky.notifications',
    dir: '/plugin',
    log() {},
    emit(event: string, data: unknown) {
      events.push({ event, data })
      return true
    },
    getSetting(name: string) {
      return settings[name]
    },
    notify(notification: PluginNotification) {
      notifications.push(notification)
      notifyResolve()
    },
    error(_kind: string, message: string) {
      return new Error(message)
    },
    async call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params })
      if (method === 'ui.state') return uiState
      if (method === 'quirky.ask/list') return pending
      if (method === 'quirky.worktree/list' || method === 'quirky.session/list') return []
      if (method === 'status.get') return { clients: [{ role: 'desktop' }] }
      if (method === 'quirky.worktree/resolve') return { id: 'worktree_1', name: 'feature', repoId: 'repo_1', kind: 'git' }
      if (method === 'quirky.repo/resolve') return { name: 'quirky', displayName: null }
      if (method === 'quirky.session/setUnread' || method === 'quirky.worktree/set') return {}
      throw new Error(`unexpected ${method}`)
    }
  } as unknown as PluginContext
  const service = new NotificationsService(context, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    cooldownMs: 0
  })
  return {
    service,
    clock,
    calls,
    events,
    notifications,
    notified,
    setPending(asks: Ask[]) {
      pending = [...asks]
    },
    setUiState(state: UiState) {
      uiState = state
    }
  }
}

const event = (type: string, data: unknown): QuirkyEvent => ({ type, data }) as QuirkyEvent

describe('delayed ask notifications', () => {
  test('Q3: a still-pending surfaced ask stays silent until three uninterrupted minutes, then uses public attention markers', async () => {
    const first = ask('ask_1')
    const app = setup([first])
    const scheduled = app.clock.whenScheduled(ESCALATION_MS)

    app.service.onEvent(event('quirky.ask/created', { ask: first, seq: first.seq }))
    await scheduled

    expect(app.notifications).toEqual([])
    expect(app.events.filter((item) => item.event === 'attention')).toEqual([])
    expect((await app.service.status()).pendingAsks).toBe(1)

    app.clock.advance(ESCALATION_MS - 1)
    expect(app.notifications).toEqual([])
    app.clock.advance(1)
    await app.notified

    expect(app.notifications).toMatchObject([{ title: 'Deploy?', body: 'Ship to prod?', sessionId: 'session_1', worktreeId: 'worktree_1' }])
    expect(app.events.find((item) => item.event === 'attention')).toMatchObject({
      data: { source: 'ask', sessionId: 'session_1', worktreeId: 'worktree_1' }
    })
    expect(app.calls).toContainEqual({ method: 'quirky.session/setUnread', params: { session: 'session_1', unread: 'notification' } })
    expect(app.calls).toContainEqual({ method: 'quirky.worktree/set', params: { worktree: 'id:worktree_1', unread: true } })
    expect(app.events.find((item) => item.event === 'decided')).toMatchObject({ data: { source: 'ask', result: 'delivered' } })
    expect(app.calls.filter((call) => call.method === 'quirky.ask/list').length).toBeGreaterThan(1)
    app.service.shutdown()
  })

  test('Q3: focusing the exact session cancels elapsed time; leaving it starts a fresh three-minute interval', async () => {
    const first = ask('ask_1')
    const app = setup([first])
    const initialTimer = app.clock.whenScheduled(ESCALATION_MS)
    app.service.onEvent(event('quirky.ask/created', { ask: first, seq: first.seq }))
    const handle = await initialTimer

    app.clock.advance(60_000)
    const cleared = app.clock.whenCleared(handle)
    app.setUiState(focused('session_1'))
    app.service.onEvent(event('ui.state.changed', { layout: focused('session_1').layout }))
    await cleared
    app.clock.advance(ESCALATION_MS)
    expect(app.notifications).toEqual([])

    const restartedTimer = app.clock.whenScheduled(ESCALATION_MS)
    app.setUiState(IDLE)
    app.service.onEvent(event('ui.state.changed', { layout: IDLE.layout }))
    await restartedTimer
    app.clock.advance(ESCALATION_MS - 1)
    expect(app.notifications).toEqual([])
    app.clock.advance(1)
    await app.notified
    expect(app.notifications).toHaveLength(1)
    app.service.shutdown()
  })

  test('Q3: resolution and FIFO head replacement cancel the old timer and the promoted head gets a full delay', async () => {
    const first = ask('ask_1')
    const queued = ask('ask_2', 'session_1', true, 2)
    const app = setup([first, queued])
    const initialTimer = app.clock.whenScheduled(ESCALATION_MS)
    app.service.onEvent(event('quirky.ask/created', { ask: first, seq: first.seq }))
    const oldHandle = await initialTimer
    app.service.onEvent(event('quirky.ask/created', { ask: queued, seq: queued.seq }))

    const newHead = ask('ask_2', 'session_1', false, 4)
    app.setPending([newHead])
    const cleared = app.clock.whenCleared(oldHandle)
    const promotedTimer = app.clock.whenScheduled(ESCALATION_MS)
    app.service.onEvent(event('quirky.ask/resolved', { askId: first.id, envelope: { status: 'declined', askId: first.id, answers: {}, skipped: [], summary: '' }, seq: 3 }))
    app.service.onEvent(event('quirky.ask/surfaced', { ask: newHead, seq: 4 }))
    await cleared
    await promotedTimer

    app.clock.advance(ESCALATION_MS - 1)
    expect(app.notifications).toEqual([])
    app.clock.advance(1)
    await app.notified
    expect(app.notifications).toMatchObject([{ sessionId: 'session_1' }])
    expect(app.notifications).toHaveLength(1)
    app.service.shutdown()
  })

  test('Q3: startup rehydrates surfaced asks and shutdown cancels their timers', async () => {
    const app = setup([ask('ask_restart')])
    const scheduled = app.clock.whenScheduled(ESCALATION_MS)
    app.service.start()
    await scheduled

    expect(app.notifications).toEqual([])
    expect((await app.service.status()).pendingAsks).toBe(1)
    expect(app.clock.activeCount()).toBeGreaterThan(0)

    app.service.shutdown()
    expect(app.clock.activeCount()).toBe(0)
    app.clock.advance(ESCALATION_MS)
    expect(app.notifications).toEqual([])
  })
})
