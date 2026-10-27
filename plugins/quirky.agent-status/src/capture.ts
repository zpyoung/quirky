import type { ProviderSession } from './types'

const MAX_ID_LENGTH = 512
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

type Capture = {
  idKeys: string[]
  /** Keys that may hold the agent's own transcript path; absent when the agent's path isn't durable or doesn't exist. */
  transcriptKeys?: string[]
  /** The session counts only when a transcript path came with it (pi and prime-agent resume from the file). */
  requireTranscript?: boolean
}

const HOOK_TRANSCRIPT = ['transcript_path', 'transcriptPath']
const SESSION_FILE = ['session_file']

const SOURCES: Record<string, Capture> = {
  claude: { idKeys: ['session_id'], transcriptKeys: HOOK_TRANSCRIPT },
  openclaude: { idKeys: ['session_id'], transcriptKeys: HOOK_TRANSCRIPT },
  codex: { idKeys: ['session_id'], transcriptKeys: HOOK_TRANSCRIPT },
  qoder: { idKeys: ['session_id'], transcriptKeys: HOOK_TRANSCRIPT },
  'qoder-cn': { idKeys: ['session_id'], transcriptKeys: HOOK_TRANSCRIPT },
  'qwen-code': { idKeys: ['session_id'], transcriptKeys: HOOK_TRANSCRIPT },
  codebuddy: { idKeys: ['session_id'], transcriptKeys: HOOK_TRANSCRIPT },
  muse: { idKeys: ['session_id'], transcriptKeys: HOOK_TRANSCRIPT },
  gemini: { idKeys: ['session_id'] },
  droid: { idKeys: ['session_id'] },
  kimi: { idKeys: ['session_id'] },
  // zcode's transcript is a temp file deleted when the hook returns; dsh and kiro send none
  zcode: { idKeys: ['session_id'] },
  kiro: { idKeys: ['session_id'] },
  dsh: { idKeys: ['session_id'] },
  antigravity: { idKeys: ['conversationId'] },
  opencode: { idKeys: ['sessionID'] },
  opencode2: { idKeys: ['sessionID'] },
  'mimo-code': { idKeys: ['sessionID'] },
  pi: { idKeys: ['session_id'], transcriptKeys: SESSION_FILE, requireTranscript: true },
  'prime-agent': { idKeys: ['session_id'], transcriptKeys: SESSION_FILE, requireTranscript: true },
  omp: { idKeys: ['session_id'], transcriptKeys: SESSION_FILE },
  grok: { idKeys: ['sessionId', 'session_id'] },
  devin: { idKeys: ['session_id', 'sessionId'] },
  jcode: { idKeys: ['session_id', 'sessionId'] },
  copilot: { idKeys: ['session_id', 'sessionId'] },
  cursor: { idKeys: ['conversation_id'] }
}

function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (id === '' || id.length > MAX_ID_LENGTH || id.startsWith('-') || CONTROL_CHARACTERS.test(id)) return null
  return id
}

function firstId(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const id = safeId(payload[key])
    if (id) return id
  }
  return null
}

function transcriptOf(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value !== 'string') continue
    const path = value.trim()
    if (path !== '' && !CONTROL_CHARACTERS.test(path)) return path
  }
  return null
}

/**
 * The provider session (resume target) a hook payload names, or null when the source reports none
 * (amp, command-code, hermes), is unknown, or the id fails the stored-id rules. Keys per source
 * follow Orca's `extractAgentProviderSession`.
 */
export function captureProviderSession(source: string, payload: Record<string, unknown>): ProviderSession | null {
  if (!Object.hasOwn(SOURCES, source)) return null
  const rule = SOURCES[source]
  const id = firstId(payload, rule.idKeys)
  if (!id) return null
  const transcriptPath = rule.transcriptKeys ? transcriptOf(payload, rule.transcriptKeys) : null
  if (rule.requireTranscript && !transcriptPath) return null
  return { id, transcriptPath }
}
