import { isRecord } from './normalize/shared'

export type ProviderCall = { toolName: string; toolInput: unknown }
export type TranscriptRecord =
  | { kind: 'prompt'; text: string }
  | { kind: 'event'; eventName: 'PreToolUse' | 'PostToolUse'; payload: Record<string, unknown> }
  | { kind: 'message'; text: string }

function parseInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((item) => {
    if (!isRecord(item) || (item.type !== 'text' && item.type !== 'output_text')) return []
    return typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
}

function callId(value: Record<string, unknown>): string | undefined {
  const id = value.call_id ?? value.tool_use_id ?? value.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function codexRecords(value: Record<string, unknown>, calls: Map<string, ProviderCall>): TranscriptRecord[] {
  const payload = isRecord(value.payload) ? value.payload : null
  if (!payload) return []
  if (value.type === 'event_msg' && payload.type === 'user_message') {
    const text = typeof payload.message === 'string' ? payload.message : typeof payload.text === 'string' ? payload.text : ''
    return text === '' ? [] : [{ kind: 'prompt', text }]
  }
  if (value.type !== 'response_item') return []
  if (payload.type === 'function_call') {
    const name = typeof payload.name === 'string' ? payload.name : ''
    if (name === '') return []
    const input = parseInput(payload.arguments)
    const id = callId(payload)
    if (id) calls.set(id, { toolName: name, toolInput: input })
    return [{ kind: 'event', eventName: 'PreToolUse', payload: { tool_name: name, tool_input: input, ...(id ? { tool_use_id: id } : {}) } }]
  }
  if (payload.type === 'function_call_output') {
    const id = callId(payload)
    const call = id ? calls.get(id) : undefined
    if (id) calls.delete(id)
    return [{
      kind: 'event',
      eventName: 'PostToolUse',
      payload: {
        ...(call ? { tool_name: call.toolName, tool_input: call.toolInput } : {}),
        ...(id ? { tool_use_id: id } : {}),
        tool_response: payload.output
      }
    }]
  }
  if (payload.type === 'message' && payload.role === 'assistant') {
    const text = textContent(payload.content)
    return text === '' ? [] : [{ kind: 'message', text }]
  }
  return []
}

function museRecords(value: Record<string, unknown>, calls: Map<string, ProviderCall>): TranscriptRecord[] {
  const type = value.type
  const message = isRecord(value.message) ? value.message : value
  const content = message.content
  if (type === 'user') {
    if (Array.isArray(content)) {
      const results = content.filter((item) => isRecord(item) && item.type === 'tool_result') as Record<string, unknown>[]
      if (results.length > 0) {
        return results.flatMap((result): TranscriptRecord[] => {
          const id = callId(result)
          const call = id ? calls.get(id) : undefined
          if (id) calls.delete(id)
          return [{
            kind: 'event',
            eventName: 'PostToolUse',
            payload: {
              ...(call ? { tool_name: call.toolName, tool_input: call.toolInput } : {}),
              ...(id ? { tool_use_id: id } : {}),
              tool_response: result.content
            }
          }]
        })
      }
    }
    const text = textContent(content)
    return text === '' ? [] : [{ kind: 'prompt', text }]
  }
  if (type !== 'assistant') return []
  if (typeof content === 'string') return content === '' ? [] : [{ kind: 'message', text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((item): TranscriptRecord[] => {
    if (!isRecord(item)) return []
    if (item.type === 'tool_use' && typeof item.name === 'string' && item.name !== '') {
      const input = item.input
      const id = callId(item)
      if (id) calls.set(id, { toolName: item.name, toolInput: input })
      return [{ kind: 'event', eventName: 'PreToolUse', payload: { tool_name: item.name, tool_input: input, ...(id ? { tool_use_id: id } : {}) } }]
    }
    if (item.type === 'text' && typeof item.text === 'string' && item.text !== '') return [{ kind: 'message', text: item.text }]
    return []
  })
}

/** Parses one complete captured Codex rollout or Claude-compatible Muse transcript line. */
export function parseProviderTranscriptLine(
  source: 'codex' | 'muse',
  line: string,
  calls: Map<string, ProviderCall>
): TranscriptRecord[] {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return []
  }
  if (!isRecord(value)) return []
  return source === 'codex' ? codexRecords(value, calls) : museRecords(value, calls)
}
