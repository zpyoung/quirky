import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { IFilesystemProvider } from '../providers/filesystem-provider-contract'

const LOOPS_EXCLUDE_LINE = '/.quirky/loops/'
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type LoopHostFilesystem = Pick<
  IFilesystemProvider,
  'readFile' | 'writeFile' | 'createDir' | 'deletePath' | 'stat'
>

export type LoopGitRunner = (
  args: string[],
  options?: { env?: Record<string, string> }
) => Promise<{ stdout: string; stderr: string }>

/**
 * A loop's workspace as seen from the host that owns it. `runGit` is null for folder workspaces;
 * `fs` is the host's filesystem provider so the same code serves local and SSH workspaces.
 */
export type LoopWorkspaceTarget = {
  kind: 'git' | 'folder'
  workspacePath: string
  pathFlavor: 'posix' | 'win32'
  fs: LoopHostFilesystem
  runGit: LoopGitRunner | null
}

export type LoopNotesTarget = LoopWorkspaceTarget

export type LoopLogEntry = {
  n: number
  endReason: string
  checkPass: boolean | null
  added: number | null
  removed: number | null
  costUsd: number | null
  skippedTicks?: number
}

export function createLocalLoopFilesystem(): LoopHostFilesystem {
  return {
    async readFile(path) {
      return { content: await readFile(path, 'utf8'), isBinary: false }
    },
    async writeFile(path, content) {
      await writeFile(path, content, 'utf8')
    },
    async createDir(path) {
      await mkdir(path, { recursive: true })
    },
    async deletePath(path, recursive) {
      await rm(path, { recursive: recursive ?? false, force: true })
    },
    async stat(path) {
      const value = await stat(path)
      return {
        size: value.size,
        type: value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'file',
        mtime: value.mtimeMs,
        mtimeMs: value.mtimeMs
      }
    }
  }
}

function pathFor(target: Pick<LoopWorkspaceTarget, 'pathFlavor'>): typeof posix {
  return target.pathFlavor === 'win32' ? win32 : posix
}

/** Resolves a path git printed, which is relative to the workspace unless git made it absolute. */
export function resolveGitReportedPath(
  target: Pick<LoopWorkspaceTarget, 'pathFlavor' | 'workspacePath'>,
  reported: string
): string {
  const flavor = pathFor(target)
  return flavor.isAbsolute(reported) ? reported : flavor.join(target.workspacePath, reported)
}

function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`Invalid loop slug: ${JSON.stringify(slug)}`)
  }
}

function loopDirectory(target: LoopWorkspaceTarget, slug: string): string {
  assertSafeSlug(slug)
  return pathFor(target).join(target.workspacePath, '.quirky', 'loops', slug)
}

export function loopNotesPath(target: LoopWorkspaceTarget, slug: string): string {
  return pathFor(target).join(loopDirectory(target, slug), 'notes.md')
}

export function loopLogPath(target: LoopWorkspaceTarget, slug: string): string {
  return pathFor(target).join(loopDirectory(target, slug), 'log.md')
}

// A stat failure means "absent"; a read failure on a file that exists must surface so a
// transient error cannot make the caller overwrite content it never saw.
async function readIfPresent(fs: LoopHostFilesystem, path: string): Promise<string | null> {
  try {
    await fs.stat(path)
  } catch {
    return null
  }
  return (await fs.readFile(path)).content
}

async function excludeLoopsDirectory(
  target: LoopWorkspaceTarget,
  runGit: LoopGitRunner
): Promise<void> {
  const { stdout } = await runGit(['rev-parse', '--git-path', 'info/exclude'])
  const reported = stdout.trim()
  if (!reported) {
    throw new Error('git did not report an info/exclude path')
  }
  const excludePath = resolveGitReportedPath(target, reported)
  const existing = await readIfPresent(target.fs, excludePath)
  if (existing?.split(/\r?\n/).includes(LOOPS_EXCLUDE_LINE)) {
    return
  }
  const prefix = existing === null || existing === '' || existing.endsWith('\n') ? '' : '\n'
  await target.fs.createDir(pathFor(target).dirname(excludePath))
  await target.fs.writeFile(excludePath, `${existing ?? ''}${prefix}${LOOPS_EXCLUDE_LINE}\n`)
}

/**
 * Creates `.quirky/loops/<slug>/notes.md` if absent and, for git workspaces, keeps `.quirky/loops/`
 * out of status via the repository's private exclude file; it throws when that entry cannot be
 * installed. `.gitignore` is never touched, and existing notes content is never rewritten.
 */
export async function ensureLoopNotesFile(
  target: LoopWorkspaceTarget,
  slug: string
): Promise<{ notesPath: string; logPath: string }> {
  const notesPath = loopNotesPath(target, slug)
  await target.fs.createDir(loopDirectory(target, slug))
  if ((await readIfPresent(target.fs, notesPath)) === null) {
    await target.fs.writeFile(
      notesPath,
      `# ${slug}\n\nNotes for this loop. Edit freely; Quirky does not rewrite this file.\n`
    )
  }
  if (target.kind === 'git') {
    if (!target.runGit) {
      throw new Error(
        'git is unavailable on the workspace host, so .quirky/loops/ cannot be excluded'
      )
    }
    await excludeLoopsDirectory(target, target.runGit)
  }
  return { notesPath, logPath: loopLogPath(target, slug) }
}

export function formatLoopLogLine(entry: LoopLogEntry): string {
  const check = entry.checkPass === null ? 'none' : entry.checkPass ? 'pass' : 'fail'
  const diff =
    entry.added === null || entry.removed === null ? 'n/a' : `+${entry.added} -${entry.removed}`
  const cost = entry.costUsd === null ? 'n/a' : `$${entry.costUsd.toFixed(2)}`
  const skipped =
    entry.skippedTicks && entry.skippedTicks > 0 ? ` | skipped ${entry.skippedTicks} ticks` : ''
  return `#${entry.n} ${entry.endReason} | check ${check} | diff ${diff} | cost ${cost}${skipped}`
}

/**
 * Appends one line to the loop's iteration log. Returns false rather than throwing: the database
 * is authoritative, so a failed log write must not disturb the loop.
 */
export async function appendLoopLogLine(
  target: LoopWorkspaceTarget,
  slug: string,
  entry: LoopLogEntry
): Promise<boolean> {
  try {
    const logPath = loopLogPath(target, slug)
    const existing = (await readIfPresent(target.fs, logPath)) ?? ''
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await target.fs.writeFile(logPath, `${existing}${prefix}${formatLoopLogLine(entry)}\n`)
    return true
  } catch {
    return false
  }
}
