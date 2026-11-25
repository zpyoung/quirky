import type { Root } from 'mdast'
import type { Processor } from 'unified'
import { maskLooseDollars } from './math-dollars'

const MASK_CANDIDATES = ['\uE000', '\uE001', '\uE002', '\uE003']

function unmask(value: unknown, mask: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      unmask(item, mask)
    }
    return
  }
  if (typeof value !== 'object' || value === null) {
    return
  }
  for (const [key, field] of Object.entries(value)) {
    if (key === 'position') {
      continue
    }
    if (typeof field === 'string') {
      if (field.includes(mask)) {
        Reflect.set(value, key, field.replaceAll(mask, '$'))
      }
    } else {
      unmask(field, mask)
    }
  }
}

/**
 * Keeps prices and stray dollars as text under single-dollar remark-math without moving a single
 * source offset, so every mdast position still maps to the original text. It masks loose dollars
 * and `\(…\)` / `\[…\]` pairs in the source with same-length stand-ins, re-parses, and swaps the
 * stand-ins back. Which characters may change is decided from a math-free parse of the source.
 * Must be the first remark plugin, because it replaces the tree it is given.
 */
export function remarkLooseDollars(this: Processor) {
  return (_tree: Root, file: { value: unknown }): ReturnType<Processor['parse']> | undefined => {
    const source = String(file.value)
    if (!source.includes('$') && !source.includes('\\(') && !source.includes('\\[')) {
      return undefined
    }
    const mask = MASK_CANDIDATES.find((candidate) => !source.includes(candidate))
    if (mask === undefined) {
      return undefined
    }
    const masked = maskLooseDollars(source, mask)
    if (masked === source) {
      return undefined
    }
    const next = this.parse(masked)
    unmask(next, mask)
    return next
  }
}
