import type { GitChangeStatus, GitConflictKind, GitStatusEntry } from '@quirky/protocol'
import { discardText, type DiscardText } from '../shared/discard-text'
import type { RemoteErrorReason } from './remote-messages'

/** The folder and the file name of a repository-relative path; `dir` is '' at the root. */
export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at === -1 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

/** The seven-character commit id shown in the history. */
export const shortOid = (oid: string): string => oid.slice(0, 7)

const STATUS_LETTERS: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U'
}

/** The one-letter status of a row: M, A, D, R, C or U. */
export const statusLetter = (status: GitChangeStatus): string => STATUS_LETTERS[status]

const CONFLICT_LABELS: Readonly<Record<GitConflictKind, string>> = {
  both_modified: 'Both modified',
  both_added: 'Both added',
  both_deleted: 'Both deleted',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them'
}

export const conflictLabel = (kind: GitConflictKind): string => CONFLICT_LABELS[kind]

const MESSAGE_SCAN_LIMIT = 64 * 1024

/** Rows for the commit message box: one per line, clamped to 2 to 12; only the first 64 KiB is scanned. */
export function messageRows(text: string): number {
  let lines = 1
  const end = Math.min(text.length, MESSAGE_SCAN_LIMIT)
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) lines++
  return Math.min(12, Math.max(2, lines))
}

const UNITS: ReadonlyArray<[number, string]> = [
  [365 * 24 * 3600, 'y'],
  [30 * 24 * 3600, 'mo'],
  [7 * 24 * 3600, 'w'],
  [24 * 3600, 'd'],
  [3600, 'h'],
  [60, 'm']
]

/** "3h ago" style age of a millisecond timestamp. */
export function relativeTime(then: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  for (const [size, unit] of UNITS) if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`
  return 'just now'
}

/** The text of a thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ErrorData = { reason?: unknown; summary?: unknown; output?: unknown; failures?: unknown }

/** The `data` a daemon error carries (reason, summary, output, failures); empty when it has none. */
export function dataOf(error: unknown): ErrorData {
  const data = (error as { data?: unknown } | null)?.data
  return typeof data === 'object' && data !== null ? (data as ErrorData) : {}
}

const REASONS: ReadonlySet<string> = new Set<RemoteErrorReason>([
  'non-fast-forward',
  'stale-lease',
  'auth',
  'network',
  'no-upstream',
  'detached',
  'divergent-policy',
  'local-changes',
  'untracked-overwrite',
  'conflicts',
  'hook',
  'lint',
  'invalid-base',
  'busy',
  'failed'
])

/** The failure reason of a daemon error; anything the window does not know reads as `failed`. */
export function reasonOf(error: unknown): RemoteErrorReason {
  const reason = dataOf(error).reason
  return typeof reason === 'string' && REASONS.has(reason) ? (reason as RemoteErrorReason) : 'failed'
}

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Whether a blocked card needs a Details button: the raw output says more than the summary does. */
export function hasMoreDetail(summary: string, output: string): boolean {
  return output.length > 64 * 1024 || (fold(output) !== '' && fold(output) !== fold(summary))
}

/** Splits a confirmation sentence such as "Force push a to origin? This replaces…" into a heading and a body. */
export function splitQuestion(text: string): { title: string; body: string } {
  const at = text.indexOf('? ')
  return at === -1 ? { title: text, body: '' } : { title: text.slice(0, at + 1), body: text.slice(at + 2) }
}

/**
 * Dialog text for discarding the rows under a folder or a bulk selection: the section wording when
 * every row is untracked, else Orca's several-files wording.
 */
export function manyDiscardText(entries: readonly GitStatusEntry[]): DiscardText {
  if (entries.length > 0 && entries.every((e) => e.area === 'untracked')) {
    return discardText({ kind: 'section', area: 'untracked', count: entries.length })
  }
  const n = entries.length
  return {
    title: `Discard changes to ${n} file${n === 1 ? '' : 's'}?`,
    body: `This will revert the unstaged changes to ${n === 1 ? 'this file' : 'these files'}. This cannot be undone.`,
    confirm: `Discard ${n}`
  }
}
