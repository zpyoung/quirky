/**
 * Generates the nine built-in notification sounds as 16-bit PCM mono WAV files.
 *
 * Output is a pure function of the code below: no randomness, no timestamps,
 * so the committed files can be compared byte for byte against a fresh render.
 *
 * Usage: bun plugins/quirky.notifications/scripts/make-sounds.ts [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SOUND_IDS = [
  'two-tone',
  'bong',
  'thump',
  'blip',
  'sonar',
  'blop',
  'ding',
  'clack',
  'beep',
] as const

export type SoundId = (typeof SOUND_IDS)[number]

const SAMPLE_RATE = 22050
const PEAK = 20000
const FADE_IN_SECONDS = 0.004
const FADE_OUT_SECONDS = 0.02
const TAU = Math.PI * 2

/** Accumulates a signal in floating point; `add` mixes a voice in at an offset. */
class Track {
  readonly data: Float64Array

  constructor(seconds: number) {
    this.data = new Float64Array(Math.round(seconds * SAMPLE_RATE))
  }

  add(startSeconds: number, seconds: number, voice: (t: number) => number): void {
    const start = Math.round(startSeconds * SAMPLE_RATE)
    const count = Math.round(seconds * SAMPLE_RATE)
    for (let i = 0; i < count && start + i < this.data.length; i++) {
      this.data[start + i]! += voice(i / SAMPLE_RATE)
    }
  }
}

/** Linear attack to 1 over `attack` seconds, then exponential decay with time constant `decay`. */
function pluck(t: number, attack: number, decay: number): number {
  return Math.min(t / attack, 1) * Math.exp(-t / decay)
}

/** Odd harmonics up to Nyquist at 1/n: a band-limited square wave. */
function squareWave(freq: number, t: number): number {
  let sum = 0
  for (let n = 1; freq * n < SAMPLE_RATE / 2; n += 2) sum += Math.sin(TAU * freq * n * t) / n
  return sum * (4 / Math.PI)
}

/** Sine whose frequency falls exponentially from `from` to `to` over `seconds`. */
function sweep(from: number, to: number, seconds: number, t: number): number {
  const k = Math.log(to / from) / seconds
  const phase = (from * (Math.exp(k * Math.min(t, seconds)) - 1)) / k
  const tail = Math.max(t - seconds, 0) * to
  return Math.sin(TAU * (phase + tail))
}

const RECIPES: Record<SoundId, () => Float64Array> = {
  'two-tone': () => {
    const track = new Track(0.36)
    track.add(0, 0.17, (t) => Math.sin(TAU * 880 * t) * pluck(t, 0.004, 0.2))
    track.add(0.17, 0.19, (t) => Math.sin(TAU * 660 * t) * pluck(t, 0.004, 0.2))
    return track.data
  },
  bong: () => {
    const track = new Track(0.58)
    track.add(0, 0.58, (t) => {
      const body = Math.sin(TAU * 196 * t) + 0.45 * Math.sin(TAU * 392 * t) + 0.2 * Math.sin(TAU * 588 * t)
      return body * pluck(t, 0.006, 0.17)
    })
    return track.data
  },
  thump: () => {
    const track = new Track(0.22)
    track.add(0, 0.22, (t) => sweep(95, 42, 0.12, t) * pluck(t, 0.003, 0.05))
    return track.data
  },
  blip: () => {
    const track = new Track(0.09)
    track.add(0, 0.09, (t) => Math.sin(TAU * 1760 * t) * pluck(t, 0.003, 0.05))
    return track.data
  },
  sonar: () => {
    const track = new Track(0.58)
    const ping = (t: number) => sweep(1500, 1100, 0.1, t) * pluck(t, 0.004, 0.06)
    track.add(0, 0.2, ping)
    track.add(0.26, 0.2, (t) => 0.45 * ping(t))
    track.add(0.46, 0.12, (t) => 0.2 * ping(t))
    return track.data
  },
  blop: () => {
    const track = new Track(0.22)
    track.add(0, 0.22, (t) => sweep(820, 180, 0.14, t) * pluck(t, 0.005, 0.07))
    return track.data
  },
  ding: () => {
    const track = new Track(0.58)
    const partials: Array<[ratio: number, amp: number, decay: number]> = [
      [1, 1, 0.16],
      [2, 0.55, 0.1],
      [3, 0.3, 0.07],
      [4.2, 0.18, 0.045],
    ]
    track.add(0, 0.58, (t) => {
      let sum = 0
      for (const [ratio, amp, decay] of partials) {
        sum += amp * Math.sin(TAU * 1320 * ratio * t) * pluck(t, 0.002, decay)
      }
      return sum
    })
    return track.data
  },
  clack: () => {
    const track = new Track(0.16)
    const click = (t: number) =>
      (squareWave(1400, t) + 0.6 * squareWave(2300, t)) * pluck(t, 0.0005, 0.007)
    track.add(0, 0.06, click)
    track.add(0.07, 0.08, (t) => 0.8 * click(t))
    return track.data
  },
  beep: () => {
    const track = new Track(0.22)
    track.add(0, 0.22, (t) => squareWave(1000, t))
    return track.data
  },
}

/** Renders one sound to 16-bit samples: faded at both ends and scaled so the peak is exactly PEAK. */
export function renderSound(id: SoundId): Int16Array {
  const data = RECIPES[id]()
  const fadeIn = Math.round(FADE_IN_SECONDS * SAMPLE_RATE)
  const fadeOut = Math.round(FADE_OUT_SECONDS * SAMPLE_RATE)
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    const gain = Math.min(1, i / fadeIn, (data.length - 1 - i) / fadeOut)
    data[i]! *= gain
    peak = Math.max(peak, Math.abs(data[i]!))
  }
  const out = new Int16Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = Math.round((data[i]! / peak) * PEAK)
  return out
}

/** Wraps mono 16-bit samples in a canonical 44-byte-header RIFF/WAVE container. */
export function encodeWav(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true)
  return bytes
}

/** Writes `<id>.wav` for every built-in sound into `outDir`, creating it if needed. */
export function generateSounds(outDir: string): void {
  mkdirSync(outDir, { recursive: true })
  for (const id of SOUND_IDS) writeFileSync(join(outDir, `${id}.wav`), encodeWav(renderSound(id)))
}

if (import.meta.main) {
  generateSounds(process.argv[2] ?? join(import.meta.dir, '..', 'sounds'))
}
