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

/** `existing` plus `incoming`, one message per `seq` (the incoming one wins), in `seq` order. */
export function mergeMessages(existing: StructuredMessage[], incoming: StructuredMessage[]): StructuredMessage[] {
  const bySeq = new Map(existing.map((message) => [message.seq, message]))
  for (const message of incoming) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
