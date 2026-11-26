import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseCssRgbColor, type RgbaColor } from '../../lib/terminal-title-contrast'

const mainCss = fs.readFileSync(new URL('../main.css', import.meta.url), 'utf8')
const coloringCss = fs.readFileSync(
  new URL('../fork-native-chat-coloring.css', import.meta.url),
  'utf8'
)

function getCssRuleBody(css: string, selector: string): string {
  const ruleMarker = css.indexOf(`\n${selector} {`)
  expect(ruleMarker).toBeGreaterThanOrEqual(0)

  const ruleStart = ruleMarker + 1
  const bodyStart = css.indexOf('{', ruleStart) + 1
  const bodyEnd = css.indexOf('}', bodyStart)
  return css.slice(bodyStart, bodyEnd)
}

function readToken(block: string, name: string): RgbaColor {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`))
  expect(match, `missing ${name} declaration`).not.toBeNull()
  const raw = match![1].trim()
  const color = parseCssRgbColor(raw)
  expect(color, `could not parse ${name} value "${raw}"`).not.toBeNull()
  return color!
}

// Mirrors `color-mix(in srgb, var(--fg) p%, var(--bg))`: a straight per-channel blend.
function resolveColorMix(fg: RgbaColor, bg: RgbaColor, fgPercent: number): RgbaColor {
  return {
    r: fg.r * fgPercent + bg.r * (1 - fgPercent),
    g: fg.g * fgPercent + bg.g * (1 - fgPercent),
    b: fg.b * fgPercent + bg.b * (1 - fgPercent),
    a: 1
  }
}

type ThemeColors = {
  background: RgbaColor
  sidebar: RgbaColor
  muted: RgbaColor
  foreground: RgbaColor
  toolRead: RgbaColor
  toolWrite: RgbaColor
  toolExec: RgbaColor
  toolSearch: RgbaColor
  toolNet: RgbaColor
  codeAccent: RgbaColor
  codeAccentSurface: RgbaColor
  chatUserSurface: RgbaColor
}

function readThemeColors(block: string): ThemeColors {
  const background = readToken(block, '--background')
  const toolRead = readToken(block, '--tool-read')
  const codeAccent = readToken(block, '--code-accent')
  return {
    background,
    sidebar: readToken(block, '--sidebar'),
    muted: readToken(block, '--muted'),
    foreground: readToken(block, '--foreground'),
    toolRead,
    toolWrite: readToken(block, '--tool-write'),
    toolExec: readToken(block, '--tool-exec'),
    toolSearch: readToken(block, '--tool-search'),
    toolNet: readToken(block, '--tool-net'),
    codeAccent,
    codeAccentSurface: resolveColorMix(codeAccent, background, 0.12),
    chatUserSurface: resolveColorMix(toolRead, background, 0.13)
  }
}

const THEMES: Record<'light' | 'dark', ThemeColors> = {
  light: readThemeColors(
    `${getCssRuleBody(mainCss, ':root')}\n${getCssRuleBody(coloringCss, ':root')}`
  ),
  dark: readThemeColors(
    `${getCssRuleBody(mainCss, '.dark')}\n${getCssRuleBody(coloringCss, '.dark')}`
  )
}

type ContrastCase = {
  token: string
  ground: string
  foreground: RgbaColor
  background: RgbaColor
  floor: number
}

const TOOL_TOKENS: { token: string; key: keyof ThemeColors }[] = [
  { token: '--tool-read', key: 'toolRead' },
  { token: '--tool-write', key: 'toolWrite' },
  { token: '--tool-exec', key: 'toolExec' },
  { token: '--tool-search', key: 'toolSearch' },
  { token: '--tool-net', key: 'toolNet' }
]

// Table of every contrast obligation the palette claims to meet. Add a row here
// whenever a new chat-transcript color token needs a floor enforced.
function buildContrastTable(colors: ThemeColors): ContrastCase[] {
  const table: ContrastCase[] = []

  for (const { token, key } of TOOL_TOKENS) {
    table.push({
      token: `${token} (text)`,
      ground: '--background',
      foreground: colors[key],
      background: colors.background,
      floor: 4.5
    })
    table.push({
      token: `${token} (text)`,
      ground: '--sidebar',
      foreground: colors[key],
      background: colors.sidebar,
      floor: 4.5
    })
    table.push({
      token: `${token} (dot)`,
      ground: '--background',
      foreground: colors[key],
      background: colors.background,
      floor: 3
    })
    table.push({
      token: `${token} (dot)`,
      ground: '--muted',
      foreground: colors[key],
      background: colors.muted,
      floor: 3
    })
  }

  table.push({
    token: '--code-accent',
    ground: '--code-accent-surface (resolved)',
    foreground: colors.codeAccent,
    background: colors.codeAccentSurface,
    floor: 4.5
  })

  table.push({
    token: '--foreground',
    ground: '--chat-user-surface (resolved)',
    foreground: colors.foreground,
    background: colors.chatUserSurface,
    floor: 4.5
  })

  return table
}

describe('chat tool color contrast', () => {
  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      for (const testCase of buildContrastTable(THEMES[theme])) {
        it(`${testCase.token} clears ${testCase.floor}:1 against ${testCase.ground}`, () => {
          const ratio = contrastRatio(testCase.foreground, testCase.background)
          expect(
            ratio,
            `${testCase.token} in ${theme} theme against ${testCase.ground}: computed ${ratio.toFixed(2)}:1, floor ${testCase.floor}:1`
          ).toBeGreaterThanOrEqual(testCase.floor)
        })
      }
    })
  }
})
