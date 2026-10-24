import { describe, expect, test } from 'bun:test'
import type { Ask, QuirkyEvent, Session } from '@quirky/protocol'
import { badgeCount, badgeLabel, createBadgeUpdater, notificationFor, shouldRefreshBadge } from '../src/bun/events'

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
  test('maps a notify event to a notification', () => {
    const event: QuirkyEvent = { type: 'notify', title: 'Claude', body: 'needs input', sessionId: 's1' }
    expect(notificationFor(event)).toEqual({ title: 'Claude', body: 'needs input' })
  })

  test('falls back to the app name for a blank title', () => {
    const event: QuirkyEvent = { type: 'notify', title: '  ', body: 'hello' }
    expect(notificationFor(event)).toEqual({ title: 'Quirky', body: 'hello' })
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

  test('only session and ask events trigger a refresh', () => {
    expect(shouldRefreshBadge({ type: 'session.changed', session: session('a', 'waiting') })).toBe(true)
    expect(shouldRefreshBadge({ type: 'session.removed', sessionId: 'a' })).toBe(true)
    expect(shouldRefreshBadge({ type: 'ask.created', ask: ask('x') })).toBe(true)
    expect(shouldRefreshBadge({ type: 'ask.resolved', askId: 'x', envelope: ask('x').envelope })).toBe(true)
    expect(shouldRefreshBadge({ type: 'git.changed', worktreeId: 'w' })).toBe(false)
    expect(shouldRefreshBadge({ type: 'notify', title: 't', body: 'b' })).toBe(false)
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
