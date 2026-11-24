/**
 * The source as a delta move sees it: a copy of the profile with everything earlier migrations of
 * the host already moved subtracted from it. What is left is what an older build added, and only
 * that is exported, censused and later committed.
 */
import type {
  QuirkydMigrationCatalogPayload,
  QuirkydMigrationDormantStatePayload,
  QuirkydMigrationManifest,
  QuirkydMigrationManifestSource
} from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { subtractQuirkydSourceCatalogState } from './quirkyd-source-catalog-subtraction'
import {
  collectQuirkydMigrationUntransferredDependencyCensus,
  type QuirkydMigrationSourceDependencyCensus
} from './quirkyd-source-dependency-census'
import { subtractQuirkydMigrationSourceDormantState } from './quirkyd-source-dormant-subtraction'
import { collectQuirkydMigrationSourceDormantState } from './quirkyd-source-dormant-state'
import { subtractQuirkydMigrationScopeWorkspaceSession } from './quirkyd-source-workspace-session-subtraction'

export type QuirkydMigrationDeltaView = {
  getRepos: () => Repo[]
  getFolderWorkspaces: () => FolderWorkspace[]
  getProjectGroups: () => ProjectGroup[]
  collectQuirkydMigrationSourceDormantState: (
    source: QuirkydMigrationManifestSource,
    catalog: QuirkydMigrationCatalogPayload,
    destinationEnvironmentId?: string
  ) => QuirkydMigrationDormantStatePayload
  inspectQuirkydMigrationUntransferredDependencies: (
    manifest: QuirkydMigrationManifest
  ) => QuirkydMigrationSourceDependencyCensus
}

/** `moved` re-exports what the earlier migrations own today, including later edits to it. */
export function createQuirkydMigrationDeltaView(
  runtime: Pick<StoreRuntimeState, 'state' | 'terminalScrollbackSnapshotStorage'>,
  moved: QuirkydMigrationManifest
): QuirkydMigrationDeltaView {
  const state = structuredClone(runtime.state)
  subtractQuirkydSourceCatalogState(state, moved)
  subtractQuirkydMigrationSourceDormantState(state, moved)
  // The server owns the moved projects' tabs now, even ones the older build left unmovable.
  subtractQuirkydMigrationScopeWorkspaceSession(state, moved)
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
