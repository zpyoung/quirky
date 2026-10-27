import type { AgentState, Normalizer } from '../types'
import { claudeToolFields, readPrompt, readString, result } from './shared'

/**
 * Kiro CLI: Claude-shaped payloads under camelCase event names. It has no permission or
 * notification event, so an approval pause reads as working.
 */
export const normalizeKiro: Normalizer = (payload, eventName) => {
  let state: AgentState
  if (eventName === 'userPromptSubmit' || eventName === 'preToolUse' || eventName === 'postToolUse') state = 'working'
  else if (eventName === 'agentSpawn' || eventName === 'stop') state = 'done'
  else return null

  const isToolEvent = eventName === 'preToolUse' || eventName === 'postToolUse'
  return result(eventName, state, {
    newTurn: eventName === 'agentSpawn' || eventName === 'userPromptSubmit',
    fields: {
      prompt: eventName === 'userPromptSubmit' ? readPrompt(payload) : undefined,
      ...(isToolEvent ? claudeToolFields(payload, { post: eventName === 'postToolUse' }) : {}),
      lastAssistantMessage: eventName === 'stop' ? readString(payload, 'assistant_response') : undefined,
    },
  })
}
