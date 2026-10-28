import { existsSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, sep, posix } from 'node:path'
import type { PluginCaller } from '@quirky/protocol'
import type { EditorServices, MarkdownPreviewParams, MarkdownPreviewResult } from '../types'
import { assertPreviewBounds, renderSafeMarkdownHtml } from './preview'
import {
  MARKDOWN_MAX_PREVIEW_IMAGES,
  releaseMarkdownImages,
  resolveMarkdownImages,
  type MarkdownResourcePool
} from './files'
import { MARKDOWN_MAX_PATH_BYTES, utf8Bytes } from './source'

const MAX_ACTIVE_PREVIEW_LEASES = 64
const MARKDOWN_EXTENSIONS: Record<string, true> = { '.md': true, '.markdown': true, '.mdx': true }
const URL_SAFE_LEASE_ID = /^[A-Za-z0-9_-]{1,128}$/
const RENDER_KEYS = ['action', 'leaseId', 'worktree', 'path', 'text']
const RELEASE_KEYS = ['action', 'leaseId']

type RenderRequest = Extract<MarkdownPreviewParams, { action: 'render' }>
type Lease = { active: boolean; resources: MarkdownResourcePool }

export type DetachedMarkdownPreviewService = {
  method(params: Record<string, unknown>, caller: PluginCaller): Promise<MarkdownPreviewResult>
  dispose(): void
}


function invalid(host: EditorServices, message: string): never {
  throw host.context.error('invalid-params', message)
}

function conflict(host: EditorServices, message: string): never {
  throw host.context.error('conflict', message)
}

function requireObject(host: EditorServices, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(host, 'Markdown preview parameters must be an object.')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(host, 'Markdown preview parameters must be a plain object.')
  return value as Record<string, unknown>
}
function requireExactKeys(host: EditorServices, params: Record<string, unknown>, expected: string[]): void {
  const keys = Reflect.ownKeys(params)
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    invalid(host, 'Markdown preview parameters contain missing or unsupported fields.')
  }
}


function requireLeaseId(host: EditorServices, value: unknown): string {
  if (typeof value !== 'string' || !URL_SAFE_LEASE_ID.test(value)) {
    invalid(host, 'leaseId must be 1–128 URL-safe ASCII characters.')
  }
  return value
}
function parseRequest(host: EditorServices, value: unknown): MarkdownPreviewParams {
  const params = requireObject(host, value)
  if (params.action === 'release') {
    requireExactKeys(host, params, RELEASE_KEYS)
    return { action: 'release', leaseId: requireLeaseId(host, params.leaseId) }
  }
  if (params.action !== 'render') invalid(host, 'action must be render or release.')
  requireExactKeys(host, params, RENDER_KEYS)
  const leaseId = requireLeaseId(host, params.leaseId)
  if (typeof params.worktree !== 'string' || !params.worktree.startsWith('id:') || params.worktree.length <= 3) {
    invalid(host, 'worktree must be an explicit registered worktree id selector.')
  }
  if (typeof params.path !== 'string' || params.path.length === 0 || utf8Bytes(params.path) > MARKDOWN_MAX_PATH_BYTES) {
    invalid(host, 'path must be a non-empty worktree-relative Markdown path within the 64 KiB limit.')
  }
  const normalizedPath = posix.normalize(params.path)
  if (
    params.path.includes('\0') || params.path.includes('\\') || params.path.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(params.path) || isAbsolute(params.path) ||
    normalizedPath === '.' || normalizedPath === '..' || normalizedPath.startsWith('../') ||
    !MARKDOWN_EXTENSIONS[extname(normalizedPath).toLowerCase()]
  ) {
    invalid(host, 'path must be a safe relative .md, .markdown or .mdx location.')
  }
  if (typeof params.text !== 'string') invalid(host, 'text must be a string.')
  return { action: 'render', leaseId, worktree: params.worktree, path: normalizedPath, text: params.text }
}

function validateCanonicalSourcePath(host: EditorServices, root: string, absolute: string): void {
  const path = relative(root, absolute)
  if (path === '' || path === '.' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    invalid(host, 'Markdown source path does not resolve to a worktree child.')
  }
  const normalized = path.split(sep).join('/')
  if (!MARKDOWN_EXTENSIONS[extname(normalized).toLowerCase()]) {
    invalid(host, 'Markdown source path must resolve to a .md, .markdown or .mdx file.')
  }
  if (existsSync(absolute) && !statSync(absolute).isFile()) {
    invalid(host, 'Markdown source location must be a regular file or an authorized missing location.')
  }
}

export function createDetachedMarkdownPreviewService(host: EditorServices): DetachedMarkdownPreviewService {
  const leases = new Map<string, Lease>()
  let disposed = false

  function isCurrent(leaseId: string, lease: Lease): boolean {
    return lease.active && !disposed && leases.get(leaseId) === lease
  }

  function revoke(leaseId: string, lease: Lease): void {
    lease.active = false
    if (leases.get(leaseId) === lease) leases.delete(leaseId)
    releaseMarkdownImages(lease.resources)
  }
  async function render(request: RenderRequest, caller: PluginCaller, lease: Lease): Promise<MarkdownPreviewResult> {
    const isActive = () => isCurrent(request.leaseId, lease)
    try {
      try {
        assertPreviewBounds(request.text)
      } catch (error) {
        invalid(host, error instanceof Error ? error.message : String(error))
      }
      const worktree = await host.resolve(request.worktree, caller)
      if (!isActive()) conflict(host, 'Markdown preview render was cancelled.')
      const absolutePath = await host.path(worktree.id, request.path, { create: true })
      if (!isActive()) conflict(host, 'Markdown preview render was cancelled.')
      validateCanonicalSourcePath(host, worktree.path, absolutePath)
      const imageUrls = await resolveMarkdownImages(host, {
        id: request.leaseId,
        worktreeId: worktree.id,
        relativePath: request.path
      }, request.text, lease.resources, {
        isActive,
        maxImages: MARKDOWN_MAX_PREVIEW_IMAGES,
        imageLimitError: () => host.context.error('invalid-params', `Markdown previews are limited to ${MARKDOWN_MAX_PREVIEW_IMAGES} local images per render.`)
      })
      if (!isActive()) conflict(host, 'Markdown preview render was cancelled.')
      let html: string
      try {
        html = await renderSafeMarkdownHtml(request.text, { imageUrls })
      } catch (error) {
        if (!isActive()) conflict(host, 'Markdown preview render was cancelled.')
        invalid(host, error instanceof Error ? error.message : String(error))
      }
      if (!isActive()) conflict(host, 'Markdown preview render was cancelled.')
      return { leaseId: request.leaseId, html, worktreeId: worktree.id, path: request.path }
    } catch (error) {
      const active = isActive()
      revoke(request.leaseId, lease)
      if (!active) conflict(host, 'Markdown preview render was cancelled.')
      throw error
    }
  }

  async function method(rawParams: Record<string, unknown>, caller: PluginCaller): Promise<MarkdownPreviewResult> {
    const request = parseRequest(host, rawParams)
    if (request.action === 'release') {
      const lease = leases.get(request.leaseId)
      if (!lease) return { leaseId: request.leaseId, released: false }
      revoke(request.leaseId, lease)
      return { leaseId: request.leaseId, released: true }
    }
    if (disposed) conflict(host, 'Markdown preview service is disposed.')
    if (leases.has(request.leaseId)) conflict(host, 'Markdown preview leaseId is already active.')
    if (leases.size >= MAX_ACTIVE_PREVIEW_LEASES) conflict(host, 'Markdown preview lease capacity is full.')
    const resources: MarkdownResourcePool = new Map([[request.leaseId, new Map()]])
    const lease: Lease = { active: true, resources }
    leases.set(request.leaseId, lease)
    return render(request, caller, lease)
  }

  return {
    method,
    dispose() {
      disposed = true
      for (const [leaseId, lease] of leases) revoke(leaseId, lease)
    }
  }
}
