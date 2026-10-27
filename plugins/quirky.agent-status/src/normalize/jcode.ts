import type { AgentState, Normalizer } from '../types'
import {
  cacheResetResult,
  isRecord,
  questionJson,
  readFirstString,
  readPrompt,
  readString,
  result,
  summarizeToolInput,
} from './shared'

const STATES: Record<string, AgentState> = {
  turn_start: 'working',
  pre_tool: 'working',
  post_tool: 'working',
  turn_end: 'done',
  session_end: 'done',
}

/** jcode's `tool_input` is the tool's argument JSON as a string. */
function parseToolInput(payload: Record<string, unknown>): unknown {
  const raw = readString(payload, 'tool_input')
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * jcode: `request_permission` is the one tool a human answers (it has no per-tool approval
 * prompt), and session_start fires on an idle TUI attach so it makes no row. The prompt would
 * come from jcode's journal, which Quirky doesn't read.
 */
export const normalizeJcode: Normalizer = (payload, eventName) => {
  if (eventName === 'session_start') return cacheResetResult(eventName)

  const toolName = readString(payload, 'tool_name')
  const asks = eventName === 'pre_tool' && toolName === 'request_permission'
  const state = asks ? 'waiting' : Object.hasOwn(STATES, eventName) ? STATES[eventName] : undefined
  if (!state) return null

  const input = eventName === 'pre_tool' ? parseToolInput(payload) : undefined
  // every jcode tool schema carries an `intent` the model fills in, which reads better than a bare path
  const intent = isRecord(input) ? readString(input, 'intent') : undefined
  const errorText = payload.status === 'error' ? readString(payload, 'error') : undefined
  return result(eventName, state, {
    newTurn: eventName === 'turn_start',
    fields: {
      prompt: readPrompt(payload),
      model: readString(payload, 'model'),
      toolName: eventName === 'pre_tool' || eventName === 'post_tool' ? toolName : undefined,
      toolInput: summarizeToolInput(input) ?? intent,
      question: asks ? questionJson(input) : undefined,
      lastAssistantMessage:
        eventName === 'turn_end' ? (errorText ?? readFirstString(payload, ['last_assistant_text', 'last_assistant_message'])) : undefined,
    },
  })
}
