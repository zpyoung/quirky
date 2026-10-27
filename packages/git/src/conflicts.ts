/**
 * Conflict handling for a stopped merge, rebase or cherry-pick: reading a conflicted file,
 * spotting leftover markers, and continuing or aborting the operation.
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitOperation } from '@quirky/protocol'
import { GitError } from './index'
import { git, runGit } from './run'

/** The request names something this operation must not touch (a symlink, a binary file, a folder not on the allowlist). */
export class NotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotAllowedError'
  }
}

const MARKER_LINE = /^(?:<{7} |\|{7} |>{7} |={7}$)/m

const BINARY_SNIFF_BYTES = 8192

/** Whether `text` has a line git writes into a conflicted file: `<<<<<<< `, `||||||| `, `=======` or `>>>>>>> `. */
export function hasConflictMarkers(text: string): boolean {
  return MARKER_LINE.test(text)
}

/**
 * The working-tree text of a conflicted `path` and the sha-256 hex of its bytes (an edit
 * guard). A missing file is `{content: null, hash: null}`; a symlink, a folder or a binary
 * file throws `NotAllowedError` rather than being followed or decoded.
 */
export async function readConflictFile(
  cwd: string,
  path: string
): Promise<{ content: string | null; hash: string | null }> {
  const full = join(cwd, path)
  const info = await lstat(full).catch(() => null)
  if (!info) return { content: null, hash: null }
  if (info.isSymbolicLink()) throw new NotAllowedError(`${path} is a symlink`)
  if (info.isDirectory()) throw new NotAllowedError(`${path} is a directory`)
  const bytes = await readFile(full)
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new NotAllowedError(`${path} is binary`)
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  return { content: new TextDecoder().decode(bytes), hash }
}

async function operationInProgress(cwd: string, operation: Exclude<GitOperation, 'none'>): Promise<boolean> {
  const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'], { readOnly: true })).trim()
  const markers =
    operation === 'rebase'
      ? ['rebase-merge', 'rebase-apply']
      : operation === 'cherry-pick'
        ? ['CHERRY_PICK_HEAD', 'sequencer']
        : ['MERGE_HEAD']
  const found = await Promise.all(markers.map((name) => lstat(join(gitDir, name)).then(() => true, () => false)))
  return found.some(Boolean)
}

const head = async (cwd: string): Promise<string> =>
  (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { readOnly: true })).exitCode === 0
    ? (await git(cwd, ['rev-parse', 'HEAD'], { readOnly: true })).trim()
    : ''

/**
 * Runs `<operation> --continue` with no editor. `finished` is false when a rebase or cherry-pick
 * applied the resolved step and stopped on the next conflict, which is a normal outcome. Any
 * other failure (unresolved paths, a failing hook) throws `GitError` carrying git's stderr.
 */
export async function continueOperation(
  cwd: string,
  operation: Exclude<GitOperation, 'none'>
): Promise<{ finished: boolean }> {
  const before = await head(cwd)
  const env: Record<string, string> = { GIT_EDITOR: 'true' }
  if (operation === 'rebase') env.GIT_SEQUENCE_EDITOR = 'true'
  const result = await runGit(cwd, ['-c', 'core.editor=true', operation, '--continue'], { env })
  const inProgress = operation === 'merge' ? false : await operationInProgress(cwd, operation)

  if (result.exitCode === 0) return { finished: !inProgress }

  // stopped again vs failed: a stop has moved HEAD past the resolved step and left new conflicts
  if (inProgress && (await head(cwd)) !== before) {
    const unmerged = await git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U'], { readOnly: true })
    if (unmerged.length > 0) return { finished: false }
  }
  const detail = result.stderr.trim()
  throw new GitError(
    `git ${operation} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`,
    result.stderr,
    result.exitCode
  )
}

/** Cancels a merge or rebase in progress and restores the state before it started. */
export async function abortOperation(cwd: string, operation: 'merge' | 'rebase'): Promise<void> {
  await git(cwd, [operation, '--abort'])
}
