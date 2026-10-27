import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import { startNotificationsE2E, type Delivery, type NotificationsE2E } from './support'

let n: NotificationsE2E
beforeAll(async () => {
  n = await startNotificationsE2E()
}, 90_000)
afterAll(() => n?.cleanup())
beforeEach(() => n.reset(), 30_000)

const send = (args: string[]) => n.json<Delivery>(['notifications', 'send', ...args])

describe('delivery gates through the CLI', () => {
  test(
    'SC-11: the gates run in order and the result names the first that fails',
    async () => {
      const b = await n.worktree('sc11-b')
      const s = await n.shell(b)
      const base = ['--session', s.id, '--title', 'T', '--body', 'x']
      const from = n.events.length

      await n.setting('enabled', false)
      expect(await send(base)).toEqual({ delivered: false, reason: 'disabled' })
      await n.setting('enabled', true)

      await n.setting('terminalNotifications', false)
      expect(await send(base)).toEqual({ delivered: false, reason: 'source-disabled' })
      await n.setting('terminalNotifications', true)

      await n.win.focus()
      await n.win.input()
      await n.win.open(b.id, [s.id])
      expect(await send(base)).toEqual({ delivered: false, reason: 'suppressed-focus' })
      await n.win.blur()
      expect(n.notifies(from)).toEqual([])

      expect(await send(base)).toEqual({ delivered: true, reason: 'delivered' })
      expect(await send(base)).toEqual({ delivered: false, reason: 'cooldown' })

      const banners = n.notifies(from)
      expect(banners).toHaveLength(1)
      expect(banners[0]).toMatchObject({ title: 'sc11-b: T', body: 'x', sessionId: s.id, worktreeId: b.id })
    },
    90_000
  )

  test(
    'SC-13: the test notification skips the cooldown and the toast',
    async () => {
      const from = n.events.length

      const first = await n.json<Delivery>(['notifications', 'test'])
      const second = await n.json<Delivery>(['notifications', 'test'])

      expect(first).toEqual({ delivered: true, reason: 'delivered' })
      expect(second).toEqual({ delivered: true, reason: 'delivered' })
      const banners = n.notifies(from)
      expect(banners).toHaveLength(2)
      for (const banner of banners) {
        expect(banner.title).toBe('Quirky notifications are on')
        expect(banner.body).toBe('This is a test notification from Quirky.')
        expect(banner.toast).toBe(false)
      }
    },
    60_000
  )

  test(
    'SC-36: a script sends to a worktree, which is marked unread but no session is',
    async () => {
      const wt = await n.worktree('fix-tests')
      const shell = await n.shell(wt)
      const from = n.events.length

      const result = await n.e2e.cli(['notifications', 'send', '--worktree', 'fix-tests', '--title', 'Deploy', '--body', 'staging is up', '--json'])

      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ delivered: true, reason: 'delivered' })
      const banners = n.notifies(from)
      expect(banners).toHaveLength(1)
      expect(banners[0]).toMatchObject({ title: 'fix-tests: Deploy', body: 'staging is up', worktreeId: wt.id })
      expect(banners[0]!.sessionId).toBeUndefined()
      expect((await n.worktreeRecord(wt.id)).unread).toBe(true)
      expect((await n.sessionRecord(shell.id)).unread ?? null).toBeNull()
      expect((await n.status()).unreadSessions).toEqual([])
    },
    60_000
  )

  test(
    'SC-19: an agent banner names the place, the agent and the status, and carries the last message',
    async () => {
      const wt = await n.worktree('fix-tests-19')
      const s = await n.claude(wt)
      const from = n.events.length

      await n.finish(s, 'All green.\n\nRan 412 tests.')
      const decided = await n.decision({ sessionId: s.id }, from)

      expect(decided.result).toBe('delivered')
      const banners = n.notifies(from)
      expect(banners).toHaveLength(1)
      const repo = basename(n.e2e.repo)
      expect(banners[0]).toMatchObject({
        title: `${repo} / fix-tests-19 - Claude finished`,
        body: 'All green. Ran 412 tests.',
        sessionId: s.id,
        worktreeId: wt.id
      })
    },
    60_000
  )
})
