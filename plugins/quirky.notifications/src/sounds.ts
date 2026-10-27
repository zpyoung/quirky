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

export function builtinSoundFile(pluginDir: string, id: string): string {
  return join(pluginDir, 'sounds', `${id}.wav`)
}

/**
 * Validates a user-chosen sound file. The reason, when not ok, completes the sentence
 * "The file ..." and is shown to the user as is.
 */
export async function checkCustomSound(path: string): Promise<SoundCheck> {
  if (!isAbsolute(path)) return { ok: false, reason: 'must be an absolute path' }
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return { ok: false, reason: 'does not exist' }
  }
  if (!AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) {
    return { ok: false, reason: 'must be .ogg, .mp3, .wav, .m4a, .aac or .flac' }
  }
  if (size > MAX_BYTES) return { ok: false, reason: 'is over 10 MiB' }
  try {
    await access(path, constants.R_OK)
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
}): Promise<{ sound?: DeliverySound; problem?: string }> {
  const { sound, customSoundPath, volume, pluginDir } = opts
  if (sound === 'system') return { sound: { file: null, volume } }
  if (sound !== 'custom') return { sound: { file: builtinSoundFile(pluginDir, sound), volume } }
  const check = await checkCustomSound(customSoundPath)
  if (!check.ok) return { problem: check.reason }
  return { sound: { file: customSoundPath, volume } }
}
