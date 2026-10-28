import { UsageError } from './args'

export type RuntimeSelectorInput = { runtime?: string; pairingCode?: string }
export type RuntimeSelectorEnvironment = { QUIRKY_RUNTIME?: string; QUIRKY_PAIRING_CODE?: string }
export type RuntimeSelection =
  | { kind: 'local' }
  | { kind: 'saved'; selector: string }
  | { kind: 'pairing'; pairingCode: string }

/** Explicit CLI selectors override ambient defaults; a one-off code wins if both env defaults exist. */
export function resolveRuntimeSelection(
  explicit: RuntimeSelectorInput,
  env: RuntimeSelectorEnvironment
): RuntimeSelection {
  if (explicit.runtime !== undefined && explicit.pairingCode !== undefined) {
    throw new UsageError('--runtime and --pairing-code cannot be used together')
  }
  if (explicit.pairingCode !== undefined) return { kind: 'pairing', pairingCode: explicit.pairingCode }
  if (explicit.runtime !== undefined) {
    return explicit.runtime === 'local' ? { kind: 'local' } : { kind: 'saved', selector: explicit.runtime }
  }
  if (env.QUIRKY_PAIRING_CODE) return { kind: 'pairing', pairingCode: env.QUIRKY_PAIRING_CODE }
  if (!env.QUIRKY_RUNTIME || env.QUIRKY_RUNTIME === 'local') return { kind: 'local' }
  return { kind: 'saved', selector: env.QUIRKY_RUNTIME }
}
