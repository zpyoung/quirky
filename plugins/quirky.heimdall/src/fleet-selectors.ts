import type { FleetRow, FleetSnapshot } from './control-contracts'

export type FleetBucket = keyof FleetSnapshot['buckets']
export type FleetGroups = Record<FleetBucket, FleetRow[]>

function urgency(row: FleetRow): number {
  const { state } = row.status
  if (state === 'escalated') return 0
  if (state === 'parked') return 1
  if (
    state === 'unreachable' || state === 'malformed' || row.ownerContact === 'unverifiable' ||
    row.status.reason === 'tick-error' || row.status.consecutiveErrors > 0
  ) return 2
  if (row.enrollment.paused || state === 'disabled') return 7
  if (state === 'held') return 3
  if (state === 'acting') return 4
  if (state === 'watching') return 5
  if (state === 'terminal') return 6
  return 2
}

export function sortFleetRows(rows: readonly FleetRow[]): FleetRow[] {
  return [...rows].sort((left, right) => {
    const rank = urgency(left) - urgency(right)
    if (rank !== 0) return rank
    const leftTick = left.lastSuccessfulTickAtMs
    const rightTick = right.lastSuccessfulTickAtMs
    if (leftTick !== rightTick) {
      if (leftTick === null) return 1
      if (rightTick === null) return -1
      return rightTick - leftTick
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })
}

export function fleetBucket(row: FleetRow): FleetBucket {
  const { state } = row.status
  if (
    state === 'escalated' || state === 'parked' ||
    (state === 'held' && (
      row.pendingQuestion || row.openEscalations.some((escalation) =>
        escalation.status === 'open' && (
          escalation.approvalScope !== undefined ||
          escalation.escalationKind === 'awaiting-approval' ||
          escalation.reason === 'awaiting-approval'
        )
      )
    ))
  ) return 'needsYou'
  if (state === 'unreachable' || state === 'malformed' || row.ownerContact === 'unverifiable') return 'lostContact'
  if (row.enrollment.paused || !row.enrollment.enabled || state === 'disabled' || state === 'terminal') return 'inactive'
  if (state === 'held' || state === 'acting' || state === 'watching') return 'active'
  return 'inactive'
}

export function groupFleetRows(rows: readonly FleetRow[]): FleetGroups {
  const groups: FleetGroups = { needsYou: [], lostContact: [], active: [], inactive: [] }
  for (const row of rows) groups[fleetBucket(row)].push(row)
  return groups
}
