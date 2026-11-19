import { describe, expect, test } from 'bun:test'

const css = await Bun.file(new URL('../src/design-system/tokens.css', import.meta.url)).text()

type Rgba = { r: number; g: number; b: number; a: number }
type Theme = Record<string, string>

function declarations(block: string): Theme {
  const out: Theme = {}
  for (const match of block.matchAll(/(--ui-[\w-]+)\s*:\s*([^;]+);/g)) out[match[1]] = match[2].trim()
  return out
}

function block(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`no ${selector} block`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

const dark = declarations(block(":root,\n[data-theme='dark']"))
const light = { ...dark, ...declarations(block("[data-theme='light'] {\n  color-scheme: light;")) }

function resolve(theme: Theme, name: string): string {
  let value = theme[name]
  if (value === undefined) throw new Error(`${name} is not defined`)
  for (let depth = 0; depth < 8; depth += 1) {
    const alias = /^var\((--ui-[\w-]+)\)$/.exec(value)
    if (!alias) return value
    const next = theme[alias[1]]
    if (next === undefined) throw new Error(`${alias[1]} is not defined`)
    value = next
  }
  throw new Error(`${name} aliases too deeply`)
}

function parseHex(value: string): Rgba {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value)
  if (!match) throw new Error(`${value} is not a 6 or 8 digit hex colour`)
  const n = Number.parseInt(match[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: match[2] ? Number.parseInt(match[2], 16) / 255 : 1 }
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
}

function mix(first: Rgba, second: Rgba, share: number): Rgba {
  const blend = (a: number, b: number) => a * share + b * (1 - share)
  return { r: blend(first.r, second.r), g: blend(first.g, second.g), b: blend(first.b, second.b), a: 1 }
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(foreground: Rgba, background: Rgba): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const colour = (theme: Theme, name: string) => parseHex(resolve(theme, name))
const withAlpha = (value: Rgba, alpha: number): Rgba => ({ ...value, a: alpha })

const NEW_TOKENS = [
  '--ui-syntax-keyword', '--ui-syntax-function', '--ui-syntax-string', '--ui-syntax-number', '--ui-syntax-comment',
  '--ui-syntax-type', '--ui-syntax-constant', '--ui-syntax-punctuation', '--ui-code-bg', '--ui-code-header-bg',
  '--ui-diff-add-bg', '--ui-diff-add-text', '--ui-diff-del-bg', '--ui-diff-del-text', '--ui-alert-note',
  '--ui-alert-tip', '--ui-alert-important', '--ui-alert-warning', '--ui-alert-caution', '--ui-heading-accent',
  '--ui-inline-code-bg', '--ui-inline-code-text', '--ui-table-zebra', '--ui-mark-bg'
]
const ALERT_HUES: Record<string, string> = {
  '--ui-alert-note': 'var(--ui-accent)',
  '--ui-alert-tip': 'var(--ui-hue-mint)',
  '--ui-alert-important': 'var(--ui-hue-violet)',
  '--ui-alert-warning': 'var(--ui-hue-sand)',
  '--ui-alert-caution': 'var(--ui-hue-coral)'
}
const ALERT_TINT = 0.09
// markdown.css draws the label as color-mix(in srgb, var(--qmd-alert) 70%, var(--ui-text))
const ALERT_LABEL_HUE_SHARE = 0.7

const themes: Array<[string, Theme, string]> = [['dark', dark, ":root,\n[data-theme='dark']"], ['light', light, "[data-theme='light']"]]

for (const [name, theme, selector] of themes) {
  describe(`${name} markdown tokens`, () => {
    test('every new token is defined in its own theme block', () => {
      const own = declarations(block(name === 'light' ? "[data-theme='light'] {\n  color-scheme: light;" : selector))
      for (const token of NEW_TOKENS) expect(own[token]).toBeDefined()
    })

    test('alert tokens alias hue tokens and never status tokens', () => {
      const own = declarations(block(name === 'light' ? "[data-theme='light'] {\n  color-scheme: light;" : selector))
      for (const [token, alias] of Object.entries(ALERT_HUES)) expect(own[token]).toBe(alias)
    })

    test('syntax tokens read at 4.5:1 on the code background', () => {
      const background = colour(theme, '--ui-code-bg')
      for (const token of NEW_TOKENS.filter((entry) => entry.startsWith('--ui-syntax-'))) {
        expect({ token, ratio: contrast(colour(theme, token), background) >= 4.5 }).toEqual({ token, ratio: true })
      }
    })

    test('plain code text reads on the code background', () => {
      expect(contrast(colour(theme, '--ui-text'), colour(theme, '--ui-code-bg'))).toBeGreaterThanOrEqual(4.5)
    })

    test('the comment colour doubles as quiet chrome text on every markdown surface', () => {
      const quiet = colour(theme, '--ui-syntax-comment')
      for (const surface of ['--ui-surface', '--ui-code-bg', '--ui-code-header-bg']) {
        expect({ surface, ok: contrast(quiet, colour(theme, surface)) >= 4.5 }).toEqual({ surface, ok: true })
      }
    })

    test('diff text reads on its tinted line', () => {
      const code = colour(theme, '--ui-code-bg')
      for (const kind of ['add', 'del']) {
        const tinted = over(colour(theme, `--ui-diff-${kind}-bg`), code)
        expect({ kind, ok: contrast(colour(theme, `--ui-diff-${kind}-text`), tinted) >= 4.5 }).toEqual({ kind, ok: true })
      }
    })

    test('alert labels read on their tint over the surface', () => {
      const surface = colour(theme, '--ui-surface')
      for (const token of Object.keys(ALERT_HUES)) {
        const hue = colour(theme, token)
        const tinted = over(withAlpha(hue, ALERT_TINT), surface)
        const label = mix(hue, colour(theme, '--ui-text'), ALERT_LABEL_HUE_SHARE)
        expect({ token, ok: contrast(label, tinted) >= 4.5 }).toEqual({ token, ok: true })
      }
    })

    test('heading accent reads on the surface', () => {
      expect(contrast(colour(theme, '--ui-heading-accent'), colour(theme, '--ui-surface'))).toBeGreaterThanOrEqual(4.5)
    })

    test('inline code text reads on its tint over the surface', () => {
      const tinted = over(colour(theme, '--ui-inline-code-bg'), colour(theme, '--ui-surface'))
      expect(contrast(colour(theme, '--ui-inline-code-text'), tinted)).toBeGreaterThanOrEqual(4.5)
    })

    test('body text reads on the zebra row and the highlight', () => {
      const surface = colour(theme, '--ui-surface')
      expect(contrast(colour(theme, '--ui-text'), over(colour(theme, '--ui-table-zebra'), surface))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colour(theme, '--ui-text'), over(colour(theme, '--ui-mark-bg'), surface))).toBeGreaterThanOrEqual(4.5)
    })
  })
}
