import type { SessionStatus } from '@quirky/protocol'

const CLAUDE_EVENT_STATUS: Record<string, SessionStatus> = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  Notification: 'waiting',
  Stop: 'done'
}

/**
 * The session status an agent hook payload implies, or null when the payload says nothing about
 * status. Codex's notify call fires when a turn finishes.
 */
export function statusForHook(agent: string, payload: unknown): SessionStatus | null {
  if (agent === 'codex') return 'done'
  if (agent === 'claude' && payload && typeof payload === 'object') {
    const event = (payload as { hook_event_name?: unknown }).hook_event_name
    if (typeof event === 'string') return CLAUDE_EVENT_STATUS[event] ?? null
  }
  return null
}
