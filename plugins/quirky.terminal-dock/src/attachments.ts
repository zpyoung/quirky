import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import type { DockAttachment } from './types.ts'

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;[^\r\n\0]*)?$/

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.text': 'text/plain',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/yaml': '.yaml',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'text/plain': '.txt'
}

function invalid(context: PluginContext, message: string): never {
  throw context.error('invalid-params', message)
}

function mimeFor(name: string, supplied: string | undefined, context: PluginContext): string {
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !MIME_TYPE.test(supplied)) invalid(context, 'mime must be a valid media type')
    return supplied
  }
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

function attachmentExtension(mime: string): string {
  const mediaType = mime.split(';', 1)[0]!.trim().toLowerCase()
  return EXTENSION_BY_MIME[mediaType] ?? ''
}

function uploadedBytes(value: string, context: PluginContext): Buffer {
  if (value.length > MAX_BASE64_LENGTH || !BASE64.test(value)) {
    invalid(context, 'base64 must be a canonical encoding of an attachment no larger than 10 MiB')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== value) {
    invalid(context, 'base64 must be a canonical encoding of an attachment no larger than 10 MiB')
  }
  return bytes
}

async function readRegularFile(path: string, context: PluginContext): Promise<Buffer> {
  let handle: FileHandle | undefined
  try {
    const before = await lstat(path)
    if (!before.isFile()) invalid(context, 'attachment path must be an existing regular file')
    if (before.size > MAX_ATTACHMENT_BYTES) invalid(context, 'attachment files must be no larger than 10 MiB')

    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile()) invalid(context, 'attachment path must be an existing regular file')
    if (opened.size > MAX_ATTACHMENT_BYTES) invalid(context, 'attachment files must be no larger than 10 MiB')

    const buffer = Buffer.allocUnsafe(Math.min(opened.size + 1, MAX_ATTACHMENT_BYTES + 1))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== opened.size || length !== opened.size) {
      invalid(context, 'attachment file changed while it was being acquired')
    }
    return buffer.subarray(0, length)
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
      if (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'EACCES' || error.code === 'ENOTDIR') {
        invalid(context, 'attachment path must be a readable regular file')
      }
    }
    throw error
  } finally {
    await handle?.close()
  }
}

async function storeBytes(bytes: Buffer, mime: string, context: PluginContext): Promise<{ id: string; path: string }> {
  const dataDir = resolve(context.dataDir)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const dirStat = await lstat(dataDir)
  if (!dirStat.isDirectory()) invalid(context, 'plugin data directory must be a directory')

  for (;;) {
    const id = randomUUID()
    const path = resolve(dataDir, `upload-${id}${attachmentExtension(mime)}`)
    let handle: FileHandle
    try {
      handle = await open(path, 'wx', 0o600)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }

    try {
      await handle.writeFile(bytes)
      await handle.close()
      return { id, path }
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(path).catch(() => {})
      throw error
    }
  }
}

/** Copies a regular caller file or uploaded bytes into this plugin's private data directory. */
export async function acquireAttachment(
  context: PluginContext,
  input: { path?: string; name?: string; mime?: string; base64?: string }
): Promise<DockAttachment> {
  const fromPath = input.path !== undefined
  const fromUpload = input.base64 !== undefined
  if (fromPath === fromUpload) invalid(context, 'provide exactly one of path or uploaded base64 bytes')

  let name: string
  let bytes: Buffer
  if (fromPath) {
    if (typeof input.path !== 'string' || input.path.length === 0) invalid(context, 'path must be a non-empty file path')
    if (input.name !== undefined && typeof input.name !== 'string') invalid(context, 'attachment name must be a string')
    name = input.name ?? basename(input.path)
    if (name.trim() === '') invalid(context, 'attachment name must not be empty')
    bytes = await readRegularFile(input.path, context)
  } else {
    if (typeof input.name !== 'string' || input.name.trim() === '') invalid(context, 'name is required for uploaded bytes')
    if (typeof input.base64 !== 'string') invalid(context, 'base64 is required for uploaded bytes')
    name = input.name
    bytes = uploadedBytes(input.base64, context)
  }

  if (input.mime !== undefined && typeof input.mime !== 'string') invalid(context, 'mime must be a string')
  const mime = mimeFor(name, input.mime, context)
  const stored = await storeBytes(bytes, mime, context)
  return { id: stored.id, name, path: stored.path, mime, image: mime.split(';', 1)[0]!.trim().toLowerCase().startsWith('image/') }
}
