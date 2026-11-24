import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import {
  QUIRKYD_MIGRATION_DEPENDENCY_KINDS,
  type QuirkydMigrationDependencyKind
} from '../../../shared/quirkyd-migration/quirkyd-migration-preflight'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import {
  inspectQuirkydMigrationSourceSessions,
  type QuirkydMigrationSourceSessionInspection
} from './quirkyd-source-session-dependencies'
import {
  collectQuirkydMigrationSourceDormantState,
  quirkydMigrationLeavesBehind
} from './quirkyd-source-dormant-state'
import {
  createQuirkydMigrationSourceScope,
  quirkydMigrationOwnerMatchesScope,
  quirkydMigrationPartitionScope,
  type QuirkydMigrationSourceScope
} from './quirkyd-source-scope'
import { paneBelongsToTabs } from '../../../shared/workspace-session-pane-ownership'

export type QuirkydMigrationSourceDependencyCensus = {
  totalCount: number
  counts: Record<QuirkydMigrationDependencyKind, number>
  /** For the kinds it can name: what blocks and how to clear it. */
  names?: Partial<Record<QuirkydMigrationDependencyKind, string[]>>
}

/** What still references the target that this manifest cannot carry. */
export function collectQuirkydMigrationUntransferredDependencyCensus(
  state: PersistedState,
  manifest: QuirkydMigrationManifest,
  storage?: TerminalScrollbackSnapshotStorage
): QuirkydMigrationSourceDependencyCensus {
  const scope = createQuirkydMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const sessions = inspectQuirkydMigrationSourceSessions(state, {
    hostId: scope.hostId,
    ownerMatches: (ownerKey, partitionHostId) =>
      quirkydMigrationOwnerMatchesScope(
        ownerKey,
        quirkydMigrationPartitionScope(scope, partitionHostId)
      )
  })
  const dormant = collectQuirkydMigrationSourceDormantState(
    state,
    manifest.source,
    manifest.payload,
    storage,
    manifest.destinationEnvironmentId
  )
  const counts: Record<QuirkydMigrationDependencyKind, number> = {
    ...dormant.blockedCounts,
    'terminal-lease': state.sshRemotePtyLeases.filter(
      (lease) => lease.targetId === scope.targetId && lease.state !== 'terminated'
    ).length,
    // Left behind, recovery records stay with this desktop; the terminal gate still proves exit.
    'terminal-recovery': quirkydMigrationLeavesBehind(state, scope.targetId)
      ? 0
      : countTerminalRecoveryState(state, scope, sessions)
  }
  return {
    counts,
    totalCount: QUIRKYD_MIGRATION_DEPENDENCY_KINDS.reduce((total, kind) => total + counts[kind], 0),
    names:
      dormant.blockedSessionItems.length > 0
        ? { 'workspace-session': dormant.blockedSessionItems }
        : {}
  }
}

// Consumer recoveries never block: the terminal gate proves before every move that their leases exited.
// Legacy pane-key aliases never block either: an alias only routes hook events and names a terminal
// the tab or pane already records, which the lease checks and the terminal gate govern.
function countTerminalRecoveryState(
  state: PersistedState,
  scope: QuirkydMigrationSourceScope,
  sessions: QuirkydMigrationSourceSessionInspection
): number {
  return state.migrationUnsupportedPtyEntries.filter(
    (entry) =>
      quirkydMigrationOwnerMatchesScope(entry.worktreeId, scope) ||
      (entry.tabId ? sessions.tabIds.has(entry.tabId) : false) ||
      sessions.ptyIds.has(entry.ptyId) ||
      (entry.paneKey ? paneBelongsToTabs(entry.paneKey, sessions.tabIds) : false)
  ).length
}
