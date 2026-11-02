/** Branch compare: the committed changes between a merge base and HEAD, and the file lists they are built from. */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitChange, GitChangeStatus, GitCompare } from '@quirky/protocol'
import { MAX_BLOB_BYTES } from './diffs'
import { GitError } from './index'
import { git, runGit } from './run'
import { STATUS_ENTRY_LIMIT } from './status'

const decoder = new TextDecoder()

const STATUS: Record<string, GitChangeStatus> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'modified',
  R: 'renamed',
  C: 'copied'
}

/**
 * Parses `--raw --numstat -z` output: every raw record first, then every numstat record. A raw
 * record is `:modes shas STATUS\0path\0` (two paths for R and C); a numstat record is
 * `added\tremoved\tpath\0`, or `added\tremoved\t\0old\0new\0` for a rename or copy.
 */
function parseChangeList(out: string): GitChange[] {
  const tokens = out.split('\0')
  if (tokens[tokens.length - 1] === '') tokens.pop()
  const changes: GitChange[] = []
  const byPath = new Map<string, GitChange>()
  let i = 0
  while (i < tokens.length && tokens[i]!.startsWith(':')) {
    const letter = tokens[i]!.split(' ').pop()![0]!
    i++
    const first = tokens[i++]!
    const second = letter === 'R' || letter === 'C' ? tokens[i++]! : undefined
    const change: GitChange = {
      path: second ?? first,
      status: STATUS[letter] ?? 'modified',
      added: 0,
      removed: 0,
      binary: false
    }
    if (second !== undefined) change.oldPath = first
    changes.push(change)
    byPath.set(change.path, change)
  }
  while (i < tokens.length) {
    const [added, removed, inlinePath] = splitNumstat(tokens[i++]!)
    let path = inlinePath
    if (path === '') {
      i++
      path = tokens[i++]!
    }
    const change = byPath.get(path)
    if (!change) continue
    if (added === '-' || removed === '-') {
      change.binary = true
      change.added = null
      change.removed = null
    } else {
      change.added = Number(added)
      change.removed = Number(removed)
    }
  }
  return changes
}

function splitNumstat(token: string): [string, string, string] {
  const first = token.indexOf('\t')
  const second = token.indexOf('\t', first + 1)
  return [token.slice(0, first), token.slice(first + 1, second), token.slice(second + 1)]
}

/**
 * The files changed from `from` to `to` with line counts, renames and copies detected. A null
 * `from` lists a root commit's files as additions. Throws `GitError` when git fails.
 */
export async function changeList(cwd: string, from: string | null, to: string): Promise<GitChange[]> {
  const args =
    from === null
      ? ['diff-tree', '--root', '--no-commit-id', '-r', '--raw', '--numstat', '-z', '-M', '-C', to, '--']
      : ['diff', '--raw', '--numstat', '-z', '-M', '-C', from, to, '--']
  return parseChangeList(await git(cwd, args, { readOnly: true }))
}

const BINARY_SNIFF_BYTES = 8000
const UNTRACKED_COUNT_CONCURRENCY = 8
const NEWLINE = 10
const pathOrder = new Intl.Collator('en', { numeric: true })

/** An untracked file as a change: line count as additions, null counts when binary or over the blob cap. */
async function untrackedChange(cwd: string, path: string): Promise<GitChange> {
  const change: GitChange = { path, status: 'untracked', added: null, removed: null, binary: false }
  try {
    const full = join(cwd, path)
    const info = await lstat(full)
    if (info.isSymbolicLink()) return { ...change, added: 1, removed: 0 }
    if (!info.isFile() || info.size > MAX_BLOB_BYTES) return change
    const bytes = await readFile(full)
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ...change, binary: true }
    let count = 0
    for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) count++
    if (bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE) count++
    return { ...change, added: count, removed: 0 }
  } catch {
    return change
  }
}

/**
 * Every path whose working-tree content differs from commit `from`: committed, staged, unstaged
 * and untracked changes folded into one list with each path once, counted base to disk. The index
 * is never the comparison side. Sorted by path in natural order. `options` mean what they do for
 * `statusV2`: the list is cut at `limit` (default `STATUS_ENTRY_LIMIT`) with `capped` set only
 * when more were found, and untracked paths in `sharedSymlinks` that are symlinks are left out.
 * Throws `GitError` when git fails.
 */
export async function worktreeChangeList(
  cwd: string,
  from: string,
  options: { limit?: number; sharedSymlinks?: string[] } = {}
): Promise<{ changes: GitChange[]; capped: boolean }> {
  const limit = options.limit ?? STATUS_ENTRY_LIMIT
  const shared = new Set(options.sharedSymlinks ?? [])
  const [tracked, untrackedOut] = await Promise.all([
    git(cwd, ['diff', '--raw', '--numstat', '-z', '--find-renames', '--end-of-options', from, '--'], { readOnly: true }),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { readOnly: true })
  ])
  const untrackedPaths: string[] = []
  for (const path of untrackedOut.split('\0')) {
    if (path === '') continue
    if (shared.has(path) && (await lstat(join(cwd, path)).then((info) => info.isSymbolicLink(), () => false))) continue
    untrackedPaths.push(path)
  }

  const entries: ({ change: GitChange } | { untracked: string })[] = [
    ...parseChangeList(tracked).map((change) => ({ change })),
    ...untrackedPaths.map((untracked) => ({ untracked }))
  ]
  const pathOf = (entry: (typeof entries)[number]) => ('change' in entry ? entry.change.path : entry.untracked)
  entries.sort((a, b) => pathOrder.compare(pathOf(a), pathOf(b)))
  const capped = entries.length > limit
  if (capped) entries.length = limit

  const changes: GitChange[] = []
  for (let i = 0; i < entries.length; i += UNTRACKED_COUNT_CONCURRENCY) {
    changes.push(
      ...(await Promise.all(
        entries.slice(i, i + UNTRACKED_COUNT_CONCURRENCY).map((entry) => ('change' in entry ? entry.change : untrackedChange(cwd, entry.untracked)))
      ))
    )
  }
  return { changes, capped }
}

async function resolveCommitOid(cwd: string, rev: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { readOnly: true })
  if (r.exitCode !== 0) return null
  return decoder.decode(r.stdout).trim() || null
}

/**
 * What the current branch committed since its merge base with `base`. The not-ready outcomes
 * (`invalid-base`, `unborn-head`, `no-merge-base`) are results with a `message`, not errors.
 * `baseSource` is left null for the caller, which knows where `base` came from.
 */
export async function compare(cwd: string, base: string): Promise<GitCompare> {
  const [baseOid, headOid] = await Promise.all([resolveCommitOid(cwd, base), resolveCommitOid(cwd, 'HEAD')])
  const result: GitCompare = {
    status: 'ready',
    base,
    baseSource: null,
    message: null,
    baseOid,
    headOid,
    mergeBase: null,
    ahead: 0,
    behind: 0,
    entries: [],
    added: 0,
    removed: 0
  }
  if (!baseOid) {
    return { ...result, status: 'invalid-base', message: `Base ref ${base} could not be resolved in this repository.` }
  }
  if (!headOid) {
    return {
      ...result,
      status: 'unborn-head',
      message: 'This branch does not have a committed HEAD yet, so compare-to-base is unavailable.'
    }
  }
  const mergeBase = await runGit(cwd, ['merge-base', baseOid, headOid], { readOnly: true })
  const mergeBaseOid = decoder.decode(mergeBase.stdout).trim()
  if (mergeBase.exitCode !== 0 || !mergeBaseOid) {
    return {
      ...result,
      status: 'no-merge-base',
      message: `This branch and ${base} do not share a merge base, so compare-to-base is unavailable.`
    }
  }
  const [counts, entries] = await Promise.all([
    git(cwd, ['rev-list', '--left-right', '--count', `${baseOid}...${headOid}`], { readOnly: true }),
    changeList(cwd, mergeBaseOid, headOid)
  ])
  const [behind, ahead] = counts.trim().split(/\s+/).map(Number)
  if (behind === undefined || ahead === undefined || Number.isNaN(behind) || Number.isNaN(ahead)) {
    throw new GitError(`unexpected rev-list output: ${counts.trim()}`, '', -1)
  }
  return {
    ...result,
    mergeBase: mergeBaseOid,
    ahead,
    behind,
    entries,
    added: entries.reduce((sum, e) => sum + (e.added ?? 0), 0),
    removed: entries.reduce((sum, e) => sum + (e.removed ?? 0), 0)
  }
}
