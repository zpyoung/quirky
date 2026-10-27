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
 * DeepSeek Harness: a Claude-shaped bridge with no Notification or PermissionRequest, so the
 * only waiting signal is its ask tool and an approval pause reads as working. The bridge stamps
 * the child's session id on subagent events, so a child's turn can't be told from the lead's
 * and subagent events are dropped.
 */
export const normalizeDsh: Normalizer = (payload, eventName) => {
  if (eventName === 'UserPromptSubmit' && isCompactContinuation(readPrompt(payload))) return null

  let state: AgentState
  if (eventName === 'UserPromptSubmit' || eventName === 'PostToolUse') state = 'working'
  else if (eventName === 'PreToolUse') state = isAskUserQuestionTool(readString(payload, 'tool_name')) ? 'waiting' : 'working'
  else if (eventName === 'SessionStart' || eventName === 'Stop') state = 'done'
  else return null

  const isToolEvent = eventName === 'PreToolUse' || eventName === 'PostToolUse'
  return result(eventName, state, {
    newTurn: eventName === 'SessionStart' || eventName === 'UserPromptSubmit',
    sessionBoundary: eventName === 'SessionStart' ? true : undefined,
    fields: {
      prompt: eventName === 'UserPromptSubmit' ? userPrompt(payload) : undefined,
      ...(isToolEvent ? claudeToolFields(payload, { post: eventName === 'PostToolUse' }) : {}),
      lastAssistantMessage: eventName === 'Stop' ? readString(payload, 'last_assistant_message') : undefined,
    },
  })
}
