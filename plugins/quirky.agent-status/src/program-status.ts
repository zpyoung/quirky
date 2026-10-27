import type { AgentState, Outcome } from './types'

/**
 * OSC 7501 (Program Status Protocol, rev 0.4): a program reports idle/working/blocked/done/error
 * for itself (the root record) or for ids beneath it. This module is the wire grammar, the record
 * set and the projection onto agent state; scanning bytes out of the PTY stream lives elsewhere.
 */

const STATES = ['idle', 'working', 'done', 'blocked', 'error'] as const
export type ProgramState = (typeof STATES)[number]

const KINDS = ['permission', 'question', 'auth'] as const
export type ProgramKind = (typeof KINDS)[number]

/** The only bytes the host ever writes back; explicit lists tell a program what it accepts. */
export const PROGRAM_STATUS_REPLY = `\x1b]7501;?:states=${STATES.join(',')}:kinds=${KINDS.join(',')}\x1b\\`

/** Whole sequence cap, OSC through ST. */
export const PROGRAM_STATUS_MAX_SEQUENCE_BYTES = 4096
export const PROGRAM_STATUS_MAX_RECORDS = 256

const MAX_KEY_BYTES = 16
const MAX_MSG_ENCODED = 2732
const MAX_MSG_DECODED = 2048
const MAX_TITLE_ENCODED = 256
const MAX_TITLE_DECODED = 192
const MAX_ID_LENGTH = 128
const MAX_ID_DEPTH = 8
const MAX_APP_BYTES = 32

export type ProgramStatusReport = {
  /** Null addresses the root record. */
  id: string | null
  state: ProgramState | 'clear'
  kind?: ProgramKind
  progress?: number
  app?: string
  title?: string
  msg?: string
}

export type ProgramStatusMessage = { type: 'query' } | { type: 'report'; report: ProgramStatusReport }

const KEY_RE = /^[a-z]+$/
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/
const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/
const APP_RE = /^[A-Za-z0-9_.+-]+$/
const PROGRESS_RE = /^\d{1,3}$/
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
// the spec refuses decoded C0, DEL and C1 controls
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const isState = (value: unknown): value is ProgramState => STATES.some((state) => state === value)
const isKind = (value: unknown): value is ProgramKind => KINDS.some((kind) => kind === value)

function isValidId(id: string): boolean {
  if (id.length > MAX_ID_LENGTH) return false
  const segments = id.split('/')
  return segments.length <= MAX_ID_DEPTH && segments.every((segment) => SEGMENT_RE.test(segment))
}

/** Decoded single-line text, or null when the report must be discarded whole. */
function decodeText(encoded: string, maxEncoded: number, maxDecoded: number): string | null {
  // the encoded cap goes first: it bounds the work a hostile program can cause
  if (encoded.length > maxEncoded || !BASE64_RE.test(encoded)) return null
  const unpadded = encoded.replace(/=+$/, '')
  if (unpadded.length % 4 === 1) return null
  let binary: string
  try {
    binary = atob(unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4))
  } catch {
    return null
  }
  if (binary.length > maxDecoded) return null
  let text: string
  try {
    text = utf8Decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
  return CONTROL_RE.test(text) ? null : text
}

/**
 * Parses the body between `OSC 7501;` and ST: a probe (`?`), a report, or null when the whole
 * sequence is to be ignored (no valid state, bad id, bad or oversized text, over a limit).
 */
export function parseProgramStatusBody(body: string): ProgramStatusMessage | null {
  if (body.length > PROGRAM_STATUS_MAX_SEQUENCE_BYTES) return null
  if (body.trim() === '?') return { type: 'query' }

  const pairs = new Map<string, string>()
  const texts: { msg?: string; title?: string } = {}
  for (const pair of body.split(':')) {
    const equals = pair.indexOf('=')
    if (equals === -1) continue
    const key = pair.slice(0, equals).trim()
    const value = pair.slice(equals + 1).trim()
    // a hard cap broken in any occurrence voids the report, even if a duplicate follows
    if (key.length > MAX_KEY_BYTES || (key === 'app' && value.length > MAX_APP_BYTES) || (key === 'id' && !isValidId(value))) {
      return null
    }
    if (!KEY_RE.test(key) || !VALUE_RE.test(value)) continue
    if (key === 'msg' || key === 'title') {
      const [maxEncoded, maxDecoded] = key === 'msg' ? [MAX_MSG_ENCODED, MAX_MSG_DECODED] : [MAX_TITLE_ENCODED, MAX_TITLE_DECODED]
      const text = decodeText(value, maxEncoded, maxDecoded)
      // every occurrence is checked so a later duplicate can't launder an over-limit one
      if (text === null) return null
      texts[key] = text
      continue
    }
    pairs.set(key, value)
  }

  const state = pairs.get('state')
  if (state === undefined || (state !== 'clear' && !isState(state))) return null

  const report: ProgramStatusReport = { id: pairs.get('id') ?? null, state }
  const kind = pairs.get('kind')
  if (state === 'blocked' && kind !== undefined && isKind(kind)) report.kind = kind
  const progress = pairs.get('progress')
  if ((state === 'working' || state === 'blocked') && progress && PROGRESS_RE.test(progress)) {
    const value = Number.parseInt(progress, 10)
    if (value <= 100) report.progress = value
  }
  const app = pairs.get('app')
  if (app !== undefined && APP_RE.test(app)) report.app = app
  if (texts.msg) report.msg = texts.msg
  if (texts.title) report.title = texts.title
  return { type: 'report', report }
}

export type ProgramStatusRecord = {
  id: string | null
  state: ProgramState
  kind?: ProgramKind
  progress?: number
  app?: string
  title?: string
  msg?: string
}

const ROOT_KEY = ''

const isAtOrBeneath = (id: string, ancestor: string) => id === ancestor || id.startsWith(`${ancestor}/`)

/** One session's OSC 7501 records: each report replaces its record whole. Mutators return whether anything changed. */
export class ProgramStatusRecords {
  // insertion order doubles as least-recently-updated order: every write re-inserts its key
  private readonly records = new Map<string, ProgramStatusRecord>()

  get size(): number {
    return this.records.size
  }

  apply(report: ProgramStatusReport): boolean {
    const key = report.id ?? ROOT_KEY
    if (report.state === 'clear') {
      if (report.id === null) return this.reset()
      let changed = false
      for (const existing of [...this.records.keys()]) {
        if (existing !== ROOT_KEY && isAtOrBeneath(existing, key)) {
          this.records.delete(existing)
          changed = true
        }
      }
      return changed
    }
    this.records.delete(key)
    if (this.records.size >= PROGRAM_STATUS_MAX_RECORDS) {
      const oldest = this.records.keys().next().value
      if (oldest !== undefined) this.records.delete(oldest)
    }
    const { state, kind, progress, app, title, msg } = report
    this.records.set(key, {
      id: report.id,
      state,
      ...(kind !== undefined ? { kind } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(app !== undefined ? { app } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(msg !== undefined ? { msg } : {}),
    })
    return true
  }

  /** The program ended (shell prompt mark): live records go, done and error ones stay for display. */
  endProgram(): boolean {
    let changed = false
    for (const [key, record] of [...this.records]) {
      if (record.state !== 'done' && record.state !== 'error') {
        this.records.delete(key)
        changed = true
      }
    }
    return changed
  }

  /** A root `clear` or terminal reset: every record goes. */
  reset(): boolean {
    const changed = this.records.size > 0
    this.records.clear()
    return changed
  }

  root(): ProgramStatusRecord | undefined {
    return this.records.get(ROOT_KEY)
  }
}

export type RootProjection = { state: AgentState; outcome?: Outcome; sessionBoundary?: boolean }

/**
 * The root record as an agent state, or null when the program has no root record.
 * Permission and question blocks are `waiting` (a human must answer); auth and unnamed blocks stay
 * `blocked`. Idle proves only that the program is at rest, so it is a boundary, not a verdict.
 */
export function projectRoot(root: ProgramStatusRecord | undefined): RootProjection | null {
  if (!root) return null
  switch (root.state) {
    case 'working':
      return { state: 'working' }
    case 'blocked':
      return { state: root.kind === 'permission' || root.kind === 'question' ? 'waiting' : 'blocked' }
    case 'done':
      return { state: 'done', outcome: 'success' }
    case 'error':
      return { state: 'done', outcome: 'failure' }
    case 'idle':
      return { state: 'done', sessionBoundary: true }
  }
}
