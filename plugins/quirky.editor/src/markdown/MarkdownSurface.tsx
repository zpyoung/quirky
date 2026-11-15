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
import { requestEditorUiControl, useEditorUiControl, type EditorUiControl, type EditorUiControlActions } from '../window/uiControl'

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
const FORMAT_VALUES: readonly MarkdownFormat[] = ['body', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'bold', 'italic', 'strike', 'bulletList', 'orderedList', 'taskList', 'quote', 'link', 'image', 'details', 'codeBlock', 'table', 'divider', 'mermaid', 'inlineMath', 'blockMath', 'emoji']
const MORE_FORMATS = ['heading4', 'heading5', 'details', 'codeBlock', 'table', 'divider', 'mermaid', 'inlineMath', 'blockMath', 'emoji']
const sourceValue = (buffer: SurfaceProps['buffer']) => buffer.draft !== null ? buffer.draft : buffer.content

function methodParams(bufferId: string, params: Record<string, unknown>): Record<string, unknown> {
  return { bufferId, ...params }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function useMarkdownSession(buffer: SurfaceProps['buffer'], acknowledged?: React.RefObject<number>, localDraft?: React.RefObject<string | null>) {
  const identity = JSON.stringify([buffer.id, buffer.tabId, buffer.path, buffer.relativePath, buffer.worktreeId, buffer.mode])
  const source = sourceValue(buffer)
  const previous = useRef<{ identity: string; source: string; scope: string } | null>(null)
  if (!previous.current || previous.current.identity !== identity ||
    (previous.current.source !== source && acknowledged?.current !== buffer.contentRevision && localDraft?.current !== source)) {
    previous.current = { identity, source, scope: crypto.randomUUID() }
  } else previous.current.source = source
  const scope = previous.current.scope
  const scopeRef = useRef(scope)
  const activeRef = useRef(true)
  scopeRef.current = scope
  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])
  const isCurrent = useCallback((expected: string) => activeRef.current && scopeRef.current === expected, [])
  return { scope, isCurrent }
}

function controlData(data: unknown, allowed: readonly string[], required: readonly string[] = []): data is Record<string, unknown> {
  return data !== null && typeof data === 'object' && !Array.isArray(data) &&
    Reflect.ownKeys(data).every((key) => typeof key === 'string' && allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(data, key))
}

function useMarkdownControl(
  props: SurfaceProps, kind: string, generation: string, active: boolean, actions: string[],
  handler: (control: EditorUiControl) => Promise<boolean | void> | boolean | void,
  onError: (error: Error) => void
) {
  const address = active && actions.length > 0 ? {
    surface: 'view:quirky.editor/document',
    target: `markdown-${kind}:${JSON.stringify([props.buffer.id, props.buffer.tabId])}`,
    generation, actions
  } : null
  const origin = useRef(address)
  const errorHandler = useRef(onError)
  const mounted = useRef(true)
  origin.current = address
  errorHandler.current = onError
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const registration = useEditorUiControl({
    context: props.context, address,
    async handler(control) {
      try { return { delivered: await handler(control) !== false } }
      catch (cause) { onError(cause instanceof Error ? cause : new Error(errorText(cause))); throw cause }
    },
    onError
  })
  async function run(action: string, data?: Record<string, unknown>) {
    const current = origin.current
    if (!current || !current.actions.includes(action) || !registration.isCurrent()) return { delivered: false }
    const args: EditorUiControl = { surface: current.surface, target: current.target, generation: current.generation, action, ...(data === undefined ? {} : { data }) }
    const live = () => mounted.current && origin.current?.generation === current.generation && origin.current?.target === current.target
    try {
      const result = await requestEditorUiControl(props.context, args)
      if (!result.delivered && live()) errorHandler.current(new Error('The editor control is no longer available.'))
      return result
    } catch (cause) {
      if (live()) errorHandler.current(cause instanceof Error ? cause : new Error(errorText(cause)))
      return { delivered: false }
    }
  }
  return { run, isCurrent: registration.isCurrent }
}

function useMarkdownPopup(scope: string, open: boolean, context: unknown = null) {
  const [, update] = useState(0)
  const ref = useRef<{ scope: string; open: boolean; context: unknown; generation: string } | null>(null)
  if (!ref.current || ref.current.scope !== scope || ref.current.open !== open || ref.current.context !== context) {
    ref.current = { scope, open, context, generation: crypto.randomUUID() }
  }
  const generation = ref.current.generation
  return {
    generation,
    isCurrent: () => ref.current?.generation === generation && ref.current.open,
    invalidate() { if (ref.current) ref.current = { ...ref.current, generation: crypto.randomUUID() }; update((value) => value + 1) }
  }
}

function updateMarkdownView(props: SurfaceProps, patch: Record<string, unknown>) {
  return props.context.call('quirky.editor/view', {
    bufferId: props.buffer.id, ...(props.buffer.tabId === null ? {} : { tabId: props.buffer.tabId }),
    action: 'update', patch
  })
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
  onOpenLink,
  markdownAnchor,
  onView,
  onMissingAnchor,
  articleRef
}: {
  source: string
  sourceOffset: number
  searchMatch: { from: number; to: number } | null
  imageUrls: Readonly<Record<string, string>>
  onOpenLink(href: string, event: React.MouseEvent<HTMLAnchorElement>): void
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
              ? <a href={href.startsWith('#') ? `#${previewHeadingId(source, href.slice(1)) ?? href.slice(1)}` : href} rel="noopener noreferrer" onClick={(event) => onOpenLink(href, event)}>{children}</a>
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
  const localDraft = useRef<string | null>(null)
  const { scope, isCurrent } = useMarkdownSession(props.buffer, undefined, localDraft)
  const [read, setRead] = useState<{ scope: string; status: 'loading' | 'ready' | 'error'; eligibility: { richEligible: boolean; reason: string | null; openAnywayAvailable: boolean } | null; error: string | null }>({
    scope,
    status: 'loading',
    eligibility: null,
    error: null
  })
  const [actionError, setActionError] = useState<{ scope: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const readRequest = useRef(0)
  const currentRead = read.scope === scope ? read : { scope, status: 'loading' as const, eligibility: null, error: null }

  const refresh = useCallback(async (raise = false) => {
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
      if (raise) throw cause
    }
  }, [isCurrent, props.buffer.contentRevision, props.buffer.draft, props.buffer.id, props.context, scope])

  useEffect(() => {
    void refresh()
    return () => { readRequest.current += 1 }
  }, [refresh])

  const busyRef = useRef(false)
  useEffect(() => { busyRef.current = false; setBusy(false) }, [scope])
  const eligibility = currentRead.eligibility
  const error = actionError?.scope === scope ? actionError.message : currentRead.error
  const canOverride = eligibility?.reason?.includes('600') && eligibility.openAnywayAvailable
  const controls = useMarkdownControl(props, 'source', scope, true, [
    'preview', ...(eligibility?.richEligible || canOverride ? ['rich'] : []),
    ...(currentRead.status === 'error' ? ['retry'] : []), ...(error ? ['dismiss-error'] : [])
  ], async ({ action, data = {} }) => {
    if (!isCurrent(scope) || !controlData(data, action === 'rich' ? ['openAnyway'] : []) ||
      (Object.hasOwn(data, 'openAnyway') && typeof data.openAnyway !== 'boolean')) return false
    if (action === 'dismiss-error') {
      if (actionError?.scope === scope) setActionError(null)
      else setRead((value) => ({ ...value, error: null, status: 'ready' }))
      return
    }
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    try {
      if (action === 'retry') {
        const previousError = actionError
        await refresh(true)
        if (isCurrent(scope)) setActionError(value => value === previousError ? null : value)
      }
      else if (action === 'preview') {
        await props.context.call('quirky.editor/open', { worktree: `id:${props.buffer.worktreeId}`, path: props.buffer.relativePath, mode: 'preview', focus: false })
      } else if (action === 'rich') {
        const openAnyway = data.openAnyway === true
        if (openAnyway ? !canOverride : !eligibility?.richEligible) return false
        const raw = await props.context.call(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities', openAnyway }))
        if (!isCurrent(scope)) return
        if (!raw || typeof raw !== 'object' || !('richEligible' in raw) || raw.richEligible !== true) {
          throw new Error('This document cannot be safely opened in rich mode. Continue editing in source mode.')
        }
        await updateMarkdownView(props, { mode: 'rich', markdownOpenAnyway: openAnyway })
        if (isCurrent(scope)) setActionError(value => value === actionError ? null : value)
      } else return false
    } catch (cause) {
      if (isCurrent(scope) && action !== 'retry') setActionError({ scope, message: errorText(cause) })
      throw cause
    } finally {
      if (isCurrent(scope)) { busyRef.current = false; setBusy(false) }
    }
  }, (cause) => { if (isCurrent(scope)) setActionError({ scope, message: cause.message }) })

  return (
    <div className="markdown-surface markdown-surface--source">
      <div className="markdown-toolbar">
        {eligibility?.richEligible
          ? <Button type="button" disabled={busy} onClick={() => { void controls.run('rich') }}>Rich Editor</Button>
          : eligibility?.reason?.includes('600') && eligibility.openAnywayAvailable
            ? <Button type="button" disabled={busy} onClick={() => { void controls.run('rich', { openAnyway: true }) }}>Open anyway</Button>
            : currentRead.status === 'ready' && eligibility && <span>Rich editing unavailable</span>}
        <Button type="button" disabled={busy} onClick={() => { void controls.run('preview') }}>Open Markdown Preview</Button>
        <span>Source mode</span>
        {eligibility?.reason && <span role="status" className="markdown-inline-status">{eligibility.reason}</span>}
      </div>
      {currentRead.status === 'loading' && <div role="status" className="markdown-status"><NoticeLine>Checking rich editor availability…</NoticeLine></div>}
      {error && <InlineError message={error}
        action={currentRead.status === 'error' ? { label: 'Retry', onAction: () => { void controls.run('retry') } } : undefined}
        onDismiss={() => { void controls.run('dismiss-error') }}
      />}
      <textarea
        aria-label="Markdown source"
        spellCheck
        value={content}
        readOnly={props.buffer.readOnly}
        onChange={(event) => { localDraft.current = event.currentTarget.value; props.onDraft(event.currentTarget.value) }}
        className="markdown-source"
      />
    </div>
  )
}

function PreviewSurface({ props }: { props: SurfaceProps }): React.JSX.Element {
  const revision = useRef(props.buffer.contentRevision)
  const { scope, isCurrent } = useMarkdownSession(props.buffer, revision)
  const [previewRead, setPreviewRead] = useState<{
    scope: string
    status: 'loading' | 'ready' | 'error'
    preview?: { html?: string; imageUrls: Record<string, string> }
    error?: string
  }>({ scope, status: 'loading' })
  const currentPreviewRead = previewRead.scope === scope ? previewRead : { scope, status: 'loading' as const, error: undefined }
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
  const searchPopup = useMarkdownPopup(scope, searchOpen)
  const writes = useRef<symbol | null>(null)

  const refresh = useCallback(async (raise = false) => {
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
      if (raise) throw cause
    }
  }, [isCurrent, props.buffer.id, props.buffer.contentRevision, props.buffer.draft, props.onAction, scope])

  useEffect(() => {
    void refresh()
    return () => {
      previewRequest.current += 1
      void props.context.call(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities', releaseImages: true })).catch(() => {})
    }
  }, [props.buffer.id, props.context, refresh])

  const openLink = useCallback(async (href: string, event?: LinkModifiers) => {
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
      throw cause
    }
  }, [isCurrent, props.buffer.id, props.buffer.worktreeId, props.context, props.onAction, props.onView, scope])

  const movePreviewSearch = useCallback((delta: number) => {
    if (searchScope !== scope || !searchResult || searchResult.matches.length === 0) return
    const next = (searchIndex + delta + searchResult.matches.length) % searchResult.matches.length
    setSearchIndex(next)
  }, [scope, searchIndex, searchResult, searchScope])

  const replacePreview = useCallback(async (all: boolean, requestedQuery = query, text = replaceText) => {
    searchRequest.current += 1
    const requestScope = scope
    if (requestedQuery === '') throw new Error('query is required for Markdown replace.')
    if (utf8Bytes(requestedQuery) > 2048) throw new Error('Markdown find queries are limited to 2 KiB.')
    const popupGeneration = searchPopup.generation
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, {
        action: 'replace',
        expectedRevision: revision.current,
        query: requestedQuery,
        text,
        matchCase,
        wholeWord,
        all
      })) as { replacements?: number; buffer?: SurfaceProps['buffer'] }
      if (!isCurrent(requestScope) || !searchPopup.isCurrent() || searchPopup.generation !== popupGeneration) return
      if (result.buffer) revision.current = result.buffer.contentRevision
      setSearchScope(requestScope)
      setSearchResult(null)
      setSearchStatus('idle')
      setFeedback(`${result.replacements ?? 0} replacement(s)`)
    } catch (cause) {
      if (isCurrent(requestScope) && searchPopup.isCurrent()) setActionError(errorText(cause))
      throw cause
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
      throw cause
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
      searchOpener.current ??= opener instanceof HTMLElement ? opener : null
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
      await updateMarkdownView(props, { mode: 'source' })
    } catch (cause) {
      if (isCurrent(requestScope)) setActionError(errorText(cause))
      throw cause
    }
  }, [isCurrent, props.buffer.id, props.context, scope])
  const reportMissingAnchor = useCallback((anchor: string) => {
    if (isCurrent(scope)) setActionError(`No Markdown preview heading or HTML anchor matches “${anchor}”.`)
  }, [isCurrent, scope])

  useEffect(() => { writes.current = null; searchRequest.current += 1; setSearchOpen(false) }, [scope])
  async function handlePreviewControl({ action, data = {} }: EditorUiControl) {
    if (!isCurrent(scope)) return false
    if (action === 'find' || action === 'replace') {
      if (!controlData(data, ['query']) || (Object.hasOwn(data, 'query') && typeof data.query !== 'string')) return false
      await openSearch(action === 'replace', data, searchOpener.current ?? document.activeElement)
    } else if (action === 'open-link') {
      if (!controlData(data, ['target', 'modifier', 'shift'], ['target']) || typeof data.target !== 'string' ||
        (Object.hasOwn(data, 'modifier') && typeof data.modifier !== 'boolean') ||
        (Object.hasOwn(data, 'shift') && typeof data.shift !== 'boolean')) return false
      await openLink(data.target, {
        metaKey: CHORD_PLATFORM === 'darwin' && data.modifier === true,
        ctrlKey: CHORD_PLATFORM !== 'darwin' && data.modifier === true, shiftKey: data.shift === true
      })
    } else {
      if (!controlData(data, [])) return false
      if (action === 'dismiss-error') {
        if (actionError) setActionError(null)
        else setPreviewRead((value) => ({ ...value, error: undefined }))
      } else if (action === 'dismiss-feedback') setFeedback(null)
      else if (action === 'source') await openSource()
      else if (action === 'retry') {
        const previousError = actionFailure
        await refresh(true)
        if (isCurrent(scope)) setActionFailure(value => value === previousError ? null : value)
      }
      else if (action === 'export-pdf') {
        if (writes.current) return false
        const token = Symbol()
        writes.current = token
        try { await exportPdf() } finally { if (writes.current === token) writes.current = null }
      } else return false
    }
  }
  const controls = useMarkdownControl(props, 'preview', scope, true,
    ['retry', 'source', 'export-pdf', 'find', 'replace', 'open-link', 'dismiss-error', 'dismiss-feedback'],
    handlePreviewControl, (cause) => { if (isCurrent(scope)) setActionError(cause.message) })
  const searchControls = useMarkdownControl(props, 'search', searchPopup.generation, searchOpen,
    ['find', 'previous', 'next', 'close', 'replace-toggle', 'options', ...(!props.buffer.readOnly ? ['replace-one', 'replace-all'] : [])],
    async ({ action, data = {} }) => {
      if (!isCurrent(scope) || !searchPopup.isCurrent()) return false
      if (action === 'find') {
        if (!controlData(data, ['query']) || (Object.hasOwn(data, 'query') && typeof data.query !== 'string')) return false
        await openSearch(replaceOpen, { query: data.query ?? query })
      } else if (action === 'options') {
        if (!controlData(data, ['matchCase', 'wholeWord']) || !Object.keys(data).length ||
          Object.values(data).some((value) => typeof value !== 'boolean')) return false
        searchRequest.current += 1
        setSearchResult(null); setSearchStatus('idle')
        if (typeof data.matchCase === 'boolean') setMatchCase(data.matchCase)
        if (typeof data.wholeWord === 'boolean') setWholeWord(data.wholeWord)
      } else if (action === 'replace-toggle') {
        if (!controlData(data, ['open'], ['open']) || typeof data.open !== 'boolean') return false
        setReplaceOpen(data.open)
      } else if (action === 'replace-one' || action === 'replace-all') {
        if (props.buffer.readOnly || !controlData(data, ['query', 'text']) ||
          Object.values(data).some((value) => typeof value !== 'string') || writes.current) return false
        const token = Symbol()
        writes.current = token
        try { await replacePreview(action === 'replace-all', data.query as string | undefined, data.text as string | undefined) }
        finally { if (writes.current === token) writes.current = null }
      } else {
        if (!controlData(data, [])) return false
        if (action === 'close') { searchPopup.invalidate(); closeSearch() }
        else if (action === 'previous') movePreviewSearch(-1)
        else if (action === 'next') movePreviewSearch(1)
        else return false
      }
    }, (cause) => { if (isCurrent(scope) && searchPopup.isCurrent()) setActionError(cause.message) })

  return (
    <div
      className="markdown-surface markdown-surface--preview"
      style={{ fontSize: props.fontSize }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== 'Escape' || !searchOpen) return
        event.preventDefault()
        event.stopPropagation()
        void searchControls.run('close')
      }}
    >
      <div className="markdown-toolbar">
        <Button type="button" onClick={() => { void controls.run('source') }}>Source</Button>
        <Button type="button" onClick={(event) => { if (!searchOpen) searchOpener.current = event.currentTarget; void (searchOpen ? searchControls.run('close') : controls.run('find')) }}>Find in preview</Button>
        <Button type="button" onClick={() => { void controls.run('export-pdf') }}>Export as PDF</Button>
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
        }} onKeyDown={(event) => { if (event.key === 'Enter') void searchControls.run('find', { query }) }} />
        <label className="markdown-check"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={(event) => { void searchControls.run('options', { matchCase: event.currentTarget.checked }) }} /> Match case</label>
        <label className="markdown-check"><input type="checkbox" aria-label="Match whole word" checked={wholeWord} onChange={(event) => { void searchControls.run('options', { wholeWord: event.currentTarget.checked }) }} /> Match whole word</label>
        <Button type="button" onClick={() => { void searchControls.run('find', { query }) }}>Find</Button>
        <Button type="button" onClick={() => { void searchControls.run('previous') }}>Previous</Button>
        <Button type="button" onClick={() => { void searchControls.run('next') }}>Next</Button>
        <Button type="button" onClick={() => { void searchControls.run('replace-toggle', { open: !replaceOpen }) }}>Replace</Button>
        {replaceOpen && <><input className="markdown-input" aria-label="Replace with" value={replaceText} onChange={(event) => setReplaceText(event.currentTarget.value)} /><Button type="button" disabled={props.buffer.readOnly} onClick={() => { void searchControls.run('replace-one', { query, text: replaceText }) }}>Replace</Button><Button type="button" disabled={props.buffer.readOnly} onClick={() => { void searchControls.run('replace-all', { query, text: replaceText }) }}>Replace all</Button></>}
        {searchStatus === 'loading' && searchScope === scope && <div role="status"><NoticeLine>Searching preview…</NoticeLine></div>}
        {searchStatus === 'ready' && searchScope === scope && searchResult?.total === 0 && <EmptyState message="No results" />}
        {searchStatus === 'ready' && searchScope === scope && searchResult && searchResult.total > 0 && <span>{searchIndex + 1} of {searchResult.total}</span>}
        <Button type="button" onClick={() => { void searchControls.run('close') }}>Close</Button>
      </div>}
      {feedback && <div role="status" className="markdown-status">{feedback}<Button type="button" onClick={() => { void controls.run('dismiss-feedback') }}>Dismiss</Button></div>}
      {currentPreviewRead.status === 'loading' && <div role="status" className="markdown-status"><NoticeLine>Preparing preview…</NoticeLine></div>}
      {(actionError || currentPreviewRead.status === 'error' && currentPreviewRead.error) && <div className="markdown-preview-failure">
        <InlineError
          message={actionError ?? currentPreviewRead.error ?? ''}
          action={currentPreviewRead.status === 'error' ? { label: 'Retry', onAction: () => { void controls.run('retry') } } : undefined}
          onDismiss={() => { void controls.run('dismiss-error') }}
        />
        <Button type="button" onClick={() => { void controls.run('source') }}>Open source</Button>
      </div>}
      {currentPreviewRead.status === 'ready' && preview && <MarkdownPreview
        source={split.body}
        sourceOffset={split.prefix.length}
        searchMatch={activeSearchMatch}
        imageUrls={preview.imageUrls}
        onOpenLink={(href, event) => { event.preventDefault(); void controls.run('open-link', { target: href, modifier: CHORD_PLATFORM === 'darwin' ? event.metaKey : event.ctrlKey, shift: event.shiftKey }) }}
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
  const revision = useRef(buffer.contentRevision)
  const { scope, isCurrent } = useMarkdownSession(buffer, revision)
  const split = markdownSource(buffer)
  const source = sourceValue(buffer)
  const extensions = useMemo(() => [...createMarkdownExtensions(), RichSearchHighlight], [])
  const readOnly = buffer.readOnly
  const [flushError, setFlushError] = useState<string | null>(null)
  const [flushErrorScope, setFlushErrorScope] = useState(scope)
  const flushFailure = useRef<string | null>(null)
  const reportFlushError = useCallback((message: string) => {
    flushFailure.current = message
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composition = useRef(false)
  const docQueryRef = useRef<string | null>(null)
  const docRangeRef = useRef<{ from: number; to: number } | null>(null)
  const docRequestRef = useRef(0)
  const docScopeRef = useRef(scope)
  const flushRef = useRef<() => Promise<void>>(async () => {})
  const editorRef = useRef<Editor | null>(null)
  const updateCompletionsRef = useRef<(current: Editor) => void>(() => {})
  const runSlashRef = useRef<EditorUiControlActions | null>(null)
  const chooseDocumentRef = useRef<EditorUiControlActions | null>(null)
  const openExternalRef = useRef<EditorUiControlActions | null>(null)
  const slashRef = useRef<typeof slash>(slash)
  const docMenuRef = useRef<typeof docMenu>(docMenu)
  const [, renderEngine] = useState(0)
  const selectionRun = useRef<EditorUiControlActions | null>(null)
  const linkContext = useRef<{ doc: Editor['state']['doc']; from: number; to: number } | null>(null)

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
          void selectionRun.current?.run('format', { value: 'strike' })
          return true
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          void selectionRun.current?.run('format', { value: 'link' })
          return true
        }
        if (event.key === 'Escape' && docMenuRef.current) {
          event.preventDefault()
          void chooseDocumentRef.current?.run('close')
          return true
        }
        if (event.key === 'Escape' && slashRef.current) {
          event.preventDefault()
          void runSlashRef.current?.run('close')
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
            if (item) void runSlashRef.current?.run('choose', { id: item.id })
            return true
          }
        }
        const currentDocs = docMenuRef.current
        if (currentDocs && currentDocs.items.length > 0 && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
          event.preventDefault()
          if (event.key === 'Enter' || event.key === 'Tab') {
            const selected = currentDocs.items[currentDocs.index]
            if (selected) void chooseDocumentRef.current?.run('choose', { path: selected.relativePath })
          } else {
            const delta = event.key === 'ArrowDown' ? 1 : -1
            setDocMenu({ ...currentDocs, index: (currentDocs.index + delta + currentDocs.items.length) % currentDocs.items.length })
          }
          return true
        }
        if (event.key === 'Tab' && currentEditor?.isActive('codeBlock')) {
          event.preventDefault()
          void selectionRun.current?.run('code-indent', { outdent: event.shiftKey })
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
            void openExternalRef.current?.run('open-link', { target, modifier: CHORD_PLATFORM === 'darwin' ? event.metaKey : event.ctrlKey, shift: event.shiftKey })
            return true
          }
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey) return false
          const href = event.target.closest('a[href]')?.getAttribute('href')
          if (!href) return false
          event.preventDefault()
          void openExternalRef.current?.run('open-link', { target: href, modifier: CHORD_PLATFORM === 'darwin' ? event.metaKey : event.ctrlKey, shift: event.shiftKey })
          return true
        }
      }
    },
    onCreate: ({ editor: current }) => { renderEngine((value) => value + 1); updateCompletionsRef.current(current) },
    onUpdate: ({ editor: current }) => {
      renderEngine((value) => value + 1)
      const markdown = current.getMarkdown()
      pendingText.current = markdown
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flushRef.current().catch(() => {}), 300)
      updateCompletionsRef.current(current)
    },
    onSelectionUpdate: ({ editor: current }) => {
      renderEngine((value) => value + 1)
      const review = selectionForReview(current)
      if (review) setSelection({ from: current.state.selection.from, to: current.state.selection.to, ...review })
      else setSelection(null)
      updateCompletionsRef.current(current)
      if (current.isActive('link')) {
        linkContext.current = { doc: current.state.doc, from: current.state.selection.from, to: current.state.selection.to }
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
      if (!isCurrent(requestScope) || markdown === lastAcknowledged.current) return
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
        flushFailure.current = null
        setFlushError(null)
        setFlushErrorScope(requestScope)
      } catch (cause) {
        if (isCurrent(requestScope)) {
          flushFailure.current = errorText(cause)
          setFlushError(errorText(cause))
          setFlushErrorScope(requestScope)
        }
        throw cause
      }
    })
    queue.current = work.catch(() => {})
    await work
  }, [buffer.id, editor, isCurrent, onAction, openAnyway, scope])
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

  const loadEligibility = useCallback(async (raise = false) => {
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
      if (raise) throw cause
    }
  }, [buffer.draft, buffer.id, isCurrent, onAction, openAnyway, scope])
  useEffect(() => {
    void loadEligibility()
    return () => { eligibilityRequestRef.current += 1 }
  }, [loadEligibility])

  const call = useCallback((method: string, params: Record<string, unknown> = {}) => onAction(method, methodParams(buffer.id, params)), [buffer.id, onAction])

  const loadNotes = useCallback(async (raise = false) => {
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
      if (raise) throw cause
    }
  }, [call, isCurrent, scope])
  useEffect(() => {
    void loadNotes()
    return () => { notesRequestRef.current += 1 }
  }, [loadNotes])

  const loadToc = useCallback(async (raise = false) => {
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
      if (raise) throw cause
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

  const applyFormat = useCallback(async (item: Pick<SlashItem, 'format' | 'id'>, removeTrigger = false) => {
    if (!editor || readOnly) return
    if (removeTrigger) {
      const current = editor.state.selection.from
      const before = editor.state.selection.$from.parent.textContent.slice(0, editor.state.selection.$from.parentOffset)
      const trigger = /^\s*\/([a-z0-9-]*)$/i.exec(before)
      if (!trigger) return
      editor.chain().focus().deleteRange({ from: current - trigger[1]!.length - 1, to: current }).run()
      setSlash(null)
    }
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
      linkContext.current = { doc: editor.state.doc, from: editor.state.selection.from, to: editor.state.selection.to }
      setLinkValue(String(editor.getAttributes('link').href ?? ''))
      setLinkBubble(true)
    }
    await flush()
  }, [editor, flush, importImage, openEmoji, readOnly])

  const chooseDocument = useCallback(async (path: string) => {
    const menu = docMenuRef.current
    const range = docRangeRef.current
    if (!editor || !menu || !range || readOnly || composition.current) return
    if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || /[\r\n\[\]|]/.test(path)) {
      throw new Error('The selected document target is unsafe.')
    }
    const target = documentLinkTarget(buffer.relativePath, path)
    if (target === '' || /[\r\n\[\]|]/.test(target)) {
      throw new Error('The selected document target is unsafe.')
    }
    editor.chain().focus().insertContentAt(range, {
      type: 'markdownDocumentLink',
      attrs: { target, label: target }
    }).run()
    docRequestRef.current += 1
    docQueryRef.current = null
    docRangeRef.current = null
    setDocMenu(null)
    await flush()
  }, [buffer.relativePath, editor, flush, readOnly, reportError])

  function insertToolbarFormat(format: MarkdownFormat) { void selectionControls.run('format', { value: format }) }

  

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
      searchOpener.current ??= opener instanceof HTMLElement ? opener : null
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
      throw cause
    }
  }, [buffer.worktreeId, checkLink, clearError, context, isCurrent, onView, reportError, scope])

  

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
    const selected = editor ? selectionForReview(editor) : null
    if (!selected || readOnly || !isCurrent(scope)) throw new Error('Select Markdown text before adding a review note.')
    setSelection({ from: editor!.state.selection.from, to: editor!.state.selection.to, ...selected })
    setNoteEdit(null)
    setNoteBody('')
    setNoteComposer(true)
    setNotesOpen(true)
    window.requestAnimationFrame(() => noteInput.current?.focus())
    return { opened: true, startLine: selected.startLine, endLine: selected.endLine }
  }, [editor, isCurrent, readOnly, scope])
  const copyMarkdownContext = useCallback(async () => {
    const selected = editor ? selectionForReview(editor) : null
    if (!selected || !isCurrent(scope)) throw new Error('Select Markdown text before copying context.')
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.')
    const lines = selected.startLine === selected.endLine ? `${selected.startLine}` : `${selected.startLine}-${selected.endLine}`
    await navigator.clipboard.writeText(`${buffer.relativePath}:${lines}\n${selected.text}`)
    return { copied: true, path: buffer.relativePath, lines }
  }, [buffer.relativePath, editor, isCurrent, scope])
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
      throw cause
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
      throw cause
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
      throw cause
    }
  }, [buffer.relativePath, buffer.worktreeId, clearError, context, flush, isCurrent, reportError, scope])

  const openSource = useCallback(async () => {
    const requestScope = scope
    await flush().catch(() => {})
    if (!isCurrent(requestScope)) return
    try {
      await updateMarkdownView(props, { mode: 'source' })
      clearError('open-source')
    } catch (cause) {
      if (isCurrent(requestScope)) reportError('open-source', cause)
      throw cause
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

  const selectionDoc = editor?.state.doc
  const selectionFrom = editor?.state.selection.from
  const selectionTo = editor?.state.selection.to
  const selectionGeneration = useMemo(() => crypto.randomUUID(), [scope, editor, selectionDoc, selectionFrom, selectionTo])
  const searchPopup = useMarkdownPopup(scope, searchOpen)
  const morePopup = useMarkdownPopup(scope, moreOpen, selectionGeneration)
  const slashPopup = useMarkdownPopup(scope, slash !== null, `${slash?.query}:${selectionFrom}:${selectionTo}`)
  const documentsPopup = useMarkdownPopup(scope, docMenu?.scope === scope, `${docMenu?.query}:${docMenu?.from}:${docMenu?.to}`)
  const linkPopup = useMarkdownPopup(scope, linkBubble, selectionGeneration)
  const emojiPopup = useMarkdownPopup(scope, emojiOpen, selectionGeneration)
  const controlBusy = useRef<{ scope: string; token: symbol } | null>(null)
  const currentBuffer = useRef(buffer)
  currentBuffer.current = buffer
  function selectionIsCurrent() {
    return isCurrent(scope) && editorRef.current === editor && !editor?.isDestroyed &&
      editor?.state.doc === selectionDoc && editor?.state.selection.from === selectionFrom && editor?.state.selection.to === selectionTo
  }
  useEffect(() => {
    setSearchOpen(false); setMoreOpen(false); setSlash(null); setDocMenu(null); setLinkBubble(false)
    closeEmoji(); closeTemplates(); closeSendMenu()
    setNoteComposer(false); setNoteEdit(null); setNoteBody(''); setFeedback(null)
  }, [scope])
  function popupFor(kind: string) {
    if (kind === 'search') return searchPopup
    if (kind === 'more') return morePopup
    if (kind === 'slash') return slashPopup
    if (kind === 'documents') return documentsPopup
    if (kind === 'link') return linkPopup
    if (kind === 'emoji') return emojiPopup
    return null
  }
  async function handleMarkdownControl(kind: string, { action, data = {} }: EditorUiControl) {
    const popup = popupFor(kind)
    const live = () => isCurrent(scope) && (!popup || popup.isCurrent())
    if (!live()) return false
    if (kind === 'search') {
      if (action === 'find') {
        if (!controlData(data, ['query']) || (Object.hasOwn(data, 'query') && typeof data.query !== 'string')) return false
        await openSearch(searchReplace, { query: data.query ?? searchQuery }); return
      }
      if (action === 'options') {
        if (!controlData(data, ['matchCase', 'wholeWord']) || !Object.keys(data).length || Object.values(data).some(value => typeof value !== 'boolean')) return false
        if (typeof data.matchCase === 'boolean') setMatchCase(data.matchCase)
        if (typeof data.wholeWord === 'boolean') setWholeWord(data.wholeWord)
        setSearchResult(null); if (editor) revealRichSearchMatch(editor, null); return
      }
      if (action === 'replace-toggle') {
        if (!controlData(data, ['open'], ['open']) || typeof data.open !== 'boolean') return false
        setSearchReplace(data.open); return
      }
      if (['previous', 'next', 'close'].includes(action)) {
        if (!controlData(data, [])) return false
        if (action === 'close') { searchPopup.invalidate(); closeSearch() }
        else moveSearch(action === 'previous' ? -1 : 1)
        return
      }
      if (!['replace-one', 'replace-all'].includes(action) || readOnly || !controlData(data, ['query', 'text']) || Object.values(data).some(value => typeof value !== 'string')) return false
    } else if (kind === 'selection') {
      if (!editor || !selectionIsCurrent()) return false
      if (action === 'format') {
        if (readOnly || !controlData(data, ['value'], ['value']) || typeof data.value !== 'string' || !FORMAT_VALUES.includes(data.value as MarkdownFormat)) return false
      } else if (action === 'table') {
        if (readOnly || !controlData(data, ['operation'], ['operation']) || typeof data.operation !== 'string' || !editor.isActive('table') ||
          !['row-above','row-below','row-delete','column-left','column-right','column-delete','delete'].includes(data.operation) ||
          (editor.isActive('tableHeader') && ['row-above','row-delete'].includes(data.operation))) return false
      } else if (action === 'code-language') {
        if (readOnly || !editor.isActive('codeBlock') || !controlData(data, ['value'], ['value']) || typeof data.value !== 'string' ||
          (data.value !== '' && !CODE_LANGUAGES.slice(1).some(value => value.toLowerCase() === data.value))) return false
      } else if (action === 'code-indent') {
        if (readOnly || !editor.isActive('codeBlock') || !controlData(data, ['outdent'], ['outdent']) || typeof data.outdent !== 'boolean') return false
      } else if (!['copy-code','copy-context','add-review-note'].includes(action) || !controlData(data, []) ||
        (action === 'copy-code' && !editor.isActive('codeBlock')) || (action === 'add-review-note' && readOnly)) return false
    } else if (kind === 'more') {
      if (action === 'close') { if (!controlData(data, [])) return false; morePopup.invalidate(); setMoreOpen(false); return }
      if (action !== 'choose' || readOnly || !selectionIsCurrent() || !controlData(data, ['value'], ['value']) || typeof data.value !== 'string' || !MORE_FORMATS.includes(data.value)) return false
    } else if (kind === 'slash') {
      if (action === 'close') { if (!controlData(data, [])) return false; slashPopup.invalidate(); setSlash(null); return }
      if (action !== 'choose' || readOnly || composition.current || !selectionIsCurrent() || !controlData(data, ['id'], ['id']) || typeof data.id !== 'string' || !slash || !filterSlashCatalog(slash.query).some(item => item.id === data.id)) return false
    } else if (kind === 'documents') {
      if (action === 'close') { if (!controlData(data, [])) return false; documentsPopup.invalidate(); docRequestRef.current += 1; docQueryRef.current = null; docRangeRef.current = null; setDocMenu(null); return }
      if (action === 'retry') { if (!controlData(data, []) || docMenu?.status !== 'error') return false; retryDocuments(); return }
      if (action !== 'choose' || readOnly || composition.current || !selectionIsCurrent() || !controlData(data, ['path'], ['path']) || typeof data.path !== 'string' || docMenu?.status !== 'ready' || !docMenu.items.some(item => item.relativePath === data.path)) return false
    } else if (kind === 'link') {
      if (action === 'close') { if (!controlData(data, [])) return false; linkPopup.invalidate(); setLinkBubble(false); return }
      if (!['open','copy','save','remove'].includes(action) || !controlData(data, action === 'remove' ? [] : ['target']) || (Object.hasOwn(data, 'target') && typeof data.target !== 'string')) return false
      if (['save','remove'].includes(action) && (readOnly || !editor || !selectionIsCurrent() || !linkContext.current || linkContext.current.doc !== editor.state.doc || linkContext.current.from !== editor.state.selection.from || linkContext.current.to !== editor.state.selection.to)) return false
    } else if (kind === 'emoji') {
      if (action === 'close') { if (!controlData(data, [])) return false; emojiPopup.invalidate(); closeEmoji(); return }
      if (action === 'retry') { if (!controlData(data, []) || currentEmojiRead.status !== 'error') return false; await loadEmojiPicker(); return }
      if (action !== 'insert' || readOnly || !editor || !selectionIsCurrent() || !emojiPickerModule || currentEmojiRead.status !== 'ready' || !controlData(data, ['value'], ['value']) || typeof data.value !== 'string' || data.value.length === 0) return false
    } else if (kind === 'rich') {
      if (action === 'find' || action === 'replace') {
        if (!controlData(data, ['query']) || (Object.hasOwn(data, 'query') && typeof data.query !== 'string')) return false
        await openSearch(action === 'replace', data, searchOpener.current ?? document.activeElement); return
      }
      if (['more','toc','frontmatter','notes'].includes(action)) {
        if (!controlData(data, ['open'], ['open']) || typeof data.open !== 'boolean' || (action === 'frontmatter' && split.prefix === '')) return false
        if (action === 'more') { if (!data.open) morePopup.invalidate(); setMoreOpen(data.open) }
        if (action === 'notes') setNotesOpen(data.open)
        if (action === 'toc') { setTocOpen(data.open); await call(MARKDOWN_METHOD, { action: 'toc', visible: data.open }) }
        if (action === 'frontmatter') { setFrontMatterVisible(data.open); await call(MARKDOWN_METHOD, { action: 'frontmatter', visible: data.open }) }
        return
      }
      if (action === 'toc-level' || action === 'toc-collapse') {
        if (!controlData(data, action === 'toc-level' ? ['level','visible'] : ['level'], action === 'toc-level' ? ['level','visible'] : ['level']) || typeof data.level !== 'number' || !Number.isInteger(data.level) || data.level < 1 || data.level > 5 || (action === 'toc-level' && typeof data.visible !== 'boolean')) return false
        const level = data.level
        if (action === 'toc-collapse') setTocLevels(new Set([1,2,3,4,5].filter(value => value <= level)))
        else setTocLevels(values => { const next = new Set(values); if (data.visible) next.add(level); else next.delete(level); return next })
        return
      }
      if (action === 'heading') {
        if (!controlData(data, ['id'], ['id']) || typeof data.id !== 'string' || currentTocRead.status !== 'ready') return false
        const heading = toc.find(value => value.id === data.id)
        if (!heading) return false
        jumpToHeading(heading); return
      }
      if (action === 'open-link') {
        if (!controlData(data, ['target','modifier','shift'], ['target']) || typeof data.target !== 'string' || (Object.hasOwn(data,'modifier') && typeof data.modifier !== 'boolean') || (Object.hasOwn(data,'shift') && typeof data.shift !== 'boolean')) return false
      } else if (action === 'edit-note' || action === 'delete-note') {
        if (readOnly || !controlData(data, ['noteId'], ['noteId']) || typeof data.noteId !== 'string' || !notes.some(note => note.id === data.noteId)) return false
        if (action === 'edit-note') { const note = notes.find(note => note.id === data.noteId)!; setNoteEdit(note.id); setNoteBody(note.body); setNoteComposer(true); setNotesOpen(true); return }
      } else {
        if (!controlData(data, [])) return false
        if (action === 'dismiss-error') { if (operationError) dismissError(operationError.id); else setFlushError(null); return }
        if (action === 'dismiss-flush-error') { setFlushError(null); flushFailure.current = null; return }
        if (action === 'dismiss-capabilities') { setEligibilityRead(value => ({ ...value, status: 'ready', error: null })); return }
        if (action === 'dismiss-feedback') { setFeedback(null); return }
        if (action === 'toc-expand') { setTocLevels(new Set([1,2,3,4,5])); return }
        if (action === 'open-anyway') {
          if (!eligibility?.reason?.includes('600') || utf8Bytes(source) > 1024 * 1024) return false
          setOpenAnyway(true); return
        }
        if (action === 'templates') { openNewDocument(); return }
        if (action === 'send-menu') { await openSendMenu(); return }
        if (!['source','preview','retry-flush','export-pdf','refresh-notes','copy-notes','refresh-headings','retry-capabilities'].includes(action)) return false
      }
    } else return false
    if (controlBusy.current?.scope === scope) return false
    const token = Symbol()
    controlBusy.current = { scope, token }
    try {
      if (kind === 'selection') {
        if (action === 'format') await applyFormat({ id: String(data.value), format: data.value as MarkdownFormat })
        else if (action === 'copy-context') await copyMarkdownContext()
        else if (action === 'add-review-note') startReviewNote()
        else if (action === 'copy-code') { const text = editor!.state.selection.$from.parent.textContent; await navigator.clipboard.writeText(text); if (live() && selectionIsCurrent()) setFeedback('Copied code') }
        else {
          if (action === 'table') {
            const chain = editor!.chain().focus()
            switch (data.operation) {
              case 'row-above': chain.addRowBefore().run(); break
              case 'row-below': chain.addRowAfter().run(); break
              case 'row-delete': chain.deleteRow().run(); break
              case 'column-left': chain.addColumnBefore().run(); break
              case 'column-right': chain.addColumnAfter().run(); break
              case 'column-delete': chain.deleteColumn().run(); break
              case 'delete': chain.deleteTable().run(); break
            }
          } else if (action === 'code-language') editor!.chain().focus().updateAttributes('codeBlock', { language: data.value || null }).run()
          else if (action === 'code-indent') {
            const { from, to } = editor!.state.selection
            const text = editor!.state.doc.textBetween(from, to, '\n')
            const replacement = data.outdent ? text.split('\n').map(line => line.replace(/^(?: {1,2}|\t)/, '')).join('\n') : text.split('\n').map(line => `  ${line}`).join('\n')
            if (text !== '' || !data.outdent) editor!.chain().focus().insertContentAt({ from, to }, { type: 'text', text: replacement }).run()
          }
          await flush()
        }
      } else if (kind === 'more') { morePopup.invalidate(); setMoreOpen(false); await applyFormat({ id: String(data.value), format: data.value as MarkdownFormat }) }
      else if (kind === 'slash') { const item = filterSlashCatalog(slash!.query).find(item => item.id === data.id)!; await applyFormat(item, true) }
      else if (kind === 'documents') await chooseDocument(String(data.path))
      else if (kind === 'emoji') {
        editor!.chain().focus().insertContent({ type: 'text', text: String(data.value) }).run()
        emojiPopup.invalidate(); closeEmoji(); await flush()
      } else if (kind === 'link') {
        const target = typeof data.target === 'string' ? data.target : linkValue
        if (action === 'copy') { await navigator.clipboard.writeText(target); if (live()) setFeedback('Copied link') }
        else if (action === 'open') await openExternal(target)
        else {
          if (action === 'save' && target.trim() !== '') { await checkLink(target.trim()); if (!live() || !selectionIsCurrent() || currentBuffer.current.readOnly) return }
          if (action === 'remove' || target.trim() === '') editor!.chain().focus().extendMarkRange('link').unsetLink().run()
          else editor!.chain().focus().extendMarkRange('link').setLink({ href: target.trim() }).run()
          linkPopup.invalidate(); setLinkBubble(false); await flush()
        }
      } else if (kind === 'search') {
        const query = typeof data.query === 'string' ? data.query : searchQuery
        const text = typeof data.text === 'string' ? data.text : replaceText
        if (query === '') throw new Error('query is required for Markdown replace.')
        if (utf8Bytes(query) > 2048) throw new Error('Markdown find queries are limited to 2 KiB.')
        const result = await call(MARKDOWN_METHOD, { action: 'replace', expectedRevision: revision.current, query, text, matchCase, wholeWord, all: action === 'replace-all' }) as { buffer?: SurfaceProps['buffer']; replacements?: number }
        if (!live()) return
        updateBufferFromApi(result.buffer); setSearchResult(null); setFeedback(`${result.replacements ?? 0} replacement(s)`)
      } else if (kind === 'rich') {
        if (action === 'source') await openSource()
        else if (action === 'preview') await openPreview()
        else if (action === 'retry-flush') await flush()
        else if (action === 'export-pdf') await exportPdf()
        else if (action === 'refresh-notes') await loadNotes(true)
        else if (action === 'refresh-headings') await loadToc(true)
        else if (action === 'retry-capabilities') await loadEligibility(true)
        else if (action === 'copy-notes') await copyNotes()
        else if (action === 'delete-note') { await call(NOTES_METHOD, { action: 'delete', noteId: data.noteId }); if (live()) await loadNotes() }
        else if (action === 'open-link') await openExternal(String(data.target), { metaKey: CHORD_PLATFORM === 'darwin' && data.modifier === true, ctrlKey: CHORD_PLATFORM !== 'darwin' && data.modifier === true, shiftKey: data.shift === true })
      }
    } catch (cause) { if (live() && errorText(cause) !== flushFailure.current) reportError(kind, cause); throw cause }
    finally { if (controlBusy.current?.token === token) controlBusy.current = null }
  }
  const richControls = useMarkdownControl(props, 'rich', scope, true,
    ['source','preview','retry-flush','open-anyway','find','replace','more','toc','frontmatter','notes','toc-level','toc-collapse','toc-expand','heading','export-pdf','templates','refresh-notes','copy-notes','send-menu','edit-note','delete-note','open-link','dismiss-error','dismiss-feedback','dismiss-flush-error','dismiss-capabilities','refresh-headings','retry-capabilities'],
    control => handleMarkdownControl('rich', control), cause => { if (isCurrent(scope) && cause.message !== flushFailure.current) reportError('bridge', cause) })
  const selectionControls = useMarkdownControl(props, 'selection', selectionGeneration, !!editor,
    [...(!readOnly ? ['format','table','code-language','code-indent','add-review-note'] : []), 'copy-code','copy-context'],
    control => handleMarkdownControl('selection', control), cause => { if (selectionIsCurrent()) reportError('selection', cause) })
  const searchControls = useMarkdownControl(props, 'search', searchPopup.generation, searchOpen,
    ['find','previous','next','close','replace-toggle','options', ...(!readOnly ? ['replace-one','replace-all'] : [])],
    control => handleMarkdownControl('search', control), cause => { if (isCurrent(scope) && searchPopup.isCurrent()) reportError('search', cause) })
  const moreControls = useMarkdownControl(props, 'more', morePopup.generation, moreOpen, ['choose','close'], control => handleMarkdownControl('more', control), cause => { if (morePopup.isCurrent()) reportError('more', cause) })
  const slashControls = useMarkdownControl(props, 'slash', slashPopup.generation, slash !== null, ['choose','close'], control => handleMarkdownControl('slash', control), cause => { if (slashPopup.isCurrent()) reportError('slash', cause) })
  const documentsControls = useMarkdownControl(props, 'documents', documentsPopup.generation, docMenu?.scope === scope, ['choose','close', ...(docMenu?.status === 'error' ? ['retry'] : [])], control => handleMarkdownControl('documents', control), cause => { if (documentsPopup.isCurrent()) reportError('documents', cause) })
  const linkControls = useMarkdownControl(props, 'link', linkPopup.generation, linkBubble, ['open','copy','close', ...(!readOnly ? ['save','remove'] : [])], control => handleMarkdownControl('link', control), cause => { if (linkPopup.isCurrent()) reportError('link', cause) })
  const emojiControls = useMarkdownControl(props, 'emoji', emojiPopup.generation, emojiOpen, ['close', ...(currentEmojiRead.status === 'error' ? ['retry'] : []), ...(!readOnly && currentEmojiRead.status === 'ready' ? ['insert'] : [])], control => handleMarkdownControl('emoji', control), cause => { if (emojiPopup.isCurrent()) reportError('emoji', cause) })
  selectionRun.current = selectionControls
  runSlashRef.current = slashControls
  chooseDocumentRef.current = documentsControls
  openExternalRef.current = richControls
  const currentSlashItems = slash ? filterSlashCatalog(slash.query) : []
  const frontmatter = splitFrontMatter(source).prefix
  const codeLanguage = editor?.isActive('codeBlock') ? String(editor.getAttributes('codeBlock').language ?? '') : ''
  const emojiPickerModuleLoaded = emojiPickerModule
  const EmojiPicker = emojiPickerModuleLoaded?.default
  const currentSelection = editor ? selectionForReview(editor) : null
  const visibleNotes = currentNotesRead.status === 'ready' ? notes : []
  const currentSendRead = sendRead.scope === scope ? sendRead : { scope, status: 'idle' as const, error: null }
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
        void searchControls.run('close')
      }}
    >
      <div className="markdown-toolbar" role="toolbar" aria-label="Markdown formatting">
        <Button type="button" aria-expanded={notesOpen} onClick={() => { void richControls.run('notes', { open: !notesOpen }) }}>Review notes ({notes.length})</Button>
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
        <Button type="button" onClick={() => { void richControls.run('more', { open: !moreOpen }) }}>More blocks ▾</Button>
        <Button type="button" onClick={() => { void richControls.run('source') }}>Source</Button>
        <Button type="button" onClick={() => { void richControls.run('preview') }}>Preview</Button>
        <Button type="button" onClick={(event) => { if (!searchOpen) searchOpener.current = event.currentTarget; void (searchOpen ? searchControls.run('close') : richControls.run('find')) }}>Find</Button>
        <Button type="button" onClick={() => { void richControls.run('toc', { open: !tocOpen }) }}>TOC</Button>
        {frontmatter && <Button type="button" onClick={() => { void richControls.run('frontmatter', { open: !frontMatterVisible }) }}>Front Matter</Button>}
        <Button type="button" onClick={() => { void richControls.run('export-pdf') }}>Export PDF</Button>
        <Button type="button" onClick={() => { void richControls.run('templates') }}>New Markdown</Button>
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
        {[['Heading 4', 'heading4'], ['Heading 5', 'heading5'], ['Collapsible section', 'details'], ['Code block', 'codeBlock'], ['Table', 'table'], ['Divider', 'divider'], ['Mermaid diagram', 'mermaid'], ['Inline math', 'inlineMath'], ['Math block', 'blockMath'], ['Emoji', 'emoji']].map(([label, format]) => <Button key={format} type="button" role="menuitem" disabled={readOnly} onClick={() => { void moreControls.run('choose', { value: format }) }}>{label}</Button>)}</div>}

      {eligibilityRead.scope === scope && eligibilityRead.status === 'loading' && <div role="status" className="markdown-status"><NoticeLine>Checking rich editing availability…</NoticeLine></div>}
      {eligibilityRead.scope === scope && eligibilityRead.status === 'error' && eligibilityRead.error && <InlineError
        message={eligibilityRead.error}
        action={{ label: 'Retry', onAction: () => { void richControls.run('retry-capabilities') } }}
        onDismiss={() => { void richControls.run('dismiss-capabilities') }}
      />}
      {eligibility && !eligibility.eligible && <div role="status" className="markdown-status">
        <span>{eligibility.reason}</span>
        {eligibility.reason?.includes('600') && utf8Bytes(source) <= 1024 * 1024 && <Button type="button" onClick={() => { void richControls.run('open-anyway') }}>Open anyway</Button>}
        <Button type="button" onClick={() => { void richControls.run('source') }}>Open source mode</Button>
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
          if (searchResult) void searchControls.run(event.shiftKey ? 'previous' : 'next')
          else void searchControls.run('find', { query: searchQuery })
        }} />
        <label className="markdown-check"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={(event) => { void searchControls.run('options', { matchCase: event.currentTarget.checked }) }} /> Match case</label>
        <label className="markdown-check"><input type="checkbox" aria-label="Match whole word" checked={wholeWord} onChange={(event) => { void searchControls.run('options', { wholeWord: event.currentTarget.checked }) }} /> Match whole word</label>
        <Button type="button" onClick={() => { void searchControls.run('find', { query: searchQuery }) }}>Find</Button>
        <Button type="button" onClick={() => { void searchControls.run('previous') }}>Previous</Button>
        <Button type="button" onClick={() => { void searchControls.run('next') }}>Next</Button>
        <Button type="button" onClick={() => { void searchControls.run('replace-toggle', { open: !searchReplace }) }}>Replace</Button>
        {searchReplace && <><input aria-label="Replace with" value={replaceText} onChange={(event) => setReplaceText(event.currentTarget.value)} /><Button type="button" disabled={readOnly} onClick={() => { void searchControls.run('replace-one', { query: searchQuery, text: replaceText }) }}>Replace</Button><Button type="button" disabled={readOnly} onClick={() => { void searchControls.run('replace-all', { query: searchQuery, text: replaceText }) }}>Replace all</Button></>}
        {searchQuery !== '' && searchResult && searchResult.doc === editor?.state.doc && searchResult.query === searchQuery && searchResult.matchCase === matchCase && searchResult.wholeWord === wholeWord && searchResult.total === 0 && <EmptyState message="No results" />}
        {searchQuery !== '' && searchResult && searchResult.doc === editor?.state.doc && searchResult.query === searchQuery && searchResult.matchCase === matchCase && searchResult.wholeWord === wholeWord && searchResult.total > 0 && <span>{searchIndex + 1} of {searchResult.total}</span>}
        <Button type="button" onClick={() => { void searchControls.run('close') }}>Close</Button>
      </div>}

      {docMenu?.scope === scope && <div role="dialog" aria-label="Markdown document links" className="markdown-popover markdown-popover--list">
        <strong>Markdown document links</strong>
        <div role="listbox" aria-label="Document matches" className="markdown-popover__items">
          {docMenu.status === 'loading' && <div role="status"><NoticeLine>Finding Markdown documents…</NoticeLine></div>}
          {docMenu.status === 'error' && docMenu.error && <InlineError
            message={docMenu.error}
            action={{ label: 'Retry', onAction: () => { void documentsControls.run('retry') } }}
          />}
          {docMenu.status === 'ready' && docMenu.items.length === 0 && <EmptyState message="No documents found" />}
          {docMenu.status === 'ready' && docMenu.items.map((item, index) => <Button key={item.relativePath} type="button" role="option" aria-selected={index === docMenu.index} className="markdown-option" onMouseDown={(event) => event.preventDefault()} onClick={() => { void documentsControls.run('choose', { path: item.relativePath }) }}>{item.relativePath}</Button>)}
        </div>
        {docMenu.status === 'ready' && <span>{docMenu.items.length} of {docMenu.total} matches{docMenu.truncated ? ' (truncated)' : ''}</span>}
      </div>}
      {slash && <div role="dialog" aria-label="Slash commands" className="markdown-popover markdown-popover--list">
        <input autoFocus className="markdown-input" aria-label="Search blocks" placeholder="Search blocks…" value={slash.query} onChange={(event) => setSlash({ query: event.currentTarget.value, index: 0 })} />
        {currentSlashItems.length === 0 ? <EmptyState message="No blocks found" /> : currentSlashItems.map((item, index) => <Button key={item.id} type="button" role="option" aria-selected={index === slash.index} className="markdown-option" onMouseDown={(event) => event.preventDefault()} onClick={() => { void slashControls.run('choose', { id: item.id }) }}>{item.group}: {item.label}</Button>)}
      </div>}

      {linkBubble && <div role="dialog" aria-label="Link actions" className="markdown-popover markdown-toolbar">
        <input className="markdown-input" aria-label="Paste or type a link" placeholder="Paste or type a link…" value={linkValue} onChange={(event) => setLinkValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void linkControls.run('save', { target: linkValue }); if (event.key === 'Escape') void linkControls.run('close') }} />
        <Button type="button" onClick={() => { void linkControls.run('open', { target: linkValue }) }}>Open link</Button>
        <Button type="button" onClick={() => { void linkControls.run('copy', { target: linkValue }) }}>Copy link</Button>
        <Button type="button" disabled={readOnly} onClick={() => { void linkControls.run('save', { target: linkValue }) }}>Save link</Button>
        <Button type="button" disabled={readOnly} onClick={() => { void linkControls.run('remove') }}>Remove link</Button>
        <Button type="button" onClick={() => { void linkControls.run('close') }}>Close</Button>
      </div>}

      {emojiOpen && <div role="dialog" aria-label="Emoji picker" className="markdown-popover markdown-popover--emoji">
        {currentEmojiRead.status === 'loading' && <div role="status"><NoticeLine>Loading native emoji picker…</NoticeLine></div>}
        {currentEmojiRead.status === 'error' && currentEmojiRead.error && <InlineError
          message={`Could not load the emoji picker: ${currentEmojiRead.error}`}
          action={{ label: 'Retry', onAction: () => { void emojiControls.run('retry') } }}
        />}
        {EmojiPicker && emojiPickerModuleLoaded && <EmojiPicker
          autoFocusSearch
          emojiStyle={emojiPickerModuleLoaded.EmojiStyle.NATIVE}
          onEmojiClick={({ emoji }) => { void emojiControls.run('insert', { value: emoji }) }}
        />}
        <Button type="button" onClick={() => { void emojiControls.run('close') }}>Close</Button>
      </div>}

      {tocOpen && <aside aria-label="Table of Contents" className="markdown-toc">
        <strong>Table of Contents</strong>
        <div>{[1, 2, 3, 4, 5].map((level) => <label key={level} className="markdown-check"><input type="checkbox" checked={tocLevels.has(level)} aria-label={`Show H${level}`} onChange={(event) => { void richControls.run('toc-level', { level, visible: event.currentTarget.checked }) }} />H{level}</label>)}
          {[1, 2, 3, 4, 5].map((level) => <Button key={`collapse-${level}`} type="button" onClick={() => { void richControls.run('toc-collapse', { level }) }}>Collapse to H{level}</Button>)}
          <Button type="button" onClick={() => { void richControls.run('toc-expand') }}>Expand all</Button>
        </div>
        {currentTocRead.status === 'loading' && <div role="status"><NoticeLine>Loading headings…</NoticeLine></div>}
        {currentTocRead.status === 'error' && currentTocRead.error && <InlineError
          message={currentTocRead.error}
          action={{ label: 'Retry', onAction: () => { void richControls.run('refresh-headings') } }}
        />}
        {currentTocRead.status === 'ready' && visibleToc.length === 0 && <EmptyState message="No headings" />}
        {currentTocRead.status === 'ready' && visibleToc.map((heading) => <Button key={`${heading.id}:${heading.line}`} type="button" className="markdown-toc-heading" data-level={heading.level} onClick={() => { void richControls.run('heading', { id: heading.id }) }}>{heading.text}</Button>)}
      </aside>}

      {feedback && <div role="status" className="markdown-status">{feedback}<Button type="button" onClick={() => { void richControls.run('dismiss-feedback') }}>Dismiss</Button></div>}
      {operationError?.scope === scope && <InlineError message={operationError.message} onDismiss={() => { void richControls.run('dismiss-error') }} />}
      {flushError && flushErrorScope === scope && <div className="markdown-flush-failure">
        <InlineError
          message={flushError}
          action={{ label: 'Retry', onAction: () => { void richControls.run('retry-flush') } }}
          onDismiss={() => { void richControls.run('dismiss-flush-error') }}
        />
        <Button type="button" onClick={() => { void richControls.run('source') }}>Open source</Button>
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
            <Button type="button" disabled={readOnly || editor.isActive('tableHeader')} onClick={() => { void selectionControls.run('table', { operation: 'row-above' }) }}>Insert row above</Button>
            <Button type="button" disabled={readOnly} onClick={() => { void selectionControls.run('table', { operation: 'row-below' }) }}>Insert row below</Button>
            <Button type="button" disabled={readOnly || editor.isActive('tableHeader')} onClick={() => { void selectionControls.run('table', { operation: 'row-delete' }) }}>Delete row</Button>
            <Button type="button" disabled={readOnly} onClick={() => { void selectionControls.run('table', { operation: 'column-left' }) }}>Insert column left</Button>
            <Button type="button" disabled={readOnly} onClick={() => { void selectionControls.run('table', { operation: 'column-right' }) }}>Insert column right</Button>
            <Button type="button" disabled={readOnly} onClick={() => { void selectionControls.run('table', { operation: 'column-delete' }) }}>Delete column</Button>
            <Button type="button" disabled={readOnly} onClick={() => { void selectionControls.run('table', { operation: 'delete' }) }}>Delete table</Button>
          </div>}
          {editor?.isActive('codeBlock') && <div className="markdown-toolbar markdown-toolbar--engine-actions" aria-label="Code block actions">
            <select className="markdown-select" aria-label="Code language" disabled={readOnly} value={codeLanguage} onChange={(event) => { void selectionControls.run('code-language', { value: event.currentTarget.value }) }}>
              <option value="">Plain text</option>{CODE_LANGUAGES.slice(1).map((language) => <option key={language} value={language.toLowerCase()}>{language}</option>)}
            </select>
            <Button type="button" onClick={() => { void selectionControls.run('copy-code') }}>Copy code</Button>
          </div>}
        </div>
        {notesOpen && <aside aria-label={`Review notes, ${visibleNotes.length} notes`} className="markdown-review-notes">
          <div className="markdown-notes-heading"><strong>Review notes ({visibleNotes.length})</strong><Button type="button" onClick={() => { void richControls.run('refresh-notes') }}>Refresh</Button></div>
          <div className="markdown-toolbar markdown-toolbar--notes">
            <Button type="button" disabled={readOnly} onClick={() => { void selectionControls.run('add-review-note') }}>+ Add note</Button>
            <Button type="button" onClick={() => { void richControls.run('copy-notes') }}>Copy notes for agent</Button>
            <Button type="button" onClick={() => { void richControls.run('send-menu') }}>Send notes to</Button>
          </div>
          {currentNotesRead.status === 'loading' && <div role="status"><NoticeLine>Loading review notes…</NoticeLine></div>}
          {currentNotesRead.status === 'error' && currentNotesRead.error && <InlineError
            message={currentNotesRead.error}
            action={{ label: 'Retry', onAction: () => { void richControls.run('refresh-notes') } }}
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
            <Button type="button" disabled={readOnly} onClick={() => { void richControls.run('edit-note', { noteId: note.id }) }}>Edit</Button>
            <Button type="button" disabled={readOnly} onClick={() => { void richControls.run('delete-note', { noteId: note.id }) }}>Delete</Button>
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
