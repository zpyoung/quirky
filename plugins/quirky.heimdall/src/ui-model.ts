import type { FleetRow, FleetSnapshot } from './control-contracts'
import type { TickTrace } from './contracts'

export type FleetBucket = 'needsYou' | 'lostContact' | 'active' | 'inactive'

export type FleetGroups = Record<FleetBucket, FleetRow[]>

export type StatusPresentation = {
  label: string
  reason?: string
  detail?: string
}

export type DecisionTraceGroup = {
  firstSeq: number
  lastSeq: number
  count: number
  representative: TickTrace
}

const urgency = (row: FleetRow): number => {
  switch (row.status.state) {
    case 'escalated':
      return 0
    case 'parked':
      return 1
    case 'unreachable':
    case 'malformed':
      return 2
    case 'held':
      return row.status.reason === 'tick-error' || row.status.consecutiveErrors > 0 || row.ownerContact === 'unverifiable' ? 2 : 3
    case 'acting':
      return 4
    case 'watching':
      return row.ownerContact === 'unverifiable' ? 2 : 5
    case 'terminal':
      return 6
    case 'disabled':
      return 7
    default:
      return 8
  }
}

/** Sorts urgency first, then most recent successful tick and watcher name. */
export function sortFleetRows(rows: readonly FleetRow[]): FleetRow[] {
  return [...rows].sort((a, b) => {
    const rank = urgency(a) - urgency(b)
    if (rank !== 0) return rank
    const aTick = a.lastSuccessfulTickAtMs
    const bTick = b.lastSuccessfulTickAtMs
    if (aTick !== bTick) {
      if (aTick === null) return 1
      if (bTick === null) return -1
      return bTick - aTick
    }
    return a.name.localeCompare(b.name)
  })
}

function awaitingApproval(row: FleetRow): boolean {
  return row.openEscalations.some((escalation) =>
    escalation.status === 'open' && (escalation.escalationKind === 'awaiting-approval' || escalation.approvalScope !== undefined)
  )
}

/** Assigns one and only one fleet bucket to a row. */
export function fleetBucket(row: FleetRow): FleetBucket {
  const { state } = row.status
  if (state === 'escalated' || state === 'parked' || (state === 'held' && (row.pendingQuestion || awaitingApproval(row)))) return 'needsYou'
  if (state === 'unreachable' || row.ownerContact === 'unverifiable') return 'lostContact'
  if (state === 'watching' || state === 'acting' || state === 'held') return 'active'
  return 'inactive'
}

/** Groups every fleet row exactly once for sidebar counts and views. */
export function groupFleetRows(rows: readonly FleetRow[]): FleetGroups {
  const groups: FleetGroups = { needsYou: [], lostContact: [], active: [], inactive: [] }
  for (const row of rows) groups[fleetBucket(row)].push(row)
  return groups
}

function ageLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Keeps contact certainty and the underlying owner status explanation visible together. */
export function statusPresentation(row: Pick<FleetRow, 'status' | 'ownerContact' | 'observedAtMs'>, now: number): StatusPresentation {
  let label: string
  if (row.ownerContact === 'unverifiable') {
    label = `Host unreachable · last confirmed ${ageLabel(now - row.observedAtMs)}`
  } else if (row.status.state === 'held' && (row.status.reason === 'tick-error' || row.status.consecutiveErrors > 0)) {
    label = 'Error · retrying'
  } else {
    switch (row.status.state) {
      case 'watching': label = 'Watching'; break
      case 'held': label = 'Held'; break
      case 'acting': label = 'Acting'; break
      case 'escalated': label = 'Escalated'; break
      case 'parked': label = 'Parked'; break
      case 'terminal': label = 'Complete'; break
      case 'disabled': label = 'Stopped'; break
      case 'unreachable': label = 'Host unreachable'; break
      case 'malformed': label = 'Malformed'; break
      default: label = 'Unknown'; break
    }
  }
  return {
    label,
    ...(row.status.reason ? { reason: row.status.reason } : {}),
    ...(row.status.detail ? { detail: row.status.detail } : {})
  }
}

/** Retains the last confirmed snapshot unless the incoming snapshot is strictly newer. */
export function acceptFleetSnapshot(current: FleetSnapshot | null, incoming: FleetSnapshot): FleetSnapshot {
  return current === null || incoming.generatedAtMs > current.generatedAtMs ? incoming : current
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function gateHeldIdentity(trace: TickTrace): string {
  return canonical({
    contentIdentity: trace.contentIdentity,
    snapshot: trace.snapshot,
    decision: trace.decision,
    declined: trace.declined,
    gate: trace.gate,
    budget: trace.budget,
    error: trace.error
  })
}

/** Collapses adjacent, semantically identical gate-held traces; all other traces stay distinct. */
export function groupDecisionTraces(traces: readonly TickTrace[]): DecisionTraceGroup[] {
  const ordered = [...traces].sort((a, b) => a.seq - b.seq)
  const groups: DecisionTraceGroup[] = []
  for (const trace of ordered) {
    const previous = groups.at(-1)
    if (
      trace.exitPath === 'gate-held' && previous?.representative.exitPath === 'gate-held' &&
      trace.seq === previous.lastSeq + 1 && gateHeldIdentity(trace) === gateHeldIdentity(previous.representative)
    ) {
      previous.lastSeq = trace.seq
      previous.count += 1
      continue
    }
    groups.push({ firstSeq: trace.seq, lastSeq: trace.seq, count: 1, representative: trace })
  }
  return groups
}
