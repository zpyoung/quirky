import type { Editor } from '@tiptap/core'
import { createHeadlessMarkdownEditor } from './tiptap'
export const RICH_MARKDOWN_MAX_BYTES = 600 * 1024
export const RICH_MARKDOWN_OVERRIDE_MAX_BYTES = 1024 * 1024
export const MARKDOWN_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
export const MARKDOWN_SEARCH_MAX_BYTES = 16 * 1024 * 1024
export const MARKDOWN_MAX_SEARCH_MATCHES = 10_000
export const MARKDOWN_MAX_DOCUMENTS = 20_000
export const MARKDOWN_MAX_DOCUMENTS_BYTES = 8 * 1024 * 1024
export const MARKDOWN_MAX_PATH_BYTES = 64 * 1024
export const MARKDOWN_MAX_TEMPLATES = 100
export const MARKDOWN_MAX_TEMPLATE_DEPTH = 8
export const MARKDOWN_MAX_TEMPLATE_BYTES = 256 * 1024
export const MARKDOWN_MAX_IMAGE_BYTES = 24 * 1024 * 1024
export const MARKDOWN_MAX_IMAGE_PIXELS = 32 * 1024 * 1024
export const MARKDOWN_MAX_NOTE_BODY_BYTES = 16 * 1024
export const MARKDOWN_MAX_NOTE_SELECTION_BYTES = 32 * 1024
export const MARKDOWN_MAX_NOTES_SOURCE_BYTES = MARKDOWN_PREVIEW_MAX_BYTES

export type FrontMatter = { prefix: string; body: string; lineCount: number }

export function splitFrontMatter(source: string): FrontMatter {
  const match = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1(?:\r?\n|$)/.exec(source)
  if (!match) return { prefix: '', body: source, lineCount: 0 }
  return {
    prefix: match[0],
    body: source.slice(match[0].length),
    lineCount: (match[0].match(/\n/g) ?? []).length
  }
}

export function sourceWithFrontMatter(source: string, body: string): string {
  return `${splitFrontMatter(source).prefix}${body}`
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export function sourceLineAtOffset(text: string, offset: number): number {
  const bounded = Math.max(0, Math.min(offset, text.length))
  let line = 1
  for (let i = 0; i < bounded; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

export type MarkdownHeading = { level: number; text: string; id: string; line: number; from: number; to: number }

function headingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/(`+)(.*?)\1/g, '$2')
    .replace(/[\\*_~]/g, '')
    .trim()
}

export function slugHeading(text: string): string {
  return headingText(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

export function extractHeadings(source: string): MarkdownHeading[] {
  const { body, lineCount } = splitFrontMatter(source)
  const lines = body.split(/\r?\n/)
  const starts = lineStarts(body)
  const counts = new Map<string, number>()
  const headings: MarkdownHeading[] = []
  let fenced: { char: string; length: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!fenced) fenced = { char: marker[0]!, length: marker.length }
      else if (marker[0] === fenced.char && marker.length >= fenced.length) fenced = null
      continue
    }
    if (fenced) continue
    const atx = /^ {0,3}(#{1,5})(?:\s+|$)(.*?)\s*$/.exec(line)
    let level: number | null = atx ? atx[1]!.length : null
    let raw = atx?.[2] ?? ''
    if (level === null && index + 1 < lines.length) {
      const setext = /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1] ?? '')
      if (setext && line.trim() !== '') {
        level = setext[1]![0] === '=' ? 1 : 2
        raw = line.trim()
      }
    }
    if (level === null) continue
    const text = headingText(raw)
    const slug = slugHeading(text)
    const count = counts.get(slug) ?? 0
    counts.set(slug, count + 1)
    headings.push({
      level,
      text,
      id: count === 0 ? slug : `${slug}-${count}`,
      line: lineCount + index + 1,
      from: starts[index] ?? 0,
      to: (starts[index] ?? 0) + line.length
    })
  }
  return headings
}

export type SearchMatch = { from: number; to: number; line: number; column: number; text: string }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function searchMarkdown(
  source: string,
  query: string,
  options: { matchCase?: boolean; wholeWord?: boolean; limit?: number } = {}
): { matches: SearchMatch[]; total: number; truncated: boolean } {
  if (query === '' || utf8Bytes(source) > MARKDOWN_SEARCH_MAX_BYTES || utf8Bytes(query) > 2048) {
    return { matches: [], total: 0, truncated: false }
  }
  const { prefix, body, lineCount } = splitFrontMatter(source)
  const flags = options.matchCase ? 'g' : 'gi'
  const core = escapeRegExp(query)
  const expression = new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}_])${core}(?![\\p{L}\\p{N}_])` : core, `${flags}u`)
  const limit = Math.max(1, Math.min(options.limit ?? MARKDOWN_MAX_SEARCH_MATCHES, MARKDOWN_MAX_SEARCH_MATCHES))
  const matches: SearchMatch[] = []
  let total = 0
  let match: RegExpExecArray | null
  while ((match = expression.exec(body)) !== null) {
    total += 1
    if (matches.length < limit) {
      const offset = match.index
      const lineStart = body.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
      const lineEndAt = body.indexOf('\n', offset)
      const lineEnd = lineEndAt === -1 ? body.length : lineEndAt
      matches.push({
        from: prefix.length + offset,
        to: prefix.length + offset + match[0].length,
        line: lineCount + sourceLineAtOffset(body, offset),
        column: offset - lineStart + 1,
        text: body.slice(lineStart, lineEnd)
      })
    }
    if (match[0] === '') expression.lastIndex += 1
  }
  return { matches, total, truncated: total > limit }
}

function withoutCode(text: string): string {
  const lines = text.split(/\r?\n/)
  let fence: { char: string; length: number } | null = null
  const output: string[] = []
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = { char: marker[0]!, length: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null
      output.push('')
      continue
    }
    output.push(fence ? '' : line.replace(/(`+)(.*?)\1/g, ''))
  }
  return output.join('\n')
}

function hasMarkdownToggleNode(markdown: string): boolean | null {
  let editor: Editor | null = null
  try {
    editor = createHeadlessMarkdownEditor(markdown)
    let found = false
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'markdownToggle') found = true
    })
    return found
  } catch {
    return null
  } finally {
    editor?.destroy()
  }
}

export type RichEligibility = { eligible: boolean; reason: string | null; bytes: number; openAnywayAvailable: boolean }

export function richEligibility(
  source: string,
  relativePath: string,
  openAnyway = false
): RichEligibility {
  const bytes = utf8Bytes(source)
  const openAnywayAvailable = bytes <= RICH_MARKDOWN_OVERRIDE_MAX_BYTES
  const ext = relativePath.toLowerCase().split('.').at(-1) ?? ''
  if (!['md', 'markdown', 'mdx'].includes(ext)) return { eligible: false, reason: 'This file is not a Markdown document.', bytes, openAnywayAvailable: false }
  if (ext === 'mdx') return { eligible: false, reason: 'Editable only in source mode because this file contains MDX.', bytes, openAnywayAvailable }
  const { body } = splitFrontMatter(source)
  const outsideCode = withoutCode(body)
  if (/^\s*\[\^[^\]\r\n]+\]:\s+/m.test(outsideCode)) {
    return { eligible: false, reason: 'Editable only in source mode because this file contains footnotes.', bytes, openAnywayAvailable }
  }
  if (/^\s*\[[^\]\r\n]+\]:\s*\S+/m.test(outsideCode)) {
    return { eligible: false, reason: 'Editable only in source mode because this file contains reference-style links.', bytes, openAnywayAvailable }
  }
  if (bytes > RICH_MARKDOWN_MAX_BYTES && !(openAnyway && openAnywayAvailable)) {
    return {
      eligible: false,
      reason: `File is larger than the ${RICH_MARKDOWN_MAX_BYTES} byte rich editing limit.`,
      bytes,
      openAnywayAvailable
    }
  }
  if (/<details(?:\s|>)/i.test(outsideCode)) {
    const hasDetails = hasMarkdownToggleNode(body)
    if (hasDetails === null) {
      return { eligible: false, reason: 'This Markdown could not be parsed safely. Open source mode to edit it.', bytes, openAnywayAvailable }
    }
    if (hasDetails) return { eligible: false, reason: 'Editable only in source mode because this file contains HTML or JSX.', bytes, openAnywayAvailable }
  }
  if (/<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/.test(outsideCode)) {
    return { eligible: false, reason: 'Editable only in source mode because this file contains HTML or JSX.', bytes, openAnywayAvailable }
  }
  return { eligible: true, reason: null, bytes, openAnywayAvailable }
}

export function previewEligibility(source: string): { available: boolean; bytes: number; reason: string | null } {
  const bytes = utf8Bytes(source)
  return bytes <= MARKDOWN_PREVIEW_MAX_BYTES
    ? { available: true, bytes, reason: null }
    : { available: false, bytes, reason: `File is larger than the ${MARKDOWN_PREVIEW_MAX_BYTES} byte preview limit.` }
}
