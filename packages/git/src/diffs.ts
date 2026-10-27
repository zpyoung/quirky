/** Diff content for every source (staged, unstaged, branch, commit) and the guarded save of a working file. */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, readFile, readlink, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { GitDiff, GitDiffSource } from '@quirky/protocol'
import { GitError } from './index'
import { gitEnv, runGit } from './run'

export const MAX_BLOB_BYTES = 10 * 1024 * 1024
export const MAX_RENDER_LINES_PER_SIDE = 120_000
export const MAX_RENDER_CHARACTERS = 6_000_000

/** Mime types of the files shown as images (and PDFs), keyed by lowercase extension. */
export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

/** The working file changed since the editor read it. */
export class ChangedOnDiskError extends Error {
  constructor(message = 'The file changed on disk.') {
    super(message)
    this.name = 'ChangedOnDiskError'
  }
}

/** The target may not be written, for example because the leaf is a symlink. */
export class NotAllowedError extends Error {
  constructor(message = 'Not allowed.') {
    super(message)
    this.name = 'NotAllowedError'
  }
}

/** sha-256 of `bytes` as lowercase hex; the editor's `expected` precondition for a save. */
export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export type DiffRequest = {
  path: string
  source: GitDiffSource
  oldPath?: string
  mergeBase?: string
  head?: string
  commit?: string
  parent?: string | null
}

/** One side of a diff; `tooBig` sides carry no bytes. */
type Side = { bytes: Uint8Array; tooBig: boolean; present: boolean }

const EMPTY: Side = { bytes: new Uint8Array(0), tooBig: false, present: false }
const OID = /^[0-9a-f]{40}$/
const MISSING_BLOB = /does not exist|exists on disk, but not in/

function requireOid(value: string | null | undefined): string {
  if (typeof value !== 'string' || !OID.test(value)) throw new GitError('Invalid commit id', '', -1)
  return value
}

async function gitCommitExists(cwd: string, oid: string): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${oid}^{commit}`], { readOnly: true })
  return r.exitCode === 0
}

/**
 * Reads `git show <spec>` with stdout capped at `MAX_BLOB_BYTES`; past the cap the process is
 * killed and the side is `tooBig`. A path absent at a real revision is an empty side; any other
 * failure throws.
 */
async function readBlob(cwd: string, spec: string): Promise<Side> {
  const proc = Bun.spawn(['git', 'show', '--no-textconv', '--end-of-options', spec], {
    cwd,
    env: await gitEnv(cwd, { readOnly: true }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const stderr = new Response(proc.stderr as ReadableStream).text()
  const chunks: Uint8Array[] = []
  let total = 0
  let tooBig = false
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_BLOB_BYTES) {
      tooBig = true
      proc.kill()
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  const [message, exitCode] = await Promise.all([stderr, proc.exited])
  if (tooBig) return { bytes: new Uint8Array(0), tooBig: true, present: true }
  if (exitCode === 0) return { bytes: concat(chunks, total), tooBig: false, present: true }

  const revision = spec.slice(0, spec.indexOf(':'))
  const unbornHead = revision === 'HEAD' && /invalid object name 'HEAD'/.test(message)
  // git words an unknown commit like a missing path, so a hex revision has to be checked itself
  const knownRevision = !OID.test(revision) || (await gitCommitExists(cwd, revision))
  if (unbornHead || (MISSING_BLOB.test(message) && knownRevision)) return EMPTY
  const detail = message.trim()
  throw new GitError(`git show failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`, message, exitCode)
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

type WorkingFile = { side: Side; hash: string | null; deleted: boolean }

/** The working copy of `path`; a leaf symlink is read as its target text and never followed. */
async function readWorkingFile(cwd: string, path: string): Promise<WorkingFile> {
  const full = join(cwd, path)
  let info
  try {
    info = await lstat(full)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { side: EMPTY, hash: null, deleted: true }
    throw error
  }
  if (info.isSymbolicLink()) {
    const bytes = new TextEncoder().encode(await readlink(full))
    return { side: { bytes, tooBig: false, present: true }, hash: contentHash(bytes), deleted: false }
  }
  if (!info.isFile()) return { side: EMPTY, hash: null, deleted: false }
  if (info.size > MAX_BLOB_BYTES) {
    return { side: { bytes: new Uint8Array(0), tooBig: true, present: true }, hash: await hashFile(full), deleted: false }
  }
  const bytes = new Uint8Array(await readFile(full))
  return { side: { bytes, tooBig: false, present: true }, hash: contentHash(bytes), deleted: false }
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

function lineCount(text: string): number {
  if (text.length === 0) return 0
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return text.endsWith('\n') ? count : count + 1
}

function decodeSide(side: Side): string {
  return new TextDecoder().decode(side.bytes)
}

/**
 * Both sides of `request.path` for its source, shaped as a `GitDiff`: staged is HEAD to index,
 * unstaged is index (else HEAD) to the working file, branch is merge base to head, commit is
 * parent to commit. Images carry base64 sides; binary and too-large files carry empty bodies.
 * Throws `GitError` for a bad commit id or any git failure other than a missing path, so an
 * unreadable diff never looks like "no changes".
 */
export async function diffSource(cwd: string, request: DiffRequest): Promise<GitDiff> {
  const { path, source, oldPath } = request
  const fromPath = oldPath ?? path
  let original: Side
  let modified: Side
  let working: WorkingFile | undefined
  if (source === 'staged') {
    ;[original, modified] = await Promise.all([readBlob(cwd, `HEAD:${path}`), readBlob(cwd, `:${path}`)])
  } else if (source === 'unstaged') {
    const [indexSide, file] = await Promise.all([readBlob(cwd, `:${path}`), readWorkingFile(cwd, path)])
    original = indexSide.present ? indexSide : await readBlob(cwd, `HEAD:${path}`)
    working = file
    modified = file.side
  } else if (source === 'branch') {
    const mergeBase = requireOid(request.mergeBase)
    const head = requireOid(request.head)
    ;[original, modified] = await Promise.all([readBlob(cwd, `${mergeBase}:${fromPath}`), readBlob(cwd, `${head}:${path}`)])
  } else {
    const commit = requireOid(request.commit)
    const parent = request.parent === null ? null : requireOid(request.parent)
    ;[original, modified] = await Promise.all([
      parent === null ? EMPTY : readBlob(cwd, `${parent}:${fromPath}`),
      readBlob(cwd, `${commit}:${path}`)
    ])
  }

  const result: GitDiff = {
    path,
    staged: source === 'staged',
    original: '',
    modified: '',
    binary: false,
    source,
    kind: 'text',
    ...(oldPath !== undefined ? { oldPath } : {})
  }
  if (working) {
    result.modifiedHash = working.hash
    if (working.deleted) result.modifiedDeleted = true
  }

  const mime = IMAGE_MIME[extname(path).toLowerCase()]
  if (mime && !original.tooBig && !modified.tooBig) {
    return {
      ...result,
      kind: 'image',
      binary: true,
      mime,
      original: Buffer.from(original.bytes).toString('base64'),
      modified: Buffer.from(modified.bytes).toString('base64')
    }
  }
  if (original.tooBig || modified.tooBig || original.bytes.includes(0) || modified.bytes.includes(0)) {
    return { ...result, kind: 'binary', binary: true }
  }

  const originalText = decodeSide(original)
  const modifiedText = decodeSide(modified)
  const characters = originalText.length + modifiedText.length
  const originalLines = lineCount(originalText)
  const modifiedLines = lineCount(modifiedText)
  if (characters > MAX_RENDER_CHARACTERS) {
    return { ...result, tooLarge: { originalLines, modifiedLines, characters, reason: 'characters' } }
  }
  if (originalLines > MAX_RENDER_LINES_PER_SIDE || modifiedLines > MAX_RENDER_LINES_PER_SIDE) {
    return { ...result, tooLarge: { originalLines, modifiedLines, characters, reason: 'lines' } }
  }
  return { ...result, original: originalText, modified: modifiedText }
}

/**
 * Replaces the working file at `path` with `content` atomically and returns the new content hash.
 * With `expected` (a hash, or null for "must not exist") the write is refused with
 * `ChangedOnDiskError` when the file no longer matches. A symlink leaf throws `NotAllowedError`.
 * The caller has already checked that `path` stays inside the worktree.
 */
export async function saveWorkingFile(
  cwd: string,
  path: string,
  content: string,
  expected?: string | null
): Promise<{ hash: string }> {
  const full = join(cwd, path)
  let mode: number | undefined
  let currentHash: string | null = null
  try {
    const info = await lstat(full)
    if (info.isSymbolicLink()) throw new NotAllowedError(`${path} is a symbolic link and cannot be saved.`)
    if (!info.isFile()) throw new NotAllowedError(`${path} is not a regular file.`)
    mode = info.mode & 0o7777
    if (expected !== undefined) currentHash = await hashFile(full)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (expected !== undefined && currentHash !== expected) throw new ChangedOnDiskError()

  const bytes = new TextEncoder().encode(content)
  const temp = join(dirname(full), `.${basename(full)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, bytes, { flag: 'wx' })
    if (mode !== undefined) await chmod(temp, mode)
    await rename(temp, full)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return { hash: contentHash(bytes) }
}
