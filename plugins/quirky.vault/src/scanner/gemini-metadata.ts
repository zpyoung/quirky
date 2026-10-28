import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isRecord, readJsonObject, readJsonl, string } from './parsers/shared'

const MAX_PROJECT_ROOT_BYTES = 4096

type GeminiTranscriptMetadata = { cwd: string | null; projectHash: string | null }
export type GeminiRegistryProject = { root: string; slug: string; projectHash: string }

export function absoluteGeminiCwd(value: unknown): string | null {
  const path = string(value)
  if (!path || !isAbsolute(path) || path.includes('\0')) return null
  return resolve(path)
}

export function geminiChatProject(sourceRoot: string, filePath: string): { slug: string; markerPath: string } | null {
  const relativePath = relative(resolve(sourceRoot), resolve(filePath))
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null
  const parts = relativePath.split(sep)
  if (parts.length < 3 || !parts[0] || parts[1] !== 'chats') return null
  const extension = extname(parts.at(-1)!).toLowerCase()
  if (extension !== '.json' && extension !== '.jsonl') return null
  return { slug: parts[0], markerPath: join(sourceRoot, parts[0], '.project_root') }
}

export async function readGeminiTranscriptMetadata(filePath: string, signal?: AbortSignal): Promise<GeminiTranscriptMetadata> {
  try {
    const extension = extname(filePath).toLowerCase()
    let record: Record<string, unknown> | null = null
    if (extension === '.json') {
      record = await readJsonObject(filePath)
    } else if (extension === '.jsonl') {
      for await (const item of readJsonl(filePath, signal)) {
        record = item
        break
      }
    }
    return {
      cwd: absoluteGeminiCwd(record?.cwd),
      projectHash: string(record?.projectHash)
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    return { cwd: null, projectHash: null }
  }
}

export async function readGeminiProjectRoot(markerPath: string): Promise<string | null> {
  let handle: FileHandle | null = null
  try {
    handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_PROJECT_ROOT_BYTES) return null

    const bytes = Buffer.alloc(MAX_PROJECT_ROOT_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > MAX_PROJECT_ROOT_BYTES) return null
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim()
    return absoluteGeminiCwd(value)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function readGeminiProjectRegistry(registryPath: string): Promise<GeminiRegistryProject[]> {
  try {
    const registry = await readJsonObject(registryPath)
    const registryProjects = registry?.projects
    if (!isRecord(registryProjects)) return []

    const projects: GeminiRegistryProject[] = []
    for (const [rawRoot, rawSlug] of Object.entries(registryProjects)) {
      const rootValue = string(rawRoot)
      const root = absoluteGeminiCwd(rootValue)
      const slug = string(rawSlug)
      if (!rootValue || !root || !slug) continue
      projects.push({
        root,
        slug,
        projectHash: createHash('sha256').update(rootValue).digest('hex')
      })
    }
    return projects
  } catch {
    return []
  }
}

export function resolveGeminiCwd(
  explicitCwd: unknown,
  projectRoot: unknown,
  temporarySlug: string,
  transcriptProjectHash: unknown,
  registry: readonly GeminiRegistryProject[]
): string | null {
  const explicit = absoluteGeminiCwd(explicitCwd)
  if (explicit) return explicit
  const marker = absoluteGeminiCwd(projectRoot)
  if (marker) return marker

  const transcriptHashValue = string(transcriptProjectHash)
  const transcriptHash = transcriptHashValue && /^[\da-f]{64}$/i.test(transcriptHashValue)
    ? transcriptHashValue.toLowerCase()
    : null
  const temporaryHash = /^[\da-f]{64}$/i.test(temporarySlug) ? temporarySlug.toLowerCase() : null
  const matches = new Set<string>()
  for (const project of registry) {
    if (
      project.slug === temporarySlug ||
      (temporaryHash !== null && project.projectHash === temporaryHash) ||
      (transcriptHash !== null && project.projectHash === transcriptHash)
    ) {
      matches.add(project.root)
    }
  }
  return matches.size === 1 ? matches.values().next().value ?? null : null
}
