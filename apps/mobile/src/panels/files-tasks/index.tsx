import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { MobileConnectionState } from '../../contracts'
import type { PanelBridge, PanelProps, PanelRoute } from '../contracts'
import {
  classifyWorkspaceResult,
  draftChunkLength,
  draftWriteMode,
  MOBILE_EDITOR_DRAFT_LIMIT,
  MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT,
  normalizeWorktreeRelativePath,
  safeExplorerPath,
  sortExplorerEntries,
  taskFilterValue,
  toWorktreeRelativePath,
  replaceTaskFilter,
  type ExplorerEntryLike
} from './model'

type ObjectValue = Record<string, unknown>
type TaskProvider = 'github' | 'gitlab' | 'linear' | 'jira'
type TaskMode = 'issues' | 'prs'
type TaskView = 'list' | 'board'
type FileKind = 'text' | 'markdown' | 'notebook' | 'csv' | 'image' | 'pdf' | 'audio' | 'video' | 'mermaid' | 'binary' | string

type ExplorerEntry = ExplorerEntryLike & {
  relativePath: string
  canOpen: boolean
  ignored?: boolean
}
type DirectoryListing = { entries: ExplorerEntry[]; truncated: boolean }
type FileBuffer = {
  id: string
  relativePath: string
  name: string
  kind: FileKind
  size: number
  contentRevision: number
  readOnly: boolean
  dirty: boolean
  external: string | null
}
type MediaPreview = { url: string; mime: string; kind: 'image' | 'pdf' | 'audio' | 'video'; size: number }
type TaskRow = ObjectValue & { kind: 'issue' | 'pullRequest'; number: number; title: string }
type TaskRepository = { id: string; name: string; displayName?: string; worktree: string }
type TaskList = { items: TaskRow[]; repositories: TaskRepository[]; failures: ObjectValue[]; page: number; totalPages: number }
type WorkspaceAgent = { id: string; label: string; isDefault: boolean }
type WorkspaceConsentDecision = { kind: 'setup' | 'issue'; choice: 'run' | 'skip' }
type StateAwareBridge = PanelBridge & {
  readonly state: MobileConnectionState
  onState(handler: (state: MobileConnectionState) => void): () => void
}

function useMobileConnection(bridge: PanelBridge): MobileConnectionState {
  const stateBridge = bridge as StateAwareBridge
  const [state, setState] = useState(stateBridge.state)
  useEffect(() => stateBridge.onState(setState), [stateBridge])
  return state
}

function connectionMessage(state: MobileConnectionState): string {
  if (state.phase === 'connected') return ''
  if (state.message) return state.message
  if (state.phase === 'connecting' || state.phase === 'reconnecting') return 'Connecting to desktop…'
  if (state.phase === 'auth-failed' || state.phase === 'credential-missing' || state.phase === 'credential-unavailable') return 'Desktop access is unavailable. Re-pair or restore the saved device credential.'
  return 'Waiting for desktop connection.'
}

const rootStyle: CSSProperties = {
  boxSizing: 'border-box', height: '100%', maxHeight: '100dvh', minHeight: 0, minWidth: 0,
  display: 'flex', flexDirection: 'column', overflow: 'hidden', color: 'var(--text, #e8e8ea)',
  background: 'var(--surface, #17181b)'
}
const headerStyle: CSSProperties = {
  flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  padding: '10px 12px', borderBottom: '1px solid var(--border, #3b3d43)', background: 'var(--surface, #17181b)'
}
const buttonStyle: CSSProperties = {
  boxSizing: 'border-box', minHeight: 36, border: '1px solid var(--border, #555860)', borderRadius: 8,
  padding: '7px 10px', color: 'inherit', background: 'var(--surface-raised, #25272c)', font: 'inherit', cursor: 'pointer'
}
const inputStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', minWidth: 0, minHeight: 38, padding: '8px 10px',
  color: 'inherit', background: 'var(--surface-raised, #25272c)', border: '1px solid var(--border, #555860)',
  borderRadius: 7, font: 'inherit'
}
const mutedStyle: CSSProperties = { color: 'var(--muted, #a1a1aa)' }
const dangerStyle: CSSProperties = { color: 'var(--danger, #f87171)' }
const scrollStyle: CSSProperties = { minHeight: 0, minWidth: 0, flex: '1 1 auto', overflow: 'auto', overscrollBehavior: 'contain' }
const overlayStyle: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  padding: '12px 8px max(8px, env(safe-area-inset-bottom))', boxSizing: 'border-box', background: 'rgba(0,0,0,.58)'
}
const sheetStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680, maxHeight: 'min(92dvh, 760px)', minHeight: 0,
  overflow: 'hidden', border: '1px solid var(--border, #4b4d54)', borderRadius: '14px 14px 8px 8px',
  color: 'var(--text, #e8e8ea)', background: 'var(--surface, #1b1c20)', boxShadow: '0 16px 48px rgba(0,0,0,.4)'
}
const sheetHeaderStyle: CSSProperties = {
  flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '10px 12px', borderBottom: '1px solid var(--border, #3b3d43)'
}
const sheetBodyStyle: CSSProperties = { minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', padding: 12 }
const sheetFooterStyle: CSSProperties = {
  flex: '0 0 auto', display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8,
  padding: '10px 12px max(10px, env(safe-area-inset-bottom))', borderTop: '1px solid var(--border, #3b3d43)',
  background: 'var(--surface, #1b1c20)'
}
const MEDIA_PREVIEW_LIMIT = 10 * 1024 * 1024
const TEXT_PREVIEW_LIMIT = MOBILE_EDITOR_DRAFT_LIMIT
const MEDIA_CHUNK_BYTES = 384 * 1024
const TRANSFER_CHUNK_LIMIT = MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT
const safeImageTypes: Record<string, true> = { 'image/avif': true, 'image/bmp': true, 'image/gif': true, 'image/jpeg': true, 'image/png': true, 'image/svg+xml': true, 'image/webp': true, 'image/x-icon': true }
const safeAudioTypes: Record<string, true> = { 'audio/aac': true, 'audio/flac': true, 'audio/mp4': true, 'audio/mpeg': true, 'audio/ogg': true, 'audio/wav': true, 'audio/webm': true }
const safeVideoTypes: Record<string, true> = { 'video/mp4': true, 'video/ogg': true, 'video/quicktime': true, 'video/webm': true }

function record(value: unknown): ObjectValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : null
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}


function normalizeFileBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0) return new Uint8Array()
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
function encodeBase64(value: Uint8Array): string {
  const blocks: string[] = []
  for (let offset = 0; offset < value.length; offset += 8192) {
    blocks.push(String.fromCharCode(...value.subarray(offset, Math.min(value.length, offset + 8192))))
  }
  return btoa(blocks.join(''))
}


function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1 }
      else bytes += 3
    } else bytes += 3
  }
  return bytes
}

async function readBufferText(bridge: PanelBridge, bufferId: string, kind: 'content' | 'draft', contentRevision: number): Promise<string> {
  const chunks: string[] = []
  let offset = 0
  let totalBytes = 0
  for (;;) {
    const chunk = record(await bridge.call('quirky.editor/read', {
      bufferId, action: 'text', kind, offset, length: 65_536, contentRevision
    }))
    if (!chunk || typeof chunk.text !== 'string' || typeof chunk.eof !== 'boolean') {
      throw new Error('The editor returned an invalid text chunk.')
    }
    totalBytes += utf8ByteLength(chunk.text)
    if (totalBytes > TEXT_PREVIEW_LIMIT) throw new Error('Text preview exceeds the 1 MiB mobile limit.')
    chunks.push(chunk.text)
    if (chunk.eof) return chunks.join('')
    const nextOffset = number(chunk.nextOffset, offset + chunk.text.length)
    if (nextOffset <= offset) throw new Error('The editor did not advance the text read.')
    offset = nextOffset
  }
}

async function readBufferBytes(bridge: PanelBridge, bufferId: string, size: number): Promise<Uint8Array<ArrayBuffer>[]> {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  while (offset < size) {
    const requested = Math.min(MEDIA_CHUNK_BYTES, size - offset)
    const chunk = record(await bridge.call('quirky.editor/read', {
      bufferId, action: 'bytes', offset, length: requested
    }))
    if (!chunk || typeof chunk.data !== 'string') throw new Error('The editor returned an invalid binary chunk.')
    const bytes = normalizeFileBytes(chunk.data)
    if (bytes.length === 0 || bytes.length > requested || offset + bytes.length > size) {
      throw new Error('The editor returned an invalid binary range.')
    }
    chunks.push(bytes)
    offset += bytes.length
  }
  return chunks
}

function safeMediaMime(kind: string, mime: string): mime is string {
  if (kind === 'image') return safeImageTypes[mime] === true
  if (kind === 'audio') return safeAudioTypes[mime] === true
  if (kind === 'video') return safeVideoTypes[mime] === true
  return kind === 'pdf' && mime === 'application/pdf'
}

function languageForPath(path: string): string {
  const extension = path.toLowerCase().split('.').pop() ?? ''
  const languages: Record<string, string> = {
    c: 'c', cc: 'cpp', cpp: 'cpp', css: 'css', go: 'go', h: 'c', hpp: 'cpp', html: 'html', java: 'java',
    js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown', mjs: 'javascript', mts: 'typescript',
    py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', sql: 'sql', ts: 'typescript', tsx: 'typescript',
    toml: 'toml', yaml: 'yaml', yml: 'yaml', xml: 'xml',
  }
  return languages[extension] ?? (extension || 'text')
}

const syntaxPattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:as|async|await|break|case|catch|class|const|continue|def|else|enum|export|extends|false|finally|fn|for|from|function|if|implements|import|in|interface|let|match|new|null|of|package|pass|private|protected|public|return|self|static|struct|super|switch|this|throw|true|try|type|var|while|yield)\b|\b\d+(?:\.\d+)?\b)/gu

function syntaxKind(token: string): 'comment' | 'string' | 'number' | 'keyword' | null {
  if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*')) return 'comment'
  if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) return 'string'
  if (/^\d/u.test(token)) return 'number'
  return 'keyword'
}

function SyntaxText({ value, language }: { value: string; language: string }) {
  const tokens = useMemo(() => {
    const output: { text: string; kind: 'comment' | 'string' | 'number' | 'keyword' | null }[] = []
    let offset = 0
    for (const match of value.matchAll(syntaxPattern)) {
      const token = match[0]
      const start = match.index ?? offset
      if (start > offset) output.push({ text: value.slice(offset, start), kind: null })
      output.push({ text: token, kind: syntaxKind(token) })
      offset = start + token.length
    }
    if (offset < value.length) output.push({ text: value.slice(offset), kind: null })
    return output
  }, [value])
  const colors: Record<string, string> = {
    comment: 'var(--muted, #9ca3af)', string: 'var(--syntax-string, #a5d6a7)',
    number: 'var(--syntax-number, #f2b880)', keyword: 'var(--syntax-keyword, #c792ea)'
  }
  return <code className={`language-${language}`} data-language={language}>{tokens.map((token, index) => token.kind
    ? <span key={index} style={{ color: colors[token.kind] }}>{token.text}</span>
    : <span key={index}>{token.text}</span>)}</code>
}

function safeMarkdownLink(value: string): string | null {
  return safeExternalUrl(value)
}

function renderInline(value: string, openLink: (url: string) => void): ReactNode[] {
  const output: ReactNode[] = []
  const pattern = /(`[^`]*`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/gu
  let offset = 0
  let index = 0
  for (const match of value.matchAll(pattern)) {
    const token = match[0]
    const start = match.index ?? offset
    if (start > offset) output.push(value.slice(offset, start))
    if (token.startsWith('`')) {
      output.push(<code key={`i${index++}`} style={{ padding: '1px 4px', borderRadius: 4, background: 'var(--surface-raised, #282a30)' }}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      output.push(<strong key={`i${index++}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      output.push(<em key={`i${index++}`}>{token.slice(1, -1)}</em>)
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token)
      const href = link ? safeMarkdownLink(link[2]!) : null
      output.push(href && link
        ? <button key={`i${index++}`} type="button" onClick={() => openLink(href)} style={{ padding: 0, border: 0, color: 'var(--accent, #8ab4f8)', background: 'none', font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>{link[1]}</button>
        : token)
    }
    offset = start + token.length
  }
  if (offset < value.length) output.push(value.slice(offset))
  return output
}

function MarkdownView({ value, openLink }: { value: string; openLink: (url: string) => void }) {
  const blocks = useMemo(() => {
    const lines = value.replace(/\r\n?/gu, '\n').split('\n')
    const output: { kind: 'paragraph' | 'heading' | 'quote' | 'unordered' | 'ordered' | 'code'; lines: string[]; level?: number; language?: string }[] = []
    let index = 0
    while (index < lines.length) {
      const line = lines[index]!
      if (!line.trim()) { index += 1; continue }
      const fence = /^```([\w+-]*)\s*$/u.exec(line)
      if (fence) {
        const code: string[] = []
        index += 1
        while (index < lines.length && !/^```\s*$/u.test(lines[index]!)) code.push(lines[index++]!)
        if (index < lines.length) index += 1
        output.push({ kind: 'code', lines: code, language: fence[1] || 'text' })
        continue
      }
      const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
      if (heading) { output.push({ kind: 'heading', lines: [heading[2]!], level: heading[1]!.length }); index += 1; continue }
      if (/^>\s?/u.test(line)) {
        const quote: string[] = []
        while (index < lines.length && /^>\s?/u.test(lines[index]!)) quote.push(lines[index++]!.replace(/^>\s?/u, ''))
        output.push({ kind: 'quote', lines: quote }); continue
      }
      if (/^\s*[-*+]\s+/u.test(line)) {
        const items: string[] = []
        while (index < lines.length && /^\s*[-*+]\s+/u.test(lines[index]!)) items.push(lines[index++]!.replace(/^\s*[-*+]\s+/u, ''))
        output.push({ kind: 'unordered', lines: items }); continue
      }
      if (/^\s*\d+[.)]\s+/u.test(line)) {
        const items: string[] = []
        while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index]!)) items.push(lines[index++]!.replace(/^\s*\d+[.)]\s+/u, ''))
        output.push({ kind: 'ordered', lines: items }); continue
      }
      const paragraph = [line]
      index += 1
      while (index < lines.length && lines[index]!.trim() && !/^(?:#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/u.test(lines[index]!)) paragraph.push(lines[index++]!)
      output.push({ kind: 'paragraph', lines: paragraph })
    }
    return output
  }, [value])

  return <div style={{ display: 'grid', gap: 10, minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.55 }}>
    {blocks.map((block, index) => {
      const content = block.lines.join(block.kind === 'code' ? '\n' : ' ')
      if (block.kind === 'heading') {
        const Heading = `h${block.level ?? 2}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        return <Heading key={index} style={{ margin: 0, fontSize: Math.max(14, 23 - (block.level ?? 2) * 2) }}>{renderInline(content, openLink)}</Heading>
      }
      if (block.kind === 'quote') return <blockquote key={index} style={{ margin: 0, paddingLeft: 10, borderLeft: '3px solid var(--border, #555)' }}>{renderInline(content, openLink)}</blockquote>
      if (block.kind === 'unordered' || block.kind === 'ordered') {
        const List = block.kind === 'unordered' ? 'ul' : 'ol'
        return <List key={index} style={{ margin: 0, paddingLeft: 24 }}>{block.lines.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, openLink)}</li>)}</List>
      }
      if (block.kind === 'code') return <pre key={index} style={{ maxWidth: '100%', overflow: 'auto', whiteSpace: 'pre', padding: 10, borderRadius: 8, background: 'var(--surface-raised, #25272c)' }}><SyntaxText value={content} language={block.language ?? 'text'} /></pre>
      return <p key={index} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{renderInline(content, openLink)}</p>
    })}
  </div>
}

function ModalSheet({ title, onClose, children, footer, zIndex = 50 }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  zIndex?: number
}) {
  return <div style={{ ...overlayStyle, zIndex }}>
    <section role="dialog" aria-modal="true" aria-label={title} style={sheetStyle}>
      <header style={sheetHeaderStyle}>
        <h2 style={{ margin: 0, fontSize: 18, minWidth: 0, overflowWrap: 'anywhere' }}>{title}</h2>
        <button type="button" aria-label={`Close ${title}`} onClick={onClose} style={buttonStyle}>Close</button>
      </header>
      <div style={sheetBodyStyle}>{children}</div>
      {footer ? <footer style={sheetFooterStyle}>{footer}</footer> : null}
    </section>
  </div>
}

function announceError(message: string): string {
  return message.trim() || 'The request failed without an error message.'
}

function ExplorerPanel({ bridge, route }: { bridge: PanelBridge; route: Extract<PanelRoute, { kind: 'files' }> }) {
  const connection = useMobileConnection(bridge)
  const connected = connection.phase === 'connected'
  const disconnectedNotice = connectionMessage(connection)
  const [worktreeRoot, setWorktreeRoot] = useState('')
  const [listings, setListings] = useState<Record<string, DirectoryListing>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)

  const parseEntries = useCallback((raw: unknown, root: string): ExplorerEntry[] => {
    return sortExplorerEntries(array(raw).flatMap((value) => {
      const entry = record(value)
      if (!entry || typeof entry.path !== 'string' || typeof entry.name !== 'string' || typeof entry.isDirectory !== 'boolean') return []
      const relativePath = toWorktreeRelativePath(root, entry.path)
      if (relativePath === null || relativePath === '.') return []
      return [{
        path: entry.path,
        relativePath,
        name: entry.name,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink === true,
        ...(typeof entry.ignored === 'boolean' ? { ignored: entry.ignored } : {}),
        ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
        canOpen: safeExplorerPath({ path: entry.path, name: entry.name, isDirectory: entry.isDirectory, isSymlink: entry.isSymlink === true, ...(typeof entry.error === 'string' ? { error: entry.error } : {}) }, root) !== null
      }]
    }))
  }, [])

  const fetchDirectory = useCallback(async (directory: string, currentRoot: string, request: number): Promise<DirectoryListing> => {
    const safeDirectory = normalizeWorktreeRelativePath(directory)
    if (safeDirectory === null) throw new Error('The directory path is outside this worktree.')
    const result = record(await bridge.call('quirky.editor/explorer', {
      worktree: route.worktreeId,
      action: 'list',
      ...(safeDirectory !== '.' ? { path: safeDirectory } : {})
    }))
    if (!result || !Array.isArray(result.entries)) throw new Error('The file explorer returned an invalid directory listing.')
    if (request !== generation.current) return { entries: [], truncated: false }
    return { entries: parseEntries(result.entries, currentRoot), truncated: result.truncated === true }
  }, [bridge, parseEntries, route.worktreeId])

  const loadRoot = useCallback(async (refresh = false) => {
    const request = ++generation.current
    setLoading(true)
    setError('')
    setListings({})
    setExpanded(new Set())
    setWorktreeRoot('')
    if (!connected) {
      setError(`Waiting for desktop. ${disconnectedNotice}`)
      setLoading(false)
      return
    }
    try {
      const result = record(await bridge.call('quirky.editor/explorer', {
        worktree: route.worktreeId, action: refresh ? 'refresh' : 'list'
      }))
      if (request !== generation.current) return
      if (!result || typeof result.root !== 'string' || !Array.isArray(result.entries)) {
        throw new Error('The file explorer returned an invalid root listing.')
      }
      const root = result.root
      setWorktreeRoot(root)
      const next: Record<string, DirectoryListing> = {
        '.': { entries: parseEntries(result.entries, root), truncated: result.truncated === true }
      }
      const requestedPath = route.path ? normalizeWorktreeRelativePath(route.path) : null
      if (requestedPath && requestedPath !== '.') {
        const targetDirectory = requestedPath.split('/').slice(0, -1).join('/') || '.'
        const chain: string[] = []
        let cursor = ''
        for (const segment of targetDirectory.split('/').filter(Boolean)) {
          cursor = cursor ? `${cursor}/${segment}` : segment
          chain.push(cursor)
        }
        for (const directory of chain) {
          const listing = await fetchDirectory(directory, root, request)
          if (request !== generation.current) return
          next[directory] = listing
        }
        setExpanded(new Set(chain))
      } else if (route.path && requestedPath === null) {
        setError('The requested explorer path is outside this worktree.')
      }
      setListings(next)
    } catch (cause) {
      if (request === generation.current) setError(`Unable to load files: ${announceError(messageOf(cause))}`)
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [bridge, connected, disconnectedNotice, fetchDirectory, parseEntries, route.path, route.worktreeId])

  useEffect(() => {
    void loadRoot()
    return () => { generation.current += 1 }
  }, [loadRoot])

  const toggleFolder = async (entry: ExplorerEntry) => {
    if (!connected || entry.error) return
    const path = normalizeWorktreeRelativePath(entry.relativePath)
    if (path === null) return
    if (expanded.has(path)) {
      setExpanded((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
      return
    }
    setExpanded((current) => new Set(current).add(path))
    if (listings[path] || !worktreeRoot) return
    const request = generation.current
    setBusyPath(path)
    try {
      const listing = await fetchDirectory(path, worktreeRoot, request)
      if (request === generation.current) setListings((current) => ({ ...current, [path]: listing }))
    } catch (cause) {
      if (request === generation.current) setError(`Unable to read folder ${entry.name}: ${announceError(messageOf(cause))}`)
    } finally {
      if (request === generation.current) setBusyPath(null)
    }
  }

  const openFile = async (entry: ExplorerEntry) => {
    if (!connected) { setError(`Waiting for desktop. ${disconnectedNotice}`); return }
    const path = safeExplorerPath(entry, worktreeRoot)
    if (!path) {
      setError(entry.error ? `Unable to open ${entry.name}: ${entry.error}` : 'This file path is outside the selected worktree.')
      return
    }
    try {
      await bridge.navigate({ kind: 'file-preview', worktreeId: route.worktreeId, path })
    } catch (cause) {
      setError(`Unable to open ${entry.name}: ${announceError(messageOf(cause))}`)
    }
  }

  const renderDirectory = (directory: string, depth: number): ReactNode => {
    const listing = listings[directory]
    if (!listing) return null
    if (listing.entries.length === 0 && depth === 0) return <p style={{ ...mutedStyle, padding: '0 12px' }}>No files found.</p>
    return listing.entries.map((entry) => {
      const isExpanded = expanded.has(entry.relativePath)
      return <div key={entry.relativePath}>
        <button
          type="button"
          aria-expanded={entry.isDirectory ? isExpanded : undefined}
          disabled={!connected || (entry.isDirectory ? Boolean(entry.error) : !entry.canOpen)}
          onClick={() => entry.isDirectory ? void toggleFolder(entry) : void openFile(entry)}
          style={{ ...buttonStyle, display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0, minHeight: 40, marginBottom: 4, textAlign: 'left', opacity: entry.error ? .7 : 1, paddingLeft: 10 + Math.min(depth, 12) * 16 }}
        >
          <span aria-hidden="true" style={{ width: 18, flex: '0 0 18px' }}>{entry.isDirectory ? (isExpanded ? '▾' : '▸') : entry.isSymlink ? '↗' : '·'}</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{entry.name}</span>
          {entry.ignored ? <span style={mutedStyle}>ignored</span> : null}
          {busyPath === entry.relativePath ? <span role="status">Loading…</span> : null}
        </button>
        {entry.error ? <div role="status" style={{ ...mutedStyle, padding: '0 12px 6px 32px', overflowWrap: 'anywhere' }}>{entry.error}</div> : null}
        {entry.isDirectory && isExpanded ? renderDirectory(entry.relativePath, depth + 1) : null}
      </div>
    })
  }

  const goBack = async () => {
    try { await bridge.navigate({ kind: 'workspaces' }) }
    catch (cause) { setError(`Unable to return to workspaces: ${announceError(messageOf(cause))}`) }
  }

  return <section aria-label="Files" style={rootStyle}>
    <header style={headerStyle}>
      <button type="button" aria-label="Back to workspaces" onClick={() => void goBack()} style={buttonStyle}>Back</button>
      <h1 style={{ margin: '0 auto 0 0', fontSize: 18 }}>Files</h1>
      <span style={{ ...mutedStyle, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bridge.init.host.name}</span>
      {!connected ? <span role="status" style={mutedStyle}>{disconnectedNotice}</span> : null}
      <button type="button" aria-label="Refresh files" disabled={loading || !connected} onClick={() => void loadRoot(true)} style={buttonStyle}>{loading ? 'Loading…' : 'Refresh'}</button>
    </header>
    {error ? <div role="alert" style={{ ...dangerStyle, padding: '8px 12px', overflowWrap: 'anywhere' }}>{error}</div> : null}
    <main style={scrollStyle}>
      {!connected ? <p role="status" style={{ ...mutedStyle, padding: '0 12px' }}>Waiting for desktop. {disconnectedNotice}</p> : null}
      {connected && loading && Object.keys(listings).length === 0 ? <p role="status" style={{ padding: '0 12px' }}>Loading files…</p> : null}
      {connected && !loading && !error && worktreeRoot && listings['.']?.entries.length === 0 ? <p style={{ ...mutedStyle, padding: '0 12px' }}>No files found.</p> : null}
      {connected ? renderDirectory('.', 0) : null}
      {connected && listings['.']?.truncated ? <p style={{ ...mutedStyle, padding: '0 12px' }}>The file list is truncated. Expand a folder to browse further.</p> : null}
    </main>
  </section>
}

function FilePreviewPanel({ bridge, route }: { bridge: PanelBridge; route: Extract<PanelRoute, { kind: 'file-preview' }> }) {
  const connection = useMobileConnection(bridge)
  const connected = connection.phase === 'connected'
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [file, setFile] = useState<FileBuffer | null>(null)
  const [baseText, setBaseText] = useState('')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [renderMarkdown, setRenderMarkdown] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const [media, setMedia] = useState<MediaPreview | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<'back' | 'refresh' | null>(null)
  const [routeError, setRouteError] = useState('')
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  const fileRef = useRef(file)
  fileRef.current = file
  const activeDraftTransferId = useRef<string | null>(null)
  const mounted = useRef(true)
  const connectionRef = useRef(connection)
  connectionRef.current = connection
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const transferId = activeDraftTransferId.current
      if (!transferId) return
      activeDraftTransferId.current = null
      void bridge.call('quirky.editor/transfer', { action: 'cancel', transferId }).catch(() => {})
    }
  }, [bridge])
  useEffect(() => {
    if (connected) return
    const transferId = activeDraftTransferId.current
    if (!transferId) return
    activeDraftTransferId.current = null
    void bridge.call('quirky.editor/transfer', { action: 'cancel', transferId }).catch(() => {})
  }, [bridge, connected])
  const localDirty = draft !== baseText
  const language = file ? languageForPath(file.relativePath) : 'text'
  const relativePath = file?.relativePath ?? normalizeWorktreeRelativePath(route.path) ?? route.path

  useEffect(() => {
    const request = ++generation.current
    let objectUrl: string | null = null
    const path = normalizeWorktreeRelativePath(route.path)

    if (!connected) {
      setLoading(false)
      setMedia(null)
      if (path && fileRef.current?.relativePath === path) {
        setNotice('Desktop disconnected. This cached file buffer may be stale; saving is disabled.')
      } else {
        setFile(null)
        setBaseText('')
        setDraft('')
        setLoadError(`Waiting for desktop. ${connectionMessage(connection)}`)
      }
      return () => { generation.current += 1 }
    }

    setLoading(true)
    setFile(null)
    setBaseText('')
    setDraft('')
    setEditing(false)
    setLoadError('')
    setSaveError('')
    setNotice('')
    setMedia(null)
    setRouteError('')

    if (path === null || path === '.') {
      setLoadError('Unable to open file: the file path is outside this worktree.')
      setLoading(false)
      return () => { generation.current += 1 }
    }

    void (async () => {
      let opened: ObjectValue | null
      try {
        opened = record(await bridge.call('quirky.editor/open', {
          worktree: route.worktreeId, path, preview: true, pinned: false, focus: false,
          mode: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'pdf', 'mp3', 'wav', 'mp4', 'mov', 'webm'].includes(path.toLowerCase().split('.').pop() ?? '') ? 'preview' : 'source'
        }))
      } catch (cause) {
        if (request === generation.current) setLoadError(`Unable to open file: ${announceError(messageOf(cause))}`)
        return
      }
      if (request !== generation.current) return
      if (!opened || typeof opened.id !== 'string' || opened.id.length === 0 || typeof opened.kind !== 'string') {
        setLoadError('Unable to open file: the editor did not return an authorized file buffer.')
        return
      }
      const openedPath = typeof opened.relativePath === 'string' ? normalizeWorktreeRelativePath(opened.relativePath) : path
      if (openedPath === null || openedPath === '.') {
        setLoadError('Unable to open file: the editor resolved this path outside the selected worktree.')
        return
      }
      const current: FileBuffer = {
        id: opened.id,
        relativePath: openedPath,
        name: typeof opened.name === 'string' ? opened.name : openedPath.split('/').pop() ?? openedPath,
        kind: opened.kind,
        size: number(opened.size),
        contentRevision: number(opened.contentRevision),
        readOnly: opened.readOnly === true,
        dirty: opened.dirty === true,
        external: typeof opened.external === 'string' ? opened.external : null
      }
      setFile(current)

      try {
        if (current.external) setNotice(`The file has an external disk change (${current.external}); this preview may be stale.`)
        if (['text', 'markdown', 'csv', 'mermaid', 'notebook'].includes(current.kind)) {
          const isDraft = current.dirty
          const availableBytes = isDraft
            ? number(opened.draftBytes, current.size)
            : number(opened.contentBytes, current.size)
          if (availableBytes > TEXT_PREVIEW_LIMIT) {
            setNotice(`File is too large to preview on mobile (limit 1 MiB; this buffer is ${availableBytes} bytes).`)
            return
          }
          const content = await readBufferText(bridge, current.id, isDraft ? 'draft' : 'content', current.contentRevision)
          if (request !== generation.current) return
          if (new TextEncoder().encode(content).byteLength > TEXT_PREVIEW_LIMIT) {
            setNotice('File is too large to preview on mobile (limit 1 MiB).')
            return
          }
          setBaseText(content)
          setDraft(content)
          if (current.kind === 'notebook') setNotice('Notebook files are shown as source only; notebook cell editing is not available in this mobile panel.')
        } else if (['image', 'pdf', 'audio', 'video'].includes(current.kind)) {
          const metadata = record(await bridge.call('quirky.editor/viewer', { bufferId: current.id, action: 'metadata' }))
          if (request !== generation.current) return
          if (!metadata || metadata.displayable === false || metadata.previewable === false) {
            throw new Error(string(metadata?.message, string(metadata?.error, 'The editor reports that this file is not safe to preview.')))
          }
          const mime = typeof metadata.mime === 'string' ? metadata.mime : typeof metadata.contentType === 'string' ? metadata.contentType : ''
          if (!safeMediaMime(current.kind, mime)) throw new Error(`The editor does not support safe ${current.kind} previews for ${mime || 'this content type'}.`)
          const mediaSize = number(metadata.size, current.size)
          if (mediaSize > MEDIA_PREVIEW_LIMIT) {
            setNotice(`File is too large to preview on mobile (limit 10 MiB; this file is ${mediaSize} bytes).`)
            return
          }
          if (current.external) throw new Error('File changed on disk. Reload the file before previewing media.')
          const bytes = await readBufferBytes(bridge, current.id, mediaSize)
          if (request !== generation.current) return
          objectUrl = URL.createObjectURL(new Blob(bytes, { type: mime }))
          setMedia({
            url: objectUrl, mime, kind: current.kind as MediaPreview['kind'], size: mediaSize
          })
        } else if (current.kind === 'binary') {
          setNotice('Binary file — the editor does not expose a safe text preview for this file.')
        } else {
          setNotice(`Preview is not supported for ${current.kind} files.`)
        }
      } catch (cause) {
        if (request === generation.current) setLoadError(`Unable to read file: ${announceError(messageOf(cause))}`)
      } finally {
        if (request === generation.current) setLoading(false)
      }
    })()

    return () => {
      generation.current += 1
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [bridge, connected, connection.phase, connection.message, reload, route.path, route.worktreeId])

  const navigateBack = async () => {
    const path = normalizeWorktreeRelativePath(relativePath)
    const parent = path && path !== '.' ? path.split('/').slice(0, -1).join('/') || undefined : undefined
    try { await bridge.navigate({ kind: 'files', worktreeId: route.worktreeId, ...(parent ? { path: parent } : {}) }) }
    catch (cause) { setRouteError(`Unable to return to files: ${announceError(messageOf(cause))}`) }
  }

  const requestNavigation = (action: 'back' | 'refresh') => {
    if (localDirty) { setPendingNavigation(action); return }
    if (action === 'back') void navigateBack()
    else setReload((value) => value + 1)
  }

  const copyText = async (value: string, label: string) => {
    try { await bridge.native.clipboardWrite(value); setRouteError(`${label} copied.`) }
    catch (cause) { setRouteError(`Unable to copy ${label.toLowerCase()}: ${announceError(messageOf(cause))}`) }
  }

  const updateDraftBuffer = async (bufferId: string, content: string, expectedRevision: number): Promise<ObjectValue> => {
    const totalBytes = utf8ByteLength(content)
    if (draftWriteMode(totalBytes) === 'inline') {
      const updated = record(await bridge.call('quirky.editor/draft', { bufferId, content, expectedRevision }))
      if (!updated || updated.id !== bufferId || typeof updated.contentRevision !== 'number') {
        throw new Error('The editor did not confirm the draft update.')
      }
      return updated
    }

    const bytes = new TextEncoder().encode(content)
    if (bytes.byteLength !== totalBytes) throw new Error('The editor draft could not be encoded as UTF-8.')
    const begin = record(await bridge.call('quirky.editor/transfer', {
      action: 'begin', kind: 'draft', bufferId, expectedRevision, totalBytes
    }))
    if (!begin || typeof begin.transferId !== 'string' || begin.transferId.length === 0) {
      throw new Error('The editor did not start the draft transfer.')
    }
    const transferId = begin.transferId
    activeDraftTransferId.current = transferId
    try {
      if (!mounted.current || connectionRef.current.phase !== 'connected') {
        throw new Error('Desktop disconnected before draft transfer could start.')
      }
      const maxChunkBytes = number(begin.maxChunkBytes, 0)
      if (begin.offset !== 0 || !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > 65_536) {
        throw new Error('The editor returned invalid draft-transfer limits.')
      }
      const chunkLimit = Math.min(TRANSFER_CHUNK_LIMIT, maxChunkBytes)
      let offset = 0
      while (offset < bytes.byteLength) {
        const chunkLength = draftChunkLength(bytes.byteLength, offset, chunkLimit)
        const chunk = bytes.subarray(offset, offset + chunkLength)
        const data = encodeBase64(chunk)
        if (data.length > 65_536) throw new Error('An editor draft chunk exceeds the mobile transport limit.')
        const expectedOffset = offset + chunk.byteLength
        const acknowledgement = record(await bridge.call('quirky.editor/transfer', {
          action: 'chunk', transferId, offset, data
        }))
        if (
          !acknowledgement
          || acknowledgement.transferId !== transferId
          || acknowledgement.offset !== expectedOffset
          || acknowledgement.nextOffset !== expectedOffset
        ) {
          throw new Error('The editor acknowledged an unexpected draft-transfer offset.')
        }
        offset = expectedOffset
        if (!mounted.current || connectionRef.current.phase !== 'connected') {
          throw new Error('Desktop disconnected during the draft transfer.')
        }
      }
      if (offset !== totalBytes) throw new Error('The editor draft transfer did not send all UTF-8 bytes.')
      if (!mounted.current || connectionRef.current.phase !== 'connected') {
        throw new Error('Desktop disconnected before the draft transfer could commit.')
      }
      const committed = record(await bridge.call('quirky.editor/transfer', { action: 'commit', transferId }))
      if (!committed || committed.id !== bufferId || typeof committed.contentRevision !== 'number') {
        throw new Error('The editor did not confirm the draft transfer.')
      }
      if (activeDraftTransferId.current === transferId) activeDraftTransferId.current = null
      return committed
    } catch (cause) {
      if (activeDraftTransferId.current === transferId) {
        activeDraftTransferId.current = null
        await bridge.call('quirky.editor/transfer', { action: 'cancel', transferId }).catch(() => {})
      }
      throw cause
    }
  }

  const saveFile = async () => {
    if (!connected || !mounted.current || !file || file.readOnly || saving) return
    setSaving(true)
    setSaveError('')
    try {
      let revision = file.contentRevision
      if (localDirty) {
        const updated = await updateDraftBuffer(file.id, draft, revision)
        if (!mounted.current) return
        if (connectionRef.current.phase !== 'connected') {
          setFile((current) => current ? { ...current, contentRevision: number(updated.contentRevision, current.contentRevision), dirty: updated.dirty === true } : current)
          throw new Error('Desktop disconnected after updating the draft. The file was not saved; reconnect before retrying.')
        }
        if (updated.id !== file.id || typeof updated.contentRevision !== 'number') {
          throw new Error('The editor did not confirm the draft update.')
        }
        revision = updated.contentRevision
        setFile((current) => current ? { ...current, contentRevision: revision, dirty: updated.dirty === true } : current)
      }
      if (!mounted.current) return
      if (connectionRef.current.phase !== 'connected') throw new Error('Desktop disconnected before the file could be saved.')
      const saved = record(await bridge.call('quirky.editor/save', { bufferId: file.id, trigger: 'user' }))
      if (!mounted.current) return
      if (!saved || saved.id !== file.id || saved.dirty !== false) throw new Error(string(saved?.error, 'The editor did not confirm that the file was saved.'))
      setFile((current) => current ? {
        ...current,
        contentRevision: number(saved.contentRevision, current.contentRevision),
        size: number(saved.size, current.size), dirty: false,
        external: typeof saved.external === 'string' ? saved.external : null
      } : current)
      setBaseText(draft)
      setEditing(false)
      setNotice('File saved.')
    } catch (cause) {
      if (mounted.current) setSaveError(`Unable to save file: ${announceError(messageOf(cause))}`)
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const resolvePendingNavigation = (choice: 'cancel' | 'discard') => {
    const action = pendingNavigation
    if (!action) return
    if (localDirty && choice !== 'discard') { setPendingNavigation(null); return }
    setPendingNavigation(null)
    if (action === 'back') void navigateBack()
    else setReload((value) => value + 1)
  }

  const openMarkdownLink = (url: string) => {
    void bridge.native.openExternal(url).catch((cause) => setRouteError(`Unable to open link: ${announceError(messageOf(cause))}`))
  }

  const textKind = Boolean(file && ['text', 'markdown', 'csv', 'mermaid', 'notebook'].includes(file.kind))
  const markdownKind = file?.kind === 'markdown'

  return <section aria-label="File preview" style={rootStyle}>
    <header style={headerStyle}>
      <button type="button" aria-label="Back to files" disabled={saving} onClick={() => requestNavigation('back')} style={buttonStyle}>Files</button>
      <h1 style={{ margin: 0, minWidth: 0, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 16 }}>{file?.name ?? relativePath}</h1>
      {file && textKind ? <button type="button" disabled={loading || !draft} onClick={() => void copyText(draft, 'Content')} style={buttonStyle}>Copy content</button> : null}
      {file ? <button type="button" onClick={() => void copyText(file.relativePath, 'Path')} style={buttonStyle}>Copy path</button> : null}
      <button type="button" aria-label="Refresh file preview" disabled={loading || saving || !connected} onClick={() => requestNavigation('refresh')} style={buttonStyle}>Refresh</button>
    </header>
    {!connected ? <p role="status" style={{ ...dangerStyle, margin: 0, padding: '6px 12px', overflowWrap: 'anywhere' }}>{file ? 'Desktop disconnected · showing a cached, possibly stale buffer.' : `Waiting for desktop. ${connectionMessage(connection)}`}</p> : null}
    {loading ? <p role="status" style={{ padding: 12 }}>Loading preview…</p> : null}
    {loadError ? <div role="alert" style={{ ...dangerStyle, padding: 12, overflowWrap: 'anywhere' }}>{loadError} <button type="button" disabled={!connected} onClick={() => setReload((value) => value + 1)} style={buttonStyle}>Retry</button></div> : null}
    {routeError ? <p role="status" style={{ ...mutedStyle, margin: 0, padding: '6px 12px', overflowWrap: 'anywhere' }}>{routeError}</p> : null}
    {saveError ? <p role="alert" style={{ ...dangerStyle, margin: 0, padding: '6px 12px', overflowWrap: 'anywhere' }}>{saveError}</p> : null}
    {notice ? <p role="status" style={{ ...mutedStyle, margin: 0, padding: '6px 12px', overflowWrap: 'anywhere' }}>{notice}</p> : null}
    {file?.external ? <p role="status" style={{ ...mutedStyle, margin: 0, padding: '6px 12px' }}>This buffer has an external disk change ({file.external}); the desktop editor remains the authority.</p> : null}
    {file && textKind ? <div style={{ ...headerStyle, paddingBlock: 6 }}>
      {markdownKind ? <>
        <button type="button" aria-pressed={renderMarkdown} onClick={() => { setRenderMarkdown(true); setEditing(false) }} style={buttonStyle}>Rendered</button>
        <button type="button" aria-pressed={!renderMarkdown} onClick={() => { setRenderMarkdown(false); setEditing(false) }} style={buttonStyle}>Source</button>
      </> : null}
      {!file.readOnly ? <button type="button" disabled={!connected || saving} aria-pressed={editing} onClick={() => setEditing((current) => !current)} style={buttonStyle}>{editing ? 'Preview' : 'Edit'}</button> : <span style={mutedStyle}>Read only</span>}
      {editing || file.dirty || localDirty ? <button type="button" disabled={!connected || saving || loading || file.readOnly || (!localDirty && !file.dirty)} onClick={() => void saveFile()} style={buttonStyle}>{saving ? 'Saving…' : 'Save'}</button> : null}
      {localDirty ? <span role="status" style={mutedStyle}>Unsaved changes.</span> : null}
    </div> : null}
    <main style={{ ...scrollStyle, padding: 12, boxSizing: 'border-box' }}>
      {file && textKind && !loading ? editing ? <textarea
        aria-label={`Edit ${file.name}`}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        readOnly={!connected || saving || file.readOnly}
        spellCheck={false}
        style={{ ...inputStyle, height: '100%', minHeight: 220, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre', tabSize: 2 }}
      /> : markdownKind && renderMarkdown ? <MarkdownView value={draft} openLink={openMarkdownLink} /> : <pre style={{ margin: 0, maxWidth: '100%', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', tabSize: 2 }}><SyntaxText value={draft} language={language} /></pre> : null}
      {file && media && !loading ? media.kind === 'image'
        ? <img src={media.url} alt={`${file.name} preview`} style={{ display: 'block', maxWidth: '100%', maxHeight: '70dvh', objectFit: 'contain', margin: '0 auto' }} />
        : media.kind === 'audio' ? <audio controls preload="metadata" src={media.url} style={{ width: '100%' }} />
          : media.kind === 'video' ? <video controls preload="metadata" src={media.url} style={{ display: 'block', maxWidth: '100%', maxHeight: '70dvh', margin: '0 auto' }} />
            : <iframe title={`${file.name} PDF preview`} src={media.url} sandbox="" style={{ display: 'block', width: '100%', height: '70dvh', border: '1px solid var(--border, #555)', borderRadius: 8 }} /> : null}
      {file && !textKind && !media && !loading && !loadError && !notice ? <p style={mutedStyle}>No preview is available for this file.</p> : null}
    </main>
    {pendingNavigation ? <ModalSheet
      title="Discard changes?"
      onClose={() => resolvePendingNavigation('cancel')}
      footer={<>
        <button type="button" onClick={() => resolvePendingNavigation('cancel')} style={buttonStyle}>Keep editing</button>
        <button type="button" onClick={() => resolvePendingNavigation('discard')} style={{ ...buttonStyle, borderColor: 'var(--danger, #dc2626)' }}>Discard changes</button>
      </>}
    >
      <p style={{ marginTop: 0 }}>This file has unsaved mobile edits. Leave without saving?</p>
    </ModalSheet> : null}
  </section>
}

const providerNames: Record<TaskProvider, string> = { github: 'GitHub', gitlab: 'GitLab', linear: 'Linear', jira: 'Jira' }
const providers: TaskProvider[] = ['github', 'gitlab', 'linear', 'jira']

function providerUnavailable(provider: TaskProvider): string {
  if (provider === 'gitlab') return 'GitLab Tasks are unavailable: this desktop build has no public GitLab Tasks provider or hosting methods.'
  if (provider === 'linear') return 'Linear Tasks are unavailable: no quirky.linear provider plugin or public task API is installed on this desktop.'
  if (provider === 'jira') return 'Jira Tasks are unavailable: no quirky.jira provider plugin or public task API is installed on this desktop.'
  return 'GitHub Tasks are unavailable: the public GitHub Tasks API could not be reached.'
}

function parseTaskRepositories(value: unknown): TaskRepository[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const repo = record(raw)
    if (!repo || typeof repo.id !== 'string' || typeof repo.name !== 'string' || typeof repo.worktree !== 'string') return []
    return [{ id: repo.id, name: repo.name, worktree: repo.worktree, ...(typeof repo.displayName === 'string' ? { displayName: repo.displayName } : {}) }]
  })
}

function parseTaskList(value: unknown): TaskList | null {
  const result = record(value)
  if (!result || !Array.isArray(result.items) || !Array.isArray(result.repositories) || !Array.isArray(result.failures)) return null
  const items = result.items.flatMap((raw) => {
    const item = record(raw)
    if (!item || (item.kind !== 'issue' && item.kind !== 'pullRequest') || typeof item.number !== 'number' || typeof item.title !== 'string') return []
    return [item as TaskRow]
  })
  const repositories = parseTaskRepositories(result.repositories)
  return {
    items,
    repositories,
    failures: result.failures.map(record).filter((failure): failure is ObjectValue => failure !== null),
    page: number(result.page, 1),
    totalPages: Math.max(1, number(result.totalPages, 1)),
  }
}

function targetForTask(item: TaskRow, fallbackWorktree?: string): ObjectValue | null {
  const worktree = typeof item.worktree === 'string' && item.worktree ? item.worktree : fallbackWorktree
  if (!worktree || !Number.isSafeInteger(item.number) || item.number <= 0) return null
  return {
    worktree,
    kind: item.kind,
    number: item.number,
    ...(typeof item.url === 'string' && item.url ? { url: item.url } : {})
  }
}

function issueTargetParams(target: ObjectValue): ObjectValue {
  return {
    worktree: target.worktree,
    number: target.number,
    ...(typeof target.url === 'string' ? { url: target.url } : {}),
    ...(typeof target.projectId === 'string' ? { projectId: target.projectId } : {}),
    ...(typeof target.itemId === 'string' ? { itemId: target.itemId } : {}),
    ...(typeof target.host === 'string' ? { host: target.host } : {}),
    ...(typeof target.owner === 'string' ? { owner: target.owner } : {}),
    ...(typeof target.repo === 'string' ? { repo: target.repo } : {})
  }
}
function pullRequestRepository(target: ObjectValue): ObjectValue | null {
  if (typeof target.url !== 'string') return null
  try {
    const url = new URL(target.url)
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/iu.exec(url.pathname)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !match || Number(match[3]) !== target.number) return null
    const owner = decodeURIComponent(match[1]!)
    const repo = decodeURIComponent(match[2]!)
    if (!owner || !repo || owner.includes('/') || repo.includes('/')) return null
    return { host: url.host, owner, repo }
  } catch {
    return null
  }
}

function csvList(value: string): string[] {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))]
}

function taskStatusLabel(item: TaskRow): string {
  if (item.kind === 'pullRequest' && item.state === 'open' && item.isDraft === true) return 'Draft'
  if (typeof item.state === 'string') return item.state.charAt(0).toUpperCase() + item.state.slice(1)
  return 'Unknown'
}

function taskAge(value: unknown): string {
  if (typeof value !== 'string') return ''
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const hours = Math.max(0, Math.floor((Date.now() - timestamp) / 3_600_000))
  if (hours < 1) return 'Updated just now'
  if (hours < 24) return `Updated ${hours}h ago`
  const days = Math.floor(hours / 24)
  return `Updated ${days}d ago`
}

function TaskCard({ item, onOpen, disabled = false }: { item: TaskRow; onOpen: (item: TaskRow) => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} onClick={() => onOpen(item)} style={{ ...buttonStyle, display: 'grid', gap: 6, width: '100%', minWidth: 0, minHeight: 74, textAlign: 'left', padding: 10 }}>
    <strong style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.title}</strong>
    <span style={{ ...mutedStyle, overflowWrap: 'anywhere' }}>{item.kind === 'issue' ? 'Issue' : 'Pull request'} · {string(item.repoName, 'GitHub')} #{item.number} · {taskStatusLabel(item)}</span>
    <span style={{ ...mutedStyle, fontSize: 12 }}>{taskAge(item.updatedAt)}</span>
  </button>
}

function TaskDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div style={{ ...overlayStyle, alignItems: 'stretch', padding: 0, zIndex: 60 }}>
    <section role="dialog" aria-modal="true" aria-label={title} style={{ ...sheetStyle, maxWidth: 760, maxHeight: '100dvh', height: '100dvh', borderRadius: 0 }}>
      <header style={sheetHeaderStyle}>
        <button type="button" aria-label="Close task details" onClick={onClose} style={buttonStyle}>Back</button>
        <h2 style={{ margin: 0, minWidth: 0, flex: '1 1 auto', fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h2>
      </header>
      <div style={{ ...sheetBodyStyle, flex: '1 1 auto' }}>{children}</div>
    </section>
  </div>
}

function TasksPanel({ bridge }: { bridge: PanelBridge }) {
  const connection = useMobileConnection(bridge)
  const connected = connection.phase === 'connected'
  const disconnectedNotice = connectionMessage(connection)
  const [initialized, setInitialized] = useState(false)
  const [provider, setProvider] = useState<TaskProvider>('github')
  const [visibleProviders, setVisibleProviders] = useState<TaskProvider[]>(providers)
  const [mode, setMode] = useState<TaskMode>('issues')
  const [repoIds, setRepoIds] = useState<string[] | null>(null)
  const [query, setQuery] = useState('is:open')
  const [searchDraft, setSearchDraft] = useState('is:open')
  const [page, setPage] = useState(1)
  const [view, setView] = useState<TaskView>('list')
  const [list, setList] = useState<TaskList | null>(null)
  const [allRepositories, setAllRepositories] = useState<TaskRepository[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [stale, setStale] = useState(false)
  const [listError, setListError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filterError, setFilterError] = useState('')
  const [draftStatus, setDraftStatus] = useState('')
  const [draftAssignee, setDraftAssignee] = useState('')
  const [draftReview, setDraftReview] = useState('')
  const [draftRepoIds, setDraftRepoIds] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<TaskRow | null>(null)
  const [detailTarget, setDetailTarget] = useState<ObjectValue | null>(null)
  const [detailItem, setDetailItem] = useState<ObjectValue | null>(null)
  const [comments, setComments] = useState<ObjectValue[]>([])
  const [requestedReviewers, setRequestedReviewers] = useState<string[] | null>(null)
  const [reviewerDraft, setReviewerDraft] = useState('')
  const [reviewerError, setReviewerError] = useState('')
  const [prAssigneeError, setPrAssigneeError] = useState('')
  const [prAssigneeDraft, setPrAssigneeDraft] = useState('')
  const [partialFailures, setPartialFailures] = useState<string[]>([])
  const [viewerCanUpdate, setViewerCanUpdate] = useState<boolean | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailSaving, setDetailSaving] = useState(false)
  const [detailEditing, setDetailEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [bodyDraft, setBodyDraft] = useState('')
  const [labelsDraft, setLabelsDraft] = useState('')
  const [assigneesDraft, setAssigneesDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentError, setCommentError] = useState('')
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [workspaceRequest, setWorkspaceRequest] = useState<ObjectValue | null>(null)
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspacePrompt, setWorkspacePrompt] = useState('')
  const [workspaceAgent, setWorkspaceAgent] = useState('')
  const [workspaceSetup, setWorkspaceSetup] = useState('inherit')
  const [workspaceIssueCommand, setWorkspaceIssueCommand] = useState('inherit')
  const [workspaceAgents, setWorkspaceAgents] = useState<WorkspaceAgent[]>([])
  const [agentError, setAgentError] = useState('')
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [workspaceSuccess, setWorkspaceSuccess] = useState('')
  const [routeError, setRouteError] = useState('')
  const listGeneration = useRef(0)
  const workspaceAgentTouched = useRef(false)
  const detailGeneration = useRef(0)

  useEffect(() => {
    let active = true
    if (!connected) {
      setInitialized(false)
      setStale(true)
      setLoading(false)
      listGeneration.current += 1
      setListError(`Waiting for desktop. ${disconnectedNotice} Previously loaded task results are stale.`)
      return () => { active = false }
    }

    setListError('')
    void bridge.call('quirky.tasks/state', {}).then((value) => {
      if (!active) return
      const state = record(value)
      const navigation = record(state?.navigation)
      const preferences = record(state?.preferences)
      if (!state || !preferences) throw new Error('The Tasks state API returned an invalid settings record.')
      const source = preferences.defaultTaskSource
      if (providers.includes(source as TaskProvider)) setProvider(source as TaskProvider)
      if (Array.isArray(preferences.visibleTaskProviders)) {
        const visible = preferences.visibleTaskProviders.filter((item): item is TaskProvider => providers.includes(item as TaskProvider))
        if (visible.length > 0) setVisibleProviders(visible)
      }
      if (navigation?.mode === 'prs') setMode('prs')
      if (navigation?.mode === 'issues') setMode('issues')
      if (typeof navigation?.query === 'string') { setQuery(navigation.query); setSearchDraft(navigation.query) }
      if (navigation?.repoIds === null) setRepoIds(null)
      else if (Array.isArray(navigation?.repoIds)) setRepoIds(navigation.repoIds.filter((id): id is string => typeof id === 'string'))
      if (typeof navigation?.page === 'number' && navigation.page > 0) setPage(navigation.page)
    }).catch((cause) => {
      if (active) setSettingsError(`Task preferences unavailable. ${announceError(messageOf(cause))}`)
    }).finally(() => { if (active) setInitialized(true) })

    void bridge.call('quirky.tasks/repositories', {}).then((value) => {
      if (!active) return
      if (!Array.isArray(value)) throw new Error('The Tasks repositories API returned an invalid repository list.')
      setAllRepositories(parseTaskRepositories(value))
    }).catch((cause) => {
      if (active) setSettingsError((current) => [current, `Repository options unavailable: ${announceError(messageOf(cause))}`].filter(Boolean).join(' '))
    })
    return () => { active = false }
  }, [bridge, connected, disconnectedNotice])

  const loadList = useCallback(async (force = false, requestedPage = page) => {
    if (provider !== 'github' || !connected) return
    const request = ++listGeneration.current
    setLoading(true)
    setStale(true)
    if (force) setRefreshing(true)
    setListError('')
    try {
      const response = await bridge.call('quirky.tasks/list', {
        mode, repoIds, query, page: requestedPage, ...(force ? { refresh: true } : {})
      })
      if (request !== listGeneration.current) return
      const parsed = parseTaskList(response)
      if (!parsed) throw new Error('The GitHub Tasks API returned an invalid list.')
      setList(parsed)
      setPage(parsed.page)
      setStale(false)
    } catch (cause) {
      if (request === listGeneration.current) {
        setListError(`Unable to load GitHub tasks: ${announceError(messageOf(cause))}`)
        setStale(true)
      }
    } finally {
      if (request === listGeneration.current) { setLoading(false); setRefreshing(false) }
    }
  }, [bridge, connected, mode, page, provider, query, repoIds])

  useEffect(() => {
    if (!connected) { setLoading(false); return }
    if (!initialized) return
    if (!visibleProviders.includes(provider)) {
      setList(null)
      setListError(`The ${providerNames[provider]} task source is hidden in desktop Tasks settings.`)
      setLoading(false)
      return
    }
    if (provider !== 'github') {
      listGeneration.current += 1
      setList(null)
      setLoading(false)
      setStale(false)
      setListError(providerUnavailable(provider))
      return
    }
    void loadList(false)
    return () => { listGeneration.current += 1 }
  }, [connected, initialized, loadList, provider, visibleProviders])

  const beginBack = async () => {
    try { await bridge.navigate({ kind: 'workspaces' }) }
    catch (cause) { setRouteError(`Unable to return to workspaces: ${announceError(messageOf(cause))}`) }
  }

  const selectedRepos = allRepositories.length > 0 ? allRepositories : list?.repositories ?? []
  const selectedRepoNames = repoIds === null ? 'All repos' : repoIds.length === 0 ? 'No repos' : `${repoIds.length} repo${repoIds.length === 1 ? '' : 's'}`
  const activeFilterCount = Number(Boolean(taskFilterValue(query, 'status'))) + Number(Boolean(taskFilterValue(query, 'assignee'))) + Number(Boolean(taskFilterValue(query, 'review'))) + Number(repoIds !== null)

  const openFilters = () => {
    setDraftStatus(taskFilterValue(query, 'status'))
    setDraftAssignee(taskFilterValue(query, 'assignee'))
    setDraftReview(taskFilterValue(query, 'review'))
    setDraftRepoIds(repoIds)
    setFilterError('')
    setFiltersOpen(true)
  }

  const applyFilters = () => {
    try {
      let next = replaceTaskFilter(searchDraft, 'status', draftStatus)
      next = replaceTaskFilter(next, 'assignee', draftAssignee)
      next = replaceTaskFilter(next, 'review', mode === 'prs' ? draftReview : '')
      setQuery(next)
      setSearchDraft(next)
      setRepoIds(draftRepoIds)
      setPage(1)
      setFilterError('')
      setFiltersOpen(false)
    } catch (cause) { setFilterError(announceError(messageOf(cause))) }
  }

  const submitSearch = (event: { preventDefault(): void }) => {
    event.preventDefault()
    setQuery(searchDraft)
    setPage(1)
  }

  const switchMode = (nextMode: TaskMode) => {
    setMode(nextMode)
    setPage(1)
    setDraftReview('')
    if (nextMode === 'issues') {
      const next = replaceTaskFilter(query, 'review', '')
      setQuery(next)
      setSearchDraft(next)
    }
  }

  const openIssue = async (item: TaskRow, refresh = false) => {
    if (item.kind !== 'issue' || !connected) return
    const target = targetForTask(item, selectedRepos.find((repo) => repo.id === item.repoId)?.worktree)
    if (!target) { setDetailError('This task row has no authorized worktree context.'); return }
    const request = ++detailGeneration.current
    setDetailLoading(true)
    setDetailError('')
    try {
      const value = record(await bridge.call('quirky.tasks/issue', {
        ...issueTargetParams(target), ...(refresh ? { refresh: true } : {})
      }))
      if (request !== detailGeneration.current) return
      const itemRecord = record(value?.item)
      if (!itemRecord || itemRecord.kind !== 'issue') throw new Error('The GitHub Tasks API returned no confirmed issue detail.')
      setDetailItem(itemRecord)
      setComments(array(value?.comments).map(record).filter((comment): comment is ObjectValue & { body: string } => comment !== null && typeof comment.body === 'string'))
      setPartialFailures(array(value?.partialFailures).filter((failure): failure is string => typeof failure === 'string'))
      setViewerCanUpdate(typeof value?.viewerCanUpdate === 'boolean' ? value.viewerCanUpdate : null)
      setTitleDraft(string(itemRecord.title))
      setBodyDraft(string(itemRecord.body))
      setLabelsDraft(array(itemRecord.labels).filter((label): label is string => typeof label === 'string').join(', '))
      setAssigneesDraft(array(itemRecord.assignees).filter((login): login is string => typeof login === 'string').join(', '))
    } catch (cause) {
      if (request === detailGeneration.current) setDetailError(`Unable to load issue details: ${announceError(messageOf(cause))}`)
    } finally { if (request === detailGeneration.current) setDetailLoading(false) }
  }
  const openPullRequest = async (item: TaskRow, refresh = false) => {
    if (item.kind !== 'pullRequest' || !connected) return
    const target = targetForTask(item, selectedRepos.find((repo) => repo.id === item.repoId)?.worktree)
    const prRepo = target ? pullRequestRepository(target) : null
    if (!target || !prRepo || typeof target.url !== 'string') {
      setDetailError('This task row has no validated GitHub pull-request repository identity.')
      return
    }
    const request = ++detailGeneration.current
    setDetailLoading(true)
    setDetailError('')
    try {
      const value = record(await bridge.call('quirky.hosting/workItemDetails', {
        worktree: target.worktree,
        number: target.number,
        kind: 'pullRequest',
        reference: target.url,
        ...(refresh ? { noCache: true } : {})
      }))
      if (request !== detailGeneration.current) return
      const itemRecord = record(value?.item)
      if (!itemRecord || itemRecord.kind !== 'pullRequest' || itemRecord.number !== item.number) {
        throw new Error('GitHub did not return the selected pull request.')
      }
      setDetailItem(itemRecord)
      setComments(array(value?.comments).map(record).filter((comment): comment is ObjectValue => comment !== null && typeof comment.body === 'string'))
      setPartialFailures(array(value?.partialFailures).filter((failure): failure is string => typeof failure === 'string'))
      const rawReviewers = value?.requestedReviewers
      setRequestedReviewers(Array.isArray(rawReviewers)
        ? rawReviewers.filter((login): login is string => typeof login === 'string')
        : null)
      setReviewerDraft('')
      setReviewerError('')
      setPrAssigneeDraft(array(itemRecord.assignees).filter((login): login is string => typeof login === 'string').join(', '))
      setTitleDraft(string(itemRecord.title))
      setBodyDraft(string(itemRecord.body))
      setLabelsDraft(array(itemRecord.labels).filter((label): label is string => typeof label === 'string').join(', '))
      setAssigneesDraft(array(itemRecord.assignees).filter((login): login is string => typeof login === 'string').join(', '))
    } catch (cause) {
      if (request === detailGeneration.current) setDetailError(`Unable to load pull request details: ${announceError(messageOf(cause))}`)
    } finally { if (request === detailGeneration.current) setDetailLoading(false) }
  }


  const openTask = async (item: TaskRow) => {
    if (!connected) { setDetailError(`Waiting for desktop. ${disconnectedNotice}`); return }
    const target = targetForTask(item, selectedRepos.find((repo) => repo.id === item.repoId)?.worktree)
    setSelected(item)
    setDetailTarget(target)
    setDetailItem(null)
    setComments([])
    setRequestedReviewers(null)
    setReviewerDraft('')
    setReviewerError('')
    setPrAssigneeError('')
    setPartialFailures([])
    setViewerCanUpdate(null)
    setDetailEditing(false)
    setDetailError('')
    setCommentError('')
    setCommentDraft('')
    setWorkspaceSuccess('')
    if (!target) { setDetailError('This task row has no registered worktree context.'); return }
    try {
      await bridge.call('quirky.tasks/navigate', {
        worktree: target.worktree,
        source: 'github',
        mode: item.kind === 'issue' ? 'issues' : 'prs',
        detail: target
      })
    } catch (cause) { setDetailError(`Unable to select task: ${announceError(messageOf(cause))}`); return }
    if (item.kind === 'issue') await openIssue(item)
    else await openPullRequest(item)
  }

  const updatePullRequest = async (action: 'edit' | 'close' | 'reopen' | 'ready', fields: ObjectValue = {}) => {
    if (!connected || selected?.kind !== 'pullRequest' || !detailTarget || detailSaving || stale) return false
    const prRepo = pullRequestRepository(detailTarget)
    if (!prRepo) { setDetailError('This pull request has no validated repository identity.'); return false }
    setDetailSaving(true)
    setDetailError('')
    try {
      const result = record(await bridge.call('quirky.hosting/updateReview', {
        worktree: detailTarget.worktree,
        number: detailTarget.number,
        prRepo,
        action,
        ...fields
      }))
      if (!result || result.number !== selected.number || result.updated !== true) {
        throw new Error(`GitHub did not confirm the pull request ${action}.`)
      }
      setDetailEditing(false)
      await openPullRequest(selected, true)
      void loadList(true)
      return true
    } catch (cause) {
      setDetailError(`Unable to ${action === 'edit' ? 'save pull request' : `${action} pull request`}: ${announceError(messageOf(cause))}`)
      return false
    } finally { setDetailSaving(false) }
  }

  const savePullRequestFields = async () => {
    if (!detailItem) return
    const fields: ObjectValue = {}
    if (titleDraft !== string(detailItem.title)) fields.title = titleDraft
    if (bodyDraft !== string(detailItem.body)) fields.body = bodyDraft
    if (Object.keys(fields).length === 0) { setDetailEditing(false); return }
    await updatePullRequest('edit', fields)
  }

  const savePullRequestReviewers = async (action: 'add' | 'remove') => {
    if (!connected || selected?.kind !== 'pullRequest' || !detailTarget || detailSaving || stale) return
    const prRepo = pullRequestRepository(detailTarget)
    const inputBytes = new TextEncoder().encode(reviewerDraft).byteLength
    const logins = [...new Set(reviewerDraft.split(/[\s,]+/u).map((login) => login.replace(/^@+/u, '')).filter(Boolean))]
    if (!prRepo) { setReviewerError('This pull request has no validated repository identity.'); return }
    if (inputBytes > 2048) { setReviewerError('Reviewer input exceeds 2,048 UTF-8 bytes.'); return }
    if (logins.length === 0 || logins.length > 15 || logins.some((login) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(login))) {
      setReviewerError('Enter 1–15 valid GitHub reviewer logins.')
      return
    }
    setDetailSaving(true)
    setReviewerError('')
    try {
      const result = record(await bridge.call('quirky.hosting/reviewers', {
        worktree: detailTarget.worktree, number: detailTarget.number, prRepo, action, logins
      }))
      if (!result || result.number !== selected.number || result.updated !== true) throw new Error('GitHub did not confirm the reviewer update.')
      if (Array.isArray(result.reviewers)) {
        setRequestedReviewers(result.reviewers.filter((login): login is string => typeof login === 'string'))
      }
      setReviewerDraft('')
      await openPullRequest(selected, true)
      void loadList(true)
    } catch (cause) { setReviewerError(`Unable to update reviewers: ${announceError(messageOf(cause))}`) }
    finally { setDetailSaving(false) }
  }

  const savePullRequestAssignees = async () => {
    if (!connected || selected?.kind !== 'pullRequest' || !detailTarget || !detailItem || detailSaving || stale) return
    const prRepo = pullRequestRepository(detailTarget)
    const logins = [...new Set(prAssigneeDraft.split(/[\s,]+/u).map((login) => login.replace(/^@+/u, '')).filter(Boolean))]
    if (!prRepo) { setPrAssigneeError('This pull request has no validated repository identity.'); return }
    if (logins.length > 100) { setPrAssigneeError('GitHub supports at most 100 pull-request assignees.'); return }
    setDetailSaving(true)
    setPrAssigneeError('')
    try {
      const result = record(await bridge.call('quirky.hosting/reviewAssignees', {
        worktree: detailTarget.worktree, number: detailTarget.number, prRepo, action: 'set', logins
      }))
      if (!result || result.number !== selected.number || !Array.isArray(result.assignees)) {
        throw new Error('GitHub did not confirm the assignee update.')
      }
      const assignees = result.assignees.filter((login): login is string => typeof login === 'string')
      setPrAssigneeDraft(assignees.join(', '))
      setDetailItem((current) => current ? { ...current, assignees } : current)
      await openPullRequest(selected, true)
      void loadList(true)
    } catch (cause) { setPrAssigneeError(`Unable to update pull-request assignees: ${announceError(messageOf(cause))}`) }
    finally { setDetailSaving(false) }
  }

  const submitPullRequestComment = async () => {
    if (!connected || selected?.kind !== 'pullRequest' || !detailTarget || !commentDraft.trim() || detailSaving || stale) return
    const prRepo = pullRequestRepository(detailTarget)
    if (!prRepo) { setCommentError('This pull request has no validated repository identity.'); return }
    setDetailSaving(true)
    setCommentError('')
    try {
      const result = record(await bridge.call('quirky.hosting/reviewConversation', {
        worktree: detailTarget.worktree, number: detailTarget.number, prRepo, action: 'add', body: commentDraft
      }))
      const comment = record(result?.comment)
      if (!comment || result?.number !== selected.number || typeof comment.body !== 'string') {
        throw new Error('GitHub did not confirm the pull-request comment.')
      }
      setComments((current) => [...current, comment])
      setCommentDraft('')
      await openPullRequest(selected, true)
    } catch (cause) { setCommentError(`Unable to post pull-request comment: ${announceError(messageOf(cause))}`) }
    finally { setDetailSaving(false) }
  }

  const closeSelectedTask = async () => {
    setCloseConfirm(false)
    if (selected?.kind === 'issue') await saveIssue({ state: 'closed' })
    else if (selected?.kind === 'pullRequest') await updatePullRequest('close')
  }

  const closeTask = async () => {
    detailGeneration.current += 1
    setSelected(null)
    setDetailTarget(null)
    setDetailItem(null)
    setDetailEditing(false)
    setCloseConfirm(false)
    try { await bridge.call('quirky.tasks/navigate', { detail: null }) }
    catch (cause) { setRouteError(`Task details closed locally, but desktop navigation could not be updated: ${announceError(messageOf(cause))}`) }
  }

  const saveIssue = async (extra: ObjectValue = {}) => {
    if (!connected || !selected || !detailTarget || !detailItem || detailSaving || stale) return false
    const changes: ObjectValue = { ...extra }
    if (!extra.state && titleDraft !== string(detailItem.title)) changes.title = titleDraft
    if (viewerCanUpdate === true && bodyDraft !== string(detailItem.body)) changes.body = bodyDraft
    const labels = csvList(labelsDraft)
    const assignees = csvList(assigneesDraft)
    const currentLabels = array(detailItem.labels).filter((entry): entry is string => typeof entry === 'string')
    const currentAssignees = array(detailItem.assignees).filter((entry): entry is string => typeof entry === 'string')
    if (!extra.state && JSON.stringify(labels) !== JSON.stringify(currentLabels)) changes.labels = labels
    if (!extra.state && JSON.stringify(assignees) !== JSON.stringify(currentAssignees)) changes.assignees = assignees
    if (Object.keys(changes).length === 0) { setDetailEditing(false); return true }
    setDetailSaving(true)
    setDetailError('')
    try {
      const result = record(await bridge.call('quirky.tasks/issueEdit', { ...issueTargetParams(detailTarget), ...changes }))
      const updated = record(result?.item)
      if (!updated || updated.kind !== 'issue' || updated.number !== selected.number) throw new Error('GitHub did not confirm the issue update.')
      setDetailItem(updated)
      setTitleDraft(string(updated.title))
      setBodyDraft(string(updated.body))
      setLabelsDraft(array(updated.labels).filter((entry): entry is string => typeof entry === 'string').join(', '))
      setAssigneesDraft(array(updated.assignees).filter((entry): entry is string => typeof entry === 'string').join(', '))
      setDetailEditing(false)
      if (typeof result?.refreshError === 'string') setDetailError(`Saved, but issue details could not be refreshed: ${result.refreshError}`)
      void loadList(true)
      return true
    } catch (cause) {
      setDetailError(`Unable to save issue: ${announceError(messageOf(cause))}`)
      return false
    } finally { setDetailSaving(false) }
  }

  const submitComment = async () => {
    if (!connected || !selected || !detailTarget || !commentDraft.trim() || detailSaving || stale) return
    setDetailSaving(true)
    setCommentError('')
    try {
      const result = record(await bridge.call('quirky.tasks/issueComment', {
        ...issueTargetParams(detailTarget), body: commentDraft
      }))
      const comment = record(result?.comment)
      if (!comment || typeof comment.body !== 'string') throw new Error('GitHub did not confirm the comment.')
      setComments((current) => [...current, comment as ObjectValue])
      setCommentDraft('')
    } catch (cause) { setCommentError(`Unable to post comment: ${announceError(messageOf(cause))}`) }
    finally { setDetailSaving(false) }
  }

  const openConfirmedWorkspace = async (result: { kind: 'created' | 'resumed'; worktreeId: string; name: string }) => {
    setWorkspaceOpen(false)
    setWorkspaceRequest(null)
    setWorkspaceSuccess(`Workspace ${result.kind === 'created' ? 'created' : 'opened'}${result.name ? `: ${result.name}` : ''}. It is linked to this task.`)
    try {
      await bridge.navigate({ kind: 'session', worktreeId: result.worktreeId })
    } catch (cause) {
      setWorkspaceError(`The workspace is ready, but could not be opened: ${announceError(messageOf(cause))}`)
    }
  }

  const startWorkspace = async () => {
    if (!connected || !selected || !detailTarget || stale || workspaceBusy) return
    setWorkspaceBusy(true)
    setWorkspaceError('')
    setWorkspaceSuccess('')
    try {
      const raw = await bridge.call('quirky.tasks/workspace', { target: detailTarget, action: 'start', newWorkspace: true })
      const result = classifyWorkspaceResult(raw)
      if (result.kind === 'invalid') throw new Error('The GitHub Tasks API did not return a workspace composer or created worktree.')
      if (result.kind === 'created' || result.kind === 'resumed') {
        await openConfirmedWorkspace(result)
        return
      }
      const request = result.request
      workspaceAgentTouched.current = false
      setWorkspaceRequest(request)
      setWorkspaceName(string(request.name))
      setWorkspacePrompt(string(request.prompt))
      setWorkspaceSetup(string(request.setup, 'inherit'))
      setWorkspaceIssueCommand(string(request.issueCommand, 'inherit'))
      setWorkspaceAgent(string(request.agent))
      setWorkspaceOpen(true)
      setAgentError('')
      void bridge.call('quirky.mobile/agentCatalog', {}).then((value) => {
        const response = record(value)
        const defaultAgent = typeof response?.defaultAgent === 'string' ? response.defaultAgent : ''
        const available = array(response?.agents).flatMap((entry) => {
          const agent = record(entry)
          if (!agent || agent.installed !== true || agent.enabled !== true || typeof agent.id !== 'string') return []
          return [{ id: agent.id, label: string(agent.label, agent.id), isDefault: agent.isDefault === true || agent.id === defaultAgent }]
        })
        setWorkspaceAgents(available)
        if (!workspaceAgentTouched.current && !string(request.agent)) setWorkspaceAgent(available.find((agent) => agent.isDefault)?.id ?? '')
      }).catch((cause) => setAgentError(`Agent options unavailable; workspace creation can continue without an agent. ${announceError(messageOf(cause))}`))
    } catch (cause) { setWorkspaceError(`Unable to start workspace: ${announceError(messageOf(cause))}`) }
    finally { setWorkspaceBusy(false) }
  }

  const cancelWorkspace = async () => {
    if (!workspaceRequest) { setWorkspaceOpen(false); return }
    if (workspaceBusy) { setWorkspaceError('A workspace request is still in progress. Wait for it to finish before closing.'); return }
    if (!connected) {
      setWorkspaceOpen(false)
      setRouteError('Workspace composer was dismissed locally; reconnect to cancel it on desktop.')
      return
    }
    const requestId = string(workspaceRequest.requestId)
    if (!requestId) { setWorkspaceError('The active workspace composer has no request identity.'); return }
    setWorkspaceBusy(true)
    setWorkspaceError('')
    try {
      await bridge.call('quirky.tasks/workspaceComposerCancel', { requestId })
      setWorkspaceOpen(false)
      setWorkspaceRequest(null)
    } catch (cause) { setWorkspaceError(`Unable to cancel workspace creation: ${announceError(messageOf(cause))}`) }
    finally { setWorkspaceBusy(false) }
  }

  const submitWorkspace = async (decision?: WorkspaceConsentDecision) => {
    if (!connected || !workspaceRequest || workspaceBusy || stale) return
    const target = record(workspaceRequest.target)
    const requestId = string(workspaceRequest.requestId)
    if (!target || !requestId) { setWorkspaceError('The active workspace composer is incomplete.'); return }
    const trustKind = workspaceRequest.trustKind === 'setup' || workspaceRequest.trustKind === 'issue' ? workspaceRequest.trustKind : null
    const displayedHash = string(workspaceRequest.trustHash)
    if (decision?.choice === 'run' && (trustKind !== decision.kind || typeof workspaceRequest.trustScript !== 'string' || !displayedHash)) {
      setWorkspaceError(`The creator did not provide a content hash for this ${decision.kind === 'issue' ? 'issue command' : 'setup'} script, so it cannot be approved once.`)
      return
    }
    const setupChoice = decision?.kind === 'setup' ? decision.choice : workspaceSetup
    const issueCommandChoice = decision?.kind === 'issue' ? decision.choice : workspaceIssueCommand
    const setupApprovalHash = setupChoice === 'run'
      ? decision?.kind === 'setup' && decision.choice === 'run' ? displayedHash : string(workspaceRequest.trustSetupHash)
      : ''
    const issueCommandApprovalHash = issueCommandChoice === 'run'
      ? decision?.kind === 'issue' && decision.choice === 'run' ? displayedHash : string(workspaceRequest.trustIssueCommandHash)
      : ''
    setWorkspaceBusy(true)
    setWorkspaceError('')
    if (decision?.kind === 'setup') setWorkspaceSetup(decision.choice)
    if (decision?.kind === 'issue') setWorkspaceIssueCommand(decision.choice)
    try {
      const response = await bridge.call('quirky.tasks/workspace', {
        target, action: 'start', newWorkspace: true, composerRequestId: requestId,
        name: workspaceName.trim(), prompt: workspacePrompt, setup: setupChoice,
        ...(target.kind === 'issue' ? { issueCommand: issueCommandChoice } : {}),
        agent: workspaceAgent,
        ...(setupApprovalHash ? { trustSetup: true, trustSetupHash: setupApprovalHash } : {}),
        ...(issueCommandApprovalHash ? { trustIssueCommand: true, trustIssueCommandHash: issueCommandApprovalHash } : {})
      })
      const outcome = classifyWorkspaceResult(response)
      if (outcome.kind === 'created' || outcome.kind === 'resumed') {
        await openConfirmedWorkspace(outcome)
      } else if (outcome.kind === 'composer') {
        setWorkspaceRequest(outcome.request)
        setWorkspaceError(string(outcome.request.error))
      } else throw new Error('The GitHub Tasks API did not confirm a created worktree.')
    } catch (cause) { setWorkspaceError(`Unable to create workspace: ${announceError(messageOf(cause))}`) }
    finally { setWorkspaceBusy(false) }
  }

  const openExternal = async (value: unknown) => {
    const url = safeExternalUrl(value)
    if (!url) { setRouteError('This task has no safe external URL.'); return }
    try { await bridge.native.openExternal(url) }
    catch (cause) { setRouteError(`Unable to open task link: ${announceError(messageOf(cause))}`) }
  }

  const copyLink = async (value: unknown) => {
    const url = safeExternalUrl(value)
    if (!url) { setRouteError('This task has no safe link to copy.'); return }
    try { await bridge.native.clipboardWrite(url); setRouteError('Task link copied.') }
    catch (cause) { setRouteError(`Unable to copy task link: ${announceError(messageOf(cause))}`) }
  }

  const changeProvider = (next: TaskProvider) => {
    setProvider(next)
    setListError('')
    setList(null)
    setPage(1)
  }

  const changePage = (next: number) => {
    const bounded = Math.max(1, Math.min(list?.totalPages ?? 1, next))
    setPage(bounded)
  }

  const boardColumns = useMemo(() => {
    const statuses = mode === 'issues' ? ['open', 'closed', 'unknown'] : ['open', 'draft', 'merged', 'closed', 'unknown']
    return statuses.map((status) => ({
      status,
      items: (list?.items ?? []).filter((item) => (item.kind === 'pullRequest' && item.isDraft === true && item.state === 'open' ? 'draft' : string(item.state, 'unknown')) === status)
    }))
  }, [list?.items, mode])

  const statusOptions = mode === 'issues'
    ? [{ value: '', label: 'Any status' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]
    : [{ value: '', label: 'Any status' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }, { value: 'merged', label: 'Merged' }, { value: 'draft', label: 'Draft' }]
  const repoFilterChecked = (id: string) => draftRepoIds === null || draftRepoIds.includes(id)
  const workspaceTrustKind = workspaceRequest?.trustKind === 'setup' || workspaceRequest?.trustKind === 'issue' ? workspaceRequest.trustKind : null
  const workspaceTrustLabel = workspaceTrustKind === 'issue' ? 'Issue command' : 'Setup script'
  const workspaceConsentLabel = workspaceTrustKind === 'issue' ? 'issue command' : 'setup'
  const workspaceTrustRequired = workspaceTrustKind !== null && typeof workspaceRequest?.trustScript === 'string'
  const workspaceTrustHashAvailable = typeof workspaceRequest?.trustHash === 'string' && workspaceRequest.trustHash.length > 0
  const workspaceTrustCanRun = workspaceTrustKind === 'setup'
    ? workspaceSetup === 'run'
    : workspaceTrustKind === 'issue' ? workspaceIssueCommand === 'run' : false

  const setRepoChecked = (id: string, checked: boolean) => {
    if (draftRepoIds === null) {
      if (!checked) setDraftRepoIds(selectedRepos.map((repo) => repo.id).filter((repoId) => repoId !== id))
      return
    }
    setDraftRepoIds(checked ? [...new Set([...draftRepoIds, id])] : draftRepoIds.filter((repoId) => repoId !== id))
  }

  return <section aria-label="Tasks" style={rootStyle}>
    <header style={headerStyle}>
      <button type="button" aria-label="Back to workspaces" onClick={() => void beginBack()} style={buttonStyle}>Back</button>
      <h1 style={{ margin: '0 auto 0 0', fontSize: 18 }}>Tasks</h1>
      <span style={{ ...mutedStyle, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bridge.init.host.name}</span>
      {!connected ? <span role="status" style={{ ...dangerStyle, overflowWrap: 'anywhere' }}>{disconnectedNotice}</span> : null}
      <button type="button" aria-label="Refresh tasks" disabled={loading || provider !== 'github' || !connected} onClick={() => void loadList(true)} style={buttonStyle}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
    </header>
    <div style={{ flex: '0 0 auto', display: 'grid', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border, #3b3d43)', maxHeight: '42dvh', overflow: 'auto', overscrollBehavior: 'contain' }}>
      <div role="group" aria-label="Task provider" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {providers.filter((item) => visibleProviders.includes(item)).map((item) => <button key={item} type="button" aria-pressed={provider === item} onClick={() => changeProvider(item)} style={{ ...buttonStyle, minHeight: 32, padding: '5px 9px', borderColor: provider === item ? 'var(--accent, #6ea8fe)' : undefined }}>{providerNames[item]}</button>)}
      </div>
      <div role="group" aria-label="Task kind" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" aria-pressed={mode === 'issues'} onClick={() => switchMode('issues')} style={{ ...buttonStyle, minHeight: 32, padding: '5px 9px' }}>Issues</button>
        <button type="button" aria-pressed={mode === 'prs'} onClick={() => switchMode('prs')} style={{ ...buttonStyle, minHeight: 32, padding: '5px 9px' }}>Pull requests</button>
        <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')} style={{ ...buttonStyle, minHeight: 32, padding: '5px 9px', marginLeft: 'auto' }}>List</button>
        <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')} style={{ ...buttonStyle, minHeight: 32, padding: '5px 9px' }}>Board</button>
        <button type="button" aria-label="Task filters" onClick={openFilters} style={{ ...buttonStyle, minHeight: 32, padding: '5px 9px' }}>Filters{activeFilterCount ? ` · ${activeFilterCount}` : ''}</button>
      </div>
      <form onSubmit={submitSearch} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
        <input aria-label="Search GitHub tasks" placeholder="Search tasks (GitHub query)" value={searchDraft} onChange={(event) => setSearchDraft(event.currentTarget.value)} style={{ ...inputStyle, minHeight: 36, flex: 1 }} />
        <button type="submit" disabled={provider !== 'github' || !connected} style={buttonStyle}>Search</button>
      </form>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ ...mutedStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedRepoNames}</span>
        {stale ? <strong role="status" style={dangerStyle}>Stale · refresh before editing</strong> : null}
      </div>
    </div>
    {settingsError ? <p role="status" style={{ ...mutedStyle, margin: 0, padding: '6px 10px', overflowWrap: 'anywhere' }}>{settingsError}</p> : null}
    {listError ? <p role="alert" style={{ ...dangerStyle, margin: 0, padding: '8px 10px', overflowWrap: 'anywhere' }}>{listError}</p> : null}
    {routeError ? <p role="status" style={{ ...mutedStyle, margin: 0, padding: '6px 10px', overflowWrap: 'anywhere' }}>{routeError}</p> : null}
    {provider === 'github' ? <>
      {list?.failures.map((failure, index) => <p key={`${string(failure.repoId)}:${index}`} role="status" style={{ ...dangerStyle, margin: 0, padding: '4px 10px', overflowWrap: 'anywhere' }}>{string(failure.message, 'GitHub source unavailable.')}</p>)}
      <main style={{ ...scrollStyle, padding: 10, boxSizing: 'border-box' }}>
        {loading && !list ? <p role="status">Loading GitHub tasks…</p> : null}
        {!loading && !listError && list && list.repositories.length === 0 ? <p style={mutedStyle}>No configured GitHub repositories are available on this desktop.</p> : null}
        {!loading && !listError && list && list.items.length === 0 && list.repositories.length > 0 && list.failures.length === 0 ? <p style={mutedStyle}>No tasks match this query and repository selection.</p> : null}
        {list && list.items.length > 0 && view === 'list' ? <div style={{ display: 'grid', gap: 8 }}>{list.items.map((item) => <TaskCard key={`${item.repoId}:${item.kind}:${item.number}`} item={item} disabled={!connected || stale} onOpen={(next) => void openTask(next)} />)}</div> : null}
        {list && list.items.length > 0 && view === 'board' ? <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', overflowX: 'auto', paddingBottom: 8 }}>
          {boardColumns.map((column) => <section key={column.status} aria-label={`${column.status} tasks`} style={{ flex: '0 0 min(82vw, 260px)', display: 'grid', alignContent: 'start', gap: 8, minHeight: 80, padding: 8, border: '1px solid var(--border, #3b3d43)', borderRadius: 10, background: 'var(--surface-raised, #202126)' }}>
            <h2 style={{ margin: '0 0 2px', fontSize: 14, textTransform: 'capitalize' }}>{column.status} · {column.items.length}</h2>
            {column.items.length ? column.items.map((item) => <TaskCard key={`${item.repoId}:${item.kind}:${item.number}`} item={item} disabled={!connected || stale} onOpen={(next) => void openTask(next)} />) : <span style={mutedStyle}>No tasks</span>}
          </section>)}
        </div> : null}
      </main>
      {list && list.totalPages > 1 ? <footer style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, padding: 8, borderTop: '1px solid var(--border, #3b3d43)' }}>
        <button type="button" disabled={!connected || loading || page <= 1} onClick={() => changePage(page - 1)} style={buttonStyle}>Previous</button>
        <span aria-live="polite">Page {page} of {list.totalPages}</span>
        <button type="button" disabled={!connected || loading || page >= list.totalPages} onClick={() => changePage(page + 1)} style={buttonStyle}>Next</button>
      </footer> : null}
    </> : <main style={{ ...scrollStyle, padding: 12, boxSizing: 'border-box' }}>
      <p role="status" style={{ ...dangerStyle, overflowWrap: 'anywhere' }}>{!visibleProviders.includes(provider) ? `The ${providerNames[provider]} task source is hidden in desktop Tasks settings.` : providerUnavailable(provider)}</p>
    </main>}

    {filtersOpen ? <ModalSheet title="Task filters" onClose={() => setFiltersOpen(false)} footer={<>
      <button type="button" onClick={() => { setDraftStatus(''); setDraftAssignee(''); setDraftReview(''); setDraftRepoIds(null) }} style={buttonStyle}>Clear filters</button>
      <button type="button" onClick={() => setFiltersOpen(false)} style={buttonStyle}>Cancel</button>
      <button type="button" onClick={applyFilters} style={buttonStyle}>Apply filters</button>
    </>}>
      <div style={{ display: 'grid', gap: 14 }}>
        <label style={{ display: 'grid', gap: 6 }}><span>Repository</span>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={draftRepoIds === null} onChange={(event) => setDraftRepoIds(event.currentTarget.checked ? null : [])} /><span>All repositories</span></label>
          {selectedRepos.map((repo) => <label key={repo.id} style={{ display: 'flex', gap: 8, alignItems: 'center', overflowWrap: 'anywhere' }}>
            <input type="checkbox" checked={repoFilterChecked(repo.id)} onChange={(event) => setRepoChecked(repo.id, event.currentTarget.checked)} />
            <span>{repo.displayName ?? repo.name}</span>
          </label>)}
          {selectedRepos.length === 0 ? <span style={mutedStyle}>Repository options load with the GitHub list.</span> : null}
        </label>
        <label style={{ display: 'grid', gap: 6 }}><span>Status</span><select aria-label="Status filter" value={draftStatus} onChange={(event) => setDraftStatus(event.currentTarget.value)} style={inputStyle}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 6 }}><span>Assignee</span><select aria-label="Assignee filter" value={draftAssignee === '@me' ? '@me' : draftAssignee ? 'custom' : ''} onChange={(event) => setDraftAssignee(event.currentTarget.value === 'custom' ? draftAssignee : event.currentTarget.value)} style={inputStyle}>
          <option value="">Any assignee</option><option value="@me">Assigned to me</option>{draftAssignee && draftAssignee !== '@me' ? <option value="custom">{draftAssignee}</option> : null}
        </select><input aria-label="Assignee login" placeholder="GitHub login" value={draftAssignee === '@me' ? '' : draftAssignee} onChange={(event) => setDraftAssignee(event.currentTarget.value)} style={inputStyle} /></label>
        {mode === 'prs' ? <label style={{ display: 'grid', gap: 6 }}><span>Review</span><select aria-label="Review filter" value={draftReview} onChange={(event) => setDraftReview(event.currentTarget.value)} style={inputStyle}>
          <option value="">Any review state</option><option value="needs-review">Needs review · assigned to me</option><option value="approved">Approved</option><option value="changes_requested">Changes requested</option><option value="none">No review</option><option value="required">Review required</option>
        </select></label> : null}
        {filterError ? <p role="alert" style={{ ...dangerStyle, margin: 0 }}>{filterError}</p> : null}
      </div>
    </ModalSheet> : null}

    {selected ? <TaskDrawer title={`${selected.kind === 'issue' ? 'Issue' : 'Pull request'} #${selected.number}`} onClose={() => void closeTask()}>
      <div style={{ display: 'grid', gap: 12 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <strong style={{ flex: '1 1 100%', overflowWrap: 'anywhere' }}>{string(detailItem?.title, selected.title)}</strong>
          <span style={mutedStyle}>{string(selected.repoName, 'GitHub')} · {taskStatusLabel((detailItem as TaskRow | null) ?? selected)}</span>
          <button type="button" onClick={() => selected.kind === 'issue' ? void openIssue(selected, true) : void openPullRequest(selected, true)} disabled={!connected || detailLoading || stale} style={buttonStyle}>Refresh</button>
          <button type="button" onClick={() => void copyLink(detailItem?.url ?? selected.url)} style={buttonStyle}>Copy link</button>
          <button type="button" onClick={() => void openExternal(detailItem?.url ?? selected.url)} style={buttonStyle}>Open externally</button>
        </header>
        {!connected ? <p role="status" style={{ ...dangerStyle, margin: 0 }}>{disconnectedNotice} Task details are stale; writes are disabled.</p> : null}
        {detailError ? <p role="alert" style={{ ...dangerStyle, margin: 0, overflowWrap: 'anywhere' }}>{detailError}</p> : null}
        {workspaceSuccess ? <p role="status" style={{ margin: 0 }}>{workspaceSuccess}</p> : null}
        {!workspaceOpen && workspaceError ? <p role="alert" style={{ ...dangerStyle, margin: 0, overflowWrap: 'anywhere' }}>{workspaceError}</p> : null}
        <button type="button" disabled={!connected || !detailTarget || stale || workspaceBusy} onClick={() => void startWorkspace()} style={{ ...buttonStyle, justifySelf: 'start' }}>{workspaceBusy ? 'Preparing workspace…' : 'Create Workspace In'}</button>
        {detailLoading ? <p role="status">Loading task details…</p> : null}
        {selected.kind === 'pullRequest' ? <>
          {detailItem ? <>
            {partialFailures.map((failure, index) => <p key={index} role="status" style={{ ...mutedStyle, margin: 0 }}>{failure}</p>)}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Description</h3>
              <button type="button" disabled={!connected || stale} onClick={() => setDetailEditing((value) => !value)} style={buttonStyle}>{detailEditing ? 'Preview' : 'Edit fields'}</button>
            </div>
            {detailEditing ? <div style={{ display: 'grid', gap: 10 }}>
              <label style={{ display: 'grid', gap: 5 }}><span>Title</span><input value={titleDraft} disabled={!connected || stale} maxLength={256} onChange={(event) => setTitleDraft(event.currentTarget.value)} style={inputStyle} /></label>
              <label style={{ display: 'grid', gap: 5 }}><span>Description (Markdown)</span><textarea value={bodyDraft} disabled={!connected || stale} onChange={(event) => setBodyDraft(event.currentTarget.value)} style={{ ...inputStyle, minHeight: 140, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} /></label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" disabled={!connected || detailSaving || stale} onClick={() => void savePullRequestFields()} style={buttonStyle}>{detailSaving ? 'Saving…' : 'Save fields'}</button>
                <button type="button" onClick={() => { setDetailEditing(false); setTitleDraft(string(detailItem.title)); setBodyDraft(string(detailItem.body)) }} style={buttonStyle}>Cancel edits</button>
              </div>
            </div> : <MarkdownView value={string(detailItem.body)} openLink={(url) => void openExternal(url)} />}
            <div style={{ display: 'grid', gap: 5, padding: 9, border: '1px solid var(--border, #3b3d43)', borderRadius: 8 }}>
              <strong>Pull request fields</strong>
              <span>State: {taskStatusLabel(detailItem as TaskRow)}</span>
              <span>Author: {string(detailItem.author, 'Unknown')}</span>
              <span>Branch: {string(detailItem.headRefName, 'Unknown')} → {string(detailItem.baseRefName, 'Unknown')}</span>
              <span>Review decision: {string(detailItem.reviewDecision, 'Unknown')}</span>
              <span>Labels: {array(detailItem.labels).map(String).join(', ') || 'None'}</span>
              <span>Requested reviewers: {requestedReviewers === null ? 'Unavailable' : requestedReviewers.join(', ') || 'None'}</span>
              <span>Assignees: {array(detailItem.assignees).map(String).join(', ') || 'None'}</span>
            </div>
            <section style={{ display: 'grid', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Requested reviewers</h3>
              <label style={{ display: 'grid', gap: 5 }}><span>GitHub logins (comma or space separated)</span><textarea aria-label="Requested reviewers" disabled={!connected || stale} maxLength={2048} value={reviewerDraft} onChange={(event) => setReviewerDraft(event.currentTarget.value)} style={{ ...inputStyle, minHeight: 68, resize: 'vertical' }} /></label>
              {reviewerError ? <p role="alert" style={{ ...dangerStyle, margin: 0 }}>{reviewerError}</p> : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" disabled={!connected || stale || detailSaving || !reviewerDraft.trim()} onClick={() => void savePullRequestReviewers('add')} style={buttonStyle}>Request reviewers</button>
                <button type="button" disabled={!connected || stale || detailSaving || !reviewerDraft.trim()} onClick={() => void savePullRequestReviewers('remove')} style={buttonStyle}>Remove reviewers</button>
              </div>
            </section>
            <section style={{ display: 'grid', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Pull-request assignees</h3>
              <label style={{ display: 'grid', gap: 5 }}><span>GitHub logins (comma separated)</span><input aria-label="Pull request assignees" disabled={!connected || stale} value={prAssigneeDraft} onChange={(event) => setPrAssigneeDraft(event.currentTarget.value)} style={inputStyle} /></label>
              {prAssigneeError ? <p role="alert" style={{ ...dangerStyle, margin: 0 }}>{prAssigneeError}</p> : null}
              <button type="button" disabled={!connected || stale || detailSaving} onClick={() => void savePullRequestAssignees()} style={{ ...buttonStyle, justifySelf: 'start' }}>Save assignees</button>
            </section>
            <section style={{ display: 'grid', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Comments and reviews · {comments.length}</h3>
              {comments.length ? comments.map((comment, index) => <article key={`${string(comment.kind)}:${string(comment.id, String(index))}`} style={{ display: 'grid', gap: 5, padding: 9, border: '1px solid var(--border, #3b3d43)', borderRadius: 8 }}>
                <span style={mutedStyle}>{string(comment.kind, 'Comment')} · {string(comment.author, 'Unknown author')} · {string(comment.createdAt)}{comment.path ? ` · ${string(comment.path)}${typeof comment.line === 'number' ? `:${comment.line}` : ''}` : ''}</span>
                <MarkdownView value={string(comment.body)} openLink={(url) => void openExternal(url)} />
              </article>) : <p style={mutedStyle}>No pull-request comments or reviews were returned.</p>}
              <label style={{ display: 'grid', gap: 5 }}><span>Add pull-request comment</span><textarea aria-label="New pull request comment" disabled={!connected || stale} maxLength={65_536} value={commentDraft} onChange={(event) => setCommentDraft(event.currentTarget.value)} style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} /></label>
              {commentError ? <p role="alert" style={{ ...dangerStyle, margin: 0 }}>{commentError}</p> : null}
              <button type="button" disabled={!connected || stale || detailSaving || !commentDraft.trim()} onClick={() => void submitPullRequestComment()} style={{ ...buttonStyle, justifySelf: 'start' }}>Post comment</button>
            </section>
            {string(detailItem.state) === 'closed'
              ? <button type="button" disabled={!connected || detailSaving || stale} onClick={() => void updatePullRequest('reopen')} style={{ ...buttonStyle, justifySelf: 'start' }}>Reopen pull request</button>
              : string(detailItem.state) === 'merged' ? <p style={mutedStyle}>This pull request is merged.</p>
                : <button type="button" disabled={!connected || detailSaving || stale} onClick={() => setCloseConfirm(true)} style={{ ...buttonStyle, justifySelf: 'start' }}>Close pull request</button>}
            {detailItem.isDraft === true || detailItem.state === 'draft'
              ? <button type="button" disabled={!connected || detailSaving || stale} onClick={() => void updatePullRequest('ready')} style={{ ...buttonStyle, justifySelf: 'start' }}>Mark ready for review</button>
              : null}
          </> : null}
        </> : null}
        {selected.kind === 'issue' && detailItem ? <>
          {partialFailures.map((failure, index) => <p key={index} role="status" style={{ ...mutedStyle, margin: 0 }}>{failure}</p>)}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Description</h3>
            <button type="button" disabled={!connected || stale} onClick={() => setDetailEditing((value) => !value)} style={buttonStyle}>{detailEditing ? 'Preview' : 'Edit fields'}</button>
          </div>
          {detailEditing ? <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 5 }}><span>Title</span><input value={titleDraft} disabled={!connected || stale} maxLength={256} onChange={(event) => setTitleDraft(event.currentTarget.value)} style={inputStyle} /></label>
            <label style={{ display: 'grid', gap: 5 }}><span>Description (Markdown){viewerCanUpdate !== true ? ' · read only' : ''}</span><textarea value={bodyDraft} disabled={!connected || stale || viewerCanUpdate !== true} maxLength={1_048_576} onChange={(event) => setBodyDraft(event.currentTarget.value)} style={{ ...inputStyle, minHeight: 140, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} /></label>
            <label style={{ display: 'grid', gap: 5 }}><span>Labels (comma separated)</span><input value={labelsDraft} disabled={!connected || stale} onChange={(event) => setLabelsDraft(event.currentTarget.value)} style={inputStyle} /></label>
            <label style={{ display: 'grid', gap: 5 }}><span>Assignees (comma-separated GitHub logins)</span><input value={assigneesDraft} disabled={!connected || stale} onChange={(event) => setAssigneesDraft(event.currentTarget.value)} style={inputStyle} /></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><button type="button" disabled={!connected || detailSaving || stale} onClick={() => void saveIssue()} style={buttonStyle}>{detailSaving ? 'Saving…' : 'Save fields'}</button><button type="button" onClick={() => { setDetailEditing(false); setTitleDraft(string(detailItem.title)); setBodyDraft(string(detailItem.body)); setLabelsDraft(array(detailItem.labels).filter((item): item is string => typeof item === 'string').join(', ')); setAssigneesDraft(array(detailItem.assignees).filter((item): item is string => typeof item === 'string').join(', ')) }} style={buttonStyle}>Cancel edits</button></div>
          </div> : <MarkdownView value={string(detailItem.body)} openLink={(url) => void openExternal(url)} />}
          {viewerCanUpdate !== true ? <p style={mutedStyle}>Description editability was not confirmed by GitHub; title, labels, assignees, and status remain available where supported.</p> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <strong>Labels:</strong>{array(detailItem.labels).length ? array(detailItem.labels).map((label, index) => <span key={index} style={{ padding: '2px 7px', border: '1px solid var(--border, #4b4d54)', borderRadius: 999 }}>{String(label)}</span>) : <span style={mutedStyle}>None</span>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <strong>Assignees:</strong>{array(detailItem.assignees).length ? array(detailItem.assignees).map((assignee, index) => <span key={index}>{String(assignee)}</span>) : <span style={mutedStyle}>Unassigned</span>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {string(detailItem.state) === 'closed'
              ? <button type="button" disabled={!connected || detailSaving || stale} onClick={() => void saveIssue({ state: 'open' })} style={buttonStyle}>Reopen issue</button>
              : <button type="button" disabled={!connected || detailSaving || stale} onClick={() => setCloseConfirm(true)} style={buttonStyle}>Close issue</button>}
          </div>
          <section style={{ display: 'grid', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Comments · {comments.length}</h3>
            {comments.length ? comments.map((comment, index) => <article key={`${string(comment.id, String(index))}`} style={{ display: 'grid', gap: 5, padding: 9, border: '1px solid var(--border, #3b3d43)', borderRadius: 8 }}>
              <span style={mutedStyle}>{string(comment.author, 'Unknown author')} · {string(comment.createdAt)}</span>
              <MarkdownView value={string(comment.body)} openLink={(url) => void openExternal(url)} />
            </article>) : <p style={mutedStyle}>No comments returned by the provider.</p>}
            <label style={{ display: 'grid', gap: 5 }}><span>Add comment</span><textarea aria-label="New comment" disabled={!connected || stale} maxLength={65_536} value={commentDraft} onChange={(event) => setCommentDraft(event.currentTarget.value)} style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} /></label>
            {commentError ? <p role="alert" style={{ ...dangerStyle, margin: 0 }}>{commentError}</p> : null}
            <button type="button" disabled={!connected || !commentDraft.trim() || detailSaving || stale} onClick={() => void submitComment()} style={{ ...buttonStyle, justifySelf: 'start' }}>{detailSaving ? 'Posting…' : 'Post comment'}</button>
          </section>
        </> : null}
      </div>
    </TaskDrawer> : null}

    {workspaceOpen && workspaceRequest ? <ModalSheet
      title={`Create workspace from ${string(workspaceRequest.target && record(workspaceRequest.target)?.kind) === 'pullRequest' ? 'pull request' : 'issue'}`}
      onClose={() => void cancelWorkspace()}
      zIndex={80}
      footer={workspaceTrustRequired && workspaceTrustKind ? <>
        <button type="button" disabled={!connected || workspaceBusy || stale} onClick={() => void submitWorkspace({ kind: workspaceTrustKind, choice: 'skip' })} style={buttonStyle}>Skip {workspaceConsentLabel}</button>
        <button type="button" disabled={!connected || workspaceBusy || stale || !workspaceTrustHashAvailable || !workspaceTrustCanRun} onClick={() => void submitWorkspace({ kind: workspaceTrustKind, choice: 'run' })} style={buttonStyle}>{workspaceBusy ? 'Creating…' : `Run ${workspaceConsentLabel} once`}</button>
      </> : <>
        <button type="button" disabled={workspaceBusy} onClick={() => void cancelWorkspace()} style={buttonStyle}>Cancel</button>
        <button type="button" disabled={!connected || workspaceBusy || stale || (workspaceRequest.setupDecisionRequired === true && workspaceSetup === 'inherit')} onClick={() => void submitWorkspace()} style={buttonStyle}>{workspaceBusy ? 'Creating…' : 'Create workspace'}</button>
      </>}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submitWorkspace() }} style={{ display: 'grid', gap: 12 }}>
        <p style={{ ...mutedStyle, margin: 0, overflowWrap: 'anywhere' }}>{string(workspaceRequest.repoName, 'Selected repository')} · {string(workspaceRequest.title, selected?.title ?? '')}</p>
        {workspaceRequest.target && record(workspaceRequest.target)?.url ? <button type="button" onClick={() => void openExternal(record(workspaceRequest.target)?.url)} style={{ ...buttonStyle, justifySelf: 'start' }}>Open task externally</button> : null}
        <label style={{ display: 'grid', gap: 5 }}><span>Workspace name</span><input autoComplete="off" maxLength={200} value={workspaceName} onChange={(event) => setWorkspaceName(event.currentTarget.value)} style={inputStyle} /></label>
        <label style={{ display: 'grid', gap: 5 }}><span>Initial prompt</span><textarea value={workspacePrompt} onChange={(event) => setWorkspacePrompt(event.currentTarget.value)} style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }} /></label>
        <label style={{ display: 'grid', gap: 5 }}><span>Agent (optional)</span><select value={workspaceAgent} onChange={(event) => { workspaceAgentTouched.current = true; setWorkspaceAgent(event.currentTarget.value) }} style={inputStyle}>
          <option value="">Create without starting an agent</option>{workspaceAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}{agent.isDefault ? ' · default' : ''}</option>)}
        </select></label>
        {workspaceRequest.setupDecisionRequired === true || workspaceTrustKind === 'setup' || workspaceSetup !== 'inherit' ? <label style={{ display: 'grid', gap: 5 }}><span>Repository setup</span><select value={workspaceSetup} onChange={(event) => setWorkspaceSetup(event.currentTarget.value)} style={inputStyle}>
          <option value="inherit" disabled>Choose whether to run setup</option><option value="run">Run setup</option><option value="skip">Skip setup</option>
        </select></label> : <p style={{ ...mutedStyle, margin: 0 }}>Repository setup follows the project policy.</p>}
        {record(workspaceRequest.target)?.kind === 'issue' ? <label style={{ display: 'grid', gap: 5 }}><span>Issue command</span><select value={workspaceIssueCommand} onChange={(event) => setWorkspaceIssueCommand(event.currentTarget.value)} style={inputStyle}>
          <option value="inherit">Follow repository issue-command settings</option><option value="run">Run issue command</option><option value="skip">Skip issue command</option>
        </select></label> : null}
        {workspaceTrustRequired && workspaceTrustKind ? <details open><summary>{workspaceTrustLabel} needs approval{workspaceRequest.trustChanged === true ? ' (script changed)' : ''}</summary>
          <p style={{ ...mutedStyle, margin: 0 }}>{workspaceTrustLabel} content must match this displayed hash before it can run.</p>
          <code>Displayed SHA-256: {string(workspaceRequest.trustHash, 'Unavailable')}</code>
          {typeof workspaceRequest.trustSetupHash === 'string' ? <p style={{ ...mutedStyle, margin: 0 }}>Setup approval remains pinned to SHA-256 {workspaceRequest.trustSetupHash}.</p> : null}
          {typeof workspaceRequest.trustIssueCommandHash === 'string' ? <p style={{ ...mutedStyle, margin: 0 }}>Issue-command approval remains pinned to SHA-256 {workspaceRequest.trustIssueCommandHash}.</p> : null}
          <pre style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 8, background: 'var(--surface-raised, #25272c)' }}>{string(workspaceRequest.trustScript)}</pre>
        </details> : null}
        {agentError ? <p role="status" style={{ ...mutedStyle, margin: 0, overflowWrap: 'anywhere' }}>{agentError}</p> : null}
        {workspaceError || (typeof workspaceRequest.error === 'string' ? workspaceRequest.error : '') ? <p role="alert" style={{ ...dangerStyle, margin: 0, overflowWrap: 'anywhere' }}>{workspaceError || string(workspaceRequest.error)}</p> : null}
      </form>
    </ModalSheet> : null}

    {closeConfirm && selected ? <ModalSheet title={`Close ${selected.kind === 'issue' ? 'issue' : 'pull request'}?`} onClose={() => setCloseConfirm(false)} zIndex={90} footer={<>
      <button type="button" onClick={() => setCloseConfirm(false)} style={buttonStyle}>Cancel</button>
      <button type="button" disabled={!connected || detailSaving || stale} onClick={() => void closeSelectedTask()} style={buttonStyle}>Close {selected.kind === 'issue' ? 'issue' : 'pull request'}</button>
    </>}><p style={{ marginTop: 0 }}>Close {selected.kind === 'issue' ? 'issue' : 'pull request'} #{selected.number} on GitHub?</p></ModalSheet> : null}
  </section>
}

export function FilesTasksPanel({ bridge, route }: PanelProps) {
  if (route.kind === 'files') return <ExplorerPanel bridge={bridge} route={route} />
  if (route.kind === 'file-preview') return <FilePreviewPanel bridge={bridge} route={route} />
  if (route.kind === 'tasks') return <TasksPanel bridge={bridge} />
  return <section role="alert" style={rootStyle}>Unsupported mobile panel route: {route.kind}</section>
}
