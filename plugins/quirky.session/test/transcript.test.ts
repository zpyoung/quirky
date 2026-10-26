import { expect, test } from 'bun:test'
import type { StructuredMessage } from '@quirky/protocol'
import { visibleMessages } from '../src/window/transcript'

const m = (seq: number, role: StructuredMessage['role'], text: string): StructuredMessage => ({
  sessionId: 's',
  seq,
  role,
  text,
  at: 0
})

const all = [
  m(1, 'user', 'hi'),
  m(2, 'system', 'hook_started: SessionStart'),
  m(3, 'system', 'init'),
  m(4, 'assistant', ''),
  m(5, 'assistant', '   \n'),
  m(6, 'assistant', 'hello'),
  m(7, 'system', 'hook_response: ok')
]

test('hides hook system messages and empty assistant messages by default', () => {
  expect(visibleMessages(all, false).map((x) => x.seq)).toEqual([1, 3, 6])
})

test('show all returns every message', () => {
  expect(visibleMessages(all, true)).toBe(all)
})
