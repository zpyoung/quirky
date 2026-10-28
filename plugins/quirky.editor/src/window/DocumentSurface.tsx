import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FocusEvent as ReactFocusEvent, type ReactNode } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorBufferInfo, EditorSurfaceAction, EditorSurfaceBuffer, EditorSurfaceCommandHandler, EditorSurfaceCommandHandlers, SurfaceProps } from '../types'
import { activeDocument, registerActiveDocument, type ActiveDocumentCommand, type ActiveDocumentRegistration } from './activeDocument'
import { useEditorState, type EditorState } from './editorState'
import { openExplorerSearch } from './explorerIntent'
import { requestSingleClose } from './overlayState'
import { setEditorSetting, useEditorSettings } from './settings'
import { SourceEditor, type SourceEditorHandle } from './SourceEditor'
import { hydrateBuffer, hydrateDiskContent, importFileTransfer, writeDraft } from './transfers'
const MarkdownSurface = lazy(() => import('../markdown/MarkdownSurface').then((module) => ({ default: module.MarkdownSurface })))
const NotebookSurface = lazy(() => import('../notebook/NotebookSurface').then((module) => ({ default: module.NotebookSurface })))
const ViewerSurface = lazy(() => import('../viewers/ViewerSurface').then((module) => ({ default: module.ViewerSurface })))

const EXPLORER_PANEL = 'panel:quirky.editor/explorer'
const MAX_UPLOADS = 256
const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_UPLOAD_METADATA_BYTES = 256 * 1024
const WORKTREE_PATHS_MIME = 'application/x-quirky-worktree-paths'
const BUFFER_METHODS: Record<string, true> = {
  'quirky.editor/draft': true,
  'quirky.editor/save': true,
  'quirky.editor/close': true,
  'quirky.editor/canClose': true,
  'quirky.editor/view': true,
  'quirky.editor/read': true,
  'quirky.editor/markdown': true,
  'quirky.editor/notes': true,
  'quirky.editor/notebook': true,
  'quirky.editor/viewer': true
}
const TAB_METHODS: Record<string, true> = {
  'quirky.editor/view': true,
  'quirky.editor/close': true,
  'quirky.editor/canClose': true
}

type SurfaceMode = 'source' | 'rich' | 'preview'
type DocumentInput = { bufferId: string; tabId: string | null; mode?: SurfaceMode; line?: number; column?: number }
type ImportResult = { path?: string; paths?: string[] }
type InternalPaths = { worktreeId: string; paths: string[] }
type ReadBufferResult = { buffer?: EditorBufferInfo }
type Props = { context: UiPluginContext; input?: unknown }
type BoundaryProps = { children: ReactNode; onRetry(): void }
type BoundaryState = { error: string | null }
type ActiveActions = {
  flush(): Promise<void>
  save(): Promise<void>
  close(): Promise<boolean>
  focus(): void
  runCommand(command: ActiveDocumentCommand, args?: Record<string, unknown>): Promise<unknown>
}

class SurfaceErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error: error.message }
  }

  componentDidCatch(error: Error): void {
    this.setState({ error: error.message })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="qe-surface-failure" role="alert">
          <p>The document surface could not be loaded: {this.state.error}</p>
          <button type="button" onClick={() => { this.setState({ error: null }); this.props.onRetry() }}>Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}

function documentInput(value: unknown): DocumentInput | null {
  if (typeof value !== 'object' || value === null || !('bufferId' in value) || typeof value.bufferId !== 'string' || value.bufferId === '') return null
  const tabId = 'tabId' in value && typeof value.tabId === 'string' ? value.tabId : null
  const modeValue = 'mode' in value ? value.mode : undefined
  const mode = modeValue === 'source' || modeValue === 'rich' || modeValue === 'preview' ? modeValue : undefined
  const line = 'line' in value && typeof value.line === 'number' ? value.line : undefined
  const column = 'column' in value && typeof value.column === 'number' ? value.column : undefined
  return { bufferId: value.bufferId, tabId, mode, line, column }
}

function internalPaths(value: unknown): InternalPaths | null {
  if (typeof value !== 'object' || value === null || !('worktreeId' in value) || !('paths' in value)) return null
  const worktreeId = value.worktreeId
  const paths = value.paths
  if (typeof worktreeId !== 'string' || !Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) return null
  return { worktreeId, paths }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function sizeOfName(name: string): number {
  return new TextEncoder().encode(name).byteLength
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash)
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}
function mergeSurfaceBuffer(
  current: EditorSurfaceBuffer,
  info: EditorBufferInfo,
  text: { content: string; draft: string | null; diskContent?: string | null }
): EditorSurfaceBuffer {
  const merged = { ...current, ...info, content: text.content, draft: text.draft }
  if ('diskContent' in text) {
    merged.diskContent = text.diskContent
  } else if (info.diskContent !== undefined) {
    merged.diskContent = info.diskContent
  } else if (info.diskContentLength === null) {
    merged.diskContent = null
  } else if (info.diskSignature === current.diskSignature && current.diskContent !== undefined) {
    merged.diskContent = current.diskContent
  } else {
    delete merged.diskContent
  }
  return merged
}


async function uploadFiles(context: UiPluginContext, worktree: string, destination: string, files: File[]): Promise<string[]> {
  if (files.length === 0) return []
  if (files.length > MAX_UPLOADS) throw new Error(`Import is limited to ${MAX_UPLOADS} files.`)
  let totalBytes = 0
  let metadataBytes = 0
  for (const file of files) {
    if (file.size > MAX_UPLOAD_FILE_BYTES) throw new Error(`${file.name} exceeds the 50 MiB per-file import limit.`)
    totalBytes += file.size
    metadataBytes += sizeOfName(file.name)
    if (totalBytes > MAX_UPLOAD_BYTES) throw new Error('Import exceeds the 50 MiB aggregate byte limit.')
    if (metadataBytes > MAX_UPLOAD_METADATA_BYTES) throw new Error('Import file names exceed the 256 KiB metadata limit.')
    if (file.name.includes('/') || file.name.includes('\\\\') || file.name === '.' || file.name === '..') throw new Error(`Unsafe import file name: ${file.name}`)
  }
  const imported: string[] = []
  for (const file of files) {
    const result = await importFileTransfer(context, worktree, destination || '.', file)
    if (result.paths?.length) imported.push(...result.paths)
    else if (result.path) imported.push(result.path)
  }
  return imported
}

async function importDroppedUris(context: UiPluginContext, worktree: string, directory: string, uriList: string): Promise<string[]> {
  const paths = uriList.split(/\r?\n/).filter((line) => line !== '' && !line.startsWith('#')).map((line) => {
    const url = new URL(line)
    if (url.protocol !== 'file:') throw new Error(`Unsupported dropped URL: ${line}`)
    return decodeURIComponent(url.pathname)
  })
  if (paths.length > MAX_UPLOADS) throw new Error(`Import is limited to ${MAX_UPLOADS} files.`)
  const metadataBytes = paths.reduce((total, path) => total + sizeOfName(path), 0)
  if (metadataBytes > MAX_UPLOAD_METADATA_BYTES) throw new Error('Dropped path names exceed the 256 KiB metadata limit.')
  const result = await context.call('quirky.editor/mutate', {
    worktree,
    action: 'import',
    path: directory || '.',
    sourcePaths: paths
  }) as ImportResult
  const imported = result.paths ?? (result.path ? [result.path] : [])
  if (imported.length === 0) throw new Error('The dropped files could not be imported.')
  return imported
}

/** One session-free hosted document view inside the terminal workspace. */
export function DocumentSurface({ context, input }: Props) {
  const parsed = documentInput(input)
  if (!parsed) return <div className="qe-document-message" role="alert">The document tab has no buffer ID.</div>
  return <DocumentBody key={`${parsed.bufferId}:${parsed.tabId ?? ''}`} context={context} input={parsed} />
}

function DocumentBody({ context, input }: { context: UiPluginContext; input: DocumentInput }) {
  const { state, error: stateError, refresh } = useEditorState(context, { bufferId: input.bufferId })
  const info = state?.buffers.find((entry) => entry.id === input.bufferId)
  const [buffer, setBuffer] = useState<EditorSurfaceBuffer | null>(null)
  const bufferRef = useRef<EditorSurfaceBuffer | null>(null)
  bufferRef.current = buffer
  const [hydrateError, setHydrateError] = useState<string | null>(null)
  const { settings, error: settingsError } = useEditorSettings(context)
  const [uiError, setUiError] = useState<string | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [draftConflict, setDraftConflict] = useState<string | null>(null)
  const [localText, setLocalText] = useState<string | null>(null)
  const localTextRef = useRef<string | null>(null)
  const [editorGeneration, setEditorGeneration] = useState(0)
  const [compareOpen, setCompareOpen] = useState(false)
  const [undoReloadUntil, setUndoReloadUntil] = useState(0)
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const sourceRef = useRef<SourceEditorHandle>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeRegistration = useRef<ActiveDocumentRegistration | null>(null)
  const editorHasFocus = useRef(false)
  const surfaceCommandHandlers = useRef(new Map<symbol, EditorSurfaceCommandHandlers>())
  const registerCommandHandlers = useCallback((handlers: EditorSurfaceCommandHandlers) => {
    const token = Symbol('editor-surface-command-handlers')
    surfaceCommandHandlers.current.set(token, handlers)
    return () => surfaceCommandHandlers.current.delete(token)
  }, [])
  const flushSurfaceEditors = useCallback(async () => {
    let flushHandler: EditorSurfaceCommandHandlers['flush']
    for (const handlers of surfaceCommandHandlers.current.values()) flushHandler = handlers.flush ?? flushHandler
    await flushHandler?.()
  }, [])
  const draftQueue = useRef<Promise<void>>(Promise.resolve())
  const ackRevision = useRef(info?.contentRevision ?? 0)
  const pendingDrafts = useRef(new Set<string>())
  const blockedDraft = useRef(false)
  const undoReloadTimer = useRef<number | undefined>(undefined)
  const activeActions = useRef<ActiveActions>({
    flush: async () => {},
    save: async () => {},
    close: async () => false,
    focus: () => { throw new Error('The editor surface is not ready.') },
    runCommand: async () => { throw new Error('The editor surface is not ready.') }
  })

  useEffect(() => {
    if (!info) {
      if (state) setBuffer(null)
      return
    }
    const current = bufferRef.current
    if (current && current.id === info.id && current.contentRevision === info.contentRevision) {
      const merged = { ...current, ...info, content: current.content, draft: current.draft }
      if (current.revision !== info.revision || current.external !== info.external || current.diskContent !== info.diskContent) setBuffer(merged)
      setHydrateError(null)
      return
    }
    let cancelled = false
    setHydrateError(null)
    void hydrateBuffer(context, info).then((hydrated) => {
      if (cancelled) return
      const latest = bufferRef.current
      if (latest && latest.id === hydrated.id && latest.contentRevision > hydrated.contentRevision) return
      setBuffer(hydrated)
    }).catch((reason: unknown) => {
      if (!cancelled) setHydrateError(messageOf(reason))
    })
    return () => { cancelled = true }
  }, [context, info, state])

  useEffect(() => {
    if (!buffer) return
    if (localTextRef.current === null) {
      ackRevision.current = buffer.contentRevision
      if (buffer.draft !== null) {
        localTextRef.current = buffer.draft
        setLocalText(buffer.draft)
      }
      return
    }
    if (buffer.draft !== null && pendingDrafts.current.has(buffer.draft)) {
      ackRevision.current = buffer.contentRevision
      if (buffer.draft === localTextRef.current) setDraftConflict(null)
      return
    }
    if (buffer.draft === localTextRef.current) {
      ackRevision.current = buffer.contentRevision
      setDraftConflict(null)
      blockedDraft.current = false
      return
    }
    if (buffer.contentRevision === ackRevision.current) return
    if (buffer.draft === null && buffer.content === localTextRef.current) {
      ackRevision.current = buffer.contentRevision
      localTextRef.current = null
      setLocalText(null)
      pendingDrafts.current.clear()
      blockedDraft.current = false
      setDraftConflict(null)
      return
    }
    blockedDraft.current = true
    setDraftConflict('A newer shared draft arrived. Your local text is preserved for comparison.')
  }, [buffer?.content, buffer?.contentRevision, buffer?.draft])

  useEffect(() => () => {
    if (undoReloadTimer.current !== undefined) window.clearTimeout(undoReloadTimer.current)
  }, [])
  const flushDrafts = useCallback(async () => {
    await draftQueue.current
    if (blockedDraft.current) throw new Error(draftConflict ?? 'Your local draft conflicts with a newer shared version.')
  }, [draftConflict])
  const flushActiveDocument = useCallback(async () => {
    await flushSurfaceEditors()
    await flushDrafts()
  }, [flushDrafts, flushSurfaceEditors])

  const submitDraft = useCallback((content: string) => {
    localTextRef.current = content
    setLocalText(content)
    pendingDrafts.current.add(content)
    draftQueue.current = draftQueue.current.then(async () => {
      if (blockedDraft.current) return
      try {
        const updated = await writeDraft(context, input.bufferId, content, ackRevision.current)
        pendingDrafts.current.delete(content)
        ackRevision.current = updated.contentRevision
        if (localTextRef.current === content) setDraftConflict(null)
        const current = bufferRef.current
        if (current) setBuffer(mergeSurfaceBuffer(current, updated, { content: current.content, draft: content }))
        refresh()
      } catch (reason) {
        pendingDrafts.current.clear()
        blockedDraft.current = true
        setDraftConflict(messageOf(reason))
        refresh()
      }
    })
  }, [context, input.bufferId, refresh])

  const writeLocalDraftAtLatest = useCallback(async (content: string) => {
    const result = await context.call('quirky.editor/read', { bufferId: input.bufferId, action: 'buffer' }) as ReadBufferResult
    if (!result.buffer) throw new Error('The latest shared buffer could not be read.')
    const updated = await writeDraft(context, input.bufferId, content, result.buffer.contentRevision)
    ackRevision.current = updated.contentRevision
    pendingDrafts.current.clear()
    blockedDraft.current = false
    localTextRef.current = content
    setLocalText(content)
    setDraftConflict(null)
    const current = bufferRef.current
    if (current) setBuffer(mergeSurfaceBuffer(current, updated, { content: current.content, draft: content }))
  }, [context, input.bufferId])

  const save = useCallback(async (trigger: 'user' | 'overwrite' = 'user') => {
    await flushSurfaceEditors()
    if (trigger === 'overwrite') {
      await draftQueue.current
      const currentText = localTextRef.current
      if (currentText !== null && blockedDraft.current) await writeLocalDraftAtLatest(currentText)
    } else {
      await flushDrafts()
    }
    const snapshot = localTextRef.current
    const saved = await context.call('quirky.editor/save', { bufferId: input.bufferId, trigger }) as EditorBufferInfo
    ackRevision.current = saved.contentRevision
    const current = bufferRef.current
    if (current) {
      const content = typeof saved.content === 'string' ? saved.content : snapshot ?? current.draft ?? current.content
      const draft = saved.draftLength === null ? null : typeof saved.draft === 'string' ? saved.draft : current.draft
      const stableText = localTextRef.current === snapshot
      setBuffer(mergeSurfaceBuffer(current, saved, { content, draft: stableText ? draft : current.draft }))
    }
    if (localTextRef.current === snapshot && saved.draftLength === null) {
      localTextRef.current = null
      setLocalText(null)
      blockedDraft.current = false
      pendingDrafts.current.clear()
      setDraftConflict(null)
    }
    setUiError(null)
    refresh()
  }, [context, flushDrafts, flushSurfaceEditors, input.bufferId, refresh, writeLocalDraftAtLatest])
  const runViewAction = useCallback(async (action: 'reload' | 'keep' | 'undoReload' | 'compare' | 'promote' | 'pin' | 'reveal', patch?: Record<string, unknown>) => {
    if (action === 'keep') {
      await draftQueue.current
      const keepContent = localTextRef.current ?? bufferRef.current?.draft ?? bufferRef.current?.content
      if (keepContent !== undefined && blockedDraft.current) await writeLocalDraftAtLatest(keepContent)
    } else if (action === 'reload' || action === 'undoReload') {
      await draftQueue.current
    }
    const updated = await context.call('quirky.editor/view', {
      bufferId: input.bufferId,
      action,
      ...(input.tabId ? { tabId: input.tabId } : {}),
      ...(patch ? { patch } : {})
    }) as EditorBufferInfo
    const comparedDiskContent = action === 'compare' && updated.external ? await hydrateDiskContent(context, updated) : undefined
    if (action === 'reload') {
      if (undoReloadTimer.current !== undefined) window.clearTimeout(undoReloadTimer.current)
      if (bufferRef.current && bufferRef.current.draft !== null) {
        setUndoReloadUntil(Date.now() + 8000)
        undoReloadTimer.current = window.setTimeout(() => {
          undoReloadTimer.current = undefined
          setUndoReloadUntil(0)
        }, 8000)
      }
      localTextRef.current = null
      setLocalText(null)
      setBuffer(null)
      blockedDraft.current = false
      pendingDrafts.current.clear()
      setDraftConflict(null)
      setEditorGeneration((value) => value + 1)
    } else if (action === 'undoReload') {
      if (undoReloadTimer.current !== undefined) window.clearTimeout(undoReloadTimer.current)
      undoReloadTimer.current = undefined
      setUndoReloadUntil(0)
      localTextRef.current = typeof updated.draft === 'string' ? updated.draft : null
      setLocalText(localTextRef.current)
      setBuffer(null)
      blockedDraft.current = false
      pendingDrafts.current.clear()
      setDraftConflict(null)
      setEditorGeneration((value) => value + 1)
    } else if (action === 'keep') {
      ackRevision.current = updated.contentRevision
      blockedDraft.current = false
      setDraftConflict(null)
      const current = bufferRef.current
      if (current) setBuffer(mergeSurfaceBuffer(current, updated, { content: current.content, draft: localTextRef.current ?? current.draft }))
    } else {
      const current = bufferRef.current
      if (current) {
        setBuffer(mergeSurfaceBuffer(current, updated, {
          content: current.content,
          draft: current.draft,
          ...(comparedDiskContent === undefined ? {} : { diskContent: comparedDiskContent })
        }))
      }
    }
    if (action === 'compare') setCompareOpen(true)
    setUiError(null)
    refresh()
    return updated
  }, [context, input.bufferId, input.tabId, refresh, writeLocalDraftAtLatest])

  const updateView = useCallback((patch: Record<string, unknown>) => {
    const tabId = input.tabId ?? bufferRef.current?.tabId
    void context.call('quirky.editor/view', { bufferId: input.bufferId, action: 'update', ...(tabId ? { tabId } : {}), patch }).catch((reason: unknown) => setUiError(messageOf(reason)))
  }, [context, input.bufferId, input.tabId])
  const actualTabId = input.tabId ?? buffer?.tabId ?? null
  const actualMode = input.mode ?? buffer?.mode ?? 'source'

  const onAction = useCallback((method: string, params: Record<string, unknown>) => {
    const needsBuffer = BUFFER_METHODS[method] === true && params.bufferId === undefined
    const needsTab = TAB_METHODS[method] === true && params.tabId === undefined && actualTabId !== null
    if (!needsBuffer && !needsTab) return context.call(method, params)
    const request = { ...params }
    if (needsBuffer) request.bufferId = input.bufferId
    if (needsTab) request.tabId = actualTabId
    return context.call(method, request)
  }, [context, input.bufferId, actualTabId])

  const featureProps = useMemo<SurfaceProps | null>(() => {
    if (!buffer) return null
    const tabViews = buffer.view.byTabId
    const tabView = actualTabId && tabViews && typeof tabViews === 'object' && !Array.isArray(tabViews)
      ? (tabViews as Record<string, unknown>)[actualTabId]
      : undefined
    const view = tabView && typeof tabView === 'object' && !Array.isArray(tabView)
      ? { ...buffer.view, ...tabView as Record<string, unknown> }
      : buffer.view
    const surfaceBuffer = buffer.mode === actualMode && view === buffer.view
      ? buffer
      : { ...buffer, mode: actualMode, view }
    return {
      context,
      buffer: surfaceBuffer,
      fontSize: Math.max(8, Math.min(32, 13 + settings.fontZoomLevel)),
      onDraft: submitDraft,
      onAction,
      onView: updateView,
      registerCommandHandlers
    }
  }, [actualMode, actualTabId, buffer, context, onAction, registerCommandHandlers, settings.fontZoomLevel, submitDraft, updateView])

  const reveal = input.line === undefined ? undefined : { line: input.line, column: input.column }
  const fontSize = Math.max(8, Math.min(32, 13 + settings.fontZoomLevel))
  const runDocumentCommand = async (command: ActiveDocumentCommand, args?: Record<string, unknown>): Promise<unknown> => {
    if (!buffer) throw new Error('There is no mounted editor document.')
    if (command === 'markdown-preview') {
      if (buffer.kind !== 'markdown') throw new Error('Markdown Preview is available only for Markdown documents.')
      await activeActions.current.flush()
      const opened = await context.call('quirky.editor/open', {
        worktree: buffer.worktreeId,
        path: buffer.relativePath,
        mode: 'preview',
        preview: false,
        focus: true
      }) as { openedTabId?: string }
      return { opened: true, bufferId: buffer.id, tabId: opened.openedTabId ?? null }
    }
    if (command === 'toggle-word-wrap') {
      if (!sourceRef.current) throw new Error('Word Wrap is available only in source-editor mode.')
      const wordWrap = !settings.wordWrap
      await setEditorSetting(context, 'editorWordWrap', wordWrap)
      return { wordWrap }
    }

    const surfaceAction: EditorSurfaceAction | null =
      command === 'find' || command === 'replace' || command === 'copy-context' ||
      command === 'add-review-note' || command === 'zoom-in' || command === 'zoom-out' || command === 'reset-zoom'
        ? command
        : null
    if (surfaceAction) {
      let handler: EditorSurfaceCommandHandler | undefined
      for (const handlers of surfaceCommandHandlers.current.values()) {
        handler = handlers[surfaceAction] ?? handler
      }
      if (handler) return await handler(args)
    }
    if (sourceRef.current) {
      if (command === 'find') return sourceRef.current.find(typeof args?.query === 'string' ? args.query : undefined)
      if (command === 'replace') return sourceRef.current.replace(typeof args?.query === 'string' ? args.query : undefined)
      if (command === 'copy-context') return sourceRef.current.copyContext()
    }

    if (command === 'zoom-in' || command === 'zoom-out' || command === 'reset-zoom') {
      if (buffer.kind === 'image' || buffer.kind === 'pdf' || buffer.kind === 'audio' || buffer.kind === 'video' || buffer.kind === 'binary') {
        throw new Error(`Zoom is not supported by the ${buffer.kind} viewer in its current state.`)
      }
      const fontZoomLevel = command === 'zoom-in'
        ? Math.min(18, settings.fontZoomLevel + 1)
        : command === 'zoom-out'
          ? Math.max(-6, settings.fontZoomLevel - 1)
          : 0
      await setEditorSetting(context, 'editorFontZoomLevel', fontZoomLevel)
      return { fontZoomLevel, fontSize: Math.max(8, Math.min(32, 13 + fontZoomLevel)) }
    }
    throw new Error(`${command} is not supported by the ${buffer.kind} ${actualMode} editor surface.`)
  }

  activeActions.current = {
    flush: flushActiveDocument,
    save: () => save('user'),
    close: () => requestSingleClose(context, input.bufferId, actualTabId ?? undefined),
    focus: () => {
      if (sourceRef.current) sourceRef.current.focus()
      else if (rootRef.current) rootRef.current.focus()
      else throw new Error('The editor surface is not mounted.')
    },
    runCommand: runDocumentCommand
  }

  useEffect(() => {
    if (!buffer) return
    const registration = registerActiveDocument({
      bufferId: buffer.id,
      tabId: actualTabId,
      worktreeId: buffer.worktreeId,
      path: buffer.path,
      mode: actualMode,
      kind: buffer.kind,
      flush: () => activeActions.current.flush(),
      save: () => activeActions.current.save(),
      close: () => activeActions.current.close(),
      focus: () => activeActions.current.focus(),
      runCommand: (command, args) => activeActions.current.runCommand(command, args)
    })
    activeRegistration.current = registration
    const hostedView = rootRef.current?.closest<HTMLElement>('.qt-hosted-view')
    const group = rootRef.current?.closest<HTMLElement>('.qt-group')
    const clearEditorFocus = () => {
      if (!editorHasFocus.current) return
      editorHasFocus.current = false
      context.setContext('editorFocus', undefined)
      context.setContext('editorWorkspaceFocus', undefined)
    }
    const updateGroupFocus = () => {
      if (group?.classList.contains('qt-active') && actualTabId !== null && hostedView?.dataset.hostedView === actualTabId) {
        registration.focus()
      } else {
        registration.blur()
        clearEditorFocus()
      }
    }
    updateGroupFocus()
    const observer = group ? new MutationObserver(updateGroupFocus) : undefined
    if (group) observer?.observe(group, { attributes: true, attributeFilter: ['class'] })
    return () => {
      observer?.disconnect()
      registration.unregister()
      if (activeRegistration.current === registration) activeRegistration.current = null
      clearEditorFocus()
    }
  }, [actualTabId, buffer?.id, context])

  useEffect(() => {
    if (!buffer) return
    activeRegistration.current?.update({
      bufferId: buffer.id,
      tabId: actualTabId,
      worktreeId: buffer.worktreeId,
      path: buffer.path,
      mode: actualMode,
      kind: buffer.kind,
      flush: () => activeActions.current.flush(),
      save: () => activeActions.current.save(),
      close: () => activeActions.current.close(),
      focus: () => activeActions.current.focus(),
      runCommand: (command, args) => activeActions.current.runCommand(command, args)
    })
  }, [actualMode, actualTabId, buffer?.id, buffer?.kind, buffer?.path, buffer?.worktreeId])

  const activateSurface = () => activeRegistration.current?.focus()
  const focusEditor = () => {
    activeRegistration.current?.focus()
    editorHasFocus.current = true
    context.setContext('editorFocus', true)
    context.setContext('editorWorkspaceFocus', true)
  }
  const blurEditor = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    if (!editorHasFocus.current) return
    editorHasFocus.current = false
    context.setContext('editorFocus', undefined)
    context.setContext('editorWorkspaceFocus', undefined)
  }

  const handleError = (reason: unknown) => {
    const message = messageOf(reason)
    setUiError(message)
    context.toast('Editor action failed', message)
  }

  const copyPath = async (relative: boolean) => {
    if (!buffer) return
    try {
      await navigator.clipboard.writeText(relative ? buffer.relativePath : buffer.path)
      context.toast('Path copied', relative ? buffer.relativePath : buffer.path)
    } catch (reason) {
      handleError(reason)
    }
  }

  const openMode = async (mode: SurfaceMode) => {
    if (!buffer) return
    try {
      if (mode === 'preview' && buffer.kind === 'markdown') {
        await context.call('quirky.editor/open', {
          worktree: buffer.worktreeId,
          path: buffer.relativePath,
          mode: 'preview',
          preview: false,
          focus: true
        })
      } else {
        const updated = await context.call('quirky.editor/view', {
          bufferId: buffer.id,
          action: 'update',
          patch: { mode }
        }) as EditorBufferInfo
        const current = bufferRef.current
        if (current) setBuffer(mergeSurfaceBuffer(current, updated, { content: current.content, draft: current.draft }))
      }
      setUiError(null)
    } catch (reason) {
      handleError(reason)
    }
  }

  const pin = async () => {
    try {
      await runViewAction('pin')
    } catch (reason) {
      handleError(reason)
    }
  }

  const revealInExplorer = async () => {
    if (!buffer) return
    try {
      await context.call('quirky.editor/explorer', { worktree: buffer.worktreeId, action: 'reveal', path: buffer.relativePath })
      context.togglePanel(EXPLORER_PANEL, true)
    } catch (reason) {
      handleError(reason)
    }
  }

  const searchInFiles = async (query: string) => {
    if (!buffer) return
    openExplorerSearch(buffer.worktreeId, query)
    context.togglePanel(EXPLORER_PANEL, true)
  }

  const saveSetting = async (name: string, value: boolean | number | string) => {
    try {
      await setEditorSetting(context, name, value)
      setUiError(null)
    } catch (reason) {
      handleError(reason)
    }
  }

  const renameFile = async () => {
    if (!buffer || !renamePath?.trim()) return
    try {
      await context.call('quirky.editor/mutate', {
        worktree: buffer.worktreeId,
        action: 'rename',
        path: buffer.relativePath,
        newPath: renamePath.trim()
      })
      setRenamePath(null)
      refresh()
    } catch (reason) {
      handleError(reason)
    }
  }

  const duplicateFile = async () => {
    if (!buffer) return
    try {
      const result = await context.call('quirky.editor/mutate', { worktree: buffer.worktreeId, action: 'duplicate', path: buffer.relativePath }) as { path: string }
      await context.call('quirky.editor/open', { worktree: buffer.worktreeId, path: result.path, focus: true, preview: false })
      refresh()
    } catch (reason) {
      handleError(reason)
    }
  }

  const deleteFile = async () => {
    if (!buffer) return
    const confirmed = await context.confirm({ title: `Delete ${buffer.name}?`, body: 'The file will be moved to Trash when supported by this workspace.' })
    if (!confirmed) return
    try {
      await context.call('quirky.editor/mutate', { worktree: buffer.worktreeId, action: 'delete', path: buffer.relativePath, yes: true })
      refresh()
    } catch (reason) {
      handleError(reason)
    }
  }

  const sourceControl = async () => {
    try {
      await context.executeCommand('command:quirky.editor/source-control')
    } catch (reason) {
      handleError(reason)
    }
  }

  const handleDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    if (!buffer) return
    const custom = event.dataTransfer.getData(WORKTREE_PATHS_MIME)
    if (custom) {
      event.preventDefault()
      const payload = internalPaths(JSON.parse(custom))
      if (!payload) throw new Error('The dropped worktree path data is malformed.')
      if (payload.worktreeId !== buffer.worktreeId) throw new Error('Open files from the same worktree as the document tab.')
      for (const path of payload.paths) await context.call('quirky.editor/open', { worktree: buffer.worktreeId, path, focus: true, preview: false })
      setUiError(null)
      return
    }
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) {
      event.preventDefault()
      const imported = await uploadFiles(context, buffer.worktreeId, parentDirectory(buffer.relativePath), files)
      for (let index = 0; index < imported.length; index++) {
        await context.call('quirky.editor/open', { worktree: buffer.worktreeId, path: imported[index], focus: index === imported.length - 1, preview: false })
      }
      setUiError(null)
      return
    }
    const uriList = event.dataTransfer.getData('text/uri-list')
    if (uriList) {
      event.preventDefault()
      const imported = await importDroppedUris(context, buffer.worktreeId, parentDirectory(buffer.relativePath), uriList)
      for (let index = 0; index < imported.length; index++) {
        await context.call('quirky.editor/open', { worktree: buffer.worktreeId, path: imported[index], focus: index === imported.length - 1, preview: false })
      }
      setUiError(null)
    }
  }

  if (!buffer) {
    if (stateError) return <div className="qe-document-message" role="alert"><p>{stateError}</p><button type="button" onClick={refresh}>Retry</button></div>
    return <div className="qe-document-message" role="status">Loading document…</div>
  }

  const external = buffer.external
  const isMarkdown = buffer.kind === 'markdown'
  const isNotebook = buffer.kind === 'notebook'
  const mediaKind = buffer.kind === 'image' || buffer.kind === 'pdf' || buffer.kind === 'audio' || buffer.kind === 'video' || buffer.kind === 'binary'
  const viewerKind = mediaKind || (buffer.kind === 'mermaid' && actualMode !== 'source') || (buffer.kind === 'csv' && actualMode !== 'source')
  const showSource = !mediaKind && (actualMode === 'source' || (!isMarkdown && !isNotebook && buffer.kind !== 'csv' && buffer.kind !== 'mermaid'))
  const showMarkdown = isMarkdown && actualMode !== 'source'
  const showNotebook = isNotebook && actualMode !== 'source'
  const showViewer = viewerKind
  const surfaceProps = featureProps
  const saveButton = () => void save('user').catch(handleError)
  const closeButton = () => void requestSingleClose(context, buffer.id, actualTabId ?? undefined)
  const changeWrap = (value: boolean) => void saveSetting('editorWordWrap', value)
  const pathTitle = buffer.relativePath || buffer.name

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="qe-document-surface"
      onPointerDownCapture={activateSurface}
      onFocusCapture={focusEditor}
      onBlurCapture={blurEditor}
      onDragOver={(event) => {
        const types = event.dataTransfer.types
        if (types.includes(WORKTREE_PATHS_MIME) || types.includes('Files') || types.includes('text/uri-list')) event.preventDefault()
      }}
      onDrop={(event) => { event.preventDefault(); void handleDrop(event).catch(handleError) }}
    >
      <header className="qe-document-header">
        <div className="qe-document-path-group">
          <button type="button" className="qe-document-path" title={buffer.path} onClick={() => void copyPath(false)}>{pathTitle}</button>
          {buffer.dirty && <span className="qe-dirty-indicator" aria-label="Unsaved changes">●</span>}
          {buffer.external && <span className="qe-external-indicator">{buffer.external === 'deleted' ? 'Deleted on disk' : 'Changed on disk'}</span>}
        </div>
        <div className="qe-document-actions">
          {buffer.kind === 'markdown' && (
            <div className="qe-mode-switch" aria-label="Markdown view mode">
              <button type="button" aria-pressed={actualMode === 'source'} onClick={() => void openMode('source')}>Source</button>
              <button type="button" aria-pressed={actualMode === 'rich'} onClick={() => void openMode('rich')}>Rich Editor</button>
              <button type="button" aria-pressed={actualMode === 'preview'} onClick={() => void openMode('preview')}>Preview</button>
            </div>
          )}
          {isNotebook && (
            <div className="qe-mode-switch" aria-label="Notebook view mode">
              <button type="button" aria-pressed={actualMode === 'source'} onClick={() => void openMode('source')}>Source</button>
              <button type="button" aria-pressed={actualMode !== 'source'} onClick={() => void openMode('rich')}>Notebook</button>
            </div>
          )}
          {buffer.kind === 'csv' && (
            <div className="qe-mode-switch" aria-label="Table view mode">
              <button type="button" aria-pressed={actualMode === 'source'} onClick={() => void openMode('source')}>Source</button>
              <button type="button" aria-pressed={actualMode !== 'source'} onClick={() => void openMode('rich')}>Table</button>
            </div>
          )}
          {buffer.kind === 'mermaid' && (
            <div className="qe-mode-switch" aria-label="Diagram view mode">
              <button type="button" aria-pressed={actualMode === 'source'} onClick={() => void openMode('source')}>Source</button>
              <button type="button" aria-pressed={actualMode !== 'source'} onClick={() => void openMode('rich')}>Preview</button>
            </div>
          )}
          {!buffer.readOnly && <button type="button" onClick={saveButton} disabled={!buffer.dirty && !buffer.external}>Save</button>}
          <button type="button" onClick={() => void pin()} aria-pressed={buffer.pinned} title={buffer.pinned ? 'Unpin tab' : 'Pin tab'}>{buffer.pinned ? 'Unpin' : 'Pin'}</button>
          <button type="button" onClick={() => context.togglePanel(EXPLORER_PANEL, true)}>Explorer</button>
          <button type="button" onClick={() => void sourceControl()}>Source Control</button>
          <button type="button" aria-label="Close tab" onClick={closeButton}>×</button>
          <div className="qe-zoom-controls" aria-label="Editor font size">
            <button type="button" aria-label="Zoom out" onClick={() => void saveSetting('editorFontZoomLevel', Math.max(-6, settings.fontZoomLevel - 1))}>−</button>
            <span>{fontSize}px</span>
            <button type="button" aria-label="Zoom in" onClick={() => void saveSetting('editorFontZoomLevel', Math.min(18, settings.fontZoomLevel + 1))}>+</button>
            <button type="button" aria-label="Reset zoom" onClick={() => void saveSetting('editorFontZoomLevel', 0)}>Reset</button>
          </div>
          <details className="qe-file-actions">
            <summary>File actions</summary>
            <div className="qe-file-actions-menu">
              <button type="button" onClick={() => void copyPath(false)}>Copy Path</button>
              <button type="button" onClick={() => void copyPath(true)}>Copy Relative Path</button>
              <button type="button" onClick={() => void revealInExplorer()}>Reveal in Explorer</button>
              <button type="button" onClick={() => setRenamePath(buffer.relativePath)}>Rename…</button>
              <button type="button" onClick={() => void duplicateFile()}>Duplicate</button>
              <button type="button" onClick={() => void deleteFile()}>Delete</button>
              {buffer.kind === 'markdown' && <button type="button" onClick={() => void openMode('preview')}>Open Markdown Preview</button>}
              <label><input type="checkbox" checked={settings.wordWrap} onChange={(event) => changeWrap(event.currentTarget.checked)} />Word Wrap</label>
              <label><input type="checkbox" checked={settings.minimap} onChange={(event) => void saveSetting('editorMinimapEnabled', event.currentTarget.checked)} />Show Minimap</label>
              <label><input type="checkbox" checked={settings.autoSave} onChange={(event) => void saveSetting('editorAutoSave', event.currentTarget.checked)} />Auto Save Files</label>
              <label className="qe-range-setting">Auto Save Delay
                <input type="range" min="250" max="10000" step="250" value={settings.autoSaveDelay} onChange={(event) => void saveSetting('editorAutoSaveDelayMs', Number(event.currentTarget.value))} />
                <span>{settings.autoSaveDelay} ms</span>
              </label>
              <label><input type="checkbox" checked={settings.previewTabs} onChange={(event) => void saveSetting('editorPreviewTabsEnabled', event.currentTarget.checked)} />Reuse preview tab</label>
            </div>
          </details>
        </div>
      </header>
      {renamePath !== null && (
        <div className="qe-inline-rename">
          <label>Rename to <input autoFocus value={renamePath} onChange={(event) => setRenamePath(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); void renameFile() }
            if (event.key === 'Escape') setRenamePath(null)
          }} /></label>
          <button type="button" onClick={() => void renameFile()}>Apply</button>
          <button type="button" onClick={() => setRenamePath(null)}>Cancel</button>
        </div>
      )}
      {external && (
        <section className="qe-external-change-banner" role="status">
          <span>{external === 'deleted' ? 'This file was deleted on disk. An explicit save can recreate it.' : 'This file changed on disk while you have unsaved edits. Overwrite replaces the newer disk content.'}</span>
          <button type="button" onClick={() => void runViewAction('compare').catch(handleError)}>Compare</button>
          <button type="button" onClick={() => void runViewAction('reload').catch(handleError)}>Reload from Disk</button>
          {buffer.dirty && <button type="button" onClick={() => void save('overwrite').catch(handleError)}>Overwrite</button>}
          <button type="button" title="Keeps your version. Your next save replaces the version on disk." onClick={() => void runViewAction('keep').catch(handleError)}>Keep My Edits</button>
        </section>
      )}
      {undoReloadUntil > Date.now() && <button type="button" className="qe-undo-reload" onClick={() => void runViewAction('undoReload').catch(handleError)}>Undo reload</button>}
      {(uiError || settingsError || buffer.error || draftConflict) && (
        <div className="qe-document-error" role="alert">
          <span>{uiError ?? settingsError ?? draftConflict ?? buffer.error}</span>
          {buffer.error && <button type="button" onClick={() => void context.call('quirky.editor/open', { worktree: buffer.worktreeId, path: buffer.relativePath, mode: actualMode, focus: true }).then(() => refresh()).catch(handleError)}>Retry</button>}
          {draftConflict && <button type="button" onClick={() => setCompareOpen(true)}>Compare local text</button>}
        </div>
      )}
      <div className="qe-document-content">
        {showSource && (
          <SourceEditor
            key={`${buffer.id}:${editorGeneration}`}
            ref={sourceRef}
            buffer={buffer}
            tabId={actualTabId}
            wrap={settings.wordWrap}
            minimap={settings.minimap}
            fontSize={fontSize}
            fontFamily={settings.fontFamily}
            onDraft={submitDraft}
            flushDraft={flushDrafts}
            onView={updateView}
            onEditorFocus={focusEditor}
            onSearchInFiles={searchInFiles}
            reveal={reveal}
            error={sourceError}
            onError={setSourceError}
          />
        )}
        {surfaceProps && showMarkdown && (
          <SurfaceErrorBoundary onRetry={() => setEditorGeneration((value) => value + 1)}>
            <Suspense fallback={<div className="qe-surface-loading" role="status">Loading Markdown surface…</div>}>
              <MarkdownSurface {...surfaceProps} />
            </Suspense>
          </SurfaceErrorBoundary>
        )}
        {surfaceProps && showNotebook && (
          <SurfaceErrorBoundary onRetry={() => setEditorGeneration((value) => value + 1)}>
            <Suspense fallback={<div className="qe-surface-loading" role="status">Loading notebook surface…</div>}>
              <NotebookSurface {...surfaceProps} />
            </Suspense>
          </SurfaceErrorBoundary>
        )}
        {surfaceProps && showViewer && (
          <SurfaceErrorBoundary onRetry={() => setEditorGeneration((value) => value + 1)}>
            <Suspense fallback={<div className="qe-surface-loading" role="status">Loading viewer…</div>}>
              <ViewerSurface {...surfaceProps} />
            </Suspense>
          </SurfaceErrorBoundary>
        )}
      </div>
      {compareOpen && (
        <div className="qe-modal-layer">
          <section className="qe-compare-dialog" role="dialog" aria-modal="true" aria-labelledby="qe-compare-title">
            <h2 id="qe-compare-title">File changed on disk</h2>
            <p>Disk version on the left, your unsaved edits on the right.</p>
            <div className="qe-compare-columns">
              <label>{external ? 'Disk version' : 'Shared draft'}
                <textarea readOnly value={external ? (buffer.diskContent === undefined ? 'Disk content is not loaded. Retry Compare.' : buffer.diskContent ?? 'File deleted on disk.') : buffer.draft ?? buffer.content} />
              </label>
              <label>{external ? 'Your edits' : 'Local edits'}
                <textarea readOnly value={localText ?? buffer.draft ?? buffer.content} />
              </label>
            </div>
            <div className="qe-dialog-actions">
              {external && <button type="button" onClick={() => { setCompareOpen(false); void runViewAction('reload').catch(handleError) }}>Reload</button>}
              {external && <button type="button" onClick={() => { setCompareOpen(false); void runViewAction('keep').catch(handleError) }}>Keep My Edits</button>}
              <button type="button" onClick={() => setCompareOpen(false)}>Close</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}