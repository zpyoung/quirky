import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Button, InlineError, TextField } from '@quirky/ui'
import { editorTheme } from '@quirky/ui/editor-theme'
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { findNext, replaceAll, replaceNext, search, SearchQuery, searchKeymap, setSearchQuery } from '@codemirror/search'
import { MergeView } from '@codemirror/merge'
import { Compartment, EditorSelection, EditorState, Transaction, type EditorStateConfig, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { EditorSurfaceBuffer } from '../types'
import type { UiPluginContext } from '@quirky/protocol'
import { CHORD_PLATFORM } from '@quirky/protocol'
import { SourceLocations } from './SourceLocations'
import {
  SOURCE_EDITOR_ONLY_MESSAGE,
  navigationLanguage,
  useSourceSymbols,
  type NavigationPosition,
  type SourceSymbolsHost,
  type SourceSymbolsResult
} from './sourceNavigation'
import { requestEditorUiControl, useEditorUiControl, type EditorUiControl, type EditorUiControlAddress, type EditorUiControlResult } from './uiControl'
import { registerEditorFocus } from './editorFocus'

const PASTE_LIMIT = 16 * 1024 * 1024
const SOURCE_CONTROL_SURFACE = 'view:quirky.editor/document'
const SOURCE_CONTROL_UNAVAILABLE = 'The editor control is no longer available.'
const SourceEditorBridgeContext = createContext<UiPluginContext | null>(null)
type SourceControlRegistrationProps = {
  context: UiPluginContext
  sourceAddress: EditorUiControlAddress | null
  menuAddress: EditorUiControlAddress | null
  onSourceControl(control: EditorUiControl): Promise<EditorUiControlResult>
  onMenuControl(control: EditorUiControl): Promise<EditorUiControlResult>
}

function SourceControlRegistration({
  context,
  sourceAddress,
  menuAddress,
  onSourceControl,
  onMenuControl
}: SourceControlRegistrationProps): null {
  useEditorUiControl({ context, address: sourceAddress, handler: onSourceControl })
  useEditorUiControl({ context, address: menuAddress, handler: onMenuControl })
  return null
}

let nextSourceControlGeneration = 0
function newSourceControlGeneration(): string {
  return `source-${++nextSourceControlGeneration}`
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key))
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Supplies this window's command bridge without owning document state or registration. */
export function SourceEditorControlScope({ context, children }: { context: UiPluginContext; children: ReactNode }): ReactNode {
  return <SourceEditorBridgeContext.Provider value={context}>{children}</SourceEditorBridgeContext.Provider>
}

// The host routes these managed chords; CodeMirror must not also run a search action.
const HOST_MANAGED_EDITOR_CHORDS: Record<string, true> = {
  'Mod-p': true,
  'Mod-Shift-e': true,
  'Mod-Shift-f': true,
  'Mod-s': true,
  'Mod-w': true,
  'Mod-Alt-w': true,
  'Mod-Shift-t': true,
  'Mod-Shift-g': true,
  'Mod-f': true,
  'Mod-Alt-f': true,
  'Mod-Alt-c': true,
  'Mod-Shift-v': true,
  'Alt-z': true,
  'Mod-Shift-a': true,
  'Mod-Shift-=': true,
  'Mod--': true,
  'Mod-0': true,
  'Mod-l': true,
  'Mod-Shift-m': true,
  'Mod-Shift-o': true
}
function withoutManagedEditorChords<T extends { key?: string }>(bindings: readonly T[]): T[] {
  return bindings.filter((binding) => HOST_MANAGED_EDITOR_CHORDS[binding.key ?? ''] !== true)
}
const editorSearchKeymap = withoutManagedEditorChords(searchKeymap)
const editorHistoryKeymap = withoutManagedEditorChords(historyKeymap)
const editorDefaultKeymap = withoutManagedEditorChords(defaultKeymap)

type SelectionSummary = { fromLine: number; toLine: number }
type SourceMenu = {
  kind: 'editor' | 'gutter'
  x: number
  y: number
  generation: string
  sourceGeneration: string
  revision: number
  path: string
  relativePath: string
  query?: string
  line?: number
  column?: number
}
type SourceIdentitySession = {
  bufferId: string
  tabId: string | null
  worktreeId: string
  root: string
  path: string
  relativePath: string
  context: UiPluginContext | null
  generation: string
}
type SourceControlSession = { generation: string; view: EditorView }

export type SourceEditorHandle = {
  flush(): Promise<void>
  focus(): void
  reveal(line: number, column?: number): void
  undo(): void
  redo(): void
  find(query?: string): Promise<{ opened: true; query?: string }>
  replace(query?: string): Promise<{ opened: true; query?: string }>
  copyContext(): Promise<{ copied: true; path: string; lines: string }>
  definition(position?: NavigationPosition): Promise<SourceSymbolsResult>
  references(position?: NavigationPosition): Promise<SourceSymbolsResult>
}

type Props = {
  buffer: EditorSurfaceBuffer
  tabId: string | null
  wrap: boolean
  minimap: boolean
  fontSize: number
  fontFamily: string
  onDraft(content: string): void
  flushDraft(): Promise<void>
  onView(patch: Record<string, unknown>): void
  onEditorFocus(): void
  onSearchInFiles(query: string): void
  comparisonOriginal?: string
  symbols?: SourceSymbolsHost
  reveal?: { line: number; column?: number }
  error?: string | null
  onError(message: string | null): void
}

function languageFor(path: string): Extension {
  const name = path.toLowerCase()
  if (/\.(?:[cm]?js|jsx|mjs|cjs|ts|tsx)$/.test(name)) return javascript({ typescript: /\.(?:ts|tsx)$/.test(name), jsx: /\.(?:jsx|tsx)$/.test(name) })
  if (name.endsWith('.json') || name.endsWith('.jsonc')) return json()
  if (/\.(?:md|markdown)$/.test(name)) return markdown()
  if (name.endsWith('.py')) return python()
  if (/\.(?:html?|xml|svg)$/.test(name)) return html()
  if (/\.(?:css|scss|less)$/.test(name)) return css()
  if (name.endsWith('.sql')) return sql()
  if (/\.(?:ya?ml)$/.test(name)) return yaml()
  return []
}
const editorHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: 'var(--ui-accent)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--ui-working)' },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: 'var(--ui-working)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--ui-needs-you)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--ui-muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName)], color: 'var(--ui-accent)' },
])

function utf8Size(text: string): number {
  let bytes = 0
  for (const character of text) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}
function wordAt(view: EditorView, position: number): string {
  const line = view.state.doc.lineAt(position)
  const localPosition = Math.min(line.length, Math.max(0, position - line.from))
  const words = /[\w$]+/g
  let match: RegExpExecArray | null
  while ((match = words.exec(line.text)) !== null) {
    if (localPosition >= match.index && localPosition <= match.index + match[0].length) return match[0]
  }
  return ''
}

function drawMinimap(view: EditorView, canvas: HTMLCanvasElement): void {
  const bounds = canvas.getBoundingClientRect()
  if (bounds.width < 1 || bounds.height < 1) return
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(bounds.width * ratio)
  canvas.height = Math.round(bounds.height * ratio)
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, bounds.width, bounds.height)
  const colors = getComputedStyle(canvas)
  const muted = colors.getPropertyValue('--ui-muted').trim()
  const accent = colors.getPropertyValue('--ui-accent').trim()
  if (!muted || !accent) return
  const lineCount = view.state.doc.lines
  const rows = Math.min(lineCount, 900)
  const rowHeight = bounds.height / rows
  context.fillStyle = muted
  for (let row = 0; row < rows; row++) {
    const lineNumber = Math.floor((row * lineCount) / rows) + 1
    const line = view.state.doc.line(lineNumber)
    const width = Math.max(1, Math.min(bounds.width - 5, 1 + line.length * 0.45))
    context.fillRect(3, row * rowHeight, width, Math.max(1, rowHeight * 0.55))
  }
  const scrollRange = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)
  const scrollProgress = scrollRange === 0 ? 0 : view.scrollDOM.scrollTop / scrollRange
  const viewportHeight = Math.max(7, bounds.height * view.scrollDOM.clientHeight / Math.max(1, view.scrollDOM.scrollHeight))
  const viewportTop = Math.max(0, bounds.height - viewportHeight) * scrollProgress
  context.globalAlpha = 0.18
  context.fillStyle = accent
  context.fillRect(0, viewportTop, bounds.width, viewportHeight)
  context.globalAlpha = 0.85
  context.strokeStyle = accent
  context.strokeRect(0.5, viewportTop + 0.5, bounds.width - 1, Math.max(1, viewportHeight - 1))
  context.globalAlpha = 1
}

function viewStateForTab(buffer: EditorSurfaceBuffer, tabId: string | null): Record<string, unknown> {
  const byTabId = buffer.view.byTabId
  if (tabId && typeof byTabId === 'object' && byTabId !== null && !Array.isArray(byTabId)) {
    const saved = (byTabId as Record<string, unknown>)[tabId]
    if (typeof saved === 'object' && saved !== null && !Array.isArray(saved)) return saved as Record<string, unknown>
  }
  return buffer.view
}

function positionAtLineColumn(text: string, requestedLine: number, requestedColumn: number): number {
  let lineStart = 0
  const line = Math.max(1, requestedLine)
  for (let current = 1; current < line; current++) {
    const newline = text.indexOf('\n', lineStart)
    if (newline < 0) {
      lineStart = text.length
      break
    }
    lineStart = newline + 1
  }
  const newline = text.indexOf('\n', lineStart)
  const lineEnd = newline < 0 ? text.length : newline
  return Math.min(lineEnd, lineStart + Math.max(1, requestedColumn) - 1)
}

function pendingNavigationForTab(buffer: EditorSurfaceBuffer, tabId: string | null): { line: number; column: number; matchLength: number; focused: boolean; navigationId: string } | undefined {
  let view: Record<string, unknown> | undefined
  const byTabId = buffer.view.byTabId
  // the global seed can precede its tab-scoped patch, so only read navigation from the tab entry.
  if (tabId && typeof byTabId === 'object' && byTabId !== null && !Array.isArray(byTabId)) {
    const saved = (byTabId as Record<string, unknown>)[tabId]
    if (typeof saved === 'object' && saved !== null && !Array.isArray(saved)) view = saved as Record<string, unknown>
  } else if (!tabId) {
    view = buffer.view
  }
  const line = view?.line
  const column = view?.column
  const navigationId = view?.navigationId
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 ||
      typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1 ||
      typeof navigationId !== 'string' || navigationId.length === 0) return undefined
  const matchLength = view?.matchLength
  return {
    line,
    column,
    matchLength: typeof matchLength === 'number' && Number.isSafeInteger(matchLength) && matchLength > 0 ? matchLength : 0,
    focused: view?.focused === true,
    navigationId
  }
}

function revealPosition(view: EditorView, line: number, column = 1, matchLength = 0): number {
  const targetLine = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
  const position = Math.min(targetLine.to, targetLine.from + Math.max(0, column - 1))
  const end = Math.min(targetLine.to, position + Math.max(0, matchLength))
  view.dispatch({
    selection: { anchor: position, head: end },
    effects: EditorView.scrollIntoView(position, { y: 'center' })
  })
  return position
}


function initialSelection(buffer: EditorSurfaceBuffer, tabId: string | null): EditorSelection | undefined {
  const text = buffer.draft ?? buffer.content
  const view = viewStateForTab(buffer, tabId) as { selection?: { anchor?: unknown; head?: unknown }; cursor?: { line?: unknown; column?: unknown } } | undefined
  const saved = view?.selection
  if (typeof saved?.anchor === 'number' && typeof saved.head === 'number') {
    return EditorSelection.single(Math.min(text.length, Math.max(0, saved.anchor)), Math.min(text.length, Math.max(0, saved.head)))
  }
  const cursor = view?.cursor
  if (typeof cursor?.line === 'number') {
    const column = typeof cursor.column === 'number' ? cursor.column : 1
    return EditorSelection.single(positionAtLineColumn(text, cursor.line, column))
  }
  return undefined
}

/** A source editor whose only document mutation path is the acknowledged daemon draft queue. */
export const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(props, forwardedRef) {
  const bridgeContext = useContext(SourceEditorBridgeContext)
  const bridgeContextRef = useRef(bridgeContext)
  bridgeContextRef.current = bridgeContext
  const sourceIdentityRef = useRef<SourceIdentitySession | null>(null)
  let sourceIdentity = sourceIdentityRef.current
  if (sourceIdentity === null || sourceIdentity.bufferId !== props.buffer.id ||
      sourceIdentity.tabId !== props.tabId || sourceIdentity.worktreeId !== props.buffer.worktreeId ||
      sourceIdentity.root !== props.buffer.root || sourceIdentity.path !== props.buffer.path ||
      sourceIdentity.relativePath !== props.buffer.relativePath || sourceIdentity.context !== bridgeContext) {
    sourceIdentity = {
      bufferId: props.buffer.id,
      tabId: props.tabId,
      worktreeId: props.buffer.worktreeId,
      root: props.buffer.root,
      path: props.buffer.path,
      relativePath: props.buffer.relativePath,
      context: bridgeContext,
      generation: newSourceControlGeneration()
    }
    sourceIdentityRef.current = sourceIdentity
  }
  const engineKey = JSON.stringify([props.buffer.id, props.tabId, props.comparisonOriginal !== undefined])
  const [engineSession, setEngineSession] = useState<{ key: string; generation: string } | null>(null)
  const engineGeneration = engineSession?.key === engineKey ? engineSession.generation : null
  const sourceGeneration = engineGeneration === null ? null : JSON.stringify([sourceIdentity.generation, engineGeneration])
  const sourceSessionRef = useRef<SourceControlSession | null>(null)
  const menuSessionRef = useRef<SourceMenu | null>(null)
  const menuGenerationRef = useRef('')

  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  sourceSessionRef.current = sourceGeneration === null || viewRef.current === null
    ? null
    : { generation: sourceGeneration, view: viewRef.current }
  const appliedNavigation = useRef<string | null>(null)
  const mergeRef = useRef<MergeView | null>(null)
  const mergeOriginal = useRef<string | null>(null)
  const pendingView = useRef<number | undefined>(undefined)
  const acceptedText = useRef(props.buffer.draft ?? props.buffer.content)
  const preservedDocument = useRef<{ bufferId: string; tabId: string | null; text: string } | null>(null)
  const suppressDraft = useRef(false)
  const scheduleView = useRef<() => void>(() => {})
  const drawMinimapRef = useRef<() => void>(() => {})
  const minimapEnabled = useRef(props.minimap)
  minimapEnabled.current = props.minimap
  const textRevision = useRef(0)
  const symbolControlRunner = useRef<((action: string, data?: Record<string, unknown>) => Promise<EditorUiControlResult>) | null>(null)
  const onSourceControlRunner = useCallback((runner: ((action: string, data?: Record<string, unknown>) => Promise<EditorUiControlResult>) | null) => {
    symbolControlRunner.current = runner
  }, [])
  const symbolLanguage = navigationLanguage(props.buffer.relativePath)
  const symbolsEnabled = props.symbols !== undefined && symbolLanguage !== null
  const symbolsEnabledRef = useRef(symbolsEnabled)
  symbolsEnabledRef.current = symbolsEnabled
  const sourceSymbols = useSourceSymbols({
    context: props.symbols?.context ?? bridgeContext,
    buffer: props.buffer,
    tabId: props.tabId,
    language: symbolLanguage ?? 'typescript',
    engineGeneration,
    enabled: symbolsEnabled,
    refusal: () => props.symbols?.refusal() ?? null,
    revision: textRevision,
    getView: () => viewRef.current,
    symbolAt: (offset) => {
      const view = viewRef.current
      return view ? wordAt(view, offset) : ''
    },
    reveal: revealSourceSpan
  })
  const compartments = useMemo(() => ({ wrap: new Compartment(), zoom: new Compartment(), language: new Compartment() }), [])
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const previousErrorProp = useRef(props.error)
  useEffect(() => {
    if (previousErrorProp.current !== props.error && (props.error === null || props.error === undefined)) setControlError(null)
    previousErrorProp.current = props.error
  }, [props.error])
  const [selection, setSelection] = useState<SelectionSummary | null>(null)
  const [contextMenu, setContextMenu] = useState<SourceMenu | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [searchQuery, setSearchQueryText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const searchQueryRef = useRef(searchQuery)
  searchQueryRef.current = searchQuery
  const content = props.buffer.draft ?? props.buffer.content
  const pendingNavigation = pendingNavigationForTab(props.buffer, props.tabId)
  const comparisonOriginalRef = useRef(props.comparisonOriginal)
  comparisonOriginalRef.current = props.comparisonOriginal
  const applySearchQuery = (view: EditorView, query: string, replacement: string) => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query, replace: replacement })) })
  }
  function revealSourceSpan(from: number, to: number): void {
    const view = viewRef.current
    if (!view) throw new Error('The source editor is not mounted.')
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' })
    })
    view.focus()
    scheduleView.current()
  }
  function isValidSymbolPosition(position: NavigationPosition): boolean {
    const view = viewRef.current
    if (!view || !Number.isSafeInteger(position.line) || position.line < 1 ||
        !Number.isSafeInteger(position.column) || position.column < 1 || position.line > view.state.doc.lines) return false
    return position.column <= view.state.doc.line(position.line).length + 1
  }
  function dispatchSymbolControl(action: 'definition' | 'references', position: number, view: EditorView): boolean {
    const run = symbolControlRunner.current
    if (!symbolsEnabledRef.current || !run) return false
    const line = view.state.doc.lineAt(position)
    void run(action, { line: line.number, column: position - line.from + 1 })
    return true
  }
  const showSearch = (replace: boolean, query?: string) => {
    const view = viewRef.current
    if (!view) throw new Error('The source editor is not mounted.')
    setSearchOpen(true)
    setReplaceOpen(replace)
    const value = typeof query === 'string' ? query : searchQuery
    if (typeof query === 'string') setSearchQueryText(query)
    applySearchQuery(view, value, replaceText)
    window.requestAnimationFrame(() => searchInput.current?.focus())
    if (value !== '' && !findNext(view)) throw new Error(`No match for “${value}”.`)
    return { opened: true as const, ...(value === '' ? {} : { query: value }) }
  }
  const runFind = (query = searchQuery) => {
    const view = viewRef.current
    if (!view) throw new Error('The source editor is not mounted.')
    if (query === '') throw new Error('Enter text to find in the source editor.')
    if (query !== searchQuery) setSearchQueryText(query)
    applySearchQuery(view, query, replaceText)
    if (!findNext(view)) throw new Error(`No match for “${query}”.`)
  }
  const runReplace = (all: boolean, query = searchQuery, replacement = replaceText) => {
    const view = viewRef.current
    if (!view) throw new Error('The source editor is not mounted.')
    if (query === '') throw new Error('Enter text to replace in the source editor.')
    if (query !== searchQuery) setSearchQueryText(query)
    if (replacement !== replaceText) setReplaceText(replacement)
    applySearchQuery(view, query, replacement)
    const replaced = all ? replaceAll(view) : replaceNext(view)
    if (!replaced) throw new Error(`No match for “${query}”.`)
    return { replaced: true, all }
  }
  const copySelectionContext = async () => {
    const view = viewRef.current
    if (!view) throw new Error('The source editor is not mounted.')
    const session = sourceSessionRef.current
    const relativePath = props.buffer.relativePath
    const range = view.state.selection.main
    if (range.empty) throw new Error('Select text before copying editor context.')
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.')
    const start = view.state.doc.lineAt(range.from)
    const end = view.state.doc.lineAt(range.to)
    const lines = start.number === end.number ? `${start.number}` : `${start.number}-${end.number}`
    const text = `${relativePath}:${lines}\n${view.state.doc.sliceString(range.from, range.to)}`
    await navigator.clipboard.writeText(text)
    if (session && isCurrentSourceSession(session)) reportSourceError(null)
    return { copied: true as const, path: relativePath, lines }
  }
 
  const callbacks = useRef({
    onDraft: props.onDraft,
    flushDraft: props.flushDraft,
    onView: props.onView,
    onEditorFocus: props.onEditorFocus,
    onSearchInFiles: props.onSearchInFiles,
    onError: props.onError
  })
  callbacks.current = {
    onDraft: props.onDraft,
    flushDraft: props.flushDraft,
    onView: props.onView,
    onEditorFocus: props.onEditorFocus,
    onSearchInFiles: props.onSearchInFiles,
    onError: props.onError
  }
  function reportSourceError(message: string | null): void {
    setControlError(message)
    callbacks.current.onError(message)
  }
  function isCurrentSourceSession(session: SourceControlSession): boolean {
    const current = sourceSessionRef.current
    return current !== null && current.generation === session.generation &&
      current.view === session.view && viewRef.current === session.view
  }

  function isCurrentMenuSession(session: SourceMenu): boolean {
    const currentMenu = menuSessionRef.current
    const source = sourceSessionRef.current
    return currentMenu !== null && currentMenu.generation === session.generation &&
      currentMenu.sourceGeneration === session.sourceGeneration && source !== null &&
      source.generation === session.sourceGeneration && isCurrentSourceSession(source)
  }

  function rotateMenuGeneration(): string {
    let generation: string
    do {
      generation = newSourceControlGeneration()
    } while (generation === menuGenerationRef.current)
    menuGenerationRef.current = generation
    return generation
  }

  function closeSourceMenu(expectedGeneration?: string): boolean {
    const session = menuSessionRef.current
    if (!session || (expectedGeneration !== undefined && session.generation !== expectedGeneration)) return false
    rotateMenuGeneration()
    menuSessionRef.current = null
    setContextMenu(null)
    return true
  }

  function openSourceMenu(
    source: SourceControlSession,
    kind: 'editor' | 'gutter',
    line: number,
    column: number,
    x: number,
    y: number
  ): SourceMenu {
    const view = source.view
    const docLine = view.state.doc.line(line)
    const selectionRange = view.state.selection.main
    const query = kind === 'editor'
      ? (selectionRange.empty
        ? wordAt(view, docLine.from + column - 1)
        : view.state.doc.sliceString(selectionRange.from, selectionRange.to)).slice(0, 8192)
      : undefined
    const session: SourceMenu = {
      kind,
      x,
      y,
      generation: rotateMenuGeneration(),
      sourceGeneration: source.generation,
      revision: textRevision.current,
      path: props.buffer.path,
      relativePath: props.buffer.relativePath,
      line,
      ...(kind === 'editor' ? { column } : {}),
      ...(query === undefined ? {} : { query })
    }
    menuSessionRef.current = session
    setContextMenu(session)
    return session
  }
  async function onSourceControl(control: EditorUiControl): Promise<EditorUiControlResult> {
    const source = sourceSessionRef.current
    if (!source || control.generation !== source.generation || !isCurrentSourceSession(source)) return { delivered: false }
    const data = control.data ?? {}
    try {
      switch (control.action) {
        case 'find':
        case 'replace': {
          if (!onlyKeys(data, ['query']) || (Object.hasOwn(data, 'query') && typeof data.query !== 'string')) return { delivered: false }
          const query = Object.hasOwn(data, 'query') ? data.query as string : searchQuery
          if (query === '') throw new Error(control.action === 'find'
            ? 'Enter text to find in the source editor.'
            : 'Enter text to replace in the source editor.')
          showSearch(control.action === 'replace', query)
          return { delivered: true }
        }
        case 'find-next': {
          if (!onlyKeys(data, ['query']) || (Object.hasOwn(data, 'query') && typeof data.query !== 'string')) return { delivered: false }
          runFind(Object.hasOwn(data, 'query') ? data.query as string : searchQuery)
          return { delivered: true }
        }
        case 'replace-next':
        case 'replace-all': {
          if (!onlyKeys(data, ['query', 'replacement']) ||
              (Object.hasOwn(data, 'query') && typeof data.query !== 'string') ||
              (Object.hasOwn(data, 'replacement') && typeof data.replacement !== 'string')) return { delivered: false }
          runReplace(
            control.action === 'replace-all',
            Object.hasOwn(data, 'query') ? data.query as string : searchQuery,
            Object.hasOwn(data, 'replacement') ? data.replacement as string : replaceText
          )
          return { delivered: true }
        }
        case 'close-find':
          if (!onlyKeys(data, [])) return { delivered: false }
          setSearchOpen(false)
          return { delivered: true }
        case 'copy-context':
          if (!onlyKeys(data, []) || source.view.state.selection.main.empty) return { delivered: false }
          try {
            await copySelectionContext()
          } catch (reason) {
            throw new Error(`Unable to copy selection context: ${errorMessage(reason)}`)
          }
          if (!isCurrentSourceSession(source)) return { delivered: false }
          return { delivered: true }
        case 'menu-open': {
          if (!onlyKeys(data, ['kind', 'line', 'column', 'x', 'y']) ||
              (data.kind !== 'editor' && data.kind !== 'gutter') ||
              !Number.isSafeInteger(data.line) || (data.line as number) < 1 ||
              (Object.hasOwn(data, 'column') && !Number.isSafeInteger(data.column)) ||
              (Object.hasOwn(data, 'x') && (typeof data.x !== 'number' || !Number.isFinite(data.x) || data.x < 0)) ||
              (Object.hasOwn(data, 'y') && (typeof data.y !== 'number' || !Number.isFinite(data.y) || data.y < 0))) return { delivered: false }
          const line = data.line as number
          if (line > source.view.state.doc.lines) return { delivered: false }
          const column = Object.hasOwn(data, 'column') ? data.column as number : 1
          const docLine = source.view.state.doc.line(line)
          if (column < 1 || column > docLine.length + 1) return { delivered: false }
          if (!isCurrentSourceSession(source)) return { delivered: false }
          openSourceMenu(
            source,
            data.kind,
            line,
            column,
            Object.hasOwn(data, 'x') ? data.x as number : 0,
            Object.hasOwn(data, 'y') ? data.y as number : 0
          )
          return { delivered: true }
        }
        case 'minimap': {
          if (!props.minimap || !onlyKeys(data, ['position']) ||
              typeof data.position !== 'number' || !Number.isFinite(data.position) ||
              data.position < 0 || data.position > 1) return { delivered: false }
          if (!isCurrentSourceSession(source)) return { delivered: false }
          const scrollRange = Math.max(0, source.view.scrollDOM.scrollHeight - source.view.scrollDOM.clientHeight)
          source.view.scrollDOM.scrollTop = scrollRange * data.position
          return { delivered: true }
        }
        default:
          return { delivered: false }
      }
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(errorMessage(reason))
      if (isCurrentSourceSession(source)) reportSourceError(error.message)
      throw error
    }
  }

  async function onMenuControl(control: EditorUiControl): Promise<EditorUiControlResult> {
    const menu = menuSessionRef.current
    if (!bridgeContext || !menu || control.generation !== menu.generation || !isCurrentMenuSession(menu)) {
      return { delivered: false }
    }
    const data = control.data ?? {}
    if (control.action === 'close') {
      if (!onlyKeys(data, [])) return { delivered: false }
      return { delivered: closeSourceMenu(menu.generation) }
    }
    if (control.action === 'copy-line') {
      if (menu.kind !== 'gutter' || menu.line === undefined || !onlyKeys(data, ['relative']) ||
          (Object.hasOwn(data, 'relative') && typeof data.relative !== 'boolean')) return { delivered: false }
      const relative = Object.hasOwn(data, 'relative') ? data.relative as boolean : false
      const path = relative ? menu.relativePath : menu.path
      try {
        if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.')
        await navigator.clipboard.writeText(`${path}:${menu.line}`)
      } catch (reason) {
        const error = new Error(`Unable to copy line path: ${errorMessage(reason)}`)
        if (isCurrentMenuSession(menu)) reportSourceError(error.message)
        throw error
      }
      if (!isCurrentMenuSession(menu)) return { delivered: false }
      reportSourceError(null)
      if (!isCurrentMenuSession(menu)) return { delivered: false }
      return { delivered: closeSourceMenu(menu.generation) }
    }
    if (control.action === 'search-in-files') {
      if (menu.kind !== 'editor' || !onlyKeys(data, [])) return { delivered: false }
      const query = (menu.query ?? '').trim().slice(0, 8192)
      if (!query || !isCurrentMenuSession(menu)) return { delivered: false }
      try {
        callbacks.current.onSearchInFiles(query)
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(errorMessage(reason))
        if (isCurrentMenuSession(menu)) reportSourceError(error.message)
        throw error
      }
      if (!isCurrentMenuSession(menu)) return { delivered: false }
      return { delivered: closeSourceMenu(menu.generation) }
    }
    if (control.action === 'definition' || control.action === 'references') {
      const hasIntent = Object.hasOwn(data, '_lookupIntent')
      if (menu.revision !== textRevision.current || menu.kind !== 'editor' ||
          menu.line === undefined || menu.column === undefined ||
          !symbolsEnabled || !onlyKeys(data, ['_lookupIntent']) ||
          hasIntent && (typeof data._lookupIntent !== 'string' || data._lookupIntent.trim() === '')) return { delivered: false }
      const source = sourceSessionRef.current
      if (!source || !isCurrentSourceSession(source)) return { delivered: false }
      const position = { line: menu.line, column: menu.column }
      const accepted = sourceSymbols.control(control.action, position, {
        intent: typeof data._lookupIntent === 'string' ? data._lookupIntent : undefined, focus: true
      })
      if (!accepted) return { delivered: false }
      return { delivered: closeSourceMenu(menu.generation) }
    }
    return { delivered: false }
  }

  async function dispatchMenuControl(action: string, data?: Record<string, unknown>): Promise<EditorUiControlResult> {
    const origin = menuSessionRef.current
    const address = menuAddressRef.current
    const source = sourceSessionRef.current
    const context = bridgeContextRef.current
    if (!context || !origin || !source || !address || address.generation !== origin.generation ||
        source.generation !== origin.sourceGeneration || !isCurrentMenuSession(origin)) {
      if (origin && isCurrentMenuSession(origin)) reportSourceError(SOURCE_CONTROL_UNAVAILABLE)
      return { delivered: false }
    }
    let lookupIntent: string | undefined
    let controlData = data
    if (action === 'definition' || action === 'references') {
      if (origin.revision !== textRevision.current || origin.kind !== 'editor' ||
          origin.line === undefined || origin.column === undefined ||
          !symbolsEnabled || data !== undefined && !onlyKeys(data, [])) return { delivered: false }
      lookupIntent = sourceSymbols.reserveIntent(action, { line: origin.line, column: origin.column }) ?? undefined
      if (lookupIntent === undefined) return { delivered: false }
      controlData = { _lookupIntent: lookupIntent }
    }
    const control: EditorUiControl = {
      surface: address.surface,
      target: address.target,
      generation: address.generation,
      action,
      ...(controlData === undefined ? {} : { data: controlData })
    }
    try {
      const result = await requestEditorUiControl(context, control)
      const ownsLookup = lookupIntent !== undefined && sourceSymbols.isIntentCurrent(lookupIntent)
      if (!isCurrentMenuSession(origin) && !(ownsLookup && result.delivered)) return { delivered: false }
      if (!result.delivered) {
        if (lookupIntent !== undefined && !ownsLookup) return { delivered: false }
        reportSourceError(SOURCE_CONTROL_UNAVAILABLE)
      }
      return result
    } catch (reason) {
      const currentLookup = lookupIntent !== undefined && sourceSymbols.isIntentCurrent(lookupIntent)
      if (isCurrentMenuSession(origin) && (lookupIntent === undefined || currentLookup)) {
        reportSourceError(errorMessage(reason))
      }
      return { delivered: false }
    }
  }


  const sourceActions = [
    'find', 'replace', 'find-next', 'replace-next', 'replace-all', 'close-find', 'menu-open',
    ...(viewRef.current && !viewRef.current.state.selection.main.empty ? ['copy-context'] : []),
    ...(props.minimap ? ['minimap'] : [])
  ]
  const sourceTarget = `source:${JSON.stringify([props.buffer.id, props.tabId])}`
  const sourceAddress: EditorUiControlAddress | null = bridgeContext && sourceGeneration !== null &&
    sourceSessionRef.current?.generation === sourceGeneration
    ? { surface: SOURCE_CONTROL_SURFACE, target: sourceTarget, generation: sourceGeneration, actions: sourceActions }
    : null
  const currentMenu = contextMenu && contextMenu.sourceGeneration === sourceGeneration &&
    menuSessionRef.current?.generation === contextMenu.generation
    ? contextMenu
    : null
  const menuActions = currentMenu === null
    ? []
    : currentMenu.kind === 'gutter'
      ? ['close', 'copy-line']
      : [
          'close',
          ...(symbolsEnabled ? ['definition', 'references'] : []),
          ...(currentMenu.query?.trim() ? ['search-in-files'] : [])
        ]
  const menuAddress: EditorUiControlAddress | null = bridgeContext && sourceGeneration !== null &&
    sourceSessionRef.current?.generation === sourceGeneration && currentMenu !== null
    ? {
        surface: SOURCE_CONTROL_SURFACE,
        target: `source-menu:${JSON.stringify([props.buffer.id, props.tabId])}`,
        generation: currentMenu.generation,
        actions: menuActions
      }
    : null
  const sourceAddressRef = useRef(sourceAddress)
  sourceAddressRef.current = sourceAddress
  const menuAddressRef = useRef(menuAddress)
  menuAddressRef.current = menuAddress

  async function dispatchSourceControl(action: string, data?: Record<string, unknown>): Promise<EditorUiControlResult> {
    const origin = sourceSessionRef.current
    const address = sourceAddressRef.current
    const context = bridgeContextRef.current
    if (!context || !origin || !address || address.generation !== origin.generation) {
      if (!origin || isCurrentSourceSession(origin)) reportSourceError(SOURCE_CONTROL_UNAVAILABLE)
      return { delivered: false }
    }
    const control: EditorUiControl = {
      surface: address.surface,
      target: address.target,
      generation: address.generation,
      action,
      ...(data === undefined ? {} : { data })
    }
    try {
      const result = await requestEditorUiControl(context, control)
      if (!isCurrentSourceSession(origin)) return { delivered: false }
      if (!result.delivered) reportSourceError(SOURCE_CONTROL_UNAVAILABLE)
      return result
    } catch (reason) {
      if (isCurrentSourceSession(origin)) reportSourceError(errorMessage(reason))
      return { delivered: false }
    }
  }

  function findNextFromKeyboard(): boolean {
    void dispatchSourceControl('find-next', { query: searchInput.current?.value ?? searchQueryRef.current })
    return true
  }
  function handleSymbolMouseDown(event: MouseEvent, view: EditorView): boolean {
    const modifier = CHORD_PLATFORM === 'darwin'
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey
    if (event.button !== 0 || !modifier || event.shiftKey || event.altKey || !symbolsEnabledRef.current) return false
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.closest('.cm-content')) return false
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (position === null || !dispatchSymbolControl('definition', position, view)) return false
    event.preventDefault()
    return true
  }
  function handleEditorContextMenu(event: MouseEvent, view: EditorView): boolean {
    const target = event.target
    if (!(target instanceof HTMLElement)) return false
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (position === null) return false
    const line = view.state.doc.lineAt(position)
    const kind = target.closest('.cm-lineNumbers') ? 'gutter' : target.closest('.cm-content') ? 'editor' : null
    if (kind === null) return false
    event.preventDefault()
    const data = {
      kind,
      line: line.number,
      ...(kind === 'editor' ? { column: position - line.from + 1 } : {}),
      x: Number.isFinite(event.clientX) ? Math.max(0, event.clientX) : 0,
      y: Number.isFinite(event.clientY) ? Math.max(0, event.clientY) : 0
    }
    void dispatchSourceControl('menu-open', data)
    return true
  }

  function requestCopyContext(): void {
    void dispatchSourceControl('copy-context')
  }

  function commitFindNext(query = searchQuery): void {
    void dispatchSourceControl('find-next', { query })
  }
  function commitFindNextFromButton(): void {
    commitFindNext(searchQuery)
  }

  function commitReplaceNext(): void {
    void dispatchSourceControl('replace-next', { query: searchQuery, replacement: replaceText })
  }

  function commitReplaceAll(): void {
    void dispatchSourceControl('replace-all', { query: searchQuery, replacement: replaceText })
  }


  function closeFind(): void {
    void dispatchSourceControl('close-find')
  }

  function requestCloseSourceMenu(): void {
    void dispatchMenuControl('close')
  }

  function copySourceMenuLine(relative: boolean): void {
    void dispatchMenuControl('copy-line', { relative })
  }
  function copyAbsoluteSourceLine(): void {
    copySourceMenuLine(false)
  }

  function copyRelativeSourceLine(): void {
    copySourceMenuLine(true)
  }


  function searchFromSourceMenu(): void {
    void dispatchMenuControl('search-in-files')
  }

  function dismissMenuContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault()
    void dispatchMenuControl('close')
  }

  function keepMenuContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.stopPropagation()
  }
  function handleSourceMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    void dispatchMenuControl('close')
  }

  function scrollFromMinimap(event: ReactMouseEvent<HTMLCanvasElement>): void {
    const target = canvas.current
    if (!target) return
    if (!viewRef.current) {
      reportSourceError(SOURCE_CONTROL_UNAVAILABLE)
      return
    }
    const bounds = target.getBoundingClientRect()
    const position = bounds.height === 0
      ? 0
      : Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    void dispatchSourceControl('minimap', { position })
  }


  useImperativeHandle(forwardedRef, () => ({
    flush: async () => callbacks.current.flushDraft(),
    focus: () => {
      const view = viewRef.current
      if (!view) throw new Error('The source editor is not mounted.')
      view.focus()
    },
    reveal: (line, column = 1) => {
      const view = viewRef.current
      if (!view) throw new Error('The source editor is not mounted.')
      revealPosition(view, line, column)
      view.focus()
    },
    undo: () => { const view = viewRef.current; if (!view) throw new Error('The source editor is not mounted.'); undo(view) },
    redo: () => { const view = viewRef.current; if (!view) throw new Error('The source editor is not mounted.'); redo(view) },
    find: async (query) => showSearch(false, query),
    replace: async (query) => showSearch(true, query),
    copyContext: copySelectionContext,
    definition: (position) => props.symbols
      ? sourceSymbols.definition(position)
      : Promise.reject(new Error(SOURCE_EDITOR_ONLY_MESSAGE)),
    references: (position) => props.symbols
      ? sourceSymbols.references(position)
      : Promise.reject(new Error(SOURCE_EDITOR_ONLY_MESSAGE))
  }), [copySelectionContext, props.symbols, showSearch, sourceSymbols.definition, sourceSymbols.references])

  useEffect(() => {
    const view = viewRef.current
    if (view) applySearchQuery(view, searchQuery, replaceText)
  }, [replaceText, searchQuery])

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    let changedSelection = false
    const savedSelection = pendingNavigation ? undefined : initialSelection(props.buffer, props.tabId)
    const preserved = preservedDocument.current
    const initialContent = preserved?.bufferId === props.buffer.id && preserved.tabId === props.tabId
      ? preserved.text
      : content
    preservedDocument.current = null
    const zoomTheme = EditorView.theme({ '&': { fontSize: `${props.fontSize}px`, fontFamily: props.fontFamily || 'var(--terminal-font-family, ui-monospace, monospace)' } })
    const comparisonEnabled = comparisonOriginalRef.current !== undefined
    const stateConfig: EditorStateConfig = {
      doc: initialContent,
      ...(savedSelection ? { selection: savedSelection } : {}),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        foldGutter(),
        indentOnInput(),
        syntaxHighlighting(editorHighlightStyle, { fallback: true }),
        ...(comparisonEnabled ? [
          editorTheme,
          EditorView.editorAttributes.of({ 'aria-label': 'Modified editor' })
        ] : []),
        history(),
        search(),
        compartments.language.of(languageFor(props.buffer.relativePath)),
        compartments.wrap.of(props.wrap ? EditorView.lineWrapping : []),
        compartments.zoom.of(zoomTheme),
        keymap.of([
          { key: 'Mod-g', run: findNextFromKeyboard },
          ...editorSearchKeymap,
          ...editorHistoryKeymap,
          ...editorDefaultKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            textRevision.current++
            sourceSymbols.documentChanged()
            if (!suppressDraft.current) callbacks.current.onDraft(update.state.doc.toString())
          }
          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main
            if (range.empty) setSelection(null)
            else {
              const start = update.state.doc.lineAt(range.from)
              const end = update.state.doc.lineAt(range.to)
              setSelection((current) => current?.fromLine === start.number && current.toLine === end.number ? current : { fromLine: start.number, toLine: end.number })
            }
          }
          if (update.selectionSet || update.docChanged || update.viewportChanged) scheduleView.current()
          drawMinimapRef.current()
        }),
        EditorView.domEventHandlers({
          focus: () => { callbacks.current.onEditorFocus(); return false },
          paste: (event, view) => {
            const text = event.clipboardData?.getData('text/plain')
            if (text === undefined) return false
            event.preventDefault()
            if (utf8Size(text) > PASTE_LIMIT) {
              setPasteError('Paste refused: source editor pastes are limited to 16 MiB.')
              callbacks.current.onError('Paste refused: source editor pastes are limited to 16 MiB.')
              return true
            }
            setPasteError(null)
            reportSourceError(null)
            const range = view.state.selection.main
            view.dispatch({
              changes: { from: range.from, to: range.to, insert: text },
              annotations: [Transaction.userEvent.of('input.paste'), isolateHistory.of('full')]
            })
            return true
          },
          mousedown: handleSymbolMouseDown,
          contextmenu: handleEditorContextMenu
        })
      ]
    }
    let editor: EditorView
    let destroyEditor: () => void
    const comparisonOriginal = comparisonOriginalRef.current
    if (comparisonOriginal !== undefined) {
      const merge = new MergeView({
        a: {
          doc: comparisonOriginal,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            foldGutter(),
            syntaxHighlighting(editorHighlightStyle, { fallback: true }),
            editorTheme,
            EditorView.editorAttributes.of({ 'aria-label': 'HEAD version' }),
            compartments.language.of(languageFor(props.buffer.relativePath)),
            compartments.wrap.of(props.wrap ? EditorView.lineWrapping : []),
            compartments.zoom.of(zoomTheme),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false)
          ]
        },
        b: stateConfig,
        parent,
        gutter: true,
        highlightChanges: true
      })
      const headPane = merge.a.dom.parentElement
      headPane?.setAttribute('role', 'group')
      headPane?.setAttribute('aria-label', 'HEAD version')
      const modifiedPane = merge.b.dom.parentElement
      modifiedPane?.setAttribute('role', 'group')
      modifiedPane?.setAttribute('aria-label', 'Modified editor')
      mergeRef.current = merge
      mergeOriginal.current = comparisonOriginal
      editor = merge.b
      destroyEditor = () => merge.destroy()
    } else {
      mergeRef.current = null
      mergeOriginal.current = null
      editor = new EditorView({ state: EditorState.create(stateConfig), parent })
      destroyEditor = () => editor.destroy()
    }
    viewRef.current = editor
    setEngineSession({ key: engineKey, generation: newSourceControlGeneration() })
    const tabId = props.tabId
    const unregisterFocus = tabId === null ? undefined : registerEditorFocus(tabId, () => {
      const group = parent.closest<HTMLElement>('.qt-group')
      const hostedView = parent.closest<HTMLElement>('.qt-hosted-view')
      if (group?.classList.contains('qt-active') && hostedView?.dataset.hostedView === tabId) editor.focus()
    })
    applySearchQuery(editor, searchQuery, replaceText)
    let drawFrame = 0
    const paintMinimap = () => {
      drawFrame = 0
      const target = canvas.current
      if (target && minimapEnabled.current) drawMinimap(editor, target)
    }
    const requestMinimap = () => {
      if (!minimapEnabled.current || drawFrame !== 0) return
      drawFrame = window.requestAnimationFrame(paintMinimap)
    }
    drawMinimapRef.current = requestMinimap
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(requestMinimap)
      resizeObserver.observe(parent)
      if (canvas.current) resizeObserver.observe(canvas.current)
    }
    let themeObserver: MutationObserver | undefined
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(requestMinimap)
      themeObserver.observe(parent.ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-theme'], subtree: true })
    }
    requestMinimap()
    if (props.reveal) revealPosition(editor, props.reveal.line, props.reveal.column ?? 1)
    if (!pendingNavigation && savedSelection) editor.dispatch({ effects: EditorView.scrollIntoView(savedSelection.main.head, { y: 'center' }) })
    const savedScroll = pendingNavigation ? undefined : viewStateForTab(props.buffer, props.tabId).scrollTop
    if (typeof savedScroll === 'number' && Number.isFinite(savedScroll)) editor.scrollDOM.scrollTop = Math.max(0, savedScroll)
    const saveView = () => {
      if (!changedSelection) return
      changedSelection = false
      const selection = editor.state.selection.main
      const cursor = editor.state.doc.lineAt(selection.head)
      callbacks.current.onView({
        selection: { anchor: selection.anchor, head: selection.head },
        cursor: { line: cursor.number, column: selection.head - cursor.from + 1 },
        scrollTop: editor.scrollDOM.scrollTop
      })
    }
    const schedule = () => {
      changedSelection = true
      drawMinimapRef.current()
      if (pendingView.current !== undefined) return
      pendingView.current = window.setTimeout(() => {
        pendingView.current = undefined
        saveView()
      }, 160)
    }
    scheduleView.current = schedule
    editor.scrollDOM.addEventListener('scroll', schedule, { passive: true })
    return () => {
      unregisterFocus?.()
      if (pendingView.current !== undefined) window.clearTimeout(pendingView.current)
      pendingView.current = undefined
      if (drawFrame !== 0) window.cancelAnimationFrame(drawFrame)
      themeObserver?.disconnect()
      editor.scrollDOM.removeEventListener('scroll', schedule)
      scheduleView.current = () => {}
      drawMinimapRef.current = () => {}
      saveView()
      preservedDocument.current = { bufferId: props.buffer.id, tabId: props.tabId, text: editor.state.doc.toString() }
      destroyEditor()
      viewRef.current = null
      mergeRef.current = null
      mergeOriginal.current = null
    }
  }, [props.buffer.id, props.tabId, props.comparisonOriginal !== undefined, engineKey])
  useEffect(() => {
    const menu = menuSessionRef.current
    if (menu && menu.sourceGeneration !== sourceGeneration) closeSourceMenu(menu.generation)
  }, [sourceGeneration])

  useEffect(() => {
    const merge = mergeRef.current
    const original = props.comparisonOriginal
    if (!merge || original === undefined || mergeOriginal.current === original) return
    merge.a.dispatch({ changes: { from: 0, to: merge.a.state.doc.length, insert: original } })
    mergeOriginal.current = original
  }, [props.comparisonOriginal])

  useEffect(() => {
    const editor = viewRef.current
    if (!editor) return
    const actual = editor.state.doc.toString()
    if (content === actual) {
      acceptedText.current = content
      return
    }
    if (actual !== acceptedText.current) {
      callbacks.current.onError('A newer shared draft arrived. Your local text is preserved for comparison.')
      return
    }
    acceptedText.current = content
    suppressDraft.current = true
    try {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content } })
    } finally {
      suppressDraft.current = false
    }
  }, [content, props.buffer.contentRevision])

  useEffect(() => {
    const editor = viewRef.current
    if (!editor) return
    const merge = mergeRef.current
    const views = merge ? [merge.a, merge.b] : [editor]
    const zoomTheme = EditorView.theme({ '&': { fontSize: `${props.fontSize}px`, fontFamily: props.fontFamily || 'var(--terminal-font-family, ui-monospace, monospace)' } })
    for (const view of views) {
      view.dispatch({
        effects: [
          compartments.wrap.reconfigure(props.wrap ? EditorView.lineWrapping : []),
          compartments.zoom.reconfigure(zoomTheme)
        ]
      })
    }
  }, [compartments, props.wrap, props.fontSize, props.fontFamily])
  useEffect(() => {
    const editor = viewRef.current
    if (!editor) return
    const merge = mergeRef.current
    const views = merge ? [merge.a, merge.b] : [editor]
    const language = languageFor(props.buffer.relativePath)
    for (const view of views) view.dispatch({ effects: compartments.language.reconfigure(language) })
  }, [compartments, props.buffer.relativePath])

  useEffect(() => {
    drawMinimapRef.current()
  }, [props.minimap])


  useEffect(() => {
    if (props.reveal && viewRef.current) revealPosition(viewRef.current, props.reveal.line, props.reveal.column ?? 1)
  }, [props.reveal?.line, props.reveal?.column])

  useEffect(() => {
    const editor = viewRef.current
    if (!pendingNavigation) {
      appliedNavigation.current = null
      return
    }
    if (!editor || props.reveal) return
    const key = `${props.buffer.id}:${props.tabId}:${pendingNavigation.navigationId}`
    if (appliedNavigation.current === key) return
    appliedNavigation.current = key
    revealPosition(editor, pendingNavigation.line, pendingNavigation.column, pendingNavigation.matchLength)
    if (pendingNavigation.focused) editor.focus()
    const selection = editor.state.selection.main
    const cursor = editor.state.doc.lineAt(selection.head)
    callbacks.current.onView({
      navigationId: pendingNavigation.navigationId,
      line: null,
      column: null,
      matchLength: null,
      focused: false,
      selection: { anchor: selection.anchor, head: selection.head },
      cursor: { line: cursor.number, column: selection.head - cursor.from + 1 },
      scrollTop: editor.scrollDOM.scrollTop
    })
  }, [
    content,
    props.buffer.id,
    props.tabId,
    pendingNavigation?.navigationId,
    pendingNavigation?.line,
    pendingNavigation?.column,
    pendingNavigation?.matchLength,
    pendingNavigation?.focused,
    props.reveal?.line,
    props.reveal?.column
  ])


  return (
    <div className={`qe-source-editor${props.minimap ? ' has-minimap' : ''}`}>
      {bridgeContext && <SourceControlRegistration
        context={bridgeContext}
        sourceAddress={sourceAddress}
        menuAddress={menuAddress}
        onSourceControl={onSourceControl}
        onMenuControl={onMenuControl}
      />}
      {selection && (
        <div className="qe-selection-copy-hint">
          <span>{selection.fromLine === selection.toLine ? `Line ${selection.fromLine} selected` : `Lines ${selection.fromLine}–${selection.toLine} selected`}</span>
          <Button onClick={requestCopyContext}>Copy context ⌘⌥C</Button>
        </div>
      )}
      {searchOpen && <div className="qe-source-search" role="search" aria-label="Find in source">
        <input
          className="ui-text-field__input qe-source-search__field"
          ref={searchInput}
          aria-label="Find in source"
          value={searchQuery}
          onChange={(event) => setSearchQueryText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitFindNext(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              closeFind()
            }
          }}
        />
        {replaceOpen && <TextField className="qe-source-search__field" label="Replace with" value={replaceText} onChange={(event) => setReplaceText(event.currentTarget.value)} />}
        <Button onClick={commitFindNextFromButton}>Find next</Button>
        {replaceOpen && <>
          <Button onClick={commitReplaceNext}>Replace</Button>
          <Button onClick={commitReplaceAll}>Replace all</Button>
        </>}
        <Button aria-label="Close find" onClick={closeFind}>Close</Button>
      </div>}
      <div className="qe-source-editor-main">
        <div className="qe-codemirror-host" ref={host} />
        {props.minimap && <canvas ref={canvas} className="qe-editor-minimap" aria-label="Code minimap" title="Click to jump to a section of the file" onClick={scrollFromMinimap} />}
      </div>
      {symbolsEnabled && props.symbols && <SourceLocations
        context={props.symbols.context}
        bufferId={props.buffer.id}
        tabId={props.tabId}
        sourceGeneration={sourceGeneration}
        enabled={symbolsEnabled}
        controller={sourceSymbols}
        isValidPosition={isValidSymbolPosition}
        focusEditor={() => { viewRef.current?.focus() }}
        onSourceControlRunner={onSourceControlRunner}
      />}
      {(pasteError || props.error || controlError) && <div className="qe-editor-error"><InlineError message={pasteError ?? props.error ?? controlError!} /></div>}
      {contextMenu && (
        <div className="qe-source-menu-layer" onClick={requestCloseSourceMenu} onContextMenu={dismissMenuContextMenu}>
          <div
            className="qe-source-context-menu"
            role="menu"
            aria-label={contextMenu.kind === 'gutter' ? 'Line actions' : 'Editor actions'}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={keepMenuContextMenu}
            onKeyDown={handleSourceMenuKeyDown}
          >
            {contextMenu.kind === 'gutter' ? (
              <>
                <Button role="menuitem" onClick={copyAbsoluteSourceLine}>Copy Path to Line</Button>
                <Button role="menuitem" onClick={copyRelativeSourceLine}>Copy Rel. Path to Line</Button>
              </>
            ) : (
              <>
                {symbolsEnabled && <>
                  <Button role="menuitem" onClick={() => { void dispatchMenuControl('definition') }}>Go to Definition</Button>
                  <Button role="menuitem" onClick={() => { void dispatchMenuControl('references') }}>Find References</Button>
                </>}
                <Button role="menuitem" disabled={!contextMenu.query?.trim()} onClick={searchFromSourceMenu}>Search in Files</Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
