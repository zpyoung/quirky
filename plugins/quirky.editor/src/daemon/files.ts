import { constants } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import { createHash } from 'node:crypto'
import type { EditorKind } from '../types'

export const MAX_TEXT_FILE_BYTES = 50 * 1024 * 1024
export const MAX_READ_BYTES = 1024 * 1024
const BINARY_PROBE_BYTES = 8192

export type FileSnapshot = {
  bytes: Buffer
  size: number
  hash: string
  text: string | null
  kind: EditorKind
  readOnly: boolean
}

export type GuardedWriteResult = 'written' | 'changed' | 'missing'

const IMAGE_EXTENSIONS = new Set(['.png', '.avif', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac', '.opus'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm'])

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function hashText(text: string): string {
  return hashBytes(Buffer.from(text, 'utf8'))
}

export function kindForPath(path: string): EditorKind {
  const ext = extname(path).toLowerCase()
  if (ext === '.ipynb') return 'notebook'
  if (['.md', '.markdown', '.mdx'].includes(ext)) return 'markdown'
  if (['.csv', '.tsv'].includes(ext)) return 'csv'
  if (['.mmd', '.mermaid'].includes(ext)) return 'mermaid'
  if (ext === '.pdf') return 'pdf'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'text'
}

export function classifySnapshot(path: string, bytes: Buffer, size: number): FileSnapshot {
  const namedKind = kindForPath(path)
  const probe = bytes.subarray(0, BINARY_PROBE_BYTES)
  const hasNul = probe.includes(0)
  let text: string | null = null
  if (!hasNul && !['image', 'pdf', 'audio', 'video'].includes(namedKind)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      text = null
    }
  }
  const binary = hasNul || text === null
  const kind: EditorKind = binary ? (namedKind === 'image' || namedKind === 'pdf' || namedKind === 'audio' || namedKind === 'video' ? namedKind : 'binary') : namedKind
  const readOnly = binary || ['image', 'pdf', 'audio', 'video'].includes(kind) || (kind === 'csv' && size >= 1024 * 1024)
  return { bytes, size, hash: hashBytes(bytes), text: readOnly ? null : text, kind, readOnly }
}

export async function readSnapshot(path: string, maximum = MAX_TEXT_FILE_BYTES): Promise<FileSnapshot> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag())
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
    if (info.size > maximum) throw new Error(`file too large (${info.size} bytes; maximum ${maximum}): ${path}`)
    const bytes = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const exact = offset === bytes.length ? bytes : bytes.subarray(0, offset)
    return classifySnapshot(path, exact, info.size)
  } finally {
    await handle.close()
  }
}

export async function readByteRange(path: string, offset: number, length: number): Promise<{ data: string; eof: boolean; size: number }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer')
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_READ_BYTES) throw new RangeError(`length must be between 0 and ${MAX_READ_BYTES}`)
  const handle = await open(path, constants.O_RDONLY | noFollowFlag())
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
    const count = Math.min(length, Math.max(0, info.size - offset))
    const data = Buffer.allocUnsafe(count)
    let read = 0
    while (read < count) {
      const result = await handle.read(data, read, count - read, offset + read)
      if (result.bytesRead === 0) break
      read += result.bytesRead
    }
    return { data: data.subarray(0, read).toString('base64'), eof: offset + read >= info.size, size: info.size }
  } finally {
    await handle.close()
  }
}

export async function currentHash(path: string): Promise<string | null> {
  try {
    return (await readSnapshot(path)).hash
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
    throw error
  }
}

export async function guardedWrite(
  path: string,
  content: string,
  expectedHash: string,
  allowMissing: boolean
): Promise<GuardedWriteResult> {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw new RangeError(`file too large to save; maximum is ${MAX_TEXT_FILE_BYTES} bytes`)
  let existing
  try {
    existing = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
  if (existing === undefined) {
    if (!allowMissing) return 'missing'
    try {
      const created = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
      try {
        await created.writeFile(bytes)
        await created.sync()
      } finally {
        await created.close()
      }
      return 'written'
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return 'changed'
      throw error
    }
  }
  if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`not a regular file: ${path}`)

  const handle = await open(path, constants.O_RDWR | noFollowFlag())
  try {
    const handleInfo = await handle.stat()
    const pathInfo = await lstat(path)
    if (!handleInfo.isFile() || pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error(`not a regular file: ${path}`)
    if (handleInfo.dev !== pathInfo.dev || handleInfo.ino !== pathInfo.ino) return 'changed'
    if (handleInfo.size > MAX_TEXT_FILE_BYTES) throw new RangeError(`file too large to save; maximum is ${MAX_TEXT_FILE_BYTES} bytes`)
    const previous = Buffer.allocUnsafe(handleInfo.size)
    let read = 0
    while (read < previous.length) {
      const result = await handle.read(previous, read, Math.min(1024 * 1024, previous.length - read), read)
      if (result.bytesRead === 0) break
      read += result.bytesRead
    }
    const current = hashBytes(previous.subarray(0, read))
    if (current !== expectedHash) return 'changed'
    const recheck = await realpath(path)
    if (recheck !== path) return 'changed'
    await handle.truncate(0)
    await handle.writeFile(bytes)
    await handle.sync()
    return 'written'
  } finally {
    await handle.close()
  }
}

export async function withOpenFile<T>(path: string, work: (handle: FileHandle) => Promise<T>): Promise<T> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag())
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
    return await work(handle)
  } finally {
    await handle.close()
  }
}

export async function statRegular(path: string): Promise<Awaited<ReturnType<typeof stat>>> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`not a regular file: ${path}`)
  return info
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0
}
