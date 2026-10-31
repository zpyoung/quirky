import { Component, Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FocusEvent as ReactFocusEvent, type ReactNode } from 'react'
import { Badge, Button, Dialog, FormRow, IconButton, TextField } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorBufferInfo, EditorSurfaceAction, EditorSurfaceBuffer, EditorSurfaceCommandHandler, EditorSurfaceCommandHandlers, SurfaceProps } from '../types'
import { activeDocument, registerActiveDocument, type ActiveDocumentCommand, type ActiveDocumentRegistration } from './activeDocument'
import { useEditorState, type EditorState } from './editorState'
import { openExplorerSearch } from './explorerIntent'
import { requestSingleClose } from './overlayState'
import { setEditorSetting, useEditorSettings } from './settings'
import { SourceEditor, type SourceEditorHandle } from './SourceEditor'
import { ChangesSurface } from './ChangesSurface'
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
          <Button onClick={() => { this.setState({ error: null }); this.props.onRetry() }}>Retry</Button>
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
  const compareId = useId()
  const [undoReloadUntil, setUndoReloadUntil] = useState(0)
  const [renamePath, setRenamePath] = useState<string | null>(null)
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
      acknowledgedBuffer.current = { content: buffer.content, draft: buffer.draft }
      ackRevision.current = Math.max(ackRevision.current, buffer.contentRevision)
      if (buffer.draft !== null) {
        localTextRef.current = buffer.draft
        setLocalText(buffer.draft)
      }
      return
    }
    const observation = { contentRevision: buffer.contentRevision, draft: buffer.draft }
    const pending = [...pendingDrafts.current.values()]
    if (pendingSaveAcknowledgement.current !== null) pending.push(pendingSaveAcknowledgement.current)
    const origin = classifyDraftUpdate(observation, ownDraftAcknowledgements.current, pending)
    if (origin === 'pending') return
    if (origin === 'acknowledged') {
      ackRevision.current = Math.max(ackRevision.current, buffer.contentRevision)
      if (buffer.draft === null && buffer.content === localTextRef.current) {
        localTextRef.current = null
        setLocalText(null)
        pendingDrafts.current.clear()
        pendingSaveAcknowledgement.current = null
        blockedDraft.current = false
        setDraftConflict(null)
        return
      }
      if (buffer.draft === localTextRef.current) {
        blockedDraft.current = false
        setDraftConflict(null)
      }
      return
    }
    if (buffer.contentRevision <= ackRevision.current) return
    blockedDraft.current = true
    setDraftConflict('A newer shared draft arrived. Your local text is preserved for comparison.')
  }, [buffer?.content, buffer?.contentRevision, buffer?.draft])

  useEffect(() => () => {
    if (undoReloadTimer.current !== undefined) window.clearTimeout(undoReloadTimer.current)
  }, [])

  useEffect(() => {
    const dismissOutside = (event: Event) => {
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
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('click', dismissOutside, true)
    document.addEventListener('focusin', dismissOutside)
    document.addEventListener('keydown', dismissEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('click', dismissOutside, true)
      document.removeEventListener('focusin', dismissOutside)
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

  const submitDraft = useCallback((content: string) => {
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
        if (localTextRef.current === content) {
          blockedDraft.current = false
          setDraftConflict(null)
        }
        const latest = bufferRef.current
        if (latest) setBuffer(mergeSurfaceBuffer(latest, updated, { content: latest.content, draft: acceptedDraft }))
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
      pendingSaveAcknowledgement.current = null
      throw reason
    }
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
  const canOfferChanges = buffer !== null &&
    (buffer.kind === 'text' || buffer.kind === 'markdown') &&
    !buffer.readOnly && !buffer.untitled && buffer.baseline !== null &&
    buffer.error === null && buffer.external !== 'deleted' && actualMode !== 'preview'
  const openChanges = useCallback(async () => {
    if (!canOfferChanges) return
    try {
      await flushActiveDocument()
      setUiError(null)
      setChangesOpen(true)
    } catch (reason) {
      const message = messageOf(reason)
      setUiError(message)
      context.toast('Changes could not be opened', message)
    }
  }, [canOfferChanges, context, flushActiveDocument])
  useEffect(() => {
    if (!canOfferChanges) setChangesOpen(false)
  }, [canOfferChanges])

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
    const selectedBuffer = bufferRef.current
    if (!selectedBuffer) return
    setChangesOpen(false)
    try {
      if (mode === 'preview' && selectedBuffer.kind === 'markdown') {
        await context.call('quirky.editor/open', {
          worktree: selectedBuffer.worktreeId,
          path: selectedBuffer.relativePath,
          mode: 'preview',
          preview: false,
          focus: true
        })
      } else if (actualMode === 'preview' && selectedBuffer.kind === 'markdown') {
        await flushActiveDocument()
        const updated = await context.call('quirky.editor/view', {
          bufferId: selectedBuffer.id,
          ...(actualTabId === null ? {} : { tabId: actualTabId }),
          action: 'returnToEdit',
          patch: { mode }
        }) as EditorBufferInfo
        const current = bufferRef.current
        if (current) setBuffer(mergeSurfaceBuffer(current, updated, { content: current.content, draft: current.draft }))
        refresh()
      } else {
        const updated = await context.call('quirky.editor/view', {
          bufferId: selectedBuffer.id,
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

  if (!buffer) {
    if (stateError) return <div className="qe-document-message" role="alert"><p>{stateError}</p><Button onClick={refresh}>Retry</Button></div>
    return <div className="qe-document-message" role="status">Loading document…</div>
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
  const saveButton = () => void save('user').catch(handleError)
  const closeButton = () => void requestSingleClose(context, buffer.id, actualTabId ?? undefined)
  const changeWrap = (value: boolean) => void saveSetting('editorWordWrap', value)
  const pathTitle = buffer.relativePath || buffer.name
  const changesBuffer = localText === null
    ? buffer
    : { ...buffer, draft: localText === buffer.content ? null : localText, dirty: localText !== buffer.content }

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
          <Button className="qe-document-path" title={buffer.path} onClick={() => void copyPath(false)}>{pathTitle}</Button>
          {buffer.dirty && <Badge tone="needs-you" label="Unsaved changes">●</Badge>}
          {buffer.external && <Badge tone="needs-you">{buffer.external === 'deleted' ? 'Deleted on disk' : 'Changed on disk'}</Badge>}
        </div>
        <div className="qe-document-actions">
          <div className="qe-document-action-strip">
            {buffer.kind === 'markdown' && (
              <div className="qe-mode-switch" aria-label="Markdown view mode">
                <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'source'} onClick={() => void openMode('source')}>Source</Button>
                <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'rich'} onClick={() => void openMode('rich')}>Rich Editor</Button>
                <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'preview'} onClick={() => void openMode('preview')}>Preview</Button>
              </div>
            )}
            {isNotebook && (
              <div className="qe-mode-switch" aria-label="Notebook view mode">
                <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'source'} onClick={() => void openMode('source')}>Source</Button>
                <Button className="qe-mode-switch__option" aria-pressed={actualMode !== 'source'} onClick={() => void openMode('rich')}>Notebook</Button>
              </div>
            )}
            {buffer.kind === 'csv' && (
              <div className="qe-mode-switch" aria-label="Table view mode">
                <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'source'} onClick={() => void openMode('source')}>Source</Button>
                <Button className="qe-mode-switch__option" aria-pressed={actualMode !== 'source'} onClick={() => void openMode('rich')}>Table</Button>
              </div>
            )}
            {buffer.kind === 'mermaid' && (
              <div className="qe-mode-switch" aria-label="Diagram view mode">
                <Button className="qe-mode-switch__option" aria-pressed={actualMode === 'source'} onClick={() => void openMode('source')}>Source</Button>
                <Button className="qe-mode-switch__option" aria-pressed={actualMode !== 'source'} onClick={() => void openMode('rich')}>Preview</Button>
              </div>
            )}
            {canOfferChanges && <Button
              aria-label={changesOpen ? 'Close Changes' : 'Changes'}
              aria-pressed={changesOpen}
              onClick={() => changesOpen ? setChangesOpen(false) : void openChanges()}
            >{changesOpen ? 'Close Changes' : 'Changes'}</Button>}
            {!buffer.readOnly && <Button variant="primary" onClick={saveButton} disabled={!buffer.untitled && !buffer.dirty && !buffer.external}>{buffer.untitled ? 'Save As…' : 'Save'}</Button>}
            <Button aria-pressed={buffer.pinned} title={buffer.pinned ? 'Unpin tab' : 'Pin tab'} onClick={() => void pin()}>{buffer.pinned ? 'Unpin' : 'Pin'}</Button>
            <Button onClick={() => context.togglePanel(EXPLORER_PANEL, true)}>Explorer</Button>
            <Button onClick={() => void sourceControl()}>Source Control</Button>
            <IconButton label="Close tab" variant="destructive" onClick={closeButton}>×</IconButton>
            <div className="qe-zoom-controls" aria-label="Editor font size">
              <IconButton label="Zoom out" onClick={() => void saveSetting('editorFontZoomLevel', Math.max(-6, settings.fontZoomLevel - 1))}>−</IconButton>
              <span>{fontSize} px</span>
              <IconButton label="Zoom in" onClick={() => void saveSetting('editorFontZoomLevel', Math.min(18, settings.fontZoomLevel + 1))}>+</IconButton>
              <Button aria-label="Reset zoom" onClick={() => void saveSetting('editorFontZoomLevel', 0)}>Reset</Button>
            </div>
          </div>
          <details ref={fileActionsRef} className="qe-file-actions">
            <summary className="qe-disclosure-trigger">File actions</summary>
            <div className="qe-file-actions-menu">
              <Button onClick={() => void copyPath(false)}>Copy Path</Button>
              <Button onClick={() => void copyPath(true)}>Copy Relative Path</Button>
              <Button onClick={() => void revealInExplorer()}>Reveal in Explorer</Button>
              <Button onClick={() => setRenamePath(buffer.relativePath)}>Rename…</Button>
              <Button onClick={() => void duplicateFile()}>Duplicate</Button>
              <Button variant="destructive" onClick={() => void deleteFile()}>Delete</Button>
              {buffer.kind === 'markdown' && <Button onClick={() => void openMode('preview')}>Open Markdown Preview</Button>}
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
      {!buffer.readOnly && buffer.diskWritable === false && (
        <section className="qe-permission-banner" role="status">
          This file is not writable with the current OS permissions. Editing and review notes remain available; Save keeps the draft until write access is restored.
        </section>
      )}
      {renamePath !== null && (
        <div className="qe-inline-rename">
          <TextField
            className="qe-inline-rename__field"
            label="Rename to"
            autoFocus
            value={renamePath}
            onChange={(event) => setRenamePath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void renameFile() }
              if (event.key === 'Escape') setRenamePath(null)
            }}
          />
          <Button variant="primary" onClick={() => void renameFile()}>Apply</Button>
          <Button onClick={() => setRenamePath(null)}>Cancel</Button>
        </div>
      )}
      {external && (
        <section className="qe-external-change-banner" role="status">
          <span>{external === 'deleted' ? 'This file was deleted on disk. An explicit save can recreate it.' : 'This file changed on disk while you have unsaved edits. Overwrite replaces the newer disk content.'}</span>
          <Button onClick={() => void runViewAction('compare').catch(handleError)}>Compare</Button>
          <Button onClick={() => void runViewAction('reload').catch(handleError)}>Reload from Disk</Button>
          {buffer.dirty && <Button variant="primary" onClick={() => void save('overwrite').catch(handleError)}>Overwrite</Button>}
          <Button title="Keeps your version. Your next save replaces the version on disk." onClick={() => void runViewAction('keep').catch(handleError)}>Keep My Edits</Button>
        </section>
      )}
      {undoReloadUntil > Date.now() && <Button className="qe-undo-reload" onClick={() => void runViewAction('undoReload').catch(handleError)}>Undo reload</Button>}
      {(uiError || settingsError || buffer.error || draftConflict) && (
        <div className="qe-document-error" role="alert">
          <span>{uiError ?? settingsError ?? draftConflict ?? buffer.error}</span>
          {buffer.error && <Button onClick={() => void context.call('quirky.editor/open', { worktree: buffer.worktreeId, path: buffer.relativePath, mode: actualMode, focus: true }).then(() => refresh()).catch(handleError)}>Retry</Button>}
          {draftConflict && <Button onClick={() => setCompareOpen(true)}>Compare local text</Button>}
        </div>
      )}
      <div className="qe-document-content">
        {showChanges && <ChangesSurface
          context={context}
          buffer={changesBuffer}
          tabId={actualTabId}
          fontSize={fontSize}
          fontFamily={settings.fontFamily}
          wrap={settings.wordWrap}
          minimap={settings.minimap}
          onDraft={submitDraft}
          flushDraft={flushDrafts}
          onView={updateView}
          onEditorFocus={focusEditor}
          onSearchInFiles={searchInFiles}
          error={sourceError}
          onError={setSourceError}
          registerCommandHandlers={registerCommandHandlers}
        />}
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
      <Dialog
        open={compareOpen}
        title="File changed on disk"
        onClose={() => setCompareOpen(false)}
        actions={
          <>
            {external && <Button onClick={() => { setCompareOpen(false); void runViewAction('reload').catch(handleError) }}>Reload</Button>}
            {external && <Button onClick={() => { setCompareOpen(false); void runViewAction('keep').catch(handleError) }}>Keep My Edits</Button>}
            <Button onClick={() => setCompareOpen(false)}>Close</Button>
          </>
        }
      >
        <div className="qe-compare-dialog">
          <p>Disk version on the left, your unsaved edits on the right.</p>
          <div className="qe-compare-columns">
            <FormRow label={external ? 'Disk version' : 'Shared draft'} htmlFor={`${compareId}-disk`}>
              <textarea
                id={`${compareId}-disk`}
                className="ui-text-field__input qe-compare-textarea"
                readOnly
                value={external ? (buffer.diskContent === undefined ? 'Disk content is not loaded. Retry Compare.' : buffer.diskContent ?? 'File deleted on disk.') : buffer.draft ?? buffer.content}
              />
            </FormRow>
            <FormRow label={external ? 'Your edits' : 'Local edits'} htmlFor={`${compareId}-local`}>
              <textarea id={`${compareId}-local`} className="ui-text-field__input qe-compare-textarea" readOnly value={localText ?? buffer.draft ?? buffer.content} />
            </FormRow>
          </div>
        </div>
      </Dialog>
    </div>
  )
}