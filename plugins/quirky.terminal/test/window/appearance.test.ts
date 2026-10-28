import { expect, test } from 'bun:test'
import { GRAPHITE_TERMINAL_PALETTES, TERMINAL_ANSI_KEYS, type TerminalAppearanceMode, type TerminalPalette } from '@quirky/protocol'
import { resolveTerminalAppearance } from '../../src/window/pane/appearance'
import { DEFAULT_PANE_SETTINGS } from '../../src/window/pane/settings'

const appLight = {
  ...GRAPHITE_TERMINAL_PALETTES.light,
  background: '#app-background',
  foreground: '#app-foreground',
  cursor: '#app-cursor'
}

function expectGraphitePalette(actual: TerminalPalette, appearance: TerminalAppearanceMode, overrides: Partial<TerminalPalette> = {}) {
  const expected = GRAPHITE_TERMINAL_PALETTES[appearance]
  for (const key of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) {
    expect(actual[key]).toBe(overrides[key] ?? expected[key])
  }
  for (const key of TERMINAL_ANSI_KEYS) expect(actual[key]).toBe(overrides[key] ?? expected[key])
}

test('inherit follows the light app palette even while the system is dark', () => {
  const result = resolveTerminalAppearance(DEFAULT_PANE_SETTINGS, appLight, false)

  expectGraphitePalette(result.colors, 'light', {
    background: appLight.background,
    foreground: appLight.foreground,
    cursor: appLight.cursor
  })
})

test('dark and light terminal pins select every graphite slot independently of app appearance', () => {
  const dark = resolveTerminalAppearance({ ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'dark' }, appLight, true)
  const light = resolveTerminalAppearance({ ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'light' }, GRAPHITE_TERMINAL_PALETTES.dark, false)

  expectGraphitePalette(dark.colors, 'dark')
  expectGraphitePalette(light.colors, 'light')
  expect(dark.colors.background).not.toBe(light.colors.background)
})

test('system terminal mode follows OS appearance independently of the pinned app palette', () => {
  const settings = { ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'system' as const }
  const systemDark = resolveTerminalAppearance(settings, appLight, false)
  const systemLight = resolveTerminalAppearance(settings, GRAPHITE_TERMINAL_PALETTES.dark, true)

  expectGraphitePalette(systemDark.colors, 'dark')
  expectGraphitePalette(systemLight.colors, 'light')
})

test('Tango selections retain their existing palette while system mode switches appearances', () => {
  const settings = { ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'system' as const, 'theme-dark': 'tango' as const, 'theme-light': 'tango' as const }
  const dark = resolveTerminalAppearance(settings, appLight, false)
  const light = resolveTerminalAppearance(settings, appLight, true)

  expect(dark.colors.background).toBe('#2e3436')
  expect(dark.colors.foreground).toBe('#d3d7cf')
  expect(dark.colors.red).toBe('#cc0000')
  expect(light.colors.background).toBe('#ffffff')
  expect(light.colors.foreground).toBe('#2e3436')
  expect(light.colors.red).toBe('#cc0000')
})

test('valid custom colors override graphite slots while retaining the rest of the palette', () => {
  const settings = {
    ...DEFAULT_PANE_SETTINGS,
    'theme-mode': 'dark' as const,
    'theme-dark': 'custom' as const,
    'theme-custom-dark': JSON.stringify({ background: '#010203', red: '#c01020' })
  }
  const result = resolveTerminalAppearance(settings, appLight, false)

  expectGraphitePalette(result.colors, 'dark', { background: '#010203', red: '#c01020' })
  expect(result.warning).toBeUndefined()
})

test('invalid custom colors use the complete graphite fallback and warn without partial overrides', () => {
  const invalidPalettes = [
    '{"background":"#010203","red":"url(file:///secret)"}',
    '{"background":"#010203","unrecognized":"#fff"}',
    '[]',
    `${' '.repeat(4097)}`
  ]
  const settings = { ...DEFAULT_PANE_SETTINGS, 'theme-mode': 'dark' as const, 'theme-dark': 'custom' as const }

  for (const raw of invalidPalettes) {
    const result = resolveTerminalAppearance({ ...settings, 'theme-custom-dark': raw }, appLight, false)
    expectGraphitePalette(result.colors, 'dark')
    expect(result.warning).toContain('custom')
  }
})
