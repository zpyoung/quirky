import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getAvailableTerminalThemeOptions,
  getBuiltinTheme,
  isTerminalBackgroundLight,
  resolveOpaqueTerminalBackground,
  resolveEffectiveTerminalAppearance
} from './terminal-theme'

// Mirrors Codex instruction block gray so the dark selection cannot disappear into it.
const INSTRUCTION_BLOCK_BACKGROUND = '#3e4451'

function parseHexColor(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  const hex = match?.[1]
  if (!hex) {
    return null
  }

  const value = Number.parseInt(hex, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toLinearChannel(channel: number): number {
  const scaled = channel / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  return (
    0.2126 * toLinearChannel(red) + 0.7152 * toLinearChannel(green) + 0.0722 * toLinearChannel(blue)
  )
}

function contrastRatio(first: string, second: string): number {
  const firstRgb = parseHexColor(first)
  const secondRgb = parseHexColor(second)

  expect(firstRgb, `${first} should be a 6-digit hex color`).not.toBeNull()
  expect(secondRgb, `${second} should be a 6-digit hex color`).not.toBeNull()
  if (!firstRgb || !secondRgb) {
    throw new Error('Expected contrast colors to parse as 6-digit hex values')
  }

  const firstLuminance = relativeLuminance(firstRgb)
  const secondLuminance = relativeLuminance(secondRgb)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)

  return (lighter + 0.05) / (darker + 0.05)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveEffectiveTerminalAppearance', () => {
  it('uses the light terminal theme for system theme on light OS when light variant is enabled', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'system',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#24262c',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#e3e5ea'
      },
      false
    )

    expect(appearance.mode).toBe('light')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_LIGHT)
  })

  it('uses the dark terminal theme for system theme on dark OS', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'system',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#24262c',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#e3e5ea'
      },
      true
    )

    expect(appearance.mode).toBe('dark')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_DARK)
  })

  it('reuses the dark terminal theme in light mode when separate light theme is disabled', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#24262c',
        terminalUseSeparateLightTheme: false,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#e3e5ea'
      },
      false
    )

    expect(appearance.mode).toBe('light')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_DARK)
  })

  it('falls back to the default light theme when terminalThemeLight is blank', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#24262c',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: '',
        terminalDividerColorLight: '#e3e5ea'
      },
      false
    )

    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_LIGHT)
  })

  it('keeps invalid terminalThemeLight names while preview falls back to light', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#24262c',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'Invalid Theme Name',
        terminalDividerColorLight: '#e3e5ea'
      },
      false
    )

    expect(appearance.themeName).toBe('Invalid Theme Name')
    expect(appearance.theme).toEqual(getBuiltinTheme(DEFAULT_TERMINAL_THEME_LIGHT))
  })

  it('resolves custom theme selections by id', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'dark',
        terminalThemeDark: 'custom:warp:tokyo-night',
        terminalDividerColorDark: '#24262c',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#e3e5ea',
        terminalCustomThemes: [
          {
            id: 'warp:tokyo-night',
            name: 'Builtin Tango Light',
            source: 'warp',
            mode: 'dark',
            terminal: {
              background: '#1a1b26',
              foreground: '#c0caf5',
              black: '#15161e'
            },
            importedAt: '2026-06-05T00:00:00.000Z'
          }
        ]
      },
      true
    )

    expect(appearance.themeName).toBe('custom:warp:tokyo-night')
    expect(appearance.theme?.background).toBe('#1a1b26')
  })

  it('falls back visually when a custom selection is missing', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'dark',
        terminalThemeDark: 'custom:warp:missing',
        terminalDividerColorDark: '#24262c',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#e3e5ea',
        terminalCustomThemes: []
      },
      true
    )

    expect(appearance.themeName).toBe('custom:warp:missing')
    expect(appearance.theme).toEqual(getBuiltinTheme(DEFAULT_TERMINAL_THEME_DARK))
  })

  it('falls back visually to the light default when a light custom selection is missing', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#24262c',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'custom:warp:missing',
        terminalDividerColorLight: '#e3e5ea',
        terminalCustomThemes: []
      },
      false
    )

    expect(appearance.themeName).toBe('custom:warp:missing')
    expect(appearance.theme).toEqual(getBuiltinTheme(DEFAULT_TERMINAL_THEME_LIGHT))
  })

  it('includes imported themes as grouped picker options', () => {
    const options = getAvailableTerminalThemeOptions({
      terminalCustomThemes: [
        {
          id: 'warp:tokyo-night',
          name: 'Tokyo Night',
          source: 'warp',
          mode: 'dark',
          terminal: {
            background: '#1a1b26',
            foreground: '#c0caf5',
            black: '#15161e'
          },
          importedAt: '2026-06-05T00:00:00.000Z'
        }
      ]
    })

    expect(options.some((option) => option.group === 'built-in')).toBe(true)
    expect(options).toContainEqual(
      expect.objectContaining({
        value: 'custom:warp:tokyo-night',
        label: 'Tokyo Night',
        group: 'imported',
        sourceLabel: 'Warp'
      })
    )
  })
})

describe('Ghostty Default Style Dark selection contrast', () => {
  it('keeps selection distinct from instruction blocks while preserving readable selected text', () => {
    const theme = getBuiltinTheme('Ghostty Default Style Dark')

    expect(theme, 'Ghostty Default Style Dark should exist').not.toBeNull()

    const selectionBackground = theme?.selectionBackground
    const selectionForeground = theme?.selectionForeground

    expect(selectionBackground, 'selectionBackground should be defined').toBeDefined()
    expect(selectionForeground, 'selectionForeground should be defined').toBeDefined()
    if (!selectionBackground || !selectionForeground) {
      throw new Error('Ghostty Default Style Dark is missing selection colors')
    }

    expect(contrastRatio(selectionBackground, INSTRUCTION_BLOCK_BACKGROUND)).toBeGreaterThanOrEqual(
      2
    )
    expect(contrastRatio(selectionForeground, selectionBackground)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('Builtin Tango Light ANSI contrast', () => {
  it('keeps CLI body/header ANSI colors readable on the terminal background', () => {
    const theme = getBuiltinTheme('Builtin Tango Light')

    expect(theme, 'Builtin Tango Light should exist').not.toBeNull()
    if (!theme?.background) {
      throw new Error('Builtin Tango Light is missing a background color')
    }

    for (const key of ['cyan', 'white', 'brightCyan', 'brightWhite'] as const) {
      const color = theme[key]
      expect(color, `Builtin Tango Light.${key} should be defined`).toBeDefined()
      if (!color) {
        throw new Error(`Builtin Tango Light.${key} is missing`)
      }
      expect(contrastRatio(color, theme.background)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('default terminal themes', () => {
  it('are Quirky Graphite, with dividers that match the graphite border tokens', () => {
    expect(DEFAULT_TERMINAL_THEME_DARK).toBe('Quirky Graphite Dark')
    expect(DEFAULT_TERMINAL_THEME_LIGHT).toBe('Quirky Graphite Light')
    expect(DEFAULT_TERMINAL_DIVIDER_DARK).toBe('#24262c')
  })

  it('keep selected text readable over the selection tint on an instruction block', () => {
    const theme = getBuiltinTheme(DEFAULT_TERMINAL_THEME_DARK)
    const tint = theme?.selectionBackground
    const foreground = theme?.selectionForeground
    if (!tint || !foreground) {
      throw new Error(`${DEFAULT_TERMINAL_THEME_DARK} is missing selection colors`)
    }
    const alpha = Number.parseInt(tint.slice(7, 9), 16) / 255
    const tintRgb = parseHexColor(tint.slice(0, 7))
    const blockRgb = parseHexColor(INSTRUCTION_BLOCK_BACKGROUND)
    if (!tintRgb || !blockRgb) {
      throw new Error('selection colors should parse')
    }
    const blended = tintRgb
      .map((channel, index) => Math.round(channel * alpha + blockRgb[index] * (1 - alpha)))
      .reduce((hex, channel) => hex + channel.toString(16).padStart(2, '0'), '#')

    expect(contrastRatio(foreground, blended)).toBeGreaterThanOrEqual(4.5)
  })

  it('keep the light default readable: text 4.5:1 and every chromatic ANSI 3:1 on white', () => {
    const theme = getBuiltinTheme(DEFAULT_TERMINAL_THEME_LIGHT)
    if (!theme?.background || !theme.foreground) {
      throw new Error(`${DEFAULT_TERMINAL_THEME_LIGHT} is missing base colors`)
    }

    expect(contrastRatio(theme.foreground, theme.background)).toBeGreaterThanOrEqual(4.5)
    for (const key of [
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan'
    ] as const) {
      const color = theme[key]
      if (!color) {
        throw new Error(`${DEFAULT_TERMINAL_THEME_LIGHT}.${key} is missing`)
      }
      expect(contrastRatio(color, theme.background), key).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('isTerminalBackgroundLight', () => {
  it('classifies common terminal background color formats by luminance', () => {
    const split = vi.spyOn(String.prototype, 'split')

    expect(isTerminalBackgroundLight('#ffffff')).toBe(true)
    expect(isTerminalBackgroundLight('#18181b')).toBe(false)
    expect(isTerminalBackgroundLight('#fffc')).toBe(true)
    expect(isTerminalBackgroundLight('rgb(245 245 244)')).toBe(true)
    expect(isTerminalBackgroundLight('rgba(24, 24, 27, 0.92)')).toBe(false)
    expect(
      split.mock.calls.filter(
        ([separator]) => separator instanceof RegExp && separator.source === '\\s+'
      )
    ).toHaveLength(0)
  })

  it('classifies transparent backgrounds after compositing with the app surface', () => {
    expect(
      isTerminalBackgroundLight('#ffffff', { backgroundOpacity: 0.1, appSurface: 'dark' })
    ).toBe(false)
    expect(
      isTerminalBackgroundLight('#ffffff', { backgroundOpacity: 0.6, appSurface: 'dark' })
    ).toBe(true)
    expect(isTerminalBackgroundLight('rgba(255, 255, 255, 0.1)', { appSurface: 'dark' })).toBe(
      false
    )
    expect(isTerminalBackgroundLight('rgb(255 255 255 / 10%)', { appSurface: 'dark' })).toBe(false)
    expect(
      isTerminalBackgroundLight('#000000', { backgroundOpacity: 0.1, appSurface: 'light' })
    ).toBe(true)
  })

  it('defaults unknown colors to dark-surface title styling', () => {
    expect(isTerminalBackgroundLight(undefined)).toBe(false)
    expect(isTerminalBackgroundLight('var(--background)')).toBe(false)
  })
})

describe('resolveOpaqueTerminalBackground', () => {
  it('returns an opaque terminal title background', () => {
    expect(resolveOpaqueTerminalBackground('#18181b')).toBe('rgb(24 24 27)')
    expect(
      resolveOpaqueTerminalBackground('rgba(255, 255, 255, 0.1)', { appSurface: 'dark' })
    ).toBe('rgb(45 46 50)')
    expect(
      resolveOpaqueTerminalBackground('#ffffff', {
        backgroundOpacity: 0.1,
        appSurface: 'dark'
      })
    ).toBe('rgb(45 46 50)')
  })

  it('returns null for unknown color values', () => {
    expect(resolveOpaqueTerminalBackground(undefined)).toBe(null)
    expect(resolveOpaqueTerminalBackground('var(--background)')).toBe(null)
  })
})
