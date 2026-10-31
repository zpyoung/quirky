import { afterAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const RUNTIME_GLOBALS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance', 'fetch', 'WebSocket'] as const
const nativeGlobals = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
GlobalRegistrator.register()
for (const [name, value] of nativeGlobals) {
  if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}
afterAll(() => { GlobalRegistrator.unregister() })
beforeEach(() => { document.documentElement.removeAttribute('data-theme') })

const { createSelectionOverlay, selectionOverlayProgram, selectionOverlayStyles } = await import('../src/design-system/selection-overlay')

type Overlay = ReturnType<typeof createSelectionOverlay>

test('selectionOverlayStyles scope tokens to the shadow host and style the picker parts', () => {
  expect(selectionOverlayStyles).toContain(':host')
  expect(selectionOverlayStyles).not.toContain(':root')
  expect(selectionOverlayStyles).toContain(":host([data-theme='dark'])")
  for (const selector of ['.surface', '.highlight', '.label']) expect(selectionOverlayStyles).toContain(selector)
})

test('createSelectionOverlay builds a full-window host with a closed shadow root and hidden marks', () => {
  document.documentElement.setAttribute('data-theme', 'light')
  const { host, shadow, surface, highlight, label } = createSelectionOverlay(document, 'MARK{}')
  expect(host.getAttribute('data-theme')).toBe('light')
  expect(host.style.getPropertyValue('position')).toBe('fixed')
  expect(host.style.getPropertyPriority('z-index')).toBe('important')
  expect(host.shadowRoot).toBeNull()
  expect(shadow.querySelector('style')?.textContent).toBe('MARK{}')
  expect(surface.className).toBe('surface')
  expect(surface.tabIndex).toBe(0)
  expect(highlight.hidden).toBe(true)
  expect(label.hidden).toBe(true)
})

test('selectionOverlayProgram evaluates to a working overlay from its string alone', () => {
  document.documentElement.setAttribute('data-theme', 'dark')
  const overlay = (0, eval)(selectionOverlayProgram) as Overlay
  expect(overlay.host.getAttribute('data-theme')).toBe('dark')
  expect(overlay.shadow.querySelector('style')?.textContent).toBe(selectionOverlayStyles)
  expect(overlay.shadow.querySelector('.surface')).toBe(overlay.surface)
  document.body.append(overlay.host)
  expect(document.body.contains(overlay.host)).toBe(true)
})

test('selectionOverlayProgram does not reference module scope', () => {
  expect(selectionOverlayProgram).not.toMatch(/selectionOverlayStyles|tokenStyles/)
})
