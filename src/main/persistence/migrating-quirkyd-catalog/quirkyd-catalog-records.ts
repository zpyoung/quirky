import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import {
  serializeQuirkydMigrationValue,
  type QuirkydMigrationImportReceipt,
  type QuirkydMigrationManifest
} from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { isRepoOnCatalogHost } from '../../../shared/execution-host'
import { assertQuirkydMigrationStagedCatalogClaims } from './quirkyd-staged-catalog-claims'
import {
  toQuirkydDestinationFolderWorkspace,
  toQuirkydDestinationProjectGroup,
  toQuirkydDestinationRepository
} from './quirkyd-destination-catalog-projection'
import {
  syncProjectHostSetupCompatibilityState,
  type RepoLifecycleOperations
} from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  applyPreparedQuirkydMigrationDormantState,
  prepareQuirkydMigrationDormantState,
  type PreparedQuirkydMigrationDormantState
} from './quirkyd-dormant-state-records'
import { sameQuirkydRepositoryConfiguration, selectNewRows } from './quirkyd-catalog-row-identity'

export type PreparedQuirkydMigrationCatalog = {
  repositories: Repo[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  newRepositories: Repo[]
  newProjectGroups: ProjectGroup[]
  newFolderWorkspaces: FolderWorkspace[]
  dormantState: PreparedQuirkydMigrationDormantState
}

export function assertSameQuirkydMigrationManifest(
  staged: QuirkydMigrationManifest,
  requested: QuirkydMigrationManifest
): void {
  if (staged.manifestSha256 !== requested.manifestSha256) {
    throw new Error('quirkyd_migration_id_reused_with_different_manifest')
  }
}

// Dormant only: no live PTY reaches the destination, so the incoming session is compared as is.
export function prepareQuirkydMigrationCatalog(
  manifest: QuirkydMigrationManifest,
  state: StoreRuntimeState['state']
): PreparedQuirkydMigrationCatalog {
  assertQuirkydMigrationStagedCatalogClaims(manifest, state.quirkydMigrationStagedCatalogs ?? [])
  const repositories = manifest.payload.repositories.map(toQuirkydDestinationRepository)
  const projectGroups = manifest.payload.projectGroups.map(toQuirkydDestinationProjectGroup)
  const folderWorkspaces = manifest.payload.folderWorkspaces.map(
    toQuirkydDestinationFolderWorkspace
  )
  const newRepositories = selectNewRows(
    repositories,
    state.repos,
    catalogConflict('repository'),
    sameQuirkydRepositoryConfiguration
  )
  const newProjectGroups = selectNewRows(
    projectGroups,
    state.projectGroups,
    catalogConflict('project_group')
  )
  const newFolderWorkspaces = selectNewRows(
    folderWorkspaces,
    state.folderWorkspaces,
    catalogConflict('folder_workspace')
  )
  assertNoRepositoryPathConflicts(repositories, state.repos)
  assertCatalogReferences({
    repositories,
    projectGroups,
    folderWorkspaces,
    existingProjectGroups: state.projectGroups
  })
  const dormantState = prepareQuirkydMigrationDormantState(manifest, state)
  return {
    repositories,
    projectGroups,
    folderWorkspaces,
    newRepositories,
    newProjectGroups,
    newFolderWorkspaces,
    dormantState
  }
}

export function applyPreparedQuirkydMigrationCatalog(
  prepared: PreparedQuirkydMigrationCatalog,
  state: StoreRuntimeState['state'],
  repos: RepoLifecycleOperations
): void {
  state.projectGroups.push(...prepared.newProjectGroups)
  state.repos.push(...prepared.newRepositories)
  state.folderWorkspaces.push(...prepared.newFolderWorkspaces)
  applyPreparedQuirkydMigrationDormantState(prepared.dormantState, state)
  if (prepared.newRepositories.length > 0) {
    syncProjectHostSetupCompatibilityState(repos)
  }
}

export function assertQuirkydMigrationReceiptMatchesManifest(
  receipt: QuirkydMigrationImportReceipt,
  manifest: QuirkydMigrationManifest
): void {
  const expected = {
    source: manifest.source,
    repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
    projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
    folderWorkspaceIds: manifest.payload.folderWorkspaces.map((workspace) => workspace.id)
  }
  const actual = {
    source: receipt.source,
    repositoryIds: receipt.repositoryIds,
    projectGroupIds: receipt.projectGroupIds,
    folderWorkspaceIds: receipt.folderWorkspaceIds
  }
  if (serializeQuirkydMigrationValue(actual) !== serializeQuirkydMigrationValue(expected)) {
    throw new Error('quirkyd_migration_receipt_manifest_mismatch')
  }
}

function catalogConflict(label: string): (id: string) => string {
  return (id) => `quirkyd_migration_${label}_id_conflict:${id}`
}

function assertNoRepositoryPathConflicts(incoming: Repo[], existing: Repo[]): void {
  const incomingIdSet = new Set(incoming.map((repo) => repo.id))
  const incomingByPath = new Map<string, string>()
  for (const repo of incoming) {
    const key = normalizeRuntimePathForComparison(repo.path)
    const priorId = incomingByPath.get(key)
    if (priorId && priorId !== repo.id) {
      throw new Error(`quirkyd_migration_repository_path_conflict:${repo.path}`)
    }
    incomingByPath.set(key, repo.id)
  }
  // Incoming rows land on this machine; a same-path row on another host is a different checkout.
  for (const repo of existing.filter(isRepoOnCatalogHost)) {
    if (
      !incomingIdSet.has(repo.id) &&
      incomingByPath.has(normalizeRuntimePathForComparison(repo.path))
    ) {
      throw new Error(`quirkyd_migration_repository_path_conflict:${repo.path}`)
    }
  }
}

function assertCatalogReferences(args: {
  repositories: Repo[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  existingProjectGroups: ProjectGroup[]
}): void {
  const groupIds = new Set([
    ...args.existingProjectGroups.map((group) => group.id),
    ...args.projectGroups.map((group) => group.id)
  ])
  for (const group of args.projectGroups) {
    if (group.parentGroupId && !groupIds.has(group.parentGroupId)) {
      throw new Error(`quirkyd_migration_project_group_parent_missing:${group.id}`)
    }
  }
  for (const repo of args.repositories) {
    if (repo.projectGroupId && !groupIds.has(repo.projectGroupId)) {
      throw new Error(`quirkyd_migration_repository_project_group_missing:${repo.id}`)
    }
  }
  for (const workspace of args.folderWorkspaces) {
    if (!groupIds.has(workspace.projectGroupId)) {
      throw new Error(`quirkyd_migration_folder_workspace_project_group_missing:${workspace.id}`)
    }
  }
}
