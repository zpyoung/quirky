import type { AgentState, Normalizer } from '../types'
import { readFirstString, readPrompt, result, summarizeToolInput } from './shared'

// on_session_start opens a session that sits at its composer, so it is a done boundary, not a turn
const STATES: Record<string, AgentState> = {
  on_session_start: 'done',
  on_session_end: 'done',
  on_session_finalize: 'done',
  on_session_reset: 'done',
  post_llm_call: 'done',
  pre_approval_request: 'waiting',
  pre_llm_call: 'working',
  pre_tool_call: 'working',
  post_tool_call: 'working',
  post_approval_response: 'working',
}

/** Hermes: its own snake_case plugin hooks; an approval request is waiting and its response resumes work. */
export const normalizeHermes: Normalizer = (payload, eventName) => {
  const state = Object.hasOwn(STATES, eventName) ? STATES[eventName] : undefined
  if (!state) return null

  const isApproval = eventName === 'pre_approval_request' || eventName === 'post_approval_response'
  const isToolEvent = isApproval || eventName === 'pre_tool_call' || eventName === 'post_tool_call'
  return result(eventName, state, {
    newTurn: eventName === 'pre_llm_call' || eventName === 'on_session_start',
    sessionBoundary: eventName === 'on_session_start' ? true : undefined,
    fields: {
      prompt: eventName === 'pre_llm_call' ? readPrompt(payload) : undefined,
      toolName: isToolEvent ? (readFirstString(payload, ['tool_name', 'name']) ?? (isApproval ? 'approval' : undefined)) : undefined,
      toolInput: isToolEvent
        ? (summarizeToolInput(payload.tool_input ?? payload.args ?? payload.input) ?? readFirstString(payload, ['command', 'description']))
        : undefined,
      lastAssistantMessage:
        eventName === 'post_llm_call'
          ? readFirstString(payload, ['last_assistant_message', 'assistant_response', 'response_text'])
          : undefined,
    },
  })
}
