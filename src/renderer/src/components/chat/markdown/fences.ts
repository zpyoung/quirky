import type { Code, ImageReference, Parent, Root } from 'mdast'
import { parseMarkdownIntoBlocks } from 'streamdown'
import { parseGfm } from './mdast-parsers'
import type { ChartSources } from './runtime'

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

type Fence = { language: string; meta: string; code: string; closed: boolean }

const QUOTE_MARKER = /^ {0,3}> ?/
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)]) +(?=\S)/

type OpenFence = {
  marker: string
  language: string
  meta: string
  lines: string[]
  quotes: number
  column: number
  indent: number
}

const closeFence = (open: OpenFence, closed: boolean): Fence => ({
  language: open.language,
  meta: open.meta,
  code: open.lines.join('\n'),
  closed
})

/** Strips up to `limit` blockquote markers from a line and says how many it removed. */
function stripQuotes(line: string, limit: number): { text: string; quotes: number } {
  let text = line
  let quotes = 0
  while (quotes < limit) {
    const marker = QUOTE_MARKER.exec(text)
    if (!marker) {
      break
    }
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
        if (
          match &&
          match[1][0] === open.marker[0] &&
          match[1].length >= open.marker.length &&
          match[2].trim() === ''
        ) {
          yield closeFence(open, true)
          open = null
        } else {
          open.lines.push(line.slice(Math.min(open.indent, leadingSpaces(line))))
        }
        continue
      }
      // the container the fence sat in has ended, which ends the fence with it
      yield closeFence(open, true)
      open = null
    }
    let { text, quotes } = stripQuotes(raw, Infinity)
    if (text.trim() !== '') {
      if (leadingSpaces(text) < listColumn) {
        listColumn = 0
      } else {
        text = text.slice(listColumn)
      }
    }
    for (
      let marker = LIST_MARKER.exec(text.trimStart());
      marker !== null && leadingSpaces(text) <= 3;
      marker = LIST_MARKER.exec(text.trimStart())
    ) {
      const consumed = leadingSpaces(text) + marker[0].length
      listColumn += consumed
      text = text.slice(consumed)
    }
    const match = FENCE.exec(text)
    if (!match) {
      continue
    }
    const info = match[2].trim()
    const space = info.search(/\s/)
    open = {
      marker: match[1],
      language: (space < 0 ? info : info.slice(0, space)).toLowerCase(),
      meta: space < 0 ? '' : info.slice(space + 1).trim(),
      lines: [],
      quotes,
      column: listColumn,
      indent: leadingSpaces(text)
    }
  }
  if (open) {
    yield closeFence(open, false)
  }
}

/**
 * Where an open fence sits in the block Streamdown renders it from. Streamdown parses each block on its own,
 * so `start` and `extent` are in that block's coordinates, and the code node of the fence reports the same pair.
 */
export type OpenFenceAtEnd = { language: string; code: string; start: number; extent: number }

function lastCode(node: Root | Parent): Code | null {
  for (let index = node.children.length - 1; index >= 0; index--) {
    const child = node.children[index]
    if (child === undefined) {
      continue
    }
    const found = child.type === 'code' ? child : 'children' in child ? lastCode(child) : null
    if (found) {
      return found
    }
  }
  return null
}

/**
 * The fenced code block the text ends inside, when it has no closing fence yet, at any blockquote or list
 * nesting. It is found in the last block Streamdown splits the text into, because that is the text its
 * code node is parsed from. `start`, `extent`, `language` and `code` together single out that node: an
 * earlier finished fence has the same start or the same length at most, and a closing fence makes its
 * extent differ from an open fence with the same code.
 */
export function openFenceAtEnd(markdown: string): OpenFenceAtEnd | null {
  if (!markdown.includes('```') && !markdown.includes('~~~')) {
    return null
  }
  const blocks = parseMarkdownIntoBlocks(markdown)
  const block = blocks.at(-1) ?? ''
  const node = lastCode(parseGfm(block))
  const { start, end } = node?.position ?? {}
  if (
    !node ||
    start?.offset === undefined ||
    end?.offset === undefined ||
    end.offset < block.trimEnd().length
  ) {
    return null
  }
  // a closed fence spans its content plus an opening and a closing line, an open one only the opening line
  const lines = block.slice(start.offset, end.offset).replace(/\n$/, '').split('\n').length
  const contentLines = node.value === '' ? 0 : node.value.split('\n').length
  if (lines !== contentLines + 1) {
    return null
  }
  return {
    language: (node.lang ?? '').toLowerCase(),
    code: node.value,
    start: start.offset,
    extent: end.offset - start.offset
  }
}

/** True when the text ends inside a fenced code block that has no closing fence yet. */
export function endsInOpenFence(markdown: string): boolean {
  return openFenceAtEnd(markdown) !== null
}

const TITLE = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/

/** The finished csv and tsv fences that carry a `title=`, which `chart` fences name in `from`. */
export function collectChartSources(markdown: string): ChartSources {
  const sources: ChartSources = {}
  if (!markdown.includes('title=')) {
    return sources
  }
  for (const fence of fences(markdown)) {
    if (!fence.closed || (fence.language !== 'csv' && fence.language !== 'tsv')) {
      continue
    }
    const title = TITLE.exec(fence.meta)
    const name = title ? (title[1] ?? title[2] ?? title[3]) : undefined
    if (name) {
      sources[name] = { language: fence.language, code: fence.code }
    }
  }
  return sources
}

const NOT_LOCAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/**
 * The distinct `src` values of markdown images that are neither remote nor data URLs, as the parser reads
 * their destination (escapes and entities resolved, no percent-encoding), inline or through a definition.
 * Code never holds an image because the text is read as a tree.
 */
export function collectLocalImageSources(markdown: string): string[] {
  if (!markdown.includes('![')) {
    return []
  }
  const sources: string[] = []
  const references: ImageReference[] = []
  const definitions = new Map<string, string>()
  const walk = (node: Root | Parent) => {
    for (const child of node.children) {
      if (child.type === 'image') {
        sources.push(child.url)
      } else if (child.type === 'imageReference') {
        references.push(child)
      } else if (child.type === 'definition') {
        if (!definitions.has(child.identifier)) {
          definitions.set(child.identifier, child.url)
        }
      }
      if ('children' in child) {
        walk(child)
      }
    }
  }
  walk(parseGfm(markdown))
  for (const reference of references) {
    const target = definitions.get(reference.identifier)
    if (target !== undefined) {
      sources.push(target)
    }
  }
  return [...new Set(sources.filter((src) => src !== '' && !NOT_LOCAL.test(src)))]
}
