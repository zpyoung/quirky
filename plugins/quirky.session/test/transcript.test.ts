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
  m(7, 'system', 'hook_response: ok'),
  m(8, 'system', 'system: hook_started'),
  m(9, 'system', 'system: hook_response'),
  m(10, 'user', 'system: hook_started'),
  m(11, 'assistant', 'hook_response: explained'),
  m(12, 'system', 'system: informational'),
  m(13, 'system', 'Claude rate limit event'),
  m(14, 'user', 'system: informational'),
  m(15, 'assistant', 'Claude rate limit event'),
  m(16, 'system', 'system: error'),
  m(17, 'result', 'OK')
]

test('hides internal system events and empty assistant turns without hiding conversation or errors', () => {
  expect(visibleMessages(all, false).map((x) => x.seq)).toEqual([1, 3, 6, 10, 11, 14, 15, 16, 17])
})

test('show all includes internal events and empty assistant turns', () => {
  expect(visibleMessages(all, true).map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
})
