import type { StructuredMessage } from '@quirky/protocol'

function isNoise(message: StructuredMessage): boolean {
  if (message.role === 'system') return message.text.startsWith('hook_')
  if (message.role === 'assistant') return message.text.trim() === ''
  return false
}

/** Drops the agent's hook chatter and empty thinking-only turns unless `showAll` is set. */
export function visibleMessages(messages: StructuredMessage[], showAll: boolean): StructuredMessage[] {
  return showAll ? messages : messages.filter((message) => !isNoise(message))
}
