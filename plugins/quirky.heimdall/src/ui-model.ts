import type { FleetRow, FleetSnapshot } from './control-contracts'
import type { TickTrace } from './contracts'

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
