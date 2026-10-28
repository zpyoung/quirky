import { constants, existsSync, fstatSync, lstatSync, openSync, readSync, closeSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { dirname, extname, join, normalize, posix, relative, sep } from 'node:path'
import type { EditorBuffer, EditorServices } from '../types'
import {
  MARKDOWN_MAX_DOCUMENTS,
  MARKDOWN_MAX_DOCUMENTS_BYTES,
  MARKDOWN_MAX_PATH_BYTES,
  MARKDOWN_MAX_TEMPLATE_BYTES,
  MARKDOWN_MAX_TEMPLATE_DEPTH,
  MARKDOWN_MAX_TEMPLATES,
  utf8Bytes
} from './source'

export type MarkdownDocument = { relativePath: string; name: string; title: string }
export type MarkdownTemplate = { relativePath: string; name: string; title: string }
export type ImageResource = { url: string; revoke(): void }
export type MarkdownResourcePool = Map<string, Map<string, ImageResource>>
export type MarkdownImageSource = Pick<EditorBuffer, 'id' | 'relativePath' | 'worktreeId'>
export type MarkdownImageResolveOptions = {
  isActive?: () => boolean
  maxImages?: number
  imageLimitError?: () => Error
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon'
}
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules'])
const MAX_DISCOVERY_ENTRIES = 100_000
const MAX_TEMPLATE_ENTRIES = 10_000
export const MARKDOWN_MAX_PREVIEW_IMAGES = 64
const MAX_LOCAL_PREVIEW_BUFFERS = 64

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function safePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && path !== '..' && !path.startsWith('../') && !path.includes('\0')
}

function readBoundedText(path: string, limit: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size > limit) throw new Error(`File exceeds the ${limit} byte limit.`)
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, length)
      if (read === 0) break
      length += read
    }
    const after = fstatSync(descriptor)
    if (length > limit || after.size > limit) throw new Error(`File exceeds the ${limit} byte limit.`)
    return bytes.subarray(0, length).toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export async function listMarkdownDocuments(
  host: EditorServices,
  worktreeId: string,
  root: string
): Promise<{ documents: MarkdownDocument[]; total: number; truncated: boolean }> {
  const pending = [root]
  const documents: MarkdownDocument[] = []
  let metadataBytes = 0
  let visited = 0
  let visitedEntries = 0
  let truncated = false
  while (pending.length > 0 && documents.length < MARKDOWN_MAX_DOCUMENTS && visitedEntries < MAX_DISCOVERY_ENTRIES) {
    const directory = pending.pop()!
    let entries
    try {
      entries = await opendir(directory)
    } catch {
      continue
    }
    try {
      for await (const entry of entries) {
        visitedEntries += 1
        if (visitedEntries >= MAX_DISCOVERY_ENTRIES) {
          truncated = true
          pending.length = 0
          break
        }
        if (entry.isSymbolicLink()) continue
        const absolute = join(directory, entry.name)
        const relativePath = relativePosix(root, absolute)
        if (!safePath(relativePath) || utf8Bytes(relativePath) > MARKDOWN_MAX_PATH_BYTES) {
          truncated = true
          continue
        }
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) pending.push(absolute)
          continue
        }
        if (!entry.isFile() || !MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        visited += 1
        metadataBytes += utf8Bytes(relativePath) + utf8Bytes(entry.name)
        if (metadataBytes > MARKDOWN_MAX_DOCUMENTS_BYTES) {
          truncated = true
          pending.length = 0
          break
        }
        try {
          await host.path(worktreeId, relativePath)
        } catch {
          truncated = true
          continue
        }
        documents.push({ relativePath, name: entry.name, title: entry.name.replace(/\.(?:md|markdown|mdx)$/i, '') })
        if (documents.length === MARKDOWN_MAX_DOCUMENTS) {
          truncated = true
          pending.length = 0
          break
        }
      }
    } catch {
      truncated = true
    }
  }
  if (pending.length > 0 || visited >= MARKDOWN_MAX_DOCUMENTS || visitedEntries >= MAX_DISCOVERY_ENTRIES) truncated = true
  documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { documents, total: documents.length, truncated }
}

export async function listMarkdownTemplates(
  host: EditorServices,
  worktreeId: string,
  root: string
): Promise<{ templates: MarkdownTemplate[]; truncated: boolean }> {
  const templateRoot = await host.path(worktreeId, '.orca/templates').catch(() => null)
  if (!templateRoot || !existsSync(templateRoot)) return { templates: [], truncated: false }
  try {
    if (!lstatSync(templateRoot).isDirectory()) return { templates: [], truncated: true }
  } catch {
    return { templates: [], truncated: false }
  }
  const pending: Array<{ path: string; depth: number }> = [{ path: templateRoot, depth: 0 }]
  const templates: MarkdownTemplate[] = []
  let visitedEntries = 0
  let truncated = false
  while (pending.length > 0 && templates.length < MARKDOWN_MAX_TEMPLATES && visitedEntries < MAX_TEMPLATE_ENTRIES) {
    const item = pending.pop()!
    let entries
    try {
      entries = await opendir(item.path)
    } catch {
      continue
    }
    try {
      for await (const entry of entries) {
        visitedEntries += 1
        if (visitedEntries >= MAX_TEMPLATE_ENTRIES) {
          truncated = true
          pending.length = 0
          break
        }
        if (entry.isSymbolicLink()) continue
        const absolute = join(item.path, entry.name)
        if (entry.isDirectory()) {
          if (item.depth < MARKDOWN_MAX_TEMPLATE_DEPTH) pending.push({ path: absolute, depth: item.depth + 1 })
          else truncated = true
          continue
        }
        if (!entry.isFile() || !MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        const relativePath = relativePosix(root, absolute)
        if (!safePath(relativePath) || utf8Bytes(relativePath) > MARKDOWN_MAX_PATH_BYTES) {
          truncated = true
          continue
        }
        try {
          await host.path(worktreeId, relativePath)
          const content = readBoundedText(absolute, MARKDOWN_MAX_TEMPLATE_BYTES)
          const title = content.split(/\r?\n/, 1)[0]?.replace(/^\s*#\s*/, '').trim() || entry.name
          templates.push({ relativePath, name: entry.name, title })
        } catch {
          truncated = true
        }
        if (templates.length === MARKDOWN_MAX_TEMPLATES) {
          truncated = true
          break
        }
      }
    } catch {
      truncated = true
    }
  }
  if (pending.length > 0 || visitedEntries >= MAX_TEMPLATE_ENTRIES) truncated = true
  templates.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { templates, truncated }
}

export async function readMarkdownTemplate(host: EditorServices, worktreeId: string, root: string, templatePath: string): Promise<string> {
  if (!safePath(templatePath) || !templatePath.startsWith('.orca/templates/')) {
    throw host.context.error('invalid-params', 'Template must be inside .orca/templates.')
  }
  const templates = await listMarkdownTemplates(host, worktreeId, root)
  if (!templates.templates.some((item) => item.relativePath === templatePath)) {
    throw host.context.error('not-found', `No Markdown template named ${templatePath} exists.`)
  }
  const absolute = await host.path(worktreeId, templatePath)
  return readBoundedText(absolute, MARKDOWN_MAX_TEMPLATE_BYTES)
}

export function fillMarkdownTemplate(template: string, values: { title: string; filename: string; now?: Date }): string {
  const now = values.now ?? new Date()
  const pad = (part: number) => String(part).padStart(2, '0')
  const replacements: Record<string, string> = {
    title: values.title,
    filename: values.filename,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    datetime: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  }
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g, (placeholder, key: string) => replacements[key] ?? placeholder)
}

function decodedLocalImageTarget(target: string): string | null {
  const trimmed = target.trim().replace(/^<|>$/g, '')
  if (trimmed === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(trimmed)) return null
  try {
    const decoded = decodeURIComponent(trimmed)
    if (decoded === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(decoded)) return null
    return decoded
  } catch {
    return null
  }
}

export async function resolveMarkdownImages(
  host: EditorServices,
  source: MarkdownImageSource,
  markdown: string,
  resources: MarkdownResourcePool,
  options: MarkdownImageResolveOptions = {}
): Promise<ReadonlyMap<string, string>> {
  let byPath = resources.get(source.id)
  if (!byPath) {
    if (resources.size >= MAX_LOCAL_PREVIEW_BUFFERS) return new Map()
    byPath = new Map()
    resources.set(source.id, byPath)
  }
  const imageUrls = new Map<string, string>()
  const directory = dirname(source.relativePath) === '.' ? '' : dirname(source.relativePath)
  const pattern = /!\[[^\]]*\]\((<[^>\r\n]+>|(?:\\.|[^)\s])+)(?:\s+['"][^\r\n]*['"])?\)/g
  for (const match of markdown.matchAll(pattern)) {
    const raw = match[1]!.replace(/^<|>$/g, '')
    const target = decodedLocalImageTarget(raw)
    if (!target) continue
    const relativePath = normalize(posix.join(directory, target)).replace(/\\/g, '/')
    if (!safePath(relativePath)) continue
    const absolute = await host.path(source.worktreeId, relativePath).catch(() => null)
    if (options.isActive && !options.isActive()) throw new Error('Detached Markdown image acquisition was cancelled.')
    if (!absolute || !isRegularFile(absolute)) continue
    const mime = IMAGE_MIME_TYPES[extname(absolute).toLowerCase()]
    if (!mime) continue
    let handle = byPath.get(absolute)
    if (!handle) {
      if (byPath.size >= (options.maxImages ?? MARKDOWN_MAX_PREVIEW_IMAGES)) {
        if (options.imageLimitError) throw options.imageLimitError()
        continue
      }
      const created = await host.context.createFileResource({ path: absolute, contentType: mime })
      if (options.isActive && !options.isActive()) {
        created.revoke()
        throw new Error('Detached Markdown image acquisition was cancelled.')
      }
      handle = created
      byPath.set(absolute, handle)
    }
    imageUrls.set(raw, handle.url)
    imageUrls.set(target, handle.url)
  }
  return imageUrls
}

export function releaseMarkdownImages(resources: MarkdownResourcePool, bufferId?: string): void {
  const targets = bufferId === undefined ? [...resources.keys()] : [bufferId]
  for (const id of targets) {
    const entries = resources.get(id)
    if (!entries) continue
    for (const resource of entries.values()) resource.revoke()
    resources.delete(id)
  }
}

export function imageMimeType(path: string): string | null {
  return IMAGE_MIME_TYPES[extname(path).toLowerCase()] ?? null
}

export function destinationDirectory(buffer: Pick<EditorBuffer, 'relativePath'>): string {
  const directory = dirname(buffer.relativePath)
  return directory === '.' ? '.' : directory
}
