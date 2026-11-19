import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadsImages } from '../src/core/mermaid-guard'

const REPO = join(import.meta.dir, '../../..')
const SHARED = readFileSync(join(REPO, 'packages/ui/src/markdown/blocks/mermaid-safety.ts'), 'utf8')
const LOCAL = readFileSync(join(import.meta.dir, '../src/core/mermaid-guard.ts'), 'utf8')

// Compared as text rather than imported: the shared markdown index pulls in the window renderer.
const checkOf = (source: string) => {
  const consts = source.slice(source.indexOf('const ASSET_KEY'), source.indexOf('/** Labels render as SVG text') === -1 ? source.indexOf('/**', source.indexOf('const ASSET_KEY')) : source.indexOf('/** Labels render as SVG text'))
  const start = source.indexOf('export function loadsImages')
  const fn = source.slice(start, source.indexOf('\n}\n', start) + 2)
  return `${consts.trim()}\n${fn}`
}

describe('the daemon mermaid guard', () => {
  test('matches the shared loadsImages in packages/ui exactly', () => {
    expect(checkOf(LOCAL)).toBe(checkOf(SHARED))
  })

  test('refuses sources that make mermaid fetch and accepts a plain flowchart', () => {
    expect(loadsImages('flowchart LR\n  a[Client] --> b[Daemon]')).toBe(false)
    expect(loadsImages('flowchart LR\n  a@{ img: "https://example.com/x.png" }')).toBe(true)
    expect(loadsImages('flowchart LR\n  a["<img src=x>"]')).toBe(true)
    expect(loadsImages('%%{init: {"themeCSS": "x"}}%%\nflowchart LR\n  a --> b')).toBe(true)
  })
})
