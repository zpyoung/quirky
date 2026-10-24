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

/**
 * True for Claude's idle reminder ("Claude is waiting for your input"), which fires some time after
 * a turn ends and is not a request for the user to act on. Permission and elicitation
 * notifications are not idle reminders.
 */
export function isClaudeIdleNotification(agent: string, payload: unknown): boolean {
  if (agent !== 'claude' || !payload || typeof payload !== 'object') return false
  const { hook_event_name: event, notification_type: type, message } = payload as Record<string, unknown>
  if (event !== 'Notification') return false
  if (typeof type === 'string') return type === 'idle_prompt'
  return typeof message === 'string' && /waiting for your input/i.test(message)
}
