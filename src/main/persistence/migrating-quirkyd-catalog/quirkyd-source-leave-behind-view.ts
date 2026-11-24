/**
 * The source as a confirmed "Move anyway" would export it, without recording the consent: lets the
 * offer appear only when leaving saved state behind would actually clear what refuses the move.
 */
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { collectQuirkydMigrationUntransferredDependencyCensus } from './quirkyd-source-dependency-census'
import { collectQuirkydMigrationSourceDormantState } from './quirkyd-source-dormant-state'
import type { QuirkydMigrationDeltaView } from './quirkyd-source-delta-view'

export function createQuirkydMigrationLeaveBehindView(
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>,
  targetId: string
): QuirkydMigrationDeltaView {
  // Shallow: the collectors only read, and only the target row differs.
  const state = {
    ...runtime.state,
    sshTargets: runtime.state.sshTargets.map((target) =>
      target.id === targetId
        ? { ...target, managedServerLeaveBehind: { confirmedAt: new Date(0).toISOString() } }
        : target
    )
  }
  const storage = runtime.terminalScrollbackSnapshotStorage
  return {
    getRepos: () => state.repos,
    getFolderWorkspaces: () => state.folderWorkspaces,
    getProjectGroups: () => state.projectGroups,
    collectQuirkydMigrationSourceDormantState: (source, catalog, destinationEnvironmentId) =>
      collectQuirkydMigrationSourceDormantState(
        state,
        source,
        catalog,
        storage,
        destinationEnvironmentId
      ).payload,
    inspectQuirkydMigrationUntransferredDependencies: (manifest) =>
      collectQuirkydMigrationUntransferredDependencyCensus(state, manifest, storage)
  }
}
