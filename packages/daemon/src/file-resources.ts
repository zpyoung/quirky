import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import type { PluginContext } from '@quirky/protocol'

type FileResourceOptions = Parameters<PluginContext['createFileResource']>[0]
type FileIdentity = { dev: number; ino: number }
type ByteRange = { start: number; end: number }
type CreatedFileResource = { url: string; revoke(): void }
type ActiveStream = {
  close(): Promise<void>
  fail(error: unknown): Promise<void>
  cancel(): Promise<void>
}

type FileResource = {
  token: string
  pluginId: string
  path: string
  contentType: string
  disposition: 'inline' | 'attachment'
  identity: FileIdentity
  identityHandle: FileHandle
  requestHandles: Map<FileHandle, Promise<void> | null>
  pendingOpens: Set<Promise<FileHandle>>
  streams: Set<ActiveStream>
  revoked: boolean
  closing?: Promise<void>
}

export const FILE_RESOURCE_ROUTE = '/plugin-file-resources'
const TOKEN_BYTES = 32
const TOKEN_PATH = /^\/plugin-file-resources\/([A-Za-z0-9_-]{43})$/
const CHUNK_SIZE = 64 * 1024
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const SAFE_CONTENT_TYPES: Record<string, true> = {
  'application/octet-stream': true,
  'application/pdf': true,
  'application/json': true,
  'image/avif': true,
  'image/bmp': true,
  'image/gif': true,
  'image/jpeg': true,
  'image/png': true,
  'image/svg+xml': true,
  'image/webp': true,
  'image/x-icon': true,
  'text/csv': true,
  'text/plain': true,
  'audio/aac': true,
  'audio/flac': true,
  'audio/mp4': true,
  'audio/mpeg': true,
  'audio/ogg': true,
  'audio/wav': true,
  'audio/webm': true,
  'video/mp4': true,
  'video/ogg': true,
  'video/quicktime': true,
  'video/webm': true
}

function identityOf(stat: { dev: number; ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function normalizedDecimal(value: string): string {
  return value.replace(/^0+/, '') || '0'
}

function compareDecimal(left: string, right: string): number {
  const a = normalizedDecimal(left)
  const b = normalizedDecimal(right)
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

function headersFor(resource: FileResource, length: number, contentRange?: string): Headers {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': resource.disposition,
    'Content-Length': String(length),
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Type': resource.contentType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
  if (contentRange !== undefined) headers.set('Content-Range', contentRange)
  return headers
}

function errorResponse(status: number, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Cache-Control', 'no-store')
  responseHeaders.set('Content-Length', '0')
  responseHeaders.set('Referrer-Policy', 'no-referrer')
  return new Response(null, { status, headers: responseHeaders })
}

function parseRange(header: string | null, size: number): ByteRange | null | false {
  if (header === null) return null
  const value = header.trim()
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value)
  if (!match || (match[1] === '' && match[2] === '')) return false
  if (size === 0) return false

  const sizeText = String(size)
  if (match[1] === '') {
    const suffix = normalizedDecimal(match[2]!)
    if (suffix === '0') return false
    const start = compareDecimal(suffix, sizeText) >= 0 ? 0 : size - Number(suffix)
    return { start, end: size - 1 }
  }

  const startText = normalizedDecimal(match[1]!)
  if (compareDecimal(startText, sizeText) >= 0) return false
  const start = Number(startText)
  if (match[2] === '') return { start, end: size - 1 }

  const requestedEnd = normalizedDecimal(match[2]!)
  if (compareDecimal(requestedEnd, startText) < 0) return false
  const end = compareDecimal(requestedEnd, String(size - 1)) >= 0 ? size - 1 : Number(requestedEnd)
  return { start, end }
}

/** Owns opaque, activation-scoped URLs for authorized regular files. */
export class FileResourceRegistry {
  private readonly byToken = new Map<string, FileResource>()
  private readonly byPlugin = new Map<string, Set<FileResource>>()
  private readonly creations = new Map<string, Set<Promise<CreatedFileResource>>>()
  private closed = false

  create(pluginId: string, options: FileResourceOptions, isRevoked: () => boolean): Promise<CreatedFileResource> {
    const creation = this.openResource(pluginId, options, isRevoked)
    const owned = this.creations.get(pluginId) ?? new Set<Promise<CreatedFileResource>>()
    owned.add(creation)
    this.creations.set(pluginId, owned)
    const forget = () => {
      owned.delete(creation)
      if (owned.size === 0) this.creations.delete(pluginId)
    }
    void creation.then(forget, forget)
    return creation
  }

  /** Resolves only exact opaque token paths; request input can never select a filesystem path. */
  async serve(request: Request, pathname: string): Promise<Response> {
    const match = TOKEN_PATH.exec(pathname)
    if (!match) return errorResponse(404)
    const resource = this.byToken.get(match[1]!)
    if (!resource || resource.revoked) return errorResponse(404)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, { Allow: 'GET, HEAD' })
    }

    let handle: FileHandle
    let size: number
    try {
      const opened = await this.openCurrent(resource)
      handle = opened.handle
      size = opened.size
    } catch {
      return errorResponse(410)
    }
    if (resource.revoked || this.closed) {
      await this.closeRequestHandle(resource, handle)
      return errorResponse(404)
    }
    const range = parseRange(request.headers.get('range'), size)
    if (range === false) {
      await this.closeRequestHandle(resource, handle)
      return errorResponse(416, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${size}`
      })
    }

    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    const length = range === null ? size : end - start + 1
    const contentRange = range === null ? undefined : `bytes ${start}-${end}/${size}`
    const headers = headersFor(resource, length, contentRange)

    if (request.method === 'HEAD' || length === 0) {
      await this.closeRequestHandle(resource, handle)
      return new Response(null, { status: range === null ? 200 : 206, headers })
    }

    if (resource.revoked || this.closed) {
      await this.closeRequestHandle(resource, handle)
      return errorResponse(404)
    }
    const body = this.stream(resource, handle, start, length)
    return new Response(body, { status: range === null ? 200 : 206, headers })
  }

  async revokePlugin(pluginId: string): Promise<void> {
    while (this.byPlugin.has(pluginId) || this.creations.has(pluginId)) {
      const resources = [...(this.byPlugin.get(pluginId) ?? [])]
      const creations = [...(this.creations.get(pluginId) ?? [])]
      await Promise.all([
        ...resources.map((resource) => this.revoke(resource)),
        ...creations.map((creation) => creation.then(() => undefined, () => undefined))
      ])
    }
  }

  async close(): Promise<void> {
    if (!this.closed) this.closed = true
    const resources = [...this.byPlugin.values()].flatMap((owned) => [...owned])
    const revocations = resources.map((resource) => this.revoke(resource))
    const creations = [...this.creations.values()].flatMap((owned) => [...owned])
    await Promise.all([
      ...revocations,
      ...creations.map((creation) => creation.then(() => undefined, () => undefined))
    ])
  }

  private async openResource(
    pluginId: string,
    options: FileResourceOptions,
    isRevoked: () => boolean
  ): Promise<{ url: string; revoke(): void }> {
    if (this.closed || isRevoked()) throw new Error(`${pluginId} is no longer active`)
    if (typeof options !== 'object' || options === null) throw new TypeError('file resource options must be an object')
    if (typeof options.path !== 'string' || options.path.length === 0 || !isAbsolute(options.path) || options.path.includes('\0')) {
      throw new TypeError('file resource path must be an absolute local path')
    }
    if (typeof options.contentType !== 'string') throw new TypeError('file resource contentType must be a string')
    const contentType = options.contentType.trim().toLowerCase()
    if (SAFE_CONTENT_TYPES[contentType] !== true) throw new TypeError('file resource contentType is not allowed')
    const disposition = options.disposition ?? 'inline'
    if (disposition !== 'inline' && disposition !== 'attachment') {
      throw new TypeError('file resource disposition must be inline or attachment')
    }

    const canonicalPath = await realpath(options.path)
    if (isRevoked() || this.closed) throw new Error(`${pluginId} is no longer active`)
    const openedPath = await lstat(canonicalPath)
    if (!openedPath.isFile() || openedPath.isSymbolicLink()) throw new TypeError('file resource must refer to a regular file')

    const identityHandle = await open(canonicalPath, FILE_FLAGS)
    try {
      const openedStat = await identityHandle.stat()
      const pathStat = await lstat(canonicalPath)
      const confirmedPath = await realpath(canonicalPath)
      if (
        !openedStat.isFile() ||
        !pathStat.isFile() ||
        pathStat.isSymbolicLink() ||
        confirmedPath !== canonicalPath ||
        !sameIdentity(identityOf(openedStat), identityOf(pathStat)) ||
        !Number.isSafeInteger(openedStat.size)
      ) {
        throw new TypeError('file resource path changed or is not a regular file')
      }
      if (isRevoked() || this.closed) throw new Error(`${pluginId} is no longer active`)

      let token = randomBytes(TOKEN_BYTES).toString('base64url')
      while (this.byToken.has(token)) token = randomBytes(TOKEN_BYTES).toString('base64url')
      const resource: FileResource = {
        token,
        pluginId,
        path: canonicalPath,
        contentType,
        disposition,
        identity: identityOf(openedStat),
        identityHandle,
        requestHandles: new Map(),
        pendingOpens: new Set(),
        streams: new Set(),
        revoked: false
      }
      this.byToken.set(token, resource)
      const owned = this.byPlugin.get(pluginId) ?? new Set<FileResource>()
      owned.add(resource)
      this.byPlugin.set(pluginId, owned)

      return {
        url: `${FILE_RESOURCE_ROUTE}/${token}`,
        revoke: () => {
          void this.revoke(resource)
        }
      }
    } catch (error) {
      await identityHandle.close().catch(() => {})
      throw error
    }
  }

  private async openCurrent(resource: FileResource): Promise<{ handle: FileHandle; size: number }> {
    if (resource.revoked || this.closed) throw new Error('resource is revoked')
    if ((await realpath(resource.path)) !== resource.path) throw new Error('resource path changed')
    const before = await lstat(resource.path)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('resource path is not a regular file')
    if (resource.revoked || this.closed) throw new Error('resource is revoked')

    const opening = open(resource.path, FILE_FLAGS).then((handle) => {
      resource.requestHandles.set(handle, null)
      return handle
    })
    resource.pendingOpens.add(opening)
    let handle: FileHandle
    try {
      handle = await opening
    } catch (error) {
      resource.pendingOpens.delete(opening)
      throw error
    }
    resource.pendingOpens.delete(opening)

    try {
      const stat = await handle.stat()
      const after = await lstat(resource.path)
      const resolved = await realpath(resource.path)
      const expected = identityOf(await resource.identityHandle.stat())
      const openedIdentity = identityOf(stat)
      if (
        resource.revoked ||
        this.closed ||
        !stat.isFile() ||
        !after.isFile() ||
        after.isSymbolicLink() ||
        resolved !== resource.path ||
        !sameIdentity(expected, openedIdentity) ||
        !sameIdentity(expected, identityOf(after)) ||
        !Number.isSafeInteger(stat.size)
      ) {
        throw new Error('resource file identity changed')
      }
      return { handle, size: stat.size }
    } catch (error) {
      await this.closeRequestHandle(resource, handle)
      throw error
    }
  }

  private closeRequestHandle(resource: FileResource, handle: FileHandle): Promise<void> {
    const current = resource.requestHandles.get(handle)
    if (current) return current
    if (!resource.requestHandles.has(handle)) return Promise.resolve()
    const closing = handle.close().catch(() => {}).then(() => {
      resource.requestHandles.delete(handle)
    })
    resource.requestHandles.set(handle, closing)
    return closing
  }

  private stream(resource: FileResource, handle: FileHandle, offset: number, length: number): ReadableStream<Uint8Array> {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let position = offset
    let remaining = length
    let stopped = false
    let controllerState: 'open' | 'closed' | 'errored' | 'cancelled' = 'open'
    let closing: Promise<void> | undefined

    const finish = (kind: 'close' | 'error' | 'cancel', error?: unknown): Promise<void> => {
      if (closing) return closing
      stopped = true
      closing = this.closeRequestHandle(resource, handle).then(() => {
        resource.streams.delete(active)
      })
      if (controllerState === 'open') {
        if (kind === 'cancel') {
          controllerState = 'cancelled'
        } else {
          controllerState = kind === 'error' ? 'errored' : 'closed'
          if (controller) {
            try {
              if (kind === 'error') controller.error(error)
              else controller.close()
            } catch {}
          }
        }
      }
      return closing
    }
    const active: ActiveStream = {
      close: () => finish('close'),
      fail: (error) => finish('error', error),
      cancel: () => finish('cancel')
    }
    resource.streams.add(active)

    return new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController
      },
      async pull(streamController) {
        if (stopped) return
        if (remaining === 0) {
          await active.close()
          return
        }
        const buffer = new Uint8Array(Math.min(CHUNK_SIZE, remaining))
        try {
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
          if (stopped) return
          if (bytesRead === 0) {
            await active.close()
            return
          }
          position += bytesRead
          remaining -= bytesRead
          streamController.enqueue(bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead))
          if (remaining === 0) await active.close()
        } catch (error) {
          if (!stopped) await active.fail(error)
          else await active.close()
        }
      },
      cancel: () => active.cancel()
    })
  }

  private revoke(resource: FileResource): Promise<void> {
    if (resource.closing) return resource.closing
    resource.revoked = true
    this.byToken.delete(resource.token)
    const requestHandles = [...resource.requestHandles.keys()]
    const pendingCloses = [...resource.pendingOpens].map((opening) =>
      opening.then((handle) => this.closeRequestHandle(resource, handle), () => undefined)
    )
    const handleCloses = requestHandles.map((handle) => this.closeRequestHandle(resource, handle))
    const streams = [...resource.streams]
    resource.closing = Promise.all([
      resource.identityHandle.close().catch(() => {}),
      ...handleCloses,
      ...pendingCloses,
      ...streams.map((stream) => stream.close())
    ]).then(() => {
      const owned = this.byPlugin.get(resource.pluginId)
      owned?.delete(resource)
      if (owned?.size === 0) this.byPlugin.delete(resource.pluginId)
    })
    return resource.closing
  }
}
