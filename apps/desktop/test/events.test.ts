import { describe, expect, test } from 'bun:test'
import { RpcError, RpcErrorCode, type Ask, type QuirkyEvent, type Session } from '@quirky/protocol'
import {
  badgeCount,
  badgeLabel,
  createBadgeUpdater,
  loadBadgeInputs,
  notificationFor,
  shouldRefreshBadge
} from '../src/bun/events'

const session = (id: string, status: Session['status']): Session => ({
  id,
  kind: 'terminal',
  agent: 'claude',
  worktreeId: 'w1',
  cwd: '/tmp',
  title: id,
  status,
  createdAt: 0,
  lastActivityAt: 0,
  exitCode: null
})

const ask = (id: string): Ask => ({
  id,
  spec: { questions: [] },
  sessionId: null,
  worktreeId: null,
  createdAt: 0,
  envelope: { status: 'pending', askId: id, answers: {}, skipped: [] }
})

describe('notificationFor', () => {
  test('SC-23: maps a notify event for the desktop to a notification', () => {
    const event: QuirkyEvent = { type: 'notify', title: 'Claude', body: 'needs input', sessionId: 's1', desktop: true }
    expect(notificationFor(event)).toEqual({ title: 'Claude', body: 'needs input' })
  })

  test('falls back to the app name for a blank title', () => {
    const event: QuirkyEvent = { type: 'notify', title: '  ', body: 'hello', desktop: true }
    expect(notificationFor(event)).toEqual({ title: 'Quirky', body: 'hello' })
  })

  test('SC-23: a notify event without desktop: true shows no native notification', () => {
    expect(notificationFor({ type: 'notify', title: 'Claude', body: 'quiet', desktop: false })).toBeNull()
    expect(notificationFor({ type: 'notify', title: 'Claude', body: 'unspecified' })).toBeNull()
  })

  test('ignores other events', () => {
    expect(notificationFor({ type: 'repo.changed' })).toBeNull()
  })
})

describe('badge', () => {
  test('counts waiting sessions plus pending asks', () => {
    const sessions = [session('a', 'waiting'), session('b', 'working'), session('c', 'waiting'), session('d', 'done')]
    expect(badgeCount(sessions, [ask('x')])).toBe(3)
  })

  test('labels: empty for zero, capped at 99+', () => {
    expect(badgeLabel(0)).toBe('')
    expect(badgeLabel(4)).toBe('4')
    expect(badgeLabel(250)).toBe('99+')
  })

  test('SC-60: only session, ask and plugin-set events trigger a refresh', () => {
    const waiting = session('a', 'waiting')
    expect(shouldRefreshBadge({ type: 'quirky.session/changed', data: { session: waiting } })).toBe(true)
    expect(shouldRefreshBadge({ type: 'quirky.session/removed', data: { sessionId: 'a' } })).toBe(true)
    expect(shouldRefreshBadge({ type: 'quirky.ask/created', data: { ask: ask('x') } })).toBe(true)
    expect(shouldRefreshBadge({ type: 'quirky.ask/resolved', data: { askId: 'x' } })).toBe(true)
    expect(shouldRefreshBadge({ type: 'plugin.changed' })).toBe(true)
    expect(shouldRefreshBadge({ type: 'quirky.git/changed', data: {} })).toBe(false)
    expect(shouldRefreshBadge({ type: 'notify', title: 't', body: 'b' })).toBe(false)
    expect(shouldRefreshBadge({ type: 'repo.changed' })).toBe(false)
  })
})

describe('loadBadgeInputs', () => {
  const methodNotFound = (method: string) => new RpcError(RpcErrorCode.MethodNotFound, `unknown method ${method}`)

  test('reads sessions and pending asks through the plugin methods', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const inputs = await loadBadgeInputs(async (method, params) => {
      calls.push([method, params])
      return method === 'quirky.session/list' ? [session('a', 'waiting')] : [ask('x')]
    })
    expect(inputs).toEqual({ sessions: [session('a', 'waiting')], asks: [ask('x')] })
    expect(calls).toContainEqual(['quirky.session/list', {}])
    expect(calls).toContainEqual(['quirky.ask/list', { pendingOnly: true }])
  })

  test('SC-60: a method missing because its plugin is off counts as zero', async () => {
    const inputs = await loadBadgeInputs(async (method) => {
      if (method === 'quirky.session/list') throw methodNotFound(method)
      return [ask('x'), ask('y')]
    })
    expect(inputs.sessions).toEqual([])
    expect(badgeCount(inputs.sessions, inputs.asks)).toBe(2)

    const none = await loadBadgeInputs(async (method) => {
      throw methodNotFound(method)
    })
    expect(badgeCount(none.sessions, none.asks)).toBe(0)
  })

  test('any other failure propagates so the badge stays as it was', async () => {
    const failing = loadBadgeInputs(async () => {
      throw new RpcError(RpcErrorCode.Internal, 'boom')
    })
    await expect(failing).rejects.toThrow('boom')
  })
})

describe('createBadgeUpdater', () => {
  test('refresh applies the current count', async () => {
    const applied: number[] = []
    const updater = createBadgeUpdater({
      load: async () => ({ sessions: [session('a', 'waiting')], asks: [ask('x'), ask('y')] }),
      apply: (count) => applied.push(count)
    })
    await updater.refresh()
    expect(applied).toEqual([3])
  })

  test('overlapping refreshes coalesce into one trailing reload', async () => {
    let loads = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const applied: number[] = []
    const updater = createBadgeUpdater({
      load: async () => {
        loads += 1
        const n = loads
        if (n === 1) await gate
        return { sessions: Array.from({ length: n }, (_, i) => session(`s${i}`, 'waiting')), asks: [] }
      },
      apply: (count) => applied.push(count)
    })
    const first = updater.refresh()
    const second = updater.refresh()
    const third = updater.refresh()
    release()
    await Promise.all([first, second, third])
    expect(loads).toBe(2)
    expect(applied.at(-1)).toBe(2)
  })

  test('a failed load keeps the last badge and does not throw', async () => {
    const applied: number[] = []
    const updater = createBadgeUpdater({
      load: async () => {
        throw new Error('down')
      },
      apply: (count) => applied.push(count)
    })
    await updater.refresh()
    expect(applied).toEqual([])
  })

  test('reset clears the badge', () => {
    const applied: number[] = []
    const updater = createBadgeUpdater({ load: async () => ({ sessions: [], asks: [] }), apply: (c) => applied.push(c) })
    updater.reset()
    expect(applied).toEqual([0])
  })
})
