import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  GRAPHITE_TERMINAL_PALETTES,
  TERMINAL_ANSI_KEYS,
  type TerminalAppearanceMode,
  type TerminalPalette
} from '@quirky/protocol'
import { readTerminalTheme } from '../src/terminal-theme'

let systemLight = false
let originalMatchMedia: typeof window.matchMedia

beforeAll(() => GlobalRegistrator.register())
afterAll(async () => GlobalRegistrator.unregister())
beforeEach(() => {
  systemLight = false
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  originalMatchMedia = window.matchMedia
  window.matchMedia = (() => ({ matches: systemLight }) as MediaQueryList) as typeof window.matchMedia
})
afterEach(() => {
  window.matchMedia = originalMatchMedia
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

function expectGraphitePalette(theme: TerminalPalette, appearance: TerminalAppearanceMode, base: Partial<TerminalPalette> = {}) {
  const expected = GRAPHITE_TERMINAL_PALETTES[appearance]
  for (const key of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) {
    expect(theme[key]).toBe(base[key] ?? expected[key])
  }
  for (const key of TERMINAL_ANSI_KEYS) expect(theme[key]).toBe(expected[key])
}

test('the root light appearance selects all graphite slots over a dark system preference', () => {
  document.documentElement.setAttribute('data-theme', 'light')
  systemLight = false
  const source = document.createElement('div')
  document.body.appendChild(source)

  expectGraphitePalette(readTerminalTheme(source), 'light')
})

test('the root dark appearance stays authoritative over a light system and inherits terminal base colors', () => {
  document.documentElement.setAttribute('data-theme', 'dark')
  systemLight = true
  const ancestor = document.createElement('div')
  ancestor.style.setProperty('--terminal-background', '#custom-background')
  ancestor.style.setProperty('--terminal-foreground', '#custom-foreground')
  ancestor.style.setProperty('--terminal-cursor', '#custom-cursor')
  const source = document.createElement('div')
  ancestor.appendChild(source)
  document.body.appendChild(ancestor)

  expectGraphitePalette(readTerminalTheme(source), 'dark', {
    background: '#custom-background',
    foreground: '#custom-foreground',
    cursor: '#custom-cursor'
  })
})

test('a standalone source without root data-theme follows the system preference', () => {
  systemLight = true
  const source = document.createElement('div')
  document.body.appendChild(source)

  expectGraphitePalette(readTerminalTheme(source), 'light')
})
