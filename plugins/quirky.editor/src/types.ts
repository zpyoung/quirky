import type { MethodHandler, PluginCaller, PluginContext, PluginStore, UiPluginContext } from '@quirky/protocol'

export type EditorKind = 'text' | 'markdown' | 'notebook' | 'csv' | 'image' | 'pdf' | 'audio' | 'video' | 'mermaid' | 'binary'
export type EditorMode = 'source' | 'rich' | 'preview'
export type EditorTabMode = 'edit' | 'preview'

export type EditorBuffer = {
  id: string
  worktreeId: string
  root: string
  path: string
  relativePath: string
  name: string
  kind: EditorKind
  content: string
  draft: string | null
  baseline: string | null
  size: number
  readOnly: boolean
  dirty: boolean
  external: 'changed' | 'deleted' | null
  diskContent: string | null
  mode: EditorMode
  tabId: string | null
  preview: boolean
  pinned: boolean
  untitled: boolean
  revision: number
  contentRevision: number
  view: Record<string, unknown>
  error: string | null
}

export type EditorBufferInfo = Omit<EditorBuffer, 'content' | 'draft' | 'diskContent'> & {
  content?: string
  draft?: string | null
  diskContent?: string | null
  contentLength: number
  draftLength: number | null
  diskContentLength: number | null
  contentBytes: number
  draftBytes: number | null
  diskContentBytes: number | null
  diskSignature: string | null
}
export type EditorOpenData = EditorBuffer & { openedTabId: string }
export type EditorOpenResult = EditorBufferInfo & { openedTabId: string }

export type EditorTransferKind = 'draft' | 'createFile' | 'import'
export type EditorTransferBeginParams =
  | { action: 'begin'; kind: 'draft'; bufferId: string; expectedRevision: number; totalBytes: number }
  | { action: 'begin'; kind: 'createFile'; worktree?: string; path: string; totalBytes: number }
  | { action: 'begin'; kind: 'import'; worktree?: string; path: string; name: string; totalBytes: number }
export type EditorTransferChunkParams = { action: 'chunk'; transferId: string; offset: number; data: string }
export type EditorTransferParams =
  | EditorTransferBeginParams
  | EditorTransferChunkParams
  | { action: 'commit' | 'cancel' | 'state'; transferId: string }

export type EditorTransferBeginResult = { transferId: string; offset: number; maxChunkBytes: number }
export type EditorTransferChunkResult = { transferId: string; offset: number; nextOffset: number }
export type EditorTransferStateResult = {
  transferId: string
  kind: EditorTransferKind
  offset: number
  totalBytes: number
  expiresAt: number
  progress: number
}
export type EditorTransferCancelResult = { transferId: string; cancelled: boolean }
export type EditorTransferResult =
  | EditorTransferBeginResult
  | EditorTransferChunkResult
  | EditorTransferStateResult
  | EditorTransferCancelResult

export type EditorReadParams =
  | { bufferId: string; action: 'buffer' }
  | { bufferId: string; action: 'bytes'; offset?: number; length?: number }
  | { bufferId: string; action: 'text'; kind: 'content' | 'draft'; offset: number; length?: number; contentRevision: number; diskSignature?: never }
  | { bufferId: string; action: 'text'; kind: 'disk'; offset: number; length?: number; contentRevision: number; diskSignature: string }
export type EditorReadResult =
  | { buffer: EditorBuffer; eof: true; size: number }
  | { data: string; eof: boolean; size: number }
  | { text: string; offset: number; nextOffset: number; eof: boolean; contentRevision: number; diskSignature?: string }

export type EditorSurfaceBuffer = Omit<EditorBuffer, 'diskContent'> & {
  diskContent?: string | null
  diskContentLength: number | null
  diskContentBytes: number | null
  diskSignature: string | null
}

export type EditorSurfaceAction = 'find' | 'replace' | 'copy-context' | 'add-review-note' | 'zoom-in' | 'zoom-out' | 'reset-zoom'
export type EditorSurfaceCommandHandler = (args?: Record<string, unknown>) => unknown | Promise<unknown>
export type EditorSurfaceCommandHandlers = Partial<Record<EditorSurfaceAction, EditorSurfaceCommandHandler>> & {
  flush?: () => void | Promise<void>
}
export type SurfaceProps = {
  context: UiPluginContext
  buffer: EditorSurfaceBuffer
  fontSize: number
  onDraft(content: string): void
  onAction(method: string, params: Record<string, unknown>): Promise<unknown>
  onView(patch: Record<string, unknown>): void
  registerCommandHandlers(handlers: EditorSurfaceCommandHandlers): () => void
}
export interface EditorServices {
  context: PluginContext
  store: PluginStore
  get(bufferId: string): EditorBuffer
  resolve(worktree?: string, caller?: PluginCaller): Promise<{ id: string; path: string }>
  path(worktreeId: string, relativePath: string, options?: { create?: boolean }): Promise<string>
  draft(bufferId: string, content: string, expectedRevision: number): Promise<EditorBuffer>
  save(bufferId: string, trigger?: 'user' | 'autosave' | 'overwrite'): Promise<EditorBuffer>
  readBytes(bufferId: string, offset: number, length: number): Promise<{ data: string; eof: boolean; size: number }>
  updateView(bufferId: string, patch: Record<string, unknown>): Promise<EditorBuffer>
  emit(): void
  onClose(listener: (bufferId: string) => void): () => void
}

export type FeatureMethods = {
  methods: Record<string, MethodHandler>
  dispose(): void | Promise<void>
}

export type EditorTab = {
  tabId: string
  bufferId: string
  mode: EditorTabMode
  group?: string
}

export type ExplorerEntry = {
  path: string
  name: string
  isDirectory: boolean
  isSymlink: boolean
  ignored?: boolean
  error?: string
}

export type SearchMatch = {
  line: number
  column: number
  matchLength: number
  lineContent: string
  displayColumn?: number
  displayMatchLength?: number
}

export type SearchFile = {
  path: string
  relativePath: string
  matches: SearchMatch[]
  matchCount?: number
}

export type EditorSearchState = {
  worktreeId: string
  query: string
  loading: boolean
  error: string | null
  files: SearchFile[]
  totalMatches: number
  truncated: boolean
  requestId: string | null
}

export type EditorBufferStateInfo = Omit<EditorBufferInfo, 'content' | 'draft' | 'diskContent'>
export type EditorState = {
  buffers: EditorBufferStateInfo[]
  tabs: EditorTab[]
  explorer: { worktreeId: string; showDotfiles: boolean; expanded: string[] }
  search: EditorSearchState | null
  quickOpenHistory: { worktreeId: string; paths: string[] }[]
  closeRequests: { bufferId: string; tabId: string; dirty: boolean }[]
}
export type EditorStateData = Omit<EditorState, 'buffers'> & { buffers: EditorBuffer[] }

export type EditorOpenParams = {
  worktree?: string
  path: string
  preview?: boolean
  pinned?: boolean
  focus?: boolean
  mode?: EditorMode
  group?: string
  line?: number
  column?: number
  matchLength?: number
}

export type EditorMutateAction = 'createFile' | 'createFolder' | 'rename' | 'move' | 'duplicate' | 'delete' | 'import'
export type EditorMutateParams = {
  worktree?: string
  action: EditorMutateAction
  path: string
  newPath?: string
  content?: string
  sourcePaths?: string[]
  files?: { name: string; data: string }[]
  yes?: boolean
}
