import type { StructuredMessage } from '@quirky/protocol'
import type { LoopMarkers } from './types'

const ANSI = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const MARKER = /^LOOP_(DONE|BLOCKED|DECIDE)(?::\s*(.*))?$/

/** Parses only standalone markers in assistant messages supplied for the current turn. */
export function parseMarkers(messages: StructuredMessage[]): LoopMarkers {
  const markers: LoopMarkers = { done: false }
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const text = message.text.replace(ANSI, '')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/^\W+/u, '').trimEnd()
      const match = MARKER.exec(line)
      if (!match) continue
      const reason = (match[2] ?? '').trim().slice(0, 500)
      if (match[1] === 'DONE') markers.done = true
      else if (match[1] === 'BLOCKED' && markers.blocked === undefined) markers.blocked = reason
      else if (match[1] === 'DECIDE' && markers.decide === undefined) markers.decide = reason
    }
  }
  return markers
}
