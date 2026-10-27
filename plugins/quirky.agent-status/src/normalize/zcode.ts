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

const IDLE_SESSION_START_SOURCES = new Set(['startup', 'resume', 'clear'])

/**
 * ZCode: Claude-compatible aliases beside its own camelCase events. Its PermissionRequest fires
 * only once the approval card is on screen, so it is proof of a human wait. SessionStart is an
 * idle boundary for startup, resume and clear; `compact` fires mid-turn and says nothing.
 */
export const normalizeZcode: Normalizer = (payload, eventName) => {
  if (eventName === 'UserPromptSubmit' && isCompactContinuation(readPrompt(payload))) return null

  let state: AgentState
  if (eventName === 'SessionStart') {
    const source = payload.source
    if (typeof source !== 'string' || !IDLE_SESSION_START_SOURCES.has(source)) return null
    state = 'done'
  } else if (eventName === 'UserPromptSubmit' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') state = 'working'
  else if (eventName === 'PreToolUse') state = isAskUserQuestionTool(readString(payload, 'tool_name')) ? 'waiting' : 'working'
  else if (eventName === 'PermissionRequest') state = 'waiting'
  else if (eventName === 'Stop') state = 'done'
  else return null

  const isToolEvent = eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PermissionRequest'
  return result(eventName, state, {
    newTurn: eventName === 'SessionStart' || eventName === 'UserPromptSubmit',
    sessionBoundary: eventName === 'SessionStart' ? true : undefined,
    interrupted: eventName === 'Stop' && payload.is_interrupt === true ? true : undefined,
    fields: {
      prompt: eventName === 'UserPromptSubmit' ? userPrompt(payload) : undefined,
      ...(isToolEvent ? claudeToolFields(payload, { post: eventName === 'PostToolUse' }) : {}),
      lastAssistantMessage: eventName === 'Stop' ? readString(payload, 'last_assistant_message') : undefined,
    },
  })
}
