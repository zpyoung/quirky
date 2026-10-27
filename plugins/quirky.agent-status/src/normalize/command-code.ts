import type { Normalizer } from '../types'
import { readFirstString, readString, result, summarizeToolInput } from './shared'

/** Command Code: tool events are working and Stop is done; its prompt lives only in a transcript Quirky doesn't read. */
export const normalizeCommandCode: Normalizer = (payload, eventName) => {
  if (eventName === 'Stop') {
    return result(eventName, 'done', { fields: { lastAssistantMessage: readString(payload, 'last_assistant_message') } })
  }
  if (eventName !== 'PreToolUse' && eventName !== 'PostToolUse') return null
  return result(eventName, 'working', {
    fields: {
      toolName: readFirstString(payload, ['tool_name', 'toolName', 'tool_display_name']),
      toolInput: summarizeToolInput(payload.tool_input),
    },
  })
}
