import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SOUND_IDS, generateSounds } from '../scripts/make-sounds.ts'

const SOUNDS_DIR = join(import.meta.dir, '..', 'sounds')
const PEAK_LIMIT = 23197

function parse(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  const samples = new Int16Array(view.getUint32(40, true) / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true)
  return {
    riff: tag(0),
    wave: tag(8),
    fmt: tag(12),
    data: tag(36),
    riffSize: view.getUint32(4, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    samples,
  }
}

describe('built-in sounds', () => {
  test('lists the nine ids and ships exactly those files', () => {
    expect([...SOUND_IDS]).toEqual([
      'two-tone', 'bong', 'thump', 'blip', 'sonar', 'blop', 'ding', 'clack', 'beep',
    ])
    expect(readdirSync(SOUNDS_DIR).sort()).toEqual(SOUND_IDS.map((id) => `${id}.wav`).sort())
  })

  test('committed files match a fresh deterministic render', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quirky-sounds-'))
    try {
      generateSounds(dir)
      for (const id of SOUND_IDS) {
        const fresh = readFileSync(join(dir, `${id}.wav`))
        const committed = readFileSync(join(SOUNDS_DIR, `${id}.wav`))
        expect(Buffer.compare(fresh, committed)).toBe(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const id of SOUND_IDS) {
    test(`${id}: header, duration, peak and fades`, () => {
      const bytes = readFileSync(join(SOUNDS_DIR, `${id}.wav`))
      const wav = parse(bytes)
      expect(wav.riff).toBe('RIFF')
      expect(wav.wave).toBe('WAVE')
      expect(wav.fmt).toBe('fmt ')
      expect(wav.data).toBe('data')
      expect(wav.riffSize).toBe(bytes.length - 8)
      expect(wav.format).toBe(1)
      expect(wav.channels).toBe(1)
      expect(wav.rate).toBe(22050)
      expect(wav.bits).toBe(16)
      expect(wav.blockAlign).toBe(2)
      expect(wav.byteRate).toBe(44100)

      const seconds = wav.samples.length / wav.rate
      expect(seconds).toBeGreaterThan(0.05)
      expect(seconds).toBeLessThanOrEqual(0.6)

      let peak = 0
      for (const s of wav.samples) peak = Math.max(peak, Math.abs(s))
      expect(peak).toBeGreaterThan(8000)
      expect(peak).toBeLessThanOrEqual(PEAK_LIMIT)

      expect(Math.abs(wav.samples[0]!)).toBeLessThan(500)
      expect(Math.abs(wav.samples[wav.samples.length - 1]!)).toBeLessThan(500)
    })
  }

  test('every sound is different', () => {
    const seen = new Set<string>()
    for (const id of SOUND_IDS) seen.add(readFileSync(join(SOUNDS_DIR, `${id}.wav`)).toString('base64'))
    expect(seen.size).toBe(SOUND_IDS.length)
  })
})
