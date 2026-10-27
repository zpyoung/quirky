import type { Normalizer } from '../types'
import { readFirstString, readPrompt, readString, result, summarizeToolInput } from './shared'

const WORKING_EVENTS = new Set(['BeforeAgent', 'BeforeTool', 'AfterTool', 'PreToolUse', 'PostToolUse'])

/** Gemini CLI: working from BeforeAgent through its tools, done at AfterAgent; it has no waiting state. */
export const normalizeGemini: Normalizer = (payload, eventName) => {
  if (eventName === 'AfterAgent') {
    return result(eventName, 'done', { fields: { lastAssistantMessage: readString(payload, 'prompt_response') } })
  }
  if (!WORKING_EVENTS.has(eventName)) return null
  const isTool = eventName !== 'BeforeAgent'
  return result(eventName, 'working', {
    newTurn: eventName === 'BeforeAgent',
    fields: {
      prompt: isTool ? undefined : readPrompt(payload),
      toolName: isTool ? readFirstString(payload, ['tool_name', 'name']) : undefined,
      toolInput: isTool ? summarizeToolInput(payload.tool_input ?? payload.args ?? payload.input) : undefined,
    },
  })
}
