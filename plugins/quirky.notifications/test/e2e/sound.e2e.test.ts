import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startNotificationsE2E, waitFor, type Delivery, type NotificationsE2E } from './support'

let n: NotificationsE2E
beforeAll(async () => {
  n = await startNotificationsE2E()
}, 90_000)
afterAll(() => n?.cleanup())
beforeEach(() => n.reset(), 30_000)

type Preview = { played: boolean; reason?: string }

const send = (worktree: string) => n.json<Delivery>(['notifications', 'send', '--worktree', worktree, '--title', 'Deploy', '--body', 'staging is up'])

describe('sounds with no desktop client connected', () => {
  test(
    'SC-39: the daemon shows the banner through the OS notifier and plays the Ding file at full volume',
    async () => {
      const wt = await n.worktree('sc39-a')
      const s = await n.claude(wt)
      await n.setting('sound', 'ding')
      await n.setting('volume', 100)
      const banners = n.osBanners().length
      const played = n.played().length
      const from = n.events.length

      await n.finish(s, 'All green')
      const decided = await n.decision({ sessionId: s.id }, from)

      expect(decided.result).toBe('delivered')
      await waitFor(() => n.osBanners().length === banners + 1, 10_000, 'the OS banner')
      const script = n.osBanners().at(-1)!
      expect(script).toContain('with title "')
      expect(script).toContain('Claude finished')
      expect(script).toContain('display notification "All green"')
      expect(script).not.toContain('sound name')
      await waitFor(() => n.played().length === played + 1, 10_000, 'the sound player')
      expect(n.played().at(-1)).toMatch(/\/quirky\.notifications\/sounds\/ding\.wav 100$/)
      expect(n.notifies(from)[0]!.sound).toEqual({ file: expect.stringMatching(/sounds\/ding\.wav$/), volume: 100 })
    },
    60_000
  )

  test(
    'System Default shows the banner with the system sound and plays no file',
    async () => {
      await n.setting('sound', 'system')
      const wt = await n.worktree('sc39-b')
      const banners = n.osBanners().length
      const played = n.played().length
      const from = n.events.length

      expect(await send(wt.name)).toEqual({ delivered: true, reason: 'delivered' })

      await waitFor(() => n.osBanners().length === banners + 1, 10_000, 'the OS banner')
      expect(n.osBanners().at(-1)).toContain('sound name "default"')
      expect(n.notifies(from)[0]!.sound).toEqual({ file: null, volume: 100 })
      await Bun.sleep(300)
      expect(n.played()).toHaveLength(played)
    },
    60_000
  )

  test(
    'SC-38: a banner that is not delivered shows nothing and plays nothing',
    async () => {
      await n.setting('sound', 'ding')
      const wt = await n.worktree('sc38-a')
      const banners = n.osBanners().length
      const played = n.played().length
      await n.setting('enabled', false)
      try {
        expect(await send(wt.name)).toEqual({ delivered: false, reason: 'disabled' })
      } finally {
        await n.setting('enabled', true)
      }

      await Bun.sleep(500)
      expect(n.osBanners()).toHaveLength(banners)
      expect(n.played()).toHaveLength(played)
    },
    60_000
  )

  test(
    'SC-40: a stored custom path that goes bad leaves the banner delivered but silent, and status reports why',
    async () => {
      await n.setting('sound', 'custom')
      await n.setting('customSoundPath', join(n.scratch, 'gone.wav'))
      try {
        const wt = await n.worktree('sc40-a')
        const played = n.played().length
        const from = n.events.length

        expect((await n.status()).sound).toEqual({ ok: false, reason: 'does not exist' })
        expect(await send(wt.name)).toEqual({ delivered: true, reason: 'delivered' })

        expect(n.notifies(from)[0]!.sound).toBeUndefined()
        await Bun.sleep(300)
        expect(n.played()).toHaveLength(played)
      } finally {
        await n.setting('sound', 'system')
        await n.setting('customSoundPath', '')
      }
    },
    60_000
  )
})

describe('preview', () => {
  test(
    'SC-40: a custom file must be an absolute path to a readable audio file of at most 10 MiB',
    async () => {
      const aiff = join(n.scratch, 'chime.aiff')
      const huge = join(n.scratch, 'huge.wav')
      const small = join(n.scratch, 'small.wav')
      writeFileSync(aiff, Buffer.alloc(1024))
      writeFileSync(huge, Buffer.alloc(11 * 1024 * 1024))
      writeFileSync(small, Buffer.alloc(1024))
      const played = n.played().length
      const from = n.events.length

      const reasons = []
      for (const path of ['relative.wav', join(n.scratch, 'missing.wav'), aiff, huge]) {
        const result = await n.e2e.cli(['notifications', 'preview', '--path', path])
        reasons.push(result.stdout.trim())
      }

      expect(reasons).toEqual([
        'must be an absolute path',
        'does not exist',
        'must be .ogg, .mp3, .wav, .m4a, .aac or .flac',
        'is over 10 MiB'
      ])
      await Bun.sleep(300)
      expect(n.played()).toHaveLength(played)

      const ok = await n.e2e.cli(['notifications', 'preview', '--path', small])
      expect(ok.stdout.trim()).toBe('played')
      await waitFor(() => n.played().length === played + 1, 10_000, 'the sound player')
      expect(n.played().at(-1)).toBe(`${small} 100`)
      expect(n.notifies(from)).toEqual([])
    },
    60_000
  )

  test(
    'SC-41: preview plays a built-in sound at the given volume, with no banner and no marker',
    async () => {
      const played = n.played().length
      const from = n.events.length

      const result = await n.json<Preview>(['notifications', 'preview', '--sound', 'sonar', '--volume', '40'])

      expect(result).toEqual({ played: true })
      await waitFor(() => n.played().length === played + 1, 10_000, 'the sound player')
      expect(n.played().at(-1)).toMatch(/\/quirky\.notifications\/sounds\/sonar\.wav 40$/)
      const sound = n.events.slice(from).find((event) => event.type === 'quirky.notifications/sound') as { data: { file: string; volume: number } }
      expect(sound.data).toEqual({ file: expect.stringMatching(/sounds\/sonar\.wav$/), volume: 40 })
      expect(n.notifies(from)).toEqual([])
      const status = await n.status()
      expect(status.unreadWorktrees).toEqual([])
      expect(status.unreadSessions).toEqual([])
    },
    60_000
  )

  test(
    'System Default has no preview',
    async () => {
      const played = n.played().length

      const result = await n.json<Preview>(['notifications', 'preview', '--sound', 'system'])

      expect(result).toEqual({ played: false, reason: 'System Default has no preview' })
      await Bun.sleep(300)
      expect(n.played()).toHaveLength(played)
    },
    60_000
  )
})
