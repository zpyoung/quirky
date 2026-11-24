import { describe, expect, it } from 'vitest'
import {
  tokenizeComposerMarkdown,
  type ComposerMarkdownSpan,
  type ComposerMarkdownSpanKind
} from './composer-markdown-spans'

function reconstructed(text: string, spans: readonly ComposerMarkdownSpan[]): string {
  return spans.map((span) => text.slice(span.start, span.end)).join('')
}

function kindsAt(
  spans: readonly ComposerMarkdownSpan[],
  position: number
): readonly ComposerMarkdownSpanKind[] {
  return spans.find((span) => span.start <= position && position < span.end)?.kinds ?? []
}

function expectFullCoverage(text: string): ComposerMarkdownSpan[] {
  const spans = tokenizeComposerMarkdown(text)
  expect(reconstructed(text, spans)).toBe(text)
  expect(spans[0]?.start ?? 0).toBe(0)
  expect(spans.at(-1)?.end ?? 0).toBe(text.length)
  for (let index = 1; index < spans.length; index += 1) {
    expect(spans[index].start).toBe(spans[index - 1].end)
  }
  return spans
}

describe('tokenizeComposerMarkdown', () => {
  it('returns no spans for an empty draft', () => {
    expect(tokenizeComposerMarkdown('')).toEqual([])
  })

  it('preserves every character across CRLF lines and a trailing newline', () => {
    expectFullCoverage('# title\r\nplain  text\r\n')
  })

  it('leaves unterminated and escaped markers plain', () => {
    for (const text of ['before **unfinished', String.raw`before \**escaped**`]) {
      const spans = expectFullCoverage(text)
      expect(spans.every((span) => span.kinds.includes('plain'))).toBe(true)
    }
  })

  it('lets inline code suppress nested emphasis and Quirky tokens', () => {
    const text = 'run `**raw** @src/file.ts` now'
    const spans = expectFullCoverage(text)
    const rawPosition = text.indexOf('raw')
    const mentionPosition = text.indexOf('@')

    expect(kindsAt(spans, rawPosition)).toEqual(['code'])
    expect(kindsAt(spans, mentionPosition)).toEqual(['code'])
  })

  it('lets fenced code suppress all inline parsing until its closing fence', () => {
    const text = '```ts\r\n**raw** @src/file.ts\r\n```\r\n**live**\n'
    const spans = expectFullCoverage(text)
    const rawPosition = text.indexOf('raw')
    const livePosition = text.indexOf('live')

    expect(kindsAt(spans, rawPosition)).toEqual(['fence'])
    expect(kindsAt(spans, livePosition)).toContain('bold')
  })

  it('supports tilde fences without styling their inline syntax', () => {
    const text = '~~~md\n~~strike~~ $skill\n~~~\n'
    const spans = expectFullCoverage(text)

    expect(kindsAt(spans, text.indexOf('strike'))).toEqual(['fence'])
    expect(kindsAt(spans, text.indexOf('$skill'))).toEqual(['fence'])
  })

  it('accumulates bold and italic for triple emphasis', () => {
    const text = 'before ***both*** after'
    const spans = expectFullCoverage(text)

    expect(kindsAt(spans, text.indexOf('both'))).toEqual(['bold', 'italic'])
    expect(kindsAt(spans, text.indexOf('***'))).toEqual(['marker'])
  })

  it('styles link text and URLs without parsing URL underscores as emphasis', () => {
    const text = '[**docs**](https://host/a_b) and https://host/c_d.'
    const spans = expectFullCoverage(text)

    expect(kindsAt(spans, text.indexOf('docs'))).toEqual(['bold', 'link-text'])
    expect(kindsAt(spans, text.indexOf('a_b'))).toEqual(['link-url'])
    expect(kindsAt(spans, text.indexOf('c_d'))).toEqual(['link-url'])
    expect(kindsAt(spans, text.length - 1)).toEqual(['plain'])
  })

  it('keeps balanced URL parentheses and trims surplus closing punctuation', () => {
    const text = 'https://host/a_(b)).'
    const spans = expectFullCoverage(text)

    expect(kindsAt(spans, text.indexOf('(b)'))).toEqual(['link-url'])
    expect(kindsAt(spans, text.length - 2)).toEqual(['plain'])
  })

  it('recognizes headings, quotes, and list markers before inline spans', () => {
    const text = '# **Title**\n> quoted\n1. item'
    const spans = expectFullCoverage(text)

    expect(kindsAt(spans, text.indexOf('#'))).toEqual(['marker'])
    expect(kindsAt(spans, text.indexOf('Title'))).toEqual(['bold', 'heading'])
    expect(kindsAt(spans, text.indexOf('quoted'))).toEqual(['quote'])
    expect(kindsAt(spans, text.indexOf('1.'))).toEqual(['list-marker'])
  })

  it('uses the picker token boundaries for lexical mentions, commands, and skills', () => {
    const text = '@src/main.ts /review $ship me@example.com (@ignored)'
    const spans = expectFullCoverage(text)

    expect(kindsAt(spans, text.indexOf('@src'))).toEqual(['mention'])
    expect(kindsAt(spans, text.indexOf('/review'))).toEqual(['command'])
    expect(kindsAt(spans, text.indexOf('$ship'))).toEqual(['skill'])
    expect(kindsAt(spans, text.indexOf('@example'))).toEqual(['plain'])
    expect(kindsAt(spans, text.indexOf('@ignored'))).toEqual(['plain'])
  })

  it('does not treat intraword underscores as emphasis', () => {
    const text = 'snake_case stays plain'
    const spans = expectFullCoverage(text)

    expect(kindsAt(spans, text.indexOf('_'))).toEqual(['plain'])
  })
})
