import { expect, test } from 'bun:test'
import { resolveTerminalAppearance } from '../../src/window/pane/appearance'
import { DEFAULT_PANE_SETTINGS } from '../../src/window/pane/settings'

const inherited = { background: '#123456', foreground: '#abcdef', cursor: '#fedcba' }

test('independent terminal dark and light choices preserve application colors', () => {
  const dark = resolveTerminalAppearance({ ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'dark' }, inherited, true)
  const light = resolveTerminalAppearance({ ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'light' }, inherited, false)
  expect(dark.colors.background).toBe('#16181d')
  expect(light.colors.background).toBe('#ffffff')
  expect(inherited.background).toBe('#123456')
  expect(resolveTerminalAppearance(DEFAULT_PANE_SETTINGS, inherited, false).colors).toEqual(inherited)
})

test('system appearance chooses separate saved palettes without changing selected mode', () => {
  const settings = { ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'system' as const, 'theme-dark': 'tango' as const }
  expect(resolveTerminalAppearance(settings, inherited, false).colors.background).toBe('#2e3436')
  expect(resolveTerminalAppearance(settings, inherited, true).colors.background).toBe('#ffffff')
  expect(settings['theme-mode']).toBe('system')
})

test('custom palette keeps ANSI colors and rejects CSS URLs or unrecognized keys as a whole', () => {
  const settings = { ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'dark' as const, 'theme-dark': 'custom' as const,
    'theme-custom-dark': JSON.stringify({ background: '#010203', foreground: '#fafafa', red: '#c01020' }) }
  const valid = resolveTerminalAppearance(settings, inherited, false)
  expect(valid.colors.background).toBe('#010203')
  expect(valid.colors.red).toBe('#c01020')
  const invalid = resolveTerminalAppearance({ ...settings, 'theme-custom-dark': '{"background":"url(file:///secret)","unrecognized":"#fff"}' }, inherited, false)
  expect(invalid.colors.background).toBe('#16181d')
  expect(invalid.warning).toContain('custom')
  expect(resolveTerminalAppearance({ ...settings, 'theme-custom-dark': '[]' }, inherited, false).warning).toBeDefined()
})
