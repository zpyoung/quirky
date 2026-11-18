import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuirkyMarkdown } from '@quirky/ui/markdown'
import { renderUserMarkdown } from '../src/window/chat/Prose'

const html = (node: unknown) => renderToStaticMarkup(createElement('div', null, node as never))

describe('user bubble markdown', () => {
  test('renders a fenced code block, bold and an @path span', () => {
    const out = html(renderUserMarkdown('Look at @src/README.md **now**\n\n```ts\nlet a = 1\n```'))
    expect(out).toContain('<pre')
    expect(out).toContain('let a = 1')
    expect(out).toContain('<strong>now</strong>')
    expect(out).toMatch(/<span[^>]*title="src\/README\.md"[^>]*>README\.md<\/span>/)
    expect(out).not.toContain('@src/README.md')
  })

  test('keeps single newlines and leaves @ inside code alone', () => {
    const out = html(renderUserMarkdown('one\ntwo `@a/b.ts`'))
    expect(out).toMatch(/one<br\/>\s*two/)
    expect(out).toContain('@a/b.ts')
  })

  test('does not turn an email address into a mention and drops raw html', () => {
    const out = html(renderUserMarkdown('mail me@x.io <script>alert(1)</script>'))
    expect(out).toContain('me@x.io')
    expect(out).not.toContain('<script')
  })
})

describe('agent prose', () => {
  test('single newlines stay on their own lines', () => {
    const out = renderToStaticMarkup(createElement(QuirkyMarkdown, { text: '1. first\n2. second\nthird line\nfourth line', profile: 'untrusted', onOpenLink: () => {} }))
    expect(out).toMatch(/third line<br\/>\s*fourth line/)
  })
})
