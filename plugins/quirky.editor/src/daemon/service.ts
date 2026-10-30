import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, open as openFile, readFile, readdir, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { MethodHandler, PluginCaller, PluginContext, PluginStore, QuirkyEvent } from '@quirky/protocol'
import type {
  EditorBuffer,
  EditorOpenData,
  EditorMode,
  EditorOpenParams,
  EditorReadParams,
  EditorReadResult,
  EditorServices,
  EditorStateData,
  ExplorerParams,
  EditorTransferBeginParams,
  EditorTransferChunkParams,
  EditorTransferKind,
  EditorTransferParams,
  EditorTransferResult,
  EditorTransferStateResult
} from '../types'
import { editorMigrations, loadBufferMetrics, loadBuffers, saveBuffer, type BufferMetrics } from './store'
import { EditorWatcher } from './watcher'
import { WorktreePaths, type ResolvedWorktree } from './paths'
import { ContentsSearch } from './search'
import { ExplorerService } from './explorer'
import { FileInventory, normalizeRipgrepPath, parseQuickOpenTarget, QUICK_OPEN_MAX_ENTRIES, QUICK_OPEN_MAX_RESULTS, QUICK_OPEN_QUERY_MAX_BYTES } from './inventory'
import { MAX_READ_BYTES, MAX_TEXT_FILE_BYTES, guardedWrite, hashText, movePathWithoutOverwrite, probeWriteAccess, readByteRange, readSnapshot, type FileSnapshot } from './files'
import { KeyedQueue } from './queue'

export const EDITOR_DOCUMENT_VIEW = 'view:quirky.editor/document'
const EDITOR_CLOSE_COMMAND = 'command:quirky.editor/close'
const EDITOR_CLOSE_METHOD = 'quirky.editor/canClose'
const RECENT_PATH_LIMIT = 100
const RECENTLY_CLOSED_LIMIT = 10
const RELOAD_UNDO_WINDOW_MS = 8000
const AUTO_SAVE_MIN_DELAY = 250
const AUTO_SAVE_MAX_DELAY = 10000
const MAX_OPERATION_HISTORY = 50
const MAX_UPLOAD_FILES = 256
const MAX_UPLOAD_METADATA_BYTES = 256 * 1024
const MAX_UPLOAD_TOTAL_BYTES = MAX_TEXT_FILE_BYTES
const MAX_INLINE_RESPONSE_BYTES = 256 * 1024
const MAX_TEXT_CHUNK_LENGTH = 64 * 1024
const MAX_TRANSFER_CHUNK_BYTES = 65536
const MAX_ACTIVE_TRANSFERS = 4
const MAX_STAGED_TRANSFER_BYTES = 100 * 1024 * 1024
const TRANSFER_IDLE_MS = 5 * 60 * 1000
const PREVIEW_TITLE_SUFFIX = ' (Preview)'
const MAX_EDITOR_TAB_TITLE_LENGTH = 200
const editorTabTitle = (name: string, mode: EditorMode): string => mode === 'preview'
  ? `${name.slice(0, MAX_EDITOR_TAB_TITLE_LENGTH - PREVIEW_TITLE_SUFFIX.length)}${PREVIEW_TITLE_SUFFIX}`
  : name

const VIEW_KEYS = new Set([
'selection', 'cursor', 'cursorLine', 'cursorColumn', 'scrollTop', 'scrollLeft', 'scroll', 'zoom', 'scale', 'page', 'position',
'wordWrap', 'showWhitespace', 'tocVisible', 'markdownTocVisible', 'frontmatterVisible', 'collapsedFiles', 'search', 'find', 'sort', 'filter', 'mode',
'delimiter', 'viewer', 'focused', 'line', 'column', 'markdownAnchor', 'markdownFrontmatterVisible', 'matchLength'
])

type PrivateBuffer = BufferMetrics & {
  buffer: EditorBuffer
  autosaveHold: boolean
  verified: boolean
  generation: number
  transferHolds: Set<string>
  timer?: ReturnType<typeof setTimeout>
  inFlight?: Promise<EditorBuffer>
}

type TabMapping = {
  tabId: string
  worktreeId: string
  bufferId: string
  key: string
  mode: 'edit' | 'preview'
  inputMode: EditorMode
  group?: string
  preview: boolean
  pinned: boolean
}

type ClosedEditorTab = { worktreeId: string; path: string; mode: EditorMode; closedAt: number }
type ReloadUndo = { draft: string | null; held: boolean; afterBaseline: string; expiresAt: number }
type MutationResult = { path: string; buffer?: EditorBuffer; paths?: string[] }
type HistoryResult = { undo: number; redo: number; canUndo: boolean; canRedo: boolean; operation?: Record<string, unknown> }
type CoreStateParams = { bufferId?: string; worktree?: string }
type DraftParams = { bufferId: string; content: string; expectedRevision: number }
type SaveParams = { bufferId: string; trigger?: 'user' | 'autosave' | 'overwrite'; expectedRevision?: number }
type SaveOutcome =
  | { kind: 'saved'; buffer: EditorBuffer }
  | { kind: 'skipped'; buffer: EditorBuffer }
  | { kind: 'external'; external: 'deleted' | 'changed' }
  | { kind: 'permission-denied' }
type CloseParams = { bufferId: string; tabId?: string; choice?: 'save' | 'discard' | 'cancel' }
type SaveAsParams = { bufferId: string; path: string; expectedRevision: number }
type ViewParams = { bufferId: string; action?: string; tabId?: string; patch?: Record<string, unknown>; preview?: boolean }
type MutateParams = {
  worktree?: string
  action: 'createFile' | 'createFolder' | 'rename' | 'move' | 'duplicate' | 'delete' | 'import'
  path: string
  newPath?: string
  content?: string
  sourcePaths?: string[]
  files?: { name: string; data: string }[]
  yes?: boolean
}
type TerminalWorkspace = { id?: string; revision?: number; root?: unknown }
type OpenTabResult = { workspace: TerminalWorkspace; tab: string }

type HistoryOperation =
  | { kind: 'create'; worktreeId: string; root: string; path: string; directory: boolean; content: string | null; hash: string | null }
  | { kind: 'rename'; worktreeId: string; root: string; from: string; to: string; dev: number; ino: number; directory: boolean }
  | { kind: 'delete'; worktreeId: string; root: string; path: string; trashedPath: string; content: string; hash: string }
type ActiveTransfer = {
  transferId: string
  kind: EditorTransferKind
  stagePath: string
  totalBytes: number
  offset: number
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  bufferId?: string
  expectedRevision?: number
  worktreeId?: string
  root?: string
  relativePath?: string
  destinationPath?: string
  name?: string
}
type ImportCopyBudget = { bytes: number; files: number; metadataBytes: number; created: string[] }

export class EditorDaemon {
  readonly store: PluginStore
  readonly paths: WorktreePaths
  readonly services: EditorServices
  readonly methods: Record<string, MethodHandler>

  private readonly buffers = new Map<string, PrivateBuffer>()
  private readonly pathIndex = new Map<string, string>()
  private readonly tabs = new Map<string, TabMapping>()
  private readonly recentlyClosed: ClosedEditorTab[] = []
  private readonly reloadUndo = new Map<string, ReloadUndo>()
  private readonly closeRequests = new Map<string, { bufferId: string; tabId: string; dirty: boolean }>()
  private readonly ownWrites = new Map<string, { hash: string; expiresAt: number }>()
  private readonly transfers = new Map<string, ActiveTransfer>()
  private readonly transferQueue = new KeyedQueue()
  private readonly transferGateQueue = new KeyedQueue()
  private readonly transferDirectory: string
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly bufferQueue = new KeyedQueue()
  private readonly fileQueue = new KeyedQueue()
  private readonly closeListeners = new Set<(bufferId: string) => void>()
  private readonly inventory: FileInventory
  private readonly searchService: ContentsSearch
  private readonly explorerService: ExplorerService
  private readonly watcher: EditorWatcher
  private disposed = false
  private stateRevision = 0

  constructor(readonly context: PluginContext, store = context.openStore(editorMigrations)) {
    this.store = store
    this.transferDirectory = join(context.dataDir, 'editor-transfers')
    this.paths = new WorktreePaths(context)
    this.inventory = new FileInventory(context)
    this.searchService = new ContentsSearch(context, this.paths)
    this.explorerService = new ExplorerService(context, store, this.paths, this.inventory)
    const cachedMetrics = loadBufferMetrics(store)
    for (const buffer of loadBuffers(store)) {
      const hold = store.get<{ autosave_hold: number }>('SELECT autosave_hold FROM editor_buffers WHERE id=?', buffer.id)?.autosave_hold === 1
      const metrics = cachedMetrics.get(buffer.id) ?? {
        contentBytes: Buffer.byteLength(buffer.content, 'utf8'),
        contentLength: buffer.content.length,
        draftBytes: buffer.draft === null ? null : Buffer.byteLength(buffer.draft, 'utf8'),
        draftLength: buffer.draft === null ? null : buffer.draft.length,
        diskContentBytes: buffer.diskContent === null ? null : Buffer.byteLength(buffer.diskContent, 'utf8'),
        diskContentLength: buffer.diskContent === null ? null : buffer.diskContent.length,
        diskSignature: null,
        placeholderHash: null,
        placeholderDev: null,
        placeholderIno: null,
        placeholderTemplate: false,
        placeholderEdited: false
      }
      const state: PrivateBuffer = { ...metrics, buffer, autosaveHold: hold, verified: false, generation: 0, transferHolds: new Set() }
      this.buffers.set(buffer.id, state)
      this.pathIndex.set(this.pathKey(buffer.worktreeId, buffer.path), buffer.id)
    }
    this.watcher = new EditorWatcher({
      change: (worktreeId, path) => this.scheduleReconcile(worktreeId, path)
    })
    this.services = {
      context,
      store,
      get: (bufferId) => this.get(bufferId),
      resolve: (worktree, caller) => this.paths.resolve(worktree, caller),
      path: (worktreeId, path, options) => this.paths.path(worktreeId, path, options).then((authorized) => authorized.path),
      draft: (bufferId, content, expectedRevision) => this.draft(bufferId, content, expectedRevision),
      save: (bufferId, trigger, expectedRevision) => this.save(bufferId, trigger, expectedRevision),
      markUntitled: (bufferId, templateCreated) => this.markUntitled(bufferId, templateCreated),
      readBytes: (bufferId, offset, length) => this.readBytes(bufferId, offset, length),
      updateView: (bufferId, patch) => this.updateView(bufferId, patch),
      emit: () => this.emit(),
      onClose: (listener) => this.onClose(listener)
    }
    this.methods = {
      documentRoot: (params, caller) => this.paths.resolve(params.worktree as string | undefined, caller),
      open: (params, caller) => this.open(params as unknown as EditorOpenParams, caller),
      state: (params, caller) => this.state(params as CoreStateParams, caller),
      draft: (params) => {
        const request = params as unknown as DraftParams
        return this.draft(request.bufferId, request.content, request.expectedRevision)
      },
      save: (params) => this.save((params as SaveParams).bufferId, (params as SaveParams).trigger, (params as SaveParams).expectedRevision),
      saveAs: (params) => this.saveAs(params as SaveAsParams),
      close: (params) => this.close(params as unknown as CloseParams),
      canClose: (params) => this.canClose(params as unknown as CloseParams),
      reopen: (params, caller) => this.reopen(params as { worktree?: string; focus?: boolean }, caller),
      view: (params) => this.view(params as ViewParams),
      explorer: async (params, caller) => {
        const request = params as ExplorerParams
        const result = await this.explorerService.call(request, caller)
        if (request.action === 'navigate' || request.action === 'select' || request.action === 'reveal' || request.action === 'preferences') {
          this.emit()
        }
        return result
      },
      mutate: (params, caller) => this.mutate(params as MutateParams, caller),
      history: (params, caller) => this.fileHistory(params as { worktree?: string; action: 'state' | 'undo' | 'redo' }, caller),
      quickOpen: (params, caller) => this.quickOpen(params as { worktree?: string; action: 'search' | 'record' | 'history' | 'clearHistory'; query?: string; path?: string; limit?: number }, caller),
      search: (params, caller) => this.searchService.call(params as Parameters<ContentsSearch['call']>[0], caller),
      read: (params) => this.read(params as EditorReadParams),
      transfer: (params, caller) => this.transfer(params as EditorTransferParams, caller),
      setupConfirmation: (params) => this.setupConfirmation(params)
    }
  }

  async restore(): Promise<void> {
    await this.cleanTransferStaging()
    for (const [id, state] of this.buffers) {
      try {
        await this.reconcileBuffer(id, 'restore')
        state.verified = state.buffer.baseline !== null && state.buffer.external === null
      } catch (error) {
        state.verified = false
        this.updateError(state, error instanceof Error ? error.message : String(error))
      }
      this.watcher.keep(state.buffer.worktreeId, state.buffer.root)
    }
    const worktrees = new Set([...this.buffers.values()].map((state) => state.buffer.worktreeId))
    for (const worktreeId of worktrees) await this.syncTerminalWorkspace(worktreeId).catch(() => undefined)
    for (const state of this.buffers.values()) this.scheduleAutosave(state)
  }

  get(bufferId: string): EditorBuffer {
    const state = this.buffers.get(bufferId)
    if (state === undefined) throw this.context.error('not-found', `editor buffer not found: ${bufferId}`)
    return state.buffer
  }

  async open(params: EditorOpenParams, caller: PluginCaller): Promise<EditorOpenData> {
    this.assertActive()
    if (typeof params.path !== 'string' || params.path.length === 0) throw this.context.error('invalid-params', 'path is required')
    if (params.line !== undefined && (!Number.isSafeInteger(params.line) || params.line < 1)) throw this.context.error('invalid-params', 'line must be a positive integer')
    if (params.column !== undefined && (!Number.isSafeInteger(params.column) || params.column < 1)) throw this.context.error('invalid-params', 'column must be a positive integer')
    if (params.matchLength !== undefined && (!Number.isSafeInteger(params.matchLength) || params.matchLength < 0 || params.matchLength > MAX_TEXT_FILE_BYTES || params.line === undefined || params.column === undefined)) {
      throw this.context.error('invalid-params', 'matchLength requires a line and column and must be a bounded non-negative integer')
    }
    const worktree = await this.paths.resolve(params.worktree, caller)
    const target = await this.paths.path(worktree.id, params.path)
    let info
    try {
      info = await stat(target.path)
    } catch (error) {
      throw this.translateFsError(error, target.path)
    }
    if (info.isDirectory()) throw this.context.error('invalid-params', 'Choose a file rather than a directory.')
    const key = this.pathKey(worktree.id, target.path)
    let bufferId = this.pathIndex.get(key)
    let state = bufferId === undefined ? undefined : this.buffers.get(bufferId)
    if (state === undefined) {
      const snapshot = await this.readSnapshot(target.path)
      const mode = this.defaultMode(snapshot.kind, params.mode)
      const view: Record<string, unknown> = {
        ...(params.line === undefined ? {} : { line: params.line }),
        ...(params.column === undefined ? {} : { column: params.column }),
        ...(params.matchLength === undefined ? {} : { matchLength: params.matchLength })
      }
      if (params.line !== undefined && snapshot.kind === 'markdown') view.source = true
      const buffer: EditorBuffer = {
        id: randomUUID(),
        worktreeId: worktree.id,
        root: worktree.path,
        path: target.path,
        relativePath: target.relativePath,
        name: basename(target.path),
        kind: snapshot.kind,
        content: snapshot.text ?? '',
        draft: null,
        baseline: snapshot.hash,
        size: snapshot.size,
        readOnly: snapshot.readOnly,
        diskWritable: snapshot.diskWritable,
        dirty: false,
        external: null,
        diskContent: null,
        mode: params.line !== undefined && snapshot.kind === 'markdown' ? 'source' : mode,
        tabId: null,
        preview: false,
        pinned: false,
        untitled: false,
        revision: 1,
        contentRevision: 1,
        view,
        error: null
      }
      state = {
        buffer,
        contentBytes: Buffer.byteLength(buffer.content, 'utf8'),
        contentLength: buffer.content.length,
        draftBytes: null,
        draftLength: null,
        diskContentBytes: null,
        diskContentLength: null,
        diskSignature: null,
        placeholderHash: null,
        placeholderDev: null,
        placeholderIno: null,
        placeholderTemplate: false,
        placeholderEdited: false,
        autosaveHold: false,
        verified: true,
        generation: 0,
        transferHolds: new Set()
      }
      bufferId = buffer.id
      this.buffers.set(bufferId, state)
      this.pathIndex.set(key, bufferId)
      this.persist(state)
      this.emit()
    } else {
      await this.reconcileBuffer(state.buffer.id, 'open')
      state = this.requireState(state.buffer.id)
      state.verified = state.buffer.baseline !== null && state.buffer.external === null
    }

    const buffer = state.buffer
    const mode = params.line !== undefined && buffer.kind === 'markdown' ? 'source' : (params.mode ?? buffer.mode)
    const terminalPreview = params.preview === true && params.pinned !== true && this.setting('editorPreviewTabsEnabled', true)
    if (params.group !== undefined || terminalPreview) await this.syncTerminalWorkspace(worktree.id)
    const existingModeTab = this.tabsForBuffer(buffer.id).find((tab) =>
      (params.group === undefined || tab.group === params.group) &&
      (mode === 'preview' ? tab.inputMode === 'preview' : tab.inputMode !== 'preview')
    )
    const defaultKey = mode === 'preview' ? `preview:${buffer.id}` : buffer.id
    let keyValue = existingModeTab?.key ?? defaultKey
    if (params.group !== undefined && existingModeTab === undefined &&
      [...this.tabs.values()].some((tab) => tab.worktreeId === worktree.id && tab.key === keyValue)) {
      keyValue = `editor:${buffer.id}:${params.group}`
    }
    const reuse = params.group === undefined || existingModeTab !== undefined
    const replaceablePreview = terminalPreview && existingModeTab === undefined
      ? [...this.tabs.values()].find((tab) =>
        tab.worktreeId === worktree.id && tab.preview && !tab.pinned &&
        (params.group === undefined || tab.group === params.group)
      )
      : undefined
    const focus = params.focus ?? caller.role === 'ui'
    const result = await this.context.call('quirky.terminal/openViewTab', {
      workspace: `id:${worktree.id}`,
      ...(params.group === undefined ? {} : { group: params.group }),
      viewId: EDITOR_DOCUMENT_VIEW,
      key: keyValue,
      input: { bufferId: buffer.id, mode },
      title: editorTabTitle(buffer.name, mode),
      reuse,
      ...(replaceablePreview === undefined ? {} : { replace: replaceablePreview.tabId }),
      activate: focus,
      closeCommand: EDITOR_CLOSE_COMMAND,
      closeMethod: EDITOR_CLOSE_METHOD,
      closeParams: { bufferId: buffer.id },
      preview: terminalPreview
    }) as OpenTabResult
    const tabId = result.tab
    this.syncWorkspaceValue(worktree.id, result.workspace)
    if (!this.tabs.has(tabId)) throw this.context.error('conflict', 'Terminal did not persist the opened editor tab.')
    if (params.pinned === true) {
      const pinned = await this.context.call('quirky.terminal/pinTab', { tab: tabId, pinned: true }) as { workspace?: TerminalWorkspace }
      if (pinned.workspace !== undefined) this.syncWorkspaceValue(worktree.id, pinned.workspace)
    }
    const fresh = this.requireState(buffer.id)
    const tabSummary = this.bufferTabSummary(buffer.id)
    const updated = {
      ...fresh.buffer,
      mode,
      ...tabSummary
    }
    if (updated.mode !== fresh.buffer.mode || updated.preview !== fresh.buffer.preview || updated.tabId !== fresh.buffer.tabId || updated.pinned !== fresh.buffer.pinned) {
      this.commit(fresh, updated, false)
    }
    await this.updateTabModes(buffer.id, mode)
    const presentation: Record<string, unknown> = {}
    if (params.line !== undefined) presentation.line = params.line
    if (params.column !== undefined) presentation.column = params.column
    if (params.matchLength !== undefined) presentation.matchLength = params.matchLength
    if (Object.keys(presentation).length > 0) await this.applyViewPatch(buffer.id, presentation, tabId)
    this.watcher.keep(worktree.id, worktree.path)
    await this.recordQuickOpen(worktree.id, buffer.relativePath)
    return { ...this.get(buffer.id), openedTabId: tabId }
  }

  async state(params: CoreStateParams = {}, caller?: PluginCaller): Promise<EditorStateData> {
    const ids = new Set<string>()
    if (params.worktree !== undefined) ids.add((await this.paths.resolve(params.worktree, caller)).id)
    else if (caller !== undefined && caller.role !== 'plugin' && (caller.worktreeId !== undefined || caller.cwd !== undefined)) {
      ids.add((await this.paths.resolve(undefined, caller)).id)
    }
    const allStates = [...this.buffers.values()]
    const filtered = allStates.filter((state) =>
      (params.bufferId === undefined || state.buffer.id === params.bufferId) &&
      (ids.size === 0 || ids.has(state.buffer.worktreeId))
    )
    const worktreeIds = ids.size > 0 ? [...ids] : [...new Set(filtered.map((state) => state.buffer.worktreeId))]
    for (const worktreeId of worktreeIds) await this.syncTerminalWorkspace(worktreeId).catch(() => undefined)
    const buffers = filtered.map((state) => state.buffer).sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.id.localeCompare(b.id))
    const tabs = [...this.tabs.values()]
      .filter((tab) => (ids.size === 0 || ids.has(tab.worktreeId)) && (params.bufferId === undefined || tab.bufferId === params.bufferId))
      .map(({ tabId, bufferId, mode, group }) => ({ tabId, bufferId, mode, ...(group === undefined ? {} : { group }) }))
    const selectedWorktree = worktreeIds[0] ?? filtered[0]?.buffer.worktreeId ?? ''
    const histories = this.store.all<{ worktree_id: string; path: string }>(
      `SELECT worktree_id, path FROM editor_quick_open_history
       ${selectedWorktree === '' ? '' : 'WHERE worktree_id=?'} ORDER BY visited_at DESC`,
      ...(selectedWorktree === '' ? [] : [selectedWorktree])
    )
    const groupedHistory = new Map<string, string[]>()
    for (const item of histories) {
      const paths = groupedHistory.get(item.worktree_id) ?? []
      if (paths.length < RECENT_PATH_LIMIT) paths.push(item.path)
      groupedHistory.set(item.worktree_id, paths)
    }
    const explorer = selectedWorktree === ''
      ? { worktreeId: '', showDotfiles: true, expanded: [] }
      : this.explorerService.snapshot(selectedWorktree)
    const search = selectedWorktree === '' ? null : await this.searchService.call({ worktree: `id:${selectedWorktree}`, action: 'state' })
    return {
      buffers,
      tabs,
      explorer,
      search,
      quickOpenHistory: [...groupedHistory].map(([worktreeId, paths]) => ({ worktreeId, paths })),
      closeRequests: [...this.closeRequests.values()].filter((request) => params.bufferId === undefined || request.bufferId === params.bufferId)
    }
  }

  async draft(bufferId: string, content: string, expectedRevision: number): Promise<EditorBuffer> {
    return await this.updateDraft(bufferId, content, expectedRevision)
  }
  async markUntitled(bufferId: string, templateCreated: boolean): Promise<EditorBuffer> {
    if (typeof templateCreated !== 'boolean') throw this.context.error('invalid-params', 'templateCreated must be a boolean.')
    const initial = this.requireState(bufferId)
    const original = initial.buffer
    if (original.kind !== 'markdown' || original.untitled || original.dirty || original.draft !== null || original.baseline === null) {
      throw this.context.error('conflict', 'Only a clean Markdown file with a verified baseline can become an untitled placeholder.')
    }
    const path = original.path
    const keys = await this.fileKeys(path)
    return await this.fileQueue.run(keys, async () => {
      const snapshot = await this.tryReadSnapshot(path)
      if (snapshot === null || snapshot.hash !== original.baseline) {
        throw this.context.error('conflict', 'The Markdown placeholder changed before it could be marked untitled.')
      }
      const before = await lstat(path)
      if (!before.isFile() || before.isSymbolicLink()) {
        throw this.context.error('conflict', 'The Markdown placeholder is no longer a regular file.')
      }
      const after = await lstat(path)
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw this.context.error('conflict', 'The Markdown placeholder was replaced before it could be marked untitled.')
      }
      return await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
        const current = this.requireState(bufferId)
        if (current.buffer.path !== path || current.buffer.untitled || current.buffer.kind !== 'markdown' ||
          current.buffer.baseline !== snapshot.hash || current.buffer.dirty || current.buffer.draft !== null) {
          throw this.context.error('conflict', 'The Markdown buffer changed before it could be marked untitled.')
        }
        current.placeholderHash = snapshot.hash
        current.placeholderDev = after.dev
        current.placeholderIno = after.ino
        current.placeholderTemplate = templateCreated
        current.placeholderEdited = false
        this.commit(current, { ...current.buffer, untitled: true, revision: current.buffer.revision + 1 }, false)
        return current.buffer
      })
    })
  }

  private async updateDraft(bufferId: string, content: string, expectedRevision: number, transferId?: string): Promise<EditorBuffer> {
    this.assertActive()
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) throw this.context.error('invalid-params', `draft exceeds the ${MAX_TEXT_FILE_BYTES}-byte editor limit`)
    const result = await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
      const state = this.requireState(bufferId)
      const current = state.buffer
      if (state.transferHolds.size > 0 && (transferId === undefined || !state.transferHolds.has(transferId))) {
        throw this.context.error('conflict', 'A draft transfer is in progress for this buffer.')
      }
      if (current.readOnly) throw this.context.error('invalid-params', 'This file is read-only.')
      if (!Number.isInteger(expectedRevision) || expectedRevision !== current.contentRevision) {
        throw Object.assign(this.context.error('conflict', `stale editor content revision: expected ${expectedRevision}, current ${current.contentRevision}`), {
          data: { expectedRevision, currentRevision: current.contentRevision }
        })
      }
      const changed = (current.draft ?? current.content) !== content
      if (changed && current.untitled) state.placeholderEdited = true
      const next: EditorBuffer = {
        ...current,
        draft: content === current.content ? null : content,
        dirty: content !== current.content,
        ...(changed ? { contentRevision: current.contentRevision + 1 } : {}),
        revision: current.revision + 1,
        error: null
      }
      this.commit(state, next, false)
      this.scheduleAutosave(state)
      return { buffer: state.buffer, promote: state.buffer.preview }
    })
    if (result.promote) await this.promoteBuffer(bufferId)
    return this.get(bufferId)
  }

  async save(bufferId: string, trigger: SaveParams['trigger'] = 'user', expectedRevision?: number): Promise<EditorBuffer> {
    this.assertActive()
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw this.context.error('invalid-params', 'expectedRevision must be a non-negative safe integer.')
    }
    const state = this.requireState(bufferId)
    const existing = state.inFlight
    if (existing !== undefined && trigger === 'autosave') return await existing
    const generation = state.generation
    const promise = this.transferGateQueue.run([`transfer-gate:${bufferId}`], () => this.performSave(bufferId, trigger, generation, expectedRevision))
    state.inFlight = promise
    try {
      return await promise
    } finally {
      const current = this.buffers.get(bufferId)
      if (current?.inFlight === promise) current.inFlight = undefined
    }
  }
  async saveAs(params: SaveAsParams): Promise<EditorBuffer> {
    this.assertActive()
    if (typeof params.bufferId !== 'string' || params.bufferId.length === 0) {
      throw this.context.error('invalid-params', 'bufferId is required.')
    }
    if (typeof params.path !== 'string' || params.path.length === 0 || params.path.includes('\0') ||
      params.path.endsWith('/') || params.path.includes('\\') || isAbsolute(params.path) || params.path.split('/').includes('..') ||
      !['.md', '.markdown', '.mdx'].includes(extname(params.path).toLowerCase())) {
      throw this.context.error('invalid-params', 'Save As requires an authorized worktree-relative Markdown path without traversal.')
    }
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
      throw this.context.error('invalid-params', 'expectedRevision must be a non-negative safe integer.')
    }
    const initial = this.requireState(params.bufferId)
    const original = initial.buffer
    if (original.kind !== 'markdown' || !original.untitled || initial.placeholderHash === null ||
      initial.placeholderDev === null || initial.placeholderIno === null) {
      throw this.context.error('invalid-params', 'Only an untitled Markdown buffer can be saved to a new path.')
    }
    if (params.expectedRevision !== original.contentRevision) {
      throw Object.assign(this.context.error('conflict', `stale editor content revision: expected ${params.expectedRevision}, current ${original.contentRevision}`), {
        data: { expectedRevision: params.expectedRevision, currentRevision: original.contentRevision }
      })
    }
    if (initial.transferHolds.size > 0) throw this.context.error('conflict', 'A text transfer is in progress for this buffer.')
    const destination = await this.paths.path(original.worktreeId, params.path, { create: true })
    const sourcePath = original.path
    const sourceKeys = await this.fileKeys(sourcePath)
    const destinationKeys = await this.fileKeys(destination.path)
    const fileKeys = [...new Set([...sourceKeys, ...destinationKeys])]

    return await this.fileQueue.run(fileKeys, async () => await this.bufferQueue.run([`buffer:${params.bufferId}`], async () => {
      const current = this.requireState(params.bufferId)
      const currentBuffer = current.buffer
      if (currentBuffer.path !== sourcePath || !currentBuffer.untitled || currentBuffer.kind !== 'markdown' ||
        current.placeholderHash === null || current.placeholderDev === null || current.placeholderIno === null) {
        throw this.context.error('conflict', 'The untitled buffer changed before Save As could complete.')
      }
      if (params.expectedRevision !== currentBuffer.contentRevision) {
        throw Object.assign(this.context.error('conflict', `stale editor content revision: expected ${params.expectedRevision}, current ${currentBuffer.contentRevision}`), {
          data: { expectedRevision: params.expectedRevision, currentRevision: currentBuffer.contentRevision }
        })
      }
      if (current.transferHolds.size > 0) throw this.context.error('conflict', 'A text transfer is in progress for this buffer.')
      const authorized = await this.paths.path(currentBuffer.worktreeId, params.path, { create: true })
      if (authorized.path !== destination.path) throw this.context.error('conflict', 'The Save As destination changed while it was being authorized.')
      await mkdir(dirname(destination.path), { recursive: true })
      const reauthorized = await this.paths.path(currentBuffer.worktreeId, params.path, { create: true })
      if (reauthorized.path !== destination.path) throw this.context.error('conflict', 'The Save As destination changed while it was being prepared.')

      const content = currentBuffer.draft ?? currentBuffer.content
      const contentBytes = Buffer.byteLength(content, 'utf8')
      if (contentBytes > MAX_TEXT_FILE_BYTES) throw this.context.error('invalid-params', `file exceeds the ${MAX_TEXT_FILE_BYTES}-byte save limit`)
      const contentHash = hashText(content)
      const stagePath = join(dirname(destination.path), `.${basename(destination.path)}.${randomUUID()}.tmp`)
      let stageIdentity: { dev: number; ino: number } | null = null
      let destinationIdentity: { dev: number; ino: number } | null = null
      const oldPlaceholder = {
        hash: current.placeholderHash!,
        dev: current.placeholderDev!,
        ino: current.placeholderIno!
      }
      let nextBuffer: EditorBuffer
      const nextMetrics: BufferMetrics = {
        contentBytes,
        contentLength: content.length,
        draftBytes: null,
        draftLength: null,
        diskContentBytes: null,
        diskContentLength: null,
        diskSignature: null,
        placeholderHash: null,
        placeholderDev: null,
        placeholderIno: null,
        placeholderTemplate: false,
        placeholderEdited: false
      }
      try {
        const staged = await openFile(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        try {
          const info = await staged.stat()
          stageIdentity = { dev: info.dev, ino: info.ino }
          await staged.writeFile(content, 'utf8')
          await staged.sync()
        } finally {
          await staged.close()
        }
        const stagedSnapshot = await readSnapshot(stagePath)
        const stagedInfo = await lstat(stagePath)
        if (stageIdentity === null || stagedInfo.dev !== stageIdentity.dev || stagedInfo.ino !== stageIdentity.ino ||
          stagedSnapshot.hash !== contentHash) {
          throw this.context.error('conflict', 'The staged Save As file changed before it could be installed.')
        }
        try {
          await link(stagePath, destination.path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
            throw this.context.error('conflict', `Destination already exists: ${destination.relativePath}`)
          }
          throw error
        }
        destinationIdentity = { dev: stagedInfo.dev, ino: stagedInfo.ino }
        const installedInfo = await lstat(destination.path)
        const installedSnapshot = await readSnapshot(destination.path)
        if (installedInfo.dev !== destinationIdentity.dev || installedInfo.ino !== destinationIdentity.ino ||
          installedSnapshot.hash !== contentHash) {
          throw this.context.error('conflict', 'The Save As destination changed before it could be committed.')
        }
        await unlink(stagePath)
        stageIdentity = null

        nextBuffer = {
          ...currentBuffer,
          path: destination.path,
          relativePath: destination.relativePath,
          name: basename(destination.path),
          content,
          draft: null,
          baseline: contentHash,
          size: contentBytes,
          diskWritable: installedSnapshot.diskWritable,
          dirty: false,
          external: null,
          diskContent: null,
          untitled: false,
          error: null,
          revision: currentBuffer.revision + 1,
          contentRevision: currentBuffer.contentRevision + Number(currentBuffer.content !== content || currentBuffer.draft !== null)
        }
        this.store.transaction(() => {
          saveBuffer(this.store, nextBuffer, false, nextMetrics)
          const rows = this.store.all<{ id: string; payload: string }>(
            'SELECT id, payload FROM editor_notes WHERE buffer_id = ?',
            params.bufferId
          )
          for (const row of rows) {
            let note: unknown
            try {
              note = JSON.parse(row.payload)
            } catch {
              throw this.context.error('conflict', `Markdown note ${row.id} could not be retargeted safely.`)
            }
            if (note === null || typeof note !== 'object' || Array.isArray(note) || typeof (note as Record<string, unknown>).filePath !== 'string') {
              throw this.context.error('conflict', `Markdown note ${row.id} has no safe file path to retarget.`)
            }
            const updatedPayload = { ...(note as Record<string, unknown>), filePath: destination.relativePath }
            const result = this.store.run(
              'UPDATE editor_notes SET payload = ? WHERE id = ? AND buffer_id = ? AND payload = ?',
              JSON.stringify(updatedPayload),
              row.id,
              params.bufferId,
              row.payload
            )
            if (result.changes === 0) throw this.context.error('conflict', `Markdown note ${row.id} changed while Save As was committing.`)
          }
        })
      } catch (error) {
        if (destinationIdentity !== null) {
          await this.unlinkIfMatches(destination.path, contentHash, destinationIdentity.dev, destinationIdentity.ino)
        }
        if (stageIdentity !== null) {
          await this.unlinkIfMatches(stagePath, contentHash, stageIdentity.dev, stageIdentity.ino)
        }
        throw error
      }

      current.buffer = nextBuffer
      current.contentBytes = nextMetrics.contentBytes
      current.contentLength = nextMetrics.contentLength
      current.draftBytes = null
      current.draftLength = null
      current.diskContentBytes = null
      current.diskContentLength = null
      current.diskSignature = null
      current.placeholderHash = null
      current.placeholderDev = null
      current.placeholderIno = null
      current.placeholderTemplate = false
      current.placeholderEdited = false
      current.autosaveHold = false
      current.verified = true
      this.cancelAutosave(current)
      this.pathIndex.delete(this.pathKey(currentBuffer.worktreeId, sourcePath))
      this.pathIndex.set(this.pathKey(currentBuffer.worktreeId, destination.path), params.bufferId)
      this.ownWrites.set(destination.path, { hash: contentHash, expiresAt: Date.now() + 3000 })
      const tabs = this.tabsForBuffer(params.bufferId)
      if (tabs.length > 0) {
        const result = await this.context.call('quirky.terminal/rekeyViewTabs', {
          workspace: `id:${currentBuffer.worktreeId}`,
          viewId: EDITOR_DOCUMENT_VIEW,
          changes: tabs.map((tab) => ({
            tab: tab.tabId,
            key: tab.key,
            input: { bufferId: params.bufferId, mode: tab.inputMode },
            title: editorTabTitle(nextBuffer.name, tab.inputMode),
            preview: tab.preview
          }))
        }) as { workspace?: TerminalWorkspace }
        if (result.workspace !== undefined) this.syncWorkspaceValue(currentBuffer.worktreeId, result.workspace)
      }
      await this.unlinkIfMatches(sourcePath, oldPlaceholder.hash, oldPlaceholder.dev, oldPlaceholder.ino)
      this.inventory.invalidate(currentBuffer.root)
      this.emit()
      return current.buffer
    }))
  }

  async readBytes(bufferId: string, offset: number, length: number): Promise<{ data: string; eof: boolean; size: number }> {
    const buffer = this.get(bufferId)
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_READ_BYTES) throw this.context.error('invalid-params', `length must be between 0 and ${MAX_READ_BYTES}`)
    const authorized = await this.paths.path(buffer.worktreeId, buffer.relativePath)
    return await readByteRange(authorized.path, offset, length)
  }

  async updateView(bufferId: string, patch: Record<string, unknown>): Promise<EditorBuffer> {
    return await this.applyViewPatch(bufferId, patch)
  }

  onClose(listener: (bufferId: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  emit(): void {
    if (this.disposed) return
    this.stateRevision++
    this.context.emit('changed', { revision: this.stateRevision })
  }
  projectPublic(method: string, value: unknown): unknown {
    const budget = { remaining: method === 'state' ? 0 : 256 * 1024 }
    return this.projectValue(value, budget, method !== 'state')
  }

  private projectValue(value: unknown, budget: { remaining: number }, allowInline: boolean): unknown {
    if (Array.isArray(value)) return value.map((item) => this.projectValue(item, budget, allowInline))
    if (value === null || typeof value !== 'object') return value
    if (this.isBufferValue(value)) {
      const buffer = value as EditorBuffer
      const state = this.buffers.get(buffer.id)
      const contentBytes = state?.contentBytes ?? Buffer.byteLength(buffer.content, 'utf8')
      const contentLength = state?.contentLength ?? buffer.content.length
      const draftBytes = buffer.draft === null ? null : (state?.draftBytes ?? Buffer.byteLength(buffer.draft, 'utf8'))
      const draftLength = buffer.draft === null ? null : (state?.draftLength ?? buffer.draft.length)
      const diskContentBytes = buffer.diskContent === null ? null : (state?.diskContentBytes ?? Buffer.byteLength(buffer.diskContent, 'utf8'))
      const diskContentLength = buffer.diskContent === null ? null : (state?.diskContentLength ?? buffer.diskContent.length)
      const info: Record<string, unknown> = { ...buffer, contentLength, draftLength, diskContentLength, contentBytes, draftBytes, diskContentBytes, diskSignature: state?.diskSignature ?? null }
      delete info.content
      delete info.draft
      delete info.diskContent
      if (allowInline) {
        if (contentBytes <= budget.remaining) {
          info.content = buffer.content
          budget.remaining -= contentBytes
        }
        if (buffer.draft === null) {
          info.draft = null
        } else if (draftBytes !== null && draftBytes <= budget.remaining) {
          info.draft = buffer.draft
          budget.remaining -= draftBytes
        }
        if (buffer.diskContent === null) {
          info.diskContent = null
        } else if (diskContentBytes !== null && diskContentBytes <= budget.remaining) {
          info.diskContent = buffer.diskContent
          budget.remaining -= diskContentBytes
        }
      }
      return info
    }
    const projected: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) projected[key] = this.projectValue(item, budget, allowInline)
    return projected
  }

  private isBufferValue(value: object): value is EditorBuffer {
    const candidate = value as Partial<EditorBuffer>
    return typeof candidate.id === 'string' && typeof candidate.worktreeId === 'string' &&
      typeof candidate.content === 'string' && typeof candidate.contentRevision === 'number' &&
      (typeof candidate.draft === 'string' || candidate.draft === null)
  }


  async close(params: CloseParams): Promise<{ closed: boolean; needsDecision?: boolean }> {
    const state = this.requireState(params.bufferId)
    if (state.transferHolds.size > 0) return { closed: false, needsDecision: true }
    let tabId = params.tabId
    if (tabId === undefined) tabId = this.editTabsForBuffer(params.bufferId)[0]?.tabId
    if (tabId === undefined) return { closed: true }
    let mapping = this.tabs.get(tabId)
    if (mapping === undefined || mapping.bufferId !== params.bufferId) {
      await this.syncTerminalWorkspace(state.buffer.worktreeId)
      mapping = this.tabs.get(tabId)
    }
    if (mapping === undefined || mapping.bufferId !== params.bufferId) return { closed: true }
    const renderedPreview = mapping.mode === 'preview'
    const remainingEditTabs = this.editTabsForBuffer(params.bufferId).filter((tab) => tab.tabId !== tabId)
    const lastEdit = !renderedPreview && remainingEditTabs.length === 0
    const dirty = state.buffer.dirty && lastEdit
    if (dirty && params.choice === undefined) {
      this.closeRequests.set(tabId, { bufferId: params.bufferId, tabId, dirty: true })
      return { closed: false, needsDecision: true }
    }
    if (dirty && params.choice === 'cancel') {
      this.closeRequests.delete(tabId)
      return { closed: false }
    }
    if (dirty && params.choice === 'save') await this.save(params.bufferId, 'user')
    if (dirty && params.choice === 'discard') {
      await this.quiesce(state)
      await this.bufferQueue.run([`buffer:${params.bufferId}`], async () => {
        const current = this.requireState(params.bufferId)
        this.commit(current, { ...current.buffer, draft: null, dirty: false, error: null }, true)
        current.autosaveHold = false
        current.verified = true
        this.persist(current)
      })
    }
    const closed = await this.closeTerminalTab(state.buffer.worktreeId, tabId)
    if (!closed) return { closed: false }
    this.closeRequests.delete(tabId)
    if (!renderedPreview && !state.buffer.untitled) {
      this.recentlyClosed.unshift({ worktreeId: state.buffer.worktreeId, path: state.buffer.relativePath, mode: state.buffer.mode, closedAt: Date.now() })
      while (this.recentlyClosed.length > RECENTLY_CLOSED_LIMIT) this.recentlyClosed.pop()
    }
    if (!renderedPreview && lastEdit) {
      await this.quiesce(state)
      for (const listener of this.closeListeners) listener(params.bufferId)
    }
    const remaining = [...this.tabs.values()].some((tab) => tab.bufferId === params.bufferId)
    if (!remaining && !state.buffer.dirty) {
      await this.cleanupClosedPlaceholder(params.bufferId)
      this.removeBuffer(params.bufferId)
    }
    else {
      const current = this.buffers.get(params.bufferId)
      if (current !== undefined) {
        current.buffer = { ...current.buffer, ...this.bufferTabSummary(params.bufferId), revision: current.buffer.revision + 1 }
        this.persist(current)
      }
    }
    this.emit()
    return { closed: true }
  }
  private async cleanupClosedPlaceholder(bufferId: string): Promise<void> {
    const initial = this.buffers.get(bufferId)
    if (initial === undefined) return
    const buffer = initial.buffer
    const emptyHash = hashText('')
    if (!buffer.untitled || buffer.kind !== 'markdown' || buffer.dirty || buffer.draft !== null || buffer.content !== '' ||
      initial.placeholderHash !== emptyHash || initial.placeholderDev === null || initial.placeholderIno === null ||
      initial.placeholderTemplate || initial.placeholderEdited || this.store.get('SELECT 1 FROM editor_notes WHERE buffer_id = ? LIMIT 1', bufferId)) {
      return
    }
    const path = buffer.path
    const hash = initial.placeholderHash
    const dev = initial.placeholderDev
    const ino = initial.placeholderIno
    const keys = await this.fileKeys(path)
    await this.fileQueue.run(keys, async () => await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
      const current = this.buffers.get(bufferId)
      if (current === undefined || current.buffer.path !== path || !current.buffer.untitled || current.buffer.kind !== 'markdown' ||
        current.buffer.dirty || current.buffer.draft !== null || current.buffer.content !== '' ||
        current.placeholderHash !== hash || current.placeholderDev !== dev || current.placeholderIno !== ino ||
        current.placeholderTemplate || current.placeholderEdited ||
        this.store.get('SELECT 1 FROM editor_notes WHERE buffer_id = ? LIMIT 1', bufferId)) {
        return
      }
      await this.unlinkIfMatches(path, hash, dev, ino)
    }))
  }

  canClose(params: CloseParams): boolean {
    const state = this.buffers.get(params.bufferId)
    if (state === undefined) return false
    if (state.transferHolds.size > 0) return false
    const tabId = params.tabId ?? state.buffer.tabId ?? undefined
    if (tabId === undefined) return !state.buffer.dirty
    const mapping = this.tabs.get(tabId)
    if (mapping === undefined || mapping.bufferId !== params.bufferId) return false
    if (mapping.mode === 'preview') return true
    const otherEditTabs = this.editTabsForBuffer(params.bufferId).filter((tab) => tab.tabId !== tabId)
    return otherEditTabs.length > 0 || !state.buffer.dirty
  }

  async reopen(params: { worktree?: string; focus?: boolean }, caller: PluginCaller): Promise<EditorBuffer | null> {
    const requested = params.worktree === undefined && caller.role === 'plugin' ? undefined : params.worktree
    let index = -1
    if (requested === undefined) index = 0
    else {
      const worktree = await this.paths.resolve(requested, caller)
      index = this.recentlyClosed.findIndex((tab) => tab.worktreeId === worktree.id)
    }
    if (index < 0) return null
    const [closed] = this.recentlyClosed.splice(index, 1)
    if (closed === undefined) return null
    try {
      const opened = await this.open({ worktree: `id:${closed.worktreeId}`, path: closed.path, mode: closed.mode, focus: params.focus ?? false }, caller)
      return this.get(opened.id)
    } catch (error) {
      this.recentlyClosed.splice(index, 0, closed)
      throw error
    }
  }

  async view(params: ViewParams): Promise<EditorBuffer> {
    const action = params.action ?? 'update'
    if (action === 'update') return await this.applyViewPatch(params.bufferId, params.patch ?? {}, params.tabId)
    if (action === 'promote') return await this.promoteBuffer(params.bufferId, params.tabId)
    if (action === 'returnToEdit') return await this.returnPreviewToEdit(params.bufferId, params.tabId, params.patch ?? {})
    if (action === 'pin') return await this.pinBuffer(params.bufferId, params.tabId)
    if (action === 'compare') return await this.compareDisk(params.bufferId)
    if (action === 'keep') return await this.keepDisk(params.bufferId)
    if (action === 'reload') return await this.reloadFromDisk(params.bufferId)
    if (action === 'undoReload') return await this.undoReloadFromDisk(params.bufferId)
    if (action === 'reveal') {
      await this.reconcileBuffer(params.bufferId, 'reveal')
      return this.get(params.bufferId)
    }
    throw this.context.error('invalid-params', `unknown editor view action: ${action}`)
  }

  async read(params: EditorReadParams): Promise<EditorReadResult> {
    const action: string = params.action
    const buffer = this.get(params.bufferId)
    if (params.action === 'buffer') return { buffer, eof: true, size: buffer.size }
    if (params.action === 'bytes') return await this.readBytes(params.bufferId, params.offset ?? 0, params.length ?? MAX_READ_BYTES)
    if (params.action !== 'text') throw this.context.error('invalid-params', `unknown read action: ${action}`)
    if (!Number.isInteger(params.contentRevision) || params.contentRevision !== buffer.contentRevision) {
      throw this.context.error('conflict', `stale editor content revision: expected ${params.contentRevision}, current ${buffer.contentRevision}`)
    }
    const state = this.requireState(params.bufferId)
    const kind = params.kind
    let text: string
    if (kind === 'content') text = buffer.content
    else if (kind === 'draft') {
      if (buffer.draft === null) throw this.context.error('not-found', 'This buffer has no draft.')
      text = buffer.draft
    } else if (kind === 'disk') {
      if (params.diskSignature === undefined || params.diskSignature !== state.diskSignature) {
        throw this.context.error('conflict', 'The disk comparison changed; fetch fresh state before reading another chunk.')
      }
      if (buffer.diskContent === null) throw this.context.error('not-found', 'No text disk comparison is available.')
      text = buffer.diskContent
    } else {
      throw this.context.error('invalid-params', 'text reads require kind content, draft, or disk')
    }
    if (params.offset === undefined) throw this.context.error('invalid-params', 'text reads require offset')
    const offset = params.offset
    const length = params.length ?? MAX_TEXT_CHUNK_LENGTH
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw this.context.error('invalid-params', 'text offset is outside the selected text')
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TEXT_CHUNK_LENGTH) {
      throw this.context.error('invalid-params', `text length must be between 0 and ${MAX_TEXT_CHUNK_LENGTH} UTF-16 code units`)
    }
    let start = offset
    if (start > 0 && start < text.length) {
      const current = text.charCodeAt(start)
      const previous = text.charCodeAt(start - 1)
      if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start--
    }
    let end = Math.min(text.length, start + length)
    if (end > start && end < text.length) {
      const last = text.charCodeAt(end - 1)
      const next = text.charCodeAt(end)
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    }
    if (length > 0 && end === start && end < text.length) end = Math.min(text.length, start + 2)
    return {
      text: text.slice(start, end),
      offset: start,
      nextOffset: end,
      eof: end >= text.length,
      contentRevision: buffer.contentRevision,
      ...(kind === 'disk' ? { diskSignature: state.diskSignature! } : {})
    }
  }

  async quickOpen(
    params: { worktree?: string; action: 'search' | 'record' | 'history' | 'clearHistory'; query?: string; path?: string; limit?: number },
    caller: PluginCaller
  ): Promise<{ results: { path: string; name: string; score: number; line?: number; column?: number }[]; truncated: boolean; history: string[] }> {
    const worktree = await this.paths.resolve(params.worktree, caller)
    if (params.action === 'clearHistory') {
      this.store.run('DELETE FROM editor_quick_open_history WHERE worktree_id=?', worktree.id)
      return { results: [], truncated: false, history: [] }
    }
    const history = this.store.all<{ path: string }>(
      'SELECT path FROM editor_quick_open_history WHERE worktree_id=? ORDER BY visited_at DESC LIMIT ?',
      worktree.id,
      RECENT_PATH_LIMIT
    ).map((row) => row.path)
    if (params.action === 'history') return { results: [], truncated: false, history }
    if (params.action === 'record') {
      if (params.path === undefined) throw this.context.error('invalid-params', 'path is required to record quick-open history')
      const authorized = await this.paths.path(worktree.id, params.path)
      const info = await stat(authorized.path)
      if (info.isDirectory()) throw this.context.error('invalid-params', 'Choose a file rather than a directory.')
      await this.recordQuickOpen(worktree.id, authorized.relativePath)
      return { results: [], truncated: false, history: [authorized.relativePath, ...history.filter((path) => path !== authorized.relativePath)].slice(0, RECENT_PATH_LIMIT) }
    }
    const query = params.query ?? ''
    if (Buffer.byteLength(query, 'utf8') > QUICK_OPEN_QUERY_MAX_BYTES) return { results: [], truncated: false, history }
    const target = parseQuickOpenTarget(query)
    const targetPath = normalizeRipgrepPath(target.path) ?? target.path
    if (target.path !== query && (target.path.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(target.path))) {
      const absolute = await this.paths.path(worktree.id, target.path)
      const info = await stat(absolute.path)
      if (info.isDirectory()) throw this.context.error('invalid-params', 'Choose a file rather than a directory.')
      return { results: [{ path: absolute.relativePath, name: basename(absolute.path), score: Number.MAX_SAFE_INTEGER, ...(target.line === undefined ? {} : { line: target.line }), ...(target.column === undefined ? {} : { column: target.column }) }], truncated: false, history }
    }
    const all = await this.inventory.list(worktree.path, this.setting('showGitIgnoredFiles', true), this.setting('followSymlinkedDirectories', false))
    if (targetPath !== query && all.paths.includes(targetPath)) {
      const direct = await this.paths.path(worktree.id, targetPath)
      const info = await stat(direct.path)
      if (info.isDirectory()) throw this.context.error('invalid-params', 'Choose a file rather than a directory.')
      return { results: [{ path: direct.relativePath, name: basename(direct.path), score: Number.MAX_SAFE_INTEGER, ...(target.line === undefined ? {} : { line: target.line }), ...(target.column === undefined ? {} : { column: target.column }) }], truncated: all.truncated, history }
    }
    const ranked = this.inventory.searchPaths(all.paths, targetPath, history, params.limit ?? QUICK_OPEN_MAX_RESULTS)
    const authorized: { path: string; name: string; score: number; line?: number; column?: number }[] = []
    for (const item of ranked) {
      try {
        const path = await this.paths.path(worktree.id, item.path)
        const info = await stat(path.path)
        if (!info.isDirectory()) authorized.push({ ...item, path: path.relativePath, ...(target.line === undefined ? {} : { line: target.line }), ...(target.column === undefined ? {} : { column: target.column }) })
      } catch {
        // A file removed or retargeted after inventory is excluded until the next inventory scan.
      }
    }
    return { results: authorized, truncated: all.truncated, history }
  }

  async setupConfirmation(params: Record<string, unknown>): Promise<string | null> {
    const action = params.action
    if (action === 'install') return 'Install ipykernel into the selected local Python environment?'
    if (action === 'venv') return 'Create a workspace virtual environment and install ipykernel?'
    return null
  }
  async transfer(params: EditorTransferParams, caller: PluginCaller): Promise<EditorTransferResult | EditorBuffer | MutationResult> {
    this.assertActive()
    if (params.action === 'begin') return await this.beginTransfer(params, caller)
    if (params.transferId === undefined) throw this.context.error('invalid-params', 'transferId is required')
    if (params.action === 'chunk') return await this.writeTransferChunk(params.transferId, params)
    if (params.action === 'commit') return await this.commitTransfer(params.transferId)
    if (params.action === 'cancel') return await this.cancelTransfer(params.transferId)
    if (params.action === 'state') return this.transferState(params.transferId)
    throw this.context.error('invalid-params', `unknown transfer action: ${params.action}`)
  }

  private async beginTransfer(params: EditorTransferBeginParams, caller: PluginCaller): Promise<Extract<EditorTransferResult, { maxChunkBytes: number }>> {
    const kind = params.kind
    const totalBytes = params.totalBytes
    if (kind !== 'draft' && kind !== 'createFile' && kind !== 'import') throw this.context.error('invalid-params', 'transfer kind must be draft, createFile or import')
    if (!Number.isSafeInteger(totalBytes) || totalBytes! < 0 || totalBytes! > MAX_TEXT_FILE_BYTES) {
      throw this.context.error('invalid-params', `transfer totalBytes must be between 0 and ${MAX_TEXT_FILE_BYTES}`)
    }
    return await this.transferQueue.run(['active-transfers'], async () => {
      for (const candidate of [...this.transfers.values()]) {
        if (candidate.expiresAt > Date.now()) continue
        await this.transferQueue.run([`transfer:${candidate.transferId}`], async () => {
          const current = this.transfers.get(candidate.transferId)
          if (current !== undefined && current.expiresAt <= Date.now()) await this.removeTransfer(current)
        })
      }
      if (this.transfers.size >= MAX_ACTIVE_TRANSFERS) throw this.context.error('conflict', `At most ${MAX_ACTIVE_TRANSFERS} transfers may be active.`)
      const reserved = [...this.transfers.values()].reduce((sum, transfer) => sum + transfer.totalBytes, 0)
      if (reserved + totalBytes! > MAX_STAGED_TRANSFER_BYTES) throw this.context.error('conflict', `Active transfer staging is limited to ${MAX_STAGED_TRANSFER_BYTES} bytes.`)
      const transferId = randomUUID()
      const record: ActiveTransfer = {
        transferId,
        kind,
        stagePath: join(this.transferDirectory, `${transferId}.part`),
        totalBytes: totalBytes!,
        offset: 0,
        expiresAt: Date.now() + TRANSFER_IDLE_MS
      }
      await mkdir(this.transferDirectory, { recursive: true, mode: 0o700 })
      const staging = await openFile(record.stagePath, 'wx', 0o600)
      await staging.close()
      try {
        if (kind === 'draft') {
          if (params.bufferId === undefined || params.expectedRevision === undefined) throw this.context.error('invalid-params', 'draft transfers require bufferId and expectedRevision')
          const state = this.requireState(params.bufferId)
          await this.transferGateQueue.run([`transfer-gate:${state.buffer.id}`], async () => {
            await this.bufferQueue.run([`buffer:${state.buffer.id}`], async () => {
              const current = this.requireState(state.buffer.id)
              if (current.buffer.readOnly) throw this.context.error('invalid-params', 'This file is read-only.')
              if (current.transferHolds.size > 0) throw this.context.error('conflict', 'A transfer is already active for this buffer.')
              if (current.buffer.contentRevision !== params.expectedRevision) {
                throw Object.assign(this.context.error('conflict', `stale editor content revision: expected ${params.expectedRevision}, current ${current.buffer.contentRevision}`), {
                  data: { expectedRevision: params.expectedRevision, currentRevision: current.buffer.contentRevision }
                })
              }
              current.transferHolds.add(transferId)
              this.cancelAutosave(current)
              record.bufferId = current.buffer.id
              record.worktreeId = current.buffer.worktreeId
              record.root = current.buffer.root
              record.relativePath = current.buffer.relativePath
              record.expectedRevision = params.expectedRevision
              this.emit()
            })
          })
        } else {
          if (params.path === undefined) throw this.context.error('invalid-params', `${kind} transfers require a path`)
          const worktree = await this.paths.resolve(params.worktree, caller)
          record.worktreeId = worktree.id
          record.root = worktree.path
          if (kind === 'createFile') {
            const destination = await this.paths.entryPath(worktree.id, params.path, { create: true })
            if (await this.exists(destination.path)) throw this.context.error('conflict', `Destination already exists: ${destination.relativePath}`)
            record.relativePath = destination.relativePath
          } else {
            if (params.name === undefined) throw this.context.error('invalid-params', 'import transfers require a safe filename')
            this.validateUploadName(params.name)
            const destination = await this.paths.path(worktree.id, params.path)
            if (!(await stat(destination.path)).isDirectory()) throw this.context.error('invalid-params', 'Import destination must be a directory.')
            record.destinationPath = destination.path
            record.relativePath = destination.relativePath
            record.name = params.name
          }
        }
      } catch (error) {
        await rm(record.stagePath, { force: true })
        if (record.bufferId !== undefined) {
          const state = this.buffers.get(record.bufferId)
          state?.transferHolds.delete(transferId)
        }
        throw error
      }
      this.transfers.set(transferId, record)
      this.touchTransfer(record)
      return { transferId, offset: 0, maxChunkBytes: MAX_TRANSFER_CHUNK_BYTES }
    })
  }

  private async writeTransferChunk(transferId: string, params: EditorTransferChunkParams): Promise<Extract<EditorTransferResult, { nextOffset: number }>> {
    return await this.transferQueue.run([`transfer:${transferId}`], async () => {
      const transfer = await this.requireTransfer(transferId)
      if (!Number.isSafeInteger(params.offset) || params.offset !== transfer.offset) {
        throw this.context.error('conflict', `transfer offset must be ${transfer.offset}`)
      }
      if (params.data === undefined) throw this.context.error('invalid-params', 'transfer chunk data is required')
      const bytes = this.decodeTransferChunk(params.data)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_TRANSFER_CHUNK_BYTES) {
        throw this.context.error('invalid-params', `transfer chunks must contain between 1 and ${MAX_TRANSFER_CHUNK_BYTES} bytes`)
      }
      if (transfer.offset + bytes.byteLength > transfer.totalBytes) throw this.context.error('invalid-params', 'transfer chunk exceeds declared totalBytes')
      const handle = await openFile(transfer.stagePath, 'r+')
      try {
        const result = await handle.write(bytes, 0, bytes.byteLength, transfer.offset)
        if (result.bytesWritten !== bytes.byteLength) throw this.context.error('conflict', 'transfer chunk could not be staged completely')
      } finally {
        await handle.close()
      }
      transfer.offset += bytes.byteLength
      this.touchTransfer(transfer)
      return { transferId, offset: transfer.offset, nextOffset: transfer.offset }
    })
  }

  private async commitTransfer(transferId: string): Promise<EditorTransferResult | EditorBuffer | MutationResult> {
    return await this.transferQueue.run([`transfer:${transferId}`], async () => {
      const transfer = await this.requireTransfer(transferId)
      if (transfer.offset !== transfer.totalBytes) throw this.context.error('conflict', `transfer is incomplete: received ${transfer.offset} of ${transfer.totalBytes} bytes`)
      try {
        const bytes = await readFile(transfer.stagePath)
        if (bytes.byteLength !== transfer.totalBytes) throw this.context.error('conflict', 'staged transfer size differs from its declared total')
        let result: EditorTransferResult | EditorBuffer | MutationResult
        if (transfer.kind === 'draft') {
          const text = this.decodeTransferText(bytes)
          result = await this.updateDraft(transfer.bufferId!, text, transfer.expectedRevision!, transfer.transferId)
        } else if (transfer.kind === 'createFile') {
          const text = this.decodeTransferText(bytes)
          const worktree = await this.paths.forId(transfer.worktreeId!)
          if (worktree.path !== transfer.root) throw this.context.error('conflict', 'Worktree root changed while the file transfer was active.')
          result = await this.createFile(worktree, { action: 'createFile', path: transfer.relativePath!, content: text })
        } else {
          const worktree = await this.paths.forId(transfer.worktreeId!)
          if (worktree.path !== transfer.root) throw this.context.error('conflict', 'Worktree root changed while the import transfer was active.')
          result = await this.importUploadedFile(worktree, transfer.destinationPath!, transfer.name!, bytes)
        }
        await this.removeTransfer(transfer)
        return result
      } catch (error) {
        await this.removeTransfer(transfer)
        throw error
      }
    })
  }

  private async cancelTransfer(transferId: string): Promise<Extract<EditorTransferResult, { cancelled: boolean }>> {
    return await this.transferQueue.run([`transfer:${transferId}`], async () => {
      const transfer = this.transfers.get(transferId)
      if (transfer === undefined) return { transferId, cancelled: false }
      await this.removeTransfer(transfer)
      return { transferId, cancelled: true }
    })
  }

  private async transferState(transferId: string): Promise<EditorTransferStateResult> {
    return await this.transferQueue.run([`transfer:${transferId}`], async () => {
      const transfer = await this.requireTransfer(transferId)
      return {
        transferId,
        kind: transfer.kind,
        offset: transfer.offset,
        totalBytes: transfer.totalBytes,
        expiresAt: transfer.expiresAt,
        progress: transfer.totalBytes === 0 ? 1 : transfer.offset / transfer.totalBytes
      }
    })
  }

  private async requireTransfer(transferId: string): Promise<ActiveTransfer> {
    const transfer = this.transfers.get(transferId)
    if (transfer === undefined) throw this.context.error('not-found', `editor transfer not found or expired: ${transferId}`)
    if (transfer.expiresAt <= Date.now()) {
      await this.removeTransfer(transfer)
      throw this.context.error('not-found', `editor transfer not found or expired: ${transferId}`)
    }
    return transfer
  }

  private touchTransfer(transfer: ActiveTransfer): void {
    if (transfer.timer !== undefined) clearTimeout(transfer.timer)
    transfer.expiresAt = Date.now() + TRANSFER_IDLE_MS
    const expectedExpiry = transfer.expiresAt
    transfer.timer = setTimeout(() => {
      void this.transferQueue.run([`transfer:${transfer.transferId}`], async () => {
        const current = this.transfers.get(transfer.transferId)
        if (current === undefined || current.expiresAt !== expectedExpiry || current.expiresAt > Date.now()) return
        await this.removeTransfer(current)
      })
    }, TRANSFER_IDLE_MS)
  }

  private async removeTransfer(transfer: ActiveTransfer): Promise<void> {
    if (transfer.timer !== undefined) clearTimeout(transfer.timer)
    this.transfers.delete(transfer.transferId)
    await rm(transfer.stagePath, { force: true })
    if (transfer.bufferId !== undefined) {
      const state = this.buffers.get(transfer.bufferId)
      if (state !== undefined) {
        await this.bufferQueue.run([`buffer:${transfer.bufferId}`], async () => {
          state.transferHolds.delete(transfer.transferId)
          this.scheduleAutosave(state)
          this.emit()
        })
      }
    }
  }

  private decodeTransferChunk(value: string): Buffer {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw this.context.error('invalid-params', 'transfer chunk must be canonical base64')
    }
    const bytes = Buffer.from(value, 'base64')
    if (bytes.byteLength > MAX_TRANSFER_CHUNK_BYTES || bytes.toString('base64') !== value) {
      throw this.context.error('invalid-params', `transfer chunks may contain at most ${MAX_TRANSFER_CHUNK_BYTES} bytes of canonical base64 data`)
    }
    return bytes
  }

  private decodeTransferText(bytes: Buffer): string {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw this.context.error('invalid-params', 'text transfer must contain valid UTF-8')
    }
  }

  private async importUploadedFile(worktree: ResolvedWorktree, destinationPath: string, name: string, bytes: Buffer): Promise<MutationResult> {
    this.validateUploadName(name)
    if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw this.context.error('invalid-params', `Import file exceeds ${MAX_TEXT_FILE_BYTES} bytes.`)
    const keys = await this.fileKeys(destinationPath)
    const target = await this.fileQueue.run(keys, async () => {
      const target = await this.importNameTarget(worktree.id, destinationPath, name)
      await writeFile(target.path, bytes, { flag: 'wx', mode: 0o600 })
      return target
    })
    this.inventory.invalidate(worktree.path)
    this.emit()
    return { path: relative(worktree.path, destinationPath) || '.', paths: [target.relativePath] }
  }

  private async cleanTransferStaging(): Promise<void> {
    await rm(this.transferDirectory, { recursive: true, force: true })
    await mkdir(this.transferDirectory, { recursive: true, mode: 0o700 })
  }


  async onEvent(event: QuirkyEvent): Promise<void> {
    if (this.disposed) return
    if (event.type === 'quirky.terminal/layout') {
      const worktreeId = (event.data as { workspace?: unknown } | undefined)?.workspace
      if (typeof worktreeId === 'string') await this.syncTerminalWorkspace(worktreeId).catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const transfer of [...this.transfers.values()]) {
      await this.transferQueue.run([`transfer:${transfer.transferId}`], () => this.removeTransfer(transfer)).catch(() => undefined)
    }
    await rm(this.transferDirectory, { recursive: true, force: true }).catch(() => undefined)
    this.watcher.dispose()
    this.searchService.dispose()
    for (const timer of this.changeTimers.values()) clearTimeout(timer)
    this.changeTimers.clear()
    const states = [...this.buffers.values()]
    for (const state of states) {
      this.cancelAutosave(state)
      if (state.inFlight !== undefined) await state.inFlight.catch(() => undefined)
    }
    for (const state of states) for (const listener of this.closeListeners) listener(state.buffer.id)
    this.closeListeners.clear()
    this.tabs.clear()
    this.reloadUndo.clear()
    this.closeRequests.clear()
  }

  private assertSaveRevision(expectedRevision: number | undefined, currentRevision: number): void {
    if (expectedRevision === undefined || expectedRevision === currentRevision) return
    throw Object.assign(this.context.error('conflict', `stale editor content revision: expected ${expectedRevision}, current ${currentRevision}`), {
      data: { expectedRevision, currentRevision }
    })
  }


  private async performSave(bufferId: string, trigger: SaveParams['trigger'], generation: number, expectedRevision?: number): Promise<EditorBuffer> {
    const state = this.requireState(bufferId)
    this.assertSaveRevision(expectedRevision, state.buffer.contentRevision)
    if (state.buffer.untitled) {
      if (trigger === 'autosave') return state.buffer
      throw this.context.error('invalid-params', 'Untitled Markdown documents must be saved with Save As.')
    }
    if (state.buffer.readOnly) throw this.context.error('invalid-params', 'This file is read-only.')
    if (state.transferHolds.size > 0) {
      if (trigger === 'autosave') return state.buffer
      throw this.context.error('conflict', 'A text transfer is in progress for this buffer.')
    }
    if (trigger === 'autosave' && (!this.autosaveEligible(state) || state.autosaveHold || !state.verified)) return state.buffer
    const path = await this.paths.path(state.buffer.worktreeId, state.buffer.relativePath, { create: true })
    const savedPath = path.path
    const baseline = state.buffer.baseline
    if (trigger !== 'overwrite' && baseline === null) throw this.context.error('conflict', 'Cannot save because this buffer has no verified disk baseline.')
    const keys = await this.fileKeys(savedPath)
    const returnEditorBuffer = await this.fileQueue.run<EditorBuffer>(keys, async () => {
      const currentState = this.requireState(bufferId)
      if (trigger === 'autosave' && (generation !== currentState.generation || !this.autosaveEligible(currentState) || currentState.autosaveHold || !currentState.verified)) return currentState.buffer
      if (currentState.buffer.path !== savedPath || (trigger !== 'overwrite' && currentState.buffer.baseline !== baseline)) {
        throw this.context.error('conflict', 'The editor buffer baseline changed while the save was queued; re-read state before saving.')
      }
      const diskWritable = await probeWriteAccess(savedPath)
      await this.updateDiskWritable(bufferId, diskWritable)
      const outcome = await this.bufferQueue.run<SaveOutcome>([`buffer:${bufferId}`], async () => {
        const latest = this.requireState(bufferId)
        this.assertSaveRevision(expectedRevision, latest.buffer.contentRevision)
        if (latest.buffer.path !== savedPath || (trigger !== 'overwrite' && latest.buffer.baseline !== baseline)) {
          throw this.context.error('conflict', 'The editor buffer baseline changed while the save was queued; re-read state before saving.')
        }
        if (latest.buffer.readOnly) throw this.context.error('invalid-params', 'This file is read-only.')
        if (latest.transferHolds.size > 0) {
          if (trigger === 'autosave') return { kind: 'skipped', buffer: latest.buffer }
          throw this.context.error('conflict', 'A text transfer is in progress for this buffer.')
        }
        if (trigger === 'autosave' && (generation !== latest.generation || !this.autosaveEligible(latest) || latest.autosaveHold || !latest.verified)) {
          return { kind: 'skipped', buffer: latest.buffer }
        }
        const content = latest.buffer.draft ?? latest.buffer.content
        const currentBaseline = latest.buffer.baseline
        if (trigger !== 'overwrite' && currentBaseline === null) {
          throw this.context.error('conflict', 'Cannot save because this buffer has no verified disk baseline.')
        }
        let writeResult: 'written' | 'changed' | 'missing'
        try {
          writeResult = trigger === 'overwrite'
            ? await this.forceWrite(savedPath, content)
            : await guardedWrite(savedPath, content, currentBaseline!, trigger !== 'autosave')
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code
          if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { kind: 'permission-denied' }
          throw error
        }
        if (writeResult !== 'written') {
          return { kind: 'external', external: writeResult === 'missing' ? 'deleted' : 'changed' }
        }
        const hash = hashText(content)
        this.ownWrites.set(savedPath, { hash, expiresAt: Date.now() + 3000 })
        const contentChanged = latest.buffer.content !== content
        const clearDraft = latest.buffer.draft === content
        const next: EditorBuffer = {
          ...latest.buffer,
          content,
          draft: clearDraft ? null : latest.buffer.draft,
          baseline: hash,
          size: Buffer.byteLength(content, 'utf8'),
          diskWritable: true,
          dirty: clearDraft ? false : latest.buffer.dirty,
          external: null,
          diskContent: null,
          error: null,
          revision: latest.buffer.revision + 1,
          contentRevision: latest.buffer.contentRevision + Number(contentChanged || clearDraft)
        }
        latest.contentBytes = Buffer.byteLength(content, 'utf8')
        latest.contentLength = content.length
        if (clearDraft) {
          latest.draftBytes = null
          latest.draftLength = null
        }
        latest.diskContentBytes = null
        latest.diskContentLength = null
        latest.diskSignature = null
        latest.buffer = next
        latest.verified = true
        if (trigger === 'user' || trigger === 'overwrite') latest.autosaveHold = false
        this.persist(latest)
        this.emit()
        return { kind: 'saved', buffer: next }
      })
      if (outcome.kind === 'external') {
        await this.markWriteConflict(currentState, savedPath, outcome.external)
        throw this.context.error('conflict', outcome.external === 'deleted'
          ? 'The file was deleted after it was opened. Compare, reload, or explicitly overwrite.'
          : 'This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.')
      }
      if (outcome.kind === 'permission-denied') {
        await this.updateDiskWritable(bufferId, false)
        throw this.context.error('conflict', 'The file is not writable with the current OS permissions. The draft and baseline were retained; restore write access and retry Save.')
      }
      const latest = this.requireState(bufferId)
      this.scheduleAutosave(latest)
      return outcome.buffer
    })
    return returnEditorBuffer
  }
  private async updateDiskWritable(bufferId: string, diskWritable: boolean): Promise<EditorBuffer> {
    return await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
      const state = this.requireState(bufferId)
      if (state.buffer.diskWritable === diskWritable) return state.buffer
      const next = { ...state.buffer, diskWritable, revision: state.buffer.revision + 1 }
      this.commit(state, next, false)
      return next
    })
  }


  private async viewPatch(bufferId: string, patch: Record<string, unknown>, tabId?: string): Promise<EditorBuffer> {
    const keys = Object.keys(patch)
    const invalid = keys.find((key) => !VIEW_KEYS.has(key))
    if (invalid !== undefined) throw this.context.error('invalid-params', `view patch cannot change protected or unknown field: ${invalid}`)
    if (keys.length > 32) throw this.context.error('invalid-params', 'view patch contains too many fields')
    const requestedMode = patch.mode
    if (requestedMode === 'preview') throw this.context.error('invalid-params', 'Preview is a separate editor tab; open it with mode preview.')
    if (requestedMode !== undefined && requestedMode !== 'source' && requestedMode !== 'rich') {
      throw this.context.error('invalid-params', 'Editable view mode must be source or rich')
    }
    const mode: EditorMode | undefined = requestedMode === 'source' || requestedMode === 'rich' ? requestedMode : undefined
    for (const field of ['line', 'column', 'cursorLine', 'cursorColumn'] as const) {
      const position = patch[field]
      if (position !== undefined && (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1)) {
        throw this.context.error('invalid-params', `${field} must be a positive integer`)
      }
    }

    const cursor = patch.cursor
    if (cursor !== undefined) {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
        throw this.context.error('invalid-params', 'cursor must be an object')
      }
      const cursorValue = cursor as Record<string, unknown>
      const invalidCursorField = Object.keys(cursorValue).find((field) => field !== 'line' && field !== 'column')
      if (invalidCursorField !== undefined) {
        throw this.context.error('invalid-params', `cursor.${invalidCursorField} is not allowed`)
      }
      for (const field of ['line', 'column'] as const) {
        const position = cursorValue[field]
        if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1) {
          throw this.context.error('invalid-params', `cursor.${field} must be a positive integer`)
        }
      }
    }
    const matchLength = patch.matchLength
    if (matchLength !== undefined && (typeof matchLength !== 'number' || !Number.isSafeInteger(matchLength) || matchLength < 0 || matchLength > MAX_TEXT_FILE_BYTES)) {
      throw this.context.error('invalid-params', `matchLength must be a bounded non-negative integer no greater than ${MAX_TEXT_FILE_BYTES}`)
    }
    const markdownFrontmatterVisible = patch.markdownFrontmatterVisible
    if (markdownFrontmatterVisible !== undefined && typeof markdownFrontmatterVisible !== 'boolean') {
      throw this.context.error('invalid-params', 'markdownFrontmatterVisible must be a boolean')
    }

    const markdownTocVisible = patch.markdownTocVisible
    if (markdownTocVisible !== undefined && typeof markdownTocVisible !== 'boolean') {
      throw this.context.error('invalid-params', 'markdownTocVisible must be a boolean')
    }
    const presentation: Record<string, unknown> = { ...patch }
    delete presentation.mode
    const result = await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
      const state = this.requireState(bufferId)
      const markdownAnchor = presentation.markdownAnchor
      if (markdownAnchor !== undefined) {
        if (markdownAnchor === null || markdownAnchor === '') presentation.markdownAnchor = null
        else if (state.buffer.kind !== 'markdown' || !this.isSafeMarkdownAnchor(markdownAnchor)) {
          throw this.context.error('invalid-params', 'markdownAnchor must be a safe fragment on a Markdown buffer; use empty string or null to clear it')
        }
      }
      if (tabId !== undefined && this.tabs.get(tabId)?.bufferId !== bufferId) {
        throw this.context.error('not-found', `editor tab ${tabId} does not belong to buffer ${bufferId}`)
      }
      const view = { ...state.buffer.view }
      if (tabId === undefined) Object.assign(view, presentation)
      else {
        const byTabId = view.byTabId !== null && typeof view.byTabId === 'object'
          ? { ...(view.byTabId as Record<string, unknown>) }
          : {}
        byTabId[tabId] = { ...(byTabId[tabId] as Record<string, unknown> | undefined), ...presentation }
        view.byTabId = byTabId
      }
      const modeChanged = mode !== undefined && mode !== state.buffer.mode
      const next = { ...state.buffer, ...(mode === undefined ? {} : { mode }), view, revision: state.buffer.revision + 1 }
      this.commit(state, next, false)
      return { buffer: state.buffer, modeChanged }
    })
    if (mode !== undefined && result.modeChanged) await this.updateTabModes(bufferId, mode)
    return this.get(bufferId)
  }
  private async returnPreviewToEdit(bufferId: string, requestedTabId: string | undefined, patch: Record<string, unknown>): Promise<EditorBuffer> {
    const invalid = Object.keys(patch).find((key) => key !== 'mode')
    if (invalid !== undefined) throw this.context.error('invalid-params', `returnToEdit patch cannot change ${invalid}.`)
    const mode = patch.mode
    if (mode !== 'source' && mode !== 'rich') throw this.context.error('invalid-params', 'returnToEdit requires mode source or rich.')
    const state = this.requireState(bufferId)
    if (state.buffer.kind !== 'markdown') throw this.context.error('invalid-params', 'Only a Markdown Preview tab can return to an editor.')
    const target = requestedTabId === undefined
      ? this.tabsForBuffer(bufferId).find((tab) => tab.inputMode === 'preview')
      : this.tabs.get(requestedTabId)
    if (target === undefined || target.bufferId !== bufferId) {
      throw this.context.error('not-found', `editor preview tab not found for buffer ${bufferId}`)
    }
    await this.viewPatch(bufferId, { mode }, target.tabId)
    const current = this.requireState(bufferId)
    const mapping = this.tabs.get(target.tabId)
    if (mapping === undefined || mapping.bufferId !== bufferId) {
      throw this.context.error('conflict', 'The preview tab changed before it could return to the editor.')
    }
    if (mapping.inputMode === 'preview') {
      const result = await this.context.call('quirky.terminal/rekeyViewTabs', {
        workspace: `id:${mapping.worktreeId}`,
        viewId: EDITOR_DOCUMENT_VIEW,
        changes: [{
          tab: mapping.tabId,
          key: mapping.key,
          input: { bufferId, mode },
          title: editorTabTitle(current.buffer.name, mode),
          preview: false
        }]
      }) as { workspace?: TerminalWorkspace }
      if (result.workspace !== undefined) this.syncWorkspaceValue(mapping.worktreeId, result.workspace)
    }
    const fresh = this.requireState(bufferId)
    fresh.buffer = { ...fresh.buffer, ...this.bufferTabSummary(bufferId), revision: fresh.buffer.revision + 1 }
    this.persist(fresh)
    this.emit()
    return fresh.buffer
  }
  private async updateTabModes(bufferId: string, mode: EditorMode): Promise<void> {
    if (mode === 'preview') return
    const state = this.requireState(bufferId)
    const mappings = this.tabsForBuffer(bufferId).filter((tab) => tab.inputMode !== 'preview' && tab.inputMode !== mode)
    if (mappings.length === 0) return
    const worktreeId = mappings[0]!.worktreeId
    const result = await this.context.call('quirky.terminal/rekeyViewTabs', {
      workspace: `id:${worktreeId}`,
      viewId: EDITOR_DOCUMENT_VIEW,
      changes: mappings.map((tab) => ({
        tab: tab.tabId,
        key: tab.key,
        input: { bufferId, mode },
        title: editorTabTitle(state.buffer.name, mode),
        preview: tab.preview
      }))
    }) as { workspace: TerminalWorkspace }
    this.syncWorkspaceValue(worktreeId, result.workspace)
  }


  private async applyViewPatch(bufferId: string, patch: Record<string, unknown>, tabId?: string): Promise<EditorBuffer> {
    return await this.viewPatch(bufferId, patch, tabId)
  }

  private async promoteBuffer(bufferId: string, requestedTabId?: string): Promise<EditorBuffer> {
    const state = this.requireState(bufferId)
    const mappings = this.tabsForBuffer(bufferId).filter((tab) => tab.preview)
    const target = requestedTabId === undefined ? mappings[0] : mappings.find((tab) => tab.tabId === requestedTabId)
    if (target === undefined) return state.buffer
    const workspace = await this.context.call('quirky.terminal/rekeyViewTabs', {
      workspace: `id:${target.worktreeId}`,
      viewId: EDITOR_DOCUMENT_VIEW,
      changes: [{ tab: target.tabId, key: target.key, input: { bufferId, mode: target.inputMode }, title: editorTabTitle(state.buffer.name, target.inputMode), preview: false }]
    }) as { workspace?: TerminalWorkspace }
    if (workspace.workspace !== undefined) this.syncWorkspaceValue(target.worktreeId, workspace.workspace)
    const current = this.requireState(bufferId)
    current.buffer = { ...current.buffer, ...this.bufferTabSummary(bufferId), revision: current.buffer.revision + 1 }
    this.persist(current)
    this.emit()
    return current.buffer
  }

  private async pinBuffer(bufferId: string, requestedTabId?: string): Promise<EditorBuffer> {
    const mappings = this.tabsForBuffer(bufferId)
    const mapping = requestedTabId === undefined
      ? mappings.find((tab) => tab.mode === 'edit') ?? mappings.find((tab) => tab.preview) ?? mappings.find((tab) => tab.inputMode === 'preview')
      : this.tabs.get(requestedTabId)
    if (mapping === undefined || mapping.bufferId !== bufferId) throw this.context.error('not-found', 'editor tab not found to pin')
    const result = await this.context.call('quirky.terminal/pinTab', { tab: mapping.tabId, pinned: true }) as { workspace?: TerminalWorkspace }
    if (result.workspace !== undefined) this.syncWorkspaceValue(mapping.worktreeId, result.workspace)
    const fresh = this.requireState(bufferId)
    fresh.buffer = { ...fresh.buffer, ...this.bufferTabSummary(bufferId), revision: fresh.buffer.revision + 1 }
    this.persist(fresh)
    this.emit()
    return fresh.buffer
  }

  private async compareDisk(bufferId: string): Promise<EditorBuffer> {
    const state = this.requireState(bufferId)
    const path = await this.paths.path(state.buffer.worktreeId, state.buffer.relativePath)
    const keys = await this.fileKeys(path.path)
    return await this.fileQueue.run(keys, async () => {
      const snapshot = await this.tryReadSnapshot(path.path)
      return await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
        const current = this.requireState(bufferId)
        current.diskSignature = snapshot?.hash ?? null
        const next: EditorBuffer = {
          ...current.buffer,
          external: snapshot === null ? 'deleted' : (snapshot.hash === current.buffer.baseline ? null : 'changed'),
          diskContent: snapshot?.text ?? null,
          diskWritable: snapshot?.diskWritable ?? false,
          revision: current.buffer.revision + 1
        }
        this.commit(current, next, false)
        return next
      })
    })
  }

  private async keepDisk(bufferId: string): Promise<EditorBuffer> {
    const state = this.requireState(bufferId)
    const path = await this.paths.path(state.buffer.worktreeId, state.buffer.relativePath)
    const keys = await this.fileKeys(path.path)
    return await this.fileQueue.run(keys, async () => {
      const snapshot = await this.tryReadSnapshot(path.path)
      if (snapshot === null) {
        await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
          const current = this.requireState(bufferId)
          current.diskSignature = null
          this.commit(current, { ...current.buffer, external: 'deleted', diskContent: null, diskWritable: false, revision: current.buffer.revision + 1 }, false)
        })
        throw this.context.error('conflict', 'Cannot keep edits because the file is deleted.')
      }
      if (snapshot.text === null && !state.buffer.readOnly) throw this.context.error('conflict', 'Cannot acknowledge a non-text disk version while keeping text edits.')
      return await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
        const current = this.requireState(bufferId)
        current.diskSignature = null
        const next: EditorBuffer = {
          ...current.buffer,
          baseline: snapshot.hash,
          diskWritable: snapshot.diskWritable,
          external: null,
          diskContent: null,
          revision: current.buffer.revision + 1
        }
        current.autosaveHold = true
        current.verified = true
        this.commit(current, next, false)
        this.persist(current)
        this.cancelAutosave(current)
        return next
      })
    })
  }

  private async reloadFromDisk(bufferId: string): Promise<EditorBuffer> {
    const state = this.requireState(bufferId)
    const path = await this.paths.path(state.buffer.worktreeId, state.buffer.relativePath)
    const keys = await this.fileKeys(path.path)
    return await this.fileQueue.run(keys, async () => {
      const snapshot = await this.tryReadSnapshot(path.path)
      if (snapshot === null) throw this.context.error('not-found', 'Cannot reload because the file is deleted.')
      return await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
        const current = this.requireState(bufferId)
        current.diskSignature = null
        this.reloadUndo.set(bufferId, {
          draft: current.buffer.draft,
          held: current.autosaveHold,
          afterBaseline: snapshot.hash,
          expiresAt: Date.now() + RELOAD_UNDO_WINDOW_MS
        })
        const previous = current.buffer
        const next: EditorBuffer = {
          ...previous,
          content: snapshot.text ?? '',
          draft: null,
          baseline: snapshot.hash,
          size: snapshot.size,
          readOnly: snapshot.readOnly,
          diskWritable: snapshot.diskWritable,
          dirty: false,
          external: null,
          diskContent: null,
          error: null,
          revision: previous.revision + 1,
          contentRevision: previous.contentRevision + 1
        }
        current.autosaveHold = false
        current.verified = true
        this.commit(current, next, false)
        this.cancelAutosave(current)
        return next
      })
    })
  }

  private async undoReloadFromDisk(bufferId: string): Promise<EditorBuffer> {
    const undo = this.reloadUndo.get(bufferId)
    if (undo === undefined || undo.expiresAt < Date.now()) throw this.context.error('conflict', 'The Reload undo window has expired.')
    const state = this.requireState(bufferId)
    const path = await this.paths.path(state.buffer.worktreeId, state.buffer.relativePath)
    const snapshot = await this.tryReadSnapshot(path.path)
    if (snapshot === null || snapshot.hash !== undo.afterBaseline || state.buffer.baseline !== undo.afterBaseline) {
      throw this.context.error('conflict', 'The file changed again; Reload can no longer be undone safely.')
    }
    this.reloadUndo.delete(bufferId)
    return await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
      const current = this.requireState(bufferId)
      const draft = undo.draft
      current.autosaveHold = undo.held
      const next: EditorBuffer = {
        ...current.buffer,
        draft,
        dirty: draft !== null && draft !== current.buffer.content,
        revision: current.buffer.revision + 1,
        contentRevision: current.buffer.contentRevision + 1
      }
      current.verified = true
      this.commit(current, next, false)
      this.scheduleAutosave(current)
      return next
    })
  }

  private async reconcileBuffer(bufferId: string, source: 'restore' | 'open' | 'watch' | 'reveal'): Promise<EditorBuffer> {
    const state = this.requireState(bufferId)
    const path = await this.paths.path(state.buffer.worktreeId, state.buffer.relativePath, { create: true })
    const keys = await this.fileKeys(path.path)
    return await this.fileQueue.run(keys, async () => {
      const snapshot = await this.tryReadSnapshot(path.path)
      const stamp = this.ownWrites.get(path.path)
      if (stamp !== undefined && stamp.expiresAt > Date.now() && snapshot?.hash === stamp.hash) {
        this.ownWrites.delete(path.path)
        return snapshot.diskWritable === state.buffer.diskWritable
          ? state.buffer
          : await this.updateDiskWritable(bufferId, snapshot.diskWritable)
      }
      if (stamp !== undefined && stamp.expiresAt <= Date.now()) this.ownWrites.delete(path.path)
      return await this.bufferQueue.run([`buffer:${bufferId}`], async () => {
        const current = this.requireState(bufferId)
        const old = current.buffer
          current.diskSignature = null
        if (snapshot === null) {
          const next = { ...old, external: 'deleted' as const, diskContent: null, diskWritable: false, error: null, revision: old.revision + 1 }
          current.verified = false
          this.commit(current, next, false)
          return next
        }
        if (old.baseline === null) {
          current.diskSignature = snapshot.hash
          const next = { ...old, external: 'changed' as const, diskContent: snapshot.text, diskWritable: snapshot.diskWritable, error: 'Disk baseline is unknown; save is blocked until Reload or explicit Overwrite.', revision: old.revision + 1 }
          current.verified = false
          this.commit(current, next, false)
          return next
        }
        if (snapshot.hash === old.baseline) {
          current.diskSignature = null
          const next = old.external === null && old.diskContent === null && old.diskWritable === snapshot.diskWritable
            ? old
            : { ...old, external: null, diskContent: null, diskWritable: snapshot.diskWritable, error: null, revision: old.revision + 1 }
          current.verified = true
          if (next !== old) this.commit(current, next, false)
          return next
        }
        if (old.dirty || current.autosaveHold) {
          current.diskSignature = snapshot.hash
          const next = { ...old, external: 'changed' as const, diskContent: snapshot.text, diskWritable: snapshot.diskWritable, error: null, revision: old.revision + 1 }
          current.verified = false
          this.commit(current, next, false)
          return next
        }
        current.diskSignature = null
        const next: EditorBuffer = {
          ...old,
          content: snapshot.text ?? '',
          draft: null,
          baseline: snapshot.hash,
          size: snapshot.size,
          readOnly: snapshot.readOnly,
          diskWritable: snapshot.diskWritable,
          dirty: false,
          external: null,
          diskContent: null,
          error: null,
          revision: old.revision + 1,
          contentRevision: old.contentRevision + 1
        }
        current.verified = true
        this.commit(current, next, false)
        if (source === 'restore') current.verified = true
        return next
      })
    })
  }

  private scheduleReconcile(worktreeId: string, path: string | null): void {
    if (this.disposed) return
    this.inventory.invalidate()
    const key = path ?? `${worktreeId}\0overflow`
    const existing = this.changeTimers.get(key)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      if (this.disposed) return
      this.changeTimers.delete(key)
      if (path === null) {
        const buffers = [...this.buffers.values()].filter((state) => state.buffer.worktreeId === worktreeId)
        for (const state of buffers) void this.reconcileBuffer(state.buffer.id, 'watch').catch((error) => this.updateError(state, this.errorMessage(error)))
      } else {
        const candidates = [...this.buffers.values()].filter((state) =>
          state.buffer.worktreeId === worktreeId && (state.buffer.path === path || this.paths.isWithin(path, state.buffer.path) || this.paths.isWithin(state.buffer.path, path))
        )
        for (const state of candidates) void this.reconcileBuffer(state.buffer.id, 'watch').catch((error) => this.updateError(state, this.errorMessage(error)))
      }
    }, path === null ? 0 : 75)
    this.changeTimers.set(key, timer)
  }

  private async syncTerminalWorkspace(worktreeId: string): Promise<void> {
    const result = await this.context.call('quirky.terminal/workspace', { workspace: `id:${worktreeId}` }) as { workspace?: TerminalWorkspace }
    if (result.workspace !== undefined) this.syncWorkspaceValue(worktreeId, result.workspace)
  }

  private syncWorkspaceValue(worktreeId: string, workspace: TerminalWorkspace): void {
    const found = new Map<string, TabMapping>()
    const visit = (node: unknown, group?: string) => {
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      const groupId = typeof record.id === 'string' && Array.isArray(record.tabs) ? record.id : group
      if (Array.isArray(record.tabs)) {
        for (const raw of record.tabs) {
          if (raw === null || typeof raw !== 'object') continue
          const tab = raw as Record<string, unknown>
          if (tab.viewId !== EDITOR_DOCUMENT_VIEW || typeof tab.id !== 'string') continue
          const input = tab.input !== null && typeof tab.input === 'object' ? tab.input as Record<string, unknown> : {}
          const bufferId = input.bufferId
          if (typeof bufferId !== 'string') continue
          const inputMode = input.mode === 'source' || input.mode === 'rich' || input.mode === 'preview' ? input.mode : 'source'
          const preview = tab.preview === true
          found.set(tab.id, {
            tabId: tab.id,
            worktreeId,
            bufferId,
            key: typeof tab.key === 'string' ? tab.key : '',
            mode: inputMode === 'preview' ? 'preview' : 'edit',
            inputMode,
            ...(groupId === undefined ? {} : { group: groupId }),
            preview,
            pinned: tab.pinned === true
          })
        }
      }
      if (record.first !== undefined) visit(record.first, groupId)
      if (record.second !== undefined) visit(record.second, groupId)
    }
    visit(workspace.root)
    for (const [tabId, mapping] of this.tabs) if (mapping.worktreeId === worktreeId) this.tabs.delete(tabId)
    for (const [tabId, mapping] of found) this.tabs.set(tabId, mapping)
    const bufferIds = new Set([...this.buffers.values()].filter((state) => state.buffer.worktreeId === worktreeId).map((state) => state.buffer.id))
    for (const bufferId of bufferIds) {
      const state = this.buffers.get(bufferId)
      if (state === undefined) continue
      const { tabId, preview, pinned } = this.bufferTabSummary(bufferId)
      if (state.buffer.tabId !== tabId || state.buffer.preview !== preview || state.buffer.pinned !== pinned) {
        state.buffer = { ...state.buffer, tabId, preview, pinned, revision: state.buffer.revision + 1 }
        this.persist(state)
      }
    }
  }

  private async closeTerminalTab(worktreeId: string, tabId: string): Promise<boolean> {
    const result = await this.context.call('quirky.terminal/closeTab', { tab: tabId }) as { workspace?: TerminalWorkspace }
    if (result.workspace !== undefined) this.syncWorkspaceValue(worktreeId, result.workspace)
    else this.tabs.delete(tabId)
    return true
  }

  private async recordQuickOpen(worktreeId: string, path: string): Promise<void> {
    this.store.run(
      `INSERT INTO editor_quick_open_history(worktree_id, path, visited_at) VALUES (?, ?, ?)
       ON CONFLICT(worktree_id, path) DO UPDATE SET visited_at=excluded.visited_at`,
      worktreeId,
      path,
      Date.now()
    )
    this.store.run(
      `DELETE FROM editor_quick_open_history WHERE worktree_id=? AND path NOT IN
       (SELECT path FROM editor_quick_open_history WHERE worktree_id=? ORDER BY visited_at DESC LIMIT ?)`,
      worktreeId,
      worktreeId,
      RECENT_PATH_LIMIT
    )
  }

  async mutate(params: MutateParams, caller: PluginCaller): Promise<MutationResult> {
    this.assertActive()
    const worktree = await this.paths.resolve(params.worktree, caller)
    if (params.action === 'createFile') return await this.createFile(worktree, params)
    if (params.action === 'createFolder') return await this.createFolder(worktree, params)
    if (params.action === 'rename' || params.action === 'move') return await this.renamePath(worktree, params)
    if (params.action === 'duplicate') return await this.duplicateFile(worktree, params)
    if (params.action === 'delete') return await this.deletePath(worktree, params)
    if (params.action === 'import') return await this.importPaths(worktree, params)
    throw this.context.error('invalid-params', `unknown editor mutation: ${String(params.action)}`)
  }

  private async createFile(worktree: ResolvedWorktree, params: MutateParams): Promise<MutationResult> {
    const content = params.content ?? ''
    const contentBytes = Buffer.byteLength(content, 'utf8')
    if (contentBytes > MAX_TEXT_FILE_BYTES) {
      throw this.context.error('invalid-params', `created file exceeds the ${MAX_TEXT_FILE_BYTES}-byte editor limit`)
    }
    const target = await this.paths.path(worktree.id, params.path, { create: true })
    const keys = await this.fileKeys(target.path)
    await this.fileQueue.run(keys, async () => {
      await mkdir(dirname(target.path), { recursive: true })
      await writeFile(target.path, content, { flag: 'wx', mode: 0o600 })
    })
    if (contentBytes <= 5 * 1024 * 1024) {
      await this.pushHistory(worktree.id, {
        kind: 'create', worktreeId: worktree.id, root: worktree.path,
        path: target.relativePath, directory: false, content, hash: hashText(content)
      })
    }
    this.inventory.invalidate(worktree.path)
    this.emit()
    return { path: target.relativePath }
  }

  private async createFolder(worktree: ResolvedWorktree, params: MutateParams): Promise<MutationResult> {
    const target = await this.paths.path(worktree.id, params.path, { create: true })
    const keys = await this.fileKeys(target.path)
    await this.fileQueue.run(keys, async () => {
      await mkdir(dirname(target.path), { recursive: true })
      await mkdir(target.path)
    })
    await this.pushHistory(worktree.id, {
      kind: 'create', worktreeId: worktree.id, root: worktree.path,
      path: target.relativePath, directory: true, content: null, hash: null
    })
    this.inventory.invalidate(worktree.path)
    this.emit()
    return { path: target.relativePath }
  }

  private async renamePath(worktree: ResolvedWorktree, params: MutateParams): Promise<MutationResult> {
    if (params.newPath === undefined || params.newPath.length === 0) throw this.context.error('invalid-params', 'newPath is required for rename and move')
    const source = await this.paths.entryPath(worktree.id, params.path)
    const target = await this.paths.entryPath(worktree.id, params.newPath, { create: true })
    if (source.path === target.path) return { path: target.relativePath }
    const sourceInfo = await lstat(source.path)
    const directory = sourceInfo.isDirectory()
    if (directory && this.paths.isWithin(source.path, target.path)) throw this.context.error('invalid-params', 'A directory cannot be moved into itself or one of its descendants.')
    const occupiedBuffer = this.pathIndex.get(this.pathKey(worktree.id, target.path))
    if (occupiedBuffer !== undefined && occupiedBuffer !== this.pathIndex.get(this.pathKey(worktree.id, source.path))) {
      throw this.context.error('conflict', `A buffer already owns the destination path: ${target.relativePath}`)
    }
    if (await this.exists(target.path)) throw this.context.error('conflict', `Destination already exists: ${target.relativePath}`)
    const keys = [...await this.fileKeys(source.path), ...await this.fileKeys(target.path)]
    await this.fileQueue.run(keys, async () => {
      await mkdir(dirname(target.path), { recursive: true })
      if (await this.exists(target.path)) throw this.context.error('conflict', `Destination already exists: ${target.relativePath}`)
      await rename(source.path, target.path)
    })
    await this.rekeyBuffers(worktree, source.path, target.path)
    await this.pushHistory(worktree.id, {
      kind: 'rename', worktreeId: worktree.id, root: worktree.path,
      from: source.relativePath, to: target.relativePath,
      dev: sourceInfo.dev, ino: sourceInfo.ino, directory
    })
    this.inventory.invalidate(worktree.path)
    this.emit()
    return { path: target.relativePath }
  }

  private async duplicateFile(worktree: ResolvedWorktree, params: MutateParams): Promise<MutationResult> {
    const source = await this.paths.entryPath(worktree.id, params.path)
    const info = await lstat(source.path)
    if (!info.isFile() || info.isSymbolicLink()) throw this.context.error('invalid-params', 'Only regular files can be duplicated.')
    const snapshot = await this.tryReadSnapshot(source.path)
    const canRecord = snapshot?.text !== null && snapshot !== null && snapshot.size <= 5 * 1024 * 1024
    const target = await this.copyNameTarget(worktree.id, dirname(source.path), basename(source.path))
    const keys = [...await this.fileKeys(source.path), ...await this.fileKeys(target.path)]
    await this.fileQueue.run(keys, async () => {
      await copyFile(source.path, target.path, constants.COPYFILE_EXCL)
    })
    if (canRecord && snapshot !== null && snapshot.text !== null) {
      await this.pushHistory(worktree.id, {
        kind: 'create', worktreeId: worktree.id, root: worktree.path,
        path: target.relativePath, directory: false, content: snapshot.text, hash: snapshot.hash
      })
    }
    this.inventory.invalidate(worktree.path)
    this.emit()
    return { path: target.relativePath }
  }

  private async deletePath(worktree: ResolvedWorktree, params: MutateParams): Promise<MutationResult> {
    const target = await this.paths.entryPath(worktree.id, params.path)
    const info = await lstat(target.path)
    const affected = [...this.buffers.values()].filter((state) =>
      state.buffer.worktreeId === worktree.id &&
      (state.buffer.path === target.path || (info.isDirectory() && this.paths.isWithin(target.path, state.buffer.path)))
    )
    for (const state of affected) {
      if (state.buffer.dirty) await this.save(state.buffer.id, 'user')
      await this.quiesce(state)
    }
    let textSnapshot: FileSnapshot | null = null
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 5 * 1024 * 1024) {
      textSnapshot = await this.tryReadSnapshot(target.path)
      if (textSnapshot?.text === null) textSnapshot = null
    }
    const trashedPath = await this.moveToTrash(target.path)
    if (textSnapshot !== null && textSnapshot.text !== null) {
      await this.pushHistory(worktree.id, {
        kind: 'delete', worktreeId: worktree.id, root: worktree.path,
        path: target.relativePath, trashedPath, content: textSnapshot.text, hash: textSnapshot.hash
      })
    }
    for (const state of affected) {
      const tabs = this.tabsForBuffer(state.buffer.id)
      let lastEdit = false
      for (const tab of tabs) {
        if (tab.mode === 'edit' && this.editTabsForBuffer(state.buffer.id).length === 1) lastEdit = true
        await this.closeTerminalTab(worktree.id, tab.tabId)
      }
      if (lastEdit) for (const listener of this.closeListeners) listener(state.buffer.id)
      if (![...this.tabs.values()].some((tab) => tab.bufferId === state.buffer.id)) this.removeBuffer(state.buffer.id)
    }
    this.inventory.invalidate(worktree.path)
    this.emit()
    return { path: target.relativePath }
  }

  private async importPaths(worktree: ResolvedWorktree, params: MutateParams): Promise<MutationResult> {
    const sourcePaths = params.sourcePaths ?? []
    const uploads = params.files ?? []
    if (sourcePaths.length + uploads.length === 0) throw this.context.error('invalid-params', 'import requires sourcePaths or files')
    if (sourcePaths.length + uploads.length > MAX_UPLOAD_FILES) throw this.context.error('invalid-params', `import is limited to ${MAX_UPLOAD_FILES} files per request`)
    const metadataBytes = sourcePaths.reduce((total, path) => total + Buffer.byteLength(path, 'utf8'), 0) +
      uploads.reduce((total, file) => total + Buffer.byteLength(file.name, 'utf8'), 0)
    if (metadataBytes > MAX_UPLOAD_METADATA_BYTES) throw this.context.error('invalid-params', `import path metadata exceeds ${MAX_UPLOAD_METADATA_BYTES} bytes`)
    const destination = await this.paths.path(worktree.id, params.path)
    const destinationInfo = await stat(destination.path)
    if (!destinationInfo.isDirectory()) throw this.context.error('invalid-params', 'Import destination must be a directory.')
    const budget: ImportCopyBudget = { bytes: 0, files: 0, metadataBytes, created: [] }
    const paths: string[] = []
    const keys = await this.fileKeys(destination.path)
    try {
      for (const sourcePath of sourcePaths) {
        const name = basename(sourcePath)
        this.validateUploadName(name)
        const target = await this.fileQueue.run(keys, async () => {
          const target = await this.importNameTarget(worktree.id, destination.path, name)
          await this.copyExternalTree(sourcePath, target.path, budget, false)
          return target
        })
        paths.push(target.relativePath)
      }
      for (const file of uploads) {
        this.validateUploadName(file.name)
        const bytes = this.decodeBase64(file.data)
        if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw this.context.error('invalid-params', `Import file exceeds ${MAX_TEXT_FILE_BYTES} bytes.`)
        if (budget.files >= MAX_UPLOAD_FILES) throw this.context.error('invalid-params', `Import is limited to ${MAX_UPLOAD_FILES} files per request.`)
        if (budget.bytes + bytes.byteLength > MAX_UPLOAD_TOTAL_BYTES) {
          throw this.context.error('invalid-params', `Import exceeds the ${MAX_UPLOAD_TOTAL_BYTES}-byte request limit.`)
        }
        const target = await this.fileQueue.run(keys, async () => {
          const target = await this.importNameTarget(worktree.id, destination.path, file.name)
          await writeFile(target.path, bytes, { flag: 'wx', mode: 0o600 })
          budget.created.push(target.path)
          return target
        })
        budget.files++
        budget.bytes += bytes.byteLength
        paths.push(target.relativePath)
      }
    } catch (error) {
      for (const path of budget.created.reverse()) await rm(path, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    this.inventory.invalidate(worktree.path)
    this.emit()
    return { path: destination.relativePath || '.', paths }
  }

  private async copyExternalTree(source: string, destination: string, budget: ImportCopyBudget, countName = true): Promise<void> {
    if (countName) {
      budget.metadataBytes += Buffer.byteLength(basename(source), 'utf8') + 1
      if (budget.metadataBytes > MAX_UPLOAD_METADATA_BYTES) throw this.context.error('invalid-params', `import path metadata exceeds ${MAX_UPLOAD_METADATA_BYTES} bytes`)
    }
    const info = await lstat(source)
    if (info.isSymbolicLink()) throw this.context.error('invalid-params', `Import does not follow symlinks: ${source}`)
    if (info.isDirectory()) {
      await mkdir(destination, { mode: 0o700 })
      budget.created.push(destination)
      for (const child of await readdir(source)) await this.copyExternalTree(join(source, child), join(destination, child), budget)
      return
    }
    if (!info.isFile()) throw this.context.error('invalid-params', `Unsupported external import type: ${source}`)
    if (info.size > MAX_TEXT_FILE_BYTES) throw this.context.error('invalid-params', `Import file exceeds ${MAX_TEXT_FILE_BYTES} bytes: ${source}`)
    if (budget.files >= MAX_UPLOAD_FILES) throw this.context.error('invalid-params', `Import is limited to ${MAX_UPLOAD_FILES} files per request.`)
    if (budget.bytes + info.size > MAX_UPLOAD_TOTAL_BYTES) throw this.context.error('invalid-params', `Import exceeds the ${MAX_UPLOAD_TOTAL_BYTES}-byte request limit.`)
    const handle = await openFile(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let data: Buffer
    try {
      const checked = await handle.stat()
      if (!checked.isFile() || checked.dev !== info.dev || checked.ino !== info.ino || checked.size !== info.size) {
        throw this.context.error('conflict', `External import changed while reading: ${source}`)
      }
      data = await handle.readFile()
      const after = await handle.stat()
      if (after.dev !== checked.dev || after.ino !== checked.ino || after.size !== checked.size || data.byteLength !== checked.size) {
        throw this.context.error('conflict', `External import changed while reading: ${source}`)
      }
    } finally {
      await handle.close()
    }
    if (budget.bytes + data.byteLength > MAX_UPLOAD_TOTAL_BYTES) throw this.context.error('invalid-params', `Import exceeds the ${MAX_UPLOAD_TOTAL_BYTES}-byte request limit.`)
    await writeFile(destination, data, { flag: 'wx', mode: 0o600 })
    budget.created.push(destination)
    budget.files++
    budget.bytes += data.byteLength
  }

  private async importNameTarget(worktreeId: string, directory: string, name: string): Promise<{ path: string; relativePath: string }> {
    const original = await this.paths.entryPath(worktreeId, join(directory, name), { create: true })
    if (!(await this.exists(original.path))) return { path: original.path, relativePath: original.relativePath }
    return await this.copyNameTarget(worktreeId, directory, name)
  }

  private async copyNameTarget(worktreeId: string, directory: string, name: string): Promise<{ path: string; relativePath: string }> {
    const extension = extname(name)
    const stem = extension === '' ? name : name.slice(0, -extension.length)
    for (let copy = 0; copy < 10000; copy++) {
      const suffix = copy === 0 ? ' copy' : ` copy ${copy + 1}`
      const candidate = join(directory, `${stem}${suffix}${extension}`)
      if (!(await this.exists(candidate))) {
        const authorized = await this.paths.entryPath(worktreeId, candidate, { create: true })
        return { path: authorized.path, relativePath: authorized.relativePath }
      }
    }
    throw this.context.error('conflict', `Could not choose a collision-free copy name for ${name}`)
  }

  private validateUploadName(name: string): void {
    if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0') || basename(name) !== name) {
      throw this.context.error('invalid-params', `unsafe import filename: ${name}`)
    }
  }

  private decodeBase64(value: string): Buffer {
    if (value.length > Math.ceil(MAX_TEXT_FILE_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw this.context.error('invalid-params', 'uploaded file data must be valid bounded base64')
    }
    const decoded = Buffer.from(value, 'base64')
    if (decoded.toString('base64') !== value) throw this.context.error('invalid-params', 'uploaded file data must use canonical base64 encoding')
    return decoded
  }

  private async moveToTrash(source: string): Promise<string> {
    const trash = join(homedir(), '.Trash')
    await mkdir(trash, { recursive: true, mode: 0o700 })
    const name = basename(source)
    let destination = join(trash, name)
    let suffix = 1
    while (await this.exists(destination)) destination = join(trash, `${name} ${suffix++}`)
    await movePathWithoutOverwrite(source, destination)
    return destination
  }

  private async rekeyBuffers(worktree: ResolvedWorktree, oldPath: string, newPath: string): Promise<void> {
    const affected = [...this.buffers.values()].filter((state) =>
      state.buffer.worktreeId === worktree.id && (state.buffer.path === oldPath || this.paths.isWithin(oldPath, state.buffer.path))
    )
    for (const state of affected) {
      const previous = state.buffer
      const suffix = relative(oldPath, previous.path)
      const path = suffix === '' ? newPath : join(newPath, suffix)
      const relativePath = relative(worktree.path, path)
      const placeholderWasRenamed = previous.path === oldPath && previous.untitled
      this.pathIndex.delete(this.pathKey(worktree.id, previous.path))
      this.pathIndex.set(this.pathKey(worktree.id, path), previous.id)
      if (placeholderWasRenamed) {
        state.placeholderHash = null
        state.placeholderDev = null
        state.placeholderIno = null
        state.placeholderTemplate = false
        state.placeholderEdited = false
      }
      state.buffer = {
        ...previous,
        path,
        relativePath,
        name: basename(path),
        ...(placeholderWasRenamed ? { untitled: false } : {}),
        revision: previous.revision + 1
      }
      this.persist(state)
      const mappings = this.tabsForBuffer(previous.id)
      if (mappings.length > 0) {
        const result = await this.context.call('quirky.terminal/rekeyViewTabs', {
          workspace: `id:${worktree.id}`,
          viewId: EDITOR_DOCUMENT_VIEW,
          changes: mappings.map((tab) => ({
            tab: tab.tabId,
            key: tab.key,
            input: { bufferId: previous.id, mode: tab.inputMode },
            title: editorTabTitle(state.buffer.name, tab.inputMode),
            preview: tab.preview
          }))
        }) as { workspace?: TerminalWorkspace }
        if (result.workspace !== undefined) this.syncWorkspaceValue(worktree.id, result.workspace)
      }
    }
  }

  private async pushHistory(worktreeId: string, operation: HistoryOperation): Promise<void> {
    this.store.transaction(() => {
      this.store.run('DELETE FROM editor_operation_history WHERE worktree_id=? AND undone=1', worktreeId)
      this.store.run(
        'INSERT INTO editor_operation_history(worktree_id, operation, undone, created_at) VALUES (?, ?, 0, ?)',
        worktreeId, JSON.stringify(operation), Date.now()
      )
      this.store.run(
        `DELETE FROM editor_operation_history WHERE worktree_id=? AND id NOT IN
         (SELECT id FROM editor_operation_history WHERE worktree_id=? ORDER BY id DESC LIMIT ?)`,
        worktreeId, worktreeId, MAX_OPERATION_HISTORY
      )
    })
  }

  private async fileHistory(params: { worktree?: string; action: 'state' | 'undo' | 'redo' }, caller: PluginCaller): Promise<HistoryResult> {
    const worktree = await this.paths.resolve(params.worktree, caller)
    if (params.action === 'state') return this.historyCounts(worktree.id)
    const row = params.action === 'undo'
      ? this.store.get<{ id: number; operation: string }>('SELECT id, operation FROM editor_operation_history WHERE worktree_id=? AND undone=0 ORDER BY id DESC LIMIT 1', worktree.id)
      : this.store.get<{ id: number; operation: string }>('SELECT id, operation FROM editor_operation_history WHERE worktree_id=? AND undone=1 ORDER BY id ASC LIMIT 1', worktree.id)
    if (row === null) return this.historyCounts(worktree.id)
    const operation = JSON.parse(row.operation) as HistoryOperation
    if (operation.worktreeId !== worktree.id || operation.root !== worktree.path) throw this.context.error('conflict', 'File operation belongs to a different worktree owner.')
    const next = await this.applyHistoryOperation(operation, params.action)
    this.store.run('UPDATE editor_operation_history SET operation=?, undone=? WHERE id=?', JSON.stringify(next), Number(params.action === 'undo'), row.id)
    this.inventory.invalidate(worktree.path)
    this.emit()
    const counts = this.historyCounts(worktree.id)
    counts.operation = { kind: operation.kind, path: operation.kind === 'rename' ? operation.to : operation.path }
    return counts
  }

  private historyCounts(worktreeId: string): HistoryResult {
    const rows = this.store.all<{ undone: number; operation: string }>(
      'SELECT undone, operation FROM editor_operation_history WHERE worktree_id=? ORDER BY id DESC LIMIT ?',
      worktreeId, MAX_OPERATION_HISTORY
    )
    const undo = rows.filter((row) => row.undone === 0).length
    const redo = rows.filter((row) => row.undone !== 0).length
    const row = rows.find((item) => item.undone === 0) ?? rows.find((item) => item.undone !== 0)
    const operation = row === undefined ? undefined : JSON.parse(row.operation) as HistoryOperation
    return {
      undo, redo, canUndo: undo > 0, canRedo: redo > 0,
      ...(operation === undefined ? {} : { operation: { kind: operation.kind, path: operation.kind === 'rename' ? operation.to : operation.path } })
    }
  }

  private async applyHistoryOperation(operation: HistoryOperation, action: 'undo' | 'redo'): Promise<HistoryOperation> {
    if (operation.kind === 'create') return await this.applyCreateHistory(operation, action)
    if (operation.kind === 'rename') return await this.applyRenameHistory(operation, action)
    return await this.applyDeleteHistory(operation, action)
  }

  private async applyCreateHistory(operation: Extract<HistoryOperation, { kind: 'create' }>, action: 'undo' | 'redo'): Promise<HistoryOperation> {
    const relativePath = operation.path
    const target = await this.paths.entryPath(operation.worktreeId, relativePath, { create: action === 'redo' })
    if (action === 'undo') {
      if (operation.directory) {
        const entries = await readdir(target.path)
        if (entries.length > 0) throw this.context.error('conflict', `Cannot undo create because ${relativePath} is not empty.`)
        await rmdir(target.path)
      } else {
        const snapshot = await this.tryReadSnapshot(target.path)
        if (snapshot === null || operation.hash === null || snapshot.hash !== operation.hash) throw this.context.error('conflict', `Cannot undo create because ${relativePath} changed.`)
        await unlink(target.path)
      }
      return operation
    }
    if (await this.exists(target.path)) throw this.context.error('conflict', `Cannot redo create because ${relativePath} already exists.`)
    await mkdir(dirname(target.path), { recursive: true })
    if (operation.directory) await mkdir(target.path)
    else if (operation.content !== null) await writeFile(target.path, operation.content, { flag: 'wx', mode: 0o600 })
    else throw this.context.error('conflict', `Cannot redo large create ${relativePath}; its original bytes were not retained.`)
    return operation
  }

  private async applyRenameHistory(operation: Extract<HistoryOperation, { kind: 'rename' }>, action: 'undo' | 'redo'): Promise<HistoryOperation> {
    const from = action === 'undo' ? operation.to : operation.from
    const to = action === 'undo' ? operation.from : operation.to
    const source = await this.paths.entryPath(operation.worktreeId, from)
    const target = await this.paths.entryPath(operation.worktreeId, to, { create: true })
    const sourceInfo = await lstat(source.path)
    if (sourceInfo.dev !== operation.dev || sourceInfo.ino !== operation.ino) throw this.context.error('conflict', `Cannot ${action} rename because ${from} changed.`)
    if (await this.exists(target.path)) throw this.context.error('conflict', `Cannot ${action} rename because ${to} now exists.`)
    await mkdir(dirname(target.path), { recursive: true })
    await rename(source.path, target.path)
    await this.rekeyBuffers({ id: operation.worktreeId, path: operation.root }, source.path, target.path)
    return operation
  }

  private async applyDeleteHistory(operation: Extract<HistoryOperation, { kind: 'delete' }>, action: 'undo' | 'redo'): Promise<HistoryOperation> {
    const destination = await this.paths.entryPath(operation.worktreeId, operation.path, { create: action === 'undo' })
    if (action === 'undo') {
      if (await this.exists(destination.path)) throw this.context.error('conflict', `Cannot undo delete because ${operation.path} already exists.`)
      const snapshot = await this.tryReadSnapshot(operation.trashedPath)
      if (snapshot === null || snapshot.hash !== operation.hash) throw this.context.error('conflict', 'Cannot undo delete because the trashed file changed or is missing.')
      await mkdir(dirname(destination.path), { recursive: true })
      await movePathWithoutOverwrite(operation.trashedPath, destination.path)
      return operation
    }
    const snapshot = await this.tryReadSnapshot(destination.path)
    if (snapshot === null || snapshot.hash !== operation.hash) throw this.context.error('conflict', `Cannot redo delete because ${operation.path} changed.`)
    const trashedPath = await this.moveToTrash(destination.path)
    return { ...operation, trashedPath }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
      throw error
    }
  }
  private defaultMode(kind: EditorBuffer['kind'], requested?: EditorMode): EditorMode {
    if (requested !== undefined) return requested
    return ['markdown', 'notebook', 'csv', 'mermaid'].includes(kind) ? 'rich' : 'source'
  }

  private async readSnapshot(path: string): Promise<FileSnapshot> {
    try {
      return await readSnapshot(path)
    } catch (error) {
      const message = this.errorMessage(error)
      throw this.context.error('invalid-params', message)
    }
  }

  private async tryReadSnapshot(path: string): Promise<FileSnapshot | null> {
    try {
      return await readSnapshot(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw error
    }
  }

  private async fileKeys(path: string): Promise<string[]> {
    const keys = [`path:${path}`]
    try {
      const info = await lstat(path)
      keys.push(`inode:${info.dev}:${info.ino}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
    return keys
  }
  private async unlinkIfMatches(path: string, expectedHash: string, expectedDev: number, expectedIno: number): Promise<boolean> {
    try {
      const before = await lstat(path)
      if (before.isSymbolicLink() || !before.isFile() || before.dev !== expectedDev || before.ino !== expectedIno) return false
      const snapshot = await this.tryReadSnapshot(path)
      if (snapshot === null || snapshot.hash !== expectedHash) return false
      const after = await lstat(path)
      if (after.isSymbolicLink() || !after.isFile() || after.dev !== expectedDev || after.ino !== expectedIno) return false
      await unlink(path)
      return true
    } catch {
      return false
    }
  }

  private async forceWrite(path: string, content: string): Promise<'written' | 'missing'> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw this.context.error('invalid-params', `file exceeds the ${MAX_TEXT_FILE_BYTES}-byte save limit`)
    try {
      const handle = await openFile(path, constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await handle.stat()
        const canonical = await realpath(path)
        if (!info.isFile() || canonical !== path) throw this.context.error('invalid-params', 'Overwrite target is not a canonical regular file.')
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return 'written'
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      const handle = await openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return 'written'
    }
  }

  private async markWriteConflict(state: PrivateBuffer, path: string, external: 'changed' | 'deleted'): Promise<void> {
    const disk = external === 'changed' ? await this.tryReadSnapshot(path).catch(() => null) : null
    await this.bufferQueue.run([`buffer:${state.buffer.id}`], async () => {
      const current = this.requireState(state.buffer.id)
      current.diskSignature = disk?.hash ?? null
      this.commit(current, {
        ...current.buffer,
        external,
        diskContent: disk?.text ?? null,
        diskWritable: disk?.diskWritable ?? false,
        revision: current.buffer.revision + 1
      }, false)
      current.verified = false
    })
  }

  private async promoteBufferIfNeeded(state: PrivateBuffer): Promise<void> {
    if (state.buffer.preview) await this.promoteBuffer(state.buffer.id)
  }

  private scheduleAutosave(state: PrivateBuffer): void {
    this.cancelAutosave(state)
    if (!this.autosaveEligible(state) || state.autosaveHold || !state.verified || this.disposed) return
    const setting = this.setting('editorAutoSave', false)
    if (!setting) return
    const delayValue = this.context.getSetting('editorAutoSaveDelayMs')
    const delay = typeof delayValue === 'number' && Number.isFinite(delayValue)
      ? Math.max(AUTO_SAVE_MIN_DELAY, Math.min(AUTO_SAVE_MAX_DELAY, Math.trunc(delayValue)))
      : 1000
    const generation = state.generation
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (state.generation !== generation || state.autosaveHold || !state.verified || this.disposed) return
      void this.save(state.buffer.id, 'autosave').catch((error) => this.updateError(state, this.errorMessage(error)))
    }, delay)
  }

  private cancelAutosave(state: PrivateBuffer): void {
    state.generation++
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
  }

  private async quiesce(state: PrivateBuffer): Promise<void> {
    this.cancelAutosave(state)
    if (state.inFlight !== undefined) await state.inFlight.catch(() => undefined)
  }

  private autosaveEligible(state: PrivateBuffer): boolean {
    return !state.buffer.untitled && state.buffer.dirty && state.buffer.draft !== null && !state.buffer.readOnly && state.buffer.external === null && state.buffer.baseline !== null && state.transferHolds.size === 0
  }

  private commit(state: PrivateBuffer, buffer: EditorBuffer, contentMutation: boolean): void {
    if (contentMutation) buffer.contentRevision = state.buffer.contentRevision + 1
    if (buffer.content !== state.buffer.content) {
      state.contentBytes = Buffer.byteLength(buffer.content, 'utf8')
      state.contentLength = buffer.content.length
    }
    if (buffer.draft !== state.buffer.draft) {
      state.draftBytes = buffer.draft === null ? null : Buffer.byteLength(buffer.draft, 'utf8')
      state.draftLength = buffer.draft === null ? null : buffer.draft.length
    }
    if (buffer.diskContent !== state.buffer.diskContent) {
      state.diskContentBytes = buffer.diskContent === null ? null : Buffer.byteLength(buffer.diskContent, 'utf8')
      state.diskContentLength = buffer.diskContent === null ? null : buffer.diskContent.length
    }
    state.buffer = buffer
    this.persist(state)
    this.emit()
  }

  private persist(state: PrivateBuffer): void {
    if (this.disposed) return
    saveBuffer(this.store, state.buffer, state.autosaveHold, {
      contentBytes: state.contentBytes,
      contentLength: state.contentLength,
      draftBytes: state.draftBytes,
      draftLength: state.draftLength,
      diskContentBytes: state.diskContentBytes,
      diskContentLength: state.diskContentLength,
      diskSignature: state.diskSignature,
      placeholderHash: state.placeholderHash,
      placeholderDev: state.placeholderDev,
      placeholderIno: state.placeholderIno,
      placeholderTemplate: state.placeholderTemplate,
      placeholderEdited: state.placeholderEdited
    })
  }

  private updateError(state: PrivateBuffer, error: string): void {
    if (this.disposed) return
    const latest = this.buffers.get(state.buffer.id)
    if (latest === undefined) return
    latest.buffer = { ...latest.buffer, error, revision: latest.buffer.revision + 1 }
    this.persist(latest)
    this.emit()
  }

  private removeBuffer(bufferId: string): void {
    const state = this.buffers.get(bufferId)
    if (state === undefined) return
    this.cancelAutosave(state)
    this.buffers.delete(bufferId)
    this.pathIndex.delete(this.pathKey(state.buffer.worktreeId, state.buffer.path))
    this.store.run('DELETE FROM editor_buffers WHERE id=?', bufferId)
    this.reloadUndo.delete(bufferId)
    this.closeRequests.forEach((request, tabId) => { if (request.bufferId === bufferId) this.closeRequests.delete(tabId) })
    const remaining = [...this.buffers.values()].some((item) => item.buffer.worktreeId === state.buffer.worktreeId)
    if (!remaining) this.watcher.drop(state.buffer.worktreeId)
  }

  private async fileKeysForBuffer(state: PrivateBuffer): Promise<string[]> {
    const path = await this.paths.path(state.buffer.worktreeId, state.buffer.relativePath, { create: true })
    return await this.fileKeys(path.path)
  }

  private requireState(bufferId: string): PrivateBuffer {
    const state = this.buffers.get(bufferId)
    if (state === undefined) throw this.context.error('not-found', `editor buffer not found: ${bufferId}`)
    return state
  }

  private tabsForBuffer(bufferId: string): TabMapping[] {
    return [...this.tabs.values()].filter((tab) => tab.bufferId === bufferId)
  }

  private editTabsForBuffer(bufferId: string): TabMapping[] {
    return this.tabsForBuffer(bufferId).filter((tab) => tab.mode === 'edit')
  }
  private bufferTabSummary(bufferId: string): { tabId: string | null; preview: boolean; pinned: boolean } {
    const tabs = this.tabsForBuffer(bufferId)
    const primary = this.editTabsForBuffer(bufferId)[0]
    const fallback = tabs.find((tab) => tab.preview) ?? tabs.find((tab) => tab.inputMode === 'preview')
    return {
      tabId: primary?.tabId ?? null,
      preview: primary?.preview ?? fallback?.preview ?? false,
      pinned: primary?.pinned ?? fallback?.pinned ?? false
    }
  }
  private isSafeMarkdownAnchor(value: unknown): value is string {
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 512 && !/[\x00-\x1F\x7F\/#?\\]/u.test(value)
  }

  private pathKey(worktreeId: string, path: string): string {
    return `${worktreeId}\0${path}`
  }



  private setting(name: string, fallback: boolean): boolean {
    const value = this.context.getSetting(name)
    return typeof value === 'boolean' ? value : fallback
  }

  private assertActive(): void {
    if (this.disposed) throw this.context.error('conflict', 'editor service is disposed')
  }

  private translateFsError(error: unknown, path: string): Error {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return this.context.error('not-found', `file does not exist: ${path}`)
    if (code === 'EACCES' || code === 'EPERM') return this.context.error('invalid-params', `access denied: ${path}`)
    return error instanceof Error ? error : new Error(String(error))
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
