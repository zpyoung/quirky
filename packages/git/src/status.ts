import { lstat, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  GitArea,
  GitChangeStatus,
  GitConflictKind,
  GitFileStatus,
  GitOperation,
  GitStatus,
  GitStatusEntry
} from '@quirky/protocol'
import { GitError } from './index'
import { gitEnv, runGit } from './run'
import { effectiveUpstream } from './upstream'

/** The most entries a status returns before it stops reading and reports `capped`. */
export const STATUS_ENTRY_LIMIT = 1000

const MAX_UNTRACKED_COUNT_BYTES = 2 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8 * 1024
const UNTRACKED_COUNT_CONCURRENCY = 8
const NEWLINE = 10

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const pathOrder = new Intl.Collator('en', { numeric: true })

const CHANGE_STATUS: Record<string, GitChangeStatus> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied'
}

const CONFLICT: Record<string, { kind: GitConflictKind; status: GitChangeStatus }> = {
  UU: { kind: 'both_modified', status: 'modified' },
  AA: { kind: 'both_added', status: 'added' },
  DD: { kind: 'both_deleted', status: 'deleted' },
  AU: { kind: 'added_by_us', status: 'added' },
  UA: { kind: 'added_by_them', status: 'added' },
  DU: { kind: 'deleted_by_us', status: 'deleted' },
  UD: { kind: 'deleted_by_them', status: 'deleted' }
}

type Snapshot = {
  entries: GitStatusEntry[]
  files: GitFileStatus[]
  capped: boolean
  oid: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/** `S<c><m><u>` of a porcelain v2 record, or undefined when the path is not a submodule. */
function submoduleFlags(field: string): GitStatusEntry['submodule'] {
  if (field[0] !== 'S') return undefined
  return { commitChanged: field[1] === 'C', trackedChanges: field[2] === 'M', untrackedChanges: field[3] === 'U' }
}

function changeEntry(
  path: string,
  oldPath: string | undefined,
  area: GitArea,
  letter: string,
  submodule: GitStatusEntry['submodule']
): GitStatusEntry {
  const status = CHANGE_STATUS[letter] ?? 'modified'
  const entry: GitStatusEntry = { path, area, status }
  if (oldPath !== undefined && (status === 'renamed' || status === 'copied')) entry.oldPath = oldPath
  if (submodule) entry.submodule = submodule
  return entry
}

/** Folds porcelain v2 records into a snapshot, one record at a time. */
class PorcelainReader {
  readonly snapshot: Snapshot = {
    entries: [],
    files: [],
    capped: false,
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0
  }
  private pendingRename: { fields: string[] } | null = null

  constructor(
    private readonly limit: number,
    private readonly dropUntracked: (path: string) => Promise<boolean>
  ) {}

  /** Consumes one NUL-separated record; true when the limit was passed and reading should stop. */
  async record(record: string): Promise<boolean> {
    if (this.pendingRename) {
      const { fields } = this.pendingRename
      this.pendingRename = null
      return this.change(fields, record)
    }
    if (record.length === 0) return false
    switch (record[0]) {
      case '#':
        this.header(record)
        return false
      case '1':
        return this.change(record.split(' ', 8).concat(record.split(' ').slice(8).join(' ')), undefined)
      case '2': {
        // old path follows as the next record
        this.pendingRename = { fields: record.split(' ', 9).concat(record.split(' ').slice(9).join(' ')) }
        return false
      }
      case 'u':
        return this.conflict(record.split(' ', 10).concat(record.split(' ').slice(10).join(' ')))
      case '?':
        return this.untracked(record.slice(2))
      default:
        return false
    }
  }

  private header(record: string): void {
    const s = this.snapshot
    const [key, ...rest] = record.slice(2).split(' ')
    const value = rest.join(' ')
    if (key === 'branch.oid') s.oid = value === '(initial)' ? null : value
    else if (key === 'branch.head') s.head = value
    else if (key === 'branch.upstream') s.upstream = value
    else if (key === 'branch.ab') {
      const m = /^\+(\d+) -(\d+)$/.exec(value)
      if (m) {
        s.ahead = Number(m[1])
        s.behind = Number(m[2])
      }
    }
  }

  private push(entries: GitStatusEntry[]): boolean {
    const s = this.snapshot
    s.entries.push(...entries)
    if (s.entries.length <= this.limit) return false
    s.entries.length = this.limit
    s.capped = true
    return true
  }

  private change(fields: string[], oldPath: string | undefined): Promise<boolean> | boolean {
    const xy = fields[1] ?? '..'
    const path = fields[fields.length - 1] ?? ''
    const submodule = submoduleFlags(fields[2] ?? 'N...')
    const x = xy[0] ?? '.'
    const y = xy[1] ?? '.'
    const file: GitFileStatus = { path, index: x === '.' ? ' ' : x, worktree: y === '.' ? ' ' : y, untracked: false }
    if (oldPath !== undefined) file.origPath = oldPath
    this.snapshot.files.push(file)
    const entries: GitStatusEntry[] = []
    if (x !== '.') entries.push(changeEntry(path, oldPath, 'staged', x, submodule))
    if (y !== '.') entries.push(changeEntry(path, oldPath, 'unstaged', y, submodule))
    return this.push(entries)
  }

  private conflict(fields: string[]): boolean {
    const xy = fields[1] ?? ''
    const path = fields[fields.length - 1] ?? ''
    const kind = CONFLICT[xy]
    this.snapshot.files.push({ path, index: xy[0] ?? ' ', worktree: xy[1] ?? ' ', untracked: false })
    if (!kind || submoduleFlags(fields[2] ?? 'N...')) return false
    return this.push([
      { path, area: 'conflicts', status: kind.status, conflict: { kind: kind.kind, state: 'unresolved' } }
    ])
  }

  private async untracked(path: string): Promise<boolean> {
    if (await this.dropUntracked(path)) return false
    this.snapshot.files.push({ path, index: '?', worktree: '?', untracked: true })
    return this.push([{ path, area: 'untracked', status: 'untracked' }])
  }
}

/** Runs the porcelain v2 status, stopping git as soon as more than `limit` entries have been read. */
async function readPorcelain(
  cwd: string,
  limit: number,
  dropUntracked: (path: string) => Promise<boolean>
): Promise<Snapshot> {
  const args = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd,
      env: await gitEnv(cwd, { readOnly: true }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
  } catch (err) {
    throw new GitError(`failed to run git: ${(err as Error).message}`, '', -1)
  }
  const stderr = new Response(proc.stderr as ReadableStream).text()
  const reader = new PorcelainReader(limit, dropUntracked)
  const decoder = new TextDecoder()
  let carry = ''
  let stopped = false
  try {
    const stdout = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    read: for (;;) {
      const { done, value } = await stdout.read()
      if (done) break
      carry += decoder.decode(value, { stream: true })
      const records = carry.split('\0')
      carry = records.pop() ?? ''
      for (const record of records) {
        if (await reader.record(record)) {
          stopped = true
          break read
        }
      }
    }
    if (!stopped && carry.length > 0) await reader.record(carry)
  } finally {
    if (stopped) proc.kill()
  }
  const exitCode = await proc.exited
  const errText = await stderr
  if (!stopped && exitCode !== 0) {
    throw new GitError(`git status failed (exit ${exitCode})${errText.trim() ? `: ${errText.trim()}` : ''}`, errText, exitCode)
  }
  return reader.snapshot
}

type LineCount = { added: number; removed: number } | { binary: true }

/** Parses `diff -z --numstat -M` output into counts keyed by the new path. */
function parseNumstat(out: string): Map<string, LineCount> {
  const counts = new Map<string, LineCount>()
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i]!)
    if (!m) continue
    // a rename has an empty path here, then the old and new paths as two more records
    const path = m[3] === '' ? tokens[(i += 2)] : m[3]
    if (path === undefined) continue
    counts.set(path, m[1] === '-' ? { binary: true } : { added: Number(m[1]), removed: Number(m[2]) })
  }
  return counts
}

async function numstat(cwd: string, cached: boolean): Promise<Map<string, LineCount>> {
  const args = ['-c', 'core.quotePath=false', '-c', 'diff.autoRefreshIndex=false', 'diff', '-z', '--numstat', '-M']
  if (cached) args.push('--cached')
  const r = await runGit(cwd, args, { readOnly: true })
  return r.exitCode === 0 ? parseNumstat(text(r.stdout)) : new Map()
}

/** Lines in an untracked file, or null when it is not counted (binary, too large, not a regular file). */
async function countUntrackedLines(full: string): Promise<number | null> {
  try {
    const info = await lstat(full)
    if (info.isSymbolicLink()) return 1
    if (!info.isFile() || info.size > MAX_UNTRACKED_COUNT_BYTES) return null
    if (info.size === 0) return 0
    const bytes = await readFile(full)
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
    let lines = 0
    for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) lines++
    return bytes[bytes.length - 1] === NEWLINE ? lines : lines + 1
  } catch {
    return null
  }
}

async function addLineCounts(cwd: string, entries: GitStatusEntry[]): Promise<void> {
  const [staged, unstaged] = await Promise.all([numstat(cwd, true), numstat(cwd, false)])
  const untracked: GitStatusEntry[] = []
  for (const entry of entries) {
    if (entry.area === 'untracked') {
      untracked.push(entry)
      continue
    }
    const count = (entry.area === 'staged' ? staged : entry.area === 'unstaged' ? unstaged : undefined)?.get(entry.path)
    if (!count) continue
    if ('binary' in count) entry.binary = true
    else {
      entry.added = count.added
      entry.removed = count.removed
    }
  }
  for (let i = 0; i < untracked.length; i += UNTRACKED_COUNT_CONCURRENCY) {
    await Promise.all(
      untracked.slice(i, i + UNTRACKED_COUNT_CONCURRENCY).map(async (entry) => {
        const lines = await countUntrackedLines(join(cwd, entry.path))
        if (lines === null) return
        entry.added = lines
        entry.removed = 0
      })
    )
  }
}

/**
 * One consistent snapshot of the worktree at `cwd` (its root): porcelain v2 rows with area,
 * status, conflict kind, submodule flags and line counts; v1's `files` from the same records;
 * branch, upstream, operation and the effective upstream's state. Reading stops once more than
 * `limit` entries (default `STATUS_ENTRY_LIMIT`) are seen: `capped` is then true with exactly
 * `limit` entries, and line counts and the upstream probe are skipped. Untracked entries named in
 * `sharedSymlinks` that are symlinks on disk are left out. Entries are sorted with unresolved
 * conflicts first, then by path in natural order. `busy` is always null and no `resolved_locally`
 * conflicts are produced; the daemon adds both. Throws `GitError` when git fails.
 */
export async function statusV2(
  cwd: string,
  options: { limit?: number; sharedSymlinks?: string[] } = {}
): Promise<GitStatus> {
  const shared = new Set(options.sharedSymlinks ?? [])
  const dropUntracked = async (path: string): Promise<boolean> => {
    if (!shared.has(path)) return false
    try {
      return (await lstat(join(cwd, path))).isSymbolicLink()
    } catch {
      return false
    }
  }
  const snap = await readPorcelain(cwd, options.limit ?? STATUS_ENTRY_LIMIT, dropUntracked)

  const detached = snap.head === '(detached)'
  const branch = detached || snap.head === null ? null : snap.head
  const unborn = snap.oid === null && snap.head !== null
  const [operation, upstreamStatus] = await Promise.all([
    detectOperation(cwd),
    snap.capped
      ? Promise.resolve({
          hasUpstream: snap.upstream !== null,
          name: snap.upstream,
          sha: null,
          ahead: snap.ahead,
          behind: snap.behind,
          behindPatchEquivalent: null
        })
      : effectiveUpstream(cwd, branch, snap),
    snap.capped ? Promise.resolve() : addLineCounts(cwd, snap.entries)
  ])

  const conflicts = snap.entries.filter((e) => e.area === 'conflicts')
  const rest = snap.entries.filter((e) => e.area !== 'conflicts')
  const byPath = (a: GitStatusEntry, b: GitStatusEntry) => pathOrder.compare(a.path, b.path)
  return {
    branch,
    upstream: snap.upstream,
    ahead: snap.ahead,
    behind: snap.behind,
    files: snap.files,
    head: unborn ? null : snap.oid,
    detached,
    unborn,
    entries: [...conflicts.sort(byPath), ...rest.sort(byPath)],
    operation,
    capped: snap.capped,
    upstreamStatus,
    busy: null
  }
}

const gitDirs = new Map<string, Promise<string>>()

/**
 * The absolute git directory of the worktree at `cwd`: a linked worktree's own directory, not the
 * main checkout's. Cached per `cwd`; a failed lookup is not cached.
 */
export function gitDirOf(cwd: string): Promise<string> {
  let cached = gitDirs.get(cwd)
  if (!cached) {
    cached = runGit(cwd, ['rev-parse', '--absolute-git-dir'], { readOnly: true }).then((r) => {
      if (r.exitCode !== 0) throw new GitError(`git rev-parse failed (exit ${r.exitCode}): ${r.stderr.trim()}`, r.stderr, r.exitCode)
      return text(r.stdout).trim()
    })
    gitDirs.set(cwd, cached)
    cached.catch(() => gitDirs.delete(cwd))
  }
  return cached
}

async function exists(path: string, directory?: boolean): Promise<boolean> {
  try {
    const info = await stat(path)
    return directory ? info.isDirectory() : true
  } catch {
    return false
  }
}

async function readOid(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim() || null
  } catch {
    return null
  }
}

/**
 * The merge, rebase or cherry-pick in progress at `cwd`, from marker files in its own git
 * directory; a rebase wins over the merge or cherry-pick it is replaying. Starts no git process
 * beyond the cached `gitDirOf`.
 */
export async function detectOperation(cwd: string): Promise<GitOperation> {
  const dir = await gitDirOf(cwd)
  if ((await exists(join(dir, 'rebase-merge'), true)) || (await exists(join(dir, 'rebase-apply'), true))) return 'rebase'
  if (await exists(join(dir, 'MERGE_HEAD'))) return 'merge'
  if (await exists(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  return 'none'
}

/**
 * The commit that identifies the operation in progress (the merged or cherry-picked commit, or
 * the branch tip a rebase started from), null when there is none; lets a caller tell one
 * operation from the next.
 */
export async function operationHead(cwd: string): Promise<string | null> {
  const dir = await gitDirOf(cwd)
  switch (await detectOperation(cwd)) {
    case 'merge':
      return readOid(join(dir, 'MERGE_HEAD'))
    case 'cherry-pick':
      return readOid(join(dir, 'CHERRY_PICK_HEAD'))
    case 'rebase':
      return (await readOid(join(dir, 'rebase-merge', 'orig-head'))) ?? (await readOid(join(dir, 'rebase-apply', 'orig-head')))
    default:
      return null
  }
}
