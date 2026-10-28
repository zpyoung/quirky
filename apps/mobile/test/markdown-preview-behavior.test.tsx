import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownPreview } from '../src/pages/MarkdownPreview'

test('phone Markdown preview renders lists, emphasis, quotes and GFM tables without executing resources', () => {
  const html = renderToStaticMarkup(createElement(MarkdownPreview, { text: [
    '# Release', '', '- **Ready**', '- _Review_', '', '> Keep the draft', '',
    '| Task | State |', '| --- | --- |', '| ship | done |', '',
    '![tracking image](https://untrusted.invalid/pixel)', '', '[unsafe](javascript:alert(1))', '',
    '<script>globalThis.PHONE_PWNED=true</script>'
  ].join('\n') }))
  expect(html).toContain('<ul>')
  expect(html).toContain('<strong>Ready</strong>')
  expect(html).toContain('<em>Review</em>')
  expect(html).toContain('<blockquote>')
  expect(html).toContain('<table>')
  expect(html).toContain('ship')
  expect(html).not.toMatch(/<(?:script|img|iframe|object)\b/i)
  expect(html).not.toMatch(/\s(?:href|src|srcset|onerror)=/i)
})
