import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import { ChangedOnDiskError, MAX_RENDER_CHARACTERS, MAX_RENDER_LINES_PER_SIDE, STATUS_ENTRY_LIMIT, gitApi } from '@quirky/git'
import type { GitChange, GitDiff, GitStatusEntry, ReviewFile, ReviewMarkState, ReviewModel, Worktree } from '@quirky/protocol'
import { compareBase } from './base'
import { readCompare } from './compare'
import type { DaemonEnv, Handler } from './env'
import { serialised } from './files'
import { containedPath } from './paths'
import { DELETED_HASH, hashDisk, readDisk, storable } from './review-marks'

const LETTERS: Record<GitChange['status'], ReviewFile['status']> = {
  modified: 'M',
  added: 'A',
  untracked: 'A',
  copied: 'A',
  deleted: 'D',
  renamed: 'R'
}

const AREA_ORDER: GitStatusEntry['area'][] = ['staged', 'conflicts', 'unstaged', 'untracked']
const HASH_CONCURRENCY = 32

const utf8 = new TextEncoder()
const byteOrder = (a: string, b: string): number => Buffer.compare(utf8.encode(a), utf8.encode(b))

/** What the status says about one path across its areas. */
type Facts = { staged: boolean; conflict?: GitStatusEntry['conflict']; entry: GitStatusEntry; entries: GitStatusEntry[] }

function factsByPath(entries: readonly GitStatusEntry[]): Map<string, Facts> {
  const facts = new Map<string, Facts>()
  const ranked = [...entries].sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area))
  for (const entry of ranked) {
    const known = facts.get(entry.path)
    if (!known) {
      facts.set(entry.path, { staged: entry.area === 'staged', ...(entry.conflict ? { conflict: entry.conflict } : {}), entry, entries: [entry] })
      continue
    }
    known.entries.push(entry)
    if (entry.area === 'staged') known.staged = true
    if (entry.conflict) known.conflict ??= entry.conflict
  }
  return facts
}

/** The change the status alone shows for a path: its first area's letter, line counts summed across areas (null when any is unknown). */
function statusChange({ entry, entries }: Facts): GitChange {
  const total = (key: 'added' | 'removed'): number | null =>
    entries.every((each) => each[key] !== undefined) ? entries.reduce((sum, each) => sum + (each[key] ?? 0), 0) : null
  return {
    path: entry.path,
    ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
    status: entry.status,
    added: total('added'),
    removed: total('removed'),
    binary: entries.some((each) => each.binary === true)
  }
}

/** Whether a mark still holds the bytes at its path; a path that left the worktree or cannot be read counts as changed and is never followed. */
async function markState(worktreePath: string, mark: { path: string; hash: string }): Promise<ReviewMarkState> {
  try {
    const { absolute } = await containedPath(worktreePath, mark.path)
    return ((await hashDisk(absolute)) ?? DELETED_HASH) === mark.hash ? 'reviewed' : 'changed'
  } catch {
    return 'changed'
  }
}

/** Evaluates `check` over `items` a few at a time so a long list does not open every file at once. */
async function inBatches<T, R>(items: readonly T[], check: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += HASH_CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(i, i + HASH_CONCURRENCY).map(check))))
  }
  return results
}

/**
 * The review of a worktree: every file that differs from the merge base with the base ref, once,
 * with its counts, whether it is uncommitted or staged, and its review mark evaluated against the
 * bytes on disk. When the compare cannot run the files are the uncommitted ones and marks are kept.
 * A file that matches the base again loses its mark, and so do all marks when the base changed.
 */
export async function readReview(env: DaemonEnv, worktree: Worktree): Promise<ReviewModel> {
  const [status, current] = await Promise.all([env.readStatus(worktree), readCompare(env, worktree)])
  const ready = current.status === 'ready'
  const facts = factsByPath(status.entries)

  const from = ready ? current.mergeBase! : status.unborn ? null : 'HEAD'
  const listed = from === null ? null : await env.changeList(worktree, from)
  const listedByPath = new Map((listed?.changes ?? []).map((change) => [change.path, change]))
  const changes = ready ? (listed?.changes ?? []) : [...facts.values()].map((known) => listedByPath.get(known.entry.path) ?? statusChange(known))
  const listedPaths = new Set(changes.map((change) => change.path))
  const conflictsOnly = [...facts.values()].filter(({ conflict, entry }) => conflict && !listedPaths.has(entry.path)).map(statusChange)
  const kept = [...conflictsOnly.slice(0, STATUS_ENTRY_LIMIT), ...changes.slice(0, Math.max(STATUS_ENTRY_LIMIT - conflictsOnly.length, 0))]
  const capped = (listed?.capped ?? false) || status.capped || changes.length + conflictsOnly.length > kept.length

  let deletedMarks = 0
  let marks = env.reviewMarks.list(worktree.id)
  if (current.base !== null && marks.some((mark) => mark.baseKey !== current.base)) {
    deletedMarks += env.reviewMarks.clear(worktree.id)
    marks = []
  }

  const noteCounts = new Map<string, number>()
  for (const note of env.notes.list(worktree.id)) noteCounts.set(note.path, (noteCounts.get(note.path) ?? 0) + 1)

  const files: ReviewFile[] = kept.map((change) => {
    const known = facts.get(change.path)
    const entry = known?.entry
    return {
      path: change.path,
      ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
      status: LETTERS[change.status],
      added: change.added,
      removed: change.removed,
      binary: change.binary,
      uncommitted: known !== undefined,
      staged: known?.staged ?? false,
      ...(known?.conflict ? { conflict: known.conflict } : {}),
      mark: 'none' as ReviewMarkState,
      notes: noteCounts.get(change.path) ?? 0,
      ...(entry?.submodule ? { submodule: entry.submodule } : {})
    }
  })
  files.sort((a, b) => byteOrder(a.path, b.path))

  const byPath = new Map(files.map((file) => [file.path, file]))
  if (ready && !capped) {
    const stale = marks.filter((mark) => !byPath.has(mark.path)).map((mark) => mark.path)
    if (stale.length > 0) deletedMarks += env.reviewMarks.removeAll(worktree.id, stale)
  }
  if (deletedMarks > 0) {
    env.reviewChanged(worktree)
    env.changed(worktree)
  }
  const states = await inBatches(
    marks.filter((mark) => {
      const file = byPath.get(mark.path)
      return file !== undefined && file.conflict === undefined
    }),
    async (mark) => ({ mark, state: await markState(worktree.path, mark) })
  )
  for (const { mark, state } of states) byPath.get(mark.path)!.mark = state

  return {
    worktreeId: worktree.id,
    branch: status.branch,
    base: {
      name: current.base ?? '',
      source: current.baseSource ?? 'detected',
      isCurrentBranch: current.base !== null && current.base === status.branch
    },
    compare: {
      status: current.status,
      mergeBase: current.mergeBase,
      headOid: current.headOid,
      ...(current.message ? { message: current.message } : {})
    },
    totals: {
      added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
    },
    counts: {
      files: files.length,
      reviewed: files.filter((file) => file.mark === 'reviewed').length,
      changed: files.filter((file) => file.mark === 'changed').length,
      uncommitted: files.filter((file) => file.uncommitted).length,
      staged: files.filter((file) => file.staged).length
    },
    capped,
    files
  }
}

/** The review model of a worktree; see `readReview`. */
export function review(env: DaemonEnv): Handler {
  return async (params, caller) => readReview(env, await env.resolve(params, caller))
}

/**
 * Marks `path` reviewed, storing its bytes on disk now, or clears the mark (idempotent). With
 * `expected`, the hash the user was looking at (null for a deleted file), a file that changed
 * since is refused with `changed-on-disk` and nothing is stored.
 */
export function setReviewMark(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const { rel, absolute } = await containedPath(worktree.path, params.path)
    if (typeof params.reviewed !== 'boolean') throw env.context.error('invalid-params', 'reviewed must be a boolean.')
    const mark: ReviewMarkState = await serialised(absolute, async () => {
      if (!params.reviewed) {
        env.reviewMarks.remove(worktree.id, rel)
        return 'none'
      }
      const disk = await readDisk(absolute)
      if (params.expected !== undefined && params.expected !== disk.hash) throw new ChangedOnDiskError()
      const base = await compareBase(env, worktree, undefined)
      env.reviewMarks.put({
        worktreeId: worktree.id,
        path: rel,
        baseKey: base?.base ?? '',
        hash: disk.hash ?? DELETED_HASH,
        content: disk.content,
        markedAt: Date.now()
      })
      return 'reviewed'
    })
    env.reviewChanged(worktree)
    env.changed(worktree)
    return { mark }
  }
}

/**
 * The content `path` had when it was marked reviewed. A deleted file has no content and the hash
 * `deleted`; a file whose bytes were not kept (binary or too large) reports `binary`. Fails
 * `not-found` when the file has no mark.
 */
export function reviewedContent(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const { rel } = await containedPath(worktree.path, params.path)
    const mark = env.reviewMarks.get(worktree.id, rel)
    if (!mark) throw env.errors.reasoned('not-found', 'no-mark', `${rel} has no review mark.`)
    return {
      content: mark.content === null ? null : new TextDecoder().decode(mark.content),
      hash: mark.hash,
      binary: mark.content === null && mark.hash !== DELETED_HASH,
      tooLarge: false
    }
  }
}

function lineCount(text: string): number {
  if (text.length === 0) return 0
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return text.endsWith('\n') ? count : count + 1
}

/**
 * The review diff of `path`: from the merge base to the disk (`base`, HEAD when the compare
 * cannot run), or from the reviewed content to the disk (`reviewed`, `not-found` without a mark).
 * Labelled `review`, with the disk hash so the card can pass `expected` back.
 */
export async function reviewDiff(
  env: DaemonEnv,
  worktree: Worktree,
  request: { path: string; oldPath?: string; against: 'base' | 'reviewed' }
): Promise<GitDiff> {
  const git = gitApi()
  const { path, oldPath } = request
  const withOld = oldPath === undefined ? {} : { oldPath }
  if (request.against === 'base') {
    const current = await readCompare(env, worktree)
    const from = current.status === 'ready' ? current.mergeBase! : (await git.resolveCommit(worktree.path, 'HEAD')) === null ? '' : 'HEAD'
    return { ...(await git.diffSource(worktree.path, { path, source: 'worktree', from, ...withOld })), source: 'review' }
  }

  const mark = env.reviewMarks.get(worktree.id, path)
  if (!mark) throw env.errors.reasoned('not-found', 'no-mark', `${path} has no review mark.`)
  const now: GitDiff = { ...(await git.diffSource(worktree.path, { path, source: 'worktree', from: '' })), source: 'review' }
  if (mark.hash === DELETED_HASH) return now
  if (mark.content === null || now.kind !== 'text') {
    const notice: GitDiff = { ...now, kind: 'binary', binary: true, original: '', modified: '' }
    delete notice.mime
    delete notice.tooLarge
    return notice
  }
  if (now.tooLarge) return now
  const original = new TextDecoder().decode(mark.content)
  const characters = original.length + now.modified.length
  const originalLines = lineCount(original)
  const modifiedLines = lineCount(now.modified)
  const reason = characters > MAX_RENDER_CHARACTERS ? 'characters' : originalLines > MAX_RENDER_LINES_PER_SIDE || modifiedLines > MAX_RENDER_LINES_PER_SIDE ? 'lines' : null
  if (reason) return { ...now, original: '', modified: '', tooLarge: { originalLines, modifiedLines, characters, reason } }
  return { ...now, original }
}

/**
 * Keeps a file reviewed across a write Quirky made itself: the mark of `rel` moves to `bytes`
 * when it still holds `fromHash` (null meaning the file was missing). A store failure is logged
 * and never fails the write that already landed.
 */
export function moveMarkToWrite(env: DaemonEnv, worktree: Worktree, rel: string, fromHash: string | null, bytes: Uint8Array, hash: string): void {
  try {
    const moved = env.reviewMarks.move(worktree.id, rel, fromHash ?? DELETED_HASH, { hash, content: storable(bytes) }, Date.now())
    if (moved) env.reviewChanged(worktree)
  } catch (error) {
    env.context.log(`could not move a review mark after a save: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Handles `quirky.editor/saved`: when the editor saved over the very bytes a file was marked
 * reviewed with, the mark moves to what it wrote. Never throws; a path outside every worktree,
 * a failed resolve and a file that changed again meanwhile leave the mark alone.
 */
export async function keepReviewAfterEditorSave(env: DaemonEnv, data: unknown): Promise<void> {
  try {
    const { path, beforeHash, afterHash } = (data ?? {}) as { path?: unknown; beforeHash?: unknown; afterHash?: unknown }
    if (typeof path !== 'string' || !isAbsolute(path) || typeof afterHash !== 'string') return
    if (beforeHash !== null && typeof beforeHash !== 'string') return
    const worktree = (await env.context.call('quirky.worktree/resolve', { selector: 'current', cwd: dirname(path) })) as Worktree
    if (worktree.kind === 'folder') return
    const rel = relative(await realpath(worktree.path), path)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
    const contained = await containedPath(worktree.path, rel)
    await serialised(contained.absolute, async () => {
      const mark = env.reviewMarks.get(worktree.id, contained.rel)
      if (!mark || mark.hash !== (beforeHash ?? DELETED_HASH)) return
      const disk = await readDisk(contained.absolute)
      if (disk.hash !== afterHash) return
      env.reviewMarks.move(worktree.id, contained.rel, mark.hash, { hash: afterHash, content: disk.content }, Date.now())
      env.reviewChanged(worktree)
      env.changed(worktree)
    })
  } catch (error) {
    env.context.log(`could not keep a review mark across an editor save: ${error instanceof Error ? error.message : String(error)}`)
  }
}
