import type { RunRow } from './types'
import { isEquivalentPaneKey } from './db/pane-key-match'
import { currentRunCoordinatorQuirkySessionId } from './db/runs/run-coordinator-quirky-session'
import {
  formatQuirkySessionAddress,
  type QuirkySessionId
} from '../../../shared/quirky-session-address'
import type { OrchestrationPartyIdentity } from '../../../shared/orchestration-party-identity'

/** Who an orchestration caller is; shared so a queued message can name its sender the same way. */
export type OrchestrationCallerIdentity = OrchestrationPartyIdentity

/** The part of a caller a Run binding stores and matches. */
export type OrchestrationCoordinatorKey = Pick<
  OrchestrationCallerIdentity,
  'terminalHandle' | 'paneKey' | 'quirkySessionId'
>

/** A caller the dispatch entry resolved from the Quirky session id in its injected environment. */
export type OrchestrationSessionCaller = OrchestrationCallerIdentity &
  Readonly<{
    quirkySessionId: QuirkySessionId
    /** The session record the request came from. */
    sessionId: QuirkySessionId
    /** Where the session runs, from its record; `worker-start --worktree current` places here. */
    workspaceId: string
  }>

/** A caller with neither a pane nor an Quirky session id can never be bound to a Run. */
export function hasRunBindingKey(caller: OrchestrationCoordinatorKey): boolean {
  return caller.paneKey !== null || caller.quirkySessionId !== null
}

/** The one address a party reads mail at and is sent mail at; null for a key naming nobody. */
export function mailboxAddressOf(
  party: Pick<OrchestrationCoordinatorKey, 'terminalHandle' | 'quirkySessionId'>
): string | null {
  // Handle first because a worker's mail and Dispatch rows are keyed by it today; flips when sessions become canonical.
  if (party.terminalHandle !== null) {
    return party.terminalHandle
  }
  return party.quirkySessionId === null ? null : formatQuirkySessionAddress(party.quirkySessionId)
}

/** Who a Run's binding names now; an Quirky session id an older binding left behind is not part of it. */
export function runCoordinatorKey(run: RunRow): OrchestrationCoordinatorKey {
  return {
    terminalHandle: run.coordinator_handle,
    paneKey: run.coordinator_pane_key,
    quirkySessionId: currentRunCoordinatorQuirkySessionId(run)
  }
}

export function runBoundToCoordinator(run: RunRow, caller: OrchestrationCoordinatorKey): boolean {
  if (
    caller.paneKey !== null &&
    run.coordinator_pane_key !== null &&
    isEquivalentPaneKey(run.coordinator_pane_key, caller.paneKey)
  ) {
    return true
  }
  return (
    caller.quirkySessionId !== null &&
    currentRunCoordinatorQuirkySessionId(run) === caller.quirkySessionId
  )
}
