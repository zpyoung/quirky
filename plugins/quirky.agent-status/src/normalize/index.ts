import { captureProviderSession } from '../capture'
import { normalizeAmp } from './amp'
import { normalizeAntigravity } from './antigravity'
import { normalizeClaude, normalizeOpenClaude, normalizeQwenCode } from './claude'
import { normalizeCodex } from './codex'
import { normalizeCodebuddy, normalizeQoder } from './compatible'
import { normalizeCommandCode } from './command-code'
import { normalizeCopilot } from './copilot'
import { normalizeCursor } from './cursor'
import { normalizeDevin } from './devin'
import { normalizeDroid } from './droid'
import { normalizeDsh } from './dsh'
import { normalizeGemini } from './gemini'
import { normalizeGrok } from './grok'
import { normalizeHermes } from './hermes'
import { normalizeJcode } from './jcode'
import { normalizeKimi } from './kimi'
import { normalizeKiro } from './kiro'
import { normalizeMuse } from './muse'
import { normalizeMimoCode, normalizeOpencode, normalizeOpencode2 } from './opencode'
import { normalizeOmp, normalizePi, normalizePrimeAgent } from './pi'
import { normalizeZcode } from './zcode'
import type { Normalized, Normalizer, NormalizerCache } from '../types'

/** Every hook source the plugin understands, mapped to its normalizer. */
export const SOURCES: Record<string, Normalizer> = {
  claude: normalizeClaude,
  codex: normalizeCodex,
  qoder: normalizeQoder,
  'qoder-cn': normalizeQoder,
  codebuddy: normalizeCodebuddy,
  'qwen-code': normalizeQwenCode,
  openclaude: normalizeOpenClaude,
  gemini: normalizeGemini,
  antigravity: normalizeAntigravity,
  amp: normalizeAmp,
  opencode: normalizeOpencode,
  opencode2: normalizeOpencode2,
  'mimo-code': normalizeMimoCode,
  cursor: normalizeCursor,
  pi: normalizePi,
  omp: normalizeOmp,
  'prime-agent': normalizePrimeAgent,
  droid: normalizeDroid,
  'command-code': normalizeCommandCode,
  grok: normalizeGrok,
  copilot: normalizeCopilot,
  hermes: normalizeHermes,
  devin: normalizeDevin,
  kimi: normalizeKimi,
  muse: normalizeMuse,
  dsh: normalizeDsh,
  zcode: normalizeZcode,
  jcode: normalizeJcode,
  kiro: normalizeKiro
}

const EVENT_NAME_KEYS = ['hook_event_name', 'hookEventName', 'hook_type', 'hookType', 'event']

/**
 * The event name a hook carries: the payload's own name, else the name the shim put in the query
 * for agents whose payload has none. '' when neither names one.
 */
export function eventNameOf(payload: Record<string, unknown>, queryEvent?: string): string {
  for (const key of EVENT_NAME_KEYS) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return queryEvent ?? ''
}

/**
 * What one hook means for status, or null for an unknown source or an event that says nothing.
 * A lead event whose normalizer named no provider session gets the one its payload carries, if any.
 */
export function normalize(
  source: string,
  payload: unknown,
  queryEvent: string | undefined,
  cache: NormalizerCache
): Normalized | null {
  if (!Object.hasOwn(SOURCES, source)) return null
  const body = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
  const found = SOURCES[source]!(body, eventNameOf(body, queryEvent), cache)
  if (!found || found.providerSession || found.agentId !== undefined) return found
  const providerSession = captureProviderSession(source, body)
  return providerSession ? { ...found, providerSession } : found
}
