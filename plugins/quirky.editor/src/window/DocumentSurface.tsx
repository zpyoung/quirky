import { Component, Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FocusEvent as ReactFocusEvent, type ReactNode } from 'react'
import { Badge, Button, Dialog, EmptyState, FormRow, IconButton, InlineError, NoticeLine, TextField } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorBufferInfo, EditorSurfaceAction, EditorSurfaceBuffer, EditorSurfaceCommandHandler, EditorSurfaceCommandHandlers, SurfaceProps } from '../types'
import { activeDocument, registerActiveDocument, type ActiveDocumentCommand, type ActiveDocumentRegistration } from './activeDocument'
import { useEditorState, type EditorState } from './editorState'
import { openExplorerSearch } from './explorerIntent'
import { requestSingleClose } from './overlayState'
import { setEditorSetting, useEditorSettings } from './settings'
import { beginEditorFocusHandoff, cancelEditorFocus } from './editorFocus'
import { SourceEditor, SourceEditorControlScope, type SourceEditorHandle } from './SourceEditor'
import { ChangesSurface } from './ChangesSurface'
import { hydrateBuffer, hydrateDiskContent, importFileTransfer, writeDraft } from './transfers'
import { requestEditorUiControl, useEditorUiControl, type EditorUiControl, type EditorUiControlAddress, type EditorUiControlResult } from './uiControl'

const EXPLORER_PANEL = 'panel:quirky.editor/explorer'
const DOCUMENT_SURFACE = 'view:quirky.editor/document'
type ControlSession = { document: object; generation: string; kind?: 'disk' | 'local' }
let nextDocumentControlGeneration = 0

function newDocumentControlGeneration(): string {
  return `document-${++nextDocumentControlGeneration}`
}

function validControlData(control: EditorUiControl): boolean {
  const data = control.data ?? {}
  const keys = Reflect.ownKeys(data)
  const only = (...names: string[]) => keys.every((key) => typeof key === 'string' && names.includes(key))
  switch (control.action) {
    case 'copy-path': return only('relative') && (!Object.hasOwn(data, 'relative') || typeof data.relative === 'boolean')
    case 'save': return only('trigger') && (!Object.hasOwn(data, 'trigger') || data.trigger === 'user' || data.trigger === 'overwrite')
    case 'zoom': return only('direction') && ['in', 'out', 'reset'].includes(data.direction as string)
    case 'mode': return only('value') && ['source', 'rich', 'preview'].includes(data.value as string)
    case 'changes': return only('open') && typeof data.open === 'boolean'
    case 'submit': return only('path') && (!Object.hasOwn(data, 'path') || typeof data.path === 'string' && data.path.trim() !== '')
    case 'setting': {
      if (!only('name', 'value') || typeof data.name !== 'string') return false
      if (['editorWordWrap', 'editorMinimapEnabled', 'editorAutoSave', 'editorPreviewTabsEnabled'].includes(data.name)) return typeof data.value === 'boolean'
      if (typeof data.value !== 'number' || !Number.isFinite(data.value)) return false
      return data.name === 'editorAutoSaveDelayMs' ? data.value >= 250 && data.value <= 10000
        : data.name === 'editorFontZoomLevel' && data.value >= -6 && data.value <= 18
    }
    default: return keys.length === 0
  }
}
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
const VIEWER_DRAFT_ACTIONS: Record<string, true> = {
  edit: true,
  insertRow: true,
  deleteRow: true,
  insertColumn: true,
  deleteColumn: true,
  delimiter: true,
  paste: true
}

type SurfaceMode = 'source' | 'rich' | 'preview'
type DocumentInput = { bufferId: string; tabId: string | null; mode?: SurfaceMode; line?: number; column?: number }
type ImportResult = { path?: string; paths?: string[] }
type InternalPaths = { worktreeId: string; paths: string[] }
type ReadBufferResult = { buffer?: EditorBufferInfo }
type Props = { context: UiPluginContext; input?: unknown }
type BoundaryProps = { children: ReactNode; onRetry(): void; onFailure(): void }
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
    this.props.onFailure()
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="qe-surface-failure">
          <InlineError message={`The document surface could not be loaded: ${this.state.error}`} action={{ label: 'Retry', onAction: this.props.onRetry }} />
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
type DraftAcknowledgement = { contentRevision: number; draft: string | null }

export function classifyDraftUpdate(
  observation: DraftAcknowledgement,
  acknowledged: ReadonlyMap<number, string | null>,
  pending: readonly DraftAcknowledgement[]
): 'acknowledged' | 'pending' | 'competing' {
  if (acknowledged.has(observation.contentRevision) && acknowledged.get(observation.contentRevision) === observation.draft) {
    return 'acknowledged'
  }
  if (pending.some((write) => write.contentRevision === observation.contentRevision && write.draft === observation.draft)) {
    return 'pending'
  }
  return 'competing'
}
type AcknowledgedDocumentDraft = { content: string; draft: string | null }

export function expectedDraftAcknowledgement(
  content: string,
  acknowledged: AcknowledgedDocumentDraft,
  contentRevision: number
): DraftAcknowledgement {
  return {
    contentRevision: contentRevision + Number((acknowledged.draft ?? acknowledged.content) !== content),
    draft: content === acknowledged.content ? null : content
  }
}

function rememberDraftAcknowledgement(
  acknowledged: Map<number, string | null>,
  observation: DraftAcknowledgement
): void {
  acknowledged.set(observation.contentRevision, observation.draft)
  while (acknowledged.size > 64) {
    const oldest = acknowledged.keys().next().value
    if (oldest === undefined) break
    acknowledged.delete(oldest)
  }
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
  return importSourcePaths(context, worktree, directory, paths)
}

async function importSourcePaths(context: UiPluginContext, worktree: string, directory: string, paths: string[]): Promise<string[]> {
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

/**
 * Worktree paths to open for OS files dropped on a document. With the drop's source paths, files
 * already inside the worktree open in place and the rest are imported as collision-safe copies
 * beside the document; without them, every file is imported.
 */
export async function droppedFileTargets(
  context: UiPluginContext,
  buffer: { root: string; worktreeId: string; relativePath: string },
  files: File[]
): Promise<string[]> {
  const directory = parentDirectory(buffer.relativePath)
  const sourcePaths = await context.nativeDropPaths(files)
  if (!sourcePaths) return uploadFiles(context, buffer.worktreeId, directory, files)
  const rootPrefix = buffer.root.endsWith('/') ? buffer.root : `${buffer.root}/`
  const inside = sourcePaths.filter((path) => path.startsWith(rootPrefix)).map((path) => path.slice(rootPrefix.length))
  const outside = sourcePaths.filter((path) => !path.startsWith(rootPrefix))
  const imported = outside.length > 0 ? await importSourcePaths(context, buffer.worktreeId, directory, outside) : []
  return [...inside, ...imported]
}

/** One session-free hosted document view inside the terminal workspace. */
export function DocumentSurface({ context, input }: Props) {
  const parsed = documentInput(input)
  if (!parsed) return <div className="qe-document-message"><InlineError message="The document tab has no buffer ID." /></div>
  return <DocumentBody key={JSON.stringify([parsed.bufferId, parsed.tabId])} context={context} input={parsed} />
}

function DocumentBody({ context, input }: { context: UiPluginContext; input: DocumentInput }) {
  const { state, error: stateError, refresh } = useEditorState(context, { bufferId: input.bufferId })
  const info = state?.buffers.find((entry) => entry.id === input.bufferId)
  const [buffer, setBuffer] = useState<EditorSurfaceBuffer | null>(null)
  const bufferRef = useRef<EditorSurfaceBuffer | null>(null)
  bufferRef.current = buffer
  const actualTabId = input.tabId ?? info?.tabId ?? buffer?.tabId ?? null
  const identity = JSON.stringify([input.bufferId, actualTabId])
  const documentSession = useMemo(() => ({ generation: newDocumentControlGeneration() }), [context, identity, info?.path, info?.worktreeId])
  const currentSession = useRef(documentSession)
  currentSession.current = documentSession
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const isCurrent = (origin = documentSession) => mounted.current && currentSession.current === origin
  const requireCurrent = (origin: object) => {
    if (!mounted.current || currentSession.current !== origin) throw new Error('The editor control is no longer available.')
  }
  const busyControls = useRef(new Set<string>())
  const [hydrateError, setHydrateError] = useState<string | null>(null)
  const [hydrationAttempt, setHydrationAttempt] = useState(0)
  const lastHydrationAttempt = useRef(0)
  const retryDocument = () => { setHydrationAttempt((attempt) => attempt + 1); refresh() }
  const { settings, error: settingsError } = useEditorSettings(context)
  const [uiError, setUiError] = useState<string | null>(null)
  const [sourceError, onSourceError] = useState<string | null>(null)
  const [draftConflict, setDraftConflict] = useState<string | null>(null)
  const [localText, setLocalText] = useState<string | null>(null)
  const localTextRef = useRef<string | null>(null)
  const [editorGeneration, setEditorGeneration] = useState(0)
  const [surfaceAttempt, setSurfaceAttempt] = useState(0)
  const [surfaceFailure, setSurfaceFailure] = useState<{ document: object; mode: SurfaceMode; kind: string } | null>(null)
  const MarkdownSurface = useMemo(() => lazy(() => import('../markdown/MarkdownSurface').then((module) => ({ default: module.MarkdownSurface }))), [surfaceAttempt])
  const NotebookSurface = useMemo(() => lazy(() => import('../notebook/NotebookSurface').then((module) => ({ default: module.NotebookSurface }))), [surfaceAttempt])
  const ViewerSurface = useMemo(() => lazy(() => import('../viewers/ViewerSurface').then((module) => ({ default: module.ViewerSurface }))), [surfaceAttempt])
  const [comparisonSession, setComparisonSession] = useState<ControlSession | null>(null)
  const comparisonIntent = useRef<string | null>(null)
  const compareOpen = comparisonSession?.document === documentSession
  const setCompareOpen = (open: boolean) => {
    const generation = newDocumentControlGeneration()
    comparisonIntent.current = generation
    setComparisonSession(open ? { document: documentSession, generation, kind: 'local' } : null)
  }
  const compareId = useId()
  const [undoReloadUntil, setUndoReloadUntil] = useState(0)
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const [renameSession, setRenameSession] = useState<ControlSession | null>(null)
  const currentRename = useRef(renameSession)
  currentRename.current = renameSession
  const currentComparison = useRef(comparisonSession)
  currentComparison.current = comparisonSession
  const [changesOpen, setChangesOpen] = useState(false)
  const sourceRef = useRef<SourceEditorHandle>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const fileActionsRef = useRef<HTMLDetailsElement>(null)
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
  const acknowledgedBuffer = useRef<AcknowledgedDocumentDraft | null>(null)
  const pendingDrafts = useRef(new Map<number, DraftAcknowledgement>())
  const ownDraftAcknowledgements = useRef(new Map<number, string | null>())
  const pendingActionAcknowledgements = useRef(0)
  const pendingSaveAcknowledgement = useRef<DraftAcknowledgement | null>(null)
  const draftWriteId = useRef(0)
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
    const retrying = lastHydrationAttempt.current !== hydrationAttempt
    if (!info) {
      if (state) setBuffer(null)
      return
    }
    const current = bufferRef.current
    if (!retrying && current && current.id === info.id && current.contentRevision === info.contentRevision) {
      const merged = { ...current, ...info, content: current.content, draft: current.draft }
      if (current.revision !== info.revision || current.path !== info.path || current.worktreeId !== info.worktreeId || current.external !== info.external || current.diskContent !== info.diskContent) setBuffer(merged)
      return
    }
    let cancelled = false
    void hydrateBuffer(context, info).then((hydrated) => {
      if (cancelled) return
      const latest = bufferRef.current
      if (latest && latest.id === hydrated.id && latest.contentRevision > hydrated.contentRevision) return
      lastHydrationAttempt.current = hydrationAttempt
      setHydrateError(null)
      setBuffer(hydrated)
    }).catch((reason: unknown) => {
      if (!cancelled) {
        lastHydrationAttempt.current = hydrationAttempt
        setHydrateError(messageOf(reason))
      }
    })
    return () => { cancelled = true }
  }, [context, hydrationAttempt, info, state])

  const reconcileDraftObservation = useCallback((observedBuffer: EditorSurfaceBuffer) => {
    if (observedBuffer.contentRevision < ackRevision.current) return
    if (localTextRef.current === null) {
      acknowledgedBuffer.current = { content: observedBuffer.content, draft: observedBuffer.draft }
      ackRevision.current = Math.max(ackRevision.current, observedBuffer.contentRevision)
      if (observedBuffer.draft !== null) {
        localTextRef.current = observedBuffer.draft
        setLocalText(observedBuffer.draft)
      }
      return
    }
    const observation = { contentRevision: observedBuffer.contentRevision, draft: observedBuffer.draft }
    const pending = [...pendingDrafts.current.values()]
    if (pendingSaveAcknowledgement.current !== null) pending.push(pendingSaveAcknowledgement.current)
    const origin = classifyDraftUpdate(observation, ownDraftAcknowledgements.current, pending)
    if (origin === 'pending') return
    if (origin === 'acknowledged') {
      ackRevision.current = Math.max(ackRevision.current, observedBuffer.contentRevision)
      if (observedBuffer.draft === null && observedBuffer.content === localTextRef.current) {
        localTextRef.current = null
        setLocalText(null)
        pendingDrafts.current.clear()
        pendingSaveAcknowledgement.current = null
        blockedDraft.current = false
        setDraftConflict(null)
        return
      }
      if (observedBuffer.draft === localTextRef.current) {
        blockedDraft.current = false
        setDraftConflict(null)
      }
      return
    }
    if (observedBuffer.contentRevision <= ackRevision.current) return
    blockedDraft.current = true
    setDraftConflict('A newer shared draft arrived. Your local text is preserved for comparison.')
  }, [])

  useEffect(() => {
    if (!buffer || pendingActionAcknowledgements.current > 0) return
    reconcileDraftObservation(buffer)
  }, [buffer?.content, buffer?.contentRevision, buffer?.draft, reconcileDraftObservation])

  useEffect(() => () => {
    if (input.tabId !== null) cancelEditorFocus(input.tabId)
  }, [input.tabId])
  useEffect(() => () => {
    if (undoReloadTimer.current !== undefined) window.clearTimeout(undoReloadTimer.current)
  }, [])

  useEffect(() => {
    const onFileActionsOutside = (event: Event) => {
      const details = fileActionsRef.current
      if (!details?.open || !(event.target instanceof Node) || details.contains(event.target)) return
      details.open = false
    }
    const dismissEscape = (event: KeyboardEvent) => {
      const details = fileActionsRef.current
      if (event.key !== 'Escape' || !details?.open) return
      event.preventDefault()
      event.stopPropagation()
      details.open = false
      details.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', onFileActionsOutside)
    document.addEventListener('click', onFileActionsOutside, true)
    document.addEventListener('focusin', onFileActionsOutside)
    document.addEventListener('keydown', dismissEscape, true)
    return () => {
      document.removeEventListener('pointerdown', onFileActionsOutside)
      document.removeEventListener('click', onFileActionsOutside, true)
      document.removeEventListener('focusin', onFileActionsOutside)
      document.removeEventListener('keydown', dismissEscape, true)
    }
  }, [])
  const flushDrafts = useCallback(async () => {
    await draftQueue.current
    if (blockedDraft.current) throw new Error(draftConflict ?? 'Your local draft conflicts with a newer shared version.')
  }, [draftConflict])
  const flushActiveDocument = useCallback(async () => {
    await flushSurfaceEditors()
    await flushDrafts()
  }, [flushDrafts, flushSurfaceEditors])

  const onDocumentDraft = useCallback((content: string) => {
    const origin = currentSession.current
    localTextRef.current = content
    setLocalText(content)
    const writeId = ++draftWriteId.current
    draftQueue.current = draftQueue.current.then(async () => {
      if (blockedDraft.current) {
        pendingDrafts.current.delete(writeId)
        return
      }
      const expectedRevision = ackRevision.current
      const acknowledged = acknowledgedBuffer.current ?? {
        content: bufferRef.current?.content ?? '',
        draft: bufferRef.current?.draft ?? null
      }
      pendingDrafts.current.set(writeId, expectedDraftAcknowledgement(content, acknowledged, expectedRevision))
      try {
        const updated = await writeDraft(context, input.bufferId, content, expectedRevision)
        pendingDrafts.current.delete(writeId)
        ackRevision.current = Math.max(ackRevision.current, updated.contentRevision)
        const latestAcknowledged = acknowledgedBuffer.current ?? {
          content: bufferRef.current?.content ?? '',
          draft: bufferRef.current?.draft ?? null
        }
        const acceptedContent = typeof updated.content === 'string' ? updated.content : latestAcknowledged.content
        const acceptedDraft = updated.draftLength === null ? null : content
        rememberDraftAcknowledgement(ownDraftAcknowledgements.current, {
          contentRevision: updated.contentRevision,
          draft: acceptedDraft
        })
        acknowledgedBuffer.current = { content: acceptedContent, draft: acceptedDraft }
        const live = mounted.current && currentSession.current === origin
        if (localTextRef.current === content) {
          blockedDraft.current = false
          if (live) setDraftConflict(null)
        }
        if (live) {
          const latest = bufferRef.current
          if (latest) setBuffer(mergeSurfaceBuffer(latest, updated, { content: latest.content, draft: acceptedDraft }))
          refresh()
        }
      } catch (reason) {
        pendingDrafts.current.clear()
        blockedDraft.current = true
        if (mounted.current && currentSession.current === origin) {
          setDraftConflict(messageOf(reason))
          refresh()
        }
      }
    })
  }, [context, input.bufferId, refresh])

  const writeLocalDraftAtLatest = useCallback(async (content: string, check?: () => void) => {
    const origin = currentSession.current
    const result = await context.call('quirky.editor/read', { bufferId: input.bufferId, action: 'buffer' }) as ReadBufferResult
    requireCurrent(origin)
    check?.()
    if (!result.buffer) throw new Error('The latest shared buffer could not be read.')
    const updated = await writeDraft(context, input.bufferId, content, result.buffer.contentRevision)
    requireCurrent(origin)
    check?.()
    const latestAcknowledged = {
      content: typeof result.buffer.content === 'string'
        ? result.buffer.content
        : bufferRef.current?.content ?? acknowledgedBuffer.current?.content ?? '',
      draft: result.buffer.draftLength === null
        ? null
        : typeof result.buffer.draft === 'string'
          ? result.buffer.draft
          : bufferRef.current?.draft ?? acknowledgedBuffer.current?.draft ?? null
    }
    const acceptedContent = typeof updated.content === 'string' ? updated.content : latestAcknowledged.content
    const acceptedDraft = updated.draftLength === null ? null : content
    acknowledgedBuffer.current = { content: acceptedContent, draft: acceptedDraft }
    rememberDraftAcknowledgement(ownDraftAcknowledgements.current, {
      contentRevision: updated.contentRevision,
      draft: acceptedDraft
    })
    ackRevision.current = Math.max(ackRevision.current, updated.contentRevision)
    pendingDrafts.current.clear()
    pendingSaveAcknowledgement.current = null
    blockedDraft.current = false
    localTextRef.current = content
    setLocalText(content)
    setDraftConflict(null)
    const current = bufferRef.current
    if (current) setBuffer(mergeSurfaceBuffer(current, updated, { content: acceptedContent, draft: acceptedDraft }))
  }, [context, input.bufferId])

  const save = useCallback(async (trigger: 'user' | 'overwrite' = 'user'): Promise<EditorBufferInfo> => {
    const origin = currentSession.current
    await flushSurfaceEditors()
    requireCurrent(origin)
    if (trigger === 'overwrite') {
      await draftQueue.current
      requireCurrent(origin)
      const currentText = localTextRef.current
      if (currentText !== null && blockedDraft.current) await writeLocalDraftAtLatest(currentText)
    } else {
      await flushDrafts()
    }
    requireCurrent(origin)
    const snapshot = localTextRef.current
    const current = bufferRef.current
    const acknowledgedBefore = acknowledgedBuffer.current ?? {
      content: current?.content ?? '',
      draft: current?.draft ?? null
    }
    if (snapshot !== null && acknowledgedBefore.draft !== null) {
      pendingSaveAcknowledgement.current = { contentRevision: ackRevision.current + 1, draft: null }
    }
    let saved: EditorBufferInfo
    try {
      saved = await context.call('quirky.editor/save', { bufferId: input.bufferId, trigger }) as EditorBufferInfo
    } catch (reason) {
      if (mounted.current && currentSession.current === origin) pendingSaveAcknowledgement.current = null
      throw reason
    }
    requireCurrent(origin)
    const savedContent = typeof saved.content === 'string' ? saved.content : snapshot ?? acknowledgedBefore.content
    const savedDraft = saved.draftLength === null
      ? null
      : typeof saved.draft === 'string'
        ? saved.draft
        : snapshot ?? acknowledgedBefore.draft
    acknowledgedBuffer.current = { content: savedContent, draft: savedDraft }
    rememberDraftAcknowledgement(ownDraftAcknowledgements.current, {
      contentRevision: saved.contentRevision,
      draft: savedDraft
    })
    pendingSaveAcknowledgement.current = null
    ackRevision.current = Math.max(ackRevision.current, saved.contentRevision)
    if (current) {
      const stableText = localTextRef.current === snapshot
      setBuffer(mergeSurfaceBuffer(current, saved, { content: savedContent, draft: stableText ? savedDraft : current.draft }))
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
    return saved
  }, [context, flushDrafts, flushSurfaceEditors, input.bufferId, refresh, writeLocalDraftAtLatest])
  const runViewAction = useCallback(async (action: 'reload' | 'keep' | 'undoReload' | 'compare' | 'promote' | 'pin' | 'reveal', patch?: Record<string, unknown>, session?: ControlSession) => {
    const origin = currentSession.current
    const comparison = action === 'compare' ? newDocumentControlGeneration() : null
    if (comparison) comparisonIntent.current = comparison
    const check = () => {
      requireCurrent(origin)
      if (session && currentComparison.current !== session || comparison && comparisonIntent.current !== comparison) throw new Error('The editor control is no longer available.')
    }
    if (action === 'keep') {
      await draftQueue.current
      check()
      const keepContent = localTextRef.current ?? bufferRef.current?.draft ?? bufferRef.current?.content
      if (keepContent !== undefined && blockedDraft.current) await writeLocalDraftAtLatest(keepContent, check)
    } else if (action === 'reload' || action === 'undoReload') {
      await draftQueue.current
    }
    check()
    const updated = await context.call('quirky.editor/view', {
      bufferId: input.bufferId,
      action,
      ...(actualTabId === null ? {} : { tabId: actualTabId }),
      ...(patch ? { patch } : {})
    }) as EditorBufferInfo
    check()
    if (comparison && updated.external !== 'changed') throw new Error('The file is no longer changed on disk.')
    const comparedDiskContent = comparison ? await hydrateDiskContent(context, updated) : undefined
    check()
    if (action === 'reload') {
      if (undoReloadTimer.current !== undefined) window.clearTimeout(undoReloadTimer.current)
      if (localTextRef.current !== null || bufferRef.current && bufferRef.current.draft !== null) {
        setUndoReloadUntil(Date.now() + 8000)
        undoReloadTimer.current = window.setTimeout(() => {
          undoReloadTimer.current = undefined
          setUndoReloadUntil(0)
        }, 8000)
      }
      ackRevision.current = Math.max(ackRevision.current, updated.contentRevision)
      acknowledgedBuffer.current = null
      pendingSaveAcknowledgement.current = null
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
      localTextRef.current = null
      setLocalText(null)
      setBuffer(null)
      ackRevision.current = Math.max(ackRevision.current, updated.contentRevision)
      acknowledgedBuffer.current = null
      pendingSaveAcknowledgement.current = null
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
    if (comparison) setComparisonSession({ document: origin, generation: comparison, kind: 'disk' })
    setUiError(null)
    refresh()
    return updated
  }, [actualTabId, context, input.bufferId, refresh, writeLocalDraftAtLatest])

  const onDocumentView = useCallback((patch: Record<string, unknown>) => {
    const origin = currentSession.current
    const tabId = input.tabId ?? bufferRef.current?.tabId
    void context.call('quirky.editor/view', { bufferId: input.bufferId, action: 'update', ...(tabId ? { tabId } : {}), patch }).catch((reason: unknown) => {
      if (mounted.current && currentSession.current === origin) setUiError(messageOf(reason))
    })
  }, [context, input.bufferId, input.tabId])
  const actualMode = input.mode ?? buffer?.mode ?? 'source'
  const canOfferChanges = buffer !== null &&
    (buffer.kind === 'text' || buffer.kind === 'markdown') &&
    !buffer.readOnly && !buffer.untitled && buffer.baseline !== null &&
    buffer.error === null && buffer.external !== 'deleted' && actualMode !== 'preview'
  useEffect(() => {
    if (!canOfferChanges) setChangesOpen(false)
  }, [canOfferChanges])

  const onAction = useCallback((method: string, params: Record<string, unknown>) => {
    const needsBuffer = BUFFER_METHODS[method] === true && params.bufferId === undefined
    const needsTab = TAB_METHODS[method] === true && params.tabId === undefined && actualTabId !== null
    const request = needsBuffer || needsTab ? { ...params } : params
    if (needsBuffer) request.bufferId = input.bufferId
    if (needsTab) request.tabId = actualTabId

    const markdownApply = method === 'quirky.editor/markdown' && request.action === 'apply'
    const viewerAction = method === 'quirky.editor/viewer' && typeof request.action === 'string'
      ? request.action
      : null
    const notebookSave = method === 'quirky.editor/notebook' && request.action === 'save'
    if (viewerAction === 'save' || notebookSave) return save('user')
    const viewerMutation = viewerAction !== null && VIEWER_DRAFT_ACTIONS[viewerAction] === true
    if (!markdownApply && !viewerMutation) return context.call(method, request)

    pendingActionAcknowledgements.current += 1
    return (async () => {
      try {
        const result = await context.call(method, request)
        const updated = (result as { buffer?: EditorBufferInfo } | null | undefined)?.buffer
        if (!updated || updated.contentRevision < ackRevision.current) return result
        const acknowledged = updated.content === undefined ||
          (updated.draft === undefined && updated.draftLength !== null)
          ? await hydrateBuffer(context, updated)
          : updated
        if (acknowledged.contentRevision < ackRevision.current) return result
        const acceptedDraft = acknowledged.draft ?? null
        if (acceptedDraft !== null && typeof acceptedDraft !== 'string') return result
        const previousAcknowledgement = acknowledgedBuffer.current ?? {
          content: bufferRef.current?.content ?? '',
          draft: bufferRef.current?.draft ?? null
        }
        const acceptedContent = typeof acknowledged.content === 'string' ? acknowledged.content : previousAcknowledgement.content
        rememberDraftAcknowledgement(ownDraftAcknowledgements.current, {
          contentRevision: acknowledged.contentRevision,
          draft: acceptedDraft
        })
        ackRevision.current = Math.max(ackRevision.current, acknowledged.contentRevision)
        acknowledgedBuffer.current = { content: acceptedContent, draft: acceptedDraft }
        localTextRef.current = acceptedDraft ?? acceptedContent
        setLocalText(acceptedDraft ?? acceptedContent)
        refresh()
        return result
      } finally {
        pendingActionAcknowledgements.current -= 1
        if (pendingActionAcknowledgements.current === 0) {
          const latest = bufferRef.current
          if (latest) reconcileDraftObservation(latest)
        }
      }
    })()
  }, [actualTabId, context, input.bufferId, reconcileDraftObservation, refresh, save])

  const featureProps = useMemo<SurfaceProps | null>(() => {
    if (!buffer) return null
    const tabViews = buffer.view.byTabId
    const tabView = actualTabId && tabViews && typeof tabViews === 'object' && !Array.isArray(tabViews)
      ? (tabViews as Record<string, unknown>)[actualTabId]
      : undefined
    const view = tabView && typeof tabView === 'object' && !Array.isArray(tabView)
      ? { ...buffer.view, ...tabView as Record<string, unknown> }
      : buffer.view
    const surfaceBuffer = buffer.mode === actualMode && buffer.tabId === actualTabId && view === buffer.view
      ? buffer
      : { ...buffer, mode: actualMode, tabId: actualTabId, view }
    return {
      context,
      buffer: surfaceBuffer,
      fontSize: Math.max(8, Math.min(32, 13 + settings.fontZoomLevel)),
      onDraft: onDocumentDraft,
      onAction,
      onView: onDocumentView,
      registerCommandHandlers
    }
  }, [actualMode, actualTabId, buffer, context, onAction, registerCommandHandlers, settings.fontZoomLevel, onDocumentDraft, onDocumentView])

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
    save: async () => { await save('user') },
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
        if (actualTabId !== null) cancelEditorFocus(actualTabId)
        clearEditorFocus()
      }
    }
    updateGroupFocus()
    const observer = group ? new MutationObserver(updateGroupFocus) : undefined
    if (group) observer?.observe(group, { attributes: true, attributeFilter: ['class'] })
    return () => {
      if (actualTabId !== null) cancelEditorFocus(actualTabId)
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
  const onEditorFocus = () => {
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
    if (!isCurrent()) return
    const message = messageOf(reason)
    setUiError(message)
    context.toast('Editor action failed', message)
  }

  const copyPath = async (relative: boolean) => {
    if (!buffer) return
    const origin = documentSession
    const path = relative ? buffer.relativePath : buffer.path
    await navigator.clipboard.writeText(path)
    requireCurrent(origin)
    context.toast('Path copied', path)
  }

  const openMode = async (mode: SurfaceMode) => {
    const selectedBuffer = bufferRef.current
    if (!selectedBuffer) return
    const origin = documentSession
    await flushActiveDocument()
    requireCurrent(origin)
    if (mode === 'preview' && selectedBuffer.kind === 'markdown') {
      await context.call('quirky.editor/open', { worktree: selectedBuffer.worktreeId, path: selectedBuffer.relativePath, mode: 'preview', preview: false, focus: true })
      requireCurrent(origin)
    } else {
      const updated = await context.call('quirky.editor/view', {
        bufferId: selectedBuffer.id, ...(actualTabId === null ? {} : { tabId: actualTabId }),
        action: actualMode === 'preview' && selectedBuffer.kind === 'markdown' ? 'returnToEdit' : 'update', patch: { mode }
      }) as EditorBufferInfo
      requireCurrent(origin)
      const current = bufferRef.current
      if (current) setBuffer(mergeSurfaceBuffer(current, updated, { content: current.content, draft: current.draft }))
      refresh()
    }
    setChangesOpen(false)
  }

  const revealInExplorer = async () => {
    if (!buffer) return
    const origin = documentSession
    await context.call('quirky.editor/explorer', { worktree: buffer.worktreeId, action: 'reveal', path: buffer.relativePath })
    requireCurrent(origin)
    context.togglePanel(EXPLORER_PANEL, true)
  }

  const onSearchInFiles = async (query: string) => {
    if (!buffer || !isCurrent()) return
    openExplorerSearch(buffer.worktreeId, query)
    context.togglePanel(EXPLORER_PANEL, true)
  }

  const saveSetting = async (name: string, value: boolean | number | string) => {
    const origin = documentSession
    await setEditorSetting(context, name, value)
    requireCurrent(origin)
  }

  const renameFile = async (path: string, session: ControlSession) => {
    if (!buffer) return
    await context.call('quirky.editor/mutate', { worktree: buffer.worktreeId, action: 'rename', path: buffer.relativePath, newPath: path })
    requireCurrent(session.document)
    if (currentRename.current !== session) return
    setRenameSession(null)
    setRenamePath(null)
    refresh()
  }

  const duplicateFile = async () => {
    if (!buffer) return
    const origin = documentSession
    const result = await context.call('quirky.editor/mutate', { worktree: buffer.worktreeId, action: 'duplicate', path: buffer.relativePath }) as { path: string }
    requireCurrent(origin)
    await context.call('quirky.editor/open', { worktree: buffer.worktreeId, path: result.path, focus: true, preview: false })
    requireCurrent(origin)
    refresh()
  }

  const deleteFile = async () => {
    if (!buffer) return
    const origin = documentSession
    const confirmed = await context.confirm({ title: `Delete ${buffer.name}?`, body: 'The file will be moved to Trash when supported by this workspace.' })
    requireCurrent(origin)
    if (!confirmed) return
    await context.call('quirky.editor/mutate', { worktree: buffer.worktreeId, action: 'delete', path: buffer.relativePath, yes: true })
    requireCurrent(origin)
    refresh()
  }

  /** Keeps the shared close flow bound to the document that requested it. */
  const closeDocument = async () => {
    const origin = documentSession
    await flushActiveDocument()
    requireCurrent(origin)
    const closeContext = Object.create(context) as UiPluginContext
    closeContext.call = async (method, params) => {
      requireCurrent(origin)
      const result = await context.call(method, params)
      if (method !== 'quirky.editor/close') requireCurrent(origin)
      return result
    }
    closeContext.toast = (title, message) => {
      if (!isCurrent(origin)) return
      if (title === 'Unable to close file') throw new Error(message ?? title)
      context.toast(title, message)
    }
    return requestSingleClose(closeContext, input.bufferId, actualTabId ?? undefined)
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
      const imported = await droppedFileTargets(context, buffer, files)
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

  const operationErrors = useRef(new WeakSet<Error>())
  const onControlError = (reason: Error) => {
    if (!operationErrors.current.has(reason)) handleError(reason)
  }

  /** Keeps bridge errors bound to a live session when its available actions change. */
  function bindControls(address: EditorUiControlAddress | null, live: () => boolean) {
    async function run(action: string, data?: Record<string, unknown>): Promise<EditorUiControlResult> {
      if (!address || !live() || !address.actions.includes(action)) return { delivered: false }
      try {
        const result = await requestEditorUiControl(context, {
          surface: address.surface, target: address.target, generation: address.generation, action,
          ...(data === undefined ? {} : { data })
        })
        if (!result.delivered && live()) onControlError(new Error('The editor control is no longer available.'))
        return result
      } catch (reason) {
        if (live()) onControlError(reason instanceof Error ? reason : new Error(messageOf(reason)))
        return { delivered: false }
      }
    }
    return { run }
  }

  const available = ['retry']
  const onSurfaceFailure = () => {
    if (isCurrent() && buffer) setSurfaceFailure({ document: documentSession, mode: actualMode, kind: buffer.kind })
  }
  if (surfaceFailure?.document === documentSession && surfaceFailure.mode === actualMode && surfaceFailure.kind === buffer?.kind) available.push('retry-surface')
  const usable = buffer && info?.path === buffer.path && info.worktreeId === buffer.worktreeId
  if (usable) {
    available.push('copy-path', 'pin', 'explorer', 'source-control', 'close', 'zoom', 'setting', 'rename-start', 'duplicate', 'delete')
    if (buffer.error) available.push('retry-open')
    if (['markdown', 'notebook', 'csv', 'mermaid'].includes(buffer.kind)) available.push('mode')
    if (canOfferChanges || changesOpen) available.push('changes')
    if (!buffer.readOnly && (buffer.untitled || buffer.dirty || buffer.external || localText !== null && localText !== buffer.content)) available.push('save')
    if (buffer.external === 'changed') available.push('compare-disk', 'reload', 'keep')
    if (draftConflict) available.push('compare-local')
    if (undoReloadUntil > Date.now()) available.push('undo-reload')
  }
  const executeControl = async (key: string, live: () => boolean, operation: () => unknown | Promise<unknown>) => {
    if (!live() || busyControls.current.has(key)) return { delivered: false }
    busyControls.current.add(key)
    try {
      await operation()
      if (live()) setUiError(null)
      return { delivered: true }
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(messageOf(reason))
      operationErrors.current.add(error)
      if (live()) handleError(error)
      throw error
    } finally {
      busyControls.current.delete(key)
    }
  }
  const handleDocumentControl = async (control: EditorUiControl) => {
    if (!validControlData(control) || !available.includes(control.action) || !isCurrent()) return { delivered: false }
    const data = control.data ?? {}
    if (control.action === 'mode' && buffer?.kind !== 'markdown' && data.value === 'preview') return { delivered: false }
    if (control.action === 'changes' && data.open && !canOfferChanges) return { delivered: false }
    if (control.action === 'save' && data.trigger === 'overwrite' && (!buffer?.dirty || !buffer.external)) return { delivered: false }
    if (control.action === 'undo-reload' && undoReloadUntil <= Date.now()) return { delivered: false }
    let diskComparison: string | null = null
    return executeControl(`${documentSession.generation}:${control.action}`, () => isCurrent() && (diskComparison === null || comparisonIntent.current === diskComparison), async () => {
      switch (control.action) {
        case 'retry': retryDocument(); break
        case 'retry-surface': setSurfaceFailure(null); setSurfaceAttempt((attempt) => attempt + 1); break
        case 'retry-open':
          await context.call('quirky.editor/open', { worktree: buffer!.worktreeId, path: buffer!.relativePath, mode: actualMode, focus: true })
          requireCurrent(documentSession)
          refresh()
          break
        case 'copy-path': await copyPath(data.relative === true); break
        case 'pin': await runViewAction('pin'); break
        case 'explorer': await revealInExplorer(); break
        case 'source-control': context.togglePanel('panel:quirky.git/source-control', true); break
        case 'close': await closeDocument(); break
        case 'zoom':
          await saveSetting('editorFontZoomLevel', data.direction === 'in' ? Math.min(18, settings.fontZoomLevel + 1) : data.direction === 'out' ? Math.max(-6, settings.fontZoomLevel - 1) : 0)
          break
        case 'setting': await saveSetting(data.name as string, data.value as boolean | number); break
        case 'mode': await openMode(data.value as SurfaceMode); break
        case 'changes':
          if (data.open) { await flushActiveDocument(); requireCurrent(documentSession) }
          setChangesOpen(data.open as boolean)
          break
        case 'save': await save(data.trigger === 'overwrite' ? 'overwrite' : 'user'); break
        case 'rename-start':
          setRenameSession({ document: documentSession, generation: newDocumentControlGeneration() })
          setRenamePath(buffer!.relativePath)
          break
        case 'duplicate': await duplicateFile(); break
        case 'delete': await deleteFile(); break
        case 'compare-disk': {
          const pending = runViewAction('compare')
          diskComparison = comparisonIntent.current
          await pending
          break
        }
        case 'compare-local': setCompareOpen(true); break
        case 'reload': await runViewAction('reload'); break
        case 'keep': await runViewAction('keep'); break
        case 'undo-reload': await runViewAction('undoReload'); break
      }
    })
  }
  const documentAddress: EditorUiControlAddress = { surface: DOCUMENT_SURFACE, target: `document:${identity}`, generation: documentSession.generation, actions: available }
  useEditorUiControl({ context, address: documentAddress, handler: handleDocumentControl })
  const controls = bindControls(documentAddress, () => isCurrent())
  const renameLive = () => isCurrent() && renameSession !== null && renameSession.document === documentSession && currentRename.current === renameSession
  const renameAddress: EditorUiControlAddress | null = renameLive() ? { surface: DOCUMENT_SURFACE, target: `document-rename:${identity}`, generation: renameSession!.generation, actions: ['submit', 'cancel'] } : null
  useEditorUiControl({
    context, address: renameAddress,
    handler: async (control) => {
      if (!validControlData(control) || !renameLive()) return { delivered: false }
      const path = (control.data?.path as string | undefined ?? renamePath)?.trim()
      if (control.action === 'submit' && !path) return { delivered: false }
      return executeControl(`${renameSession!.generation}:${control.action}`, renameLive, async () => {
        if (control.action === 'cancel') { setRenameSession(null); setRenamePath(null) }
        else if (control.action === 'submit') await renameFile(path!, renameSession!)
      })
    }
  })
  const renameControls = bindControls(renameAddress, renameLive)
  const comparisonLive = () => isCurrent() && comparisonSession !== null && comparisonSession.document === documentSession && currentComparison.current === comparisonSession
  const comparisonAddress: EditorUiControlAddress | null = comparisonLive() ? { surface: DOCUMENT_SURFACE, target: `document-compare:${identity}`, generation: comparisonSession!.generation, actions: buffer?.external === 'changed' ? ['close', 'reload', 'keep'] : ['close'] } : null
  useEditorUiControl({
    context, address: comparisonAddress,
    handler: async (control) => {
      if (!validControlData(control) || !comparisonLive()) return { delivered: false }
      if (control.action !== 'close' && buffer?.external !== 'changed') return { delivered: false }
      return executeControl(`${comparisonSession!.generation}:${control.action}`, comparisonLive, async () => {
        if (control.action === 'reload' || control.action === 'keep') await runViewAction(control.action, undefined, comparisonSession!)
        if (comparisonLive()) setCompareOpen(false)
      })
    }
  })
  const comparisonControls = bindControls(comparisonAddress, comparisonLive)

  if (!buffer) {
    const error = stateError ?? hydrateError
    if (error) return <div className="qe-document-message"><InlineError message={error} action={{ label: 'Retry', onAction: () => { void controls.run('retry') } }} /></div>
    if (state && !info) return <div className="qe-document-message"><EmptyState message="This document is no longer open." action={{ label: 'Retry', onAction: () => { void controls.run('retry') } }} /></div>
    return <div className="qe-document-message" role="status" aria-live="polite"><NoticeLine>Loading document…</NoticeLine></div>
  }

  const external = buffer.external
  const isMarkdown = buffer.kind === 'markdown'
  const isNotebook = buffer.kind === 'notebook'
  const mediaKind = buffer.kind === 'image' || buffer.kind === 'pdf' || buffer.kind === 'audio' || buffer.kind === 'video' || buffer.kind === 'binary'
  const showSource = !changesOpen && !mediaKind && (actualMode === 'source' || (!isMarkdown && !isNotebook && buffer.kind !== 'csv' && buffer.kind !== 'mermaid'))
  const showMarkdown = !changesOpen && isMarkdown && actualMode !== 'source'
  const showNotebook = !changesOpen && isNotebook && actualMode !== 'source'
  const viewerKind = buffer.kind === 'csv' || buffer.kind === 'mermaid' || mediaKind
  const showViewer = !changesOpen && viewerKind
  const showChanges = changesOpen && canOfferChanges
  const surfaceProps = featureProps
  const comparingDisk = comparisonSession?.kind === 'disk'
  const saveButton = () => {
    const handoff = actualTabId === null ? null : beginEditorFocusHandoff()
    if (actualTabId !== null) handoff?.setTarget(actualTabId)
    const origin = documentSession
    void controls.run('save').then((result) => {
      if (result.delivered && isCurrent(origin)) handoff?.request()
      else handoff?.cancel()
    })
  }
  const closeButton = () => {
    const details = fileActionsRef.current
    if (details) {
      details.open = false
      details.querySelector('summary')?.focus()
    }
    void controls.run('close')
  }
  const changeWrap = (value: boolean) => void controls.run('setting', { name: 'editorWordWrap', value })
  const pathTitle = buffer.relativePath || buffer.name
  const editingBuffer = localText === null
    ? buffer
    : { ...buffer, draft: localText === buffer.content ? null : localText, dirty: localText !== buffer.content }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="qe-document-surface"
      onPointerDownCapture={activateSurface}
      onFocusCapture={onEditorFocus}
      onBlurCapture={blurEditor}
      onDragOver={(event) => {
        const types = event.dataTransfer.types
        if (types.includes(WORKTREE_PATHS_MIME) || types.includes('Files') || types.includes('text/uri-list')) event.preventDefault()
      }}
      onDrop={(event) => { event.preventDefault(); void handleDrop(event).catch(handleError) }}
    >
      <header className="qe-document-header">
        <div className="qe-document-path-group">
          <Button className="qe-document-path" title={buffer.path} onClick={() => void controls.run('copy-path')}>{pathTitle}</Button>
          {buffer.dirty && <Badge tone="needs-you" label="Unsaved changes">●</Badge>}
          {buffer.external && <Badge tone="needs-you">{buffer.external === 'deleted' ? 'Deleted on disk' : 'Changed on disk'}</Badge>}
          <details ref={fileActionsRef} className="qe-file-actions">
            <summary className="qe-disclosure-trigger">File actions</summary>
            <div className="qe-file-actions-menu">
              <Button aria-pressed={buffer.pinned} title={buffer.pinned ? 'Unpin tab' : 'Pin tab'} onClick={() => void controls.run('pin')}>{buffer.pinned ? 'Unpin' : 'Pin'}</Button>
              <Button onClick={() => void controls.run('explorer')}>Explorer</Button>
              <Button onClick={() => void controls.run('source-control')}>Source Control</Button>
              <Button variant="destructive" onClick={closeButton}>Close tab</Button>
              <div className="qe-zoom-controls" aria-label="Editor font size">
                <IconButton label="Zoom out" onClick={() => void controls.run('zoom', { direction: 'out' })}>−</IconButton>
                <span>{fontSize} px</span>
                <IconButton label="Zoom in" onClick={() => void controls.run('zoom', { direction: 'in' })}>+</IconButton>
                <Button aria-label="Reset zoom" onClick={() => void controls.run('zoom', { direction: 'reset' })}>Reset</Button>
              </div>
              <Button onClick={() => void controls.run('copy-path')}>Copy Path</Button>
              <Button onClick={() => void controls.run('copy-path', { relative: true })}>Copy Relative Path</Button>
              <Button onClick={() => void controls.run('explorer')}>Reveal in Explorer</Button>
              <Button onClick={() => void controls.run('rename-start')}>Rename…</Button>
              <Button onClick={() => void controls.run('duplicate')}>Duplicate</Button>
              <Button variant="destructive" onClick={() => void controls.run('delete')}>Delete</Button>
              {buffer.kind === 'markdown' && <Button onClick={() => void controls.run('mode', { value: 'preview' })}>Open Markdown Preview</Button>}
              <label><input type="checkbox" checked={settings.wordWrap} onChange={(event) => changeWrap(event.currentTarget.checked)} />Word Wrap</label>
              <label><input type="checkbox" checked={settings.minimap} onChange={(event) => void controls.run('setting', { name: 'editorMinimapEnabled', value: event.currentTarget.checked })} />Show Minimap</label>
              <label><input type="checkbox" checked={settings.autoSave} onChange={(event) => void controls.run('setting', { name: 'editorAutoSave', value: event.currentTarget.checked })} />Auto Save Files</label>
              <label className="qe-range-setting">Auto Save Delay
                <input type="range" min="250" max="10000" step="250" value={settings.autoSaveDelay} onChange={(event) => void controls.run('setting', { name: 'editorAutoSaveDelayMs', value: Number(event.currentTarget.value) })} />
                <span>{settings.autoSaveDelay} ms</span>
              </label>
              <label><input type="checkbox" checked={settings.previewTabs} onChange={(event) => void controls.run('setting', { name: 'editorPreviewTabsEnabled', value: event.currentTarget.checked })} />Reuse preview tab</label>
            </div>
          </details>
        </div>
        <div className="qe-document-action-strip">
          {buffer.kind === 'markdown' && (
            <div className="qe-mode-switch" aria-label="Markdown view mode">
              <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'source'} onClick={() => void controls.run('mode', { value: 'source' })}>Source</Button>
              <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'rich'} onClick={() => void controls.run('mode', { value: 'rich' })}>Rich Editor</Button>
              <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'preview'} onClick={() => void controls.run('mode', { value: 'preview' })}>Preview</Button>
            </div>
          )}
          {isNotebook && (
            <div className="qe-mode-switch" aria-label="Notebook view mode">
              <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'source'} onClick={() => void controls.run('mode', { value: 'source' })}>Source</Button>
              <Button className="qe-mode-switch__option" aria-pressed={actualMode !== 'source'} onClick={() => void controls.run('mode', { value: 'rich' })}>Notebook</Button>
            </div>
          )}
          {buffer.kind === 'csv' && (
            <div className="qe-mode-switch" aria-label="Table view mode">
              <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'source'} onClick={() => void controls.run('mode', { value: 'source' })}>Source</Button>
              <Button className="qe-mode-switch__option" aria-pressed={actualMode !== 'source'} onClick={() => void controls.run('mode', { value: 'rich' })}>Table</Button>
            </div>
          )}
          {buffer.kind === 'mermaid' && (
            <div className="qe-mode-switch" aria-label="Diagram view mode">
              <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'source'} onClick={() => void controls.run('mode', { value: 'source' })}>Source</Button>
              <Button className="qe-mode-switch__option" aria-pressed={actualMode !== 'source'} onClick={() => void controls.run('mode', { value: 'rich' })}>Preview</Button>
            </div>
          )}
          {canOfferChanges && <Button
            aria-label={changesOpen ? 'Close Changes' : 'Changes'}
            aria-pressed={changesOpen}
            onClick={() => void controls.run('changes', { open: !changesOpen })}
          >{changesOpen ? 'Close Changes' : 'Changes'}</Button>}
          {!buffer.readOnly && <Button variant="primary" onClick={saveButton} disabled={!available.includes('save')}>{buffer.untitled ? 'Save As…' : 'Save'}</Button>}
        </div>
      </header>
      {!buffer.readOnly && buffer.diskWritable === false && buffer.external !== 'deleted' && (
        <section className="qe-permission-banner" role="status">
          This file is not writable with the current OS permissions. Editing and review notes remain available; Save keeps the draft until write access is restored.
        </section>
      )}
      {renameLive() && renamePath !== null && (
        <div className="qe-inline-rename">
          <TextField
            className="qe-inline-rename__field"
            label="Rename to"
            autoFocus
            value={renamePath}
            onChange={(event) => setRenamePath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void renameControls.run('submit') }
              if (event.key === 'Escape') { event.preventDefault(); void renameControls.run('cancel') }
            }}
          />
          <Button variant="primary" onClick={() => void renameControls.run('submit')}>Apply</Button>
          <Button onClick={() => void renameControls.run('cancel')}>Cancel</Button>
        </div>
      )}
      {external && (
        <section className="qe-external-change-banner" role="status">
          <span>{external === 'deleted' ? 'This file was deleted on disk. An explicit save can recreate it.' : 'This file changed on disk while you have unsaved edits. Overwrite replaces the newer disk content.'}</span>
          {external === 'changed' && <Button onClick={() => void controls.run('compare-disk')}>Compare</Button>}
          {external === 'changed' && <Button onClick={() => void controls.run('reload')}>Reload from Disk</Button>}
          {buffer.dirty && <Button variant="primary" onClick={() => void controls.run('save', { trigger: 'overwrite' })}>Overwrite</Button>}
          {external === 'changed' && <Button title="Keeps your version. Your next save replaces the version on disk." onClick={() => void controls.run('keep')}>Keep My Edits</Button>}
        </section>
      )}
      {undoReloadUntil > Date.now() && <Button className="qe-undo-reload" onClick={() => void controls.run('undo-reload')}>Undo reload</Button>}
      <div className="qe-document-error">
        {uiError && <InlineError message={uiError} />}
        {settingsError && <InlineError message={settingsError} />}
        {stateError && <InlineError message={stateError} action={{ label: 'Retry', onAction: () => { void controls.run('retry') } }} />}
        {hydrateError && <InlineError message={hydrateError} action={{ label: 'Retry', onAction: () => { void controls.run('retry') } }} />}
        {buffer.error && <InlineError message={buffer.error} action={{ label: 'Retry', onAction: () => { void controls.run('retry-open') } }} />}
        {draftConflict && <InlineError message={draftConflict} action={{ label: 'Compare local text', onAction: () => { void controls.run('compare-local') } }} />}
      </div>
      <div className="qe-document-content">
        <SourceEditorControlScope context={context}>
        {showChanges && <ChangesSurface
          context={context}
          buffer={editingBuffer}
          tabId={actualTabId}
          fontSize={fontSize}
          fontFamily={settings.fontFamily}
          wrap={settings.wordWrap}
          minimap={settings.minimap}
          onDraft={onDocumentDraft}
          flushDraft={flushDrafts}
          onView={onDocumentView}
          onEditorFocus={onEditorFocus}
          onSearchInFiles={onSearchInFiles}
          error={sourceError}
          onError={onSourceError}
          registerCommandHandlers={registerCommandHandlers}
        />}
        {showSource && (
          <SourceEditor
            key={`${buffer.id}:${editorGeneration}`}
            ref={sourceRef}
            buffer={editingBuffer}
            tabId={actualTabId}
            wrap={settings.wordWrap}
            minimap={settings.minimap}
            fontSize={fontSize}
            fontFamily={settings.fontFamily}
            onDraft={onDocumentDraft}
            flushDraft={flushDrafts}
            onView={onDocumentView}
            onEditorFocus={onEditorFocus}
            onSearchInFiles={onSearchInFiles}
            reveal={reveal}
            error={sourceError}
            onError={onSourceError}
          />
        )}
        {surfaceProps && showMarkdown && (
          <SurfaceErrorBoundary key={surfaceAttempt} onFailure={onSurfaceFailure} onRetry={() => void controls.run('retry-surface')}>
            <Suspense fallback={<div className="qe-surface-loading" role="status" aria-live="polite"><NoticeLine>Loading Markdown surface…</NoticeLine></div>}>
              <MarkdownSurface {...surfaceProps} />
            </Suspense>
          </SurfaceErrorBoundary>
        )}
        {surfaceProps && showNotebook && (
          <SurfaceErrorBoundary key={surfaceAttempt} onFailure={onSurfaceFailure} onRetry={() => void controls.run('retry-surface')}>
            <Suspense fallback={<div className="qe-surface-loading" role="status" aria-live="polite"><NoticeLine>Loading notebook surface…</NoticeLine></div>}>
              <NotebookSurface {...surfaceProps} />
            </Suspense>
          </SurfaceErrorBoundary>
        )}
        {surfaceProps && showViewer && (
          <SurfaceErrorBoundary key={surfaceAttempt} onFailure={onSurfaceFailure} onRetry={() => void controls.run('retry-surface')}>
            <Suspense fallback={<div className="qe-surface-loading" role="status" aria-live="polite"><NoticeLine>Loading viewer…</NoticeLine></div>}>
              <ViewerSurface {...surfaceProps} />
            </Suspense>
          </SurfaceErrorBoundary>
        )}
        </SourceEditorControlScope>
      </div>
      <Dialog
        open={compareOpen}
        title="File changed on disk"
        onClose={() => void comparisonControls.run('close')}
        actions={
          <>
            {external === 'changed' && <Button onClick={() => void comparisonControls.run('reload')}>Reload</Button>}
            {external === 'changed' && <Button onClick={() => void comparisonControls.run('keep')}>Keep My Edits</Button>}
            <Button onClick={() => void comparisonControls.run('close')}>Close</Button>
          </>
        }
      >
        <div className="qe-compare-dialog">
          <p>{comparingDisk ? 'Disk version on the left, your unsaved edits on the right.' : 'Shared draft on the left, your preserved local edits on the right.'}</p>
          <div className="qe-compare-columns">
            <FormRow label={comparingDisk ? 'Disk version' : 'Shared draft'} htmlFor={`${compareId}-disk`}>
              <textarea
                id={`${compareId}-disk`}
                className="ui-text-field__input qe-compare-textarea"
                readOnly
                value={comparingDisk ? buffer.diskContent ?? '' : buffer.draft ?? buffer.content}
              />
            </FormRow>
            <FormRow label={comparingDisk ? 'Your edits' : 'Local edits'} htmlFor={`${compareId}-local`}>
              <textarea id={`${compareId}-local`} className="ui-text-field__input qe-compare-textarea" readOnly value={localText ?? buffer.draft ?? buffer.content} />
            </FormRow>
          </div>
        </div>
      </Dialog>
    </div>
  )
}