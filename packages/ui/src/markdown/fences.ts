import type { ChartSources } from './runtime'

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

type Fence = { language: string; meta: string; code: string; closed: boolean }

function* fences(markdown: string): Generator<Fence> {
  let open: { marker: string; language: string; meta: string; lines: string[] } | null = null
  for (const line of markdown.split('\n')) {
    const match = FENCE.exec(line)
    if (open === null) {
      if (!match) continue
      const info = match[2].trim()
      const space = info.search(/\s/)
      open = { marker: match[1], language: (space < 0 ? info : info.slice(0, space)).toLowerCase(), meta: space < 0 ? '' : info.slice(space + 1).trim(), lines: [] }
    } else if (match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length && match[2].trim() === '') {
      yield { language: open.language, meta: open.meta, code: open.lines.join('\n'), closed: true }
      open = null
    } else open.lines.push(line)
  }
  if (open) yield { language: open.language, meta: open.meta, code: open.lines.join('\n'), closed: false }
}

/** True when the text ends inside a fenced code block that has no closing fence yet. */
export function endsInOpenFence(markdown: string): boolean {
  let last: Fence | null = null
  for (const fence of fences(markdown)) last = fence
  return last !== null && !last.closed
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

const IMAGE = /!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

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

/** The distinct `src` values of markdown images that are neither remote nor data URLs, as written. */
export function collectLocalImageSources(markdown: string): string[] {
  if (!markdown.includes('![')) return []
  const found = new Set<string>()
  for (const match of withoutFencedCode(markdown).matchAll(IMAGE)) {
    const src = match[1]
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue
    found.add(src)
  }
  return [...found]
}
