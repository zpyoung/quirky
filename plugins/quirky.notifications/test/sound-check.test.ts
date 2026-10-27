import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SOUND_IDS,
  SOUND_LABELS,
  builtinSoundFile,
  checkCustomSound,
  deliverySound,
} from '../src/sounds'

const dir = mkdtempSync(join(tmpdir(), 'quirky-sound-check-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const file = (name: string) => {
  const p = join(dir, name)
  writeFileSync(p, 'x')
  return p
}

describe('catalog', () => {
  test('ids and labels', () => {
    expect([...SOUND_IDS]).toEqual([
      'system', 'two-tone', 'bong', 'thump', 'blip', 'sonar', 'blop', 'ding', 'clack', 'beep', 'custom',
    ])
    expect(SOUND_LABELS.system).toBe('System Default')
    expect(SOUND_LABELS['two-tone']).toBe('Two Tone')
    expect(SOUND_LABELS.custom).toBe('Custom')
  })

  test('built-in file path', () => {
    expect(builtinSoundFile('/p', 'bong')).toBe('/p/sounds/bong.wav')
  })
})

describe('checkCustomSound', () => {
  test('accepts a readable audio file with any extension case', async () => {
    expect(await checkCustomSound(file('ok.WAV'))).toEqual({ ok: true })
  })

  test('relative path', async () => {
    expect(await checkCustomSound('sounds/a.wav')).toEqual({ ok: false, reason: 'must be an absolute path' })
  })

  test('missing file', async () => {
    expect(await checkCustomSound(join(dir, 'nope.wav'))).toEqual({ ok: false, reason: 'does not exist' })
  })

  test('wrong extension', async () => {
    expect(await checkCustomSound(file('a.txt'))).toEqual({
      ok: false,
      reason: 'must be .ogg, .mp3, .wav, .m4a, .aac or .flac',
    })
  })

  test('over 10 MiB fails, exactly 10 MiB passes', async () => {
    const big = file('big.mp3')
    truncateSync(big, 10 * 1024 * 1024 + 1)
    expect(await checkCustomSound(big)).toEqual({ ok: false, reason: 'is over 10 MiB' })
    const edge = file('edge.mp3')
    truncateSync(edge, 10 * 1024 * 1024)
    expect(await checkCustomSound(edge)).toEqual({ ok: true })
  })

  test('unreadable', async () => {
    if (process.getuid?.() === 0) return
    const p = file('locked.ogg')
    chmodSync(p, 0o000)
    expect(await checkCustomSound(p)).toEqual({ ok: false, reason: 'could not be read' })
    chmodSync(p, 0o600)
  })
})

describe('deliverySound', () => {
  test('system has no file', async () => {
    expect(await deliverySound({ sound: 'system', customSoundPath: '', volume: 60, pluginDir: '/p' })).toEqual({
      sound: { file: null, volume: 60 },
    })
  })

  test('built-in resolves to its file', async () => {
    expect(await deliverySound({ sound: 'ding', customSoundPath: '', volume: 30, pluginDir: '/p' })).toEqual({
      sound: { file: '/p/sounds/ding.wav', volume: 30 },
    })
  })

  test('custom that passes', async () => {
    const p = file('mine.flac')
    expect(await deliverySound({ sound: 'custom', customSoundPath: p, volume: 80, pluginDir: '/p' })).toEqual({
      sound: { file: p, volume: 80 },
    })
  })

  test('custom that fails is silent with a problem', async () => {
    expect(
      await deliverySound({ sound: 'custom', customSoundPath: join(dir, 'gone.wav'), volume: 80, pluginDir: '/p' }),
    ).toEqual({ problem: 'does not exist' })
  })

  test('custom with no path', async () => {
    expect(await deliverySound({ sound: 'custom', customSoundPath: '', volume: 80, pluginDir: '/p' })).toEqual({
      problem: 'no custom file chosen',
    })
  })
})
