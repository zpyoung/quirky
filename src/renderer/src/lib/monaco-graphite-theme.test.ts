import { describe, expect, it, vi } from 'vitest'
import {
  MONACO_THEME_DARK,
  MONACO_THEME_LIGHT,
  defineGraphiteMonacoThemes,
  monacoThemeFor
} from './monaco-graphite-theme'

type DefinedTheme = {
  base: string
  inherit: boolean
  rules: { token: string; foreground?: string }[]
  colors: Record<string, string>
}

function defineAll(): Map<string, DefinedTheme> {
  const themes = new Map<string, DefinedTheme>()
  const defineTheme = vi.fn((id: string, data: DefinedTheme) => {
    themes.set(id, data)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only editor.defineTheme is read.
  defineGraphiteMonacoThemes({ editor: { defineTheme } } as never)
  return themes
}

describe('monacoThemeFor', () => {
  it('maps the resolved mode to the graphite theme ids', () => {
    expect(monacoThemeFor(true)).toBe(MONACO_THEME_DARK)
    expect(monacoThemeFor(false)).toBe(MONACO_THEME_LIGHT)
  })
})

describe('defineGraphiteMonacoThemes', () => {
  it('defines both themes on the stock bases with inheritance', () => {
    const themes = defineAll()

    expect(themes.get(MONACO_THEME_DARK)).toMatchObject({ base: 'vs-dark', inherit: true })
    expect(themes.get(MONACO_THEME_LIGHT)).toMatchObject({ base: 'vs', inherit: true })
  })

  it('uses the locked surface, selection and diff colours as plain hex', () => {
    const themes = defineAll()
    const dark = themes.get(MONACO_THEME_DARK)!.colors
    const light = themes.get(MONACO_THEME_LIGHT)!.colors

    expect(dark['editor.background']).toBe('#16171b')
    expect(dark['editor.selectionBackground']).toBe('#5fd0d638')
    expect(dark['diffEditor.insertedTextBackground']).toBe('#3fb95024')
    expect(dark['diffEditor.removedTextBackground']).toBe('#e5534b24')
    expect(light['editor.background']).toBe('#ffffff')
    expect(light['editor.selectionBackground']).toBe('#14808a38')
    expect(light['diffEditor.insertedTextBackground']).toBe('#2da44e1f')
    expect(light['diffEditor.removedTextBackground']).toBe('#cf222e1a')
    for (const value of [...Object.values(dark), ...Object.values(light)]) {
      expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
    }
  })

  it('colours keywords with the locked syntax value for each mode', () => {
    const themes = defineAll()
    const keyword = (id: string): string | undefined =>
      themes.get(id)!.rules.find((rule) => rule.token === 'keyword')?.foreground

    expect(keyword(MONACO_THEME_DARK)).toBe('c79bff')
    expect(keyword(MONACO_THEME_LIGHT)).toBe('7f4fc9')
  })

  it('can run more than once without throwing', () => {
    expect(() => {
      defineAll()
      defineAll()
    }).not.toThrow()
  })
})
