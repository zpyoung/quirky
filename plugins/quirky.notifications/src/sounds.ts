import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'

export const SOUND_IDS = [
  'system',
  'two-tone',
  'bong',
  'thump',
  'blip',
  'sonar',
  'blop',
  'ding',
  'clack',
  'beep',
  'custom',
] as const

export type SoundId = (typeof SOUND_IDS)[number]

export const SOUND_LABELS: Record<SoundId, string> = {
  system: 'System Default',
  'two-tone': 'Two Tone',
  bong: 'Bong',
  thump: 'Thump',
  blip: 'Blip',
  sonar: 'Sonar',
  blop: 'Blop',
  ding: 'Ding',
  clack: 'Clack',
  beep: 'Beep',
  custom: 'Custom',
}

export type SoundCheck = { ok: true } | { ok: false; reason: string }

export type DeliverySound = { file: string | null; volume: number }

const AUDIO_EXTENSIONS = new Set(['.ogg', '.mp3', '.wav', '.m4a', '.aac', '.flac'])
const MAX_BYTES = 10 * 1024 * 1024
const CHECK_TIMEOUT_MS = 2000

class DeadlineExceeded extends Error {}

/** Rejects with `DeadlineExceeded` when `work` has not settled in `ms`, so a stalled filesystem cannot hold the caller. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded()), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export function builtinSoundFile(pluginDir: string, id: string): string {
  return join(pluginDir, 'sounds', `${id}.wav`)
}

/**
 * Validates a user-chosen sound file. The reason, when not ok, completes the sentence
 * "The file ..." and is shown to the user as is. Each filesystem call gets `timeoutMs`; one that
 * does not answer in time reads as "could not be read".
 */
export async function checkCustomSound(path: string, opts: { timeoutMs?: number } = {}): Promise<SoundCheck> {
  if (!isAbsolute(path)) return { ok: false, reason: 'must be an absolute path' }
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS
  let size: number
  try {
    size = (await withDeadline(stat(path), timeoutMs)).size
  } catch (error) {
    return { ok: false, reason: error instanceof DeadlineExceeded ? 'could not be read' : 'does not exist' }
  }
  if (!AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) {
    return { ok: false, reason: 'must be .ogg, .mp3, .wav, .m4a, .aac or .flac' }
  }
  if (size > MAX_BYTES) return { ok: false, reason: 'is over 10 MiB' }
  try {
    await withDeadline(access(path, constants.R_OK), timeoutMs)
  } catch {
    return { ok: false, reason: 'could not be read' }
  }
  return { ok: true }
}

/**
 * Resolves the sound a banner carries. A custom file that fails its check yields no `sound`
 * (the banner is silent) and the failure in `problem`.
 */
export async function deliverySound(opts: {
  sound: string
  customSoundPath: string
  volume: number
  pluginDir: string
  /** Bound on each filesystem call of the custom-file check. */
  checkTimeoutMs?: number
}): Promise<{ sound?: DeliverySound; problem?: string }> {
  const { sound, customSoundPath, volume, pluginDir } = opts
  if (sound === 'system') return { sound: { file: null, volume } }
  if (sound !== 'custom') return { sound: { file: builtinSoundFile(pluginDir, sound), volume } }
  const check = await checkCustomSound(customSoundPath, opts.checkTimeoutMs === undefined ? {} : { timeoutMs: opts.checkTimeoutMs })
  if (!check.ok) return { problem: check.reason }
  return { sound: { file: customSoundPath, volume } }
}
