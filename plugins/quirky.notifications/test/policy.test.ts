import { describe, expect, spyOn, test } from 'bun:test'
import * as fsp from 'node:fs/promises'
import type { PluginContext, PluginEvent, PluginNotification, QuirkyEvent, UiState } from '@quirky/protocol'
import { PluginEvents } from '../../../packages/daemon/src/plugins/events'
import type { PluginHost } from '../../../packages/daemon/src/plugins/host'
import { waitFor } from '../../../packages/daemon/test/helpers'
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

type EventQuery = { kind?: string; pluginId?: string }
type WorktreeChangedData = { repoId: string; worktreeId: string; unread?: boolean; unreadSource?: string }

function worktreeEventBridge(deliver: (event: QuirkyEvent) => void) {
  const declaration = {
    id: 'event:quirky.worktree/changed',
    plugin: 'quirky.worktree',
    data: {
      coalesce: ['repoId', 'unread', 'removed', 'unreadSource'],
      worktree: 'worktreeId'
    }
  }
  const host = {
    contributions: (query: EventQuery) =>
      query.kind === 'event' && (query.pluginId === undefined || query.pluginId === 'quirky.worktree')
        ? [declaration]
        : []
  } as unknown as PluginHost
  const delivered: PluginEvent[] = []
  const events = new PluginEvents(host, (event) => {
    if (!('data' in event)) throw new Error('expected a plugin event')
    delivered.push(event)
    deliver(event)
  }, () => {})
  return { events, delivered }
}

function worktreeSetEvent(params: unknown): WorktreeChangedData {
  if (typeof params !== 'object' || params === null || !('unread' in params) || typeof params.unread !== 'boolean') {
    throw new Error('expected a worktree unread set')
  }
  const data: WorktreeChangedData = {
    repoId: 'repo_1',
    worktreeId: 'w1',
    unread: params.unread
  }
  if ('unreadSource' in params && params.unreadSource === 'notifications') data.unreadSource = params.unreadSource
  return data
}

const ownWorktreeChanges = (events: PluginEvent[]) =>
  events.filter((event) => event.type === 'quirky.worktree/changed').filter((event) => {
    const data = event.data as WorktreeChangedData
    return data.unreadSource === 'notifications'
  })

const EXTERNAL_MARK_READ = {
  repoId: 'repo_1',
  worktreeId: 'w1',
  unread: false
}

const OWN_MARK_READ = {
  repoId: 'repo_1',
  worktreeId: 'w1',
  unread: false,
  unreadSource: 'notifications'
}

const OWN_WORKTREE_SET = {
  worktree: 'id:w1',
  unread: false,
  unreadSource: 'notifications'
}

const BACKGROUND_SESSION = { id: 'bg', worktreeId: 'w1', unread: 'agent' }

const clearBackgroundSession: [string, unknown] = ['quirky.session/setUnread', { session: 'bg', unread: null }]

const taggedMarkRead = {
  type: 'quirky.worktree/changed',
  data: OWN_MARK_READ
} as QuirkyEvent

const externalMarkRead = {
  type: 'quirky.worktree/changed',
  data: EXTERNAL_MARK_READ
} as QuirkyEvent

async function drainProductionWorktreeWindow(): Promise<void> {
  // PluginEvents holds the latest event until its production 250 ms COALESCE_INTERVAL_MS window drains.
  await Bun.sleep(300)
}

const unreadWriteAnswers = (readCount: { value: number }, emit: (data: WorktreeChangedData) => void) =>
  answers({
    'ui.state': worktreeOpen,
    'quirky.worktree/list': () => [{ id: 'w1', name: 'fix-tests', unread: readCount.value++ < 3 }],
    'quirky.worktree/set': (params: unknown) => {
      emit(worktreeSetEvent(params))
      return {}
    },
    'quirky.session/list': [BACKGROUND_SESSION]
  })

const waitForWorktreeWrites = (calls: [string, unknown][], count: number) =>
  waitFor(() => {
    const writes = calls.filter(([method]) => method === 'quirky.worktree/set')
    return writes.length >= count ? writes : undefined
  })

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
  test('three notification writes coalesce to two, then external Mark Read clears background sessions', async () => {
    let service!: NotificationsService
    const bridge = worktreeEventBridge((event) => service.onEvent(event))
    const readCount = { value: 0 }
    const env = setup(unreadWriteAnswers(readCount, (data) => {
      bridge.events.emit('quirky.worktree', 'changed', data)
    }))
    service = env.service
    service.start()

    expect(await waitForWorktreeWrites(env.calls, 2)).toHaveLength(2)
    service.onEvent({ type: 'ui.state.changed' } as QuirkyEvent)
    const writes = await waitForWorktreeWrites(env.calls, 3)
    expect(writes).toHaveLength(3)
    expect(writes.map(([, params]) => params)).toEqual([OWN_WORKTREE_SET, OWN_WORKTREE_SET, OWN_WORKTREE_SET])

    await drainProductionWorktreeWindow()
    const delivered = bridge.delivered.filter((event) => event.type === 'quirky.worktree/changed')
    expect(delivered).toHaveLength(2)
    expect(delivered.map((event) => 'worktreeId' in event ? event.worktreeId : undefined)).toEqual(['w1', 'w1'])
    expect(ownWorktreeChanges(bridge.delivered).map((event) => event.data as WorktreeChangedData)).toEqual([OWN_MARK_READ, OWN_MARK_READ])
    expect(env.cleared()).toEqual([])

    bridge.events.emit('quirky.worktree', 'changed', EXTERNAL_MARK_READ)
    expect(await waitFor(() => env.cleared().length > 0 ? env.cleared() : undefined)).toEqual([clearBackgroundSession])
    service.shutdown()
  })

  test('an external false event interleaved between own writes keeps its separate key', async () => {
    let service!: NotificationsService
    const bridge = worktreeEventBridge((event) => service.onEvent(event))
    const readCount = { value: 0 }
    const env = setup(unreadWriteAnswers(readCount, (data) => {
      bridge.events.emit('quirky.worktree', 'changed', data)
    }))
    service = env.service
    service.start()

    expect(await waitForWorktreeWrites(env.calls, 2)).toHaveLength(2)
    bridge.events.emit('quirky.worktree', 'changed', EXTERNAL_MARK_READ)
    const writes = await waitForWorktreeWrites(env.calls, 3)
    expect(writes).toHaveLength(3)
    expect(writes.map(([, params]) => params)).toEqual([OWN_WORKTREE_SET, OWN_WORKTREE_SET, OWN_WORKTREE_SET])
    expect(await waitFor(() => env.cleared().length > 0 ? env.cleared() : undefined)).toEqual([clearBackgroundSession])

    await drainProductionWorktreeWindow()
    const delivered = bridge.delivered.filter((event) => event.type === 'quirky.worktree/changed')
    expect(delivered).toHaveLength(3)
    expect(ownWorktreeChanges(bridge.delivered)).toHaveLength(2)
    expect(delivered.filter((event) => {
      const data = event.data as WorktreeChangedData
      return data.unreadSource !== 'notifications'
    })).toHaveLength(1)
    service.shutdown()
  })

  test('a timed-out own write keeps its attribution after 61,000 ms', async () => {
    let t = 0
    let listCalls = 0
    const { service, cleared, calls } = setup(
      answers({
        'ui.state': worktreeOpen,
        'quirky.worktree/list': () => [{ id: 'w1', name: 'fix-tests', unread: listCalls++ === 0 }],
        'quirky.worktree/set': never,
        'quirky.session/list': [BACKGROUND_SESSION]
      }),
      { lookupTimeoutMs: 40, now: () => t }
    )

    service.start()
    const writes = await waitForWorktreeWrites(calls, 1)
    // The bounded write resolves only when its real 40 ms service timer fires.
    await Bun.sleep(60)
    const params = writes[0]![1] as Record<string, unknown>
    expect(params).toMatchObject({ unread: false, unreadSource: 'notifications' })

    t = 61_000
    service.onEvent(taggedMarkRead)
    await waitFor(() => calls.filter(([method]) => method === 'quirky.worktree/list').length >= 2 ? true : undefined)
    expect(cleared()).toEqual([])

    service.onEvent(externalMarkRead)
    expect(await waitFor(() => cleared().length > 0 ? cleared() : undefined)).toEqual([clearBackgroundSession])
    service.shutdown()
  })

  test('a write that failed outright leaves no marker behind', async () => {
    const { service, calls, cleared } = setup(
      answers({
        'ui.state': worktreeOpen,
        'quirky.worktree/list': [{ id: 'w1', name: 'fix-tests', unread: true }],
        'quirky.worktree/set': () => {
          throw Object.assign(new Error('refused'), { code: -32000 })
        },
        'quirky.session/list': [BACKGROUND_SESSION]
      })
    )

    service.start()
    await waitForWorktreeWrites(calls, 1)
    service.onEvent(externalMarkRead)

    expect(await waitFor(() => cleared().length > 0 ? cleared() : undefined)).toEqual([clearBackgroundSession])
    service.shutdown()
  })

  test('a tagged own event received by a fresh service clears no background sessions', async () => {
    const { service, cleared } = setup(answers({
      'quirky.session/list': [BACKGROUND_SESSION]
    }))

    service.onEvent(taggedMarkRead)
    await Bun.sleep(40)
    expect(cleared()).toEqual([])
    service.shutdown()
  })

  test('notification-created unread markers include source attribution', async () => {
    const { service, calls } = setup(answers())

    service.onEvent(settled())
    const writes = await waitForWorktreeWrites(calls, 1)
    expect(writes.map(([, params]) => params)).toEqual([{
      worktree: 'id:w1',
      unread: true,
      unreadSource: 'notifications'
    }])
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
