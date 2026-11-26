import type { EditorState } from '@codemirror/state'
import type { Trigger } from './types'

/**
 * The `@` or `/` trigger under the cursor, or null. Either begins a trigger at the start of the
 * document or after whitespace, never mid-word. A `/` token holding a second `/` is a path, not a command.
 */
export function detectTrigger(state: EditorState): Trigger | null {
  const selection = state.selection.main
  if (!selection.empty) {
    return null
  }
  const head = selection.head
  const before = state.doc.sliceString(Math.max(0, head - 512), head)
  const offset = head - before.length
  let start = before.length
  while (start > 0 && !/\s/.test(before[start - 1]!)) {
    start--
  }
  const token = before.slice(start)
  const from = offset + start
  const atWordStart = start > 0 || offset === 0
  if (!atWordStart) {
    return null
  }
  if (token.startsWith('@')) {
    return { kind: '@', query: token.slice(1), from, to: head }
  }
  if (token.startsWith('/') && !token.includes('/', 1)) {
    return { kind: '/', query: token.slice(1), from, to: head }
  }
  return null
}
