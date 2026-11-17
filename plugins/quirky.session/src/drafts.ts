import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginErrorKind, PluginEvent, PluginStore, QuirkyEvent } from '@quirky/protocol'

/** The unsent composer state kept per session so it survives a restart. */
export type Draft = {
  text: string
  images: string[]
  pastes: { id: string; text: string }[]
  picks: { model: string | null; effort: string | null; mode: string | null; plan: boolean }
}

export const MAX_DRAFT_BYTES = 64 * 1024
export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024

const IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
} as const

type ImageMime = keyof typeof IMAGE_EXTENSIONS

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/** True when `value` is exactly a `Draft`: no missing, extra or wrongly typed fields. */
export function isDraft(value: unknown): value is Draft {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false
  const { text, images, pastes, picks } = value
  if (typeof text !== 'string' || !isStringArray(images) || !Array.isArray(pastes)) return false
  if (!pastes.every((paste) => isRecord(paste) && Object.keys(paste).length === 2 &&
    typeof paste.id === 'string' && typeof paste.text === 'string')) return false
  return isRecord(picks) && Object.keys(picks).length === 4 &&
    isStringOrNull(picks.model) && isStringOrNull(picks.effort) && isStringOrNull(picks.mode) &&
    typeof picks.plan === 'boolean'
}

/** Session ids become directory names, so only plain single path segments qualify. */
const isSafeSegment = (id: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)

/** Per-session composer drafts and pasted-image files owned by the session plugin. */
export class ComposerDrafts {
  constructor(
    private readonly store: PluginStore,
    private readonly dataDir: string,
    private readonly sessionExists: (session: string) => boolean,
    private readonly fail: (kind: PluginErrorKind, message: string) => Error
  ) {}

  draft = (params: Record<string, unknown>): Draft | null => {
    const row = this.store.get<{ draft: string }>(
      'SELECT draft FROM composer_drafts WHERE session_id = ?',
      this.sessionOf(params)
    )
    return row ? (JSON.parse(row.draft) as Draft) : null
  }

  saveDraft = (params: Record<string, unknown>): { ok: true } => {
    const session = this.sessionOf(params)
    const { draft } = params
    if (!isDraft(draft)) throw this.fail('invalid-params', 'draft must have text, images, pastes and picks of the right types')
    const json = JSON.stringify(draft)
    if (Buffer.byteLength(json) > MAX_DRAFT_BYTES) throw this.fail('invalid-params', 'draft is over 64 KiB')
    this.store.run(
      `INSERT INTO composer_drafts (session_id, draft, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET draft = excluded.draft, updated_at = excluded.updated_at`,
      session,
      json,
      new Date().toISOString()
    )
    return { ok: true }
  }

  clearDraft = (params: Record<string, unknown>): { ok: true } => {
    this.store.run('DELETE FROM composer_drafts WHERE session_id = ?', this.sessionOf(params))
    return { ok: true }
  }

  pasteImage = (params: Record<string, unknown>): { path: string } => {
    const session = this.sessionOf(params)
    const { mime, data } = params
    if (typeof mime !== 'string' || !Object.hasOwn(IMAGE_EXTENSIONS, mime)) {
      throw this.fail('invalid-params', 'mime must be image/png, image/jpeg, image/gif or image/webp')
    }
    if (typeof data !== 'string') throw this.fail('invalid-params', 'data must be a base64 string')
    if (!this.sessionExists(session) || !isSafeSegment(session)) throw this.fail('not-found', `no session ${session}`)
    // checked before decoding so an oversize payload is never allocated
    if (data.length > Math.ceil((MAX_PASTED_IMAGE_BYTES * 4) / 3) + 4) throw this.fail('invalid-params', 'image is over 20 MB')
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw this.fail('invalid-params', 'data is not valid base64')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > MAX_PASTED_IMAGE_BYTES) throw this.fail('invalid-params', 'image is over 20 MB')
    const dir = join(this.dataDir, 'pasted', session)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${randomUUID()}.${IMAGE_EXTENSIONS[mime as ImageMime]}`)
    writeFileSync(path, bytes)
    return { path }
  }

  /** Deletes a removed session's draft row and pasted images. */
  remove(session: string): void {
    this.store.run('DELETE FROM composer_drafts WHERE session_id = ?', session)
    if (isSafeSegment(session)) rmSync(join(this.dataDir, 'pasted', session), { recursive: true, force: true })
  }

  /** Listener for the daemon event stream; reacts only to this plugin's own `removed` event. */
  onEvent = (event: QuirkyEvent, pluginId = 'quirky.session'): void => {
    if (event.type !== `${pluginId}/removed`) return
    const { sessionId } = (event as PluginEvent).data as { sessionId?: unknown }
    if (typeof sessionId === 'string') this.remove(sessionId)
  }

  private sessionOf(params: Record<string, unknown>): string {
    if (typeof params.session !== 'string' || params.session === '') {
      throw this.fail('invalid-params', 'session must be a non-empty string')
    }
    return params.session
  }
}
