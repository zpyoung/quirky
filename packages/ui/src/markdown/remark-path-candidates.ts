import type { InlineCode, Parent, PhrasingContent, Root, Text } from 'mdast'

/**
 * A relative path with at least one `/` and a file extension, optionally followed by `:line` or
 * `:line:col`, and not part of a URL or an email address. Group 1 is the path, 2 the line, 3 the column.
 */
export const PATH_CANDIDATE = /(?<![\w@/.:-])((?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8})(?::(\d+)(?::(\d+))?)?(?![\w/])/g

const WHOLE_PATH_CANDIDATE = new RegExp(`^${PATH_CANDIDATE.source}$`)

/** True when `content` is nothing but one path candidate, which is what makes inline code a chip. */
export function isPathCandidate(content: string): boolean {
  return WHOLE_PATH_CANDIDATE.test(content)
}

/** Splits a written candidate into its path and optional line, as `openFile` wants them. */
export function splitPathCandidate(candidate: string): { path: string; line?: number } {
  const match = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(candidate)
  const path = match?.[1] ?? candidate
  return match?.[2] ? { path, line: Number(match[2]) } : { path }
}

function withoutFencedCode(markdown: string): string {
  const kept: string[] = []
  let marker: string | null = null
  for (const line of markdown.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker === null) {
      if (fence) marker = fence[1]
      else kept.push(line)
    } else if (fence && fence[1][0] === marker[0] && fence[1].length >= marker.length && line.trim() === fence[1]) marker = null
  }
  return kept.join('\n')
}

/** Every distinct candidate written in `markdown` outside fenced code, link labels and link targets, in the order first seen. */
export function collectPathCandidates(markdown: string): string[] {
  const found = new Set<string>()
  const prose = withoutFencedCode(markdown).replace(/\[[^\]\n]*\]\([^)\n]*\)/g, '')
  for (const match of prose.matchAll(PATH_CANDIDATE)) found.add(match[0])
  return [...found]
}

const SKIPPED_PARENTS = new Set(['link', 'linkReference', 'definition', 'footnoteDefinition'])

function split(node: Text): PhrasingContent[] | null {
  const parts: PhrasingContent[] = []
  let cursor = 0
  for (const match of node.value.matchAll(PATH_CANDIDATE)) {
    const start = match.index ?? 0
    if (start > cursor) parts.push({ type: 'text', value: node.value.slice(cursor, start) })
    const chip: InlineCode = { type: 'inlineCode', value: match[0], data: { hProperties: { 'data-path-candidate': match[0] } } }
    parts.push(chip)
    cursor = start + match[0].length
  }
  if (parts.length === 0) return null
  if (cursor < node.value.length) parts.push({ type: 'text', value: node.value.slice(cursor) })
  return parts
}

function walk(parent: Parent) {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index]
    if (child.type === 'text') {
      const parts = split(child)
      if (parts) {
        parent.children.splice(index, 1, ...(parts as never[]))
        index += parts.length - 1
      }
    } else if ('children' in child && !SKIPPED_PARENTS.has(child.type)) walk(child as Parent)
  }
}

/** Marks path-shaped words in prose as inline code carrying `data-path-candidate`, never inside code or links. */
export function remarkPathCandidates() {
  return (tree: Root) => walk(tree)
}
