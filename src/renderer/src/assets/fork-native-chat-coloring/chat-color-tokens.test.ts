import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = fs.readFileSync(new URL('../main.css', import.meta.url), 'utf8')
const coloringCss = fs.readFileSync(
  new URL('../fork-native-chat-coloring.css', import.meta.url),
  'utf8'
)
function getCssBlockBody(css: string, selector: string): string {
  const ruleMarker = css.indexOf(`${selector} {`)
  expect(ruleMarker).toBeGreaterThanOrEqual(0)

  const ruleStart = ruleMarker + 1
  const bodyStart = css.indexOf('{', ruleStart) + 1
  const bodyEnd = css.indexOf('}', bodyStart)
  return css.slice(bodyStart, bodyEnd)
}

const CODE_ACCENT_SURFACE_EXPR = 'color-mix(in srgb, var(--code-accent) 12%, var(--background))'
const CHAT_USER_SURFACE_EXPR = 'color-mix(in srgb, var(--tool-read) 13%, var(--background))'

const PALETTE_TOKENS: { name: string; light: string; dark: string }[] = [
  { name: '--tool-read', light: '#2f6a96', dark: '#8ab4d8' },
  { name: '--tool-write', light: '#8a6100', dark: '#e3b341' },
  { name: '--tool-exec', light: '#24707a', dark: '#79bfc4' },
  { name: '--tool-search', light: '#4f4fc4', dark: '#9a9ae6' },
  { name: '--tool-net', light: '#6a4fb0', dark: '#b39ddb' },
  { name: '--code-accent', light: '#a01e6a', dark: '#f191c5' },
  {
    name: '--code-accent-surface',
    light: CODE_ACCENT_SURFACE_EXPR,
    dark: CODE_ACCENT_SURFACE_EXPR
  },
  { name: '--chat-user-surface', light: CHAT_USER_SURFACE_EXPR, dark: CHAT_USER_SURFACE_EXPR }
]

const HLJS_TOKENS: { name: string; light: string; dark: string }[] = [
  { name: '--hljs-keyword', light: '#cf222e', dark: '#ff7b72' },
  { name: '--hljs-string', light: '#0a3069', dark: '#a5d6ff' },
  { name: '--hljs-number', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-comment', light: '#6e7781', dark: '#8b949e' },
  { name: '--hljs-function', light: '#8250df', dark: '#d2a8ff' },
  { name: '--hljs-title', light: '#8250df', dark: '#d2a8ff' },
  { name: '--hljs-built-in', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-type', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-attr', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-selector-class', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-variable', light: '#953800', dark: '#ffa657' },
  { name: '--hljs-meta', light: '#6e7781', dark: '#8b949e' },
  { name: '--hljs-tag', light: '#116329', dark: '#7ee787' },
  { name: '--hljs-name', light: '#116329', dark: '#7ee787' },
  { name: '--hljs-params', light: '#953800', dark: '#ffa657' },
  { name: '--hljs-literal', light: '#0550ae', dark: '#79c0ff' },
  { name: '--hljs-regexp', light: '#0a3069', dark: '#a5d6ff' },
  { name: '--hljs-operator', light: '#cf222e', dark: '#ff7b72' },
  { name: '--hljs-property', light: '#0550ae', dark: '#79c0ff' }
]

const ALL_TOKENS = [...PALETTE_TOKENS, ...HLJS_TOKENS]

describe('chat transcript color tokens', () => {
  it('imports the native chat coloring stylesheet', () => {
    expect(mainCss).toContain("@import './fork-native-chat-coloring.css';")
  })

  it('binds all 8 palette tokens through @theme inline', () => {
    const themeInline = getCssBlockBody(coloringCss, '@theme inline')

    for (const token of PALETTE_TOKENS) {
      expect(themeInline).toContain(`--color-${token.name.slice(2)}: var(${token.name});`)
    }
  })

  it('never binds an hljs token through @theme inline', () => {
    const themeInline = getCssBlockBody(coloringCss, '@theme inline')

    expect(themeInline).not.toContain('hljs')
  })

  it.each(ALL_TOKENS)('declares $name in :root (light) and .dark with locked values', (token) => {
    const root = getCssBlockBody(coloringCss, ':root')
    const dark = getCssBlockBody(coloringCss, '.dark')

    expect(root).toContain(`${token.name}: ${token.light};`)
    expect(dark).toContain(`${token.name}: ${token.dark};`)
  })

  it('declares --code-accent-surface and --chat-user-surface as color-mix expressions in both themes', () => {
    const root = getCssBlockBody(coloringCss, ':root')
    const dark = getCssBlockBody(coloringCss, '.dark')

    for (const block of [root, dark]) {
      expect(block).toContain(`--code-accent-surface: ${CODE_ACCENT_SURFACE_EXPR};`)
      expect(block).toContain(`--chat-user-surface: ${CHAT_USER_SURFACE_EXPR};`)
    }
  })

  it('keeps every --quirky-security-* token a literal hex copy of the matching core token', () => {
    const SECURITY_ROLES = [
      'background',
      'foreground',
      'card',
      'card-foreground',
      'popover',
      'popover-foreground',
      'primary',
      'primary-foreground',
      'secondary',
      'secondary-foreground',
      'muted',
      'muted-foreground',
      'accent',
      'accent-foreground',
      'border',
      'input',
      'ring'
    ]
    for (const selector of [':root', '.dark']) {
      const block = getCssBlockBody(mainCss, selector)
      const read = (name: string): string | undefined =>
        block.match(new RegExp(`^  ${name}: ([^;]+);`, 'm'))?.[1]
      for (const role of SECURITY_ROLES) {
        const security = read(`--quirky-security-${role}`)
        expect(security, `${selector} --quirky-security-${role}`).toMatch(/^#[0-9a-f]{6}$/)
        expect(security, `${selector} --quirky-security-${role}`).toBe(read(`--${role}`))
      }
    }
  })

  it.each([
    [':root', '#f6f7f9', '#eceef2', '#1f9d63', '#d6455d'],
    ['.dark', '#101114', '#1b1c21', '#4cc38a', '#ef6b73']
  ])(
    'defines the code and agent outcome tokens in %s',
    (selector, codeBg, codeHeader, done, failed) => {
      const block = getCssBlockBody(mainCss, selector)
      expect(block).toContain(`--code-background: ${codeBg};`)
      expect(block).toContain(`--code-header: ${codeHeader};`)
      expect(block).toContain(`--agent-done: ${done};`)
      expect(block).toContain(`--agent-failed: ${failed};`)
      expect(block).toContain('--workspace-status-progress: var(--agent-working);')
    }
  )

  it('exposes the new tokens as Tailwind colors', () => {
    const themeInline = getCssBlockBody(mainCss, '@theme inline')
    for (const name of ['agent-done', 'agent-failed', 'code-background', 'code-header']) {
      expect(themeInline).toContain(`--color-${name}: var(--${name});`)
    }
  })

  it('declares the browser color scheme for each mode', () => {
    expect(getCssBlockBody(mainCss, ':root')).toContain('color-scheme: light;')
    expect(getCssBlockBody(mainCss, '.dark')).toContain('color-scheme: dark;')
  })

  it('does not add any of the 27 new tokens to .plugin-security-chrome', () => {
    const pluginSecurityChrome = getCssBlockBody(mainCss, '.plugin-security-chrome')

    for (const token of ALL_TOKENS) {
      expect(pluginSecurityChrome).not.toContain(token.name)
    }
  })
})
