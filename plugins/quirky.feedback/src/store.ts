import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { FEEDBACK_FULL, MAX_COMMENT_LENGTH, MAX_COMMENTS, type Capture, type CaptureKind, type Comment, type CommentIntent } from './contract'

const COMMENTS_FILE = 'comments.json'
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_CAPTURE_BYTES = 64 * 1024
const CAPTURE_KINDS: readonly CaptureKind[] = ['element', 'terminal-pane', 'browser-pane']
const INTENTS: readonly CommentIntent[] = ['change', 'question']

type Params = Record<string, unknown>
type ErrorFactory = PluginContext['error']

/** Raised internally for a file that exists but cannot be trusted; the store sets it aside. */
class CorruptFile extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isIntent(value: unknown): value is CommentIntent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value)
}

function trimmedComment(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length >= 1 && text.length <= MAX_COMMENT_LENGTH ? text : null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNullable<T>(value: unknown, check: (value: unknown) => value is T): boolean {
  return value === null || check(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  const entries = record(value)
  return entries !== null && Object.values(entries).every(isString)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isRect(value: unknown): boolean {
  const rect = record(value)
  return rect !== null && ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
}

function isBuild(value: unknown): boolean {
  const build = record(value)
  return build !== null && isString(build.version) && isString(build.commit) && isString(build.channel)
}

function isCapture(value: unknown): value is Capture {
  const capture = record(value)
  if (!capture) return false
  if (!isString(capture.kind) || !(CAPTURE_KINDS as readonly string[]).includes(capture.kind)) return false
  if (!isString(capture.owner) || !isString(capture.elementPath) || !isString(capture.selector)) return false
  if (!(['role', 'accessibleName', 'visibleText', 'component', 'source', 'sourceCaller'] as const).every((key) => isNullable(capture[key], isString))) return false
  if (!isNullable(capture.nearbyText, isStringArray) || !isNullable(capture.attributes, isStringRecord)) return false
  if (!isRect(capture.rect) || !isStringRecord(capture.computedStyles) || !isBuild(capture.build)) return false
  try {
    return Buffer.byteLength(JSON.stringify(capture), 'utf8') <= MAX_CAPTURE_BYTES
  } catch {
    return false
  }
}

function isStoredComment(value: unknown): value is Comment {
  const entry = record(value)
  return (
    entry !== null &&
    typeof entry.id === 'string' &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt) &&
    isIntent(entry.intent) &&
    trimmedComment(entry.comment) !== null &&
    isCapture(entry.capture)
  )
}

function readFile(path: string): string | null {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new CorruptFile('unusable comments file')
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new CorruptFile('comments file is a symlink')
    throw error
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new CorruptFile('unusable comments file')
    const buffer = Buffer.alloc(opened.size)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function parseComments(text: string): Comment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CorruptFile('comments file is not valid JSON')
  }
  const root = record(parsed)
  if (!root || root.version !== 1 || !Array.isArray(root.comments)) throw new CorruptFile('comments file has an unexpected shape')
  if (!root.comments.every(isStoredComment)) throw new CorruptFile('comments file has an invalid entry')
  return root.comments
}

function writeAtomically(path: string, data: unknown): void {
  const directory = join(path, '..')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temp = join(directory, `.${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  let open = true
  try {
    writeFileSync(fd, JSON.stringify(data), 'utf8')
    fsyncSync(fd)
    open = false
    closeSync(fd)
    renameSync(temp, path)
    chmodSync(path, 0o600)
  } catch (error) {
    if (open) try { closeSync(fd) } catch { /* the original failure is the one to report */ }
    try { unlinkSync(temp) } catch { /* temporary entry may already be gone */ }
    throw error
  }
}

/**
 * Holds the feedback tray and persists every mutation to `<dataDir>/comments.json`.
 *
 * The file loads on the first call. A mutation writes the whole file first and only then
 * changes memory, so a failed write rejects and leaves the tray as it was. A file that cannot
 * be trusted is renamed aside and never overwritten; if that rename fails every call rejects.
 */
export class FeedbackStore {
  private comments: Comment[] | null = null
  private recovered = false

  constructor(private readonly context: Pick<PluginContext, 'dataDir' | 'error'>) {}

  private get path(): string {
    return join(this.context.dataDir, COMMENTS_FILE)
  }

  private fail(kind: Parameters<ErrorFactory>[0], message: string): Error {
    return this.context.error(kind, message)
  }

  private load(): Comment[] {
    if (this.comments) return this.comments
    try {
      const text = readFile(this.path)
      this.comments = text === null ? [] : parseComments(text)
    } catch (error) {
      if (!(error instanceof CorruptFile)) throw error
      renameSync(this.path, join(this.context.dataDir, `comments.corrupt-${Date.now()}.json`))
      this.comments = []
      this.recovered = true
    }
    return this.comments
  }

  private persist(next: Comment[]): Comment[] {
    writeAtomically(this.path, { version: 1, comments: next })
    this.comments = next
    return next
  }

  private text(value: unknown): string {
    const text = trimmedComment(value)
    if (text === null) throw this.fail('invalid-params', `comment must be a string of 1 to ${MAX_COMMENT_LENGTH} characters`)
    return text
  }

  private intent(value: unknown): CommentIntent {
    if (!isIntent(value)) throw this.fail('invalid-params', 'intent must be "change" or "question"')
    return value
  }

  private id(params: Params): string {
    if (typeof params.id !== 'string' || params.id === '') throw this.fail('invalid-params', 'id must be a non-empty string')
    return params.id
  }

  /** Returns the comments in insertion order and whether a corrupt file was set aside. */
  list(): { comments: Comment[]; recovered: boolean } {
    return { comments: [...this.load()], recovered: this.recovered }
  }

  /**
   * Appends a comment with a daemon-assigned `id` and `createdAt`.
   * Rejects with `invalid-params` for bad input and with a `conflict` starting `feedback_full`
   * when the tray already holds the maximum.
   */
  add(params: Params): Comment {
    const intent = this.intent(params.intent)
    const comment = this.text(params.comment)
    if (!isCapture(params.capture)) throw this.fail('invalid-params', 'capture is malformed or larger than 64 KiB')
    const current = this.load()
    if (current.length >= MAX_COMMENTS) {
      throw this.fail('conflict', `${FEEDBACK_FULL}: the tray holds ${MAX_COMMENTS} comments; remove one before adding another`)
    }
    const added: Comment = { id: randomUUID(), createdAt: Date.now(), intent, comment, capture: params.capture }
    this.persist([...current, added])
    return added
  }

  /** Changes the text and/or intent of one comment. Captured context, `id` and `createdAt` never change. */
  update(params: Params): Comment {
    const id = this.id(params)
    if (params.comment === undefined && params.intent === undefined) {
      throw this.fail('invalid-params', 'update needs a comment or an intent')
    }
    const comment = params.comment === undefined ? undefined : this.text(params.comment)
    const intent = params.intent === undefined ? undefined : this.intent(params.intent)
    const current = this.load()
    const index = current.findIndex((entry) => entry.id === id)
    if (index < 0) throw this.fail('not-found', `no feedback comment with id ${id}`)
    const updated: Comment = { ...current[index]!, ...(comment === undefined ? {} : { comment }), ...(intent === undefined ? {} : { intent }) }
    this.persist(current.map((entry, position) => (position === index ? updated : entry)))
    return updated
  }

  /** Removes one comment, or rejects with `not-found`. */
  remove(params: Params): { removed: true } {
    const id = this.id(params)
    const current = this.load()
    if (!current.some((entry) => entry.id === id)) throw this.fail('not-found', `no feedback comment with id ${id}`)
    this.persist(current.filter((entry) => entry.id !== id))
    return { removed: true }
  }

  /** Empties the tray and reports how many comments it held. */
  clear(): { cleared: number } {
    const current = this.load()
    this.persist([])
    return { cleared: current.length }
  }
}
