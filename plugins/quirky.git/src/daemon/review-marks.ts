import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MAX_BLOB_BYTES, contentHash } from '@quirky/git'
import type { PluginStore } from '@quirky/protocol'

/** The hash a mark stores for a file that is not on disk. */
export const DELETED_HASH = 'deleted'

/** A review mark: the content of `path` when the user marked it reviewed. */
export type ReviewMark = {
  worktreeId: string
  path: string
  /** The effective base ref name when marked. */
  baseKey: string
  /** sha-256 hex of the marked bytes, or `DELETED_HASH`. */
  hash: string
  /** The marked text; null for binary, too-large and deleted files. */
  content: Uint8Array | null
  markedAt: number
}

type MarkRow = {
  worktree_id: string
  path: string
  base_key: string
  hash: string
  content: Uint8Array | null
  marked_at: number
}

const toMark = (row: MarkRow): ReviewMark => ({
  worktreeId: row.worktree_id,
  path: row.path,
  baseKey: row.base_key,
  hash: row.hash,
  content: row.content === null ? null : new Uint8Array(row.content),
  markedAt: row.marked_at
})

/** The `review_marks` table: every read and write of review marks goes through here. */
export class ReviewMarks {
  constructor(private readonly store: PluginStore) {}

  /** A worktree's marks without their content, for evaluating them against the disk. */
  list(worktreeId: string): Omit<ReviewMark, 'content'>[] {
    return this.store
      .all<Omit<MarkRow, 'content'>>('SELECT worktree_id, path, base_key, hash, marked_at FROM review_marks WHERE worktree_id = ?', worktreeId)
      .map((row) => ({ worktreeId: row.worktree_id, path: row.path, baseKey: row.base_key, hash: row.hash, markedAt: row.marked_at }))
  }

  get(worktreeId: string, path: string): ReviewMark | null {
    const row = this.store.get<MarkRow>('SELECT * FROM review_marks WHERE worktree_id = ? AND path = ?', worktreeId, path)
    return row ? toMark(row) : null
  }

  /** Stores `mark`, replacing the one for the same worktree and path. */
  put(mark: ReviewMark): void {
    this.store.run(
      'INSERT OR REPLACE INTO review_marks (worktree_id, path, base_key, hash, content, marked_at) VALUES (?, ?, ?, ?, ?, ?)',
      mark.worktreeId,
      mark.path,
      mark.baseKey,
      mark.hash,
      mark.content,
      mark.markedAt
    )
  }

  remove(worktreeId: string, path: string): void {
    this.store.run('DELETE FROM review_marks WHERE worktree_id = ? AND path = ?', worktreeId, path)
  }

  /** Deletes the marks of `paths` in one transaction. */
  removeAll(worktreeId: string, paths: readonly string[]): void {
    this.store.transaction(() => {
      for (const path of paths) this.remove(worktreeId, path)
    })
  }

  /** Deletes every mark of the worktree and returns how many went. */
  clear(worktreeId: string): number {
    return this.store.run('DELETE FROM review_marks WHERE worktree_id = ?', worktreeId).changes
  }

  /** Moves the mark of `path` to new content when it still holds `fromHash`; false when it does not. */
  move(worktreeId: string, path: string, fromHash: string, to: { hash: string; content: Uint8Array | null }, now: number): boolean {
    const { changes } = this.store.run(
      'UPDATE review_marks SET hash = ?, content = ?, marked_at = ? WHERE worktree_id = ? AND path = ? AND hash = ?',
      to.hash,
      to.content,
      now,
      worktreeId,
      path,
      fromHash
    )
    return changes > 0
  }
}

/** What is on disk at a path: its hash (null when nothing readable is there) and, for small text, its bytes. */
export type DiskContent = { hash: string | null; content: Uint8Array | null }

/** The bytes a mark keeps for `bytes`: text up to `MAX_BLOB_BYTES`, else null (hash only). */
export function storable(bytes: Uint8Array): Uint8Array | null {
  return bytes.length > MAX_BLOB_BYTES || bytes.includes(0) ? null : bytes
}

function hashFile(full: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(full)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

/**
 * The working copy of a file as a review mark sees it: hashed like the diff's `modifiedHash`
 * (a symlink leaf by its target text, never followed), with a missing path or a non-file
 * giving a null hash.
 */
export async function readDisk(full: string): Promise<DiskContent> {
  let info
  try {
    info = await lstat(full)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { hash: null, content: null }
    throw error
  }
  if (info.isSymbolicLink()) {
    const bytes = new TextEncoder().encode(await readlink(full))
    return { hash: contentHash(bytes), content: storable(bytes) }
  }
  if (!info.isFile()) return { hash: null, content: null }
  if (info.size > MAX_BLOB_BYTES) return { hash: await hashFile(full), content: null }
  const bytes = new Uint8Array(await readFile(full))
  return { hash: contentHash(bytes), content: storable(bytes) }
}
