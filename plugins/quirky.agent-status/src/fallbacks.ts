import { newRow } from './apply'
import { readableDetail, STALE_AFTER_MS } from './model'
import { ProgramStatusRecords, projectRoot, type ProgramStatusRecord, type ProgramStatusReport } from './program-status'
import type { TitleStatus } from './title'
import type { AgentRow, AgentState, ProgramStatusFacet } from './types'

/** How long hooks must be silent, while the program's report disagrees, before OSC 7501 takes the row. */
export const HOOK_SILENCE_MS = 120_000

/** A title row's evidence is refreshed this often while its title keeps saying the same thing. */
const TITLE_REFRESH_MS = 60_000

const TITLE_STATES: Record<TitleStatus, AgentState> = { working: 'working', permission: 'waiting', idle: 'done' }

/** Where a fallback decision stands: the row to store (`prev` itself when nothing changes, null to remove it). */
export type FallbackDecision = { row: AgentRow | null; retryAt?: number }

type Evidence = { sessionId: string; agent: string; at: number }

/** A hook row still being fed by hooks: its latest hook is within the freshness window. */
const hasFreshHooks = (row: AgentRow, at: number) => row.lastHookAt !== null && at - row.lastHookAt <= STALE_AFTER_MS

/** A row only OSC 7501 or titles fed, never a hook. */
const isFallbackRow = (row: AgentRow) => row.lastHookAt === null

/**
 * What a terminal title adds for a session: a title-sourced row, or `prev` itself when the title
 * changes nothing. Hooks win while they are fresh, and so does a program's own OSC 7501 row. Title
 * evidence never counts as a hook and never notifies.
 */
export function titleEvidence(prev: AgentRow | null, status: TitleStatus, ev: Evidence): AgentRow {
  if (prev && (hasFreshHooks(prev, ev.at) || (isFallbackRow(prev) && prev.source === 'program-status'))) return prev
  const state = TITLE_STATES[status]
  if (prev && prev.source === 'title' && prev.state === state && !prev.restoredUnconfirmed) {
    return ev.at - prev.evidenceAt < TITLE_REFRESH_MS ? prev : { ...prev, evidenceAt: ev.at }
  }
  const row = newRow({ sessionId: ev.sessionId, source: ev.agent, at: ev.at, replay: false })
  const sameState = prev?.source === 'title' && prev.state === state
  const since = sameState ? prev.stateStartedAt : ev.at
  return { ...row, state, lead: { ...row.lead, state, stateStartedAt: since }, stateStartedAt: since, source: 'title' }
}

/** The part of a root record that rides on a row. */
export function facetOf(root: ProgramStatusRecord | undefined): ProgramStatusFacet | undefined {
  if (!root) return undefined
  return {
    state: root.state,
    ...(root.kind !== undefined ? { kind: root.kind } : {}),
    ...(root.progress !== undefined ? { progress: root.progress } : {}),
    ...(root.msg !== undefined ? { msg: root.msg } : {}),
    ...(root.app !== undefined ? { app: root.app } : {})
  }
}

function withFacet(row: AgentRow, facet: ProgramStatusFacet | undefined): AgentRow {
  if (JSON.stringify(row.programStatus) === JSON.stringify(facet)) return row
  const next = { ...row }
  if (facet) next.programStatus = facet
  else delete next.programStatus
  next.detail = readableDetail(next)
  return next
}

export type ProgramEvidence = Evidence & {
  /** The `hooks` setting; false lets OSC 7501 decide even while hooks are fresh. */
  hooksOn: boolean
  silenceMs: number
}

/**
 * What a session's OSC 7501 root record does to its row. The facet always rides on the row; the
 * state follows the program unless hooks outrank it (fresh hooks, or silent ones whose last word
 * still agrees), in which case `retryAt` says when the hooks' silence will have lasted long enough.
 * A cleared root removes a row the program alone fed.
 */
export function programEvidence(prev: AgentRow | null, root: ProgramStatusRecord | undefined, ev: ProgramEvidence): FallbackDecision {
  const facet = facetOf(root)
  const projection = projectRoot(root)
  if (!projection) {
    if (!prev) return { row: null }
    if (isFallbackRow(prev) && prev.source === 'program-status') return { row: null }
    return { row: withFacet(prev, undefined) }
  }

  if (prev && prev.lastHookAt !== null && ev.hooksOn) {
    const silentFor = ev.at - prev.lastHookAt
    if (projection.state === prev.state) return { row: withFacet(prev, facet) }
    if (silentFor <= ev.silenceMs) return { row: withFacet(prev, facet), retryAt: prev.lastHookAt + ev.silenceMs + 1 }
  }

  const row = prev
    ? { ...prev, lead: { ...prev.lead }, children: [...prev.children] }
    : newRow({ sessionId: ev.sessionId, source: ev.agent, at: ev.at, replay: false })
  if (row.state !== projection.state) row.stateStartedAt = ev.at
  if (row.lead.state !== projection.state) row.lead.stateStartedAt = ev.at
  row.state = projection.state
  row.lead.state = projection.state
  if (projection.outcome) row.outcome = projection.outcome
  else delete row.outcome
  delete row.interrupted
  if (projection.sessionBoundary) row.sessionBoundary = true
  else delete row.sessionBoundary
  delete row.workingMode
  delete row.heldPermission
  delete row.stashedState
  delete row.restoredUnconfirmed
  row.source = 'program-status'
  row.evidenceAt = ev.at
  return { row: withFacet(row, facet) }
}

/** The records as stored: oldest first, so replaying them rebuilds the same least-recently-updated order. */
export function serializeRecords(records: ProgramStatusRecords): string {
  // the class has no iterator and its module is fenced, so the map is read directly
  const map = records['records'] as Map<string, ProgramStatusRecord>
  return JSON.stringify([...map.values()])
}

/** Rebuilds a session's records from `serializeRecords` output; unreadable input gives an empty set. */
export function parseRecords(json: string): ProgramStatusRecords {
  const records = new ProgramStatusRecords()
  try {
    const stored = JSON.parse(json) as ProgramStatusReport[]
    for (const record of stored) records.apply(record)
  } catch {
    records.reset()
  }
  return records
}
