import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { startNotificationsE2E, waitFor, type NotificationsE2E } from './support'

const AWAY_MS = 3000

let n: NotificationsE2E
beforeAll(async () => {
  n = await startNotificationsE2E({ awayMs: AWAY_MS })
}, 90_000)
afterAll(() => n?.cleanup())
beforeEach(() => n.reset(), 30_000)

describe('unread markers through the CLI', () => {
  test(
    'SC-1: an agent finishing in a background worktree marks its session and worktree',
    async () => {
      const a = await n.main()
      const b = await n.worktree('sc1-b')
      const shell = await n.shell(a)
      const s = await n.claude(b)
      await n.win.focus()
      await n.win.input()
      await n.win.open(a.id, [shell.id])
      const from = n.events.length

      await n.finish(s, 'All green')
      await n.decision({ sessionId: s.id }, from)

      const session = await n.json<{ unread?: string | null }>(['session', 'get', s.id])
      expect(session.unread).toBe('agent')
      const text = await n.e2e.cli(['session', 'get', s.id])
      expect(text.stdout).toMatch(/unread: agent/)
      const shown = await n.e2e.cli(['wt', 'show', `id:${b.id}`])
      expect(shown.stdout).toMatch(/unread: yes/)
      const status = await n.status()
      expect(status.badge).toBe(1)
      expect(status.unreadWorktrees).toEqual([{ id: b.id, name: b.name }])
      expect(status.unreadSessions).toEqual([{ id: s.id, worktreeId: b.id, reason: 'agent' }])
      expect((await n.worktreeRecord(a.id)).unread).toBeFalsy()
      expect((await n.sessionRecord(shell.id)).unread ?? null).toBeNull()
    },
    60_000
  )

  test(
    'SC-2: finishing in the session on screen marks nothing and sends no banner',
    async () => {
      const b = await n.worktree('sc2-b')
      const s = await n.claude(b)
      await n.win.focus()
      await n.win.input()
      await n.win.open(b.id, [s.id])
      const from = n.events.length

      await n.finish(s, 'done')
      const decided = await n.decision({ sessionId: s.id }, from)

      expect(decided.result).toBe('suppressed-focus')
      expect((await n.sessionRecord(s.id)).unread ?? null).toBeNull()
      expect((await n.worktreeRecord(b.id)).unread).toBeFalsy()
      expect((await n.status()).badge).toBe(0)
      expect(n.notifies(from)).toEqual([])
    },
    60_000
  )

  test(
    'SC-3: a background tab of the open worktree is marked, the worktree is not',
    async () => {
      const b = await n.worktree('sc3-b')
      const s1 = await n.claude(b)
      const s2 = await n.claude(b)
      await n.win.focus()
      await n.win.input()
      await n.win.open(b.id, [s1.id])
      const from = n.events.length

      await n.finish(s2, 'done')
      const decided = await n.decision({ sessionId: s2.id }, from)

      expect(decided.result).toBe('suppressed-focus')
      expect((await n.sessionRecord(s2.id)).unread).toBe('agent')
      expect((await n.worktreeRecord(b.id)).unread).toBeFalsy()
      expect((await n.status()).badge).toBe(0)
      expect(n.notifies(from)).toEqual([])
    },
    60_000
  )

  test(
    'SC-4: an away person still gets the marker, and the next touch clears it',
    async () => {
      const b = await n.worktree('sc4-b')
      const s = await n.claude(b)
      await n.win.focus()
      await n.win.input()
      await n.win.open(b.id, [s.id])
      await n.e2e.shim('claude', s.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { pid: s.pid })
      await Bun.sleep(AWAY_MS + 300)
      const from = n.events.length

      await n.e2e.shim('claude', s.id, { hook_event_name: 'Stop', last_assistant_message: 'done' }, { pid: s.pid })
      await n.decision({ sessionId: s.id }, from)

      expect((await n.sessionRecord(s.id)).unread).toBe('agent')
      expect((await n.worktreeRecord(b.id)).unread).toBe(true)
      expect((await n.status()).badge).toBe(1)

      await n.win.input()

      await waitFor(async () => (await n.status()).badge === 0, 10_000, 'the badge to return to 0')
      expect((await n.sessionRecord(s.id)).unread ?? null).toBeNull()
      expect((await n.worktreeRecord(b.id)).unread).toBeFalsy()
    },
    60_000
  )

  test(
    'SC-7: wt set --read clears the worktree and its sessions, --unread marks only the worktree',
    async () => {
      const b = await n.worktree('sc7-b')
      const s1 = await n.claude(b)
      const s2 = await n.claude(b)
      await n.finish(s1, 'one')
      await n.finish(s2, 'two')
      await waitFor(async () => (await n.status()).unreadSessions.length === 2, 10_000, 'both sessions to be marked')
      expect((await n.status()).badge).toBe(1)

      const read = await n.e2e.cli(['wt', 'set', `id:${b.id}`, '--read'])
      expect(read.code).toBe(0)
      await waitFor(async () => (await n.status()).badge === 0, 10_000, 'the badge to drop')
      await waitFor(async () => (await n.status()).unreadSessions.length === 0, 10_000, 'the sessions to clear')

      const unread = await n.e2e.cli(['wt', 'set', `id:${b.id}`, '--unread'])
      expect(unread.code).toBe(0)
      const status = await waitFor(async () => ((await n.status()).badge === 1 ? await n.status() : undefined), 10_000, 'the badge to rise')
      expect(status.unreadWorktrees).toEqual([{ id: b.id, name: b.name }])
      expect(status.unreadSessions).toEqual([])
      expect((await n.sessionRecord(s1.id)).unread ?? null).toBeNull()
      expect((await n.sessionRecord(s2.id)).unread ?? null).toBeNull()
    },
    90_000
  )

  test(
    'SC-7: --read on an already-read worktree still clears its unread session',
    async () => {
      const b = await n.worktree('sc7-c')
      const s1 = await n.claude(b)
      const s2 = await n.claude(b)
      await n.win.focus()
      await n.win.input()
      await n.win.open(b.id, [s2.id])
      const from = n.events.length
      await n.finish(s1, 'done')
      await n.decision({ sessionId: s1.id }, from)
      expect((await n.sessionRecord(s1.id)).unread).toBe('agent')
      expect((await n.worktreeRecord(b.id)).unread).toBeFalsy()

      const read = await n.e2e.cli(['wt', 'set', `id:${b.id}`, '--read'])

      expect(read.code).toBe(0)
      await waitFor(async () => ((await n.sessionRecord(s1.id)).unread ?? null) === null, 10_000, 'the session to clear')
    },
    60_000
  )

  test(
    'SC-10: closing a session drops its marker from the count and leaves the worktree unread',
    async () => {
      const b = await n.worktree('sc10-b')
      const s = await n.claude(b)
      const from = n.events.length
      await n.finish(s, 'done')
      await n.decision({ sessionId: s.id }, from)
      expect((await n.status()).unreadSessions.map((session) => session.id)).toEqual([s.id])

      const closed = await n.e2e.cli(['session', 'close', s.id])

      expect(closed.code).toBe(0)
      const status = await waitFor(
        async () => {
          const current = await n.status()
          return current.unreadSessions.length === 0 ? current : undefined
        },
        10_000,
        'the session to leave the status'
      )
      expect(status.unreadWorktrees).toEqual([{ id: b.id, name: b.name }])
      expect(status.badge).toBe(1)
    },
    60_000
  )
})
