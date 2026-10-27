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

function setup(table: Record<string, unknown>) {
  const notifications: PluginNotification[] = []
  const logs: string[] = []
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
    call: async (method: string) => {
      if (!(method in table)) throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 })
      const answer = table[method]
      return typeof answer === 'function' ? (answer as () => unknown)() : answer
    }
  } as unknown as PluginContext
  const service = new NotificationsService(context, { lookupTimeoutMs: 40 })
  return { service, notifications, logs }
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
