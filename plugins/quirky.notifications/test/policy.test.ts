import { describe, expect, spyOn, test } from 'bun:test'
import * as fsp from 'node:fs/promises'
import type { PluginContext, PluginNotification, QuirkyEvent, UiState } from '@quirky/protocol'
import { NotificationsService, type ServiceOptions } from '../src/service'
import { checkCustomSound, deliverySound } from '../src/sounds'

const VIEW = 'view:quirky.session/worktree'
const OVERLAY = 'overlay:quirky.terminal/floating'
const never = () => new Promise<never>(() => {})
const window = [{ connId: 1, focused: true, inputAt: 1, present: true }]

const idle: UiState = { windows: [], layout: { view: null, panel: null, sidebar: true, focus: null }, toasts: [], slots: [] }

const floatingOnly: UiState = {
  windows: window,
  layout: { view: null, panel: null, sidebar: true, focus: null },
  toasts: [], slots: [{ id: OVERLAY, kind: 'overlay', plugin: 'quirky.terminal', title: 'Floating Workspace', shown: true, report: { shown: true, visibleSessions: ['f1'] } }]
}

const worktreeOpen: UiState = {
  windows: window,
  layout: { view: { id: VIEW, input: { worktree: 'w1' } }, panel: null, sidebar: true, focus: null },
  toasts: [], slots: [{ id: VIEW, kind: 'view', plugin: 'quirky.session', title: 'Session', shown: true, report: { worktree: 'w1', visibleSessions: [] } }]
}

const answers = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  'ui.state': idle,
  'status.get': { clients: [{ role: 'desktop' }] },
  'quirky.session/get': { id: 's1', worktreeId: 'w1' },
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

function setup(table: Record<string, unknown>, options: ServiceOptions = {}, settings: Record<string, unknown> = {}) {
  const notifications: PluginNotification[] = []
  const calls: [string, unknown][] = []
  const decided: { source: string; result: string }[] = []
  const values: Record<string, unknown> = {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: false,
    terminalNotifications: true,
    sound: 'system',
    customSoundPath: '',
    volume: 100,
    suppressWhenFocused: true,
    ...settings
  }
  const context = {
    pluginId: 'quirky.notifications',
    dir: '/plugin',
    log: () => {},
    emit: (event: string, data: unknown) => {
      if (event === 'decided') decided.push(data as { source: string; result: string })
      return true
    },
    getSetting: (name: string) => values[name],
    notify: (n: PluginNotification) => notifications.push(n),
    error: (_kind: string, message: string) => new Error(message),
    call: async (method: string, params: unknown) => {
      calls.push([method, params])
      if (!(method in table)) throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 })
      const answer = table[method]
      return typeof answer === 'function' ? (answer as (p: unknown) => unknown)(params) : answer
    }
  } as unknown as PluginContext
  const service = new NotificationsService(context, { lookupTimeoutMs: 500, ...options })
  const cleared = () => calls.filter(([method, params]) => method === 'quirky.session/setUnread' && (params as { unread: unknown }).unread === null)
  return { service, notifications, calls, decided, cleared }
}

const settled = (data: Record<string, unknown> = {}) =>
  ({ type: 'quirky.structured/settled', data: { sessionId: 's1', worktreeId: 'w1', agent: 'codex', state: 'done', at: 1, ...data } }) as QuirkyEvent

describe('auto-read of the floating panel', () => {
  test('an attended window clears an unread floating session while no worktree view is shown', async () => {
    const { service, calls, cleared } = setup(
      answers({
        'ui.state': floatingOnly,
        'quirky.session/list': [{ id: 'f1', worktreeId: 'w1', unread: 'bell' }],
        'quirky.worktree/list': [{ id: 'w1', name: 'fix-tests', unread: true }]
      })
    )

    service.start()
    await Bun.sleep(50)

    expect(cleared()).toEqual([['quirky.session/setUnread', { session: 'f1', unread: null }]])
    expect(calls.some(([method]) => method === 'quirky.worktree/set')).toBe(false)
    service.shutdown()
  })
})

describe('cooldown measured between deliveries', () => {
  test('a slow banner lookup does not shorten the window', async () => {
    let t = 0
    let resolved = 0
    const { service, notifications, decided } = setup(
      answers({
        'quirky.worktree/resolve': () => {
          if (resolved++ === 0) t += 4000
          return { id: 'w1', name: 'fix-tests', repoId: 'repo_1', kind: 'git' }
        }
      }),
      { now: () => t, cooldownMs: 5000 }
    )

    service.onEvent(settled({ sessionId: 's1' }))
    await Bun.sleep(50)
    expect(notifications).toHaveLength(1)

    t = 5001
    service.onEvent(settled({ sessionId: 's2' }))
    await Bun.sleep(50)

    expect(notifications).toHaveLength(1)
    expect(decided.map((d) => d.result)).toEqual(['delivered', 'cooldown'])
    service.shutdown()
  })
})

describe('bell hold', () => {
  test('a completion received during the hold supersedes the bell even when its lookups outlast the hold', async () => {
    let slow = false
    const { service, notifications, decided } = setup(
      answers({
        'ui.state': async () => {
          if (slow) await Bun.sleep(80)
          return idle
        }
      }),
      { bellHoldMs: 20 },
      { terminalBell: true }
    )

    service.onEvent({ type: 'quirky.terminal/bell', data: { sessionId: 's1' } } as QuirkyEvent)
    await Bun.sleep(5)
    slow = true
    service.onEvent(settled())
    await Bun.sleep(250)

    expect(decided.map((d) => `${d.source}:${d.result}`).sort()).toEqual(['agent:delivered', 'bell:superseded'])
    expect(notifications).toHaveLength(1)
    service.shutdown()
  })

  test('a completion that arrived before the bell does not supersede it', async () => {
    const { service, decided } = setup(answers(), { bellHoldMs: 20 }, { terminalBell: true })

    service.onEvent(settled())
    await Bun.sleep(30)
    service.onEvent({ type: 'quirky.terminal/bell', data: { sessionId: 's1' } } as QuirkyEvent)
    await Bun.sleep(100)

    expect(decided.find((d) => d.source === 'bell')?.result).not.toBe('superseded')
    service.shutdown()
  })
})

describe('own worktree writes', () => {
  test('a timed-out auto-read write is not mistaken for Mark Read when its event arrives late', async () => {
    let t = 0
    const { service, cleared } = setup(
      answers({
        'ui.state': worktreeOpen,
        'quirky.worktree/list': [{ id: 'w1', name: 'fix-tests', unread: true }],
        'quirky.worktree/set': never,
        'quirky.session/list': [{ id: 'bg', worktreeId: 'w1', unread: 'agent' }]
      }),
      { lookupTimeoutMs: 40, now: () => t }
    )

    service.start()
    await Bun.sleep(120)
    service.onEvent({ type: 'quirky.worktree/changed', data: { worktreeId: 'w1', unread: false } } as QuirkyEvent)
    await Bun.sleep(60)
    expect(cleared()).toEqual([])

    t = 61_000
    service.onEvent({ type: 'quirky.worktree/changed', data: { worktreeId: 'w1', unread: false } } as QuirkyEvent)
    await Bun.sleep(60)
    expect(cleared()).toEqual([['quirky.session/setUnread', { session: 'bg', unread: null }]])
    service.shutdown()
  })

  test('a write that failed outright leaves no marker behind', async () => {
    const { service, cleared } = setup(
      answers({
        'ui.state': worktreeOpen,
        'quirky.worktree/list': [{ id: 'w1', name: 'fix-tests', unread: true }],
        'quirky.worktree/set': () => {
          throw Object.assign(new Error('refused'), { code: -32000 })
        },
        'quirky.session/list': [{ id: 'bg', worktreeId: 'w1', unread: 'agent' }]
      })
    )

    service.start()
    await Bun.sleep(50)
    service.onEvent({ type: 'quirky.worktree/changed', data: { worktreeId: 'w1', unread: false } } as QuirkyEvent)
    await Bun.sleep(60)

    expect(cleared()).toEqual([['quirky.session/setUnread', { session: 'bg', unread: null }]])
    service.shutdown()
  })
})

describe('custom sound on a stalled filesystem', () => {
  test('a stat that never returns reads as could not be read', async () => {
    const spy = spyOn(fsp, 'stat').mockImplementation(never as never)
    try {
      const started = Date.now()
      expect(await checkCustomSound('/sounds/a.wav', { timeoutMs: 30 })).toEqual({ ok: false, reason: 'could not be read' })
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      spy.mockRestore()
    }
  })

  test('an access that never returns reads as could not be read', async () => {
    const stat = spyOn(fsp, 'stat').mockImplementation((async () => ({ size: 1 })) as never)
    const access = spyOn(fsp, 'access').mockImplementation(never as never)
    try {
      expect(await checkCustomSound('/sounds/a.wav', { timeoutMs: 30 })).toEqual({ ok: false, reason: 'could not be read' })
    } finally {
      stat.mockRestore()
      access.mockRestore()
    }
  })

  test('delivery stays silent and names the problem', async () => {
    const spy = spyOn(fsp, 'stat').mockImplementation(never as never)
    try {
      const choice = await deliverySound({ sound: 'custom', customSoundPath: '/sounds/a.wav', volume: 50, pluginDir: '/p', checkTimeoutMs: 30 })
      expect(choice).toEqual({ problem: 'could not be read' })
    } finally {
      spy.mockRestore()
    }
  })

  test('the service bounds the check with its lookup timeout, so the queue keeps moving', async () => {
    const spy = spyOn(fsp, 'stat').mockImplementation(never as never)
    try {
      const { service, notifications } = setup(answers(), { lookupTimeoutMs: 40 }, { sound: 'custom', customSoundPath: '/sounds/a.wav' })
      service.onEvent(settled())
      await Bun.sleep(300)
      expect(notifications).toHaveLength(1)
      expect(notifications[0]).not.toHaveProperty('sound')
      service.shutdown()
    } finally {
      spy.mockRestore()
    }
  })
})
