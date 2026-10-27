import { describe, expect, test } from 'bun:test'
import { estimateTokens } from '../../src/core/tokens'

const line = (chars: number) => `${'x'.repeat(chars - 1)}\n`

describe('estimateTokens', () => {
  test('weighs prose, code and diff lines (SC-41)', () => {
    const prose = line(50).repeat(12) + line(38)
    const code = line(50).repeat(9)
    const diff = `+${line(49)}`.repeat(7)
    const text = `${prose}\`\`\`text\n${code}\`\`\`\n${diff}`
    expect(text.length).toBe(1450)
    expect(estimateTokens(text)).toBe(300)
  })

  test('counts at least one token', () => {
    expect(estimateTokens('')).toBe(1)
    expect(estimateTokens('a')).toBe(1)
  })

  test('rounds up', () => {
    expect(estimateTokens('x'.repeat(7))).toBe(2)
  })

  test('treats +, - and @@ lines outside a fence as diff', () => {
    const text = '+++ after\n--- before\n@@ -1 +1 @@\n'
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 3.5))
  })

  test('treats lines inside a fence as code, even when they look like a diff', () => {
    const text = '```\n+added\n```'
    expect(estimateTokens(text)).toBe(Math.ceil(4 / 6.5 + 7 / 4.5 + 3 / 6.5))
  })

  test('closes a fence only on a marker at least as long', () => {
    const text = '````\n```\n+x\n````\n+y'
    const expected = Math.ceil(5 / 6.5 + (4 + 3) / 4.5 + 5 / 6.5 + 2 / 3.5)
    expect(estimateTokens(text)).toBe(expected)
  })
})
