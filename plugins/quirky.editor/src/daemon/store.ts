import type { EditorBuffer } from '../types'
import type { PluginStore, StoreMigration } from '@quirky/protocol'
export type BufferMetrics = {
  contentBytes: number
  contentLength: number
  draftBytes: number | null
  draftLength: number | null
  diskContentBytes: number | null
  diskContentLength: number | null
  diskSignature: string | null
}

export const editorMigrations: StoreMigration[] = [
  `
    CREATE TABLE editor_buffers (
      id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL,
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      content_bytes INTEGER NOT NULL,
      content_length INTEGER NOT NULL,
      draft TEXT,
      draft_bytes INTEGER,
      draft_length INTEGER,
      baseline TEXT,
      size INTEGER NOT NULL,
      read_only INTEGER NOT NULL,
      dirty INTEGER NOT NULL,
      external TEXT,
      disk_content TEXT,
      disk_content_bytes INTEGER,
      disk_content_length INTEGER,
      disk_signature TEXT,
      mode TEXT NOT NULL,
      tab_id TEXT,
      preview INTEGER NOT NULL,
      pinned INTEGER NOT NULL,
      untitled INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      content_revision INTEGER NOT NULL,
      view_json TEXT NOT NULL,
      error TEXT,
      autosave_hold INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX editor_buffers_worktree_path ON editor_buffers(worktree_id, path);
    CREATE TABLE editor_explorer_preferences (
      worktree_id TEXT PRIMARY KEY,
      show_dotfiles INTEGER NOT NULL DEFAULT 1,
      display_root TEXT
    );
    CREATE TABLE editor_quick_open_history (
      worktree_id TEXT NOT NULL,
      path TEXT NOT NULL,
      visited_at INTEGER NOT NULL,
      PRIMARY KEY(worktree_id, path)
    );
    CREATE INDEX editor_quick_open_recent ON editor_quick_open_history(worktree_id, visited_at DESC);
    CREATE TABLE editor_operation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worktree_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX editor_operation_history_stack ON editor_operation_history(worktree_id, id DESC);
    CREATE TABLE editor_notes (
      id TEXT PRIMARY KEY,
      buffer_id TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `
]

type BufferRow = {
  id: string
  worktree_id: string
  root: string
  path: string
  relative_path: string
  name: string
  kind: EditorBuffer['kind']
  content: string
  content_bytes: number
  content_length: number
  draft: string | null
  draft_bytes: number | null
  draft_length: number | null
  baseline: string | null
  size: number
  read_only: number
  dirty: number
  external: EditorBuffer['external']
  disk_content: string | null
  disk_content_bytes: number | null
  disk_content_length: number | null
  disk_signature: string | null
  mode: EditorBuffer['mode']
  tab_id: string | null
  preview: number
  pinned: number
  untitled: number
  revision: number
  content_revision: number
  view_json: string
  error: string | null
}

export function loadBuffers(store: PluginStore): EditorBuffer[] {
  return store.all<BufferRow>('SELECT * FROM editor_buffers ORDER BY updated_at, id').map((row) => ({
    id: row.id,
    worktreeId: row.worktree_id,
    root: row.root,
    path: row.path,
    relativePath: row.relative_path,
    name: row.name,
    kind: row.kind,
    content: row.content,
    draft: row.draft,
    baseline: row.baseline,
    size: row.size,
    readOnly: row.read_only !== 0,
    dirty: row.dirty !== 0,
    external: row.external,
    diskContent: row.disk_content,
    mode: row.mode,
    tabId: row.tab_id,
    preview: row.preview !== 0,
    pinned: row.pinned !== 0,
    untitled: row.untitled !== 0,
    revision: row.revision,
    contentRevision: row.content_revision,
    view: JSON.parse(row.view_json) as Record<string, unknown>,
    error: row.error
  }))
}

export function loadBufferMetrics(store: PluginStore): Map<string, BufferMetrics> {
  const rows = store.all<{ id: string; content_bytes: number; content_length: number; draft_bytes: number | null; draft_length: number | null; disk_content_bytes: number | null; disk_content_length: number | null; disk_signature: string | null }>(
    'SELECT id, content_bytes, content_length, draft_bytes, draft_length, disk_content_bytes, disk_content_length, disk_signature FROM editor_buffers'
  )
  return new Map(rows.map((row) => [row.id, {
    contentBytes: row.content_bytes,
    contentLength: row.content_length,
    draftBytes: row.draft_bytes,
    draftLength: row.draft_length,
    diskContentBytes: row.disk_content_bytes,
    diskContentLength: row.disk_content_length,
    diskSignature: row.disk_signature
  }]))
}
export function saveBuffer(store: PluginStore, buffer: EditorBuffer, autosaveHold: boolean, metrics: BufferMetrics): void {
  store.run(
    `INSERT INTO editor_buffers (
      id, worktree_id, root, path, relative_path, name, kind, content, content_bytes, content_length,
      draft, draft_bytes, draft_length, baseline, size, read_only, dirty, external, disk_content,
      disk_content_bytes, disk_content_length, disk_signature, mode, tab_id, preview, pinned, untitled,
      revision, content_revision, view_json, error, autosave_hold, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      worktree_id=excluded.worktree_id, root=excluded.root, path=excluded.path,
      relative_path=excluded.relative_path, name=excluded.name, kind=excluded.kind,
      content=excluded.content, content_bytes=excluded.content_bytes, content_length=excluded.content_length,
      draft=excluded.draft, draft_bytes=excluded.draft_bytes, draft_length=excluded.draft_length,
      baseline=excluded.baseline, size=excluded.size, read_only=excluded.read_only, dirty=excluded.dirty,
      external=excluded.external, disk_content=excluded.disk_content,
      disk_content_bytes=excluded.disk_content_bytes, disk_content_length=excluded.disk_content_length,
      disk_signature=excluded.disk_signature, mode=excluded.mode, tab_id=excluded.tab_id,
      preview=excluded.preview, pinned=excluded.pinned, untitled=excluded.untitled,
      revision=excluded.revision, content_revision=excluded.content_revision, view_json=excluded.view_json,
      error=excluded.error, autosave_hold=excluded.autosave_hold, updated_at=excluded.updated_at`,
    buffer.id,
    buffer.worktreeId,
    buffer.root,
    buffer.path,
    buffer.relativePath,
    buffer.name,
    buffer.kind,
    buffer.content,
    metrics.contentBytes,
    metrics.contentLength,
    buffer.draft,
    metrics.draftBytes,
    metrics.draftLength,
    buffer.baseline,
    buffer.size,
    Number(buffer.readOnly),
    Number(buffer.dirty),
    buffer.external,
    buffer.diskContent,
    metrics.diskContentBytes,
    metrics.diskContentLength,
    metrics.diskSignature,
    buffer.mode,
    buffer.tabId,
    Number(buffer.preview),
    Number(buffer.pinned),
    Number(buffer.untitled),
    buffer.revision,
    buffer.contentRevision,
    JSON.stringify(buffer.view),
    buffer.error,
    Number(autosaveHold),
    Date.now()
  )
}
