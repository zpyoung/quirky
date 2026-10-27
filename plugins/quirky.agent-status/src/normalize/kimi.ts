import type { AgentState, Normalizer } from '../types'
import {
  claudeToolFields,
  isAskUserQuestionTool,
  isCompactContinuation,
  readPrompt,
  readString,
  result,
  userPrompt,
} from './shared'

/**
 * Kimi Code: Claude-compatible events. Its AskUserQuestion is auto-allowed, so it shows up as
 * PreToolUse (not PermissionRequest) while it waits for the answer.
 */
export const normalizeKimi: Normalizer = (payload, eventName) => {
  if (eventName === 'UserPromptSubmit' && isCompactContinuation(readPrompt(payload))) return null

  const asks = eventName === 'PreToolUse' && isAskUserQuestionTool(readString(payload, 'tool_name'))
  let state: AgentState | null = null
  if (eventName === 'PermissionRequest' || asks) state = 'waiting'
  else if (['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse'].includes(eventName)) state = 'working'
  else if (eventName === 'Stop' || eventName === 'StopFailure') state = 'done'
  if (!state) return null

  const isToolEvent = ['PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(eventName)
  return result(eventName, state, {
    newTurn: eventName === 'UserPromptSubmit',
    outcome: eventName === 'StopFailure' ? 'failure' : undefined,
    interrupted: eventName === 'Stop' && payload.is_interrupt === true ? true : undefined,
    fields: {
      prompt: eventName === 'UserPromptSubmit' ? userPrompt(payload) : undefined,
      ...(isToolEvent ? claudeToolFields(payload, { post: eventName === 'PostToolUse' }) : {}),
      lastAssistantMessage: state === 'done' ? readString(payload, 'last_assistant_message') : undefined,
    },
  })
}
