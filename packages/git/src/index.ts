/**
 * Git operations for the daemon, done by spawning the `git` binary (no git library), the same
 * approach Orca uses. Every function throws `GitError` with git's stderr on a non-zero exit.
 */
import { existsSync, statSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GitDiff, GitFileStatus, GitStatus } from '@quirky/protocol'
import { git, runGit } from './run'

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number
  ) {
    super(message)
    this.name = 'GitError'
  }
}

/** The requested branch is already checked out in another worktree. */
export class BranchCheckedOutError extends GitError {
  constructor(
    readonly branch: string,
    readonly worktreePath: string | null,
    stderr = ''
  ) {
    super(
      `branch '${branch}' is already checked out${worktreePath ? ` at ${worktreePath}` : ' in another worktree'}`,
      stderr,
      128
    )
    this.name = 'BranchCheckedOutError'
  }
}

/** The path given to `resolveRepoRoot` is not an existing directory. */
export class NoSuchDirectoryError extends GitError {
  constructor(readonly path: string) {
    super(`no such directory: ${path}`, '', -1)
    this.name = 'NoSuchDirectoryError'
  }
}

export type GitWorktreeInfo = {
  path: string
  branch: string | null
  head: string
  isMain: boolean
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The repository toplevel containing `path`. Throws NoSuchDirectoryError when `path` is not a
 * directory and GitError when it isn't inside a repo.
 */
export async function resolveRepoRoot(path: string): Promise<string> {
  if (!isDirectory(path)) throw new NoSuchDirectoryError(path)
  return (await git(path, ['rev-parse', '--show-toplevel'])).trim()
}

/** Every worktree of the repo at `repoPath`, main worktree first (`git worktree list --porcelain`). */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  const result: GitWorktreeInfo[] = []
  let isFirst = true
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split('\n').filter((l) => l.length > 0)
    if (lines.length === 0) continue
    let path = ''
    let head = ''
    let branch: string | null = null
    let skip = false
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'bare' || line.startsWith('prunable')) skip = true
    }
    const isMain = isFirst
    isFirst = false
    if (skip || !path || !existsSync(path)) continue
    result.push({ path, branch, head, isMain })
  }
  return result
}

/**
 * Adds a worktree at `path` for `branch`, creating parent dirs. A new branch is cut from `baseRef`
 * (default HEAD). When a local branch of that name already exists it is checked out as is and
 * `baseRef` is ignored; if another worktree has it checked out this throws BranchCheckedOutError.
 */
export async function addWorktree(
  repoPath: string,
  path: string,
  branch: string,
  baseRef?: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const exists = (await runGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0
  if (!exists) {
    await git(repoPath, ['worktree', 'add', '-b', branch, path, baseRef ?? 'HEAD'])
    return
  }
  const holder = (await listWorktrees(repoPath)).find((w) => w.branch === branch)
  if (holder) throw new BranchCheckedOutError(branch, holder.path)
  try {
    await git(repoPath, ['worktree', 'add', path, branch])
  } catch (error) {
    const stderr = error instanceof GitError ? error.stderr : ''
    if (/already (checked out|used by worktree)/.test(stderr)) {
      throw new BranchCheckedOutError(branch, /at '([^']+)'/.exec(stderr)?.[1] ?? null, stderr)
    }
    throw error
  }
}

export async function removeWorktree(repoPath: string, path: string, force: boolean): Promise<void> {
  await git(repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
}

export async function status(cwd: string): Promise<GitStatus> {
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
  const entries = out.split('\0')
  const result: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }

  let i = 0
  const header = entries[0]
  if (header?.startsWith('## ')) {
    parseBranchHeader(header.slice(3), result)
    i = 1
  }

  for (; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    const index = entry[0]!
    const worktree = entry[1]!
    const file: GitFileStatus = {
      path: entry.slice(3),
      index,
      worktree,
      untracked: index === '?' && worktree === '?'
    }
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      file.origPath = entries[++i]
    }
    result.files.push(file)
  }
  return result
}

function parseBranchHeader(header: string, out: GitStatus): void {
  if (header.startsWith('No commits yet on ')) {
    out.branch = header.slice('No commits yet on '.length)
    return
  }
  if (header.startsWith('Initial commit on ')) {
    out.branch = header.slice('Initial commit on '.length)
    return
  }
  if (header.startsWith('HEAD (no branch)')) return

  let rest = header
  const counts = /^(.*) \[(.*)\]$/.exec(header)
  if (counts) {
    rest = counts[1]!
    const ahead = /ahead (\d+)/.exec(counts[2]!)
    const behind = /behind (\d+)/.exec(counts[2]!)
    out.ahead = ahead ? Number(ahead[1]) : 0
    out.behind = behind ? Number(behind[1]) : 0
  }
  const sep = rest.indexOf('...')
  if (sep === -1) {
    out.branch = rest
  } else {
    out.branch = rest.slice(0, sep)
    out.upstream = rest.slice(sep + 3)
  }
}

type Side = { text: string; binary: boolean }

function decodeSide(bytes: Uint8Array): Side {
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return { text: '', binary: true }
  return { text: new TextDecoder().decode(bytes), binary: false }
}

async function readBlob(cwd: string, spec: string): Promise<Side> {
  const r = await runGit(cwd, ['show', spec])
  if (r.exitCode !== 0) return { text: '', binary: false }
  return decodeSide(r.stdout)
}

async function readWorkingFile(cwd: string, path: string): Promise<Side> {
  const full = join(cwd, path)
  try {
    const info = await stat(full)
    if (!info.isFile()) return { text: '', binary: false }
    if (info.size > MAX_TEXT_BYTES) return { text: '', binary: true }
    return decodeSide(new Uint8Array(await Bun.file(full).arrayBuffer()))
  } catch {
    return { text: '', binary: false }
  }
}

/** See `GitDiff` for which sides `staged` selects. Files over 2 MB or with NUL bytes are binary. */
export async function diff(cwd: string, path: string, staged: boolean): Promise<GitDiff> {
  const [original, modified] = staged
    ? await Promise.all([readBlob(cwd, `HEAD:${path}`), readBlob(cwd, `:${path}`)])
    : await Promise.all([readBlob(cwd, `:${path}`), readWorkingFile(cwd, path)])
  if (original.binary || modified.binary) {
    return { path, staged, original: '', modified: '', binary: true }
  }
  return { path, staged, original: original.text, modified: modified.text, binary: false }
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await git(cwd, ['--literal-pathspecs', 'add', '--', ...paths])
}

/** Works in a repo with no commits yet (falls back to `git rm --cached`). */
export async function unstage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const hasHead = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).exitCode === 0
  if (hasHead) {
    await git(cwd, ['--literal-pathspecs', 'restore', '--staged', '--', ...paths])
  } else {
    await git(cwd, ['--literal-pathspecs', 'rm', '--cached', '-r', '-q', '--', ...paths])
  }
}

/** Commits what is staged and returns the new commit's full sha. */
export async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ['commit', '-m', message])
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}
