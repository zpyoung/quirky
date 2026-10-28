import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
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

test('an explicit root appearance is stable across system changes and changes when the root changes', () => {
  const source = document.createElement('div')
  document.body.appendChild(source)

  document.documentElement.setAttribute('data-theme', 'dark')
  systemLight = false
  const dark = readTerminalTheme(source)
  systemLight = true
  expect(readTerminalTheme(source)).toEqual(dark)

  document.documentElement.setAttribute('data-theme', 'light')
  const light = readTerminalTheme(source)
  systemLight = false
  expect(readTerminalTheme(source)).toEqual(light)

  expect(light.background).not.toBe(dark.background)
  expect(light.foreground).not.toBe(dark.foreground)
})

test('a standalone source without root data-theme follows the system preference', () => {
  const source = document.createElement('div')
  document.body.appendChild(source)

  document.documentElement.setAttribute('data-theme', 'dark')
  const dark = readTerminalTheme(source)
  document.documentElement.setAttribute('data-theme', 'light')
  const light = readTerminalTheme(source)
  document.documentElement.removeAttribute('data-theme')

  systemLight = false
  expect(readTerminalTheme(source)).toEqual(dark)
  systemLight = true
  expect(readTerminalTheme(source)).toEqual(light)
})

test('overrides terminal base colors supplied on the source', () => {
  document.documentElement.setAttribute('data-theme', 'dark')
  systemLight = true
  const source = document.createElement('div')
  source.style.setProperty('--terminal-background', '#123456')
  source.style.setProperty('--terminal-foreground', '#ddeeff')
  source.style.setProperty('--terminal-cursor', '#abcdef')
  document.body.appendChild(source)

  const theme = readTerminalTheme(source)

  expect(theme.background).toBe('#123456')
  expect(theme.foreground).toBe('#ddeeff')
  expect(theme.cursor).toBe('#abcdef')
})
