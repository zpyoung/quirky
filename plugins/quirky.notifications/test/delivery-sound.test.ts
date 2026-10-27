import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { Rig } from './support'

let rig: Rig
afterEach(() => rig?.cleanup())

const preview = (params: Record<string, unknown>) => rig.client.callAny('quirky.notifications/preview', params)
const SOUNDS = join(import.meta.dir, '..', 'sounds')

describe('delivery sound', () => {
  test('SC-37: a delivered banner carries the chosen sound', async () => {
    rig = await Rig.start({ cooldownMs: 1 })
    await rig.setting('sound', 'bong')
    await rig.setting('volume', 60)
    const s = await rig.session('b', 'claude')
    await rig.claudeTurn(s.id, 'one')
    await rig.waitDecided(1)
    expect(rig.notifies()[0]!.sound).toEqual({ file: join(SOUNDS, 'bong.wav'), volume: 60 })

    await rig.setting('sound', 'system')
    await Bun.sleep(5)
    await rig.claudeTurn(s.id, 'two')
    await rig.waitDecided(2)
    expect(rig.notifies()[1]!.sound).toEqual({ file: null, volume: 60 })
  })

  test('SC-38: no banner, no sound', async () => {
    rig = await Rig.start()
    await rig.setting('sound', 'ding')
    const b = await rig.worktree('b')
    const s = await rig.session('b', 'claude')
    await rig.client.callAny('quirky.notifications/send', { worktree: b.id, body: 'first' })
    rig.h.notifications.length = 0
    await waitFor(() => rig.played().length === 1)

    await rig.claudeTurn(s.id, 'cooldown')
    await rig.waitDecided(2)
    expect(rig.decisions()[1]).toMatchObject({ result: 'cooldown' })

    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [s.id])
    await rig.claudeTurn(s.id, 'suppressed')
    await rig.waitDecided(3)
    expect(rig.decisions()[2]).toMatchObject({ result: 'suppressed-focus' })

    await rig.settle()
    expect(rig.notifies()).toHaveLength(1)
    expect(rig.played()).toHaveLength(1)
    expect(rig.h.notifications).toEqual([])
  })

  test('SC-39: with no desktop client the daemon shows and plays it', async () => {
    rig = await Rig.start()
    await rig.setting('sound', 'ding')
    const s = await rig.session('b', 'claude')

    await rig.claudeTurn(s.id, 'done')
    await rig.waitDecided(1)

    expect(rig.h.notifications).toEqual([{ title: 'quirky / b - Claude finished', body: 'done' }])
    await waitFor(() => rig.played().length === 1)
    expect(rig.played()).toEqual([`${join(SOUNDS, 'ding.wav')} 100`])
  })

  test('with a desktop client connected the shell plays it, not the daemon', async () => {
    rig = await Rig.start()
    await rig.setting('sound', 'ding')
    await rig.h.connect('desktop', 'shell')
    const s = await rig.session('b', 'claude')

    await rig.claudeTurn(s.id, 'done')
    await rig.waitDecided(1)
    await rig.settle()

    expect(rig.notifies()[0]!.sound).toEqual({ file: join(SOUNDS, 'ding.wav'), volume: 100 })
    expect(rig.h.notifications).toEqual([])
    expect(rig.played()).toEqual([])
  })

  test('the system sound is left to the OS notifier', async () => {
    rig = await Rig.start()
    const s = await rig.session('b', 'claude')

    await rig.claudeTurn(s.id, 'done')
    await rig.waitDecided(1)
    await rig.settle()

    expect(rig.notifies()[0]!.sound).toEqual({ file: null, volume: 100 })
    expect(rig.played()).toEqual([])
  })

  test('a custom file that went bad leaves the banner delivered but silent, and status says why', async () => {
    rig = await Rig.start()
    await rig.setting('sound', 'custom')
    await rig.setting('customSoundPath', '/nonexistent/sound.wav')
    const s = await rig.session('b', 'claude')

    await rig.claudeTurn(s.id, 'done')
    await rig.waitDecided(1)

    expect(rig.notifies()).toHaveLength(1)
    expect(rig.notifies()[0]!.sound).toBeUndefined()
    expect((await rig.status()).sound).toEqual({ ok: false, reason: 'does not exist' })
    expect(rig.played()).toEqual([])
  })
})

describe('preview', () => {
  test('SC-40: a custom file must be a readable audio file', async () => {
    rig = await Rig.start()
    const dir = makeTempDir('qn-audio-')
    const aiff = join(dir, 'Glass.aiff')
    const big = join(dir, 'big.wav')
    const small = join(dir, 'small.wav')
    writeFileSync(aiff, 'x')
    writeFileSync(big, Buffer.alloc(11 * 1024 * 1024))
    writeFileSync(small, Buffer.alloc(1024))

    expect(await preview({ path: 'relative.wav' })).toEqual({ played: false, reason: 'must be an absolute path' })
    expect(await preview({ path: join(dir, 'missing.wav') })).toEqual({ played: false, reason: 'does not exist' })
    expect(await preview({ path: aiff })).toEqual({ played: false, reason: 'must be .ogg, .mp3, .wav, .m4a, .aac or .flac' })
    expect(await preview({ path: big })).toEqual({ played: false, reason: 'is over 10 MiB' })
    expect(rig.played()).toEqual([])
    expect(rig.pluginEvents('sound')).toEqual([])

    expect(await preview({ path: small, volume: 70 })).toEqual({ played: true })
    await waitFor(() => rig.played().length === 1)
    expect(rig.played()).toEqual([`${small} 70`])
    expect(rig.pluginEvents('sound')).toEqual([{ file: small, volume: 70 }])
  })

  test('SC-41: preview plays a sound now, with no banner and no marker', async () => {
    rig = await Rig.start()

    expect(await preview({ sound: 'sonar', volume: 40 })).toEqual({ played: true })

    await waitFor(() => rig.played().length === 1)
    expect(rig.played()).toEqual([`${join(SOUNDS, 'sonar.wav')} 40`])
    expect(rig.pluginEvents('sound')).toEqual([{ file: join(SOUNDS, 'sonar.wav'), volume: 40 }])
    expect(rig.notifies()).toEqual([])
    expect(rig.decisions()).toEqual([])
    expect((await rig.status()).badge).toBe(0)
  })

  test('with a desktop client connected preview only tells the shell', async () => {
    rig = await Rig.start()
    await rig.h.connect('desktop', 'shell')

    expect(await preview({ sound: 'blip' })).toEqual({ played: true })

    await rig.settle()
    expect(rig.pluginEvents('sound')).toHaveLength(1)
    expect(rig.played()).toEqual([])
  })

  test('System Default has no preview, and an unusable choice says why', async () => {
    rig = await Rig.start()
    expect(await preview({})).toEqual({ played: false, reason: 'System Default has no preview' })
    expect(await preview({ sound: 'system' })).toEqual({ played: false, reason: 'System Default has no preview' })
    expect(await preview({ sound: 'custom' })).toEqual({ played: false, reason: 'no custom file chosen' })
    await expect(preview({ sound: 'kazoo' })).rejects.toThrow()
    await expect(preview({ sound: 'bong', volume: 120 })).rejects.toThrow()
  })

  test('preview uses the chosen sound and volume when none is given', async () => {
    rig = await Rig.start()
    await rig.setting('sound', 'thump')
    await rig.setting('volume', 35)

    expect(await preview({})).toEqual({ played: true })

    await waitFor(() => rig.played().length === 1)
    expect(rig.played()).toEqual([`${join(SOUNDS, 'thump.wav')} 35`])
  })
})
