import type { Code, Parent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { ChartSources } from './runtime'

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

type Fence = { language: string; meta: string; code: string; closed: boolean }

const QUOTE_MARKER = /^ {0,3}> ?/
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)]) +(?=\S)/

type OpenFence = { marker: string; language: string; meta: string; lines: string[]; quotes: number; column: number }

const closeFence = (open: OpenFence, closed: boolean): Fence => ({ language: open.language, meta: open.meta, code: open.lines.join('\n'), closed })

/** Strips up to `limit` blockquote markers from a line and says how many it removed. */
function stripQuotes(line: string, limit: number): { text: string; quotes: number } {
  let text = line
  let quotes = 0
  while (quotes < limit) {
    const marker = QUOTE_MARKER.exec(text)
    if (!marker) break
    text = text.slice(marker[0].length)
    quotes++
  }
  return { text, quotes }
}

const leadingSpaces = (line: string) => line.length - line.trimStart().length

/** Fences in blockquotes and list items are found with their container markers and indentation removed. */
function* fences(markdown: string): Generator<Fence> {
  let open: OpenFence | null = null
  let listColumn = 0
  for (const raw of markdown.split('\n')) {
    if (open !== null) {
      const { text, quotes } = stripQuotes(raw, open.quotes)
      const blank = text.trim() === ''
      if (quotes === open.quotes && (blank || leadingSpaces(text) >= open.column)) {
        const line = blank ? '' : text.slice(open.column)
        const match = FENCE.exec(line)
        if (match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length && match[2].trim() === '') {
          yield closeFence(open, true)
          open = null
        } else open.lines.push(line)
        continue
      }
      // the container the fence sat in has ended, which ends the fence with it
      yield closeFence(open, true)
      open = null
    }
    let { text, quotes } = stripQuotes(raw, Infinity)
    if (text.trim() !== '') {
      if (leadingSpaces(text) < listColumn) listColumn = 0
      else text = text.slice(listColumn)
    }
    for (let marker = LIST_MARKER.exec(text.trimStart()); marker !== null && leadingSpaces(text) <= 3; marker = LIST_MARKER.exec(text.trimStart())) {
      const consumed = leadingSpaces(text) + marker[0].length
      listColumn += consumed
      text = text.slice(consumed)
    }
    const match = FENCE.exec(text)
    if (!match) continue
    const info = match[2].trim()
    const space = info.search(/\s/)
    open = { marker: match[1], language: (space < 0 ? info : info.slice(0, space)).toLowerCase(), meta: space < 0 ? '' : info.slice(space + 1).trim(), lines: [], quotes, column: listColumn }
  }
  if (open) yield closeFence(open, false)
}

export type OpenFenceAtEnd = { language: string; code: string; extent: number }

function lastCode(node: Parent): Code | null {
  for (let index = node.children.length - 1; index >= 0; index--) {
    const child = node.children[index]
    const found = child.type === 'code' ? child : 'children' in child ? lastCode(child as Parent) : null
    if (found) return found
  }
  return null
}

/**
 * The fenced code block the text ends inside, when it has no closing fence yet, at any blockquote or list
 * nesting. `extent` is the source length from the fence's start to the end of the text, which the rendered
 * block of that fence has too and an earlier, finished block with the same content does not.
 */
export function openFenceAtEnd(markdown: string): OpenFenceAtEnd | null {
  if (!markdown.includes('```') && !markdown.includes('~~~')) return null
  const block = lastCode(fromMarkdown(markdown))
  const { start, end } = block?.position ?? {}
  if (!block || start?.offset === undefined || end?.offset === undefined || end.offset < markdown.trimEnd().length) return null
  // a closed fence spans its content plus an opening and a closing line, an open one only the opening line
  const lines = markdown.slice(start.offset, end.offset).replace(/\n$/, '').split('\n').length
  const contentLines = block.value === '' ? 0 : block.value.split('\n').length
  return lines === contentLines + 1 ? { language: (block.lang ?? '').toLowerCase(), code: block.value, extent: end.offset - start.offset } : null
}

/** True when the text ends inside a fenced code block that has no closing fence yet. */
export function endsInOpenFence(markdown: string): boolean {
  return openFenceAtEnd(markdown) !== null
}

const TITLE = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/

/** The finished csv and tsv fences that carry a `title=`, which `chart` fences name in `from`. */
export function collectChartSources(markdown: string): ChartSources {
  const sources: ChartSources = {}
  if (!markdown.includes('title=')) return sources
  for (const fence of fences(markdown)) {
    if (!fence.closed || (fence.language !== 'csv' && fence.language !== 'tsv')) continue
    const title = TITLE.exec(fence.meta)
    const name = title ? (title[1] ?? title[2] ?? title[3]) : undefined
    if (name) sources[name] = { language: fence.language, code: fence.code }
  }
  return sources
}

const IMAGE_START = /!\[[^\]\n]*\]\(/g

/** The destination of an inline link starting at `from` (just past the opening paren), CommonMark style: `<...>` or balanced parentheses, then an optional title. */
function inlineDestination(text: string, from: number): string | null {
  let index = from
  while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') index++
  let destination: string
  if (text[index] === '<') {
    const end = text.indexOf('>', index)
    const newline = text.indexOf('\n', index)
    if (end < 0 || (newline >= 0 && newline < end)) return null
    destination = text.slice(index + 1, end)
    index = end + 1
  } else {
    const start = index
    let depth = 0
    while (index < text.length) {
      const char = text[index]
      if (char === '\\' && index + 1 < text.length) index += 2
      else if (char === '(') { depth++; index++ }
      else if (char === ')') { if (depth === 0) break; depth--; index++ }
      else if (char === ' ' || char === '\t' || char === '\n') break
      else index++
    }
    if (depth !== 0) return null
    destination = text.slice(start, index)
  }
  while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') index++
  const quote = text[index]
  if (quote === '"' || quote === "'" || quote === '(') {
    const close = text.indexOf(quote === '(' ? ')' : quote, index + 1)
    if (close < 0) return null
    index = close + 1
    while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') index++
  }
  return text[index] === ')' && destination !== '' ? destination : null
}

function inlineImageSources(prose: string): string[] {
  const sources: string[] = []
  for (const match of prose.matchAll(IMAGE_START)) {
    const destination = inlineDestination(prose, match.index + match[0].length)
    if (destination !== null) sources.push(destination)
  }
  return sources
}

function withoutFencedCode(markdown: string): string {
  const parts: string[] = []
  let marker: string | null = null
  for (const line of markdown.split('\n')) {
    const match = FENCE.exec(line)
    if (marker === null) {
      if (match) marker = match[1]
      else parts.push(line)
    } else if (match && match[1][0] === marker[0] && match[1].length >= marker.length && match[2].trim() === '') marker = null
  }
  return parts.join('\n')
}

const IMAGE_REFERENCE = /!\[((?:[^\]\\\n]|\\.)*)\](?:\[((?:[^\]\\\n]|\\.)*)\])?/g
const DEFINITION = /^ {0,3}\[((?:[^\]\\\n]|\\.)+)\]:[ \t]*(?:<([^<>\n]*)>|(\S+))/

const referenceLabel = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase()

/** The destinations of link reference definitions, keyed by normalised label; the first definition wins, as in CommonMark. */
function referenceDefinitions(prose: string): Map<string, string> {
  const definitions = new Map<string, string>()
  for (const line of prose.split('\n')) {
    const match = DEFINITION.exec(line)
    if (match && !definitions.has(referenceLabel(match[1]))) definitions.set(referenceLabel(match[1]), match[2] ?? match[3])
  }
  return definitions
}

/** The distinct `src` values of markdown images that are neither remote nor data URLs, as written, inline or by reference. */
export function collectLocalImageSources(markdown: string): string[] {
  if (!markdown.includes('![')) return []
  const prose = withoutFencedCode(markdown)
  const sources = inlineImageSources(prose)
  const definitions = referenceDefinitions(prose)
  if (definitions.size > 0) {
    for (const match of prose.matchAll(IMAGE_REFERENCE)) {
      const target = definitions.get(referenceLabel(match[2] === undefined || match[2].trim() === '' ? match[1] : match[2]))
      if (target !== undefined) sources.push(target)
    }
  }
  return [...new Set(sources.filter((src) => src !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)))]
}
