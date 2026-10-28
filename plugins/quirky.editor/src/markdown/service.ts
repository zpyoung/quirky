import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, posix } from 'node:path'
import type { PluginCaller } from '@quirky/protocol'
import type { EditorBuffer, EditorServices, FeatureMethods } from '../types'
import { createMarkdownNotesMethod, createWorkspaceNotesMethod } from './notes'
import { extractSelectedCode, formatMarkdownSelection, insertMarkdown, isSafeMarkdownLink, type MarkdownFormat, type MarkdownSelection } from './operations'
import { choosePdfDestination, exportPdfWithChrome } from './pdf'
import { confirmNativeReplacement, chooseMarkdownImage } from './native'
import { renderSafeMarkdownHtml } from './preview'
import { reconcileSerializedMarkdown } from './reconcile'

import {
  MARKDOWN_MAX_IMAGE_BYTES,
  MARKDOWN_MAX_IMAGE_PIXELS,
  MARKDOWN_MAX_SEARCH_MATCHES,
  MARKDOWN_MAX_TEMPLATE_BYTES,
  MARKDOWN_MAX_TEMPLATES,
  RICH_MARKDOWN_MAX_BYTES,
  RICH_MARKDOWN_OVERRIDE_MAX_BYTES,
  extractHeadings,
  previewEligibility,
  richEligibility,
  searchMarkdown,
  splitFrontMatter,
  utf8Bytes
} from './source'
import {
  destinationDirectory,
  fillMarkdownTemplate,
  imageMimeType,
  listMarkdownDocuments,
  listMarkdownTemplates,
  readMarkdownTemplate,
  releaseMarkdownImages,
  resolveMarkdownImages,
  type MarkdownResourcePool
} from './files'
import { serializeMarkdown } from './tiptap'

type MarkdownActionName = 'capabilities' | 'format' | 'insert' | 'apply' | 'links' | 'documents' | 'toc' | 'frontmatter' | 'search' | 'replace' | 'templates' | 'new' | 'importImage' | 'exportPdf' | 'renderPreview'
type ActionParams = Record<string, unknown> & {
  action?: MarkdownActionName
  bufferId?: string
  expectedRevision?: number
  worktree?: string
  query?: string
  text?: string
  format?: MarkdownFormat
  target?: string
  path?: string
  name?: string
  data?: string
  title?: string
  template?: string
  selection?: MarkdownSelection
  startLine?: number
  endLine?: number
  matchCase?: boolean
  wholeWord?: boolean
  all?: boolean
  openAnyway?: boolean
  includeCanonical?: boolean
  includePreview?: boolean
  visible?: boolean
  releaseImages?: boolean
  operation?: 'open' | 'copy' | 'edit' | 'remove' | 'resolve'
  kind?: 'image' | 'link'
  language?: string
  noteIds?: string[]
}

type MarkdownActionResult = Record<string, unknown>

const ALLOWED_FORMATS = new Set<MarkdownFormat>([
  'body', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'bold', 'italic', 'strike', 'inlineCode',
  'bulletList', 'orderedList', 'taskList', 'quote', 'link', 'image', 'codeBlock', 'divider', 'table', 'details',
  'collapsibleHeading', 'mermaid', 'inlineMath', 'blockMath', 'emoji', 'documentLink', 'tableRowAbove',
  'tableRowBelow', 'tableRowDelete', 'tableColumnLeft', 'tableColumnRight', 'tableColumnDelete', 'tableDelete',
  'codeLanguage', 'indentCode', 'outdentCode', 'copyCode'
])
const INSERT_FORMATS = new Set<MarkdownFormat>([
  'body', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'bold', 'italic', 'strike', 'inlineCode',
  'bulletList', 'orderedList', 'taskList', 'quote', 'link', 'image', 'codeBlock', 'divider', 'table', 'details',
  'collapsibleHeading', 'mermaid', 'inlineMath', 'blockMath', 'emoji', 'documentLink'
])
const PROTECTED_INLINE = /\[\[[^\]\r\n]+\]\]|\$\$[\s\S]*?\$\$|\$[^$\r\n]+\$/g
const SUPPORTED_LOCAL_LINK_SUFFIXES = ['.md', '.markdown', '.mdx'] as const
const MAX_INLINE_IMAGE_UPLOAD_BASE64_CHARS = 12 * 1024 * 1024

function currentContent(buffer: EditorBuffer): string {
  return buffer.draft !== null ? buffer.draft : buffer.content
}

function errorOf(host: EditorServices, kind: 'invalid-params' | 'not-found' | 'conflict', message: string): Error {
  return host.context.error(kind, message)
}

function requireBuffer(host: EditorServices, params: ActionParams): EditorBuffer {
  if (typeof params.bufferId !== 'string' || params.bufferId === '') throw errorOf(host, 'invalid-params', 'bufferId is required.')
  const buffer = host.get(params.bufferId)
  if (buffer.kind !== 'markdown') throw errorOf(host, 'invalid-params', 'Markdown actions require a Markdown buffer.')
  return buffer
}

function requireRevision(host: EditorServices, params: ActionParams): number {
  if (!Number.isSafeInteger(params.expectedRevision) || (params.expectedRevision as number) < 0) {
    throw errorOf(host, 'invalid-params', 'expectedRevision is required and must be a non-negative integer.')
  }
  return params.expectedRevision as number
}

function normalizeMarkdown(source: string): string {
  return source.replace(/\r\n/g, '\n')
}

function supportedCanonical(source: string, relativePath: string, openAnyway = false): { canonical: string | null; reason: string | null } {
  const eligible = richEligibility(source, relativePath, openAnyway)
  if (!eligible.eligible) return { canonical: null, reason: eligible.reason }
  const body = splitFrontMatter(source).body
  const canonical = serializeMarkdown(body)
  if (canonical === null) return { canonical: null, reason: 'This Markdown could not be parsed safely. Open source mode to edit it.' }
  const stable = serializeMarkdown(canonical)
  if (stable === null || normalizeMarkdown(stable) !== normalizeMarkdown(canonical)) {
    return { canonical: null, reason: 'This Markdown does not have a stable rich-editor round trip. Open source mode to edit it.' }
  }
  return { canonical, reason: null }
}

function markdownCapabilities(buffer: EditorBuffer, params: ActionParams): MarkdownActionResult {
  const source = currentContent(buffer)
  const frontMatter = splitFrontMatter(source)
  const rich = supportedCanonical(source, buffer.relativePath, params.openAnyway === true)
  const preview = previewEligibility(source)
  const visible = buffer.view.markdownFrontmatterVisible === true
  return {
    bufferId: buffer.id,
    mode: buffer.mode,
    richEligible: rich.canonical !== null,
    richReason: rich.reason,
    richLimitBytes: RICH_MARKDOWN_MAX_BYTES,
    openAnywayLimitBytes: RICH_MARKDOWN_OVERRIDE_MAX_BYTES,
    openAnywayAvailable: utf8Bytes(source) <= RICH_MARKDOWN_OVERRIDE_MAX_BYTES,
    previewAvailable: preview.available,
    previewReason: preview.reason,
    previewLimitBytes: 8 * 1024 * 1024,
    byteLength: preview.bytes,
    canonicalText: params.includeCanonical === true && rich.canonical !== null ? rich.canonical : undefined,
    frontMatter: frontMatter.prefix === '' ? null : {
      text: frontMatter.prefix,
      startLine: 1,
      endLine: frontMatter.lineCount,
      lineCount: frontMatter.lineCount,
      visible
    }
  }
}

function protectedRanges(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  for (const match of text.matchAll(PROTECTED_INLINE)) ranges.push({ from: match.index!, to: match.index! + match[0].length })
  return ranges
}

function isProtected(from: number, to: number, ranges: Array<{ from: number; to: number }>): boolean {
  return ranges.some((range) => from < range.to && to > range.from)
}

function escapedRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function markdownReplace(
  body: string,
  query: string,
  replacement: string,
  options: { matchCase?: boolean; wholeWord?: boolean; all?: boolean }
): { body: string; replacements: number } {
  const literal = escapedRegExp(query)
  const pattern = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal
  const expression = new RegExp(pattern, `${options.matchCase ? '' : 'i'}gu`)
  const ranges = protectedRanges(body)
  const pieces: string[] = []
  let cursor = 0
  let replacements = 0
  let match: RegExpExecArray | null
  while ((match = expression.exec(body)) !== null) {
    const from = match.index
    const to = from + match[0].length
    if (isProtected(from, to, ranges) || (!options.all && replacements > 0)) continue
    pieces.push(body.slice(cursor, from), replacement)
    cursor = to
    replacements += 1
  }
  if (replacements === 0) return { body, replacements }
  pieces.push(body.slice(cursor))
  return { body: pieces.join(''), replacements }
}

async function commitRichText(
  host: EditorServices,
  buffer: EditorBuffer,
  expectedRevision: number,
  text: string,
  openAnyway = false
): Promise<{ changed: boolean; sourcePreserved: true; buffer: EditorBuffer }> {
  const original = currentContent(buffer)
  const { prefix, body } = splitFrontMatter(original)
  const current = supportedCanonical(original, buffer.relativePath, openAnyway)
  if (current.canonical === null) throw errorOf(host, 'invalid-params', current.reason ?? 'Open source mode to edit this Markdown safely.')
  if (utf8Bytes(text) > RICH_MARKDOWN_OVERRIDE_MAX_BYTES) throw errorOf(host, 'invalid-params', 'Rich Markdown changes cannot exceed 1 MiB.')
  const editedBody = splitFrontMatter(text).body
  const editedCanonical = serializeMarkdown(editedBody)
  if (editedCanonical === null) throw errorOf(host, 'invalid-params', 'The rich Markdown edit could not be parsed safely.')
  const reconciled = reconcileSerializedMarkdown({
    originalSource: body,
    baseCanonical: current.canonical,
    edited: editedCanonical,
    roundTrip: serializeMarkdown
  })
  if (reconciled === null) {
    throw errorOf(host, 'conflict', 'This rich edit cannot preserve untouched Markdown bytes safely. Switch to source mode and make the change there; the draft was not modified.')
  }
  const nextContent = `${prefix}${reconciled.text}`
  if (nextContent === original) return { changed: false, sourcePreserved: true, buffer }
  const updated = await host.draft(buffer.id, nextContent, expectedRevision)
  return { changed: true, sourcePreserved: true, buffer: updated }
}

function validateSelection(host: EditorServices, selection: MarkdownSelection | undefined, bodyLength: number): MarkdownSelection {
  if (!selection) throw errorOf(host, 'invalid-params', 'selection with Markdown body offsets is required.')
  if (!Number.isSafeInteger(selection.from) || !Number.isSafeInteger(selection.to) || selection.from < 0 || selection.to < selection.from || selection.to > bodyLength) {
    throw errorOf(host, 'invalid-params', 'selection is outside the Markdown body.')
  }
  return selection
}

async function documentsFor(host: EditorServices, buffer: EditorBuffer, query: string): Promise<MarkdownActionResult> {
  const result = await listMarkdownDocuments(host, buffer.worktreeId, buffer.root)
  const normalizedQuery = query.trim().toLowerCase()
  const matching = normalizedQuery === '' ? result.documents : result.documents.filter((document) =>
    document.name.toLowerCase().startsWith(normalizedQuery) || document.relativePath.toLowerCase().startsWith(normalizedQuery)
  )
  return { documents: matching.slice(0, 20), total: matching.length, truncated: result.truncated || matching.length > 20 }
}

function localDocumentCandidates(target: string, currentPath: string): { exact: string[]; filePath: string | null } {
  let decoded: string
  try {
    decoded = decodeURIComponent(target.split('#', 1)[0]!)
  } catch {
    return { exact: [], filePath: null }
  }
  if (decoded === '' || decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) {
    return { exact: [], filePath: null }
  }
  const baseDir = posix.dirname(currentPath) === '.' ? '' : posix.dirname(currentPath)
  const relativeTarget = decoded.replace(/^\.\//, '')
  const normalized = posix.normalize(posix.join(baseDir, relativeTarget))
  const rootTarget = posix.normalize(relativeTarget)
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.' || posix.isAbsolute(normalized)) {
    return { exact: [], filePath: null }
  }
  const extension = posix.extname(normalized).toLowerCase()
  const candidates = [normalized]
  if (rootTarget !== normalized && rootTarget !== '..' && !rootTarget.startsWith('../') && !posix.isAbsolute(rootTarget)) candidates.push(rootTarget)
  if (extension === '') {
    const candidateCount = candidates.length
    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = candidates[index]!
      for (const suffix of SUPPORTED_LOCAL_LINK_SUFFIXES) candidates.push(`${candidate}${suffix}`)
    }
  }
  return { exact: candidates, filePath: normalized }
}

async function resolveMarkdownLink(host: EditorServices, buffer: EditorBuffer, target: string): Promise<MarkdownActionResult> {
  const value = target.trim()
  if (value === '' || value.startsWith('//')) return { target, safe: false, resolved: null, ambiguous: false, kind: 'unsafe' }
  const hash = value.indexOf('#')
  let anchor: string | null = null
  if (hash >= 0) {
    try {
      anchor = decodeURIComponent(value.slice(hash + 1))
    } catch {
      return { target, safe: false, resolved: null, ambiguous: false, kind: 'unsafe' }
    }
  }
  const path = hash >= 0 ? value.slice(0, hash) : value
  if (path === '') return { target, href: value, safe: true, resolved: null, anchor, ambiguous: false, kind: 'anchor' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    const safe = isSafeMarkdownLink(value)
    return { target, href: safe ? value : null, safe, resolved: null, ambiguous: false, kind: safe ? 'external' : 'unsafe' }
  }
  const candidatePaths = localDocumentCandidates(value, buffer.relativePath)
  if (candidatePaths.exact.length === 0 || candidatePaths.filePath === null) return { target, safe: false, resolved: null, ambiguous: false, kind: 'unsafe' }
  const listed = await listMarkdownDocuments(host, buffer.worktreeId, buffer.root)
  const matching = listed.documents.filter((document) => candidatePaths.exact.includes(document.relativePath))
  const withoutExtension = /\.(?:md|markdown|mdx)$/i.test(candidatePaths.filePath)
    ? candidatePaths.filePath.replace(/\.(?:md|markdown|mdx)$/i, '')
    : candidatePaths.filePath
  const basenameMatches = candidatePaths.filePath.includes('/')
    ? []
    : listed.documents.filter((document) => document.relativePath.replace(/\.(?:md|markdown|mdx)$/i, '').split('/').at(-1)!.toLowerCase() === withoutExtension.toLowerCase())
  const allMatches = matching.length > 0 ? matching : basenameMatches
  if (allMatches.length > 1) return { target, safe: true, resolved: null, ambiguous: true, matches: allMatches.slice(0, 20).map((doc) => doc.relativePath), kind: 'document' }
  if (allMatches.length === 1) {
    const resolved = allMatches[0]!.relativePath
    return {
      target,
      safe: true,
      resolved,
      ambiguous: false,
      anchor,
      href: resolved,
      kind: 'document'
    }
  }
  try {
    const absolutePath = await host.path(buffer.worktreeId, candidatePaths.filePath)
    if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
      return { target, safe: true, resolved: candidatePaths.filePath, ambiguous: false, anchor: null, href: candidatePaths.filePath, kind: 'file' }
    }
  } catch {}
  return { target, safe: false, resolved: null, ambiguous: false, missing: true, kind: 'document' }
}

async function validateFormatTarget(host: EditorServices, buffer: EditorBuffer, format: MarkdownFormat, target: string | undefined): Promise<string> {
  if (typeof target !== 'string' || target.trim() === '') throw errorOf(host, 'invalid-params', `${format} requires a target.`)
  const base = posix.dirname(buffer.relativePath) === '.' ? '' : posix.dirname(buffer.relativePath)
  if (format === 'image') {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('/') || target.includes('\\')) throw errorOf(host, 'invalid-params', 'Markdown images must use an authorized worktree-relative image path.')
    let decoded: string
    try { decoded = decodeURIComponent(target.split('#', 1)[0]!) }
    catch { throw errorOf(host, 'invalid-params', 'Markdown image path has invalid URL encoding.') }
    const relativePath = posix.normalize(posix.join(base, decoded))
    if (relativePath === '..' || relativePath.startsWith('../')) throw errorOf(host, 'invalid-params', 'Markdown image path escapes the worktree.')
    const absolute = await host.path(buffer.worktreeId, relativePath).catch(() => null)
    if (!absolute || !existsSync(absolute) || !statSync(absolute).isFile() || !imageMimeType(absolute)) {
      throw errorOf(host, 'not-found', `Markdown image ${target} is not an authorized image file.`)
    }
    return target
  }
  const resolution = await resolveMarkdownLink(host, buffer, target)
  if (!resolution.safe || resolution.ambiguous) {
    throw errorOf(host, 'invalid-params', 'Link target is unsafe, ambiguous or outside the authorized worktree.')
  }
  if (format === 'documentLink') {
    if (resolution.kind !== 'document' || typeof resolution.resolved !== 'string') {
      throw errorOf(host, 'invalid-params', 'Document links must resolve to a Markdown document in the worktree.')
    }
    const relativePath = posix.relative(base, resolution.resolved) || posix.basename(resolution.resolved)
    const encodedPath = relativePath.split('/').map((part) => encodeURIComponent(part)).join('/')
    const anchor = typeof resolution.anchor === 'string' && resolution.anchor !== ''
      ? `#${encodeURIComponent(resolution.anchor)}`
      : ''
    return `${encodedPath}${anchor}`
  }
  return target
}

async function markdownAction(host: EditorServices, rawParams: Record<string, unknown>, caller: PluginCaller, resources: MarkdownResourcePool): Promise<MarkdownActionResult> {
  const params = rawParams as ActionParams
  const action = params.action
  if (!action) throw errorOf(host, 'invalid-params', 'markdown action is required.')

  if (action === 'renderPreview') {
    if (params.bufferId !== undefined || params.path !== undefined || params.worktree !== undefined) {
      throw errorOf(host, 'invalid-params', 'renderPreview accepts only Markdown text and has no buffer, path or worktree context.')
    }
    if (typeof params.text !== 'string') throw errorOf(host, 'invalid-params', 'text is required for Markdown renderPreview.')
    try {
      return { html: await renderSafeMarkdownHtml(params.text) }
    } catch (error) {
      throw errorOf(host, 'invalid-params', error instanceof Error ? error.message : String(error))
    }
  }

  if (action === 'new' || action === 'templates') {
    const resolved = await host.resolve(typeof params.worktree === 'string' ? params.worktree : undefined, caller)
    const templates = await listMarkdownTemplates(host, resolved.id, resolved.path)
    if (action === 'templates') {
      const query = (params.query ?? '').trim().toLowerCase()
      const matching = query === '' ? templates.templates : templates.templates.filter((item) => item.title.toLowerCase().includes(query) || item.relativePath.toLowerCase().includes(query))
      return { templates: matching.slice(0, MARKDOWN_MAX_TEMPLATES), total: matching.length, truncated: templates.truncated || matching.length > MARKDOWN_MAX_TEMPLATES }
    }
    const title = typeof params.title === 'string' ? params.title.slice(0, 256) : ''
    const templatePath = typeof params.template === 'string' ? params.template : undefined
    let templateContent = ''
    if (templatePath) templateContent = await readMarkdownTemplate(host, resolved.id, resolved.path, templatePath)
    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const relativePath = suffix === 1 ? 'untitled.md' : `untitled-${suffix}.md`
      const absolutePath = await host.path(resolved.id, relativePath, { create: true })
      if (existsSync(absolutePath)) continue
      const content = templatePath
        ? fillMarkdownTemplate(templateContent, { title, filename: relativePath })
        : ''
      if (utf8Bytes(content) > MARKDOWN_MAX_TEMPLATE_BYTES) throw errorOf(host, 'invalid-params', 'Expanded Markdown template is larger than the 256 KiB limit.')
      try {
        await host.context.call('quirky.editor/mutate', { worktree: `id:${resolved.id}`, action: 'createFile', path: relativePath, content })
      } catch (error) {
        if (existsSync(absolutePath)) continue
        throw error
      }
      const opened = await host.context.call('quirky.editor/open', { worktree: `id:${resolved.id}`, path: relativePath, mode: 'rich', focus: false }) as EditorBuffer
      const buffer = await host.markUntitled(opened.id, templatePath !== undefined)
      return { buffer, path: relativePath, template: templatePath ?? null, templateCreated: templatePath !== undefined }
    }
    throw errorOf(host, 'conflict', 'Could not create an untitled Markdown file after 100 collision-safe attempts.')
  }

  const buffer = requireBuffer(host, params)
  const source = currentContent(buffer)
  const { prefix, body } = splitFrontMatter(source)

  if (action === 'capabilities') {
    if (params.releaseImages === true) {
      releaseMarkdownImages(resources, buffer.id)
      return { bufferId: buffer.id, released: true }
    }
    const result = markdownCapabilities(buffer, params)
    if (params.includePreview === true) {
      const preview = previewEligibility(source)
      if (preview.available) {
        try {
          const images = await resolveMarkdownImages(host, buffer, body, resources)
          result.previewHtml = await renderSafeMarkdownHtml(body, { imageUrls: images })
          result.imageUrls = Object.fromEntries(images)
        } catch (error) {
          result.previewAvailable = false
          result.previewReason = error instanceof Error ? error.message : String(error)
        }
      }
    }
    return result
  }

  if (action === 'apply') {
    const revision = requireRevision(host, params)
    if (typeof params.text !== 'string') throw errorOf(host, 'invalid-params', 'text is required for a rich Markdown update.')
    if (buffer.mode !== 'rich') throw errorOf(host, 'invalid-params', 'Rich Markdown changes require rich editor mode.')
    return commitRichText(host, buffer, revision, params.text, params.openAnyway === true)
  }

  if (action === 'format' || action === 'insert') {
    const revision = requireRevision(host, params)
    if (typeof params.format !== 'string' || !ALLOWED_FORMATS.has(params.format as MarkdownFormat)) {
      throw errorOf(host, 'invalid-params', 'format must be one of the supported Markdown toolbar and insertion formats.')
    }
    const format = params.format as MarkdownFormat
    if (action === 'insert' && !INSERT_FORMATS.has(format)) {
      throw errorOf(host, 'invalid-params', `insert does not support the ${format} format.`)
    }
    if (buffer.mode !== 'rich') throw errorOf(host, 'invalid-params', 'Rich Markdown changes require rich editor mode.')
    const canonical = supportedCanonical(source, buffer.relativePath, params.openAnyway === true)
    if (canonical.canonical === null) throw errorOf(host, 'invalid-params', canonical.reason ?? 'Open source mode to edit this Markdown safely.')
    const operationSource = canonical.canonical
    const selected = params.selection
      ? validateSelection(host, params.selection, operationSource.length)
      : { from: operationSource.length, to: operationSource.length }
    if (action === 'format' && !params.selection) throw errorOf(host, 'invalid-params', 'selection is required for Markdown formatting.')
    if (action === 'format' && format === 'copyCode') {
      return { text: extractSelectedCode(operationSource, params.selection), contentRevision: buffer.contentRevision }
    }
    let target = params.target
    if (format === 'link' || format === 'image' || format === 'documentLink') {
      target = await validateFormatTarget(host, buffer, format, params.target)
    }
    let desired: string
    try {
      desired = action === 'format'
        ? formatMarkdownSelection(operationSource, format, selected, { target, language: params.language, text: params.text })
        : insertMarkdown(operationSource, { format, text: params.text, target, language: params.language, selection: selected })
    } catch (error) {
      throw errorOf(host, 'invalid-params', error instanceof Error ? error.message : String(error))
    }
    return commitRichText(host, buffer, revision, desired, params.openAnyway === true)
  }

  if (action === 'links') {
    if (params.operation !== 'remove' && typeof params.target !== 'string') throw errorOf(host, 'invalid-params', 'target is required for Markdown link actions.')
    if (params.operation === 'remove' || params.operation === 'edit') {
      if (buffer.mode !== 'rich') throw errorOf(host, 'invalid-params', 'Link edits require rich editor mode.')
      const canonical = supportedCanonical(source, buffer.relativePath, params.openAnyway === true)
      if (canonical.canonical === null) throw errorOf(host, 'invalid-params', canonical.reason ?? 'Open source mode to edit this Markdown safely.')
      const operationSource = canonical.canonical
      const selection = validateSelection(host, params.selection, operationSource.length)
      const selected = operationSource.slice(selection.from, selection.to)
      let replacement = selected
      if (params.operation === 'remove') replacement = selected.replace(/!?(\[[^\]]*\])\((?:<[^>]+>|[^)]+)\)/g, '$1').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2')
      else {
        if (typeof params.target !== 'string') throw errorOf(host, 'invalid-params', 'Link edits need a target.')
        await validateFormatTarget(host, buffer, 'link', params.target)
        replacement = selected.replace(/!?(\[[^\]]*\])\((?:<[^>]+>|[^)]+)\)/g, (_match, label: string) => `${label}(<${params.target!.replace(/[<>]/g, '')}>)`)
      }
      return commitRichText(host, buffer, requireRevision(host, params), operationSource.slice(0, selection.from) + replacement + operationSource.slice(selection.to), params.openAnyway === true)
    }
    if (typeof params.target !== 'string') throw errorOf(host, 'invalid-params', 'target is required for Markdown link resolution.')
    return resolveMarkdownLink(host, buffer, params.target)
  }

  if (action === 'documents') {
    const query = typeof params.query === 'string' ? params.query : ''
    if (utf8Bytes(query) > 2048) return { documents: [], total: 0, truncated: false }
    return documentsFor(host, buffer, query)
  }

  if (action === 'toc') {
    const headings = extractHeadings(source).filter((heading) => heading.level >= 1 && heading.level <= 5)
    const visible = typeof params.visible === 'boolean' ? params.visible : buffer.view.markdownTocVisible === true
    if (typeof params.visible === 'boolean') await host.updateView(buffer.id, { markdownTocVisible: visible })
    return { headings, count: headings.length, visible }
  }

  if (action === 'frontmatter') {
    const frontMatter = splitFrontMatter(source)
    const visible = typeof params.visible === 'boolean' ? params.visible : buffer.view.markdownFrontmatterVisible === true
    if (typeof params.visible === 'boolean') await host.updateView(buffer.id, { markdownFrontmatterVisible: visible })
    return frontMatter.prefix === ''
      ? { visible, text: '', startLine: null, endLine: null, readOnly: true }
      : { visible, text: frontMatter.prefix, startLine: 1, endLine: frontMatter.lineCount, readOnly: true }
  }

  if (action === 'search') {
    if (typeof params.query !== 'string') throw errorOf(host, 'invalid-params', 'query is required for Markdown find.')
    const result = searchMarkdown(source, params.query, {
      matchCase: params.matchCase === true,
      wholeWord: params.wholeWord === true,
      limit: MARKDOWN_MAX_SEARCH_MATCHES
    })
    const protectedSource = protectedRanges(source)
    return {
      query: params.query,
      matches: result.matches.map((match) => ({ ...match, preserved: isProtected(match.from, match.to, protectedSource) })),
      total: result.total,
      truncated: result.truncated,
      activeIndex: 0
    }
  }

  if (action === 'replace') {
    const revision = requireRevision(host, params)
    if (typeof params.query !== 'string' || params.query === '') throw errorOf(host, 'invalid-params', 'query is required for Markdown replace.')
    if (utf8Bytes(params.query) > 2048) throw errorOf(host, 'invalid-params', 'Markdown find queries are limited to 2 KiB.')
    if (typeof params.text !== 'string') throw errorOf(host, 'invalid-params', 'text is required for Markdown replacement.')
    const replaced = markdownReplace(body, params.query, params.text, {
      matchCase: params.matchCase === true,
      wholeWord: params.wholeWord === true,
      all: params.all === true
    })
    if (replaced.replacements === 0) return { replacements: 0, changed: false, buffer }
    const next = `${prefix}${replaced.body}`
    const updated = await host.draft(buffer.id, next, revision)
    return { replacements: replaced.replacements, changed: true, sourcePreserved: true, buffer: updated }
  }


  if (action === 'importImage') return importMarkdownImage(host, buffer, params)
  if (action === 'exportPdf') return exportMarkdownPdf(host, buffer, params, resources)
  throw errorOf(host, 'invalid-params', `Unsupported Markdown action ${String(action)}.`)
}

function imageDimensions(bytes: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (mime === 'image/gif' && bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  if (mime === 'image/bmp' && bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') {
    return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) }
  }
  if (mime === 'image/x-icon' && bytes.length >= 8 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    return { width: bytes[6] || 256, height: bytes[7] || 256 }
  }
  if (mime === 'image/webp' && bytes.length >= 25 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && bytes.length >= 30) return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b1 = bytes[21]!
      const b2 = bytes[22]!
      const b3 = bytes[23]!
      const b4 = bytes[24]!
      return { width: 1 + b1 + ((b2 & 0x3f) << 8), height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) }
    }
    if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    }
  }
  if (mime === 'image/svg+xml') {
    const svg = bytes.toString('utf8', 0, Math.min(bytes.length, 1024 * 1024))
    if (!/<svg\b[^>]*>/i.test(svg)) return null
    const tag = /<svg\b([^>]*)>/i.exec(svg)?.[1] ?? ''
    const width = /\bwidth=["']([\d.]+)/i.exec(tag)?.[1]
    const height = /\bheight=["']([\d.]+)/i.exec(tag)?.[1]
    const viewBox = /\bviewBox=["']\s*[-+.\d]+[ ,]+\s*[-+.\d]+[ ,]+\s*([\d.]+)[ ,]+\s*([\d.]+)/i.exec(tag)
    return { width: Math.ceil(Number(width ?? viewBox?.[1] ?? 0)), height: Math.ceil(Number(height ?? viewBox?.[2] ?? 0)) }
  }
  if (mime === 'image/jpeg' && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]!
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) break
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return null
}

function validateImageBytes(host: EditorServices, path: string, bytes: Buffer): { bytes: Buffer; mime: string } {
  const mime = imageMimeType(path)
  if (!mime) throw errorOf(host, 'invalid-params', 'Choose a PNG, JPEG, GIF, WebP, SVG, BMP or ICO image.')
  if (bytes.length <= 0 || bytes.length > MARKDOWN_MAX_IMAGE_BYTES) throw errorOf(host, 'invalid-params', 'Image file must be non-empty and no larger than 24 MiB.')
  const dimensions = imageDimensions(bytes, mime)
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw errorOf(host, 'invalid-params', 'Image dimensions could not be verified safely.')
  if (dimensions.width > 32_768 || dimensions.height > 32_768 || dimensions.width * dimensions.height > MARKDOWN_MAX_IMAGE_PIXELS) {
    throw errorOf(host, 'invalid-params', 'Image exceeds the 32 Mi-pixel preview limit.')
  }
  return { bytes, mime }
}

function validateImageFile(host: EditorServices, path: string, absolutePath: string): { bytes: Buffer; mime: string } {
  const size = statSync(absolutePath).size
  if (size <= 0 || size > MARKDOWN_MAX_IMAGE_BYTES) throw errorOf(host, 'invalid-params', 'Image file must be non-empty and no larger than 24 MiB.')
  return validateImageBytes(host, path, readFileSync(absolutePath))
}

function importedRelativePath(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const record = result as { path?: unknown; paths?: unknown }
  const candidate = Array.isArray(record.paths) ? record.paths[0] : record.path
  if (typeof candidate !== 'string' || candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate)) return null
  const normalized = posix.normalize(candidate.replace(/\\/g, '/'))
  return normalized === '.' || normalized === '..' || normalized.startsWith('../') ? null : normalized
}

async function importMarkdownImage(host: EditorServices, buffer: EditorBuffer, params: ActionParams): Promise<MarkdownActionResult> {
  const expectedRevision = requireRevision(host, params)
  if (buffer.mode === 'preview') throw errorOf(host, 'invalid-params', 'Images cannot be inserted from a read-only Markdown preview.')
  if (buffer.readOnly) throw errorOf(host, 'invalid-params', 'Images cannot be inserted into a read-only Markdown file.')

  const destination = destinationDirectory(buffer)
  let verified: { bytes: Buffer; mime: string }
  let importedPath: string | null = null
  let ownsImportedFile = false

  if (typeof params.data === 'string') {
    if (typeof params.name !== 'string' || params.name === '' || params.name !== posix.basename(params.name) || params.name.includes('\\')) {
      throw errorOf(host, 'invalid-params', 'Uploaded image name must be a single safe filename.')
    }
    if (params.data.length === 0 || params.data.length > MAX_INLINE_IMAGE_UPLOAD_BASE64_CHARS || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(params.data)) {
      throw errorOf(host, 'invalid-params', 'Inline image uploads must use canonical base64 of at most 12 MiB; larger images use the bounded transfer API.')
    }
    const bytes = Buffer.from(params.data, 'base64')
    if (bytes.toString('base64') !== params.data) throw errorOf(host, 'invalid-params', 'Inline image upload is not canonical base64.')
    verified = validateImageBytes(host, params.name, bytes)
    const result = await host.context.call('quirky.editor/mutate', {
      worktree: `id:${buffer.worktreeId}`,
      action: 'import',
      path: destination,
      files: [{ name: params.name, data: params.data }]
    })
    importedPath = importedRelativePath(result)
    ownsImportedFile = true
  } else {
    let sourcePath: string
    let sourceRelative: string | null = null
    if (typeof params.path === 'string' && params.path !== '') {
      if (isAbsolute(params.path)) {
        const relativePath = posix.relative(buffer.root.replace(/\\/g, '/'), params.path.replace(/\\/g, '/'))
        if (relativePath === '' || relativePath.startsWith('../')) {
          throw errorOf(host, 'invalid-params', 'Explicit image paths must be authorized inside the worktree; use the native chooser for external files.')
        }
        sourceRelative = relativePath
        sourcePath = await host.path(buffer.worktreeId, relativePath)
      } else {
        sourceRelative = posix.normalize(params.path.replace(/\\/g, '/'))
        sourcePath = await host.path(buffer.worktreeId, sourceRelative)
      }
    } else {
      const selected = await chooseMarkdownImage()
      if (selected === null) return { cancelled: true }
      sourcePath = selected
      const relativePath = posix.relative(buffer.root.replace(/\\/g, '/'), selected.replace(/\\/g, '/'))
      if (relativePath !== '' && !relativePath.startsWith('../') && !posix.isAbsolute(relativePath)) sourceRelative = relativePath
    }
    verified = validateImageFile(host, sourcePath, sourcePath)
    if (sourceRelative && posix.dirname(sourceRelative) === destination) {
      importedPath = sourceRelative
    } else {
      const result = await host.context.call('quirky.editor/mutate', {
        worktree: `id:${buffer.worktreeId}`,
        action: 'import',
        path: destination,
        sourcePaths: [sourcePath]
      })
      importedPath = importedRelativePath(result)
      ownsImportedFile = true
    }
  }

  if (!importedPath) throw errorOf(host, 'conflict', 'The editor could not identify the authorized imported image path.')
  const target = posix.relative(posix.dirname(buffer.relativePath), importedPath) || posix.basename(importedPath)
  const encodedTarget = target.split('/').map((part) => encodeURIComponent(part)).join('/')
  const source = currentContent(buffer)
  const { prefix, body } = splitFrontMatter(source)
  const selection = params.selection ?? null
  const safeAlt = typeof params.text === 'string'
    ? params.text.slice(0, 1024).replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    : ''
  const imageMarkdown = `![${safeAlt}](<${encodedTarget}>)`
  try {
    let update: EditorBuffer
    if (buffer.mode === 'rich') {
      const openAnyway = params.openAnyway === true || buffer.view.markdownOpenAnyway === true
      const canonical = supportedCanonical(source, buffer.relativePath, openAnyway)
      if (canonical.canonical === null) throw errorOf(host, 'invalid-params', canonical.reason ?? 'Open source mode to insert an image safely.')
      const range = selection ? validateSelection(host, selection, canonical.canonical.length) : null
      const desired = range
        ? insertMarkdown(canonical.canonical, { format: 'image', text: safeAlt, target: encodedTarget, selection: range })
        : canonical.canonical === '' ? imageMarkdown : `${canonical.canonical.replace(/\\n*$/, '')}\\n\\n${imageMarkdown}`
      update = (await commitRichText(host, buffer, expectedRevision, desired, openAnyway)).buffer
    } else {
      const sourceSelection = selection ? validateSelection(host, selection, body.length) : null
      const nextBody = sourceSelection
        ? insertMarkdown(body, { format: 'image', text: safeAlt, target: encodedTarget, selection: sourceSelection })
        : body === '' ? imageMarkdown : `${body.replace(/\n*$/, '')}\n\n${imageMarkdown}`
      update = await host.draft(buffer.id, `${prefix}${nextBody}`, expectedRevision)
    }
    return { buffer: update, relativePath: importedPath, mimeType: verified.mime, size: verified.bytes.length, inserted: imageMarkdown }
  } catch (error) {
    if (ownsImportedFile) {
      await host.context.call('quirky.editor/mutate', {
        worktree: `id:${buffer.worktreeId}`,
        action: 'delete',
        path: importedPath,
        yes: true
      }).catch(() => {})
    }
    throw error
  }
}

async function exportMarkdownPdf(host: EditorServices, buffer: EditorBuffer, params: ActionParams, resources: MarkdownResourcePool): Promise<MarkdownActionResult> {
  if (buffer.mode === 'source') throw errorOf(host, 'invalid-params', 'PDF export is available only from rich Markdown or preview mode.')
  const source = currentContent(buffer)
  if (utf8Bytes(source) > RICH_MARKDOWN_MAX_BYTES) throw errorOf(host, 'invalid-params', 'PDF export is unavailable above the 600 KiB rich editing limit.')
  const { body } = splitFrontMatter(source)
  const imageUrls = await resolveMarkdownImages(host, buffer, body, resources)
  const html = await renderSafeMarkdownHtml(body, { imageUrls })
  let outputPath: string
  let nativeDestination = false
  if (typeof params.path === 'string' && params.path !== '') {
    if (isAbsolute(params.path) || params.path.split(/[\\/]/).includes('..')) throw errorOf(host, 'invalid-params', 'PDF path must be a worktree-relative authorized destination.')
    outputPath = await host.path(buffer.worktreeId, params.path, { create: true })
  } else {
    const selected = await choosePdfDestination(buffer.name)
    if (selected === null) return { cancelled: true }
    outputPath = selected
    nativeDestination = true
  }
  const exists = existsSync(outputPath)
  if (exists && (!nativeDestination || !(await confirmNativeReplacement(outputPath)))) {
    if (nativeDestination) return { cancelled: true }
    throw errorOf(host, 'conflict', 'PDF destination already exists; choose a new path or use the native replacement confirmation.')
  }
  const exported = await exportPdfWithChrome({
    title: buffer.name.replace(/\.(?:md|markdown|mdx)$/i, ''),
    html,
    outputPath,
    replaceExisting: exists
  })
  return { ...exported, valid: true, cancelled: false }
}

export function createMarkdownMethods(host: EditorServices): FeatureMethods {
  const resources: MarkdownResourcePool = new Map()
  const removeCloseListener = host.onClose((bufferId) => {
    try {
      if (host.get(bufferId).mode === 'preview') return
    } catch {}
    releaseMarkdownImages(resources, bufferId)
  })
  const markdown = (params: Record<string, unknown>, caller: PluginCaller) => markdownAction(host, params, caller, resources)
  const notes = createMarkdownNotesMethod(host)
  const workspaceNotes = createWorkspaceNotesMethod(host)
  return {
    methods: { markdown, notes, workspaceNotes },
    dispose() {
      removeCloseListener()
      releaseMarkdownImages(resources)
    }
  }
}
