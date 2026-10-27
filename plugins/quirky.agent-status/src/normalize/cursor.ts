import type { Normalizer } from '../types'
import { readFirstString, readPrompt, readString, responseText, result, summarizeToolInput } from './shared'

const LAST_STATE = 'cursor:lastState'
const WORKING_EVENTS = new Set([
  'beforeSubmitPrompt',
  'sessionStart',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'beforeMCPExecution',
])

function toolFields(payload: Record<string, unknown>, eventName: string) {
  if (eventName === 'beforeShellExecution') return { toolName: 'Shell', toolInput: readString(payload, 'command') }
  if (eventName === 'beforeMCPExecution') {
    return {
      toolName: readString(payload, 'tool_name') ?? 'MCP',
      toolInput: summarizeToolInput(payload.tool_input) ?? readFirstString(payload, ['command', 'url']),
    }
  }
  if (eventName === 'preToolUse' || eventName === 'postToolUse') {
    return { toolName: readString(payload, 'tool_name'), toolInput: summarizeToolInput(payload.tool_input) }
  }
  return {}
}

/**
 * Cursor: its shell and MCP gates fire on every call, so they read as working, never waiting.
 * Final response text can arrive after `stop`; the cache tells that late text (stays done)
 * from a mid-turn response (working).
 */
export const normalizeCursor: Normalizer = (payload, eventName, cache) => {
  let state: 'working' | 'done'
  if (WORKING_EVENTS.has(eventName)) state = 'working'
  else if (eventName === 'afterAgentResponse') state = cache.get(LAST_STATE) === 'done' ? 'done' : 'working'
  else if (eventName === 'stop' || eventName === 'sessionEnd') state = 'done'
  else return null
  cache.set(LAST_STATE, state)

  const status = payload.status
  return result(eventName, state, {
    newTurn: eventName === 'beforeSubmitPrompt' || eventName === 'sessionStart',
    interrupted: eventName === 'stop' && typeof status === 'string' && status !== 'completed' ? true : undefined,
    fields: {
      prompt: eventName === 'beforeSubmitPrompt' ? readPrompt(payload) : undefined,
      lastAssistantMessage: eventName === 'afterAgentResponse' ? responseText(payload.text) : undefined,
      ...toolFields(payload, eventName),
    },
  })
}
