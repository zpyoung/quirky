import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuirkyMarkdown } from '@quirky/ui/markdown'
import { renderUserMarkdown } from '../src/window/chat/Prose'
import { rememberVisualLabel } from '../src/window/chat/editor/types'

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

describe('visual level marker', () => {
  test('a leading marker line never renders', () => {
    const out = html(renderUserMarkdown('[quirky visual level: balanced]\nwhy is this slow?'))
    expect(out).toContain('why is this slow?')
    expect(out).not.toContain('quirky visual level')
  })

  test('every level marker is stripped, and only from the start of the message', () => {
    for (const level of ['off', 'balanced', 'visual-first']) {
      expect(html(renderUserMarkdown(`[quirky visual level: ${level}]\nhi`))).not.toContain('quirky visual level')
    }
    const typed = html(renderUserMarkdown('I typed\n[quirky visual level: off]\nin the middle'))
    expect(typed).toContain('[quirky visual level: off]')
  })

  test('a message that is only the marker leaves nothing behind', () => {
    expect(html(renderUserMarkdown('[quirky visual level: off]\n'))).toBe('<div></div>')
  })
})

describe('visual references in a sent message', () => {
  const ref = { viewId: 'view_0123456789ab', version: 2, element: 'dg:daemon' }
  const text = '@view:view_0123456789ab/v2/dg:daemon why does every call go through this hop?'

  test('a known reference reads as the visual and the element, before the text', () => {
    rememberVisualLabel(ref, { title: 'Auth flow', label: 'Daemon' })
    const out = html(renderUserMarkdown(text))
    expect(out).toContain('◈ Auth flow › Daemon')
    expect(out).toContain('why does every call go through this hop?')
    expect(out).not.toContain('@view:')
    expect(out.indexOf('◈')).toBeLessThan(out.indexOf('why does'))
  })

  test('an unknown reference still reads as a chip, naming the element', () => {
    const out = html(renderUserMarkdown('@view:view_ffffffffffff/v1/row:3 what is this row?'))
    expect(out).toContain('◈ row:3')
    expect(out).not.toContain('@view:')
  })

  test('a file mention beside a reference is still a file name', () => {
    const out = html(renderUserMarkdown(`@src/a.ts ${text}`))
    expect(out).toMatch(/<span[^>]*title="src\/a\.ts"[^>]*>a\.ts<\/span>/)
    expect(out).toContain('◈')
  })

  test('text that only looks like a reference stays text', () => {
    expect(html(renderUserMarkdown('see @view:nope/v1/x here'))).toContain('nope')
  })
})

describe('agent prose', () => {
  test('single newlines stay on their own lines', () => {
    const out = renderToStaticMarkup(createElement(QuirkyMarkdown, { text: '1. first\n2. second\nthird line\nfourth line', profile: 'untrusted', onOpenLink: () => {} }))
    expect(out).toMatch(/third line<br\/>\s*fourth line/)
  })
})
