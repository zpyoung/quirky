import { createHash } from 'node:crypto'

export const SILENT_MS = 15 * 60_000
export const DONE_WHEN_REPEATS = 3
export const CALL_REPEATS = 3
export const DENIALS_IN_A_ROW = 3
export const DENIALS_TOTAL = 20
export const EDIT_WINDOW_MS = 30 * 60_000

export type StuckKind = 'silent' | 'done-when-repeat' | 'call-loop' | 'edit-revert' | 'denials'
export type StuckSignal = { kind: StuckKind; detail: string }

/** What the supervisor knows about one worker, oldest entry first in every list. */
export type StuckWindow = {
  now: number
  working: boolean
  lastActivityAt: number | null
  doneWhen: { signature: string; pass: boolean; at: number }[]
  calls: { fingerprint: string; toolName: string; at: number }[]
  edits: { path: string; contentHash: string; at: number }[]
  denials: { consecutive: number; total: number }
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** A hash of a failure's output that ignores colour, numbers and spacing, so one failure with different timings hashes the same. */
export function outputSignature(output: string): string {
  const normalized = output.replace(ANSI, '').replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function repeatedDoneWhen(window: StuckWindow): StuckSignal | null {
  const run = window.doneWhen.slice(-DONE_WHEN_REPEATS)
  if (run.length < DONE_WHEN_REPEATS) return null
  if (run.some((attempt) => attempt.pass || attempt.signature !== run[0].signature)) return null
  return { kind: 'done-when-repeat', detail: `done when failed the same way ${DONE_WHEN_REPEATS} times in a row` }
}

function loopingCall(window: StuckWindow): StuckSignal | null {
  const run = window.calls.slice(-CALL_REPEATS)
  if (run.length < CALL_REPEATS || run.some((call) => call.fingerprint !== run[0].fingerprint)) return null
  return { kind: 'call-loop', detail: `the same ${run[0].toolName} call with the same arguments ${CALL_REPEATS} times in a row` }
}

function revertedEdit(window: StuckWindow): StuckSignal | null {
  const byPath = new Map<string, string[]>()
  for (const edit of window.edits) {
    if (edit.at < window.now - EDIT_WINDOW_MS) continue
    byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit.contentHash])
  }
  for (const [path, hashes] of byPath) {
    for (let later = 2; later < hashes.length; later++) {
      for (let earlier = 0; earlier < later - 1; earlier++) {
        if (hashes[earlier] === hashes[later] && hashes.slice(earlier + 1, later).some((hash) => hash !== hashes[later])) {
          return { kind: 'edit-revert', detail: `${path} was edited and then put back to an earlier content` }
        }
      }
    }
  }
  return null
}

/**
 * Finds the first of the five stuck signals in `window`, or null. A worker is stuck after 15
 * minutes of silence while working, done when failing the same way 3 times in a row, 3 identical
 * consecutive tool calls, an edit that returns a file to earlier content, or 3 denials in a row
 * or 20 in total.
 */
export function detectStuck(window: StuckWindow): StuckSignal | null {
  if (window.working && window.lastActivityAt !== null && window.now - window.lastActivityAt >= SILENT_MS) {
    return { kind: 'silent', detail: `no activity for ${Math.floor((window.now - window.lastActivityAt) / 60_000)} minutes while working` }
  }
  if (window.denials.consecutive >= DENIALS_IN_A_ROW || window.denials.total >= DENIALS_TOTAL) {
    return { kind: 'denials', detail: `${window.denials.consecutive} denials in a row, ${window.denials.total} in total` }
  }
  return repeatedDoneWhen(window) ?? loopingCall(window) ?? revertedEdit(window)
}

const KEPT = 50

/** The recent calls, file edits and last sign of life per worktree, filled by the session-record check and read by the watchdog. */
export type Evidence = {
  noteActivity(worktreeId: string, at: number): void
  noteCall(worktreeId: string, call: StuckWindow['calls'][number]): void
  noteEdit(worktreeId: string, edit: StuckWindow['edits'][number]): void
  lastActivity(worktreeId: string): number | null
  calls(worktreeId: string, since?: number): StuckWindow['calls']
  edits(worktreeId: string, since?: number): StuckWindow['edits']
  /** The content hash last recorded for a file, so only real changes are noted as edits. */
  lastHash(worktreeId: string, path: string): string | undefined
  clear(worktreeId: string): void
}

/** An in-memory `Evidence` that keeps the newest 50 calls and 50 edits per worktree. */
export function createEvidence(): Evidence {
  const activity = new Map<string, number>()
  const calls = new Map<string, StuckWindow['calls']>()
  const edits = new Map<string, StuckWindow['edits']>()
  const hashes = new Map<string, string>()
  const push = <T>(store: Map<string, T[]>, worktreeId: string, item: T): void => void store.set(worktreeId, [...(store.get(worktreeId) ?? []), item].slice(-KEPT))
  return {
    noteActivity: (worktreeId, at) => void activity.set(worktreeId, Math.max(at, activity.get(worktreeId) ?? 0)),
    noteCall: (worktreeId, call) => push(calls, worktreeId, call),
    noteEdit(worktreeId, edit) {
      hashes.set(`${worktreeId}\0${edit.path}`, edit.contentHash)
      push(edits, worktreeId, edit)
    },
    lastActivity: (worktreeId) => activity.get(worktreeId) ?? null,
    calls: (worktreeId, since = 0) => (calls.get(worktreeId) ?? []).filter((call) => call.at > since),
    edits: (worktreeId, since = 0) => (edits.get(worktreeId) ?? []).filter((edit) => edit.at > since),
    lastHash: (worktreeId, path) => hashes.get(`${worktreeId}\0${path}`),
    clear(worktreeId) {
      calls.delete(worktreeId)
      edits.delete(worktreeId)
      for (const key of [...hashes.keys()]) if (key.startsWith(`${worktreeId}\0`)) hashes.delete(key)
    }
  }
}
