import { expect, test } from 'bun:test'
import { withoutTrailingNewline } from '../src/diffText'

test('drops one trailing newline so the editor has no empty last line', () => {
  expect(withoutTrailingNewline('a\nb\n')).toBe('a\nb')
  expect(withoutTrailingNewline('a\r\n')).toBe('a')
  expect(withoutTrailingNewline('a\n\n')).toBe('a\n')
})

test('leaves text without a trailing newline alone', () => {
  expect(withoutTrailingNewline('a\nb')).toBe('a\nb')
  expect(withoutTrailingNewline('')).toBe('')
})
