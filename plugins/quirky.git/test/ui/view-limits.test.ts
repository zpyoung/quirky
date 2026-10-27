import { describe, expect, test } from 'bun:test'
import { countLines, LIMITS_TEXT, MAX_CHARACTERS, MAX_LINES, reasonText, tooLargeFor } from '../../src/view/limits'

describe('countLines', () => {
  test('counts lines without counting a trailing break as another line', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\n\n')).toBe(2)
  })
})

describe('tooLargeFor', () => {
  test('SC-63: a draft within both limits is fine', () => {
    expect(tooLargeFor('a\n', 'b\n')).toBeNull()
    expect(tooLargeFor('\n'.repeat(MAX_LINES), '')).toBeNull()
  })

  test('SC-63: either side over the line limit reports lines', () => {
    const big = 'x\n'.repeat(MAX_LINES + 1)
    expect(tooLargeFor('', big)).toEqual({
      originalLines: 0,
      modifiedLines: MAX_LINES + 1,
      characters: big.length,
      reason: 'lines'
    })
    expect(tooLargeFor(big, '')?.reason).toBe('lines')
  })

  test('SC-63: the combined character limit is checked first', () => {
    const half = 'y'.repeat(MAX_CHARACTERS / 2 + 1)
    expect(tooLargeFor(half, half)).toMatchObject({ reason: 'characters', characters: half.length * 2 })
    expect(tooLargeFor('y'.repeat(MAX_CHARACTERS / 2), 'y'.repeat(MAX_CHARACTERS / 2))).toBeNull()
  })

  test('SC-63: the fallback copy', () => {
    expect(reasonText('lines')).toBe('line count exceeds the safe display limit')
    expect(reasonText('characters')).toBe('character count exceeds the safe display limit')
    expect(LIMITS_TEXT).toBe('Limits: 120,000 lines per side · 6,000,000 combined characters')
  })
})
