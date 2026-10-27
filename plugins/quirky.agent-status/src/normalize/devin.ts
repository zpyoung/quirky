import type { AgentState, Normalizer } from '../types'
import {
  cacheResetResult,
  claudeToolFields,
  isCompactContinuation,
  readPrompt,
  readString,
  result,
  userPrompt,
} from './shared'

/** Devin: Claude-shaped payloads with its own lifecycle; SessionStart fires on an idle TUI open, so it never makes a row. */
export const normalizeDevin: Normalizer = (payload, eventName) => {
  if (eventName === 'SessionStart') return cacheResetResult(eventName)

  let state: AgentState | null = null
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostCompaction'].includes(eventName)) state = 'working'
  else if (eventName === 'PermissionRequest') state = 'waiting'
  else if (eventName === 'Stop' || eventName === 'SessionEnd') state = 'done'
  if (!state) return null
  if (eventName === 'UserPromptSubmit' && isCompactContinuation(readPrompt(payload))) return null

  const isToolEvent = eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PermissionRequest'
  return result(eventName, state, {
    newTurn: eventName === 'UserPromptSubmit',
    interrupted: eventName === 'Stop' && payload.is_interrupt === true ? true : undefined,
    fields: {
      prompt: eventName === 'UserPromptSubmit' ? userPrompt(payload) : undefined,
      ...(isToolEvent ? claudeToolFields(payload, { post: eventName === 'PostToolUse' }) : {}),
      lastAssistantMessage: eventName === 'Stop' ? readString(payload, 'last_assistant_message') : undefined,
    },
  })
}
