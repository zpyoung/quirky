/** Branch compare: the committed changes between a merge base and HEAD, and the file lists they are built from. */
import { lstat, readFile, readlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { GitChange, GitChangeStatus, GitCompare } from '@quirky/protocol'
import { MAX_BLOB_BYTES } from './diffs'
import { GitError } from './index'
import {
  drainText,
  git,
  gitEnv,
  readChunk,
  retryStalled,
  runGit,
  shareGitRead,
  withGitReadSlot
} from './run'
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
 * Streams git's NUL-separated stdout one token at a time and kills git once `onToken` returns
 * true, so a huge listing is never held in memory. Throws `GitError` when git fails on its own,
 * and a stalled pipe (see `retryStalled`) when git's output does not end after it exited.
 */
async function streamTokens(
  cwd: string,
  args: string[],
  onToken: (token: string) => boolean | Promise<boolean>
): Promise<void> {
  const env = await gitEnv(cwd, { readOnly: true })
  return withGitReadSlot(async () => {
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(['git', ...args], {
        cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      })
    } catch (err) {
      throw new GitError(`failed to run git: ${(err as Error).message}`, '', -1)
    }
    let stopped = false
    let exited = false
    try {
      const stderr = drainText(proc)
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      const stream = new TextDecoder()
      let carry = ''
      read: for (;;) {
        const { done, value } = await readChunk(reader, proc.exited)
        if (done) break
        carry += stream.decode(value, { stream: true })
        const tokens = carry.split('\0')
        carry = tokens.pop() ?? ''
        for (const token of tokens) {
          if (await onToken(token)) {
            stopped = true
            break read
          }
        }
      }
      if (!stopped && carry.length > 0) await onToken(carry)
      if (stopped) proc.kill()
      const exitCode = await proc.exited
      exited = true
      const errText = await stderr
      if (!stopped && exitCode !== 0) {
        throw new GitError(`git ${args[0]} failed (exit ${exitCode})${errText.trim() ? `: ${errText.trim()}` : ''}`, errText, exitCode)
      }
    } finally {
      if (!exited) {
        try {
          proc.kill()
        } finally {
          await proc.exited
        }
      }
    }
  })
}

/** The tokens of the first `bound` records of `diff --raw -z` (`numstat` false) or `diff --numstat -z` (true) against `from`. */
async function trackedTokens(cwd: string, from: string, numstat: boolean, bound: number): Promise<string[]> {
  return retryStalled(async () => {
    const tokens: string[] = []
    let records = 0
    let pending = 0
    await streamTokens(
      cwd,
      ['diff', numstat ? '--numstat' : '--raw', '-z', '--find-renames', '--end-of-options', from, '--'],
      (token) => {
        tokens.push(token)
        if (pending > 0) pending--
        else {
          records++
          if (numstat) pending = splitNumstat(token)[2] === '' ? 2 : 0
          else {
            const letter = token.split(' ').pop()![0]
            pending = letter === 'R' || letter === 'C' ? 2 : 1
          }
        }
        return pending === 0 && records >= bound
      }
    )
    return tokens
  })
}

/** The first `bound` untracked paths git lists, skipping shared symlinks. */
async function untrackedPrefix(cwd: string, bound: number, isSharedSymlink: (path: string) => Promise<boolean>): Promise<string[]> {
  return retryStalled(async () => {
    const paths: string[] = []
    await streamTokens(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], async (path) => {
      if (path === '' || (await isSharedSymlink(path))) return false
      paths.push(path)
      return paths.length >= bound
    })
    return paths
  })
}

/**
 * A file that is deleted in the index but still on disk, as one change from the blob at `from` to
 * the disk bytes: null when they are identical, null counts when either side is over the blob cap
 * or the disk entry is not a regular file. A symlink is identical when the base is a symlink with
 * the same target, since git stores the target as the blob.
 */
async function recreatedChange(cwd: string, from: string, path: string): Promise<GitChange | null> {
  const change: GitChange = { path, status: 'modified', added: null, removed: null, binary: false }
  const ref = `${from}:${path}`
  const full = join(cwd, path)
  const [info, baseSize] = await Promise.all([lstat(full), git(cwd, ['cat-file', '-s', '--end-of-options', ref], { readOnly: true })])
  if (info.isSymbolicLink()) {
    const [tree, target] = await Promise.all([
      git(cwd, ['ls-tree', '-z', '--end-of-options', from, '--', path], { readOnly: true }),
      readlink(full, 'buffer')
    ])
    if (!tree.startsWith('120000 ') || Number(baseSize) > MAX_BLOB_BYTES) return change
    const baseBlob = await runGit(cwd, ['cat-file', 'blob', '--end-of-options', ref], { readOnly: true })
    if (baseBlob.exitCode !== 0) throw new GitError(`git cat-file failed (exit ${baseBlob.exitCode}): ${baseBlob.stderr.trim()}`, baseBlob.stderr, baseBlob.exitCode)
    return Buffer.from(baseBlob.stdout).equals(target) ? null : change
  }
  if (!info.isFile() || info.size > MAX_BLOB_BYTES || Number(baseSize) > MAX_BLOB_BYTES) return change
  const [baseBlob, disk] = await Promise.all([runGit(cwd, ['cat-file', 'blob', '--end-of-options', ref], { readOnly: true }), readFile(full)])
  if (baseBlob.exitCode !== 0) throw new GitError(`git cat-file failed (exit ${baseBlob.exitCode}): ${baseBlob.stderr.trim()}`, baseBlob.stderr, baseBlob.exitCode)
  if (Buffer.from(baseBlob.stdout).equals(disk)) return null
  if (baseBlob.stdout.subarray(0, BINARY_SNIFF_BYTES).includes(0) || disk.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { ...change, binary: true }
  }
  const counted = await runGit(cwd, ['diff', '--no-index', '--numstat', '-z', '--', '-', full], { readOnly: true, input: baseBlob.stdout })
  if (counted.exitCode > 1) throw new GitError(`git diff failed (exit ${counted.exitCode}): ${counted.stderr.trim()}`, counted.stderr, counted.exitCode)
  const [added, removed] = decoder.decode(counted.stdout).split('\t')
  return { ...change, added: Number(added), removed: Number(removed) }
}

/**
 * Every path whose working-tree content differs from commit `from`: committed, staged, unstaged
 * and untracked changes folded into one list with each path once, counted base to disk. The index
 * is never the comparison side: a file the index dropped but the disk still has is one change
 * from its base blob to the disk bytes, or none when they match. Sorted by path in natural order.
 * `options` mean what they do for `statusV2`: git's listings are read only until more than
 * `limit` entries (default `STATUS_ENTRY_LIMIT`) are known, so the list holds the first `limit`
 * paths git reports (then sorted) and `capped` is set only when more exist; untracked paths in
 * `sharedSymlinks` that are symlinks are left out. Throws `GitError` when git fails.
 */
export function worktreeChangeList(
  cwd: string,
  from: string,
  options: { limit?: number; sharedSymlinks?: string[] } = {}
): Promise<{ changes: GitChange[]; capped: boolean }> {
  const limit = options.limit ?? STATUS_ENTRY_LIMIT
  const sharedSymlinks = [...new Set(options.sharedSymlinks ?? [])].sort()
  const key = JSON.stringify([
    'worktreeChangeList',
    resolve(cwd),
    from,
    limit,
    sharedSymlinks,
    process.env.PATH ?? ''
  ])
  return shareGitRead(
    key,
    () => worktreeChangeListOnce(cwd, from, { limit, sharedSymlinks }),
    (value) => structuredClone(value)
  )
}

async function worktreeChangeListOnce(
  cwd: string,
  from: string,
  options: { limit?: number; sharedSymlinks?: string[] }
): Promise<{ changes: GitChange[]; capped: boolean }> {
  const limit = options.limit ?? STATUS_ENTRY_LIMIT
  const shared = new Set(options.sharedSymlinks ?? [])
  const isSharedSymlink = async (path: string): Promise<boolean> =>
    shared.has(path) && (await lstat(join(cwd, path)).then((info) => info.isSymbolicLink(), () => false))

  type Entry = { change: GitChange } | { untracked: string }
  let entries: Entry[] = []
  let capped = false
  // omitted recreated files shrink the list below what the bound promised, so read further
  for (let slack = 0; ; ) {
    const bound = limit + 1 + slack
    const [rawTokens, numstatTokens, untrackedPaths] = await Promise.all([
      trackedTokens(cwd, from, false, bound),
      trackedTokens(cwd, from, true, bound),
      untrackedPrefix(cwd, bound, isSharedSymlink)
    ])
    const tracked = parseChangeList([...rawTokens, ...numstatTokens].join('\0'))

    const recreated = new Set<string>()
    let omitted = 0
    const resolved: GitChange[] = []
    for (let i = 0; i < tracked.length; i += UNTRACKED_COUNT_CONCURRENCY) {
      resolved.push(
        ...(
          await Promise.all(
            tracked.slice(i, i + UNTRACKED_COUNT_CONCURRENCY).map(async (change): Promise<GitChange | null> => {
              if (change.status !== 'deleted') return change
              const onDisk = await lstat(join(cwd, change.path)).then((info) => !info.isDirectory(), () => false)
              if (!onDisk || (await isSharedSymlink(change.path))) return change
              recreated.add(change.path)
              return recreatedChange(cwd, from, change.path)
            })
          )
        ).filter((change): change is GitChange => change !== null)
      )
      omitted = tracked.length - resolved.length
    }

    // a rename's old path restored on disk is untracked to git, but it is a base file, not an addition
    const renamedFrom = new Set(tracked.flatMap((change) => (change.oldPath !== undefined ? [change.oldPath] : [])))
    const restored = new Map<string, GitChange | null>()
    const restoredPaths = untrackedPaths.filter((path) => renamedFrom.has(path) && !recreated.has(path))
    for (let i = 0; i < restoredPaths.length; i += UNTRACKED_COUNT_CONCURRENCY) {
      await Promise.all(
        restoredPaths.slice(i, i + UNTRACKED_COUNT_CONCURRENCY).map(async (path) => {
          restored.set(path, await recreatedChange(cwd, from, path))
        })
      )
    }
    for (const change of restored.values()) if (change === null) omitted++

    entries = [
      ...resolved.map((change) => ({ change })),
      ...untrackedPaths
        .filter((path) => !recreated.has(path))
        .flatMap((untracked): Entry[] => {
          if (!restored.has(untracked)) return [{ untracked }]
          const change = restored.get(untracked)
          return change ? [{ change }] : []
        })
    ]
    const hitBound = tracked.length >= bound || untrackedPaths.length >= bound
    if (entries.length > limit || !hitBound || omitted === 0) {
      capped = entries.length > limit
      break
    }
    slack += omitted
  }

  const pathOf = (entry: Entry) => ('change' in entry ? entry.change.path : entry.untracked)
  entries.sort((a, b) => pathOrder.compare(pathOf(a), pathOf(b)))
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
export function compare(cwd: string, base: string): Promise<GitCompare> {
  const key = JSON.stringify(['compare', resolve(cwd), base, process.env.PATH ?? ''])
  return shareGitRead(key, () => compareOnce(cwd, base), (value) => structuredClone(value))
}

async function compareOnce(cwd: string, base: string): Promise<GitCompare> {
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
