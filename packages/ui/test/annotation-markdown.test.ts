import { expect, test } from 'bun:test'
import { codeSpan, collapse, feedbackBlock, htmlFence, longestBacktickRun, markdownText } from '../src/design-system/annotation-markdown'

test('collapse flattens whitespace, trims and caps length', () => {
  expect(collapse('  a \n\t b  ')).toBe('a b')
  expect(collapse(42)).toBe('')
  expect(collapse('x'.repeat(3000))).toHaveLength(2048)
})

test('longestBacktickRun finds the longest run', () => {
  expect(longestBacktickRun('no ticks')).toBe(0)
  expect(longestBacktickRun('a`b```c``')).toBe(3)
})

test('codeSpan fences around embedded backticks and pads when the edge needs it', () => {
  expect(codeSpan('plain')).toBe('`plain`')
  expect(codeSpan('a`b')).toBe('``a`b``')
  expect(codeSpan('a``b')).toBe('```a``b```')
  expect(codeSpan('`edge')).toBe('`` `edge ``')
  expect(codeSpan('edge`')).toBe('`` edge` ``')
  expect(codeSpan(' x ')).toBe('`x`')
  expect(codeSpan(undefined)).toBe('``')
})

test('codeSpan collapses whitespace before checking edges', () => {
  expect(codeSpan('  spaced   out  ')).toBe('`spaced out`')
})

test('markdownText escapes markdown punctuation and backslashes', () => {
  expect(markdownText('*bold* _it_ `c` [l](u) <b> #h +x 1. !i a|b a-b {}')).toBe(
    '\\*bold\\* \\_it\\_ \\`c\\` \\[l\\](u) \\<b\\> \\#h \\+x 1\\. \\!i a\\|b a\\-b \\{\\}'
  )
  expect(markdownText('back\\slash')).toBe('back\\\\slash')
  expect(markdownText('plain text')).toBe('plain text')
  expect(markdownText(null)).toBe('')
})

test('htmlFence is at least three backticks and longer than any run inside', () => {
  expect(htmlFence('<p>x</p>')).toBe('```')
  expect(htmlFence('a ```` b')).toBe('`````')
})

test('feedbackBlock labels the first line and escapes every line', () => {
  expect(feedbackBlock('one')).toEqual(['**Feedback:** one'])
  expect(feedbackBlock('first *a*\nsecond_b\n\nlast')).toEqual(['**Feedback:** first \\*a\\*', 'second\\_b', '', 'last'])
})

test('feedbackBlock treats CRLF and lone CR as line breaks', () => {
  expect(feedbackBlock('a\r\nb\rc')).toEqual(['**Feedback:** a', 'b', 'c'])
  expect(feedbackBlock('')).toEqual(['**Feedback:** '])
})
