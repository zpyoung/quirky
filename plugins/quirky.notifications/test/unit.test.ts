import { describe, expect, test } from 'bun:test'
import type { PluginContext, PluginNotification, QuirkyEvent, UiState } from '@quirky/protocol'
import { playerArgv } from '../src/player'
import { NotificationsService } from '../src/service'
import { NOT_VIEWING, sessionViewed, viewingOf, worktreeOpenInFocusedWindow, worktreeViewed } from '../src/viewed'

const VIEW = 'view:quirky.session/worktree'
const OVERLAY = 'overlay:quirky.terminal/floating'

function uiState(over: {
  windows?: UiState['windows']
  view?: UiState['layout']['view']
  report?: unknown
  overlay?: unknown
}): UiState {
  return {
    windows: over.windows ?? [{ connId: 1, focused: true, inputAt: 1, present: true }],
    layout: { view: over.view ?? { id: VIEW, input: { worktree: 'w1' } }, panel: null, sidebar: true, focus: null },
    toasts: [], slots: [
      { id: VIEW, kind: 'view', plugin: 'quirky.session', title: 'Session', shown: true, ...(over.report === undefined ? {} : { report: over.report }) },
      ...(over.overlay === undefined ? [] : [{ id: OVERLAY, kind: 'overlay' as const, plugin: 'quirky.terminal', title: 'Floating Workspace', shown: true, report: over.overlay }])
    ]
  }
}

describe('viewing', () => {
  test('a session is viewed when an attended window shows it in the open worktree', () => {
    const viewing = viewingOf(uiState({ report: { worktree: 'w1', visibleSessions: ['s1'] } }))
    expect(sessionViewed(viewing, 's1')).toBe(true)
    expect(sessionViewed(viewing, 's2')).toBe(false)
    expect(worktreeViewed(viewing, 'w1')).toBe(true)
    expect(worktreeViewed(viewing, 'w2')).toBe(false)
  })

  test('the session the view was opened on counts as visible', () => {
    const viewing = viewingOf(uiState({ view: { id: VIEW, input: { worktree: 'w1', session: 's9' } } }))
    expect(sessionViewed(viewing, 's9')).toBe(true)
  })

  test('the sessions of the open floating panel are viewed beside the worktree view', () => {
    const viewing = viewingOf(uiState({ report: { worktree: 'w1', visibleSessions: ['s1'] }, overlay: { shown: true, visibleSessions: ['f1', 'f2'] } }))
    expect([...viewing.visibleSessions].sort()).toEqual(['f1', 'f2', 's1'])
    expect(sessionViewed(viewing, 'f2')).toBe(true)
  })

  test('the floating panel counts whichever worktree view is shown, or none', () => {
    const overlay = { shown: true, visibleSessions: ['f1'] }
    expect(sessionViewed(viewingOf(uiState({ report: { worktree: 'w2', visibleSessions: ['s1'] }, overlay })), 'f1')).toBe(true)
    const noView = { ...uiState({ overlay }), layout: { view: null, panel: null, sidebar: true, focus: null } } as UiState
    const viewing = viewingOf(noView)
    expect(sessionViewed(viewing, 'f1')).toBe(true)
    expect(viewing.shownWorktree).toBeNull()
  })

  test('a minimized floating panel views nothing', () => {
    expect(sessionViewed(viewingOf(uiState({ overlay: { shown: false, visibleSessions: ['f1'] } })), 'f1')).toBe(false)
    expect(sessionViewed(viewingOf(uiState({ overlay: { visibleSessions: ['f1'] } })), 'f1')).toBe(false)
  })

  test('an away person views nothing in the floating panel either', () => {
    const away = [{ connId: 1, focused: true, inputAt: null, present: false }]
    expect(sessionViewed(viewingOf(uiState({ windows: away, overlay: { shown: true, visibleSessions: ['f1'] } })), 'f1')).toBe(false)
  })

  test('a report about another worktree shows nothing', () => {
    const viewing = viewingOf(uiState({ report: { worktree: 'w2', visibleSessions: ['s1'] } }))
    expect(sessionViewed(viewing, 's1')).toBe(false)
  })

  test('a focused window that is away views nothing but still has the worktree open', () => {
    const viewing = viewingOf(
      uiState({ windows: [{ connId: 1, focused: true, inputAt: null, present: false }], report: { worktree: 'w1', visibleSessions: ['s1'] } })
    )
    expect(sessionViewed(viewing, 's1')).toBe(false)
    expect(worktreeViewed(viewing, 'w1')).toBe(false)
    expect(worktreeOpenInFocusedWindow(viewing, 'w1')).toBe(true)
  })

  test('an unfocused window has nothing open for the focus check', () => {
    const viewing = viewingOf(uiState({ windows: [{ connId: 1, focused: false, inputAt: 1, present: true }] }))
    expect(viewing.focused).toBe(false)
    expect(worktreeOpenInFocusedWindow(viewing, 'w1')).toBe(false)
    expect(worktreeViewed(viewing, 'w1')).toBe(false)
  })

  test('another view, or none, shows no worktree', () => {
    expect(viewingOf(uiState({ view: { id: 'view:acme/other', input: { worktree: 'w1' } } })).shownWorktree).toBeNull()
    expect(viewingOf({ ...uiState({}), layout: { view: null, panel: null, sidebar: true, focus: null } }).shownWorktree).toBeNull()
    expect(NOT_VIEWING.attended).toBe(false)
  })
})

describe('player command', () => {
  test('QUIRKY_SOUND_PLAYER is called with the file and the volume', () => {
    expect(playerArgv('/s/a.wav', 40, { QUIRKY_SOUND_PLAYER: '/bin/rec' })).toEqual(['/bin/rec', '/s/a.wav', '40'])
  })

  test('afplay takes the volume as a fraction', () => {
    expect(playerArgv('/s/a.wav', 60, {})).toEqual(['afplay', '-v', '0.6', '/s/a.wav'])
  })
})

type Fake = {
  context: PluginContext
  notifications: PluginNotification[]
  emitted: [string, unknown][]
  calls: [string, unknown][]
}

/** A plugin context over canned answers, for sources the daemon rig cannot produce. */
function fakeContext(answers: Record<string, unknown>, settings: Record<string, unknown> = {}): Fake {
  const notifications: PluginNotification[] = []
  const emitted: [string, unknown][] = []
  const calls: [string, unknown][] = []
  const defaults: Record<string, unknown> = {
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
      emitted.push([event, data])
      return true
    },
    getSetting: (name: string) => defaults[name],
    notify: (n: PluginNotification) => notifications.push(n),
    error: (_kind: string, message: string) => new Error(message),
    call: async (method: string, params: unknown) => {
      calls.push([method, params])
      if (!(method in answers)) throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 })
      const answer = answers[method]
      return typeof answer === 'function' ? (answer as (p: unknown) => unknown)(params) : answer
    }
  } as unknown as PluginContext
  return { context, notifications, emitted, calls }
}

const idle: UiState = { windows: [], layout: { view: null, panel: null, sidebar: true, focus: null }, toasts: [], slots: [] }
const settledEvent = (type: string, data: Record<string, unknown>) => ({ type, data }) as QuirkyEvent

describe('structured sessions', () => {
  const answers = {
    'ui.state': idle,
    'status.get': { clients: [] },
    'quirky.worktree/resolve': { id: 'w1', name: 'fix-tests', repoId: 'repo_1', kind: 'git' },
    'quirky.repo/resolve': { name: 'quirky', displayName: null },
    'quirky.agents/get': { label: 'Codex' },
    'quirky.session/setUnread': {},
    'quirky.worktree/set': {},
    'quirky.worktree/list': [],
    'quirky.session/list': [],
    'quirky.ask/list': []
  }

  test('SC-23: a structured codex session\'s banner reads like an agent\'s', async () => {
    const fake = fakeContext(answers)
    const service = new NotificationsService(fake.context)

    service.onEvent(
      settledEvent('quirky.structured/settled', { sessionId: 's1', worktreeId: 'w1', agent: 'codex', state: 'done', lastAssistantMessage: 'Done.', at: 1 })
    )
    await Bun.sleep(30)

    expect(fake.notifications).toMatchObject([{ title: 'quirky / fix-tests - Codex finished', body: 'Done.', sessionId: 's1', worktreeId: 'w1' }])
    expect(fake.emitted.filter(([event]) => event === 'attention')).toHaveLength(1)
    expect(fake.calls).toContainEqual(['quirky.session/setUnread', { session: 's1', unread: 'agent' }])
    service.shutdown()
  })

  test('a missing agents plugin falls back to the capitalised id, and a missing repo plugin to the worktree alone', async () => {
    const { 'quirky.agents/get': _agents, 'quirky.repo/resolve': _repo, ...rest } = answers
    const fake = fakeContext(rest)
    const service = new NotificationsService(fake.context)

    service.onEvent(settledEvent('quirky.structured/settled', { sessionId: 's1', worktreeId: 'w1', agent: 'codex', state: 'done', at: 1 }))
    await Bun.sleep(30)

    expect(fake.notifications).toMatchObject([{ title: 'fix-tests - Codex finished', body: 'Codex finished.' }])
    service.shutdown()
  })

  test('events are decided in the order they arrive', async () => {
    const fake = fakeContext(answers, { enabled: false })
    const service = new NotificationsService(fake.context)

    for (const sessionId of ['a', 'b', 'c']) {
      service.onEvent(settledEvent('quirky.structured/settled', { sessionId, worktreeId: 'w1', agent: 'codex', state: 'done', at: 1 }))
    }
    await Bun.sleep(60)

    expect(fake.emitted.filter(([event]) => event === 'decided').map(([, data]) => (data as { sessionId: string }).sessionId)).toEqual(['a', 'b', 'c'])
    service.shutdown()
  })
})

describe('asks', () => {
  const ask = {
    id: 'ask_1',
    spec: { title: 'Deploy?', questions: [{ id: 'go', question: 'Ship?', type: 'confirm' }] },
    sessionId: null,
    worktreeId: null,
    queued: false,
    envelope: { status: 'pending' }
  }
  const answers = (pending: unknown[]) => ({
    'ui.state': idle,
    'status.get': { clients: [] },
    'quirky.worktree/list': [],
    'quirky.session/list': [],
    'quirky.ask/list': pending
  })

  test('an ask whose deadline passed before it was announced is not announced', async () => {
    const fake = fakeContext(answers([]))
    const service = new NotificationsService(fake.context)
    service.onEvent(settledEvent('quirky.ask/created', { ask, seq: 1 }))
    await Bun.sleep(30)
    expect(fake.notifications).toEqual([])
    expect(fake.emitted.filter(([event]) => event === 'decided')).toEqual([])
    service.shutdown()
  })

})
