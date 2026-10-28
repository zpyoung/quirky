import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Button, TextField } from '@quirky/ui'
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting, tags } from '@codemirror/language'
import { findNext, replaceAll, replaceNext, search, SearchQuery, searchKeymap, setSearchQuery } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import type { EditorSurfaceBuffer } from '../types'

const PASTE_LIMIT = 16 * 1024 * 1024
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
type SourceMenu = { kind: 'editor' | 'gutter'; x: number; y: number; query?: string; line?: number }

export type SourceEditorHandle = {
  flush(): Promise<void>
  focus(): void
  reveal(line: number, column?: number): void
  undo(): void
  redo(): void
  find(query?: string): Promise<{ opened: true; query?: string }>
  replace(query?: string): Promise<{ opened: true; query?: string }>
  copyContext(): Promise<{ copied: true; path: string; lines: string }>
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

function initialSelection(buffer: EditorSurfaceBuffer, tabId: string | null): EditorSelection | undefined {
  const text = buffer.draft ?? buffer.content
  const view = viewStateForTab(buffer, tabId) as { selection?: { anchor?: unknown; head?: unknown }; cursor?: { line?: unknown; column?: unknown } } | undefined
  const saved = view?.selection
  if (typeof saved?.anchor === 'number' && typeof saved.head === 'number') {
    return EditorSelection.single(Math.min(text.length, Math.max(0, saved.anchor)), Math.min(text.length, Math.max(0, saved.head)))
  }
  const cursor = view?.cursor
  if (typeof cursor?.line === 'number') {
    const line = Math.max(1, cursor.line)
    const column = typeof cursor.column === 'number' ? Math.max(1, cursor.column) : 1
    let lineStart = 0
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
    return EditorSelection.single(Math.min(lineEnd, lineStart + column - 1))
  }
  return undefined
}

/** A source editor whose only document mutation path is the acknowledged daemon draft queue. */
export const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(props, forwardedRef) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const pendingView = useRef<number | undefined>(undefined)
  const acceptedText = useRef(props.buffer.draft ?? props.buffer.content)
  const suppressDraft = useRef(false)
  const scheduleView = useRef<() => void>(() => {})
  const drawMinimapRef = useRef<() => void>(() => {})
  const minimapEnabled = useRef(props.minimap)
  minimapEnabled.current = props.minimap
  const compartments = useMemo(() => ({ wrap: new Compartment(), zoom: new Compartment(), language: new Compartment() }), [])
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [selection, setSelection] = useState<SelectionSummary | null>(null)
  const [contextMenu, setContextMenu] = useState<SourceMenu | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [searchQuery, setSearchQueryText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const content = props.buffer.draft ?? props.buffer.content
  const applySearchQuery = (view: EditorView, query: string, replacement: string) => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query, replace: replacement })) })
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
  const runFind = () => {
    const view = viewRef.current
    if (!view) throw new Error('The source editor is not mounted.')
    if (searchQuery === '') throw new Error('Enter text to find in the source editor.')
    applySearchQuery(view, searchQuery, replaceText)
    if (!findNext(view)) throw new Error(`No match for “${searchQuery}”.`)
  }
  const runReplace = (all: boolean) => {
    const view = viewRef.current
    if (!view) throw new Error('The source editor is not mounted.')
    if (searchQuery === '') throw new Error('Enter text to replace in the source editor.')
    applySearchQuery(view, searchQuery, replaceText)
    const replaced = all ? replaceAll(view) : replaceNext(view)
    if (!replaced) throw new Error(`No match for “${searchQuery}”.`)
    return { replaced: true, all }
  }
  const copySelectionContext = async () => {
    const view = viewRef.current
    if (!view) throw new Error('The source editor is not mounted.')
    const range = view.state.selection.main
    if (range.empty) throw new Error('Select text before copying editor context.')
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.')
    const start = view.state.doc.lineAt(range.from)
    const end = view.state.doc.lineAt(range.to)
    const lines = start.number === end.number ? `${start.number}` : `${start.number}-${end.number}`
    const text = `${props.buffer.relativePath}:${lines}\n${view.state.doc.sliceString(range.from, range.to)}`
    await navigator.clipboard.writeText(text)
    callbacks.current.onError(null)
    return { copied: true as const, path: props.buffer.relativePath, lines }
  }
  const reportCopyError = (reason: unknown) => {
    callbacks.current.onError(`Unable to copy selection context: ${reason instanceof Error ? reason.message : String(reason)}`)
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
      const targetLine = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
      const position = Math.min(targetLine.to, targetLine.from + Math.max(0, column - 1))
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) })
      view.focus()
    },
    undo: () => { const view = viewRef.current; if (!view) throw new Error('The source editor is not mounted.'); undo(view) },
    redo: () => { const view = viewRef.current; if (!view) throw new Error('The source editor is not mounted.'); redo(view) },
    find: async (query) => showSearch(false, query),
    replace: async (query) => showSearch(true, query),
    copyContext: copySelectionContext
  }), [copySelectionContext, showSearch])

  useEffect(() => {
    const view = viewRef.current
    if (view) applySearchQuery(view, searchQuery, replaceText)
  }, [replaceText, searchQuery])

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    let changedSelection = false
    const savedSelection = initialSelection(props.buffer, props.tabId)
    const state = EditorState.create({
      doc: content,
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
        history(),
        search(),
        compartments.language.of(languageFor(props.buffer.relativePath)),
        compartments.wrap.of(props.wrap ? EditorView.lineWrapping : []),
        compartments.zoom.of(EditorView.theme({ '&': { fontSize: `${props.fontSize}px`, fontFamily: props.fontFamily || 'var(--terminal-font-family, ui-monospace, monospace)' } })),
        keymap.of([
          { key: 'Mod-g', run: findNext },
          ...editorSearchKeymap,
          ...editorHistoryKeymap,
          ...editorDefaultKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressDraft.current) callbacks.current.onDraft(update.state.doc.toString())
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
            callbacks.current.onError(null)
            const range = view.state.selection.main
            view.dispatch({
              changes: { from: range.from, to: range.to, insert: text },
              annotations: [Transaction.userEvent.of('input.paste'), isolateHistory.of('full')]
            })
            return true
          },
          contextmenu: (event, view) => {
            const target = event.target
            if (!(target instanceof HTMLElement)) return false
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (position === null) return false
            const line = view.state.doc.lineAt(position).number
            if (target.closest('.cm-lineNumbers')) {
              event.preventDefault()
              setContextMenu({ kind: 'gutter', x: event.clientX, y: event.clientY, line })
              return true
            }
            if (target.closest('.cm-content')) {
              const range = view.state.selection.main
              const query = (range.empty ? wordAt(view, position) : view.state.doc.sliceString(range.from, range.to)).slice(0, 8192)
              event.preventDefault()
              setContextMenu({ kind: 'editor', x: event.clientX, y: event.clientY, query })
              return true
            }
            return false
          }
        })
      ]
    })
    const editor = new EditorView({ state, parent })
    viewRef.current = editor
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
    if (props.reveal) {
      const line = editor.state.doc.line(Math.max(1, Math.min(props.reveal.line, editor.state.doc.lines)))
      const position = Math.min(line.to, line.from + Math.max(0, (props.reveal.column ?? 1) - 1))
      editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) })
    }
    if (savedSelection) editor.dispatch({ effects: EditorView.scrollIntoView(savedSelection.main.head, { y: 'center' }) })
    const savedScroll = viewStateForTab(props.buffer, props.tabId).scrollTop
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
      if (pendingView.current !== undefined) window.clearTimeout(pendingView.current)
      pendingView.current = undefined
      if (drawFrame !== 0) window.cancelAnimationFrame(drawFrame)
      themeObserver?.disconnect()
      editor.scrollDOM.removeEventListener('scroll', schedule)
      scheduleView.current = () => {}
      drawMinimapRef.current = () => {}
      saveView()
      editor.destroy()
      viewRef.current = null
    }
  }, [props.buffer.id, props.tabId])

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
    editor.dispatch({ effects: compartments.wrap.reconfigure(props.wrap ? EditorView.lineWrapping : []) })
    editor.dispatch({ effects: compartments.zoom.reconfigure(EditorView.theme({ '&': { fontSize: `${props.fontSize}px`, fontFamily: props.fontFamily || 'var(--terminal-font-family, ui-monospace, monospace)' } })) })
  }, [compartments, props.wrap, props.fontSize])
  useEffect(() => {
    const editor = viewRef.current
    if (!editor) return
    editor.dispatch({ effects: compartments.language.reconfigure(languageFor(props.buffer.relativePath)) })
  }, [compartments, props.buffer.relativePath])

  useEffect(() => {
    drawMinimapRef.current()
  }, [props.minimap])


  useEffect(() => {
    if (props.reveal && viewRef.current) {
      const targetLine = viewRef.current.state.doc.line(Math.max(1, Math.min(props.reveal.line, viewRef.current.state.doc.lines)))
      const position = Math.min(targetLine.to, targetLine.from + Math.max(0, (props.reveal.column ?? 1) - 1))
      viewRef.current.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) })
    }
  }, [props.reveal?.line, props.reveal?.column])

  const copyGutterLine = async (relative: boolean) => {
    if (!contextMenu || contextMenu.kind !== 'gutter' || contextMenu.line === undefined) return
    const path = relative ? props.buffer.relativePath : props.buffer.path
    try {
      await navigator.clipboard.writeText(`${path}:${contextMenu.line}`)
      callbacks.current.onError(null)
    } catch (reason) {
      callbacks.current.onError(`Unable to copy line path: ${reason instanceof Error ? reason.message : String(reason)}`)
    }
    setContextMenu(null)
  }
  const searchFromContextMenu = () => {
    const query = contextMenu?.kind === 'editor' ? contextMenu.query?.trim() : ''
    if (query) callbacks.current.onSearchInFiles(query)
    setContextMenu(null)
  }
  const scrollFromMinimap = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const target = canvas.current
    const editor = viewRef.current
    if (!target || !editor) return
    const bounds = target.getBoundingClientRect()
    const position = bounds.height === 0 ? 0 : Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    editor.scrollDOM.scrollTop = Math.max(0, editor.scrollDOM.scrollHeight - editor.scrollDOM.clientHeight) * position
  }

  return (
    <div className={`qe-source-editor${props.minimap ? ' has-minimap' : ''}`}>
      {selection && (
        <div className="qe-selection-copy-hint">
          <span>{selection.fromLine === selection.toLine ? `Line ${selection.fromLine} selected` : `Lines ${selection.fromLine}–${selection.toLine} selected`}</span>
          <Button onClick={() => { void copySelectionContext().catch(reportCopyError) }}>Copy context ⌘⌥C</Button>
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
              try { runFind() } catch (reason) { callbacks.current.onError(reason instanceof Error ? reason.message : String(reason)) }
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setSearchOpen(false)
            }
          }}
        />
        {replaceOpen && <TextField className="qe-source-search__field" label="Replace with" value={replaceText} onChange={(event) => setReplaceText(event.currentTarget.value)} />}
        <Button onClick={() => { try { runFind() } catch (reason) { callbacks.current.onError(reason instanceof Error ? reason.message : String(reason)) } }}>Find next</Button>
        {replaceOpen && <>
          <Button onClick={() => { try { runReplace(false) } catch (reason) { callbacks.current.onError(reason instanceof Error ? reason.message : String(reason)) } }}>Replace</Button>
          <Button onClick={() => { try { runReplace(true) } catch (reason) { callbacks.current.onError(reason instanceof Error ? reason.message : String(reason)) } }}>Replace all</Button>
        </>}
        <Button aria-label="Close find" onClick={() => setSearchOpen(false)}>Close</Button>
      </div>}
      <div className="qe-source-editor-main">
        <div className="qe-codemirror-host" ref={host} />
        {props.minimap && <canvas ref={canvas} className="qe-editor-minimap" aria-label="Code minimap" title="Click to jump to a section of the file" onClick={scrollFromMinimap} />}
      </div>
      {(pasteError || props.error) && <div className="qe-editor-error" role="alert">{pasteError ?? props.error}</div>}
      {contextMenu && (
        <div className="qe-source-menu-layer" onClick={() => setContextMenu(null)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(null) }}>
          <div
            className="qe-source-context-menu"
            role="menu"
            aria-label={contextMenu.kind === 'gutter' ? 'Line actions' : 'Editor actions'}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {contextMenu.kind === 'gutter' ? (
              <>
                <Button role="menuitem" onClick={() => void copyGutterLine(false)}>Copy Path to Line</Button>
                <Button role="menuitem" onClick={() => void copyGutterLine(true)}>Copy Rel. Path to Line</Button>
              </>
            ) : (
              <Button role="menuitem" disabled={!contextMenu.query} onClick={searchFromContextMenu}>Search in Files</Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
