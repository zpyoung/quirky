#!/usr/bin/env bun
/**
 * Regenerates the committed icon sets under `packages/ui/src/design-system/icons/`:
 * `generated-tools.ts` (Phosphor Duotone), `generated-controls.ts` (Phosphor Regular) and
 * `generated-files.ts` (the vendored Catppuccin Mocha and Latte SVGs). Run it by hand with
 * `bun scripts/gen-icons.ts` after changing a name list or the pinned sources. Only named icons are
 * emitted, so plugin bundles do not carry the full sets.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const iconsDirectory = join(root, 'packages/ui/src/design-system/icons')
const phosphorAssets = join(root, 'node_modules/@phosphor-icons/core/assets')

export const TOOL_ICON_NAMES = [
  'git-branch', 'tray', 'list-checks', 'robot', 'flow-arrow', 'device-mobile', 'git-diff', 'folders',
  'check-circle', 'chat-circle-dots', 'git-pull-request', 'info', 'vault', 'book-open-text',
  'terminal-window', 'command', 'warning-circle', 'hard-drives', 'pulse', 'gauge', 'sidebar', 'squares-four'
] as const

export const CONTROL_ICON_NAMES = [
  'plus', 'magnifying-glass', 'dots-three', 'dots-three-vertical', 'minus', 'caret-down', 'caret-left',
  'caret-right', 'arrows-clockwise', 'funnel', 'export', 'x', 'arrows-out', 'arrows-in', 'check', 'gear', 'globe', 'squares-four'
] as const

export const FILE_ICON_NAMES = [
  'file', 'typescript', 'typescript-react', 'typescript-def', 'typescript-config', 'javascript', 'javascript-react',
  'json', 'markdown', 'css', 'html', 'bash', 'powershell', 'python', 'rust', 'go', 'go-mod', 'yaml', 'toml',
  'database', 'image', 'svg', 'lock', 'bun-lock', 'npm-lock', 'pnpm-lock', 'yarn-lock', 'cargo-lock', 'cargo',
  'package-json', 'npm', 'bun', 'docker', 'docker-compose', 'git', 'env', 'text', 'readme', 'license', 'makefile',
  'xml', 'csv', 'pdf', 'zip', 'config', 'editorconfig', 'eslint', 'prettier', 'vite', 'tailwind', 'log', 'audio', 'video'
] as const

const FLAVORS = ['mocha', 'latte'] as const

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set(['svg', 'g', 'path'])
const UNSAFE: readonly [pattern: RegExp, reason: string][] = [
  [/<[!?]/, 'a declaration'],
  [/[\s"'/]on[a-z]+\s*=/i, 'an event attribute'],
  [/javascript\s*:/i, 'a javascript: URL'],
  [/url\(\s*['"]?(?!#)/i, 'an external url()'],
  [/&/, 'a character reference, which could spell any of the above']
]
const ELEMENT = /<\s*([^\s/>]+)/g
const HREF = /(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

/**
 * Throws, naming `file`, when `svg` could run code or fetch anything: any element other than svg, g
 * and path, a declaration, an `on*` event attribute, or an `href` or `url()` that leaves the document.
 */
export function assertSafeSvg(file: string, svg: string): void {
  for (const [, element] of svg.matchAll(ELEMENT)) {
    if (!ALLOWED_ELEMENTS.has(element!)) throw new Error(`${file}: rejected SVG containing a ${element} element`)
  }
  for (const [pattern, reason] of UNSAFE) {
    if (pattern.test(svg)) throw new Error(`${file}: rejected SVG containing ${reason}`)
  }
  for (const match of svg.matchAll(HREF)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!target.startsWith('#')) throw new Error(`${file}: rejected SVG containing an external href "${target}"`)
  }
}

function innerMarkup(file: string, svg: string, viewBox: string): string {
  assertSafeSvg(file, svg)
  const open = svg.match(/<svg\b[^>]*>/i)
  const close = svg.lastIndexOf('</svg>')
  if (!open || open.index === undefined || close < 0) throw new Error(`${file}: not an SVG document`)
  if (!open[0].includes(`viewBox="${viewBox}"`)) throw new Error(`${file}: expected viewBox ${viewBox}`)
  return svg
    .slice(open.index + open[0].length, close)
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .replace(/ \/>/g, '/>')
    .trim()
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

const quote = (name: string) => `'${name}'`
const list = (names: readonly string[]) => `[${names.map(quote).join(', ')}] as const`
const entries = (markup: Record<string, string>, indent: string) =>
  Object.entries(markup).map(([name, value]) => `${indent}${quote(name)}: ${JSON.stringify(value)},`).join('\n')

function phosphor(names: readonly string[], weight: 'duotone' | 'regular'): Record<string, string> {
  return Object.fromEntries(names.map((name) => {
    const file = join(phosphorAssets, weight, weight === 'regular' ? `${name}.svg` : `${name}-${weight}.svg`)
    return [name, innerMarkup(file, read(file), '0 0 256 256')]
  }))
}

function catppuccin(flavor: (typeof FLAVORS)[number]): Record<string, string> {
  return Object.fromEntries(FILE_ICON_NAMES.map((name) => {
    const file = join(iconsDirectory, 'catppuccin', flavor, `${name === 'file' ? '_file' : name}.svg`)
    return [name, innerMarkup(file, read(file), '0 0 16 16')]
  }))
}

const HEADER = '// Generated by scripts/gen-icons.ts. Do not edit; run `bun scripts/gen-icons.ts`.\n'

function phosphorModule(prefix: string, type: string, weight: string, names: readonly string[], markup: Record<string, string>): string {
  return `${HEADER}// Phosphor ${weight} (MIT), viewBox 0 0 256 256, inner SVG markup only.
export const ${prefix}_ICON_NAMES = ${list(names)}
export type ${type} = (typeof ${prefix}_ICON_NAMES)[number]
export const ${prefix}_ICON_MARKUP: Record<${type}, string> = {
${entries(markup, '  ')}
}
`
}

/** The text of every generated file, keyed by file name, from the pinned sources on disk. */
export function generateIcons(): Record<string, string> {
  const files = Object.fromEntries(FLAVORS.map((flavor) => [flavor, catppuccin(flavor)]))
  return {
    'generated-tools.ts': phosphorModule('TOOL', 'GeneratedToolIconName', 'Duotone', TOOL_ICON_NAMES, phosphor(TOOL_ICON_NAMES, 'duotone')),
    'generated-controls.ts': phosphorModule('CONTROL', 'GeneratedControlIconName', 'Regular', CONTROL_ICON_NAMES, phosphor(CONTROL_ICON_NAMES, 'regular')),
    'generated-files.ts': `${HEADER}// Catppuccin Mocha and Latte (MIT), viewBox 0 0 16 16, inner SVG markup only.
export const FILE_ICON_NAMES = ${list(FILE_ICON_NAMES)}
export type GeneratedFileIconName = (typeof FILE_ICON_NAMES)[number]
export const FILE_ICON_MARKUP: Record<'mocha' | 'latte', Record<GeneratedFileIconName, string>> = {
${FLAVORS.map((flavor) => `  ${flavor}: {\n${entries(files[flavor]!, '    ')}\n  },`).join('\n')}
}
`
  }
}

if (import.meta.main) {
  for (const [file, text] of Object.entries(generateIcons())) writeFileSync(join(iconsDirectory, file), text)
}
