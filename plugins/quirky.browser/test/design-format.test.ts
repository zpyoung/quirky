import { expect, test } from 'bun:test'
import { formatBrowserAnnotationsAsMarkdown, formatGrabPayloadAsText } from '../src/design/format'
import type { DesignAnnotation, DesignPayload } from '../src/design-contract'

function payload(url: string, overrides: Partial<DesignPayload['target']> = {}): DesignPayload {
  return {
    page: { sanitizedUrl: url, title: 'Page', viewportWidth: 900, viewportHeight: 700, scrollX: 0, scrollY: 0, devicePixelRatio: 1, capturedAt: '2026-10-27T00:00:00.000Z' },
    target: {
      tagName: 'BUTTON', selector: 'main > button', elementPath: 'main > button', fullPath: 'html > body > main > button', cssClasses: 'primary',
      nearbyElements: ['button.secondary "Other"'], selectedText: null, isFixed: false, reactComponents: 'App Button', sourceFile: 'src/Button.tsx:3',
      textSnippet: 'Save changes', htmlSnippet: '<button class="primary">Save changes</button>', attributes: { class: 'primary' },
      accessibility: { role: 'button', accessibleName: 'Save changes', ariaLabel: '', ariaLabelledBy: '' },
      rectViewport: { x: 14, y: 22, width: 180, height: 40 }, rectPage: { x: 14, y: 22, width: 180, height: 40 },
      computedStyles: { display: 'inline', position: 'static', color: 'rgb(1, 2, 3)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px' },
      ...overrides
    },
    nearbyText: [], ancestorPath: ['html', 'body', 'main'], screenshot: null
  }
}

function annotation(id: string, url: string, htmlSnippet: string, comment: string, overrides: Partial<DesignAnnotation> = {}): DesignAnnotation {
  return {
    id, revision: 1, browserPageId: `page-${id}`, payload: payload(url, { htmlSnippet }), intent: 'change', comment,
    ...overrides
  }
}

test('grab text omits default styles and keeps the promised context sections', () => {
  const text = formatGrabPayloadAsText(payload('https://example.test/path'))
  expect(text.startsWith('Attached browser context from https://example.test/path')).toBe(true)
  expect(text).toContain('Selected element:')
  expect(text).toContain('Accessible name: "Save changes"')
  expect(text).toContain('Selector: main > button')
  expect(text).toContain('React: App Button')
  expect(text).toContain('font-size: 16px')
  expect(text).toContain('color: rgb(1, 2, 3)')
  expect(text).not.toContain('display: inline')
  expect(text).not.toContain('position: static')
  expect(text).not.toContain('background: rgba(0, 0, 0, 0)')
  expect(text).toContain('Ancestor path: html > body > main')
})

test('annotation Markdown groups pages and chooses fences longer than embedded backticks', () => {
  const markdown = formatBrowserAnnotationsAsMarkdown([
    annotation('one', 'https://example.test/one?discarded=yes', '<main>````\nunsafe</main>', 'Change this\n```\nwithout escaping out of feedback.'),
    annotation('two', 'https://example.test/two#discarded', '<article>plain</article>', 'Ask for details', { intent: 'question' })
  ])
  expect(markdown.startsWith('## Design Feedback across pages')).toBe(true)
  expect(markdown).toContain('## Design Feedback: /one')
  expect(markdown).toContain('## Design Feedback: /two')
  expect(markdown).toContain('**Browser tab id:** `page-one`')
  expect(markdown).toContain('**Browser tab id:** `page-two`')
  expect(markdown).toContain('**Intent:** question')
  expect(markdown).toContain('**Intent:** change')
  expect(markdown).toContain('**URL:** https://example.test/one')
  expect(markdown).toContain('**Viewport:** 900x700')
  expect(markdown).toContain('`````html')
  expect(markdown).not.toContain('**Priority**')
  expect(markdown).not.toContain('Please')
  expect(markdown).not.toContain('display: inline')
  expect(markdown).not.toContain('position: static')
  expect(markdown).not.toContain('backgroundColor: rgba(0, 0, 0, 0)')
})

test('annotation Markdown preserves authored credential-related feedback', () => {
  const markdown = formatBrowserAnnotationsAsMarkdown([
    annotation('feedback', 'https://example.test/form', '<form><input></form>', 'Make the password label clearer; keep the api_key field name.')
  ])
  expect(markdown).toContain('Make the password label clearer')
  expect(markdown).toContain('api\\_key field name')
  expect(markdown).not.toContain('[redacted]')
})
