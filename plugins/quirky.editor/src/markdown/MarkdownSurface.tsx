import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CHORD_PLATFORM, RpcErrorCode } from '@quirky/protocol'
import { Button, Dialog, TextField } from '@quirky/ui'
import type { SurfaceProps } from '../types'
import type { MarkdownHeading } from './source'
import type { MarkdownReviewNote } from './notes'
import type { MarkdownFormat } from './operations'
import { isSafeMarkdownLink } from './operations'
import { extractHeadings, splitFrontMatter, slugHeading, utf8Bytes } from './source'
import { createMarkdownExtensions } from './tiptap'
import { filterSlashCatalog, SLASH_CATALOG, type SlashItem } from './slashCatalog'
import { MermaidDiagram } from './MermaidDiagram'
import { destinationDirectory } from './files'
import { MARKDOWN_PREVIEW_REHYPE_PLUGINS, previewHeadingId } from './previewPipeline'
const KATEX_STYLESHEET = new URL('./katex/katex.min.css', import.meta.url).href

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

function findTextPosition(editor: Editor, query: string, from = 0): { from: number; to: number } | null {
  if (query === '') return null
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), from)
  if (index < 0) return null
  return { from: Math.min(index + 1, editor.state.doc.content.size), to: Math.min(index + query.length + 1, editor.state.doc.content.size) }
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
function expandDocumentLinks(markdown: string): string {
  let fence: { char: string; size: number } | null = null
  return markdown.split(/\r?\n/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = { char: marker[0]!, size: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.size) fence = null
      return line
    }
    if (fence) return line
    const chunks = line.split(/(`+[^`]*`+)/g)
    return chunks.map((chunk, index) => {
      if (index % 2 === 1) return chunk
      return chunk.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, rawTarget: string, rawLabel?: string) => {
        const target = rawTarget.trim()
        const label = (rawLabel ?? target).replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
        const anchorStart = target.indexOf('#')
        const path = anchorStart < 0 ? target : target.slice(0, anchorStart)
        const anchor = anchorStart < 0 ? undefined : target.slice(anchorStart + 1)
        const encodedPath = path.split('/').map((part) => {
          try { return encodeURIComponent(decodeURIComponent(part)) }
          catch { return encodeURIComponent(part) }
        }).join('/')
        const href = `${encodedPath}${anchor === undefined ? '' : `#${encodeURIComponent(anchor)}`}`
        return `[${label}](${href})`
      })
    }).join('')
  }).join('\n')
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

function MarkdownPreview({
  source,
  imageUrls,
  openLink,
  markdownAnchor,
  onView,
  onMissingAnchor,
  articleRef
}: {
  source: string
  imageUrls: Readonly<Record<string, string>>
  openLink(href: string, event: React.MouseEvent<HTMLAnchorElement>): void
  markdownAnchor: string | null
  onView(patch: Record<string, unknown>): void
  onMissingAnchor(anchor: string): void
  articleRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
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
        remarkPlugins={[remarkGfm, remarkMath]}
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
        {expandDocumentLinks(source)}
      </ReactMarkdown>
    </article>
  )
}


function SourceSurface({ props }: { props: SurfaceProps }): React.JSX.Element {
  const content = sourceValue(props.buffer)
  const [eligibility, setEligibility] = useState<{ richEligible: boolean; reason: string | null; openAnywayAvailable: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void props.context.call(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities' })).then((raw) => {
      if (active && raw && typeof raw === 'object' && 'richEligible' in raw) {
        const result = raw as { richEligible: boolean; richReason?: string | null; openAnywayAvailable?: boolean }
        setEligibility({ richEligible: result.richEligible === true, reason: result.richReason ?? null, openAnywayAvailable: result.openAnywayAvailable === true })
      }
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)) })
    return () => { active = false }
  }, [props.buffer.contentRevision, props.buffer.draft, props.buffer.id, props.context])

  const openRich = async (openAnyway = false) => {
    setBusy(true)
    setError(null)
    try {
      const raw = await props.context.call(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities', openAnyway }))
      if (!raw || typeof raw !== 'object' || !('richEligible' in raw) || raw.richEligible !== true) {
        setError('This document cannot be safely opened in rich mode. Continue editing in source mode.')
        return
      }
      await props.context.call('quirky.editor/view', {
        bufferId: props.buffer.id,
        action: 'update',
        patch: { mode: 'rich', markdownOpenAnyway: openAnyway }
      })
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(false) }
  }

  return (
    <div className="markdown-surface markdown-surface--source">
      <div className="markdown-toolbar">
        {eligibility?.richEligible
          ? <Button type="button" onClick={() => void openRich()}>Rich Editor</Button>
          : eligibility?.reason?.includes('600') && eligibility.openAnywayAvailable
            ? <Button type="button" disabled={busy} onClick={() => void openRich(true)}>Open anyway</Button>
            : <span>Rich editing unavailable</span>}
        <Button type="button" onClick={() => props.context.call('quirky.editor/open', { worktree: `id:${props.buffer.worktreeId}`, path: props.buffer.relativePath, mode: 'preview', focus: false })}>Open Markdown Preview</Button>
        <span>Source mode</span>
        {eligibility?.reason && <span role="status" className="markdown-inline-status">{eligibility.reason}</span>}
        {error && <span role="alert" className="markdown-inline-error">{error}</span>}
      </div>
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
  const [preview, setPreview] = useState<{ html?: string; imageUrls: Record<string, string>; available: boolean; reason: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const previewArticle = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [searchResult, setSearchResult] = useState<{ total: number; matches: { from: number; to: number; line: number; text: string }[] } | null>(null)
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const content = sourceValue(props.buffer)
  const split = splitFrontMatter(content)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities', includePreview: true })) as {
        previewHtml?: string
        previewAvailable?: boolean
        previewReason?: string | null
        imageUrls?: Record<string, string>
      }
      setPreview({ html: result.previewHtml, imageUrls: result.imageUrls ?? {}, available: result.previewAvailable === true, reason: result.previewReason ?? null })
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }, [props.buffer.contentRevision, props.buffer.draft, props.buffer.id, props.onAction])

  useEffect(() => {
    void refresh()
    return () => {
      void props.context.call(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'capabilities', releaseImages: true })).catch(() => {})
    }
  }, [props.buffer.id, props.context, refresh])

  const openLink = useCallback(async (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'links', target: href })) as {
        safe?: boolean; kind?: string; resolved?: string | null; anchor?: string | null; ambiguous?: boolean
      }
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
      setError(errorText(cause))
    }
  }, [props.buffer.id, props.buffer.worktreeId, props.context, props.onAction, props.onView])

  const revealPreviewMatch = useCallback((match: { text: string }) => {
    const root = previewArticle.current
    const target = Array.from(root?.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th') ?? [])
      .find((element) => element.textContent?.includes(match.text))
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])
  const runSearch = useCallback(async () => {
    if (query === '') {
      setSearchResult(null)
      return
    }
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, {
        action: 'search',
        query,
        matchCase,
        wholeWord
      })) as { total: number; matches: { from: number; to: number; line: number; text: string }[] }
      setSearchResult(result)
      setSearchIndex(0)
      if (result.matches[0]) revealPreviewMatch(result.matches[0])
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [matchCase, wholeWord, props.buffer.id, props.onAction, query, revealPreviewMatch])
  const movePreviewSearch = useCallback((delta: number) => {
    if (!searchResult || searchResult.matches.length === 0) return
    const next = (searchIndex + delta + searchResult.matches.length) % searchResult.matches.length
    setSearchIndex(next)
    revealPreviewMatch(searchResult.matches[next]!)
  }, [revealPreviewMatch, searchIndex, searchResult])

  const replacePreview = useCallback(async (all: boolean) => {
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
      setSearchResult(null)
      setError(`${result.replacements ?? 0} replacement(s)`)
    } catch (cause) { setError(errorText(cause)) }
  }, [matchCase, props.buffer.contentRevision, props.buffer.id, props.onAction, query, replaceText, wholeWord])
  const openSearch = useCallback(async (replace: boolean, args?: Record<string, unknown>) => {
    const requestedQuery = typeof args?.query === 'string' ? args.query : undefined
    setSearchOpen(true)
    setReplaceOpen(replace)
    if (requestedQuery !== undefined) setQuery(requestedQuery)
    window.requestAnimationFrame(() => searchInput.current?.focus())
    if (requestedQuery === undefined || requestedQuery === '') return { opened: true, replace }
    try {
      const result = await props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, {
        action: 'search',
        query: requestedQuery,
        matchCase,
        wholeWord
      })) as { total: number; matches: { from: number; to: number; line: number; text: string }[] }
      setSearchResult(result)
      setSearchIndex(0)
      if (result.matches[0]) revealPreviewMatch(result.matches[0])
      return { opened: true, replace, query: requestedQuery, total: result.total }
    } catch (cause) {
      setError(errorText(cause))
      throw cause
    }
  }, [matchCase, wholeWord, props.buffer.id, props.onAction, revealPreviewMatch])
  useEffect(() => props.registerCommandHandlers({
    find: (args) => openSearch(false, args),
    replace: (args) => openSearch(true, args)
  }), [openSearch, props.registerCommandHandlers])


  const openSource = () => props.context.call('quirky.editor/view', methodParams(props.buffer.id, { action: 'update', patch: { mode: 'source' } }))
  const reportMissingAnchor = useCallback((anchor: string) => {
    setError(`No Markdown preview heading or HTML anchor matches “${anchor}”.`)
  }, [])

  return (
    <div className="markdown-surface markdown-surface--preview" style={{ fontSize: props.fontSize }}>
      <div className="markdown-toolbar">
        <Button type="button" onClick={() => void openSource()}>Source</Button>
        <Button type="button" onClick={() => setSearchOpen((open) => !open)}>Find in preview</Button>
        <Button type="button" onClick={() => props.onAction(MARKDOWN_METHOD, methodParams(props.buffer.id, { action: 'exportPdf' }))}>Export as PDF</Button>
        <span>Markdown Preview</span>
      </div>
      {searchOpen && <div className="markdown-toolbar markdown-toolbar--search">
        <input ref={searchInput} className="markdown-input" aria-label="Find in preview" placeholder="Find in preview" value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }} />
        <label className="markdown-check"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={(event) => setMatchCase(event.currentTarget.checked)} /> Match case</label>
        <label className="markdown-check"><input type="checkbox" aria-label="Match whole word" checked={wholeWord} onChange={(event) => setWholeWord(event.currentTarget.checked)} /> Match whole word</label>
        <Button type="button" onClick={() => void runSearch()}>Find</Button>
        <Button type="button" onClick={() => movePreviewSearch(-1)}>Previous</Button>
        <Button type="button" onClick={() => movePreviewSearch(1)}>Next</Button>
        <Button type="button" onClick={() => setReplaceOpen((open) => !open)}>Replace</Button>
        {replaceOpen && <><input className="markdown-input" aria-label="Replace with" value={replaceText} onChange={(event) => setReplaceText(event.currentTarget.value)} /><Button type="button" onClick={() => void replacePreview(false)}>Replace</Button><Button type="button" onClick={() => void replacePreview(true)}>Replace all</Button></>}
        {searchResult && <span>{searchResult.total === 0 ? 'No results' : `${searchIndex + 1} of ${searchResult.total}`}</span>}
        <Button type="button" onClick={() => { setSearchOpen(false); setSearchResult(null) }}>Close</Button>
      </div>}
      {error && <div role="alert" className="markdown-alert markdown-alert--error">{error}<Button type="button" onClick={() => setError(null)}>Dismiss</Button></div>}
      {busy && <div role="status" className="markdown-status">Preparing preview…</div>}
      {!busy && preview && !preview.available && <div role="alert" className="markdown-alert">
        {preview.reason ?? 'This document cannot be rendered within the preview limits.'}
        <Button type="button" onClick={() => void openSource()}>Open source view</Button>
        <Button type="button" onClick={() => void refresh()}>Retry</Button>
      </div>}
      {!busy && preview?.available && <MarkdownPreview
        source={split.body}
        imageUrls={preview.imageUrls}
        openLink={(href, event) => void openLink(href, event)}
        markdownAnchor={typeof props.buffer.view.markdownAnchor === 'string' ? props.buffer.view.markdownAnchor : null}
        onView={props.onView}
        onMissingAnchor={reportMissingAnchor}
        articleRef={previewArticle}
      />}
      {!busy && !preview && error && <div role="alert" className="markdown-alert markdown-alert--error">Preview failed. <Button type="button" onClick={() => void refresh()}>Retry</Button><Button type="button" onClick={() => void openSource()}>Open source</Button></div>}
    </div>
  )
}

function RichSurface({ props }: { props: SurfaceProps }): React.JSX.Element {
  const { buffer, onAction, onView, context } = props
  const split = markdownSource(buffer)
  const source = sourceValue(buffer)
  const extensions = useMemo(() => createMarkdownExtensions(), [])
  const [readOnly, setReadOnly] = useState(buffer.readOnly)
  const [flushError, setFlushError] = useState<string | null>(null)
  const [slash, setSlash] = useState<{ query: string; index: number } | null>(null)
  const [docMenu, setDocMenu] = useState<{ query: string; index: number; from: number; to: number; items: { relativePath: string; name: string }[]; total: number; truncated: boolean } | null>(null)
  const [selection, setSelection] = useState<{ from: number; to: number; text: string; startLine: number; endLine: number } | null>(null)
  const [linkBubble, setLinkBubble] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiPickerModule, setEmojiPickerModule] = useState<EmojiPickerModule | null>(null)
  const [emojiPickerLoading, setEmojiPickerLoading] = useState(false)
  const [emojiPickerError, setEmojiPickerError] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const [searchReplace, setSearchReplace] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [searchResult, setSearchResult] = useState<{ matches: { from: number; to: number; line: number; text: string }[]; total: number } | null>(null)
  const [searchIndex, setSearchIndex] = useState(0)
  const [tocOpen, setTocOpen] = useState(buffer.view.markdownTocVisible === true)
  const [tocLevels, setTocLevels] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]))
  const [toc, setToc] = useState<MarkdownHeading[]>([])
  const [frontMatterVisible, setFrontMatterVisible] = useState(buffer.view.markdownFrontmatterVisible === true)
  const [notes, setNotes] = useState<MarkdownReviewNote[]>([])
  const [noteComposer, setNoteComposer] = useState(false)
  const noteInput = useRef<HTMLTextAreaElement>(null)
  const [noteBody, setNoteBody] = useState('')
  const [noteEdit, setNoteEdit] = useState<string | null>(null)
  const [sendMenu, setSendMenu] = useState(false)
  const [agentTargets, setAgentTargets] = useState<{ sessions: { id: string; agent: string; title: string }[]; agents: { id: string; label: string }[] }>({ sessions: [], agents: [] })
  const [sendTarget, setSendTarget] = useState('')
  const [sendAgent, setSendAgent] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [openAnyway, setOpenAnyway] = useState(buffer.view.markdownOpenAnyway === true)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templateOptions, setTemplateOptions] = useState<{ relativePath: string; title: string }[]>([])
  const [templateQuery, setTemplateQuery] = useState('')
  const [templateTitle, setTemplateTitle] = useState('')
  const [eligibility, setEligibility] = useState<{ eligible: boolean; reason: string | null } | null>(null)
  const loadEmojiPicker = useCallback(async () => {
    setEmojiPickerLoading(true)
    setEmojiPickerError(null)
    try {
      setEmojiPickerModule(await loadEmojiPickerModule())
    } catch (cause) {
      setEmojiPickerError(errorText(cause))
    } finally {
      setEmojiPickerLoading(false)
    }
  }, [])
  useEffect(() => {
    if (!emojiOpen || emojiPickerModule || emojiPickerLoading || emojiPickerError) return
    void loadEmojiPicker()
  }, [emojiOpen, emojiPickerError, emojiPickerLoading, emojiPickerModule, loadEmojiPicker])
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pendingText = useRef<string | null>(null)
  const lastAcknowledged = useRef<string | null>(null)
  const revision = useRef(buffer.contentRevision)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composition = useRef(false)
  const docQueryRef = useRef<string | null>(null)
  const docRangeRef = useRef<{ from: number; to: number } | null>(null)
  const docRequestRef = useRef(0)
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
    docRangeRef.current = range
    if (docQueryRef.current === query) {
      const currentMenu = docMenuRef.current
      if (currentMenu) setDocMenu({ ...currentMenu, ...range })
      return
    }
    docQueryRef.current = query
    const request = ++docRequestRef.current
    void onAction(MARKDOWN_METHOD, methodParams(buffer.id, { action: 'documents', query })).then((raw) => {
      if (request !== docRequestRef.current || readOnly || composition.current) return
      const result = raw as { documents?: { relativePath: string; name: string }[]; total?: number; truncated?: boolean }
      const items = result.documents ?? []
      const latestRange = docRangeRef.current
      if (!latestRange) return
      setDocMenu({
        query,
        index: 0,
        ...latestRange,
        items,
        total: typeof result.total === 'number' ? result.total : items.length,
        truncated: result.truncated === true
      })
    }).catch((cause: unknown) => {
      if (request === docRequestRef.current) setFeedback(errorText(cause))
    })
  }, [buffer.id, onAction, readOnly])
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
    const markdown = editor.getMarkdown()
    if (markdown === lastAcknowledged.current && pendingText.current === null) return
    const work = queue.current.then(async () => {
      if (markdown === lastAcknowledged.current) return
      try {
        const result = await onAction(MARKDOWN_METHOD, methodParams(buffer.id, {
          action: 'apply',
          expectedRevision: revision.current,
          text: markdown,
          openAnyway
        })) as { buffer?: SurfaceProps['buffer']; changed?: boolean; sourcePreserved?: boolean }
        if (result.buffer) revision.current = result.buffer.contentRevision
        if (result.sourcePreserved === false) throw new Error('Rich Markdown update did not preserve its source bytes.')
        lastAcknowledged.current = markdown
        if (pendingText.current === markdown) pendingText.current = null
        setFlushError(null)
      } catch (cause) {
        setFlushError(errorText(cause))
        throw cause
      }
    })
    queue.current = work.catch(() => {})
    await work
  }, [buffer.id, editor, onAction, openAnyway])
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
        setFlushError('The Markdown draft changed elsewhere. Your local rich edit is retained; switch to source or compare before retrying.')
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
  }, [buffer.contentRevision, buffer.draft, buffer.readOnly, editor])

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

  useEffect(() => {
    let active = true
    void onAction(MARKDOWN_METHOD, methodParams(buffer.id, { action: 'capabilities', openAnyway })).then((raw) => {
      if (active) {
        const result = raw as { richEligible?: boolean; richReason?: string | null }
        setEligibility({ eligible: result.richEligible === true, reason: result.richReason ?? null })
      }
    }).catch((cause: unknown) => { if (active) setFeedback(errorText(cause)) })
    return () => { active = false }
  }, [buffer.contentRevision, buffer.draft, buffer.id, onAction, openAnyway])

  const call = useCallback((method: string, params: Record<string, unknown> = {}) => onAction(method, methodParams(buffer.id, params)), [buffer.id, onAction])

  const loadNotes = useCallback(async () => {
    try {
      const result = await call(NOTES_METHOD, { action: 'list' }) as { notes?: MarkdownReviewNote[] }
      setNotes(result.notes ?? [])
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [call])
  useEffect(() => { void loadNotes() }, [buffer.id, buffer.contentRevision, loadNotes])

  const loadToc = useCallback(async () => {
    try {
      const result = await call(MARKDOWN_METHOD, { action: 'toc' }) as { headings?: MarkdownHeading[] }
      setToc(result.headings ?? [])
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [call])

  const checkLink = useCallback(async (target: string) => {
    const result = await call(MARKDOWN_METHOD, { action: 'links', target }) as { safe?: boolean; kind?: string; resolved?: string | null; ambiguous?: boolean; anchor?: string | null }
    if (!result.safe || result.ambiguous) throw new Error(result.ambiguous ? 'This document link is ambiguous; use its relative path.' : 'This link target is unsafe or unavailable.')
    return result
  }, [call])

  const importImage = useCallback(async () => {
    if (!editor || readOnly) return
    try {
      await flush()
      const position = markdownOffsetAt(editor, editor.state.selection.from)
      const end = markdownOffsetAt(editor, editor.state.selection.to)
      const result = await call(MARKDOWN_METHOD, {
        action: 'importImage',
        expectedRevision: revision.current,
        selection: { from: position, to: end }
      }) as { buffer?: SurfaceProps['buffer']; cancelled?: boolean }
      if (result.cancelled) return
      updateBufferFromApi(result.buffer)
      await loadNotes()
    } catch (cause) { setFlushError(errorText(cause)) }
  }, [call, editor, flush, loadNotes, readOnly, updateBufferFromApi])

  const importPastedImage = useCallback(async (file: File) => {
    if (!editor || readOnly || buffer.mode === 'preview') return
    if (file.size <= 0 || file.size > 18 * 1024 * 1024) {
      setFlushError('Pasted images must be non-empty and fit the 24 MiB encoded-image limit.')
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
      setFlushError(errorText(cause))
    }
  }, [buffer, call, context, editor, flush, loadNotes, readOnly, updateBufferFromApi])

  const runSlash = useCallback(async (item: SlashItem) => {
    if (!editor) return
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
    else if (item.format === 'emoji') setEmojiOpen(true)
    else if (item.format === 'link') {
      setLinkValue('')
      setLinkBubble(true)
    }
    void flush()
  }, [editor, flush, importImage])
  runSlashRef.current = runSlash

  const chooseDocument = useCallback((path: string) => {
    const menu = docMenuRef.current
    const range = docRangeRef.current
    if (!editor || !menu || !range || readOnly || composition.current) return
    if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || /[\r\n\[\]|]/.test(path)) {
      setFeedback('The selected document target is unsafe.')
      return
    }
    const target = documentLinkTarget(buffer.relativePath, path)
    if (target === '' || /[\r\n\[\]|]/.test(target)) {
      setFeedback('The selected document target is unsafe.')
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
    void flush()
  }, [buffer.relativePath, editor, flush, readOnly])
  chooseDocumentRef.current = chooseDocument

  const insertToolbarFormat = useCallback((format: MarkdownFormat) => {
    if (!editor) return
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
    void flush()
  }, [editor, flush, importImage])

  const toggleFrontMatter = useCallback(async () => {
    const next = !frontMatterVisible
    setFrontMatterVisible(next)
    try { await call(MARKDOWN_METHOD, { action: 'frontmatter', visible: next }) }
    catch (cause) { setFeedback(errorText(cause)) }
  }, [call, frontMatterVisible])

  const updateSearch = useCallback(async () => {
    try {
      const result = await call(MARKDOWN_METHOD, { action: 'search', query: searchQuery, matchCase, wholeWord }) as { matches: { from: number; to: number; line: number; text: string }[]; total: number }
      setSearchResult(result)
      setSearchIndex(0)
      const position = result.matches[0] ? findTextPosition(editor!, searchQuery) : null
      if (position) editor?.chain().focus().setTextSelection(position).scrollIntoView().run()
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [call, editor, matchCase, wholeWord, searchQuery])
  const openSearch = useCallback(async (replace: boolean, args?: Record<string, unknown>) => {
    if (!editor) throw new Error('The rich Markdown editor is not ready.')
    const requestedQuery = typeof args?.query === 'string' ? args.query : undefined
    setSearchOpen(true)
    setSearchReplace(replace)
    if (requestedQuery !== undefined) setSearchQuery(requestedQuery)
    window.requestAnimationFrame(() => searchInput.current?.focus())
    if (requestedQuery === undefined || requestedQuery === '') return { opened: true, replace }
    const result = await call(MARKDOWN_METHOD, { action: 'search', query: requestedQuery, matchCase, wholeWord }) as { matches: { from: number; to: number; line: number; text: string }[]; total: number }
    setSearchResult(result)
    setSearchIndex(0)
    const position = result.matches[0] ? findTextPosition(editor, requestedQuery) : null
    if (position) editor.chain().focus().setTextSelection(position).scrollIntoView().run()
    return { opened: true, replace, query: requestedQuery, total: result.total }
  }, [call, editor, matchCase, wholeWord])

  const moveSearch = useCallback((direction: number) => {
    if (!editor || !searchResult || searchResult.matches.length === 0) return
    const next = (searchIndex + direction + searchResult.matches.length) % searchResult.matches.length
    setSearchIndex(next)
    const match = searchResult.matches[next]!
    const position = findTextPosition(editor, searchQuery, Math.max(0, match.from - 1)) ?? findTextPosition(editor, searchQuery)
    if (position) editor.chain().focus().setTextSelection(position).scrollIntoView().run()
  }, [editor, searchIndex, searchQuery, searchResult])

  const replaceMatches = useCallback(async (all: boolean) => {
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
      if (result.buffer) updateBufferFromApi(result.buffer)
      setFeedback(`${result.replacements ?? 0} replacement(s)`)
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [call, matchCase, replaceText, searchQuery, updateBufferFromApi, wholeWord])

  const toggleToc = useCallback(async () => {
    const next = !tocOpen
    setTocOpen(next)
    try {
      await call(MARKDOWN_METHOD, { action: 'toc', visible: next })
      if (next) await loadToc()
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [call, loadToc, tocOpen])

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
    if (!editor || typeof anchor !== 'string' || anchor === '') return
    const heading = extractHeadings(source).find((item) => item.id === anchor || item.id === slugHeading(anchor))
    if (heading) jumpToHeading(heading)
    else setFeedback(`No Markdown heading matches “${anchor}”.`)
    onView({ markdownAnchor: null })
  }, [buffer.view.markdownAnchor, editor, jumpToHeading, onView, source])

  const openExternal = useCallback(async (target: string, event?: LinkModifiers) => {
    try {
      const result = await checkLink(target)
      if (result.kind === 'document' && result.resolved) {
        const opened = await context.call('quirky.editor/open', {
          worktree: `id:${buffer.worktreeId}`,
          path: result.resolved,
          mode: 'preview',
          focus: true
        }) as { id?: string; openedTabId?: string }
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
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [buffer.worktreeId, checkLink, context, onView])
  openExternalRef.current = (target, event) => { void openExternal(target, event) }

  const saveLink = useCallback(async () => {
    if (!editor) return
    const target = linkValue.trim()
    if (!target) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      setLinkBubble(false)
      void flush()
      return
    }
    try {
      const resolved = await checkLink(target)
      if (!resolved.safe) throw new Error('Unsafe link targets are not allowed.')
      editor.chain().focus().extendMarkRange('link').setLink({ href: target }).run()
      setLinkBubble(false)
      void flush()
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [checkLink, editor, flush, linkValue])

  const openSendMenu = useCallback(async () => {
    setSendMenu((open) => !open)
    try {
      const [sessionRows, agentRows] = await Promise.all([
        context.call('quirky.session/list', { worktree: `id:${buffer.worktreeId}` }) as Promise<{ id: string; agent: string; title: string; kind: string; status: string }[]>,
        context.call('quirky.agents/list', {}) as Promise<{ id: string; label: string }[]>
      ])
      setAgentTargets({
        sessions: sessionRows.filter((session) => session.kind === 'terminal' && session.status !== 'exited').map(({ id, agent, title }) => ({ id, agent, title })),
        agents: agentRows.map(({ id, label }) => ({ id, label }))
      })
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [buffer.worktreeId, context])

  const sendNotes = useCallback(async (target: 'existing' | 'new') => {
    try {
      const params = target === 'existing'
        ? { action: 'send', target, sessionId: sendTarget, agent: agentTargets.sessions.find((session) => session.id === sendTarget)?.agent }
        : { action: 'send', target, agent: sendAgent }
      const result = await call(NOTES_METHOD, params) as { delivery: string; deletedNoteIds: string[]; retainedNoteIds: string[]; error?: string }
      setFeedback(result.error ?? `${result.deletedNoteIds.length} note(s) delivered.`)
      setSendMenu(false)
      await loadNotes()
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [agentTargets.sessions, call, loadNotes, sendAgent, sendTarget])

  const addNote = useCallback(async () => {
    if (!selection) return
    if (utf8Bytes(noteBody) > MAX_NOTE_BODY_BYTES) {
      setFeedback('Comment is too large to submit safely.')
      return
    }
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
      setNoteComposer(false)
      setNoteBody('')
      setNoteEdit(null)
      await loadNotes()
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [call, loadNotes, noteBody, noteEdit, selection])
  const startReviewNote = useCallback(() => {
    if (!selection) throw new Error('Select Markdown text before adding a review note.')
    setNoteEdit(null)
    setNoteBody('')
    setNoteComposer(true)
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
    try {
      const result = await call(NOTES_METHOD, { action: 'copy' }) as { text: string; count: number }
      await navigator.clipboard.writeText(result.text)
      setFeedback(result.count === 0 ? 'No review notes to copy.' : 'Copied notes for agent.')
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [call])

  const exportPdf = useCallback(async () => {
    try {
      await flush()
      const result = await call(MARKDOWN_METHOD, { action: 'exportPdf' }) as { path?: string; cancelled?: boolean }
      if (!result.cancelled) setFeedback(`Exported PDF to ${result.path ?? 'the selected location'}.`)
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [call, flush])

  const openPreview = useCallback(async () => {
    await flush()
    try { await context.call('quirky.editor/open', { worktree: `id:${buffer.worktreeId}`, path: buffer.relativePath, mode: 'preview', focus: false }) }
    catch (cause) { setFeedback(errorText(cause)) }
  }, [buffer.relativePath, buffer.worktreeId, context, flush])

  const openSource = useCallback(async () => {
    await flush().catch(() => {})
    try { await context.call('quirky.editor/view', methodParams(buffer.id, { action: 'update', patch: { mode: 'source' } })) }
    catch (cause) { setFeedback(errorText(cause)) }
  }, [buffer.id, context, flush])

  const openNewDocument = useCallback(async () => {
    try {
      const result = await call(MARKDOWN_METHOD, { action: 'templates', worktree: `id:${buffer.worktreeId}` }) as { templates?: { relativePath: string; title: string }[] }
      setTemplateOptions(result.templates ?? [])
      setTemplateQuery('')
      setTemplateTitle('')
      setTemplatesOpen(true)
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [buffer.worktreeId, call])

  const createNewDocument = useCallback(async (template?: string) => {
    try {
      await call(MARKDOWN_METHOD, {
        action: 'new',
        worktree: `id:${buffer.worktreeId}`,
        title: templateTitle,
        ...(template ? { template } : {})
      })
      setTemplatesOpen(false)
    } catch (cause) { setFeedback(errorText(cause)) }
  }, [buffer.worktreeId, call, templateTitle])

  const currentSlashItems = slash ? filterSlashCatalog(slash.query) : []
  const frontmatter = splitFrontMatter(source).prefix
  const linkHref = editor?.isActive('link') ? String(editor.getAttributes('link').href ?? '') : ''
  const codeLanguage = editor?.isActive('codeBlock') ? String(editor.getAttributes('codeBlock').language ?? '') : ''
  const codeText = editor?.isActive('codeBlock') ? editor.state.selection.$from.parent.textContent : ''
  const emojiPickerModuleLoaded = emojiPickerModule
  const EmojiPicker = emojiPickerModuleLoaded?.default
  const currentSelection = editor ? selectionForReview(editor) : null
  const visibleToc = toc.filter((heading) => tocLevels.has(heading.level))
  const visibleTemplates = templateOptions.filter((template) =>
    template.title.toLowerCase().includes(templateQuery.toLowerCase()) ||
    template.relativePath.toLowerCase().includes(templateQuery.toLowerCase())
  )

  return (
    <div className="markdown-surface markdown-surface--rich" style={{ fontSize: props.fontSize }}>
      <div className="markdown-toolbar" role="toolbar" aria-label="Markdown formatting">
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
        <Button type="button" onClick={() => setSearchOpen((open) => !open)}>Find</Button>
        <Button type="button" onClick={() => void toggleToc()}>TOC</Button>
        {frontmatter && <Button type="button" onClick={() => void toggleFrontMatter()}>Front Matter</Button>}
        <Button type="button" onClick={() => void exportPdf()}>Export PDF</Button>
        <Button type="button" onClick={() => void openNewDocument()}>New Markdown</Button>
      </div>
      {templatesOpen && <Dialog
        open={templatesOpen}
        title="New Markdown"
        onClose={() => setTemplatesOpen(false)}
        actions={<Button onClick={() => setTemplatesOpen(false)}>Cancel</Button>}
      >
        <div className="markdown-template-dialog">
          <TextField label="Document title" className="markdown-input" placeholder="Title" value={templateTitle} onChange={(event) => setTemplateTitle(event.currentTarget.value)} />
          <TextField label="Search templates" className="markdown-input" placeholder="Search templates…" value={templateQuery} onChange={(event) => setTemplateQuery(event.currentTarget.value)} />
          <Button type="button" onClick={() => void createNewDocument()}>Blank Markdown (untitled.md)</Button>
          {visibleTemplates.length === 0 && templateOptions.length > 0 && <span>No matching templates.</span>}
          {visibleTemplates.map((template) => <Button key={template.relativePath} type="button" onClick={() => void createNewDocument(template.relativePath)}>{template.title} — {template.relativePath}</Button>)}
        </div>
      </Dialog>}

      {moreOpen && <div className="markdown-popover markdown-popover--menu" role="menu" aria-label="More Markdown blocks">
        {[['Heading 4', 'heading4'], ['Heading 5', 'heading5'], ['Collapsible section', 'details'], ['Code block', 'codeBlock'], ['Table', 'table'], ['Divider', 'divider'], ['Mermaid diagram', 'mermaid'], ['Inline math', 'inlineMath'], ['Math block', 'blockMath'], ['Emoji', 'emoji']].map(([label, format]) => <Button key={format} type="button" role="menuitem" disabled={readOnly && format === 'emoji'} onClick={() => {
          const item = SLASH_CATALOG.find((candidate) => candidate.format === format)
          if (format === 'emoji') setEmojiOpen(true)
          else if (item) void runSlash(item)
          else if (format === 'heading4' || format === 'heading5' || format === 'details' || format === 'codeBlock' || format === 'table' || format === 'divider' || format === 'mermaid' || format === 'inlineMath' || format === 'blockMath') {
            void call(MARKDOWN_METHOD, { action: 'insert', expectedRevision: revision.current, format }).then((result) => updateBufferFromApi((result as { buffer?: SurfaceProps['buffer'] }).buffer)).catch((cause) => setFeedback(errorText(cause)))
          }
          setMoreOpen(false)
        }}>{label}</Button>)}</div>}

      {eligibility && !eligibility.eligible && <div role="status" className="markdown-status">
        <span>{eligibility.reason}</span>
        {eligibility.reason?.includes('600') && utf8Bytes(source) <= 1024 * 1024 && <Button type="button" onClick={() => setOpenAnyway(true)}>Open anyway</Button>}
        <Button type="button" onClick={() => void openSource()}>Open source mode</Button>
      </div>}
      {frontmatter && frontMatterVisible && <details open className="markdown-frontmatter">
        <summary>Front Matter (edit in source mode)</summary><pre className="markdown-frontmatter__source">{frontmatter}</pre>
      </details>}
      {searchOpen && <div className="markdown-toolbar markdown-toolbar--search">
        <input ref={searchInput} className="markdown-input" aria-label="Find in rich editor" placeholder="Find in rich editor" value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void updateSearch() }} />
        <label className="markdown-check"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={(event) => setMatchCase(event.currentTarget.checked)} /> Match case</label>
        <label className="markdown-check"><input type="checkbox" aria-label="Match whole word" checked={wholeWord} onChange={(event) => setWholeWord(event.currentTarget.checked)} /> Match whole word</label>
        <Button type="button" onClick={() => void updateSearch()}>Find</Button>
        <Button type="button" onClick={() => moveSearch(-1)}>Previous</Button>
        <Button type="button" onClick={() => moveSearch(1)}>Next</Button>
        <Button type="button" onClick={() => setSearchReplace((show) => !show)}>Replace</Button>
        {searchReplace && <><input aria-label="Replace with" value={replaceText} onChange={(event) => setReplaceText(event.currentTarget.value)} /><Button type="button" onClick={() => void replaceMatches(false)}>Replace</Button><Button type="button" onClick={() => void replaceMatches(true)}>Replace all</Button></>}
        {searchResult && <span>{searchResult.total ? `${searchIndex + 1} of ${searchResult.total}` : 'No results'}</span>}
        <Button type="button" onClick={() => setSearchOpen(false)}>Close</Button>
      </div>}

      {docMenu && <div role="dialog" aria-label="Markdown document links" className="markdown-popover markdown-popover--list">
        <strong>Markdown document links</strong>
        <div role="listbox" aria-label="Document matches" className="markdown-popover__items">
          {docMenu.items.length === 0
            ? <span>No documents found</span>
            : docMenu.items.map((item, index) => <Button key={item.relativePath} type="button" role="option" aria-selected={index === docMenu.index} className="markdown-option" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseDocument(item.relativePath)}>{item.relativePath}</Button>)}
        </div>
        <span>{docMenu.items.length} of {docMenu.total} matches{docMenu.truncated ? ' (truncated)' : ''}</span>
      </div>}
      {slash && <div role="dialog" aria-label="Slash commands" className="markdown-popover markdown-popover--list">
        <input autoFocus className="markdown-input" aria-label="Search blocks" placeholder="Search blocks…" value={slash.query} onChange={(event) => setSlash({ query: event.currentTarget.value, index: 0 })} />
        {currentSlashItems.length === 0 ? <span>No blocks found</span> : currentSlashItems.map((item, index) => <Button key={item.id} type="button" role="option" aria-selected={index === slash.index} className="markdown-option" onMouseDown={(event) => event.preventDefault()} onClick={() => void runSlash(item)}>{item.group}: {item.label}</Button>)}
      </div>}

      {linkBubble && <div role="dialog" aria-label="Link actions" className="markdown-popover markdown-toolbar">
        <input className="markdown-input" aria-label="Paste or type a link" placeholder="Paste or type a link…" value={linkValue} onChange={(event) => setLinkValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveLink(); if (event.key === 'Escape') setLinkBubble(false) }} />
        <Button type="button" onClick={() => void openExternal(linkValue)}>Open link</Button>
        <Button type="button" onClick={async () => { try { await navigator.clipboard.writeText(linkValue); setFeedback('Copied link') } catch { setFeedback('Failed to copy link') } }}>Copy link</Button>
        <Button type="button" onClick={() => void saveLink()}>Save link</Button>
        <Button type="button" onClick={() => { editor?.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkBubble(false); void flush() }}>Remove link</Button>
        <Button type="button" onClick={() => setLinkBubble(false)}>Close</Button>
      </div>}

      {emojiOpen && <div role="dialog" aria-label="Emoji picker" className="markdown-popover markdown-popover--emoji">
        {emojiPickerLoading && <div role="status">Loading native emoji picker…</div>}
        {emojiPickerError && <div role="alert">Could not load the emoji picker: {emojiPickerError}<Button type="button" onClick={() => void loadEmojiPicker()}>Retry</Button></div>}
        {EmojiPicker && emojiPickerModuleLoaded && <EmojiPicker
          autoFocusSearch
          emojiStyle={emojiPickerModuleLoaded.EmojiStyle.NATIVE}
          onEmojiClick={({ emoji }) => {
            if (!editor) return
            if (readOnly) {
              setFeedback('This Markdown buffer is read-only.')
              return
            }
            if (!editor.chain().focus().insertContent(emoji).run()) return
            setEmojiOpen(false)
            void flush().catch(() => {})
          }}
        />}
        <Button type="button" onClick={() => setEmojiOpen(false)}>Close</Button>
      </div>}

      {tocOpen && <aside aria-label="Table of Contents" className="markdown-toc">
        <strong>Table of Contents</strong>
        <div>{[1, 2, 3, 4, 5].map((level) => <label key={level} className="markdown-check"><input type="checkbox" checked={tocLevels.has(level)} aria-label={`Show H${level}`} onChange={(event) => { const checked = event.currentTarget.checked; setTocLevels((current) => { const next = new Set(current); if (checked) next.add(level); else next.delete(level); return next }) }} />H{level}</label>)}
          {[1, 2, 3, 4, 5].map((level) => <Button key={`collapse-${level}`} type="button" onClick={() => setTocLevels(new Set([1, 2, 3, 4, 5].filter((candidate) => candidate <= level)))}>Collapse to H{level}</Button>)}
          <Button type="button" onClick={() => setTocLevels(new Set([1, 2, 3, 4, 5]))}>Expand all</Button>
        </div>
        {visibleToc.length === 0 ? <p>No headings</p> : visibleToc.map((heading) => <Button key={`${heading.id}:${heading.line}`} type="button" className="markdown-toc-heading" data-level={heading.level} onClick={() => jumpToHeading(heading)}>{heading.text}</Button>)}
      </aside>}

      {feedback && <div role="status" className="markdown-status">{feedback}<Button type="button" onClick={() => setFeedback(null)}>Dismiss</Button></div>}
      {flushError && <div role="alert" className="markdown-alert markdown-alert--error">{flushError}<Button type="button" onClick={() => void flush().catch(() => {})}>Retry</Button><Button type="button" onClick={() => void openSource()}>Open source</Button></div>}

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
          {editor && <EditorContent editor={editor} />}
          {editor?.isActive('table') && <div className="markdown-toolbar markdown-toolbar--engine-actions" aria-label="Table actions">
            <Button type="button" disabled={editor.isActive('tableHeader')} onClick={() => { editor.chain().focus().addRowBefore().run(); void flush() }}>Insert row above</Button>
            <Button type="button" onClick={() => { editor.chain().focus().addRowAfter().run(); void flush() }}>Insert row below</Button>
            <Button type="button" disabled={editor.isActive('tableHeader')} onClick={() => { editor.chain().focus().deleteRow().run(); void flush() }}>Delete row</Button>
            <Button type="button" onClick={() => { editor.chain().focus().addColumnBefore().run(); void flush() }}>Insert column left</Button>
            <Button type="button" onClick={() => { editor.chain().focus().addColumnAfter().run(); void flush() }}>Insert column right</Button>
            <Button type="button" onClick={() => { editor.chain().focus().deleteColumn().run(); void flush() }}>Delete column</Button>
            <Button type="button" onClick={() => { editor.chain().focus().deleteTable().run(); void flush() }}>Delete table</Button>
          </div>}
          {editor?.isActive('codeBlock') && <div className="markdown-toolbar markdown-toolbar--engine-actions" aria-label="Code block actions">
            <select className="markdown-select" aria-label="Code language" value={codeLanguage} onChange={(event) => { editor.chain().focus().updateAttributes('codeBlock', { language: event.currentTarget.value || null }).run(); void flush() }}>
              <option value="">Plain text</option>{CODE_LANGUAGES.slice(1).map((language) => <option key={language} value={language.toLowerCase()}>{language}</option>)}
            </select>
            <Button type="button" onClick={async () => { try { await navigator.clipboard.writeText(codeText); setFeedback('Copied code') } catch { setFeedback('Could not copy code') } }}>Copy code</Button>
          </div>}
        </div>
        <aside aria-label={`Review notes, ${notes.length} notes`} className="markdown-review-notes">
          <div className="markdown-notes-heading"><strong>Review notes ({notes.length})</strong><Button type="button" onClick={() => void loadNotes()}>Refresh</Button></div>
          <div className="markdown-toolbar markdown-toolbar--notes">
            <Button type="button" onClick={() => { if (currentSelection) { setSelection({ from: editor?.state.selection.from ?? 0, to: editor?.state.selection.to ?? 0, ...currentSelection }); setNoteEdit(null); setNoteBody(''); setNoteComposer(true) } }}>+ Add note</Button>
            <Button type="button" onClick={() => void copyNotes()}>Copy notes for agent</Button>
            <Button type="button" onClick={() => void openSendMenu()}>Send notes to</Button>
          </div>
          {sendMenu && <div role="dialog" aria-label="Send notes to" className="markdown-popover markdown-popover--form">
            <label className="markdown-field">Running agent<select className="markdown-select" value={sendTarget} onChange={(event) => setSendTarget(event.currentTarget.value)}><option value="">Choose a running agent</option>{agentTargets.sessions.map((session) => <option key={session.id} value={session.id}>{session.agent} · {session.title}</option>)}</select></label>
            <Button type="button" disabled={!sendTarget} onClick={() => void sendNotes('existing')}>Send</Button>
            <label className="markdown-field">New agent<select className="markdown-select" value={sendAgent} onChange={(event) => setSendAgent(event.currentTarget.value)}><option value="">Choose an agent</option>{agentTargets.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></label>
            <Button type="button" disabled={!sendAgent} onClick={() => void sendNotes('new')}>New agent</Button>
            <Button type="button" onClick={() => setSendMenu(false)}>Cancel</Button>
          </div>}
          {noteComposer && <div role="dialog" aria-label="Add note for the AI" className="markdown-popover markdown-popover--form">
            <p>{selection?.text ? `Selected text: ${selection.text}` : 'Add note for the AI'}</p>
            <textarea ref={noteInput} className="markdown-textarea" aria-label="Add note for the AI" rows={3} maxLength={MAX_NOTE_BODY_BYTES} value={noteBody} onChange={(event) => setNoteBody(event.currentTarget.value)} />
            <Button type="button" onClick={() => void addNote()}>{noteEdit ? 'Save note' : 'Add note'}</Button>
            <Button type="button" onClick={() => { setNoteComposer(false); setNoteEdit(null); setNoteBody('') }}>Cancel</Button>
          </div>}
          {notes.map((note) => <article key={note.id} className="markdown-note">
            <small>{note.startLine === note.endLine ? `Line ${note.lineNumber}` : `Lines ${note.startLine}-${note.endLine}`}</small>
            {note.selectedText && <blockquote className="markdown-note__selection">{note.selectedText}</blockquote>}
            <p>{note.body}</p>
            <Button type="button" onClick={() => { setNoteEdit(note.id); setNoteBody(note.body); setNoteComposer(true) }}>Edit</Button>
            <Button type="button" onClick={async () => { await call(NOTES_METHOD, { action: 'delete', noteId: note.id }); await loadNotes() }}>Delete</Button>
          </article>)}
        </aside>
      </div>
    </div>
  )
}

export function MarkdownSurface(props: SurfaceProps): React.JSX.Element {
  const stylesheet = <link rel="stylesheet" href={KATEX_STYLESHEET} />
  if (props.buffer.mode === 'source') return <>{stylesheet}<SourceSurface props={props} /></>
  if (props.buffer.mode === 'preview') return <>{stylesheet}<PreviewSurface props={props} /></>
  return <>{stylesheet}<RichSurface props={props} /></>
}
