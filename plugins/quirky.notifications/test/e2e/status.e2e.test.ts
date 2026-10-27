import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startNotificationsE2E, waitFor, type NotificationsE2E, type Status } from './support'

let n: NotificationsE2E
beforeAll(async () => {
  n = await startNotificationsE2E()
}, 90_000)
afterAll(() => n?.cleanup())

const ask = (text: string) =>
  n.call('quirky.ask/create', { spec: { questions: [{ id: 'go', question: text, type: 'confirm' }] } }) as Promise<{ askId: string }>

type ApiDescription = {
  methods: { name: string; plugin: string | null; params: { type?: string }; result: { properties?: Record<string, unknown> } }[]
  events: { name: string }[]
}

describe('the badge and the status command', () => {
  test('a quiet home has badge 0 and an empty label', async () => {
    const status = await n.status()

    expect(status).toEqual({ badge: 0, label: '', unreadWorktrees: [], unreadSessions: [], pendingAsks: 0, sound: { ok: true } })
  })

  test(
    'SC-42: the badge counts unread worktrees plus pending asks, and unread sessions add nothing',
    async () => {
      const b = await n.worktree('sc42-b')
      const c = await n.worktree('sc42-c')
      const sessions = [await n.shell(b), await n.shell(b), await n.shell(b)]
      for (const s of sessions) await n.call('quirky.session/setUnread', { session: s.id, unread: 'agent' })
      for (const w of [b, c]) expect((await n.e2e.cli(['wt', 'set', `id:${w.id}`, '--unread'])).code).toBe(0)
      await ask('One?')
      await ask('Two?')

      const status = await n.json<Status>(['notifications', 'status'])

      expect(status.badge).toBe(4)
      expect(status.label).toBe('4')
      expect(status.pendingAsks).toBe(2)
      expect(status.unreadWorktrees.map((w) => w.name).sort()).toEqual(['sc42-b', 'sc42-c'])
      expect(status.unreadSessions.map((s) => s.id).sort()).toEqual(sessions.map((s) => s.id).sort())
      for (const s of status.unreadSessions) expect(s).toEqual({ id: s.id, worktreeId: b.id, reason: 'agent' })
      const text = await n.e2e.cli(['notifications', 'status'])
      expect(text.stdout.split('\n')[0]).toBe('badge 4')
      expect(text.stdout).toContain('asks 2')
      expect(text.stdout).toContain('sound ok')
    },
    90_000
  )

  test(
    'the label reads 99+ above 99',
    async () => {
      for (let i = 0; i < 118; i++) await ask(`Question ${i}?`)

      const status = await waitFor(
        async () => {
          const current = await n.status()
          return current.pendingAsks === 120 ? current : undefined
        },
        20_000,
        'the pending asks to be counted'
      )

      expect(status.badge).toBe(122)
      expect(status.label).toBe('99+')
    },
    90_000
  )

  test('SC-52: the API lists status, send, test and preview with their schemas', async () => {
    const description = await n.json<ApiDescription>(['api'])

    const ours = description.methods.filter((method) => method.plugin === 'quirky.notifications')
    expect(ours.map((method) => method.name).sort()).toEqual([
      'quirky.notifications/preview',
      'quirky.notifications/send',
      'quirky.notifications/status',
      'quirky.notifications/test'
    ])
    for (const method of ours) {
      expect(method.params.type).toBe('object')
      expect(method.result.properties).toBeDefined()
    }
    const status = ours.find((method) => method.name === 'quirky.notifications/status')!
    expect(Object.keys(status.result.properties!).sort()).toEqual(['badge', 'label', 'pendingAsks', 'sound', 'unreadSessions', 'unreadWorktrees'])
    expect(description.events.map((event) => event.name).filter((name) => name.startsWith('quirky.notifications/')).sort()).toEqual([
      'quirky.notifications/attention',
      'quirky.notifications/changed',
      'quirky.notifications/decided',
      'quirky.notifications/sound'
    ])
  })
})
