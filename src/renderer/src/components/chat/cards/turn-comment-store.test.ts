import { describe, expect, it } from 'vitest'
import {
  addTurnComment,
  clearTurnComments,
  composeCommentsMessage,
  readTurnComments,
  removeTurnComment,
  turnCommentKey
} from './turn-comment-store'

describe('composeCommentsMessage', () => {
  it('writes one path:line line per comment in the order they were made', () => {
    expect(
      composeCommentsMessage([
        { id: '1', path: 'a.ts', line: 4, side: 'new', text: ' rename this ' },
        { id: '2', path: 'b.ts', line: 9, side: 'new', text: 'why?' },
        { id: '3', path: 'b.ts', line: 7, side: 'old', text: 'keep this' }
      ])
    ).toBe('a.ts:4 — rename this\nb.ts:9 — why?\nb.ts:7 (removed) — keep this')
  })
})

describe('turn comment store', () => {
  it('keeps comments per session and turn until they are removed or cleared', () => {
    const key = turnCommentKey('s1', 't1')
    const other = turnCommentKey('s1', 't2')
    addTurnComment(key, { path: 'a.ts', line: 1, side: 'new', text: 'one' })
    addTurnComment(key, { path: 'a.ts', line: 2, side: 'new', text: 'two' })
    addTurnComment(other, { path: 'b.ts', line: 3, side: 'new', text: 'other turn' })
    expect(readTurnComments(key).map((note) => note.text)).toEqual(['one', 'two'])
    removeTurnComment(key, readTurnComments(key)[0]?.id ?? '')
    expect(readTurnComments(key).map((note) => note.text)).toEqual(['two'])
    clearTurnComments(key)
    expect(readTurnComments(key)).toEqual([])
    expect(readTurnComments(other)).toHaveLength(1)
    clearTurnComments(other)
  })
})
