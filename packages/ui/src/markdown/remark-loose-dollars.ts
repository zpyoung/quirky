import type { Root } from 'mdast'
import { visit } from 'unist-util-visit'
import { maskLooseDollars } from './math-dollars'
import type { SourceSpan } from './math-dollars'

type Reparser = { parse(value: string): object }

const CODE_NODES = new Set(['code', 'inlineCode', 'html'])
const MASK_CANDIDATES = ['', '', '', '']

function unmask(value: unknown, mask: string): void {
  if (Array.isArray(value)) {
    for (const item of value) unmask(item, mask)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key === 'position') continue
    const field = record[key]
    if (typeof field === 'string') {
      if (field.includes(mask)) record[key] = field.replaceAll(mask, '$')
    } else unmask(field, mask)
  }
}

/**
 * Keeps prices and stray dollars as text under single-dollar remark-math without moving a single
 * source offset, so every mdast position still maps to the original text. It masks loose dollars
 * and `\(…\)` / `\[…\]` pairs in the source with same-length stand-ins, re-parses, and swaps the
 * stand-ins back. Must be the first remark plugin, because it replaces the tree it is given.
 */
export function remarkLooseDollars(this: Reparser) {
  const reparser = this
  return (tree: Root, file: { value: unknown }): Root | undefined => {
    const source = String(file.value)
    if (!source.includes('$') && !source.includes('\\(') && !source.includes('\\[')) return undefined
    const mask = MASK_CANDIDATES.find((candidate) => !source.includes(candidate))
    if (mask === undefined) return undefined
    const spans: SourceSpan[] = []
    visit(tree, (node) => {
      const from = node.position?.start.offset
      const to = node.position?.end.offset
      if (CODE_NODES.has(node.type) && from !== undefined && to !== undefined) spans.push([from, to])
    })
    const masked = maskLooseDollars(source, spans, mask)
    if (masked === source) return undefined
    const next = reparser.parse(masked) as Root
    unmask(next, mask)
    return next
  }
}
