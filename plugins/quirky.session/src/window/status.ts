import type { SessionStatus } from '@quirky/protocol'

export type DisplayStatus = Exclude<SessionStatus, 'starting'>

/** A starting session shows as running; every other status shows as itself. */
export function displayStatus(status: SessionStatus): DisplayStatus {
  return status === 'starting' ? 'running' : status
}
