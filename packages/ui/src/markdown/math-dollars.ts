import type { Parent, Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import remarkGfm from 'remark-gfm'

type ParserData = { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] }

/** The syntax extensions the renderer's remark-gfm adds, collected by letting the plugin register itself on a stand-in processor. */
const GFM_DATA: ParserData = {}
;(remarkGfm as unknown as (this: { data: () => ParserData }) => void).call({ data: () => GFM_DATA })

const NOT_TEXT = -1

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char)
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

/**
 * For each source offset, the id of the inline parent whose `text` node covers it, or `NOT_TEXT`.
 * The source is parsed without math, so code, inline code, link and image destinations and titles,
 * definitions and html are never text and their characters are never touched.
 */
function textOwners(source: string): Int32Array {
  const owners = new Int32Array(source.length).fill(NOT_TEXT)
  const tree = fromMarkdown(source, {
    extensions: GFM_DATA.micromarkExtensions as never,
    mdastExtensions: GFM_DATA.fromMarkdownExtensions as never
  }) as Root
  let nextOwner = 0
  const walk = (parent: Parent) => {
    const owner = nextOwner++
    for (const child of parent.children) {
      if (child.type === 'text') {
        const from = child.position?.start.offset
        const to = child.position?.end.offset
        if (from !== undefined && to !== undefined) owners.fill(owner, from, to)
      } else if ('children' in child) walk(child as Parent)
    }
  }
  walk(tree)
  return owners
}

/** Length of the run of dollars at `index` that all belong to `owner`. */
function dollarRun(source: string, owners: Int32Array, index: number, owner: number): number {
  let run = 1
  while (source[index + run] === '$' && owners[index + run] === owner) run += 1
  return run
}

/** Offset of the next occurrence of `needle` at or after `from` that starts in text owned by `owner` (any owner when null), or -1. */
function findText(source: string, owners: Int32Array, needle: string, from: number, owner: number | null): number {
  for (let at = source.indexOf(needle, from); at !== -1; at = source.indexOf(needle, at + 1)) {
    const found = owners[at]
    if (owner === null ? found !== NOT_TEXT : found === owner) return at
  }
  return -1
}

/** Finds the next unescaped single dollar in text owned by `owner` that is not part of a longer run. */
function findCloser(source: string, owners: Int32Array, from: number, owner: number): number {
  let index = from
  while (index < source.length) {
    if (owners[index] !== owner) {
      index += 1
      continue
    }
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '$') {
      const run = dollarRun(source, owners, index, owner)
      if (run === 1) return index
      index += run
      continue
    }
    index += 1
  }
  return -1
}

/** Rewrites `\(…\)` and `\[…\]` to dollar math of the same length, or returns null when the pair is not math. */
function rewriteEscapedDelimiter(source: string, owners: Int32Array, index: number, owner: number): { text: string; next: number } | null {
  const inline = source[index + 1] === '('
  const end = findText(source, owners, inline ? '\\)' : '\\]', index + 2, owner)
  if (end === -1) return null
  const inner = source.slice(index + 2, end)
  const core = inner.trim()
  if (core === '' || /(?:^|[^\\])\$/.test(core)) return null
  if (!inline) return { text: `$$${inner}$$`, next: end + 2 }
  const lead = inner.length - inner.trimStart().length
  const trail = inner.length - inner.trimEnd().length
  return { text: ` ${inner.slice(0, lead)}$${core}$${inner.slice(inner.length - trail)} `, next: end + 2 }
}

/**
 * Prepares `source` for remark-math with single-dollar math on, without moving any character.
 * Eligibility comes from the parser: the source is parsed once without math and only characters in
 * `text` nodes may change. A single `$…$` pair survives only when no whitespace follows the opening
 * dollar or precedes the closing one and no digit follows the closing one, so prices stay text; every
 * other loose dollar becomes `mask`, which the caller swaps back after parsing. A pair may span
 * non-text siblings (`$a*b*c$`) but both ends must be text of the same inline parent, which keeps it
 * inside one paragraph; `\(…\)` and `\[…\]` pair the same way and become math of the same length.
 * `$$…$$` pairs with the next `$$` in any text, because display math may span blocks.
 */
export function maskLooseDollars(source: string, mask: string): string {
  const owners = textOwners(source)
  let out = ''
  let index = 0
  while (index < source.length) {
    const owner = owners[index]
    const char = source[index]
    if (owner === NOT_TEXT) {
      out += char
      index += 1
      continue
    }
    if (char === '\\') {
      const next = source[index + 1]
      if ((next === '(' || next === '[') && owners[index + 1] === owner) {
        const rewritten = rewriteEscapedDelimiter(source, owners, index, owner)
        if (rewritten) {
          out += rewritten.text
          index = rewritten.next
          continue
        }
      }
      const take = next !== undefined && owners[index + 1] === owner ? 2 : 1
      out += source.slice(index, index + take)
      index += take
      continue
    }
    if (char === '$') {
      const run = dollarRun(source, owners, index, owner)
      if (run >= 2) {
        const delimiter = '$'.repeat(run)
        const end = findText(source, owners, delimiter, index + run, null)
        if (end !== -1) {
          out += source.slice(index, end + run)
          index = end + run
          continue
        }
        out += mask.repeat(run)
        index += run
        continue
      }
      const closer = isWhitespace(source[index + 1]) || index + 1 >= source.length ? -1 : findCloser(source, owners, index + 1, owner)
      const tight = closer > index + 1 && !isWhitespace(source[closer - 1]) && !isDigit(source[closer + 1])
      if (tight) {
        out += source.slice(index, closer + 1)
        index = closer + 1
        continue
      }
      out += mask
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out
}
