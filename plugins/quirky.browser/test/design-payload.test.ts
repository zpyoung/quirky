import { expect, test } from 'bun:test'
import { clampAnnotation, clampPayload, MAX_SCREENSHOT_BYTES } from '../src/design/payload'
import type { DesignPayload } from '../src/design-contract'

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    page: {
      sanitizedUrl: 'https://user:pass@example.test/path?access_token=hidden#fragment',
      title: 'Fixture', viewportWidth: 800, viewportHeight: 600, scrollX: 0, scrollY: 0,
      devicePixelRatio: 1, capturedAt: '2026-10-27T00:00:00.000Z'
    },
    target: {
      tagName: 'P', selector: 'body > p', elementPath: 'p', fullPath: 'html > body > p', cssClasses: 'copy',
      nearbyElements: [], selectedText: null, isFixed: false, reactComponents: null, sourceFile: null,
      textSnippet: 'A paragraph', htmlSnippet: '<p class="copy">A paragraph</p>', attributes: { class: 'copy' },
      accessibility: { role: '', accessibleName: '', ariaLabel: '', ariaLabelledBy: '' },
      rectViewport: { x: 10, y: 20, width: 200, height: 40 }, rectPage: { x: 10, y: 20, width: 200, height: 40 },
      computedStyles: { display: 'block', position: 'static', fontSize: '16px' }
    },
    nearbyText: [], ancestorPath: [], screenshot: null,
    ...overrides
  }
}

test('clampPayload strips credentials, redacts hostile HTML and enforces every field budget', () => {
  const raw = payload({
    target: {
      ...(payload().target as Record<string, unknown>),
      selector: 's'.repeat(800), elementPath: 'p'.repeat(1000), fullPath: 'p'.repeat(1000),
      cssClasses: 'c'.repeat(550), textSnippet: 't'.repeat(250),
      htmlSnippet: `<section onclick="steal()" class="${'x'.repeat(300)}"><script>window.secret='leak'</script><input value="form-secret"><p>safe</p></section>`,
      attributes: { id: 'safe', class: 'c'.repeat(240), onclick: 'steal()', 'aria-label': 'oauth_state=private', href: 'https://u:p@example.test/a?q=private#part' },
      reactComponents: 'r'.repeat(600), sourceFile: 'f'.repeat(600),
      selectedText: 'z'.repeat(600), nearbyElements: Array.from({ length: 10 }, () => 'n'.repeat(200)),
      rectViewport: { x: Number.POSITIVE_INFINITY, y: Number.NaN, width: -2, height: Number.MAX_VALUE }
    },
    nearbyText: Array.from({ length: 12 }, () => 'n'.repeat(240)),
    ancestorPath: Array.from({ length: 12 }, () => 'a'.repeat(500))
  })

  const result = clampPayload(raw) as DesignPayload
  expect(result.page.sanitizedUrl).toBe('https://example.test/path')
  expect(result.target.selector.length).toBeLessThanOrEqual(700)
  expect(result.target.selector.endsWith(' (truncated)')).toBe(true)
  expect(result.target.elementPath.length).toBeLessThanOrEqual(900)
  expect(result.target.cssClasses.length).toBeLessThanOrEqual(500)
  expect(result.target.cssClasses.endsWith(' (truncated)')).toBe(true)
  expect(result.target.textSnippet.length).toBeLessThanOrEqual(200)
  expect(result.target.textSnippet.endsWith(' (truncated)')).toBe(true)
  expect(result.target.selectedText?.length).toBeLessThanOrEqual(500)
  expect(result.target.reactComponents?.length).toBeLessThanOrEqual(500)
  expect(result.target.sourceFile?.length).toBeLessThanOrEqual(500)
  expect(result.target.nearbyElements).toHaveLength(6)
  expect(result.nearbyText).toHaveLength(10)
  expect(result.nearbyText.every((entry) => entry.length <= 200)).toBe(true)
  expect(result.ancestorPath).toHaveLength(10)
  expect(result.target.attributes).not.toHaveProperty('onclick')
  expect(result.target.attributes['aria-label']).toBe('[redacted]')
  expect(result.target.attributes.href).toBe('https://example.test/a')
  expect(result.target.attributes.class?.length).toBeLessThanOrEqual(200)
  expect(result.target.htmlSnippet).not.toContain('<script')
  expect(result.target.htmlSnippet).not.toContain('onclick')
  expect(result.target.htmlSnippet).not.toContain('steal()')
  expect(result.target.htmlSnippet).not.toContain('form-secret')
  expect([result.target.rectViewport.x, result.target.rectViewport.y, result.target.rectViewport.width, result.target.rectViewport.height].every(Number.isFinite)).toBe(true)
})

test('clampPayload rejects malformed pages and drops screenshots above the exact PNG byte budget', () => {
  expect(() => clampPayload({ page: {}, target: {} })).toThrow()
  expect(() => clampPayload(payload({ page: { sanitizedUrl: 'javascript:alert(1)' } }))).toThrow()

  const base64OverBudget = `iVBORw0KGgo${'A'.repeat(Math.ceil((MAX_SCREENSHOT_BYTES + 1) * 4 / 3))}`
  const result = clampPayload(payload({
    screenshot: { mimeType: 'image/png', dataUrl: `data:image/png;base64,${base64OverBudget}`, width: 1, height: 1 }
  })) as DesignPayload
  expect(result.screenshot).toBeNull()
})

test('annotation feedback preserves user wording while bounding comments and rejecting non-strings', () => {
  const base = {
    id: 'feedback', revision: 1, browserPageId: 'page-one', payload: payload().target,
    intent: 'change' as const
  }
  const comment = 'Make the password label clearer; keep the api_key field name.'
  expect(clampAnnotation({ ...base, payload: payload(), comment }).comment).toBe(comment)
  const bounded = clampAnnotation({ ...base, payload: payload(), comment: 'x'.repeat(2100) }).comment
  expect(bounded.length).toBeLessThanOrEqual(2000)
  expect(bounded.endsWith(' (truncated)')).toBe(true)
  expect(() => clampAnnotation({ ...base, payload: payload(), comment: 42 })).toThrow()
})
