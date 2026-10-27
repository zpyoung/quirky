import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'
import { InstallError } from '../types.ts'

export type JsonObject = Record<string, unknown>

export const REAL_HOME_SKIPPED = 'skipped: test run against the real home'

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The user's home as a hook installer sees it; `HOME` wins because Bun's `homedir()` ignores it. */
export function resolveHome(env: Record<string, string | undefined>): string {
  return env.HOME || homedir()
}

/** True when a test run would write the developer's real agent configs; callers skip every write. */
export function isRealHomeInTest(home: string): boolean {
  return process.env.NODE_ENV === 'test' && home === homedir()
}

/** An agent's home override when it is set to an absolute path, else the default. */
export function dirOverride(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && isAbsolute(trimmed) ? trimmed : fallback
}

/** `path` with the home prefix shown as `~`, for messages. */
export function tildePath(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Raised inside an edit when the document's shape can't hold Quirky's entries. */
export class ShapeError extends Error {}

/** The object at `path` inside `doc`, or undefined when any step is absent or not an object. */
export function objectAt(doc: JsonObject, path: string[]): JsonObject | undefined {
  let node: unknown = doc
  for (const key of path) {
    if (!isObject(node)) return undefined
    node = node[key]
  }
  return isObject(node) ? node : undefined
}

/** The object at `path`, creating missing steps; throws ShapeError when a step holds a non-object. */
export function ensureObjectAt(doc: JsonObject, path: string[]): JsonObject {
  let node = doc
  for (const key of path) {
    const next = node[key]
    if (next === undefined) {
      const created: JsonObject = {}
      node[key] = created
      node = created
    } else if (isObject(next)) {
      node = next
    } else {
      throw new ShapeError(key)
    }
  }
  return node
}

/** Deletes empty objects along `path`, deepest first, stopping at the first one still holding keys. */
export function pruneEmptyAt(doc: JsonObject, path: string[]): void {
  for (let depth = path.length; depth > 0; depth--) {
    const parent = objectAt(doc, path.slice(0, depth - 1))
    const node = objectAt(doc, path.slice(0, depth))
    if (!parent || !node || Object.keys(node).length > 0) return
    delete parent[path[depth - 1]!]
  }
}

export type JsonRead = { doc: JsonObject; text: string | null }

/** Reads a JSON object file; a missing or blank file is `{}`. Throws InstallError and leaves the file alone when it can't be read as an object. */
export function readJsonFile(path: string, home: string): JsonRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { doc: {}, text: null }
    throw new InstallError(`Could not read ${tildePath(path, home)}`)
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body.trim() === '') return { doc: {}, text }
  try {
    const parsed: unknown = JSON.parse(body)
    if (isObject(parsed)) return { doc: parsed, text }
  } catch {}
  throw new InstallError(`Could not parse ${tildePath(path, home)}`)
}

/** Writes `text` via a temp file in the same directory and a rename, creating parent directories 0700. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, text, { mode })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function serializeJson(doc: JsonObject): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export type EditOptions = {
  /** A remove on a file that doesn't exist is a no-op. */
  createIfMissing: boolean
  /** True when the edited document holds nothing but what Quirky wrote, so the file is deleted; defaults to no keys left. */
  isEmpty?: (doc: JsonObject) => boolean
}

/**
 * Applies `edit` to a JSON file and reports whether it changed. A change is a different document, not
 * different bytes, so a rerun never rewrites a file the user formatted their own way.
 * Throws InstallError, with the file untouched, when the file can't be parsed or `edit` rejects its shape.
 */
export function editJsonFile(path: string, home: string, edit: (doc: JsonObject) => void, options: EditOptions): boolean {
  const { doc, text } = readJsonFile(path, home)
  if (text === null && !options.createIfMissing) return false
  const next = structuredClone(doc)
  try {
    edit(next)
  } catch (error) {
    if (error instanceof ShapeError) throw new InstallError(`Could not parse ${tildePath(path, home)}`)
    throw error
  }
  if (JSON.stringify(next) === JSON.stringify(doc)) return false
  if (text !== null && (options.isEmpty?.(next) ?? Object.keys(next).length === 0)) {
    rmSync(path, { force: true })
    return true
  }
  writeFileAtomic(path, serializeJson(next))
  return true
}
