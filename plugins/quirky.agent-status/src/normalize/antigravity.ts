import type { Normalizer } from '../types'
import { isRecord, readFirstString, readPrompt, readString, result, summarizeToolInput } from './shared'

const COMPLETED = 'antigravity:completed'
const WAITING_TOOLS = new Set(['ask_question', 'ask_permission'])

/**
 * Antigravity: only a fully idle Stop is terminal. The cache remembers the transcript that
 * finished ('' when the payload names none) so a bookkeeping event after it can't reopen the row.
 */
export const normalizeAntigravity: Normalizer = (payload, eventName, cache) => {
  const transcript = readFirstString(payload, ['transcriptPath', 'transcript_path'])
  if (eventName === 'PreInvocation') {
    cache.delete(COMPLETED)
  } else if (eventName !== 'Stop') {
    const completed = cache.get(COMPLETED)
    if (completed === '' || (completed !== undefined && completed === transcript)) return null
  }

  const toolCall = isRecord(payload.toolCall) ? payload.toolCall : undefined
  const toolName = toolCall ? readFirstString(toolCall, ['name', 'toolName', 'tool_name']) : undefined
  const isToolEvent = eventName === 'PreToolUse' || eventName === 'PostToolUse'

  if (eventName === 'Stop') {
    if (payload.fullyIdle === false || payload.fully_idle === false) return result(eventName, 'working')
    cache.set(COMPLETED, transcript ?? '')
    return result(eventName, 'done', { fields: { lastAssistantMessage: readString(payload, 'last_assistant_message') } })
  }
  if (eventName !== 'PreInvocation' && eventName !== 'PostInvocation' && !isToolEvent) return null

  const waiting = eventName === 'PreToolUse' && toolName !== undefined && WAITING_TOOLS.has(toolName)
  return result(eventName, waiting ? 'waiting' : 'working', {
    newTurn: eventName === 'PreInvocation',
    fields: {
      prompt: readPrompt(payload),
      toolName: isToolEvent ? toolName : undefined,
      toolInput: isToolEvent ? summarizeToolInput(toolCall?.args) : undefined,
      question: waiting && toolCall?.args !== undefined ? JSON.stringify(toolCall.args) : undefined,
    },
  })
}
