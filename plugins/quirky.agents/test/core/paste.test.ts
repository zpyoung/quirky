import { expect, test } from 'bun:test'
import { encodeBracketedPaste, submitDelayMs } from '../../src/core/paste'

test('SC-20: CRLF and lone LF become CR, ESC becomes its printable substitute, and the text is framed', () => {
  expect(encodeBracketedPaste('a\r\nb\x1bc')).toBe('\x1b[200~a\rb␛c\x1b[201~')
  expect(encodeBracketedPaste('a\nb')).toBe('\x1b[200~a\rb\x1b[201~')
})

test('SC-20: a lone CR is kept and an embedded paste-end cannot close the frame early', () => {
  expect(encodeBracketedPaste('a\rb')).toBe('\x1b[200~a\rb\x1b[201~')
  const encoded = encodeBracketedPaste('x\x1b[201~rm -rf /')
  expect(encoded).toBe('\x1b[200~x␛[201~rm -rf /\x1b[201~')
  expect(encoded.indexOf('\x1b[201~')).toBe(encoded.length - 6)
})

test('SC-20: every ESC is replaced, including consecutive ones', () => {
  expect(encodeBracketedPaste('\x1b\x1b')).toBe('\x1b[200~␛␛\x1b[201~')
})

test('an empty prompt still encodes to an empty frame', () => {
  expect(encodeBracketedPaste('')).toBe('\x1b[200~\x1b[201~')
})

test('SC-25: the submit delay is 500 ms plus 1 ms per 4 KiB when the agent has no line settle', () => {
  expect(submitDelayMs('hi', { lineSettleMs: null })).toBe(501)
  expect(submitDelayMs('x'.repeat(4096), { lineSettleMs: null })).toBe(501)
  expect(submitDelayMs('x'.repeat(4097), { lineSettleMs: null })).toBe(502)
})

test('SC-25: antigravity adds 45 ms per line (3 lines: 500 + 1 + 135)', () => {
  expect(submitDelayMs('a\nb\nc', { lineSettleMs: 45 })).toBe(500 + 1 + 135)
})

test('SC-25: lines count CRLF, CR and LF once each, and a trailing newline starts another line', () => {
  expect(submitDelayMs('a\r\nb\rc\nd', { lineSettleMs: 10 })).toBe(500 + 1 + 40)
  expect(submitDelayMs('a\n', { lineSettleMs: 10 })).toBe(500 + 1 + 20)
  expect(submitDelayMs('one line', { lineSettleMs: 10 })).toBe(500 + 1 + 10)
})

test('size is measured in UTF-8 bytes, not characters', () => {
  // 1366 three-byte characters are 4098 bytes
  expect(submitDelayMs('☃'.repeat(1366), { lineSettleMs: null })).toBe(502)
})

test('a zero line settle adds nothing', () => {
  expect(submitDelayMs('a\nb', { lineSettleMs: 0 })).toBe(501)
})
