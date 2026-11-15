import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CHORD_PLATFORM, RpcErrorCode } from '@quirky/protocol'
import { Button, Dialog, EmptyState, InlineError, NoticeLine, TextField } from '@quirky/ui'
import type { SurfaceProps } from '../types'
import type { MarkdownHeading } from './source'
import type { MarkdownReviewNote } from './note-store'
import type { MarkdownFormat } from './operations'
import { isSafeMarkdownLink } from './operations'
import { extractHeadings, splitFrontMatter, slugHeading, utf8Bytes } from './source'
import { createMarkdownExtensions } from './tiptap'
import { findRichMatches, revealRichSearchMatch, RichSearchHighlight, type RichSearchRange } from './search'
import { filterSlashCatalog, SLASH_CATALOG, type SlashItem } from './slashCatalog'
import { MermaidDiagram } from './MermaidDiagram'
import { destinationDirectory } from './files'
import { MARKDOWN_PREVIEW_REHYPE_PLUGINS, previewHeadingId } from './previewPipeline'
import { registerEditorFocus } from '../window/editorFocus'

const MARKDOWN_METHOD = 'quirky.editor/markdown'
const NOTES_METHOD = 'quirky.editor/notes'
const MAX_NOTE_BODY_BYTES = 16 * 1024
// Keep the picker in a separate chunk and invoke it only while the popup is open.
const loadEmojiPickerModule = () => import('emoji-picker-react')
type EmojiPickerModule = Awaited<ReturnType<typeof loadEmojiPickerModule>>
const CODE_LANGUAGES = [
  'Plain text', 'Bash', 'C', 'C++', 'CSS', 'Diff', 'Go', 'GraphQL', 'HTML', 'Java', 'JavaScript',
  'JSON', 'Kotlin', 'Markdown', 'Mermaid', 'Python', 'Ruby', 'Rust', 'SCSS', 'Shell', 'SQL', 'Swift',
  'TypeScript', 'XML', 'YAML'
]
const sourceValue = (buffer: SurfaceProps['buffer']) => buffer.draft !== null ? buffer.draft : buffer.content

function methodParams(bufferId: string, params: Record<string, unknown>): Record<string, unknown> {
  return { bufferId, ...params }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function useMarkdownSession(buffer: SurfaceProps['buffer']) {
  const identity = JSON.stringify([
    buffer.id,
    buffer.tabId,
    buffer.relativePath,
    buffer.worktreeId,
    buffer.contentRevision
  ])
  const identityRef = useRef(identity)
  const generationRef = useRef(0)
  if (identityRef.current !== identity) {
    identityRef.current = identity
    generationRef.current += 1
  }
  const scope = JSON.stringify([identity, generationRef.current])
  const scopeRef = useRef(scope)
  const activeRef = useRef(true)
  scopeRef.current = scope
  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])
  const isCurrent = useCallback((expected: string) => activeRef.current && scopeRef.current === expected, [])
  const isSameScope = useCallback((expected: string) => scopeRef.current === expected, [])
  return { scope, isCurrent, isSameScope }
}

type LinkModifiers = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

function isBrowserMethodUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === RpcErrorCode.MethodNotFound
}


async function openExternalTarget(
  context: SurfaceProps['context'],
  target: string,
  worktreeId: string,
  event?: LinkModifiers
): Promise<void> {
  if (!/^https?:/i.test(target)) {
    await context.call('quirky.terminal/openExternal', { target })
    return
  }
  try {
    await context.call('quirky.browser/openLink', {
      url: target,
      worktree: `id:${worktreeId}`,
      ...(event && (CHORD_PLATFORM === 'darwin' ? event.metaKey : event.ctrlKey) ? { modifier: true } : {}),
      ...(event?.shiftKey ? { shift: true } : {})
    })
  } catch (error) {
    if (!isBrowserMethodUnavailable(error)) throw error
    await context.call('quirky.terminal/openExternal', { target })
  }
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024))
  }
  return btoa(binary)
}
const IMAGE_FILENAME_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i

function imageFileFromTransfer(transfer: DataTransfer): File | null {
  const files = Array.from(transfer.files)
  const file = files.find((candidate) => candidate.type.startsWith('image/') || IMAGE_FILENAME_RE.test(candidate.name))
  if (file) return file
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file' || (!item.type.startsWith('image/') && !IMAGE_FILENAME_RE.test(item.type))) continue
    const itemFile = item.getAsFile()
    if (itemFile) return itemFile
  }
  return null
}

function markdownSource(buffer: SurfaceProps['buffer']): { prefix: string; body: string } {
  const split = splitFrontMatter(sourceValue(buffer))
  return { prefix: split.prefix, body: split.body }
}

function lineOfSelection(editor: Editor, position: number): number {
  return editor.state.doc.textBetween(0, position, '\n').split('\n').length
}
function markdownOffsetAt(editor: Editor, position: number): number {
  const markdown = editor.getMarkdown()
  const visiblePrefix = editor.state.doc.textBetween(0, position, '\n')
  if (visiblePrefix === '') return 0
  const location = markdown.lastIndexOf(visiblePrefix)
  return location < 0 ? markdown.length : location + visiblePrefix.length
}

function selectionForReview(editor: Editor): { text: string; startLine: number; endLine: number } | null {
  const { from, to, empty } = editor.state.selection
  if (empty) return null
  const text = editor.state.doc.textBetween(from, to, '\n')
  if (text.trim() === '' || utf8Bytes(text) > 32 * 1024) return null
  const startLine = lineOfSelection(editor, from)
  return { text, startLine, endLine: startLine + text.split('\n').length - 1 }
}

function isSafePreviewHref(href: string | undefined): href is string {
  return Boolean(href && isSafeMarkdownLink(href))
}
type PreviewOffsetReplacement = {
  sourceFrom: number
  sourceTo: number
  expandedFrom: number
  expandedTo: number
  labelSourceFrom: number | null
  labelSourceTo: number | null
  labelExpandedFrom: number
}

type ExpandedPreviewMarkdown = {
  markdown: string
  mapRange(from: number, to: number): { from: number; to: number } | null
}

function expandDocumentLinkChunk(
  chunk: string,
  sourceFrom: number,
  expandedFrom: number,
  replacements: PreviewOffsetReplacement[]
): string {
  const links = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
  let output = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = links.exec(chunk)) !== null) {
    output += chunk.slice(cursor, match.index)
    const rawTarget = match[1]!
    const rawLabel = match[2]
    const target = rawTarget.trim()
    const rawVisibleLabel = rawLabel ?? target
    const label = rawVisibleLabel.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    const anchorStart = target.indexOf('#')
    const path = anchorStart < 0 ? target : target.slice(0, anchorStart)
    const anchor = anchorStart < 0 ? undefined : target.slice(anchorStart + 1)
    const encodedPath = path.split('/').map((part) => {
      try { return encodeURIComponent(decodeURIComponent(part)) }
      catch { return encodeURIComponent(part) }
    }).join('/')
    const href = `${encodedPath}${anchor === undefined ? '' : `#${encodeURIComponent(anchor)}`}`
    const expandedLink = `[${label}](${href})`
    const rawStart = sourceFrom + match.index
    const visibleLabelCanMap = label === rawVisibleLabel && (rawLabel !== undefined || rawTarget === target)
    const labelSourceFrom = visibleLabelCanMap
      ? rawStart + 2 + (rawLabel === undefined ? 0 : rawTarget.length + 1)
      : null
    replacements.push({
      sourceFrom: rawStart,
      sourceTo: rawStart + match[0].length,
      expandedFrom: expandedFrom + output.length,
      expandedTo: expandedFrom + output.length + expandedLink.length,
      labelSourceFrom,
      labelSourceTo: labelSourceFrom === null ? null : labelSourceFrom + rawVisibleLabel.length,
      labelExpandedFrom: expandedFrom + output.length + 1
    })
    output += expandedLink
    cursor = links.lastIndex
  }
  return output + chunk.slice(cursor)
}

function expandDocumentLinks(markdown: string): ExpandedPreviewMarkdown {
  let fence: { char: string; size: number } | null = null
  const replacements: PreviewOffsetReplacement[] = []
  const lines = markdown.split(/\r?\n/)
  let sourceOffset = 0
  let expandedOffset = 0
  const expandedLines = lines.map((line, lineIndex) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    const isFenceLine = Boolean(marker)
    if (marker) {
      if (!fence) fence = { char: marker[0]!, size: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.size) fence = null
    }
    let expandedLine = line
    if (!isFenceLine && !fence) {
      let sourceChunkOffset = 0
      let expandedChunkOffset = 0
      expandedLine = line.split(/(`+[^`]*`+)/g).map((chunk, index) => {
        const expandedChunk = index % 2 === 1
          ? chunk
          : expandDocumentLinkChunk(chunk, sourceOffset + sourceChunkOffset, expandedOffset + expandedChunkOffset, replacements)
        sourceChunkOffset += chunk.length
        expandedChunkOffset += expandedChunk.length
        return expandedChunk
      }).join('')
    }
    const lineBreakLength = lineIndex < lines.length - 1
      ? markdown.slice(sourceOffset + line.length, sourceOffset + line.length + 2) === '\r\n' ? 2 : 1
      : 0
    const expandedLineBreakLength = lineIndex < lines.length - 1 ? 1 : 0
    if (lineBreakLength !== expandedLineBreakLength) {
      const lineBreakSourceFrom = sourceOffset + line.length
      const lineBreakExpandedFrom = expandedOffset + expandedLine.length
      replacements.push({
        sourceFrom: lineBreakSourceFrom,
        sourceTo: lineBreakSourceFrom + lineBreakLength,
        expandedFrom: lineBreakExpandedFrom,
        expandedTo: lineBreakExpandedFrom + expandedLineBreakLength,
        labelSourceFrom: null,
        labelSourceTo: null,
        labelExpandedFrom: lineBreakExpandedFrom
      })
    }
    sourceOffset += line.length + lineBreakLength
    expandedOffset += expandedLine.length + expandedLineBreakLength
    return expandedLine
  })
  const mapOffset = (offset: number): number | null => {
    let delta = 0
    for (const replacement of replacements) {
      if (offset < replacement.sourceFrom) break
      if (offset > replacement.sourceTo) {
        delta += (replacement.expandedTo - replacement.expandedFrom) - (replacement.sourceTo - replacement.sourceFrom)
        continue
      }
      if (offset === replacement.sourceFrom) return replacement.expandedFrom
      if (offset === replacement.sourceTo) return replacement.expandedTo
      if (
        replacement.labelSourceFrom !== null &&
        replacement.labelSourceTo !== null &&
        offset >= replacement.labelSourceFrom &&
        offset <= replacement.labelSourceTo
      ) {
        return replacement.labelExpandedFrom + offset - replacement.labelSourceFrom
      }
      return null
    }
    return offset + delta
  }
  return {
    markdown: expandedLines.join('\n'),
    mapRange(from, to) {
      for (const replacement of replacements) {
        if (from < replacement.sourceTo && to > replacement.sourceFrom) {
          const withinVisibleLabel = replacement.labelSourceFrom !== null &&
            replacement.labelSourceTo !== null &&
            from >= replacement.labelSourceFrom &&
            to <= replacement.labelSourceTo
          if (!withinVisibleLabel) return null
        }
      }
      const expandedFrom = mapOffset(from)
      const expandedTo = mapOffset(to)
      return expandedFrom === null || expandedTo === null || expandedTo < expandedFrom
        ? null
        : { from: expandedFrom, to: expandedTo }
    }
  }
}

type PreviewSearchNode = {
  type: string
  value?: string
  lang?: string | null
  position?: { start?: { offset?: number }; end?: { offset?: number } }
  data?: { hName?: string; hProperties?: Record<string, unknown> }
  children?: PreviewSearchNode[]
}

function previewSearchTextNodes(value: string, start: number, end: number): PreviewSearchNode[] {
  const nodes: PreviewSearchNode[] = []
  const before = value.slice(0, start)
  const selected = value.slice(start, end)
  const after = value.slice(end)
  if (before) nodes.push({ type: 'text', value: before })
  nodes.push({
    type: 'previewSearchMatch',
    data: {
      hName: 'mark',
      hProperties: { className: ['markdown-preview-search-match'] }
    },
    children: [{ type: 'text', value: selected }]
  })
  if (after) nodes.push({ type: 'text', value: after })
  return nodes
}

function remarkPreviewSearchMatch(match: { from: number; to: number } | null, markdown: string) {
  return () => (tree: PreviewSearchNode) => {
    if (!match) return
    let inserted = false
    const visit = (parent: PreviewSearchNode) => {
      if (!parent.children) return
      const children: PreviewSearchNode[] = []
      for (const child of parent.children) {
        if (!inserted && child.type === 'code' && child.lang !== 'mermaid' && typeof child.value === 'string') {
          const nodeStart = child.position?.start?.offset
          const openingLineEnd = nodeStart === undefined ? -1 : markdown.indexOf('\n', nodeStart)
          const contentStart = openingLineEnd + 1
          const start = match.from - contentStart
          const end = match.to - contentStart
          if (
            openingLineEnd >= 0 &&
            start >= 0 &&
            end > start &&
            end <= child.value.length &&
            markdown.slice(match.from, match.to) === child.value.slice(start, end)
          ) {
            children.push({
              type: 'previewSearchCode',
              data: { hName: 'pre' },
              children: [{
                type: 'previewSearchCodeContent',
                data: {
                  hName: 'code',
                  hProperties: child.lang ? { className: [`language-${child.lang}`] } : {}
                },
                children: previewSearchTextNodes(`${child.value}\n`, start, end)
              }]
            })
            inserted = true
            continue
          }
        }
        const sourceFrom = child.position?.start?.offset
        const sourceTo = child.position?.end?.offset
        if (
          !inserted &&
          child.type === 'text' &&
          typeof child.value === 'string' &&
          sourceFrom !== undefined &&
          sourceTo !== undefined &&
          sourceTo - sourceFrom === child.value.length &&
          match.from >= sourceFrom &&
          match.to <= sourceTo
        ) {
          const start = match.from - sourceFrom
          const end = match.to - sourceFrom
          if (end > start) {
            children.push(...previewSearchTextNodes(child.value, start, end))
            inserted = true
            continue
          }
        }
        visit(child)
        children.push(child)
      }
      parent.children = children
    }
    visit(tree)
  }
}

function MarkdownPreview({
  source,
  sourceOffset,
  searchMatch,
  imageUrls,
  openLink,
  markdownAnchor,
  onView,
  onMissingAnchor,
  articleRef
}: {
  source: string
  sourceOffset: number
  searchMatch: { from: number; to: number } | null
  imageUrls: Readonly<Record<string, string>>
  openLink(href: string, event: React.MouseEvent<HTMLAnchorElement>): void
  markdownAnchor: string | null
  onView(patch: Record<string, unknown>): void
  onMissingAnchor(anchor: string): void
  articleRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const expandedSource = useMemo(() => expandDocumentLinks(source), [source])
  const expandedMatch = useMemo(() => searchMatch
    ? expandedSource.mapRange(searchMatch.from - sourceOffset, searchMatch.to - sourceOffset)
    : null, [expandedSource, searchMatch, sourceOffset])

  useEffect(() => {
    articleRef.current?.querySelector<HTMLElement>('.markdown-preview-search-match')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [articleRef, expandedMatch])

  useEffect(() => {
    if (!markdownAnchor) return
    const headingId = previewHeadingId(source, markdownAnchor)
    const safeRawId = markdownAnchor.startsWith('user-content-') ? markdownAnchor : `user-content-${markdownAnchor}`
    const target = Array.from(articleRef.current?.querySelectorAll('[id]') ?? [])
      .find((element) => element.id === headingId || element.id === safeRawId || element.id === markdownAnchor)
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    else onMissingAnchor(markdownAnchor)
    onView({ markdownAnchor: null })
  }, [articleRef, markdownAnchor, onMissingAnchor, onView, source])

  return (
    <article ref={articleRef} className="markdown-body markdown-body--editor markdown-preview-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkPreviewSearchMatch(expandedMatch, expandedSource.markdown)]}
        rehypePlugins={MARKDOWN_PREVIEW_REHYPE_PLUGINS}
        components={{
          a({ href, children }) {
            return isSafePreviewHref(href)
              ? <a href={href.startsWith('#') ? `#${previewHeadingId(source, href.slice(1)) ?? href.slice(1)}` : href} rel="noopener noreferrer" onClick={(event) => openLink(href, event)}>{children}</a>
              : <span>{children}</span>
          },
          img({ src, alt }) {
            const resource = src ? imageUrls[src] : undefined
            return resource ? <img src={resource} alt={alt ?? ''} loading="lazy" /> : alt ? <span>{alt}</span> : null
          },
          code({ className, children, ...props }) {
            if (className?.includes('language-mermaid')) {
              return <MermaidDiagram source={String(children).replace(/\n$/, '')} />
            }
            return <code className={className} {...props}>{children}</code>
          }
        }}
      >
        {expandedSource.markdown}
      </ReactMarkdown>
    </article>
  )
}


function documentLinkTarget(currentPath: string, documentPath: string): string {
  const from = currentPath.split('/').slice(0, -1).filter((part) => part !== '' && part !== '.')
  const to = documentPath.replace(/\.(?:md|markdown|mdx)$/i, '').split('/').filter((part) => part !== '' && part !== '.')
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1
  const relative = [
    ...Array.from({ length: from.length - common }, () => '..'),
    ...to.slice(common)
  ].join('/') || to.at(-1) || ''
  return relative.split('/').map((part) => part === '..' ? part : encodeURIComponent(part)).join('/')
}



function SourceSurface({ props }: { props: SurfaceProps }): React.JSX.Element {
  const content = sourceValue(props.buffer)
  const { scope, isCurrent } = useMarkdownSession(props.buffer)
  const [read, setRead] = useState<{ scope: string; status: 'loading' | 'ready' | 'error'; eligibility: { richEligible: boolean; reason: string | null; openAnywayAvailable: boolean } | null; error: string | null }>({
    scope,
    status: 'loading',
    eligibility: null,
    error: null
  })
  const [actionError, setActionError] = useState<{ scope: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const readRequest = useRef(0)
  const actionRequest = useRef(0)
  const currentRead = read.scope === scope ? read : { scope, status: 'loading' as const, eligibility: null, error: null }

  const refresh = useCallback(async () => {
    const request = ++readRequest.current
    const requestScope = scope
    setRead({ scope: requestScope, status: 'loading', eligibility: null, error: null })
    try {
      const raw = await props.context.call(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities' }))
      if (!isCurrent(requestScope) || request !== readRequest.current) return
      const result = raw && typeof raw === 'object'
        ? raw as { richEligible?: boolean; richReason?: string | null; openAnywayAvailable?: boolean }
        : {}
      setRead({
        scope: requestScope,
        status: 'ready',
        eligibility: {
          richEligible: result.richEligible === true,
          reason: result.richReason ?? null,
          openAnywayAvailable: result.openAnywayAvailable === true
        },
        error: null
      })
    } catch (cause) {
      if (!isCurrent(requestScope) || request !== readRequest.current) return
      setRead({ scope: requestScope, status: 'error', eligibility: null, error: errorText(cause) })
    }
  }, [isCurrent, props.buffer.draft, props.buffer.id, props.context, scope])

  useEffect(() => {
    void refresh()
    return () => { readRequest.current += 1 }
  }, [refresh])

  const openRich = async (openAnyway = false) => {
    const request = ++actionRequest.current
    const requestScope = scope
    setBusy(true)
    setActionError(null)
    try {
      const raw = await props.context.call(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities', openAnyway }))
      if (!isCurrent(requestScope) || request !== actionRequest.current) return
      if (!raw || typeof raw !== 'object' || !('richEligible' in raw) || raw.richEligible !== true) {
        setActionError({ scope: requestScope, message: 'This document cannot be safely opened in rich mode. Continue editing in source mode.' })
        return
      }
      await props.context.call('quirky.editor/view', {
        bufferId: props.buffer.id,
        action: 'update',
        patch: { mode: 'rich', markdownOpenAnyway: openAnyway }
      })
    } catch (cause) {
      if (isCurrent(requestScope) && request === actionRequest.current) setActionError({ scope: requestScope, message: errorText(cause) })
    } finally {
      if (isCurrent(requestScope) && request === actionRequest.current) setBusy(false)
    }
  }

  const openPreview = async () => {
    const requestScope = scope
    try {
      await props.context.call('quirky.editor/open', { worktree: `id:${props.buffer.worktreeId}`, path: props.buffer.relativePath, mode: 'preview', focus: false })
    } catch (cause) {
      if (isCurrent(requestScope)) setActionError({ scope: requestScope, message: errorText(cause) })
    }
  }

  const eligibility = currentRead.eligibility
  return (
    <div className="markdown-surface markdown-surface--source">
      <div className="markdown-toolbar">
        {eligibility?.richEligible
          ? <Button type="button" disabled={busy} onClick={() => void openRich()}>Rich Editor</Button>
          : eligibility?.reason?.includes('600') && eligibility.openAnywayAvailable
            ? <Button type="button" disabled={busy} onClick={() => void openRich(true)}>Open anyway</Button>
            : currentRead.status === 'ready' && eligibility && <span>Rich editing unavailable</span>}
        <Button type="button" onClick={() => void openPreview()}>Open Markdown Preview</Button>
        <span>Source mode</span>
        {eligibility?.reason && <span role="status" className="markdown-inline-status">{eligibility.reason}</span>}
      </div>
      {currentRead.status === 'loading' && <div role="status" className="markdown-status"><NoticeLine>Checking rich editor availability…</NoticeLine></div>}
      {currentRead.status === 'error' && currentRead.error && <InlineError
        message={currentRead.error}
        action={{ label: 'Retry', onAction: () => { void refresh() } }}
        onDismiss={() => setRead((previous) => previous.scope === scope ? { ...previous, error: null, status: 'ready' } : previous)}
      />}
      {actionError?.scope === scope && <InlineError message={actionError.message} onDismiss={() => setActionError(null)} />}
      <textarea
        aria-label="Markdown source"
        spellCheck
        value={content}
        readOnly={props.buffer.readOnly}
        onChange={(event) => props.onDraft(event.currentTarget.value)}
        className="markdown-source"
      />
    </div>
  )
}

function PreviewSurface({ props }: { props: SurfaceProps }): React.JSX.Element {
  const { scope, isCurrent } = useMarkdownSession(props.buffer)
  const [previewRead, setPreviewRead] = useState<{
    scope: string
    status: 'loading' | 'ready' | 'error'
    preview?: { html?: string; imageUrls: Record<string, string> }
    error?: string
  }>({ scope, status: 'loading' })
  const currentPreviewRead = previewRead.scope === scope ? previewRead : { scope, status: 'loading' as const }
  const [actionFailure, setActionFailure] = useState<{ scope: string; message: string } | null>(null)
  const [feedbackState, setFeedbackState] = useState<{ scope: string; message: string } | null>(null)
  const actionError = actionFailure?.scope === scope ? actionFailure.message : null
  const feedback = feedbackState?.scope === scope ? feedbackState.message : null
  const setActionError = useCallback((message: string | null) => setActionFailure(message === null ? null : { scope, message }), [scope])
  const setFeedback = useCallback((message: string | null) => setFeedbackState(message === null ? null : { scope, message }), [scope])
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchOpener = useRef<HTMLElement | null>(null)
  const previewArticle = useRef<HTMLElement | null>(null)
  const previewRequest = useRef(0)
  const searchRequest = useRef(0)
  const [query, setQuery] = useState('')
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'ready'>('idle')
  const [searchScope, setSearchScope] = useState(scope)
  const [searchResult, setSearchResult] = useState<{ total: number; matches: { from: number; to: number; line: number; text: string }[] } | null>(null)
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const content = sourceValue(props.buffer)
  const split = splitFrontMatter(content)
  const preview = currentPreviewRead.status === 'ready' ? currentPreviewRead.preview : undefined
  const activeSearchMatch = searchScope === scope ? searchResult?.matches[searchIndex] ?? null : null

  const refresh = useCallback(async () => {
    const request = ++previewRequest.current
    const requestScope = scope
    setPreviewRead({ scope: requestScope, status: 'loading' })
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities', includePreview: true })) as {
        previewHtml?: string
        previewAvailable?: boolean
        previewReason?: string | null
        imageUrls?: Record<string, string>
      }
      if (!isCurrent(requestScope) || request !== previewRequest.current) return
      if (result.previewAvailable !== true) {
        setPreviewRead({
          scope: requestScope,
          status: 'error',
          error: result.previewReason ?? 'This document cannot be rendered within the preview limits.'
        })
        return
      }
      setPreviewRead({
        scope: requestScope,
        status: 'ready',
        preview: { html: result.previewHtml, imageUrls: result.imageUrls ?? {} }
      })
    } catch (cause) {
      if (!isCurrent(requestScope) || request !== previewRequest.current) return
      setPreviewRead({ scope: requestScope, status: 'error', error: errorText(cause) })
    }
  }, [isCurrent, props.buffer.id, props.buffer.contentRevision, props.buffer.draft, props.onAction, scope])

  useEffect(() => {
    void refresh()
    return () => {
      previewRequest.current += 1
      void props.context.call(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities', releaseImages: true })).catch(() => {})
    }
  }, [props.buffer.id, props.context, refresh])

  const openLink = useCallback(async (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const requestScope = scope
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'links', target: href })) as {
        safe?: boolean; kind?: string; resolved?: string | null; anchor?: string | null; ambiguous?: boolean
      }
      if (!isCurrent(requestScope)) return
      if (result.ambiguous) throw new Error('This document link is ambiguous; use its relative path.')
      if (!result.safe) throw new Error('This link is unsafe or unavailable.')
      if (result.kind === 'anchor') {
        props.onView({ markdownAnchor: result.anchor ?? null })
        return
      }
      if (result.kind === 'document' && result.resolved && !result.ambiguous) {
        const opened = await props.context.call('quirky.editor/open', {
          worktree: `id:${props.buffer.worktreeId}`,
          path: result.resolved,
          mode: 'preview',
          focus: true
        }) as { id?: string; openedTabId?: string }
        if (!isCurrent(requestScope)) return
        if (result.anchor) {
          if (!opened.id || !opened.openedTabId) throw new Error('The editor did not return the preview tab identity needed to reveal this heading.')
          await props.context.call('quirky.editor/view', {
            bufferId: opened.id,
            tabId: opened.openedTabId,
            action: 'update',
            patch: { markdownAnchor: result.anchor }
          })
        }
        return
      }
      if (result.kind === 'file' && result.resolved) {
        await props.context.call('quirky.editor/open', { worktree: `id:${props.buffer.worktreeId}`, path: result.resolved, focus: true })
        return
      }
      if (result.kind === 'external') await openExternalTarget(props.context, href, props.buffer.worktreeId, event)
    } catch (cause) {
      if (isCurrent(requestScope)) setActionError(errorText(cause))
    }
  }, [isCurrent, props.buffer.id, props.buffer.worktreeId, props.context, props.onAction, props.onView, scope])

  const runSearch = useCallback(async () => {
    if (query === '') {
      searchRequest.current += 1
      setSearchScope(scope)
      setSearchResult(null)
      setSearchStatus('idle')
      return
    }
    const request = ++searchRequest.current
    const requestScope = scope
    setSearchScope(requestScope)
    setSearchResult(null)
    setSearchStatus('loading')
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, {
        action: 'search',
        query,
        matchCase,
        wholeWord
      })) as { total: number; matches: { from: number; to: number; line: number; text: string }[] }
      if (!isCurrent(requestScope) || request !== searchRequest.current) return
      setSearchResult(result)
      setSearchStatus('ready')
      setSearchIndex(0)
    } catch (cause) {
      if (isCurrent(requestScope) && request === searchRequest.current) setActionError(errorText(cause))
    }
  }, [isCurrent, matchCase, wholeWord, props.buffer.id, props.onAction, query, scope])
  const movePreviewSearch = useCallback((delta: number) => {
    if (searchScope !== scope || !searchResult || searchResult.matches.length === 0) return
    const next = (searchIndex + delta + searchResult.matches.length) % searchResult.matches.length
    setSearchIndex(next)
  }, [scope, searchIndex, searchResult, searchScope])

  const replacePreview = useCallback(async (all: boolean) => {
    searchRequest.current += 1
    const requestScope = scope
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, {
        action: 'replace',
        expectedRevision: props.buffer.contentRevision,
        query,
        text: replaceText,
        matchCase,
        wholeWord,
        all
      })) as { replacements?: number }
      if (!isCurrent(requestScope)) return
      setSearchScope(requestScope)
      setSearchResult(null)
      setSearchStatus('idle')
      setFeedback(`${result.replacements ?? 0} replacement(s)`)
    } catch (cause) {
      if (isCurrent(requestScope)) setActionError(errorText(cause))
    }
  }, [isCurrent, matchCase, props.buffer.contentRevision, props.buffer.id, props.onAction, query, replaceText, scope, wholeWord])

  const exportPdf = useCallback(async () => {
    const requestScope = scope
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'exportPdf' })) as { path?: string; cancelled?: boolean }
      if (!isCurrent(requestScope)) return
      if (!result.cancelled) setFeedback(`Exported PDF to ${result.path ?? 'the selected location'}.`)
    } catch (cause) {
      if (isCurrent(requestScope)) setActionError(errorText(cause))
    }
  }, [isCurrent, props.buffer.id, props.onAction, scope])

  const closeSearch = useCallback(() => {
    searchRequest.current += 1
    setSearchOpen(false)
    setSearchScope(scope)
    setSearchResult(null)
    setSearchStatus('idle')
    const opener = searchOpener.current
    searchOpener.current = null
    opener?.focus()
  }, [scope])
  const openSearch = useCallback(async (replace: boolean, args?: Record<string, unknown>, opener: Element | null = document.activeElement) => {
    const requestedQuery = typeof args?.query === 'string' ? args.query : undefined
    if (!searchOpen) {
      searchOpener.current = opener instanceof HTMLElement ? opener : null
      searchRequest.current += 1
    }
    setSearchOpen(true)
    setSearchScope(scope)
    setReplaceOpen(replace)
    if (requestedQuery !== undefined) {
      setQuery(requestedQuery)
      setSearchResult(null)
      searchRequest.current += 1
    }
    window.requestAnimationFrame(() => searchInput.current?.focus())
    if (requestedQuery === undefined || requestedQuery === '') {
      if (requestedQuery === '') {
        setSearchResult(null)
        setSearchStatus('idle')
      }
      return { opened: true, replace }
    }
    const request = ++searchRequest.current
    const requestScope = scope
    setSearchResult(null)
    setSearchStatus('loading')
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, {
        action: 'search',
        query: requestedQuery,
        matchCase,
        wholeWord
      })) as { total: number; matches: { from: number; to: number; line: number; text: string }[] }
      if (isCurrent(requestScope) && request === searchRequest.current) {
        setSearchResult(result)
        setSearchStatus('ready')
        setSearchIndex(0)
      }
      return { opened: true, replace, query: requestedQuery, total: result.total }
    } catch (cause) {
      if (isCurrent(requestScope) && request === searchRequest.current) {
        setSearchStatus('idle')
        setActionError(errorText(cause))
      }
      throw cause
    }
  }, [isCurrent, matchCase, wholeWord, props.buffer.id, props.onAction, scope, searchOpen])
  useEffect(() => props.registerCommandHandlers({
    find: (args) => openSearch(false, args),
    replace: (args) => openSearch(true, args)
  }), [openSearch, props.registerCommandHandlers])

  const openSource = useCallback(async () => {
    const requestScope = scope
    try {
      await props.context.call('quirky.editor/view', methodParams(props.buffer.id, { action: 'update', patch: { mode: 'source' } }))
    } catch (cause) {
      if (isCurrent(requestScope)) setActionError(errorText(cause))
    }
  }, [isCurrent, props.buffer.id, props.context, scope])
  const reportMissingAnchor = useCallback((anchor: string) => {
    if (isCurrent(scope)) setActionError(`No Markdown preview heading or HTML anchor matches “${anchor}”.`)
  }, [isCurrent, scope])

  return (
    <div
      className="markdown-surface markdown-surface--preview"
      style={{ fontSize: props.fontSize }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== 'Escape' || !searchOpen) return
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
      }}
    >
      <div className="markdown-toolbar">
        <Button type="button" onClick={() => void openSource()}>Source</Button>
        <Button type="button" onClick={(event) => searchOpen ? closeSearch() : void openSearch(false, undefined, event.currentTarget).catch(() => {})}>Find in preview</Button>
        <Button type="button" onClick={() => void exportPdf()}>Export as PDF</Button>
        <span>Markdown Preview</span>
      </div>
      {searchOpen && <div className="markdown-toolbar markdown-toolbar--search">
        <input ref={searchInput} className="markdown-input" aria-label="Find in preview" placeholder="Find in preview" value={query} onChange={(event) => {
          const value = event.currentTarget.value
          searchRequest.current += 1
          setQuery(value)
          setSearchScope(scope)
          setSearchResult(null)
          setSearchStatus('idle')
        }} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }} />
        <label className="markdown-check"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={(event) => setMatchCase(event.currentTarget.checked)} /> Match case</label>
        <label className="markdown-check"><input type="checkbox" aria-label="Match whole word" checked={wholeWord} onChange={(event) => setWholeWord(event.currentTarget.checked)} /> Match whole word</label>
        <Button type="button" onClick={() => void runSearch()}>Find</Button>
        <Button type="button" onClick={() => movePreviewSearch(-1)}>Previous</Button>
        <Button type="button" onClick={() => movePreviewSearch(1)}>Next</Button>
        <Button type="button" onClick={() => setReplaceOpen((open) => !open)}>Replace</Button>
        {replaceOpen && <><input className="markdown-input" aria-label="Replace with" value={replaceText} onChange={(event) => setReplaceText(event.currentTarget.value)} /><Button type="button" onClick={() => void replacePreview(false)}>Replace</Button><Button type="button" onClick={() => void replacePreview(true)}>Replace all</Button></>}
        {searchStatus === 'loading' && searchScope === scope && <div role="status"><NoticeLine>Searching preview…</NoticeLine></div>}
        {searchStatus === 'ready' && searchScope === scope && searchResult?.total === 0 && <EmptyState message="No results" />}
        {searchStatus === 'ready' && searchScope === scope && searchResult && searchResult.total > 0 && <span>{searchIndex + 1} of {searchResult.total}</span>}
        <Button type="button" onClick={closeSearch}>Close</Button>
      </div>}
      {actionError && <InlineError message={actionError} onDismiss={() => setActionError(null)} />}
      {feedback && <div role="status" className="markdown-status">{feedback}<Button type="button" onClick={() => setFeedback(null)}>Dismiss</Button></div>}
      {currentPreviewRead.status === 'loading' && <div role="status" className="markdown-status"><NoticeLine>Preparing preview…</NoticeLine></div>}
      {currentPreviewRead.status === 'error' && currentPreviewRead.error && <div className="markdown-preview-failure">
        <InlineError
          message={currentPreviewRead.error}
          action={{ label: 'Retry', onAction: () => { void refresh() } }}
          onDismiss={() => setPreviewRead((previous) => previous.scope === scope ? { ...previous, error: undefined } : previous)}
        />
        <Button type="button" onClick={() => void openSource()}>Open source</Button>
      </div>}
      {currentPreviewRead.status === 'ready' && preview && <MarkdownPreview
        source={split.body}
        sourceOffset={split.prefix.length}
        searchMatch={activeSearchMatch}
        imageUrls={preview.imageUrls}
        openLink={(href, event) => void openLink(href, event)}
        markdownAnchor={typeof props.buffer.view.markdownAnchor === 'string' ? props.buffer.view.markdownAnchor : null}
        onView={props.onView}
        onMissingAnchor={reportMissingAnchor}
        articleRef={previewArticle}
      />}
    </div>
  )
}

function RichSurface({ props }: { props: SurfaceProps }): React.JSX.Element {
  const { buffer, onAction, onView, context } = props
  const { scope, isCurrent, isSameScope } = useMarkdownSession(buffer)
  const split = markdownSource(buffer)
  const source = sourceValue(buffer)
  const extensions = useMemo(() => [...createMarkdownExtensions(), RichSearchHighlight], [])
  const [readOnly, setReadOnly] = useState(buffer.readOnly)
  const [flushError, setFlushError] = useState<string | null>(null)
  const [flushErrorScope, setFlushErrorScope] = useState(scope)
  const reportFlushError = useCallback((message: string) => {
    setFlushError(message)
    setFlushErrorScope(scope)
  }, [scope])
  const [slash, setSlash] = useState<{ query: string; index: number } | null>(null)
  const [docMenu, setDocMenu] = useState<{
    scope: string
    query: string
    index: number
    from: number
    to: number
    items: { relativePath: string; name: string }[]
    total: number
    truncated: boolean
    status: 'loading' | 'ready' | 'error'
    error: string | null
  } | null>(null)
  const [selection, setSelection] = useState<{ from: number; to: number; text: string; startLine: number; endLine: number } | null>(null)
  const [linkBubble, setLinkBubble] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiPickerModule, setEmojiPickerModule] = useState<EmojiPickerModule | null>(null)
  const [emojiPickerRead, setEmojiPickerRead] = useState<{ scope: string; status: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }>({ scope, status: 'idle', error: null })
  const [moreOpen, setMoreOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchOpener = useRef<HTMLElement | null>(null)
  const [searchReplace, setSearchReplace] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [searchResult, setSearchResult] = useState<{ matches: RichSearchRange[]; total: number; query: string; matchCase: boolean; wholeWord: boolean; doc: Editor['state']['doc'] } | null>(null)
  const [searchIndex, setSearchIndex] = useState(0)
  const [tocOpen, setTocOpen] = useState(buffer.view.markdownTocVisible === true)
  const [tocLevels, setTocLevels] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]))
  const [toc, setToc] = useState<MarkdownHeading[]>([])
  const [tocRead, setTocRead] = useState<{ scope: string; status: 'loading' | 'ready' | 'error'; error: string | null }>({ scope, status: 'loading', error: null })
  const [frontMatterVisible, setFrontMatterVisible] = useState(buffer.view.markdownFrontmatterVisible === true)
  const [notes, setNotes] = useState<MarkdownReviewNote[]>([])
  const [notesRead, setNotesRead] = useState<{ scope: string; status: 'loading' | 'ready' | 'error'; error: string | null }>({ scope, status: 'loading', error: null })
  const [notesOpen, setNotesOpen] = useState(false)
  const [noteComposer, setNoteComposer] = useState(false)
  const noteInput = useRef<HTMLTextAreaElement>(null)
  const [noteBody, setNoteBody] = useState('')
  const [noteEdit, setNoteEdit] = useState<string | null>(null)
  const [sendMenu, setSendMenu] = useState(false)
  const [agentTargets, setAgentTargets] = useState<{ sessions: { id: string; agent: string; title: string }[]; agents: { id: string; label: string }[] }>({ sessions: [], agents: [] })
  const [sendTarget, setSendTarget] = useState('')
  const [sendAgent, setSendAgent] = useState('')
  const [sendRead, setSendRead] = useState<{ scope: string; status: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }>({ scope, status: 'idle', error: null })
  const sendRequestRef = useRef(0)
  const sendSessionRef = useRef(0)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<{ id: number; key: string; message: string; scope: string } | null>(null)
  const operationErrorId = useRef(0)
  const reportError = useCallback((key: string, cause: unknown) => {
    setOperationError({ id: ++operationErrorId.current, key, message: errorText(cause), scope })
  }, [scope])
  const clearError = useCallback((key: string) => {
    setOperationError((current) => current?.key === key ? null : current)
  }, [])
  const dismissError = useCallback((id: number) => {
    setOperationError((current) => current?.id === id ? null : current)
  }, [])
  const [openAnyway, setOpenAnyway] = useState(buffer.view.markdownOpenAnyway === true)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templateOptions, setTemplateOptions] = useState<{ relativePath: string; title: string }[]>([])
  const [templateQuery, setTemplateQuery] = useState('')
  const [templateTitle, setTemplateTitle] = useState('')
  const [templateRead, setTemplateRead] = useState<{ scope: string; status: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }>({ scope, status: 'idle', error: null })
  const [templateCreateError, setTemplateCreateError] = useState<string | null>(null)
  const [eligibilityRead, setEligibilityRead] = useState<{
    scope: string
    status: 'loading' | 'ready' | 'error'
    eligibility: { eligible: boolean; reason: string | null } | null
    error: string | null
  }>({ scope, status: 'loading', eligibility: null, error: null })
  const eligibility = eligibilityRead.scope === scope ? eligibilityRead.eligibility : null
  const currentEmojiRead = emojiPickerRead.scope === scope ? emojiPickerRead : { scope, status: 'idle' as const, error: null }
  const currentNotesRead = notesRead.scope === scope ? notesRead : { scope, status: 'loading' as const, error: null }
  const currentTocRead = tocRead.scope === scope ? tocRead : { scope, status: 'loading' as const, error: null }
  const currentTemplateRead = templateRead.scope === scope ? templateRead : { scope, status: 'idle' as const, error: null }
  const emojiSessionRef = useRef(0)
  const emojiRequestRef = useRef(0)
  const emojiOpenRef = useRef(false)
  const eligibilityRequestRef = useRef(0)
  const notesRequestRef = useRef(0)
  const tocRequestRef = useRef(0)
  const templateRequestRef = useRef(0)
  const templateSessionRef = useRef(0)
  const templateOpenRef = useRef(false)
  const loadEmojiPicker = useCallback(async () => {
    if (!emojiOpenRef.current || readOnly) return
    const session = emojiSessionRef.current
    const requestScope = scope
    const request = ++emojiRequestRef.current
    setEmojiPickerRead({ scope: requestScope, status: 'loading', error: null })
    try {
      const module = await loadEmojiPickerModule()
      if (!isCurrent(requestScope) || !emojiOpenRef.current || session !== emojiSessionRef.current || request !== emojiRequestRef.current) return
      setEmojiPickerModule(module)
      setEmojiPickerRead({ scope: requestScope, status: 'ready', error: null })
    } catch (cause) {
      if (!isCurrent(requestScope) || !emojiOpenRef.current || session !== emojiSessionRef.current || request !== emojiRequestRef.current) return
      setEmojiPickerRead({ scope: requestScope, status: 'error', error: errorText(cause) })
    }
  }, [isCurrent, readOnly, scope])
  const openEmoji = useCallback(() => {
    if (readOnly) return
    const session = ++emojiSessionRef.current
    emojiOpenRef.current = true
    setEmojiOpen(true)
    setEmojiPickerRead({ scope, status: emojiPickerModule ? 'ready' : 'idle', error: null })
    if (!emojiPickerModule) void loadEmojiPicker()
    return session
  }, [loadEmojiPicker, emojiPickerModule, readOnly, scope])
  const closeEmoji = useCallback(() => {
    emojiOpenRef.current = false
    emojiSessionRef.current += 1
    emojiRequestRef.current += 1
    setEmojiOpen(false)
    setEmojiPickerRead({ scope, status: 'idle', error: null })
  }, [scope])
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pendingText = useRef<string | null>(null)
  const lastAcknowledged = useRef<string | null>(null)
  const revision = useRef(buffer.contentRevision)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composition = useRef(false)
  const docQueryRef = useRef<string | null>(null)
  const docRangeRef = useRef<{ from: number; to: number } | null>(null)
  const docRequestRef = useRef(0)
  const docScopeRef = useRef(scope)
  const flushRef = useRef<() => Promise<void>>(async () => {})
  const editorRef = useRef<Editor | null>(null)
  const updateCompletionsRef = useRef<(current: Editor) => void>(() => {})
  const runSlashRef = useRef<(item: SlashItem) => void>(() => {})
  const chooseDocumentRef = useRef<(path: string) => void>(() => {})
  const openExternalRef = useRef<(target: string, event: LinkModifiers) => void>(() => {})
  const slashRef = useRef<typeof slash>(slash)
  const docMenuRef = useRef<typeof docMenu>(docMenu)

  slashRef.current = slash
  docMenuRef.current = docMenu
  const editor = useEditor({
    extensions,
    content: split.body,
    contentType: 'markdown',
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'quirky-markdown-prosemirror', 'aria-label': 'Rich Markdown editor' },
      handleKeyDown: (_view, event) => {
        const currentEditor = editorRef.current
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'x') {
          event.preventDefault()
          currentEditor?.chain().focus().toggleStrike().run()
          return true
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          setLinkValue(String(currentEditor?.getAttributes('link').href ?? ''))
          setLinkBubble(true)
          return true
        }
        if (event.key === 'Escape' && docMenuRef.current) {
          event.preventDefault()
          docRequestRef.current += 1
          docQueryRef.current = null
          docRangeRef.current = null
          setDocMenu(null)
          return true
        }
        if (event.key === 'Escape' && slashRef.current) {
          event.preventDefault()
          setSlash(null)
          return true
        }
        const currentSlash = slashRef.current
        if (currentSlash && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
          const items = filterSlashCatalog(currentSlash.query)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setSlash({ ...currentSlash, index: (currentSlash.index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length) })
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            const item = items[currentSlash.index]
            if (item) runSlashRef.current(item)
            return true
          }
        }
        const currentDocs = docMenuRef.current
        if (currentDocs && currentDocs.items.length > 0 && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
          event.preventDefault()
          if (event.key === 'Enter' || event.key === 'Tab') {
            const selected = currentDocs.items[currentDocs.index]
            if (selected) chooseDocumentRef.current(selected.relativePath)
          } else {
            const delta = event.key === 'ArrowDown' ? 1 : -1
            setDocMenu({ ...currentDocs, index: (currentDocs.index + delta + currentDocs.items.length) % currentDocs.items.length })
          }
          return true
        }
        if (event.key === 'Tab' && currentEditor?.isActive('codeBlock')) {
          event.preventDefault()
          const { from, to } = currentEditor.state.selection
          const selected = currentEditor.state.doc.textBetween(from, to, '\n')
          const replacement = event.shiftKey
            ? selected.split('\n').map((line) => line.replace(/^(?: {1,2}|\t)/, '')).join('\n')
            : selected.split('\n').map((line) => `  ${line}`).join('\n')
          if (selected !== '') currentEditor.chain().focus().insertContentAt({ from, to }, replacement).run()
          else if (!event.shiftKey) currentEditor.chain().focus().insertContent('  ').run()
          return true
        }
        return false
      },
      handleDOMEvents: {
        click: (_view, event) => {
          if (!(event.target instanceof Element)) return false
          const documentLink = event.target.closest('[data-markdown-document-link]')
          if (documentLink) {
            const target = documentLink.getAttribute('data-target')
            if (!target) return false
            event.preventDefault()
            openExternalRef.current(target, event)
            return true
          }
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey) return false
          const href = event.target.closest('a[href]')?.getAttribute('href')
          if (!href) return false
          event.preventDefault()
          openExternalRef.current(href, event)
          return true
        }
      }
    },
    onCreate: ({ editor: current }) => updateCompletionsRef.current(current),
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown()
      pendingText.current = markdown
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flushRef.current().catch(() => {}), 300)
      updateCompletionsRef.current(current)
    },
    onSelectionUpdate: ({ editor: current }) => {
      const review = selectionForReview(current)
      if (review) setSelection({ from: current.state.selection.from, to: current.state.selection.to, ...review })
      else setSelection(null)
      updateCompletionsRef.current(current)
      if (current.isActive('link')) {
        setLinkValue(String(current.getAttributes('link').href ?? ''))
        setLinkBubble(true)
      }
      onView({ selection: { from: current.state.selection.from, to: current.state.selection.to } })
    },
    onBlur: () => { void flushRef.current().catch(() => {}) }
  }, [buffer.id])
  editorRef.current = editor
  useEffect(() => {
    if (!editor || buffer.tabId === null) return
    const tabId = buffer.tabId
    const editorDom = editor.view.dom
    return registerEditorFocus(tabId, () => {
      const group = editorDom.closest<HTMLElement>('.qt-group')
      const hostedView = editorDom.closest<HTMLElement>('.qt-hosted-view')
      if (group?.classList.contains('qt-active') && hostedView?.dataset.hostedView === tabId) editor.view.focus()
    })
  }, [buffer.tabId, editor])

  const requestDocuments = useCallback((query: string, range: { from: number; to: number }) => {
    const request = ++docRequestRef.current
    const requestScope = scope
    docQueryRef.current = query
    docRangeRef.current = range
    docScopeRef.current = requestScope
    setDocMenu({
      scope: requestScope,
      query,
      index: 0,
      ...range,
      items: [],
      total: 0,
      truncated: false,
      status: 'loading',
      error: null
    })
    void onAction(MARKDOWN_METHOD, methodParams(buffer.id, { action: 'documents', query })).then((raw) => {
      if (!isCurrent(requestScope) || request !== docRequestRef.current || readOnly || composition.current) return
      const result = raw as { documents?: { relativePath: string; name: string }[]; total?: number; truncated?: boolean }
      const items = result.documents ?? []
      const latestRange = docRangeRef.current
      if (!latestRange || latestRange.from !== range.from || latestRange.to !== range.to) return
      setDocMenu({
        scope: requestScope,
        query,
        index: 0,
        ...latestRange,
        items,
        total: typeof result.total === 'number' ? result.total : items.length,
        truncated: result.truncated === true,
        status: 'ready',
        error: null
      })
    }).catch((cause: unknown) => {
      if (!isCurrent(requestScope) || request !== docRequestRef.current) return
      setDocMenu({
        scope: requestScope,
        query,
        index: 0,
        ...range,
        items: [],
        total: 0,
        truncated: false,
        status: 'error',
        error: errorText(cause)
      })
    })
  }, [buffer.id, isCurrent, onAction, readOnly, scope])
  const retryDocuments = useCallback(() => {
    const menu = docMenuRef.current
    const range = docRangeRef.current
    if (menu && range) requestDocuments(menu.query, range)
  }, [requestDocuments])
  
  const updateCompletions = useCallback((current: Editor) => {
    const dismissDocuments = () => {
      docRequestRef.current += 1
      docQueryRef.current = null
      docRangeRef.current = null
      setDocMenu(null)
    }
    if (readOnly || composition.current || !current.state.selection.empty ||
      current.isActive('code') || current.isActive('codeBlock')) {
      setSlash(null)
      dismissDocuments()
      return
    }
    const $from = current.state.selection.$from
    const before = $from.parent.textContent.slice(0, $from.parentOffset)
    const slashMatch = /^\s*\/([a-z0-9-]*)$/i.exec(before)
    if (slashMatch) {
      setSlash({ query: slashMatch[1] ?? '', index: 0 })
      dismissDocuments()
      return
    }
    setSlash(null)
    const docMatch = /(?:^|[\s(])\[\[([^\[\]|\r\n]*)$/.exec(before)
    if (!docMatch) {
      dismissDocuments()
      return
    }
    const query = docMatch[1] ?? ''
    const range = { from: $from.pos - query.length - 2, to: $from.pos }
    if (range.from < 1) {
      dismissDocuments()
      return
    }
    const previousRange = docRangeRef.current
    if (docQueryRef.current === query && docScopeRef.current === scope &&
      previousRange?.from === range.from && previousRange.to === range.to) return
    requestDocuments(query, range)
  }, [readOnly, requestDocuments, scope])
  updateCompletionsRef.current = updateCompletions
  useEffect(() => {
    if (editor) updateCompletions(editor)
  }, [editor, updateCompletions])

  const flush = useCallback(async () => {
    if (!editor) return
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const requestScope = scope
    const markdown = editor.getMarkdown()
    if (markdown === lastAcknowledged.current && pendingText.current === null) return
    const work = queue.current.then(async () => {
      if (!isSameScope(requestScope) || markdown === lastAcknowledged.current) return
      try {
        const result = await onAction(MARKDOWN_METHOD, methodParams(buffer.id, {
          action: 'apply',
          expectedRevision: revision.current,
          text: markdown,
          openAnyway
        })) as { buffer?: SurfaceProps['buffer']; changed?: boolean; sourcePreserved?: boolean }
        if (!isCurrent(requestScope)) return
        if (result.buffer) revision.current = result.buffer.contentRevision
        if (result.sourcePreserved === false) throw new Error('Rich Markdown update did not preserve its source bytes.')
        lastAcknowledged.current = markdown
        if (pendingText.current === markdown) pendingText.current = null
        setFlushError(null)
        setFlushErrorScope(requestScope)
      } catch (cause) {
        if (isCurrent(requestScope)) {
          setFlushError(errorText(cause))
          setFlushErrorScope(requestScope)
        }
        throw cause
      }
    })
    queue.current = work.catch(() => {})
    await work
  }, [buffer.id, editor, isCurrent, isSameScope, onAction, openAnyway, scope])
  flushRef.current = flush

  const updateBufferFromApi = useCallback((next: SurfaceProps['buffer'] | undefined) => {
    if (next) {
      revision.current = next.contentRevision
      if (editor) {
        const nextBody = splitFrontMatter(sourceValue(next)).body
        editor.commands.setContent(nextBody, { contentType: 'markdown', emitUpdate: false })
        lastAcknowledged.current = editor.getMarkdown()
        pendingText.current = null
      }
    }
  }, [editor])

  useEffect(() => {
    if (!editor) return
    const source = sourceValue(buffer)
    const sourceBody = splitFrontMatter(source).body
    if (revision.current === buffer.contentRevision && lastAcknowledged.current === null) {
      lastAcknowledged.current = editor.getMarkdown()
      pendingText.current = null
    } else if (buffer.contentRevision !== revision.current) {
      if (pendingText.current !== null && editor.getMarkdown() !== lastAcknowledged.current) {
        reportFlushError('The Markdown draft changed elsewhere. Your local rich edit is retained; switch to source or compare before retrying.')
      } else {
        editor.commands.setContent(sourceBody, { contentType: 'markdown', emitUpdate: false })
        revision.current = buffer.contentRevision
        lastAcknowledged.current = editor.getMarkdown()
      }
    }
    setReadOnly(buffer.readOnly)
    editor.setEditable(!buffer.readOnly)
    if (buffer.readOnly) {
      docRequestRef.current += 1
      docQueryRef.current = null
      docRangeRef.current = null
      setDocMenu(null)
      setSlash(null)
    }
  }, [buffer.contentRevision, buffer.draft, buffer.readOnly, editor, reportFlushError])

  useEffect(() => {
    if (!editor) return
    const element = editor.view.dom
    const start = () => {
      composition.current = true
      docRequestRef.current += 1
      docQueryRef.current = null
      docRangeRef.current = null
      setDocMenu(null)
      setSlash(null)
    }
    const end = () => {
      composition.current = false
      docQueryRef.current = null
      docRangeRef.current = null
      setDocMenu(null)
      setSlash(null)
    }
    element.addEventListener('compositionstart', start)
    element.addEventListener('compositionend', end)
    return () => {
      element.removeEventListener('compositionstart', start)
      element.removeEventListener('compositionend', end)
    }
  }, [editor])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    void flushRef.current().catch(() => {})
  }, [])

  const loadEligibility = useCallback(async () => {
    const request = ++eligibilityRequestRef.current
    const requestScope = scope
    setEligibilityRead({ scope: requestScope, status: 'loading', eligibility: null, error: null })
    try {
      const raw = await onAction(MARKDOWN_METHOD, methodParams(buffer.id, { action: 'capabilities', openAnyway }))
      if (!isCurrent(requestScope) || request !== eligibilityRequestRef.current) return
      const result = raw as { richEligible?: boolean; richReason?: string | null }
      setEligibilityRead({
        scope: requestScope,
        status: 'ready',
        eligibility: { eligible: result.richEligible === true, reason: result.richReason ?? null },
        error: null
      })
    } catch (cause) {
      if (!isCurrent(requestScope) || request !== eligibilityRequestRef.current) return
      setEligibilityRead({ scope: requestScope, status: 'error', eligibility: null, error: errorText(cause) })
    }
  }, [buffer.draft, buffer.id, isCurrent, onAction, openAnyway, scope])
  useEffect(() => {
    void loadEligibility()
    return () => { eligibilityRequestRef.current += 1 }
  }, [loadEligibility])

  const call = useCallback((method: string, params: Record<string, unknown> = {}) => onAction(method, methodParams(buffer.id, params)), [buffer.id, onAction])

  const loadNotes = useCallback(async () => {
    const request = ++notesRequestRef.current
    const requestScope = scope
    setNotesRead({ scope: requestScope, status: 'loading', error: null })
    try {
      const result = await call(NOTES_METHOD, { action: 'list' }) as { notes?: MarkdownReviewNote[] }
      if (!isCurrent(requestScope) || request !== notesRequestRef.current) return
      setNotes(result.notes ?? [])
      setNotesRead({ scope: requestScope, status: 'ready', error: null })
    } catch (cause) {
      if (!isCurrent(requestScope) || request !== notesRequestRef.current) return
      setNotesRead({ scope: requestScope, status: 'error', error: errorText(cause) })
    }
  }, [call, isCurrent, scope])
  useEffect(() => {
    void loadNotes()
    return () => { notesRequestRef.current += 1 }
  }, [loadNotes])

  const loadToc = useCallback(async () => {
    const request = ++tocRequestRef.current
    const requestScope = scope
    setTocRead({ scope: requestScope, status: 'loading', error: null })
    try {
      const result = await call(MARKDOWN_METHOD, { action: 'toc' }) as { headings?: MarkdownHeading[] }
      if (!isCurrent(requestScope) || request !== tocRequestRef.current) return
      setToc(result.headings ?? [])
      setTocRead({ scope: requestScope, status: 'ready', error: null })
    } catch (cause) {
      if (!isCurrent(requestScope) || request !== tocRequestRef.current) return
      setTocRead({ scope: requestScope, status: 'error', error: errorText(cause) })
    }
  }, [call, isCurrent, scope])
  useEffect(() => {
    if (!tocOpen) {
      tocRequestRef.current += 1
      return
    }
    void loadToc()
    return () => { tocRequestRef.current += 1 }
  }, [loadToc, tocOpen])

  const loadTemplates = useCallback(async (session: number) => {
    if (!templateOpenRef.current || session !== templateSessionRef.current) return
    const request = ++templateRequestRef.current
    const requestScope = scope
    setTemplateRead({ scope: requestScope, status: 'loading', error: null })
    try {
      const result = await call(MARKDOWN_METHOD, { action: 'templates', worktree: `id:${buffer.worktreeId}` }) as { templates?: { relativePath: string; title: string }[] }
      if (!isCurrent(requestScope) || request !== templateRequestRef.current || session !== templateSessionRef.current || !templateOpenRef.current) return
      setTemplateOptions(result.templates ?? [])
      setTemplateRead({ scope: requestScope, status: 'ready', error: null })
    } catch (cause) {
      if (!isCurrent(requestScope) || request !== templateRequestRef.current || session !== templateSessionRef.current || !templateOpenRef.current) return
      setTemplateRead({ scope: requestScope, status: 'error', error: errorText(cause) })
    }
  }, [buffer.worktreeId, call, isCurrent, scope])
  const closeTemplates = useCallback(() => {
    templateOpenRef.current = false
    templateSessionRef.current += 1
    templateRequestRef.current += 1
    setTemplatesOpen(false)
  }, [])

  const checkLink = useCallback(async (target: string) => {
    const result = await call(MARKDOWN_METHOD, { action: 'links', target }) as { safe?: boolean; kind?: string; resolved?: string | null; ambiguous?: boolean; anchor?: string | null }
    if (!result.safe || result.ambiguous) throw new Error(result.ambiguous ? 'This document link is ambiguous; use its relative path.' : 'This link target is unsafe or unavailable.')
    return result
  }, [call])

  const importImage = useCallback(async () => {
    if (!editor || readOnly) return
    const requestScope = scope
    try {
      await flush()
      if (!isCurrent(requestScope)) return
      const position = markdownOffsetAt(editor, editor.state.selection.from)
      const end = markdownOffsetAt(editor, editor.state.selection.to)
      const result = await call(MARKDOWN_METHOD, {
        action: 'importImage',
        expectedRevision: revision.current,
        selection: { from: position, to: end }
      }) as { buffer?: SurfaceProps['buffer']; cancelled?: boolean }
      if (!isCurrent(requestScope) || result.cancelled) return
      updateBufferFromApi(result.buffer)
      await loadNotes()
    } catch (cause) {
      if (isCurrent(requestScope)) reportFlushError(errorText(cause))
    }
  }, [call, editor, flush, isCurrent, loadNotes, readOnly, reportFlushError, scope, updateBufferFromApi])

  const importPastedImage = useCallback(async (file: File) => {
    if (!editor || readOnly || buffer.mode === 'preview') return
    const requestScope = scope
    if (file.size <= 0 || file.size > 18 * 1024 * 1024) {
      reportFlushError('Pasted images must be non-empty and fit the 24 MiB encoded-image limit.')
      return
    }
    const mimeExtension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico' }
    const filename = file.name.split(/[\\/]/).at(-1) ?? ''
    const name = filename && /\.[a-z0-9]+$/i.test(filename) ? filename : `pasted-image.${mimeExtension[file.type] ?? 'png'}`
    const from = markdownOffsetAt(editor, editor.state.selection.from)
    const to = markdownOffsetAt(editor, editor.state.selection.to)
    let transferId: string | null = null
    let importedPath: string | null = null
    try {
      await flush()
      const begun = await context.call('quirky.editor/transfer', {
        action: 'begin',
        kind: 'import',
        worktree: `id:${buffer.worktreeId}`,
        path: destinationDirectory(buffer),
        name,
        totalBytes: file.size
      }) as { transferId?: unknown; maxChunkBytes?: unknown }
      if (typeof begun.transferId !== 'string' || typeof begun.maxChunkBytes !== 'number' || begun.maxChunkBytes < 1) {
        throw new Error('The editor could not begin the bounded image import.')
      }
      transferId = begun.transferId
      const chunkBytes = Math.min(65_536, begun.maxChunkBytes)
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer())
        const result = await context.call('quirky.editor/transfer', {
          action: 'chunk',
          transferId,
          offset,
          data: bytesToBase64(chunk)
        }) as { offset?: unknown }
        if (result.offset !== offset + chunk.byteLength) throw new Error('The bounded image transfer did not acknowledge the complete chunk.')
      }
      const committed = await context.call('quirky.editor/transfer', { action: 'commit', transferId }) as { path?: unknown; paths?: unknown }
      transferId = null
      const path = Array.isArray(committed.paths) ? committed.paths[0] : committed.path
      if (typeof path !== 'string') throw new Error('The editor did not return the imported image path.')
      importedPath = path
      const result = await call(MARKDOWN_METHOD, {
        action: 'importImage',
        expectedRevision: revision.current,
        path: importedPath,
        selection: { from, to }
      }) as { buffer?: SurfaceProps['buffer'] }
      importedPath = null
      updateBufferFromApi(result.buffer)
      await loadNotes()
    } catch (cause) {
      if (transferId) await context.call('quirky.editor/transfer', { action: 'cancel', transferId }).catch(() => {})
      if (importedPath) {
        await context.call('quirky.editor/mutate', {
          worktree: `id:${buffer.worktreeId}`,
          action: 'delete',
          path: importedPath,
          yes: true
        }).catch(() => {})
      }
      if (isCurrent(requestScope)) reportFlushError(errorText(cause))
    }
  }, [buffer, call, context, editor, flush, isCurrent, loadNotes, readOnly, reportFlushError, scope, updateBufferFromApi])

  const runSlash = useCallback(async (item: SlashItem) => {
    if (!editor || readOnly) return
    const current = editor.state.selection.from
    const $from = editor.state.selection.$from
    const query = slashRef.current?.query ?? ''
    const triggerLength = query.length + 1
    const start = Math.max(1, current - triggerLength)
    editor.chain().focus().deleteRange({ from: start, to: current }).run()
    setSlash(null)
    if (item.format === 'heading1' || item.format === 'heading2' || item.format === 'heading3' || item.format === 'heading4' || item.format === 'heading5') {
      editor.chain().focus().setHeading({ level: Number(item.format.at(-1)) as 1 | 2 | 3 | 4 | 5 }).run()
    } else if (item.format === 'body') editor.chain().focus().setParagraph().run()
    else if (item.format === 'bold') editor.chain().focus().toggleBold().run()
    else if (item.format === 'italic') editor.chain().focus().toggleItalic().run()
    else if (item.format === 'strike') editor.chain().focus().toggleStrike().run()
    else if (item.format === 'bulletList') editor.chain().focus().toggleBulletList().run()
    else if (item.format === 'orderedList') editor.chain().focus().toggleOrderedList().run()
    else if (item.format === 'taskList') editor.chain().focus().toggleTaskList().run()
    else if (item.format === 'quote') editor.chain().focus().toggleBlockquote().run()
    else if (item.format === 'codeBlock') editor.chain().focus().toggleCodeBlock().run()
    else if (item.format === 'divider') editor.chain().focus().setHorizontalRule().run()
    else if (item.format === 'table') editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    else if (item.format === 'details') editor.chain().focus().insertContent({
      type: 'markdownToggle',
      attrs: { summary: 'Toggle Text', headingLevel: null, open: false },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Content' }] }]
    }).run()
    else if (item.format === 'collapsibleHeading') {
      const level = Number(/^toggleHeading([1-5])$/.exec(item.id)?.[1] ?? 1)
      editor.chain().focus().insertContent({
        type: 'markdownToggle',
        attrs: { summary: `Heading ${level}`, headingLevel: level, open: false },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Content' }] }]
      }).run()
    }
    else if (item.format === 'mermaid') editor.chain().focus().setCodeBlock({ language: 'mermaid' }).insertContent('graph TD\n  A[Start] --> B[End]').run()
    else if (item.format === 'inlineMath') editor.commands.insertInlineMath({ latex: 'x^2' })
    else if (item.format === 'blockMath') editor.commands.insertBlockMath({ latex: 'x^2' })
    else if (item.format === 'image') await importImage()
    else if (item.format === 'emoji') openEmoji()
    else if (item.format === 'link') {
      setLinkValue('')
      setLinkBubble(true)
    }
    void flush().catch(() => {})
  }, [editor, flush, importImage, openEmoji, readOnly])
  runSlashRef.current = runSlash

  const chooseDocument = useCallback((path: string) => {
    const menu = docMenuRef.current
    const range = docRangeRef.current
    if (!editor || !menu || !range || readOnly || composition.current) return
    if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || /[\r\n\[\]|]/.test(path)) {
      reportError('document-link', new Error('The selected document target is unsafe.'))
      return
    }
    const target = documentLinkTarget(buffer.relativePath, path)
    if (target === '' || /[\r\n\[\]|]/.test(target)) {
      reportError('document-link', new Error('The selected document target is unsafe.'))
      return
    }
    editor.chain().focus().insertContentAt(range, {
      type: 'markdownDocumentLink',
      attrs: { target, label: target }
    }).run()
    docRequestRef.current += 1
    docQueryRef.current = null
    docRangeRef.current = null
    setDocMenu(null)
    void flush().catch(() => {})
  }, [buffer.relativePath, editor, flush, readOnly, reportError])
  chooseDocumentRef.current = chooseDocument

  const insertToolbarFormat = useCallback((format: MarkdownFormat) => {
    if (!editor || readOnly) return
    if (format === 'body') editor.chain().focus().setParagraph().run()
    else if (/^heading[1-5]$/.test(format)) editor.chain().focus().setHeading({ level: Number(format.at(-1)) as 1 | 2 | 3 | 4 | 5 }).run()
    else if (format === 'bold') editor.chain().focus().toggleBold().run()
    else if (format === 'italic') editor.chain().focus().toggleItalic().run()
    else if (format === 'strike') editor.chain().focus().toggleStrike().run()
    else if (format === 'bulletList') editor.chain().focus().toggleBulletList().run()
    else if (format === 'orderedList') editor.chain().focus().toggleOrderedList().run()
    else if (format === 'taskList') editor.chain().focus().toggleTaskList().run()
    else if (format === 'quote') editor.chain().focus().toggleBlockquote().run()
    else if (format === 'link') {
      setLinkValue(String(editor.getAttributes('link').href ?? ''))
      setLinkBubble(true)
    }
    else if (format === 'image') void importImage()
    void flush().catch(() => {})
  }, [editor, flush, importImage, readOnly])

  const toggleFrontMatter = useCallback(async () => {
    const next = !frontMatterVisible
    const requestScope = scope
    setFrontMatterVisible(next)
    try {
      await call(MARKDOWN_METHOD, { action: 'frontmatter', visible: next })
      if (isCurrent(requestScope)) clearError('frontmatter')
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('frontmatter', cause)
    }
  }, [call, clearError, frontMatterVisible, isCurrent, reportError, scope])

  const updateSearch = useCallback(() => {
    if (!editor) return
    if (searchQuery === '') {
      setSearchResult(null)
      revealRichSearchMatch(editor, null)
      return
    }
    const result = findRichMatches(editor, searchQuery, { matchCase, wholeWord })
    setSearchResult({ ...result, query: searchQuery, matchCase, wholeWord, doc: editor.state.doc })
    setSearchIndex(0)
    revealRichSearchMatch(editor, result.matches[0] ?? null)
    searchInput.current?.focus()
  }, [editor, matchCase, wholeWord, searchQuery])
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    if (editor) revealRichSearchMatch(editor, null)
    setSearchResult(null)
    const opener = searchOpener.current
    searchOpener.current = null
    opener?.focus()
  }, [editor])
  const openSearch = useCallback(async (replace: boolean, args?: Record<string, unknown>, opener: Element | null = document.activeElement) => {
    if (!editor) throw new Error('The rich Markdown editor is not ready.')
    const requestedQuery = typeof args?.query === 'string' ? args.query : undefined
    if (!searchOpen) {
      searchOpener.current = opener instanceof HTMLElement ? opener : null
    }
    setSearchOpen(true)
    setSearchReplace(replace)
    if (requestedQuery !== undefined) setSearchQuery(requestedQuery)
    window.requestAnimationFrame(() => searchInput.current?.focus())
    if (requestedQuery === undefined || requestedQuery === '') return { opened: true, replace }
    const result = findRichMatches(editor, requestedQuery, { matchCase, wholeWord })
    setSearchResult({ ...result, query: requestedQuery, matchCase, wholeWord, doc: editor.state.doc })
    setSearchIndex(0)
    revealRichSearchMatch(editor, result.matches[0] ?? null)
    return { opened: true, replace, query: requestedQuery, total: result.total }
  }, [editor, matchCase, searchOpen, wholeWord])

  const moveSearch = useCallback((direction: number) => {
    if (!editor || !searchResult) return
    if (searchResult.doc !== editor.state.doc || searchResult.query !== searchQuery || searchResult.matchCase !== matchCase || searchResult.wholeWord !== wholeWord) {
      updateSearch()
      return
    }
    if (searchResult.matches.length === 0) return
    const next = (searchIndex + direction + searchResult.matches.length) % searchResult.matches.length
    setSearchIndex(next)
    revealRichSearchMatch(editor, searchResult.matches[next]!)
    searchInput.current?.focus()
  }, [editor, matchCase, searchIndex, searchQuery, searchResult, updateSearch, wholeWord])

  const replaceMatches = useCallback(async (all: boolean) => {
    if (!editor || readOnly) return
    const requestScope = scope
    try {
      const result = await call(MARKDOWN_METHOD, {
        action: 'replace',
        expectedRevision: revision.current,
        query: searchQuery,
        text: replaceText,
        matchCase,
        wholeWord,
        all
      }) as { buffer?: SurfaceProps['buffer']; replacements?: number }
      if (!isCurrent(requestScope)) return
      if (result.buffer) updateBufferFromApi(result.buffer)
      clearError('replace')
      setFeedback(`${result.replacements ?? 0} replacement(s)`)
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('replace', cause)
    }
  }, [call, clearError, editor, isCurrent, matchCase, readOnly, replaceText, reportError, scope, searchQuery, updateBufferFromApi, wholeWord])

  const toggleToc = useCallback(async () => {
    const next = !tocOpen
    const requestScope = scope
    setTocOpen(next)
    try {
      await call(MARKDOWN_METHOD, { action: 'toc', visible: next })
      if (isCurrent(requestScope)) clearError('toc-toggle')
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('toc-toggle', cause)
    }
  }, [call, clearError, isCurrent, reportError, scope, tocOpen])

  const jumpToHeading = useCallback((heading: MarkdownHeading) => {
    if (!editor) return
    const all: { text: string; level: number; pos: number }[] = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') all.push({ text: node.textContent, level: Number(node.attrs.level), pos })
    })
    const headings = extractHeadings(source)
    const index = headings.findIndex((item) => item.id === heading.id)
    const target = all[index]
    if (target) editor.chain().focus().setTextSelection(target.pos + 1).scrollIntoView().run()
  }, [editor, source])
  useEffect(() => {
    const anchor = buffer.view.markdownAnchor
    const requestScope = scope
    if (!editor || typeof anchor !== 'string' || anchor === '') return
    const heading = extractHeadings(source).find((item) => item.id === anchor || item.id === slugHeading(anchor))
    if (heading) jumpToHeading(heading)
    else if (isCurrent(requestScope)) reportError('missing-anchor', new Error(`No Markdown heading matches “${anchor}”.`))
    onView({ markdownAnchor: null })
  }, [buffer.view.markdownAnchor, editor, isCurrent, jumpToHeading, onView, reportError, scope, source])

  const openExternal = useCallback(async (target: string, event?: LinkModifiers) => {
    const requestScope = scope
    try {
      const result = await checkLink(target)
      if (!isCurrent(requestScope)) return
      if (result.kind === 'document' && result.resolved) {
        const opened = await context.call('quirky.editor/open', {
          worktree: `id:${buffer.worktreeId}`,
          path: result.resolved,
          mode: 'preview',
          focus: true
        }) as { id?: string; openedTabId?: string }
        if (!isCurrent(requestScope)) return
        if (result.anchor) {
          if (!opened.id || !opened.openedTabId) throw new Error('The editor did not return the preview tab identity needed to reveal this heading.')
          await context.call('quirky.editor/view', {
            bufferId: opened.id,
            tabId: opened.openedTabId,
            action: 'update',
            patch: { markdownAnchor: result.anchor }
          })
        }
      } else if (result.kind === 'file' && result.resolved) {
        await context.call('quirky.editor/open', { worktree: `id:${buffer.worktreeId}`, path: result.resolved, focus: true })
      } else if (result.kind === 'anchor') {
        onView({ markdownAnchor: result.anchor ?? null })
      } else if (result.kind === 'external') {
        await openExternalTarget(context, target, buffer.worktreeId, event)
      }
      if (isCurrent(requestScope)) clearError('open-link')
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('open-link', cause)
    }
  }, [buffer.worktreeId, checkLink, clearError, context, isCurrent, onView, reportError, scope])
  openExternalRef.current = (target, event) => { void openExternal(target, event) }

  const saveLink = useCallback(async () => {
    if (!editor || readOnly) return
    const requestScope = scope
    const target = linkValue.trim()
    if (!target) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      setLinkBubble(false)
      void flush().catch(() => {})
      return
    }
    try {
      const resolved = await checkLink(target)
      if (!isCurrent(requestScope)) return
      if (!resolved.safe) throw new Error('Unsafe link targets are not allowed.')
      editor.chain().focus().extendMarkRange('link').setLink({ href: target }).run()
      setLinkBubble(false)
      clearError('link-save')
      void flush().catch(() => {})
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('link-save', cause)
    }
  }, [checkLink, clearError, editor, flush, isCurrent, linkValue, readOnly, reportError, scope])

  const loadSendTargets = useCallback(async (session: number) => {
    const request = ++sendRequestRef.current
    const requestScope = scope
    setSendRead({ scope: requestScope, status: 'loading', error: null })
    try {
      const [sessionRows, agentRows] = await Promise.all([
        context.call('quirky.session/list', { worktree: `id:${buffer.worktreeId}` }) as Promise<{ id: string; agent: string; title: string; kind: string; status: string }[]>,
        context.call('quirky.agents/list', {}) as Promise<{ id: string; label: string }[]>
      ])
      if (!isCurrent(requestScope) || request !== sendRequestRef.current || session !== sendSessionRef.current) return
      setAgentTargets({
        sessions: sessionRows.filter((row) => row.kind === 'terminal' && row.status !== 'exited').map(({ id, agent, title }) => ({ id, agent, title })),
        agents: agentRows.map(({ id, label }) => ({ id, label }))
      })
      setSendRead({ scope: requestScope, status: 'ready', error: null })
    } catch (cause) {
      if (!isCurrent(requestScope) || request !== sendRequestRef.current || session !== sendSessionRef.current) return
      setSendRead({ scope: requestScope, status: 'error', error: errorText(cause) })
    }
  }, [buffer.worktreeId, context, isCurrent, scope])
  const closeSendMenu = useCallback(() => {
    sendSessionRef.current += 1
    sendRequestRef.current += 1
    setSendMenu(false)
    setSendRead({ scope, status: 'idle', error: null })
  }, [scope])
  const openSendMenu = useCallback(() => {
    if (sendMenu) {
      closeSendMenu()
      return
    }
    const session = ++sendSessionRef.current
    setSendMenu(true)
    setAgentTargets({ sessions: [], agents: [] })
    void loadSendTargets(session)
  }, [closeSendMenu, loadSendTargets, sendMenu])

  const sendNotes = useCallback(async (target: 'existing' | 'new') => {
    const requestScope = scope
    const session = sendSessionRef.current
    try {
      const params = target === 'existing'
        ? { action: 'send', target, sessionId: sendTarget, agent: agentTargets.sessions.find((item) => item.id === sendTarget)?.agent }
        : { action: 'send', target, agent: sendAgent }
      const result = await call(NOTES_METHOD, params) as { delivery: string; deletedNoteIds: string[]; retainedNoteIds: string[]; error?: string }
      if (!isCurrent(requestScope) || session !== sendSessionRef.current) return
      if (result.error) {
        reportError('send-notes', new Error(result.error))
        return
      }
      clearError('send-notes')
      setFeedback(`${result.deletedNoteIds.length} note(s) delivered.`)
      closeSendMenu()
      await loadNotes()
    } catch (cause) {
      if (isCurrent(requestScope) && session === sendSessionRef.current) reportError('send-notes', cause)
    }
  }, [agentTargets.sessions, call, clearError, closeSendMenu, isCurrent, loadNotes, reportError, scope, sendAgent, sendTarget])

  const addNote = useCallback(async () => {
    if (!selection) return
    if (utf8Bytes(noteBody) > MAX_NOTE_BODY_BYTES) {
      reportError('note-submit', new Error('Comment is too large to submit safely.'))
      return
    }
    const requestScope = scope
    try {
      if (noteEdit) {
        await call(NOTES_METHOD, { action: 'edit', noteId: noteEdit, text: noteBody })
      } else {
        await call(NOTES_METHOD, {
          action: 'add',
          selection: { text: selection.text, startLine: selection.startLine, endLine: selection.endLine, mode: 'rich' },
          text: noteBody
        })
      }
      if (!isCurrent(requestScope)) return
      clearError('note-submit')
      setNoteComposer(false)
      setNoteBody('')
      setNoteEdit(null)
      await loadNotes()
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('note-submit', cause)
    }
  }, [call, clearError, isCurrent, loadNotes, noteBody, noteEdit, reportError, scope, selection])
  const startReviewNote = useCallback(() => {
    if (!selection) throw new Error('Select Markdown text before adding a review note.')
    setNoteEdit(null)
    setNoteBody('')
    setNoteComposer(true)
    setNotesOpen(true)
    window.requestAnimationFrame(() => noteInput.current?.focus())
    return { opened: true, startLine: selection.startLine, endLine: selection.endLine }
  }, [selection])
  const copyMarkdownContext = useCallback(async () => {
    if (!selection) throw new Error('Select Markdown text before copying context.')
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.')
    const lines = selection.startLine === selection.endLine ? `${selection.startLine}` : `${selection.startLine}-${selection.endLine}`
    await navigator.clipboard.writeText(`${buffer.relativePath}:${lines}\n${selection.text}`)
    return { copied: true, path: buffer.relativePath, lines }
  }, [buffer.relativePath, selection])
  useEffect(() => props.registerCommandHandlers({
    find: (args) => openSearch(false, args),
    replace: (args) => openSearch(true, args),
    'copy-context': copyMarkdownContext,
    'add-review-note': startReviewNote,
    flush
  }), [copyMarkdownContext, flush, openSearch, props.registerCommandHandlers, startReviewNote])

  const copyNotes = useCallback(async () => {
    const requestScope = scope
    try {
      const result = await call(NOTES_METHOD, { action: 'copy' }) as { text: string; count: number }
      await navigator.clipboard.writeText(result.text)
      if (!isCurrent(requestScope)) return
      clearError('copy-notes')
      setFeedback(result.count === 0 ? 'No review notes to copy.' : 'Copied notes for agent.')
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('copy-notes', cause)
    }
  }, [call, clearError, isCurrent, reportError, scope])

  const exportPdf = useCallback(async () => {
    const requestScope = scope
    try {
      await flush()
    } catch {
      return
    }
    if (!isCurrent(requestScope)) return
    try {
      const result = await call(MARKDOWN_METHOD, { action: 'exportPdf' }) as { path?: string; cancelled?: boolean }
      if (!isCurrent(requestScope)) return
      if (!result.cancelled) {
        clearError('export-pdf')
        setFeedback(`Exported PDF to ${result.path ?? 'the selected location'}.`)
      }
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('export-pdf', cause)
    }
  }, [call, clearError, flush, isCurrent, reportError, scope])

  const openPreview = useCallback(async () => {
    const requestScope = scope
    try {
      await flush()
    } catch {
      return
    }
    if (!isCurrent(requestScope)) return
    try {
      await context.call('quirky.editor/open', { worktree: `id:${buffer.worktreeId}`, path: buffer.relativePath, mode: 'preview', focus: false })
      clearError('open-preview')
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('open-preview', cause)
    }
  }, [buffer.relativePath, buffer.worktreeId, clearError, context, flush, isCurrent, reportError, scope])

  const openSource = useCallback(async () => {
    const requestScope = scope
    await flush().catch(() => {})
    if (!isCurrent(requestScope)) return
    try {
      await context.call('quirky.editor/view', methodParams(buffer.id, { action: 'update', patch: { mode: 'source' } }))
      clearError('open-source')
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('open-source', cause)
    }
  }, [buffer.id, clearError, context, flush, isCurrent, reportError, scope])

  const openNewDocument = useCallback(() => {
    const session = ++templateSessionRef.current
    templateOpenRef.current = true
    setTemplatesOpen(true)
    setTemplateOptions([])
    setTemplateRead({ scope, status: 'loading', error: null })
    setTemplateCreateError(null)
    setTemplateQuery('')
    setTemplateTitle('')
    void loadTemplates(session)
  }, [loadTemplates, scope])

  const createNewDocument = useCallback(async (template?: string) => {
    const requestScope = scope
    const session = templateSessionRef.current
    setTemplateCreateError(null)
    try {
      await call(MARKDOWN_METHOD, {
        action: 'new',
        worktree: `id:${buffer.worktreeId}`,
        title: templateTitle,
        ...(template ? { template } : {})
      })
      if (!isCurrent(requestScope) || session !== templateSessionRef.current || !templateOpenRef.current) return
      closeTemplates()
    } catch (cause) {
      if (isCurrent(requestScope) && session === templateSessionRef.current && templateOpenRef.current) setTemplateCreateError(errorText(cause))
    }
  }, [buffer.worktreeId, call, closeTemplates, isCurrent, scope, templateTitle])

  const currentSlashItems = slash ? filterSlashCatalog(slash.query) : []
  const frontmatter = splitFrontMatter(source).prefix
  const linkHref = editor?.isActive('link') ? String(editor.getAttributes('link').href ?? '') : ''
  const codeLanguage = editor?.isActive('codeBlock') ? String(editor.getAttributes('codeBlock').language ?? '') : ''
  const codeText = editor?.isActive('codeBlock') ? editor.state.selection.$from.parent.textContent : ''
  const emojiPickerModuleLoaded = emojiPickerModule
  const EmojiPicker = emojiPickerModuleLoaded?.default
  const currentSelection = editor ? selectionForReview(editor) : null
  const visibleNotes = currentNotesRead.status === 'ready' ? notes : []
  const currentSendRead = sendRead.scope === scope ? sendRead : { scope, status: 'idle' as const, error: null }
  const emojiRenderSession = emojiSessionRef.current
  const visibleToc = toc.filter((heading) => tocLevels.has(heading.level))
  const visibleTemplates = templateOptions.filter((template) =>
    template.title.toLowerCase().includes(templateQuery.toLowerCase()) ||
    template.relativePath.toLowerCase().includes(templateQuery.toLowerCase())
  )

  return (
    <div
      className="markdown-surface markdown-surface--rich"
      style={{ fontSize: props.fontSize }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== 'Escape' || !searchOpen) return
        event.preventDefault()
        event.stopPropagation()
        closeSearch()
      }}
    >
      <div className="markdown-toolbar" role="toolbar" aria-label="Markdown formatting">
        <Button type="button" aria-expanded={notesOpen} onClick={() => setNotesOpen((open) => !open)}>Review notes ({notes.length})</Button>
        <Button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('body')}>Body text</Button>
        {[1, 2, 3].map((level) => <Button key={level} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat(`heading${level}` as MarkdownFormat)}>H{level}</Button>)}
        <Button type="button" aria-label="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('bold')}><strong>B</strong></Button>
        <Button type="button" aria-label="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('italic')}><em>I</em></Button>
        <Button type="button" aria-label="Strikethrough" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('strike')}><s>S</s></Button>
        <Button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('bulletList')}>Bullets</Button>
        <Button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('orderedList')}>Numbered</Button>
        <Button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('taskList')}>Checklist</Button>
        <Button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('quote')}>Quote</Button>
        <Button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('link')}>Link</Button>
        <Button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertToolbarFormat('image')}>Image</Button>
        <Button type="button" onClick={() => setMoreOpen((open) => !open)}>More blocks ▾</Button>
        <Button type="button" onClick={() => void openSource()}>Source</Button>
        <Button type="button" onClick={() => void openPreview()}>Preview</Button>
        <Button type="button" onClick={(event) => searchOpen ? closeSearch() : void openSearch(false, undefined, event.currentTarget)}>Find</Button>
        <Button type="button" onClick={() => void toggleToc()}>TOC</Button>
        {frontmatter && <Button type="button" onClick={() => void toggleFrontMatter()}>Front Matter</Button>}
        <Button type="button" onClick={() => void exportPdf()}>Export PDF</Button>
        <Button type="button" onClick={() => void openNewDocument()}>New Markdown</Button>
      </div>
      {templatesOpen && <Dialog
        open={templatesOpen}
        title="New Markdown"
        onClose={closeTemplates}
        actions={<Button onClick={closeTemplates}>Cancel</Button>}
      >
        <div className="markdown-template-dialog">
          <TextField label="Document title" className="markdown-input" placeholder="Title" value={templateTitle} onChange={(event) => setTemplateTitle(event.currentTarget.value)} />
          <TextField label="Search templates" className="markdown-input" placeholder="Search templates…" value={templateQuery} onChange={(event) => setTemplateQuery(event.currentTarget.value)} />
          <Button type="button" onClick={() => void createNewDocument()}>Blank Markdown (untitled.md)</Button>
          {currentTemplateRead.status === 'loading' && <div role="status"><NoticeLine>Loading Markdown templates…</NoticeLine></div>}
          {currentTemplateRead.status === 'error' && currentTemplateRead.error && <InlineError
            message={currentTemplateRead.error}
            action={{ label: 'Retry', onAction: () => { void loadTemplates(templateSessionRef.current) } }}
            onDismiss={() => setTemplateRead((previous) => previous.scope === scope ? { ...previous, error: null, status: 'idle' } : previous)}
          />}
          {templateCreateError && <InlineError message={templateCreateError} onDismiss={() => setTemplateCreateError(null)} />}
          {currentTemplateRead.status === 'ready' && templateOptions.length === 0 && <EmptyState message="No Markdown templates." />}
          {currentTemplateRead.status === 'ready' && templateOptions.length > 0 && visibleTemplates.length === 0 && <EmptyState message="No matching templates." />}
          {currentTemplateRead.status === 'ready' && visibleTemplates.map((template) => <Button key={template.relativePath} type="button" onClick={() => void createNewDocument(template.relativePath)}>{template.title} — {template.relativePath}</Button>)}
        </div>
      </Dialog>}

      {moreOpen && <div className="markdown-popover markdown-popover--menu" role="menu" aria-label="More Markdown blocks">
        {[['Heading 4', 'heading4'], ['Heading 5', 'heading5'], ['Collapsible section', 'details'], ['Code block', 'codeBlock'], ['Table', 'table'], ['Divider', 'divider'], ['Mermaid diagram', 'mermaid'], ['Inline math', 'inlineMath'], ['Math block', 'blockMath'], ['Emoji', 'emoji']].map(([label, format]) => <Button key={format} type="button" role="menuitem" disabled={readOnly} onClick={() => {
          if (readOnly) return
          const requestScope = scope
          const item = SLASH_CATALOG.find((candidate) => candidate.format === format)
          if (format === 'emoji') openEmoji()
          else if (item) void runSlash(item).catch((cause) => { if (isCurrent(requestScope)) reportError('insert-block', cause) })
          else if (format === 'heading4' || format === 'heading5' || format === 'details' || format === 'codeBlock' || format === 'table' || format === 'divider' || format === 'mermaid' || format === 'inlineMath' || format === 'blockMath') {
            void call(MARKDOWN_METHOD, { action: 'insert', expectedRevision: revision.current, format }).then((result) => {
              if (isCurrent(requestScope)) {
                updateBufferFromApi((result as { buffer?: SurfaceProps['buffer'] }).buffer)
                clearError('insert-block')
              }
            }).catch((cause) => { if (isCurrent(requestScope)) reportError('insert-block', cause) })
          }
          setMoreOpen(false)
        }}>{label}</Button>)}</div>}

      {eligibilityRead.scope === scope && eligibilityRead.status === 'loading' && <div role="status" className="markdown-status"><NoticeLine>Checking rich editing availability…</NoticeLine></div>}
      {eligibilityRead.scope === scope && eligibilityRead.status === 'error' && eligibilityRead.error && <InlineError
        message={eligibilityRead.error}
        action={{ label: 'Retry', onAction: () => { void loadEligibility() } }}
        onDismiss={() => setEligibilityRead((previous) => previous.scope === scope ? { ...previous, status: 'ready', error: null } : previous)}
      />}
      {eligibility && !eligibility.eligible && <div role="status" className="markdown-status">
        <span>{eligibility.reason}</span>
        {eligibility.reason?.includes('600') && utf8Bytes(source) <= 1024 * 1024 && <Button type="button" onClick={() => setOpenAnyway(true)}>Open anyway</Button>}
        <Button type="button" onClick={() => void openSource()}>Open source mode</Button>
      </div>}
      {frontmatter && frontMatterVisible && <details open className="markdown-frontmatter">
        <summary>Front Matter (edit in source mode)</summary><pre className="markdown-frontmatter__source">{frontmatter}</pre>
      </details>}
      {searchOpen && <div className="markdown-toolbar markdown-toolbar--search">
        <input ref={searchInput} className="markdown-input" aria-label="Find in rich editor" placeholder="Find in rich editor" value={searchQuery} onChange={(event) => {
          const value = event.currentTarget.value
          setSearchQuery(value)
          setSearchResult(null)
          if (value === '' && editor) revealRichSearchMatch(editor, null)
        }} onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          if (searchResult) moveSearch(event.shiftKey ? -1 : 1)
          else updateSearch()
        }} />
        <label className="markdown-check"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={(event) => setMatchCase(event.currentTarget.checked)} /> Match case</label>
        <label className="markdown-check"><input type="checkbox" aria-label="Match whole word" checked={wholeWord} onChange={(event) => setWholeWord(event.currentTarget.checked)} /> Match whole word</label>
        <Button type="button" onClick={() => void updateSearch()}>Find</Button>
        <Button type="button" onClick={() => moveSearch(-1)}>Previous</Button>
        <Button type="button" onClick={() => moveSearch(1)}>Next</Button>
        <Button type="button" onClick={() => setSearchReplace((show) => !show)}>Replace</Button>
        {searchReplace && <><input aria-label="Replace with" value={replaceText} onChange={(event) => setReplaceText(event.currentTarget.value)} /><Button type="button" disabled={readOnly} onClick={() => void replaceMatches(false)}>Replace</Button><Button type="button" disabled={readOnly} onClick={() => void replaceMatches(true)}>Replace all</Button></>}
        {searchQuery !== '' && searchResult && searchResult.doc === editor?.state.doc && searchResult.query === searchQuery && searchResult.matchCase === matchCase && searchResult.wholeWord === wholeWord && searchResult.total === 0 && <EmptyState message="No results" />}
        {searchQuery !== '' && searchResult && searchResult.doc === editor?.state.doc && searchResult.query === searchQuery && searchResult.matchCase === matchCase && searchResult.wholeWord === wholeWord && searchResult.total > 0 && <span>{searchIndex + 1} of {searchResult.total}</span>}
        <Button type="button" onClick={closeSearch}>Close</Button>
      </div>}

      {docMenu?.scope === scope && <div role="dialog" aria-label="Markdown document links" className="markdown-popover markdown-popover--list">
        <strong>Markdown document links</strong>
        <div role="listbox" aria-label="Document matches" className="markdown-popover__items">
          {docMenu.status === 'loading' && <div role="status"><NoticeLine>Finding Markdown documents…</NoticeLine></div>}
          {docMenu.status === 'error' && docMenu.error && <InlineError
            message={docMenu.error}
            action={{ label: 'Retry', onAction: retryDocuments }}
          />}
          {docMenu.status === 'ready' && docMenu.items.length === 0 && <EmptyState message="No documents found" />}
          {docMenu.status === 'ready' && docMenu.items.map((item, index) => <Button key={item.relativePath} type="button" role="option" aria-selected={index === docMenu.index} className="markdown-option" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseDocument(item.relativePath)}>{item.relativePath}</Button>)}
        </div>
        {docMenu.status === 'ready' && <span>{docMenu.items.length} of {docMenu.total} matches{docMenu.truncated ? ' (truncated)' : ''}</span>}
      </div>}
      {slash && <div role="dialog" aria-label="Slash commands" className="markdown-popover markdown-popover--list">
        <input autoFocus className="markdown-input" aria-label="Search blocks" placeholder="Search blocks…" value={slash.query} onChange={(event) => setSlash({ query: event.currentTarget.value, index: 0 })} />
        {currentSlashItems.length === 0 ? <EmptyState message="No blocks found" /> : currentSlashItems.map((item, index) => <Button key={item.id} type="button" role="option" aria-selected={index === slash.index} className="markdown-option" onMouseDown={(event) => event.preventDefault()} onClick={() => void runSlash(item).catch((cause) => reportError('insert-block', cause))}>{item.group}: {item.label}</Button>)}
      </div>}

      {linkBubble && <div role="dialog" aria-label="Link actions" className="markdown-popover markdown-toolbar">
        <input className="markdown-input" aria-label="Paste or type a link" placeholder="Paste or type a link…" value={linkValue} onChange={(event) => setLinkValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveLink(); if (event.key === 'Escape') setLinkBubble(false) }} />
        <Button type="button" onClick={() => void openExternal(linkValue)}>Open link</Button>
        <Button type="button" disabled={readOnly} onClick={async () => {
          const requestScope = scope
          try {
            await navigator.clipboard.writeText(linkValue)
            if (!isCurrent(requestScope)) return
            clearError('copy-link')
            setFeedback('Copied link')
          } catch (cause) {
            if (isCurrent(requestScope)) reportError('copy-link', cause)
          }
        }}>Copy link</Button>
        <Button type="button" disabled={readOnly} onClick={() => void saveLink()}>Save link</Button>
        <Button type="button" disabled={readOnly} onClick={() => { if (!editor || readOnly) return; editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkBubble(false); void flush().catch(() => {}) }}>Remove link</Button>
        <Button type="button" onClick={() => setLinkBubble(false)}>Close</Button>
      </div>}

      {emojiOpen && <div role="dialog" aria-label="Emoji picker" className="markdown-popover markdown-popover--emoji">
        {currentEmojiRead.status === 'loading' && <div role="status"><NoticeLine>Loading native emoji picker…</NoticeLine></div>}
        {currentEmojiRead.status === 'error' && currentEmojiRead.error && <InlineError
          message={`Could not load the emoji picker: ${currentEmojiRead.error}`}
          action={{ label: 'Retry', onAction: () => { void loadEmojiPicker() } }}
          onDismiss={() => setEmojiPickerRead((previous) => previous.scope === scope ? { ...previous, status: 'idle', error: null } : previous)}
        />}
        {EmojiPicker && emojiPickerModuleLoaded && <EmojiPicker
          autoFocusSearch
          emojiStyle={emojiPickerModuleLoaded.EmojiStyle.NATIVE}
          onEmojiClick={({ emoji }) => {
            if (!isCurrent(scope) || !editor || readOnly || !emojiOpenRef.current || emojiRenderSession !== emojiSessionRef.current) return
            if (!editor.chain().focus().insertContent({ type: 'text', text: emoji }).run()) return
            closeEmoji()
            void flush().catch(() => {})
          }}
        />}
        <Button type="button" onClick={closeEmoji}>Close</Button>
      </div>}

      {tocOpen && <aside aria-label="Table of Contents" className="markdown-toc">
        <strong>Table of Contents</strong>
        <div>{[1, 2, 3, 4, 5].map((level) => <label key={level} className="markdown-check"><input type="checkbox" checked={tocLevels.has(level)} aria-label={`Show H${level}`} onChange={(event) => { const checked = event.currentTarget.checked; setTocLevels((current) => { const next = new Set(current); if (checked) next.add(level); else next.delete(level); return next }) }} />H{level}</label>)}
          {[1, 2, 3, 4, 5].map((level) => <Button key={`collapse-${level}`} type="button" onClick={() => setTocLevels(new Set([1, 2, 3, 4, 5].filter((candidate) => candidate <= level)))}>Collapse to H{level}</Button>)}
          <Button type="button" onClick={() => setTocLevels(new Set([1, 2, 3, 4, 5]))}>Expand all</Button>
        </div>
        {currentTocRead.status === 'loading' && <div role="status"><NoticeLine>Loading headings…</NoticeLine></div>}
        {currentTocRead.status === 'error' && currentTocRead.error && <InlineError
          message={currentTocRead.error}
          action={{ label: 'Retry', onAction: () => { void loadToc() } }}
        />}
        {currentTocRead.status === 'ready' && visibleToc.length === 0 && <EmptyState message="No headings" />}
        {currentTocRead.status === 'ready' && visibleToc.map((heading) => <Button key={`${heading.id}:${heading.line}`} type="button" className="markdown-toc-heading" data-level={heading.level} onClick={() => jumpToHeading(heading)}>{heading.text}</Button>)}
      </aside>}

      {feedback && <div role="status" className="markdown-status">{feedback}<Button type="button" onClick={() => setFeedback(null)}>Dismiss</Button></div>}
      {operationError?.scope === scope && <InlineError message={operationError.message} onDismiss={() => dismissError(operationError.id)} />}
      {flushError && flushErrorScope === scope && <div className="markdown-flush-failure">
        <InlineError
          message={flushError}
          action={{ label: 'Retry', onAction: () => { void flush().catch(() => {}) } }}
          onDismiss={() => setFlushError(null)}
        />
        <Button type="button" onClick={() => void openSource()}>Open source</Button>
      </div>}

      <div className="markdown-rich-layout">
        <div
          className="markdown-rich-content markdown-body--editor"
          onMouseUp={() => { if (editor) setSelection((current) => selectionForReview(editor) ? { from: editor.state.selection.from, to: editor.state.selection.to, ...selectionForReview(editor)! } : current) }}
          onPasteCapture={(event) => {
            const file = imageFileFromTransfer(event.clipboardData)
            if (file) {
              event.preventDefault()
              void importPastedImage(file)
            }
          }}
          onDragOverCapture={(event) => {
            if (imageFileFromTransfer(event.dataTransfer)) event.preventDefault()
          }}
          onDropCapture={(event) => {
            const file = imageFileFromTransfer(event.dataTransfer)
            if (file) {
              event.preventDefault()
              void importPastedImage(file)
            }
          }}
        >
          {editor
            ? <EditorContent editor={editor} />
            : <div role="status"><NoticeLine>Preparing rich editor…</NoticeLine></div>}
          {editor?.isActive('table') && <div className="markdown-toolbar markdown-toolbar--engine-actions" aria-label="Table actions">
            <Button type="button" disabled={readOnly || editor.isActive('tableHeader')} onClick={() => { if (readOnly) return; editor.chain().focus().addRowBefore().run(); void flush().catch(() => {}) }}>Insert row above</Button>
            <Button type="button" disabled={readOnly} onClick={() => { if (readOnly) return; editor.chain().focus().addRowAfter().run(); void flush().catch(() => {}) }}>Insert row below</Button>
            <Button type="button" disabled={readOnly || editor.isActive('tableHeader')} onClick={() => { if (readOnly) return; editor.chain().focus().deleteRow().run(); void flush().catch(() => {}) }}>Delete row</Button>
            <Button type="button" disabled={readOnly} onClick={() => { if (readOnly) return; editor.chain().focus().addColumnBefore().run(); void flush().catch(() => {}) }}>Insert column left</Button>
            <Button type="button" disabled={readOnly} onClick={() => { if (readOnly) return; editor.chain().focus().addColumnAfter().run(); void flush().catch(() => {}) }}>Insert column right</Button>
            <Button type="button" disabled={readOnly} onClick={() => { if (readOnly) return; editor.chain().focus().deleteColumn().run(); void flush().catch(() => {}) }}>Delete column</Button>
            <Button type="button" disabled={readOnly} onClick={() => { if (readOnly) return; editor.chain().focus().deleteTable().run(); void flush().catch(() => {}) }}>Delete table</Button>
          </div>}
          {editor?.isActive('codeBlock') && <div className="markdown-toolbar markdown-toolbar--engine-actions" aria-label="Code block actions">
            <select className="markdown-select" aria-label="Code language" disabled={readOnly} value={codeLanguage} onChange={(event) => { if (readOnly) return; editor.chain().focus().updateAttributes('codeBlock', { language: event.currentTarget.value || null }).run(); void flush().catch(() => {}) }}>
              <option value="">Plain text</option>{CODE_LANGUAGES.slice(1).map((language) => <option key={language} value={language.toLowerCase()}>{language}</option>)}
            </select>
            <Button type="button" onClick={async () => {
              const requestScope = scope
              try {
                await navigator.clipboard.writeText(codeText)
                if (!isCurrent(requestScope)) return
                clearError('copy-code')
                setFeedback('Copied code')
              } catch (cause) {
                if (isCurrent(requestScope)) reportError('copy-code', cause)
              }
            }}>Copy code</Button>
          </div>}
        </div>
        {notesOpen && <aside aria-label={`Review notes, ${visibleNotes.length} notes`} className="markdown-review-notes">
          <div className="markdown-notes-heading"><strong>Review notes ({visibleNotes.length})</strong><Button type="button" onClick={() => void loadNotes()}>Refresh</Button></div>
          <div className="markdown-toolbar markdown-toolbar--notes">
            <Button type="button" onClick={() => { if (currentSelection) { setSelection({ from: editor?.state.selection.from ?? 0, to: editor?.state.selection.to ?? 0, ...currentSelection }); setNoteEdit(null); setNoteBody(''); setNoteComposer(true) } }}>+ Add note</Button>
            <Button type="button" onClick={() => void copyNotes()}>Copy notes for agent</Button>
            <Button type="button" onClick={() => void openSendMenu()}>Send notes to</Button>
          </div>
          {currentNotesRead.status === 'loading' && <div role="status"><NoticeLine>Loading review notes…</NoticeLine></div>}
          {currentNotesRead.status === 'error' && currentNotesRead.error && <InlineError
            message={currentNotesRead.error}
            action={{ label: 'Retry', onAction: () => { void loadNotes() } }}
          />}
          {currentNotesRead.status === 'ready' && visibleNotes.length === 0 && <EmptyState message="No review notes." />}
          {sendMenu && <div role="dialog" aria-label="Send notes to" className="markdown-popover markdown-popover--form">
            {currentSendRead.status === 'loading' && <div role="status"><NoticeLine>Loading note destinations…</NoticeLine></div>}
            {currentSendRead.status === 'error' && currentSendRead.error && <InlineError
              message={currentSendRead.error}
              action={{ label: 'Retry', onAction: () => { void loadSendTargets(sendSessionRef.current) } }}
            />}
            {currentSendRead.status === 'ready' && agentTargets.sessions.length === 0 && agentTargets.agents.length === 0 && <EmptyState message="No note destinations available." />}
            {currentSendRead.status === 'ready' && <>
              <label className="markdown-field">Running agent<select className="markdown-select" value={sendTarget} onChange={(event) => setSendTarget(event.currentTarget.value)}><option value="">Choose a running agent</option>{agentTargets.sessions.map((session) => <option key={session.id} value={session.id}>{session.agent} · {session.title}</option>)}</select></label>
              <Button type="button" disabled={!sendTarget} onClick={() => void sendNotes('existing')}>Send</Button>
              <label className="markdown-field">New agent<select className="markdown-select" value={sendAgent} onChange={(event) => setSendAgent(event.currentTarget.value)}><option value="">Choose an agent</option>{agentTargets.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></label>
              <Button type="button" disabled={!sendAgent} onClick={() => void sendNotes('new')}>New agent</Button>
            </>}
            <Button type="button" onClick={closeSendMenu}>Cancel</Button>
          </div>}
          {noteComposer && <div role="dialog" aria-label="Add note for the AI" className="markdown-popover markdown-popover--form">
            <p>{selection?.text ? `Selected text: ${selection.text}` : 'Add note for the AI'}</p>
            <textarea ref={noteInput} className="markdown-textarea" aria-label="Add note for the AI" rows={3} maxLength={MAX_NOTE_BODY_BYTES} value={noteBody} onChange={(event) => setNoteBody(event.currentTarget.value)} />
            <Button type="button" onClick={() => void addNote()}>{noteEdit ? 'Save note' : 'Add note'}</Button>
            <Button type="button" onClick={() => { setNoteComposer(false); setNoteEdit(null); setNoteBody('') }}>Cancel</Button>
          </div>}
          {currentNotesRead.status === 'ready' && visibleNotes.map((note) => <article key={note.id} className="markdown-note">
            <small>{note.startLine === note.endLine ? `Line ${note.lineNumber}` : `Lines ${note.startLine}-${note.endLine}`}</small>
            {note.selectedText && <blockquote className="markdown-note__selection">{note.selectedText}</blockquote>}
            <p>{note.body}</p>
            <Button type="button" onClick={() => { setNoteEdit(note.id); setNoteBody(note.body); setNoteComposer(true) }}>Edit</Button>
            <Button type="button" onClick={async () => {
              const requestScope = scope
              try {
                await call(NOTES_METHOD, { action: 'delete', noteId: note.id })
                if (!isCurrent(requestScope)) return
                clearError('note-delete')
                await loadNotes()
              } catch (cause) {
                if (isCurrent(requestScope)) reportError('note-delete', cause)
              }
            }}>Delete</Button>
          </article>)}
        </aside>}
      </div>
    </div>
  )
}

export function MarkdownSurface(props: SurfaceProps): React.JSX.Element {
  const identity = JSON.stringify([props.buffer.id, props.buffer.tabId, props.buffer.path, props.buffer.worktreeId, props.buffer.mode])
  if (props.buffer.mode === 'source') return <SourceSurface key={identity} props={props} />
  if (props.buffer.mode === 'preview') return <PreviewSurface key={identity} props={props} />
  return <RichSurface key={identity} props={props} />
}
