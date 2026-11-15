import { useCallback, useEffect, useRef, useState } from 'react'
import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorSurfaceBuffer } from '../types'

export type SourceSymbolsKind = 'definition' | 'references'
export type NavigationLanguage = 'typescript' | 'python'
export type NavigationPosition = { line: number; column: number }
export type SourceLocation = {
  path: string
  relativePath: string | null
  line: number
  column: number
  endLine: number
  endColumn: number
  preview: string
}
export type NavigationResult = {
  worktreeId: string
  language: string
  locations: SourceLocation[]
  truncated: boolean
}
export type SourceSymbolsResult =
  | { kind: 'definition'; status: 'opened'; path: string; line: number; column: number }
  | { kind: SourceSymbolsKind; status: 'list'; count: number; truncated: boolean }
  | { kind: SourceSymbolsKind; status: 'empty' }
export type SourceSymbolsReport = {
  status: 'idle' | 'pending' | 'list' | 'empty' | 'error'
  kind: SourceSymbolsKind | null
  count: number | null
  truncated: boolean | null
  error: string | null
}
export type SourceLocationsPanel = {
  generation: string
  kind: SourceSymbolsKind
  label: string
  position?: NavigationPosition
  status: 'pending' | 'list' | 'empty' | 'error'
  locations: SourceLocation[]
  truncated: boolean
  error: string | null
  retryable: boolean
  focusResults: boolean
}

export const UNSAVED_SOURCE_SYMBOLS_MESSAGE = 'Save this file first. Navigation reads files from disk, and this one has unsaved changes.'
export const CHANGED_SOURCE_SYMBOLS_MESSAGE = 'This file changed on disk. Reload or save it before navigating.'
export const DELETED_SOURCE_SYMBOLS_MESSAGE = "This file was deleted on disk, so navigation can't read it."
export const UNSUPPORTED_SOURCE_SYMBOLS_MESSAGE = 'Go to Definition and Find References work in TypeScript, JavaScript and Python files.'
export const SOURCE_EDITOR_ONLY_MESSAGE = 'Go to Definition and Find References work in the source editor.'
export const SOURCE_WINDOW_UNKNOWN_MESSAGE = 'The daemon did not identify this window.'
export const LOOKUP_CLOSED_MESSAGE = 'The lookup was closed before it finished.'
export const DOCUMENT_CHANGED_MESSAGE = 'The document changed before the lookup finished.'
export const LOOKUP_REPLACED_MESSAGE = 'A newer lookup replaced this one.'
export const WORKTREE_MISMATCH_MESSAGE = 'Navigation answered for a different worktree.'

const SAFE_REPORT_ERRORS = new Set([
  UNSAVED_SOURCE_SYMBOLS_MESSAGE, CHANGED_SOURCE_SYMBOLS_MESSAGE, DELETED_SOURCE_SYMBOLS_MESSAGE,
  UNSUPPORTED_SOURCE_SYMBOLS_MESSAGE, SOURCE_EDITOR_ONLY_MESSAGE, SOURCE_WINDOW_UNKNOWN_MESSAGE,
  LOOKUP_CLOSED_MESSAGE, DOCUMENT_CHANGED_MESSAGE, LOOKUP_REPLACED_MESSAGE, WORKTREE_MISMATCH_MESSAGE
])

function reportError(kind: SourceSymbolsKind, message: string): string {
  return SAFE_REPORT_ERRORS.has(message) ? message
    : kind === 'definition' ? 'Go to Definition failed.' : 'Find References failed.'
}

let nextLocationsGeneration = 0
let nextLookupIntent = 0

function newLookupIntent(): string {
  return `source-lookup-intent-${++nextLookupIntent}`
}

export function navigationLanguage(path: string): NavigationLanguage | null {
  const lower = path.toLowerCase()
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(lower)) return 'typescript'
  if (/\.(?:py|pyi)$/.test(lower)) return 'python'
  return null
}

function countSeparators(text: string, limit: number): number {
  let count = 0
  for (let index = text.indexOf('\u2028'); index >= 0 && index < limit; index = text.indexOf('\u2028', index + 1)) count++
  for (let index = text.indexOf('\u2029'); index >= 0 && index < limit; index = text.indexOf('\u2029', index + 1)) count++
  return count
}

function lastSeparator(text: string, limit: number): number {
  if (limit === 0) return -1
  const lineSeparator = text.lastIndexOf('\u2028', limit - 1)
  const paragraphSeparator = text.lastIndexOf('\u2029', limit - 1)
  return Math.max(lineSeparator, paragraphSeparator)
}

export function toNavigationPosition(doc: Text, offset: number, language: NavigationLanguage): NavigationPosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > doc.length) throw new RangeError('The source position is outside the document.')
  const line = doc.lineAt(offset)
  const local = offset - line.from
  if (language === 'python') return { line: line.number, column: local + 1 }

  let precedingSeparators = 0
  for (let number = 1; number < line.number; number++) {
    precedingSeparators += countSeparators(doc.line(number).text, doc.line(number).length)
  }
  const last = lastSeparator(line.text, local)
  const currentSeparators = countSeparators(line.text, local)
  return {
    line: line.number + precedingSeparators + currentSeparators,
    column: local - last
  }
}

export function fromNavigationPosition(doc: Text, line: number, column: number, language: NavigationLanguage): number | null {
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) return null
  if (language === 'python') {
    if (line > doc.lines) return null
    const target = doc.line(line)
    return column <= target.length + 1 ? target.from + column - 1 : null
  }

  let navigationLine = 1
  for (let number = 1; number <= doc.lines; number++) {
    const target = doc.line(number)
    const text = target.text
    let start = 0
    while (start <= text.length) {
      let end = start
      while (end < text.length && text.charCodeAt(end) !== 0x2028 && text.charCodeAt(end) !== 0x2029) end++
      if (navigationLine === line) {
        const local = column - 1
        return local <= end - start ? target.from + start + local : null
      }
      if (end === text.length) break
      navigationLine++
      start = end + 1
    }
    if (number < doc.lines) navigationLine++
  }
  return null
}

export function sourceSymbolRefusal(input: {
  buffer: Pick<EditorSurfaceBuffer, 'content' | 'draft' | 'external' | 'untitled'>
  localText: string | null
  pendingDraft: boolean
  blockedDraft: boolean
}): string | null {
  if (input.buffer.external === 'changed') return CHANGED_SOURCE_SYMBOLS_MESSAGE
  if (input.buffer.external === 'deleted') return DELETED_SOURCE_SYMBOLS_MESSAGE
  if (input.buffer.untitled || input.buffer.draft !== null || input.pendingDraft || input.blockedDraft ||
      input.localText !== null && input.localText !== input.buffer.content) return UNSAVED_SOURCE_SYMBOLS_MESSAGE
  return null
}

export function validateNavigationResult(value: unknown): NavigationResult {
  if (!isRecord(value) || typeof value.worktreeId !== 'string' || typeof value.language !== 'string' ||
      !Array.isArray(value.locations) || typeof value.truncated !== 'boolean') {
    throw new Error('Navigation returned an invalid result.')
  }
  const locations: SourceLocation[] = []
  for (const item of value.locations) {
    if (!isRecord(item) || typeof item.path !== 'string' ||
        !(item.relativePath === null || typeof item.relativePath === 'string') ||
        !positiveInteger(item.line) || !positiveInteger(item.column) ||
        !positiveInteger(item.endLine) || !positiveInteger(item.endColumn) ||
        typeof item.preview !== 'string') {
      throw new Error('Navigation returned an invalid location.')
    }
    locations.push({
      path: item.path,
      relativePath: item.relativePath,
      line: item.line,
      column: item.column,
      endLine: item.endLine,
      endColumn: item.endColumn,
      preview: item.preview
    })
  }
  return { worktreeId: value.worktreeId, language: value.language, locations, truncated: value.truncated }
}

export function sourceOpenParameters(worktree: string, location: SourceLocation, window: number): Record<string, unknown> {
  const matchLength = location.endLine === location.line ? location.endColumn - location.column : 0
  return {
    worktree,
    path: location.relativePath,
    mode: 'source',
    line: location.line,
    column: location.column,
    ...(matchLength > 0 ? { matchLength } : {}),
    window
  }
}

type BufferIdentity = Pick<EditorSurfaceBuffer, 'id' | 'worktreeId' | 'path' | 'relativePath' | 'untitled' | 'external' | 'draft' | 'content'>
export type SourceSymbolsHost = {
  context: UiPluginContext
  refusal(): string | null
}

type LookupParams = { worktree: string; path: string; line: number; column: number }
type LookupSession = {
  request: number
  bufferId: string
  tabId: string | null
  worktreeId: string
  path: string
  relativePath: string
  engineGeneration: string
  revision: number
  language: NavigationLanguage
  kind: SourceSymbolsKind
  label: string
  params: LookupParams
  focusResults: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  resolve(value: SourceSymbolsResult): void
  reject(reason: Error): void
  settled: boolean
}
type LookupIntent = {
  token: string
  kind: SourceSymbolsKind
  position: NavigationPosition
  bufferId: string
  tabId: string | null
  worktreeId: string
  path: string
  relativePath: string
  engineGeneration: string
  revision: number
  language: NavigationLanguage
  context: UiPluginContext
  consumed: boolean
}
export type UseSourceSymbolsOptions = {
  context: UiPluginContext | null
  buffer: BufferIdentity
  tabId: string | null
  language: NavigationLanguage
  engineGeneration: string | null
  enabled: boolean
  refusal(): string | null
  revision: { current: number }
  getView(): EditorView | null
  symbolAt(offset: number): string
  reveal(from: number, to: number): void
}
type SessionCurrent = 'current' | 'detached' | 'changed' | 'refused' | 'replaced'
export type SourceSymbolsController = {
  report: SourceSymbolsReport
  panel: SourceLocationsPanel | null
  definition(position?: NavigationPosition, label?: string): Promise<SourceSymbolsResult>
  references(position?: NavigationPosition, label?: string): Promise<SourceSymbolsResult>
  reserveIntent(kind: SourceSymbolsKind, position?: NavigationPosition): string | null
  isIntentCurrent(token: string): boolean
  control(action: SourceSymbolsKind, position?: NavigationPosition, options?: { intent?: string; focus?: boolean }): boolean
  open(index: number, generation: string): boolean
  close(generation?: string): boolean
  retry(generation: string): boolean
  documentChanged(): void
  bridgeFailure(intent?: string): (message: string, dispatchedIntent?: string) => void
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
function idleReport(): SourceSymbolsReport {
  return { status: 'idle', kind: null, count: null, truncated: null, error: null }
}
function validEditorPosition(doc: Text, position: NavigationPosition): number | null {
  if (!positiveInteger(position.line) || !positiveInteger(position.column) || position.line > doc.lines) return null
  const line = doc.line(position.line)
  return position.column <= line.length + 1 ? line.from + position.column - 1 : null
}
function nextGeneration(): string {
  return `source-locations-${++nextLocationsGeneration}`
}

export function useSourceSymbols(options: UseSourceSymbolsOptions): SourceSymbolsController {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const identityKey = JSON.stringify([
    options.buffer.id,
    options.tabId,
    options.buffer.worktreeId,
    options.buffer.path,
    options.buffer.relativePath,
    options.engineGeneration
  ])
  const previousIdentity = useRef({ key: identityKey, context: options.context })
  const [report, setReportState] = useState<SourceSymbolsReport>(idleReport)
  const reportRef = useRef(report)
  reportRef.current = report
  const [panel, setPanelState] = useState<SourceLocationsPanel | null>(null)
  const panelRef = useRef(panel)
  panelRef.current = panel
  const requestRef = useRef(0)
  const activeRef = useRef<LookupSession | null>(null)
  const retryRef = useRef<LookupSession | null>(null)
  const intentRef = useRef<LookupIntent | null>(null)
  const mountedRef = useRef(true)

  const publishReport = useCallback((next: SourceSymbolsReport) => {
    reportRef.current = next
    if (mountedRef.current) setReportState(next)
  }, [])
  const publishPanel = useCallback((next: SourceLocationsPanel | null) => {
    panelRef.current = next
    if (mountedRef.current) setPanelState(next)
  }, [])

  const settle = useCallback((session: LookupSession, result?: SourceSymbolsResult, error?: Error) => {
    if (session.settled) return
    session.settled = true
    if (session.timer !== undefined) clearTimeout(session.timer)
    session.timer = undefined
    if (error) session.reject(error)
    else session.resolve(result!)
  }, [])

  const cancelActive = useCallback((reason: string | null, clear: boolean) => {
    const session = activeRef.current
    if (session) {
      activeRef.current = null
      requestRef.current++
      if (session.timer !== undefined) clearTimeout(session.timer)
      session.timer = undefined
      if (reason !== null) settle(session, undefined, new Error(reason))
      else if (!session.settled) settle(session, { kind: session.kind, status: 'empty' })
    }
    retryRef.current = null
    if (clear) {
      publishPanel(null)
      publishReport(idleReport())
    }
  }, [publishPanel, publishReport, settle])
  const invalidateIntent = useCallback(() => {
    intentRef.current = null
  }, [])
  const intentIsCurrent = useCallback((intent: LookupIntent): boolean => {
    const current = optionsRef.current
    return mountedRef.current && intentRef.current === intent && current.enabled &&
      current.context === intent.context && current.engineGeneration === intent.engineGeneration &&
      current.buffer.id === intent.bufferId && current.tabId === intent.tabId &&
      current.buffer.worktreeId === intent.worktreeId && current.buffer.path === intent.path &&
      current.buffer.relativePath === intent.relativePath && current.language === intent.language &&
      current.revision.current === intent.revision
  }, [])
  const reserveIntent = useCallback((kind: SourceSymbolsKind, position?: NavigationPosition): string | null => {
    const current = optionsRef.current
    const view = current.getView()
    if (!mountedRef.current || !current.enabled || !current.context || current.engineGeneration === null || !view) return null
    const offset = position === undefined
      ? view.state.selection.main.head
      : validEditorPosition(view.state.doc, position)
    if (offset === null) return null
    const line = view.state.doc.lineAt(offset)
    const capturedPosition = { line: line.number, column: offset - line.from + 1 }
    invalidateIntent()
    cancelActive(LOOKUP_REPLACED_MESSAGE, false)
    requestRef.current++
    const token = newLookupIntent()
    intentRef.current = {
      token,
      kind,
      position: capturedPosition,
      bufferId: current.buffer.id,
      tabId: current.tabId,
      worktreeId: current.buffer.worktreeId,
      path: current.buffer.path,
      relativePath: current.buffer.relativePath,
      engineGeneration: current.engineGeneration,
      revision: current.revision.current,
      language: current.language,
      context: current.context,
      consumed: false
    }
    return token
  }, [cancelActive, invalidateIntent])
  const isIntentCurrent = useCallback((token: string): boolean => {
    const intent = intentRef.current
    return intent !== null && intent.token === token && intentIsCurrent(intent)
  }, [intentIsCurrent])

  useEffect(() => {
    const previous = previousIdentity.current
    if (previous.key === identityKey && previous.context === options.context) return
    previousIdentity.current = { key: identityKey, context: options.context }
    invalidateIntent()
    cancelActive(null, true)
  }, [cancelActive, identityKey, invalidateIntent, options.context])


  const sessionState = useCallback((session: LookupSession): SessionCurrent => {
    if (!mountedRef.current || activeRef.current !== session || requestRef.current !== session.request) return 'replaced'
    const current = optionsRef.current
    if (!current.enabled || !current.context || current.engineGeneration !== session.engineGeneration ||
        current.buffer.id !== session.bufferId || current.tabId !== session.tabId ||
        current.buffer.worktreeId !== session.worktreeId || current.buffer.path !== session.path ||
        current.buffer.relativePath !== session.relativePath) return 'detached'
    if (current.refusal() !== null) return 'refused'
    if (current.revision.current !== session.revision) return 'changed'
    return 'current'
  }, [])

  const panelFor = useCallback((session: LookupSession, state: Omit<SourceLocationsPanel, 'generation' | 'kind' | 'label' | 'position' | 'focusResults'>): SourceLocationsPanel => ({
    generation: nextGeneration(),
    kind: session.kind,
    label: session.label,
    position: { line: session.params.line, column: session.params.column },
    focusResults: session.focusResults,
    ...state
  }), [])

  const showRefusal = useCallback((kind: SourceSymbolsKind, message: string) => {
    publishReport({ status: 'error', kind, count: null, truncated: null, error: reportError(kind, message) })
    publishPanel({
      generation: nextGeneration(), kind, label: '', status: 'error', locations: [], truncated: false,
      error: message, retryable: false, focusResults: false
    })
  }, [publishPanel, publishReport])

  const bridgeFailure = useCallback((token?: string) => {
    const origin = optionsRef.current
    const owner = token !== undefined && intentRef.current?.token === token ? intentRef.current : null
    const explicitIntent = token !== undefined
    const revision = origin.revision.current
    const request = requestRef.current
    const generation = panelRef.current?.generation
    return (message: string, dispatchedIntent?: string) => {
      const current = optionsRef.current
      if (!mountedRef.current || !current.enabled ||
          current.context !== origin.context || current.engineGeneration !== origin.engineGeneration ||
          current.buffer.id !== origin.buffer.id || current.tabId !== origin.tabId ||
          current.buffer.worktreeId !== origin.buffer.worktreeId || current.buffer.path !== origin.buffer.path ||
          current.buffer.relativePath !== origin.buffer.relativePath) return
      if (dispatchedIntent !== undefined) {
        if (owner === null || owner.token !== dispatchedIntent || !intentIsCurrent(owner)) return
      } else if (explicitIntent) {
        if (owner === null || !intentIsCurrent(owner)) return
      } else if (requestRef.current !== request || current.revision.current !== revision ||
          panelRef.current?.generation !== generation) return
      const kind = owner?.kind ?? activeRef.current?.kind ?? reportRef.current.kind ?? 'definition'
      invalidateIntent()
      cancelActive(message, false)
      showRefusal(kind, message)
    }
  }, [cancelActive, intentIsCurrent, invalidateIntent, showRefusal])

  const completeStale = useCallback((session: LookupSession, state: SessionCurrent) => {
    if (activeRef.current === session) {
      activeRef.current = null
      if (session.timer !== undefined) clearTimeout(session.timer)
      session.timer = undefined
    }
    if (state === 'changed' || state === 'detached') {
      publishPanel(null)
      publishReport(idleReport())
    }
    if (state === 'changed') settle(session, undefined, new Error(DOCUMENT_CHANGED_MESSAGE))
    else if (state === 'refused') {
      const message = optionsRef.current.refusal() ?? UNSAVED_SOURCE_SYMBOLS_MESSAGE
      showRefusal(session.kind, message)
      settle(session, undefined, new Error(message))
    } else if (state === 'replaced') settle(session, undefined, new Error(LOOKUP_REPLACED_MESSAGE))
    else settle(session, { kind: session.kind, status: 'empty' })
  }, [publishPanel, publishReport, settle, showRefusal])

  const failSession = useCallback((session: LookupSession, message: string, retryable: boolean) => {
    if (activeRef.current !== session) return
    retryRef.current = retryable ? session : null
    publishReport({ status: 'error', kind: session.kind, count: null, truncated: null, error: reportError(session.kind, message) })
    publishPanel(panelFor(session, {
      status: 'error', locations: [], truncated: false, error: message, retryable
    }))
    settle(session, undefined, new Error(message))
  }, [panelFor, publishPanel, publishReport, settle])

  const openLocation = useCallback(async (session: LookupSession, location: SourceLocation): Promise<void> => {
    const current = optionsRef.current
    const context = current.context
    if (!context) throw new Error(SOURCE_EDITOR_ONLY_MESSAGE)
    if (location.relativePath === null) throw new Error('This location is outside this worktree.')
    if (location.relativePath === session.relativePath) {
      const view = current.getView()
      if (!view) return
      const from = fromNavigationPosition(view.state.doc, location.line, location.column, session.language)
      const to = fromNavigationPosition(view.state.doc, location.endLine, location.endColumn, session.language)
      if (from === null || to === null || to < from) throw new Error('Navigation returned a position outside this file.')
      current.reveal(from, to)
      return
    }

    let identity: unknown
    try {
      identity = await context.call('ui.window.self', {})
    } catch {
      throw new Error(SOURCE_WINDOW_UNKNOWN_MESSAGE)
    }
    const afterIdentity = sessionState(session)
    if (afterIdentity !== 'current') {
      completeStale(session, afterIdentity)
      return
    }
    if (!isRecord(identity) || !Number.isSafeInteger(identity.connId) || typeof identity.connId !== 'number' || identity.connId <= 0) {
      throw new Error(SOURCE_WINDOW_UNKNOWN_MESSAGE)
    }
    const params = sourceOpenParameters(session.worktreeId, location, identity.connId)
    const beforeOpen = sessionState(session)
    if (beforeOpen !== 'current') {
      completeStale(session, beforeOpen)
      return
    }
    await context.call('quirky.editor/open', params)
  }, [completeStale, sessionState])


  const runSession = useCallback(async (session: LookupSession): Promise<void> => {
    let result: NavigationResult
    try {
      const context = optionsRef.current.context
      if (!context) throw new Error(SOURCE_EDITOR_ONLY_MESSAGE)
      const raw = await context.call(`quirky.navigation/${session.kind}`, session.params)
      const state = sessionState(session)
      if (state !== 'current') {
        completeStale(session, state)
        return
      }
      result = validateNavigationResult(raw)
    } catch (reason) {
      const state = sessionState(session)
      if (state !== 'current') {
        completeStale(session, state)
        return
      }
      const prefix = session.kind === 'definition' ? 'Go to Definition failed: ' : 'Find References failed: '
      failSession(session, `${prefix}${messageOf(reason)}`, true)
      return
    }

    if (result.worktreeId !== session.worktreeId) {
      failSession(session, WORKTREE_MISMATCH_MESSAGE, false)
      return
    }
    const refusal = optionsRef.current.refusal()
    if (refusal !== null) {
      showRefusal(session.kind, refusal)
      settle(session, undefined, new Error(refusal))
      return
    }
    const state = sessionState(session)
    if (state !== 'current') {
      completeStale(session, state)
      return
    }

    const location = result.locations[0]
    if (session.kind === 'definition' && result.locations.length === 1 && location.relativePath !== null) {
      try {
        await openLocation(session, location)
      } catch (reason) {
        const message = messageOf(reason)
        const prefixed = message === SOURCE_WINDOW_UNKNOWN_MESSAGE
          ? message
          : `Go to Definition failed: ${message}`
        failSession(session, prefixed, false)
        return
      }
      if (activeRef.current !== session) return
      publishPanel(null)
      publishReport(idleReport())
      settle(session, {
        kind: 'definition', status: 'opened', path: location.relativePath, line: location.line, column: location.column
      })
      return
    }

    const locations = result.locations
    const status = locations.length === 0 ? 'empty' : 'list'
    publishReport({
      status,
      kind: session.kind,
      count: locations.length,
      truncated: result.truncated,
      error: null
    })
    publishPanel(panelFor(session, {
      status,
      locations,
      truncated: result.truncated,
      error: null,
      retryable: false
    }))
    settle(session, locations.length === 0
      ? { kind: session.kind, status: 'empty' }
      : { kind: session.kind, status: 'list', count: locations.length, truncated: result.truncated })
  }, [completeStale, failSession, openLocation, panelFor, publishPanel, publishReport, sessionState, settle, showRefusal])

  const start = useCallback((
    kind: SourceSymbolsKind,
    position?: NavigationPosition,
    label?: string,
    fixedParams?: LookupParams,
    intent?: LookupIntent,
    focusResults = false
  ): Promise<SourceSymbolsResult> => {
    if (intent === undefined) {
      invalidateIntent()
      cancelActive(LOOKUP_REPLACED_MESSAGE, false)
    } else if (!intentIsCurrent(intent)) {
      return Promise.reject(new Error(LOOKUP_REPLACED_MESSAGE))
    }
    const current = optionsRef.current
    if (!current.enabled) return Promise.reject(new Error(UNSUPPORTED_SOURCE_SYMBOLS_MESSAGE))
    if (!current.context) return Promise.reject(new Error(SOURCE_EDITOR_ONLY_MESSAGE))
    const view = current.getView()
    if (current.engineGeneration === null) return Promise.reject(new Error(SOURCE_EDITOR_ONLY_MESSAGE))
    if (!view) return Promise.reject(new Error(SOURCE_EDITOR_ONLY_MESSAGE))
    const refusal = current.refusal()
    if (refusal !== null) {
      showRefusal(kind, refusal)
      return Promise.reject(new Error(refusal))
    }

    let offset: number
    let navParams: LookupParams
    try {
      if (fixedParams) {
        navParams = fixedParams
        const editorOffset = position ? validEditorPosition(view.state.doc, position) : null
        offset = editorOffset ?? view.state.selection.main.head
      } else {
        if (position !== undefined) {
          const editorOffset = validEditorPosition(view.state.doc, position)
          if (editorOffset === null) throw new Error('The source position is outside the document.')
          offset = editorOffset
        } else offset = view.state.selection.main.head
        const navPosition = toNavigationPosition(view.state.doc, offset, current.language)
        navParams = {
          worktree: `id:${current.buffer.worktreeId}`,
          path: current.buffer.relativePath,
          line: navPosition.line,
          column: navPosition.column
        }
      }
    } catch (reason) {
      return Promise.reject(reason instanceof Error ? reason : new Error(messageOf(reason)))
    }

    publishPanel(null)
    const request = ++requestRef.current
    const session: LookupSession = {
      request,
      bufferId: current.buffer.id,
      tabId: current.tabId,
      worktreeId: current.buffer.worktreeId,
      path: current.buffer.path,
      relativePath: current.buffer.relativePath,
      engineGeneration: current.engineGeneration!,
      revision: current.revision.current,
      language: current.language,
      kind,
      label: label ?? current.symbolAt(offset),
      params: navParams,
      focusResults: focusResults || view.hasFocus,
      timer: undefined,
      resolve: () => {},
      reject: () => {},
      settled: false
    }
    activeRef.current = session
    retryRef.current = null
    publishReport({ status: 'pending', kind, count: null, truncated: null, error: null })
    const pendingPanel = () => {
      if (sessionState(session) !== 'current') return
      publishPanel(panelFor(session, {
        status: 'pending', locations: [], truncated: false, error: null, retryable: false
      }))
    }
    if (kind === 'references') pendingPanel()
    else session.timer = setTimeout(pendingPanel, 300)

    const deferred = Promise.withResolvers<SourceSymbolsResult>()
    session.resolve = deferred.resolve
    session.reject = deferred.reject
    void runSession(session)
    return deferred.promise
  }, [cancelActive, intentIsCurrent, invalidateIntent, panelFor, publishPanel, publishReport, runSession, sessionState, showRefusal])

  const definition = useCallback((position?: NavigationPosition, label?: string) => start('definition', position, label), [start])
  const references = useCallback((position?: NavigationPosition, label?: string) => start('references', position, label), [start])

  const control = useCallback((
    action: SourceSymbolsKind,
    position?: NavigationPosition,
    intentOptions?: { intent?: string; focus?: boolean }
  ): boolean => {
    const current = optionsRef.current
    const view = current.getView()
    if (!current.enabled || !view) return false
    if (intentOptions?.intent !== undefined) {
      const intent = intentRef.current
      if (intent === null || intent.token !== intentOptions.intent || intent.consumed ||
          intent.kind !== action || !intentIsCurrent(intent) ||
          position !== undefined && (position.line !== intent.position.line || position.column !== intent.position.column)) return false
      intent.consumed = true
      if (intentOptions.focus) view.focus()
      const promise = start(action, intent.position, undefined, undefined, intent, intentOptions.focus === true)
      void promise.catch(() => {})
      return true
    }
    if (position !== undefined && validEditorPosition(view.state.doc, position) === null) return false
    if (intentOptions?.focus) view.focus()
    const promise = start(action, position)
    void promise.catch(() => {})
    return true
  }, [intentIsCurrent, start])

  const close = useCallback((generation?: string): boolean => {
    const currentPanel = panelRef.current
    if (!currentPanel || generation !== undefined && currentPanel.generation !== generation) return false
    invalidateIntent()
    cancelActive(LOOKUP_CLOSED_MESSAGE, true)
    return true
  }, [cancelActive, invalidateIntent])

  const retry = useCallback((generation: string): boolean => {
    const currentPanel = panelRef.current
    const failed = retryRef.current
    if (!currentPanel || currentPanel.generation !== generation || currentPanel.status !== 'error' ||
        !currentPanel.retryable || !failed) return false
    const current = optionsRef.current
    if (!current.enabled || current.refusal() !== null || current.revision.current !== failed.revision ||
        current.buffer.id !== failed.bufferId || current.tabId !== failed.tabId ||
        current.buffer.worktreeId !== failed.worktreeId || current.buffer.path !== failed.path ||
        current.buffer.relativePath !== failed.relativePath || current.engineGeneration !== failed.engineGeneration) return false
    const promise = start(failed.kind, undefined, failed.label, failed.params)
    void promise.catch(() => {})
    return true
  }, [start])

  const open = useCallback((index: number, generation: string): boolean => {
    const currentPanel = panelRef.current
    const session = activeRef.current
    if (!Number.isSafeInteger(index) || index < 0 || !currentPanel || currentPanel.generation !== generation ||
        currentPanel.status !== 'list' || !session || session.kind !== currentPanel.kind) return false
    const location = currentPanel.locations[index]
    if (!location || location.relativePath === null) return false
    invalidateIntent()
    void (async () => {
      const state = sessionState(session)
      if (state !== 'current') {
        completeStale(session, state)
        return
      }
      try {
        await openLocation(session, location)
        if (activeRef.current !== session) return
        if (session.kind === 'definition') {
          publishPanel(null)
          publishReport(idleReport())
          activeRef.current = null
          requestRef.current++
        }
      } catch (reason) {
        if (activeRef.current !== session) return
        failSession(session, messageOf(reason), false)
      }
    })()
    return true
  }, [completeStale, failSession, invalidateIntent, openLocation, publishPanel, publishReport, sessionState])

  const documentChanged = useCallback(() => {
    invalidateIntent()
    cancelActive(DOCUMENT_CHANGED_MESSAGE, true)
  }, [cancelActive, invalidateIntent])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      invalidateIntent()
      const session = activeRef.current
      if (session) {
        activeRef.current = null
        if (session.timer !== undefined) clearTimeout(session.timer)
        session.timer = undefined
        if (!session.settled) settle(session, { kind: session.kind, status: 'empty' })
      }
    }
  }, [invalidateIntent, settle])

  return {
    report, panel, definition, references, reserveIntent, isIntentCurrent, control, open, close, retry, documentChanged, bridgeFailure
  }
}
