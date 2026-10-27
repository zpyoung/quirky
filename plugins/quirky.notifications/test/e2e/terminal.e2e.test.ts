import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { startNotificationsE2E, waitFor, type NotificationsE2E } from './support'

let n: NotificationsE2E
beforeAll(async () => {
  n = await startNotificationsE2E()
}, 90_000)
afterAll(() => n?.cleanup())
beforeEach(() => n.reset(), 30_000)

/** Types `printf` of `format` into a real shell session, so the PTY host sees the bytes as a program's output. */
async function print(session: Session, format: string): Promise<void> {
  const sent = await n.e2e.cli(['terminal', 'send', session.id, `printf '${format}'`, '--enter'])
  if (sent.code !== 0) throw new Error(`terminal send failed: ${sent.stderr || sent.stdout}`)
}

type TerminalNotification = { sessionId: string; title: string | null; body: string; occasion: string }

describe('terminal sources through a real PTY session', () => {
  test(
    'SC-29: OSC 777 notify marks the session and delivers "worktree: title" with the body',
    async () => {
      const wt = await n.worktree('fix-tests')
      const s = await n.shell(wt)
      const from = n.events.length

      await print(s, '\\033]777;notify;Build;done in 4s\\007')
      const decided = await n.decision({ sessionId: s.id }, from)

      expect(decided).toMatchObject({ source: 'program', result: 'delivered', worktreeId: wt.id })
      const fact = n.events
        .slice(from)
        .find((event) => event.type === 'quirky.terminal/notification') as { data: TerminalNotification } | undefined
      expect(fact?.data).toEqual({ sessionId: s.id, title: 'Build', body: 'done in 4s', occasion: 'always' })
      expect((await n.sessionRecord(s.id)).unread).toBe('notification')
      expect((await n.worktreeRecord(wt.id)).unread).toBe(true)
      const banners = n.notifies(from)
      expect(banners).toHaveLength(1)
      expect(banners[0]).toMatchObject({ title: 'fix-tests: Build', body: 'done in 4s', sessionId: s.id })
    },
    60_000
  )

  test(
    'SC-26: a bell marks the session unread even with Terminal Bell off, and the banner is source-disabled',
    async () => {
      const wt = await n.worktree('sc26-b')
      const s = await n.shell(wt)
      const from = n.events.length

      await print(s, '\\007')
      const decided = await n.decision({ sessionId: s.id, source: 'bell' }, from)

      expect(decided.result).toBe('source-disabled')
      await waitFor(async () => (await n.sessionRecord(s.id)).unread === 'bell', 10_000, 'the bell marker')
      expect((await n.worktreeRecord(wt.id)).unread).toBe(true)
      expect(n.notifies(from)).toEqual([])
    },
    60_000
  )

  test(
    'SC-26: with Terminal Bell on, the bell delivers "Bell in worktree"',
    async () => {
      const wt = await n.worktree('sc26-c')
      const s = await n.shell(wt)
      await n.setting('terminalBell', true)
      try {
        const from = n.events.length

        await print(s, '\\007')
        const decided = await n.decision({ sessionId: s.id, source: 'bell' }, from)

        expect(decided.result).toBe('delivered')
        expect(n.notifies(from)[0]).toMatchObject({ title: 'Bell in sc26-c' })
        expect((await n.sessionRecord(s.id)).unread).toBe('bell')
      } finally {
        await n.setting('terminalBell', false)
      }
    },
    60_000
  )
})
