/**
 * A move onto a server another desktop on the same login already uses. A project this desktop moves
 * that the server already holds at the same host path is the same checkout, so the move links it
 * to the server's project instead of importing a second row the server refuses. The server's row
 * and state stay as they are; this desktop's own rows stay in its retained source, as moved ones do.
 *
 * Linking rewrites the journal under the same migration id, and only after the server proves it
 * holds nothing of the earlier manifest, so no row ever lands twice.
 */
import { getAutomationRunRepoId } from '../../shared/automation-run-identity'
import type { Automation } from '../../shared/automations-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isRepoOnCatalogHost } from '../../shared/execution-host'
import type { QuirkydMigrationSourceCutover } from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import type { SshManagedServerLinkedProject } from '../../shared/ssh-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { Store } from '../persistence'
import {
  abortQuirkydMigrationCutover,
  type QuirkydMigrationDestinationCatalog
} from './quirkyd-migration-cutover-coordinator'
import { writeQuirkydMigrationSourceCutover } from './quirkyd-migration-cutover-journal'
import {
  quirkydSourceStoreWithout,
  type QuirkydDeltaSourceStore
} from './quirkyd-migration-delta-plan'
import { createQuirkydMigrationManifest } from './quirkyd-migration-manifest-export'
import type { QuirkydMigrationSourceCutoverPort } from './quirkyd-migration-source'
import { sshRelayMigrationCutoverPort } from './quirkyd-migration-ssh-relay-source'
import { quirkydCatalogFingerprint } from './quirkyd-retained-source'
import {
  folderWorkspacesHeldByServer,
  type QuirkydServerFolderCatalog
} from './quirkyd-server-folder-workspaces'
import { projectGroupsHeldByServer, serverHeldProjectGroups } from './quirkyd-server-project-groups'
import type { SshTargetQuirkydClaims } from './targets/ssh-target-quirkyd-claims'

export type QuirkydServerRepository = Pick<Repo, 'id' | 'path'> & {
  connectionId?: string | null
  executionHostId?: string | null
  /** Proves the server holds this group: its record, not this desktop's copy, wins on relink. */
  projectGroupId?: string | null
}

/**
 * Incoming projects the server holds at the same host path. `sameId` is the server's copy of this
 * desktop's own row, from an earlier move into the profile a stopped server left (#29560). Only the
 * server machine's own rows count: one it reaches on another host is a different checkout.
 */
export function repositoriesHeldByServer(
  incoming: readonly QuirkydServerRepository[],
  server: readonly QuirkydServerRepository[]
): { otherId: string[]; sameId: string[] } {
  const serverIdsByPath = new Map<string, Set<string>>()
  for (const repo of server.filter(isRepoOnCatalogHost)) {
    const key = normalizeRuntimePathForComparison(repo.path)
    serverIdsByPath.set(key, (serverIdsByPath.get(key) ?? new Set()).add(repo.id))
  }
  const otherId: string[] = []
  const sameId: string[] = []
  for (const repo of incoming) {
    const ids = serverIdsByPath.get(normalizeRuntimePathForComparison(repo.path))
    if (ids?.has(repo.id)) {
      sameId.push(repo.id)
    } else if (ids) {
      otherId.push(repo.id)
    }
  }
  return { otherId, sameId }
}

/**
 * The server's same-id rows came from an earlier move unless this one already committed (a crash
 * before the journal caught up), which must resume, not relink. Its live state since then is
 * newer than this desktop's retained copy, so it is linked rather than re-imported over.
 */
async function serverHeldRowsToLink(
  cutover: QuirkydMigrationSourceCutover,
  destination: QuirkydMigrationDestinationCatalog,
  server: readonly QuirkydServerRepository[],
  serverFolders: QuirkydServerFolderCatalog
): Promise<{ repositoryIds: string[]; folderWorkspaceIds: string[]; projectGroupIds: string[] }> {
  const { payload } = cutover.manifest
  const held = repositoriesHeldByServer(payload.repositories, server)
  const heldFolders = folderWorkspacesHeldByServer(payload.folderWorkspaces, serverFolders, server)
  const heldGroups = projectGroupsHeldByServer(payload.projectGroups, serverFolders)
  const otherIdOnly = { repositoryIds: held.otherId, folderWorkspaceIds: [], projectGroupIds: [] }
  if (held.sameId.length === 0 && heldFolders.length === 0 && heldGroups.length === 0) {
    return otherIdOnly
  }
  const state = await destination.readState(cutover.manifest)
  return state.state === 'committed'
    ? otherIdOnly
    : {
        repositoryIds: [...held.otherId, ...held.sameId],
        folderWorkspaceIds: heldFolders,
        projectGroupIds: heldGroups
      }
}

/** The source the cutover was cut from: the real store less any project or group it linked. */
export function linkedQuirkydMigrationSource(
  store: Store,
  cutover: Pick<
    QuirkydMigrationSourceCutover,
    | 'sshTargetId'
    | 'destinationEnvironmentId'
    | 'linkedRepositoryIds'
    | 'linkedProjectGroupIds'
    | 'linkedFolderWorkspaceIds'
  >
): (() => QuirkydDeltaSourceStore) | undefined {
  const linked = cutover.linkedRepositoryIds ?? []
  const linkedGroups = cutover.linkedProjectGroupIds ?? []
  const linkedFolders = cutover.linkedFolderWorkspaceIds ?? []
  if (linked.length === 0 && linkedGroups.length === 0 && linkedFolders.length === 0) {
    return undefined
  }
  return () => {
    const target = store.getSshTarget(cutover.sshTargetId)
    if (!target) {
      throw new Error('quirkyd_migration_source_fence_lost')
    }
    return quirkydSourceStoreWithout(
      store,
      target,
      {
        repositoryIds: new Set(linked),
        folderWorkspaceIds: new Set(linkedFolders),
        projectGroupIds: new Set()
      },
      cutover.destinationEnvironmentId,
      new Set(linkedGroups)
    )
  }
}

export function linkedQuirkydMigrationCutoverPort(args: {
  userDataPath: string
  store: Store
  claims: SshTargetQuirkydClaims
  cutover: QuirkydMigrationSourceCutover
}): QuirkydMigrationSourceCutoverPort {
  return sshRelayMigrationCutoverPort({
    userDataPath: args.userDataPath,
    store: args.store,
    claims: args.claims,
    freshSource: linkedQuirkydMigrationSource(args.store, args.cutover)
  })
}

const NO_SERVER_FOLDERS: QuirkydServerFolderCatalog = { folderWorkspaces: [], projectGroups: [] }

/** The repo or folder workspace a lease's tab belongs to. */
function leaseWorkspaceOwner(worktreeId: string): string | undefined {
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder' ? scope.folderWorkspaceId : splitWorktreeId(worktreeId)?.repoId
}

/**
 * A relay terminal the bridge still serves reattaches only into its own tab, which a linked
 * project never sends to the server: linking now would strand it out of sight, still running.
 */
function assertNoRelayTerminalsIn(
  store: Pick<Store, 'getSshRemotePtyLeases'>,
  cutover: QuirkydMigrationSourceCutover,
  linked: readonly string[],
  linkedFolders: readonly string[]
): void {
  const bridged = new Set(cutover.bridgedPtyIds ?? [])
  const owners = store
    .getSshRemotePtyLeases(cutover.sshTargetId)
    .filter((lease) => bridged.has(lease.ptyId) && lease.state !== 'terminated')
    .map((lease) => (lease.worktreeId ? leaseWorkspaceOwner(lease.worktreeId) : undefined))
  if (owners.length === 0) {
    return
  }
  const { repositories, folderWorkspaces } = cutover.manifest.payload
  const linkedRows = [
    ...repositories.filter((repo) => linked.includes(repo.id)),
    ...folderWorkspaces
      .filter((workspace) => linkedFolders.includes(workspace.id))
      .map((workspace) => ({ id: workspace.id, path: workspace.folderPath }))
  ]
  const blocked = linkedRows.find((row) => owners.includes(row.id))
  if (blocked) {
    throw new Error(`quirkyd_migration_linked_project_terminals:${blocked.path}`)
  }
  const moving = new Set([...repositories, ...folderWorkspaces].map((row) => row.id))
  // A lease whose project can't be told, or isn't moving, may be one a link would strand.
  if (owners.some((owner) => owner === undefined || !moving.has(owner))) {
    throw new Error(
      `quirkyd_migration_linked_project_unowned_terminals:${linkedRows.map((row) => row.path).join(', ')}`
    )
  }
}

/** What each linked project leaves behind on this desktop, so the connect can say so. */
export function linkedQuirkydMigrationProjects(
  store: {
    getRepos(): QuirkydServerRepository[]
    getFolderWorkspaces(): Pick<FolderWorkspace, 'id' | 'folderPath'>[]
    listAutomations(): Pick<Automation, 'projectId' | 'runContext'>[]
  },
  cutover: Pick<QuirkydMigrationSourceCutover, 'linkedRepositoryIds' | 'linkedFolderWorkspaceIds'>
): SshManagedServerLinkedProject[] {
  const linked = new Set(cutover.linkedRepositoryIds ?? [])
  const linkedFolders = new Set(cutover.linkedFolderWorkspaceIds ?? [])
  if (linked.size === 0 && linkedFolders.size === 0) {
    return []
  }
  const automations = store.listAutomations()
  return [
    ...store
      .getRepos()
      .filter((repo) => linked.has(repo.id))
      .map((repo) => ({
        path: repo.path,
        automations: automations.filter((entry) => getAutomationRunRepoId(entry) === repo.id).length
      })),
    ...store
      .getFolderWorkspaces()
      .filter((workspace) => linkedFolders.has(workspace.id))
      .map((workspace) => ({ path: workspace.folderPath, automations: 0 }))
  ]
}

/** Returns the cutover to commit: the same one, or one re-journaled without the linked projects. */
export async function linkServerHeldRepositories(args: {
  userDataPath: string
  store: Store
  claims: SshTargetQuirkydClaims
  cutover: QuirkydMigrationSourceCutover
  destination: QuirkydMigrationDestinationCatalog
  serverRepositories: () => Promise<QuirkydServerRepository[]>
  /** Absent: the server's folder workspaces aren't read, so none of them link. */
  serverFolderCatalog?: () => Promise<QuirkydServerFolderCatalog>
  now?: () => Date
}): Promise<QuirkydMigrationSourceCutover> {
  const { cutover, userDataPath } = args
  if (cutover.phase !== 'source-fenced' && cutover.phase !== 'destination-staged') {
    return cutover
  }
  const serverRepositories = await args.serverRepositories()
  const { folderWorkspaces, projectGroups } = cutover.manifest.payload
  const serverCatalog =
    folderWorkspaces.length > 0 || projectGroups.length > 0
      ? await args.serverFolderCatalog?.()
      : undefined
  const serverFolders = serverCatalog ?? NO_SERVER_FOLDERS
  const {
    repositoryIds: linked,
    folderWorkspaceIds: folders,
    projectGroupIds: heldGroups
  } = await serverHeldRowsToLink(cutover, args.destination, serverRepositories, serverFolders)
  if (linked.length === 0 && folders.length === 0 && heldGroups.length === 0) {
    return cutover
  }
  assertNoRelayTerminalsIn(args.store, cutover, linked, folders)
  const source = linkedQuirkydMigrationCutoverPort(args)
  // The relinked manifest is cut from the source as fenced, so it must still be that source.
  source.verifyFence(cutover)
  const linkedRepositoryIds = [...new Set([...(cutover.linkedRepositoryIds ?? []), ...linked])]
  const linkedFolderWorkspaceIds = [
    ...new Set([...(cutover.linkedFolderWorkspaceIds ?? []), ...folders])
  ]
  const linkedProjectGroupIds = [
    ...new Set([
      ...(cutover.linkedProjectGroupIds ?? []),
      ...serverHeldProjectGroups(
        cutover.manifest.payload,
        {
          repositoryIds: new Set(linkedRepositoryIds),
          folderWorkspaceIds: new Set(linkedFolderWorkspaceIds)
        },
        [...serverRepositories, ...serverFolders.folderWorkspaces],
        serverCatalog
      )
    ])
  ]
  const linkedIds = {
    ...(linkedRepositoryIds.length > 0 ? { linkedRepositoryIds } : {}),
    ...(linkedProjectGroupIds.length > 0 ? { linkedProjectGroupIds } : {}),
    ...(linkedFolderWorkspaceIds.length > 0 ? { linkedFolderWorkspaceIds } : {})
  }
  const view = linkedQuirkydMigrationSource(args.store, { ...cutover, ...linkedIds })?.()
  const target = args.store.getSshTarget(cutover.sshTargetId)
  if (!view || !target) {
    throw new Error('quirkyd_migration_source_fence_lost')
  }
  const manifest = createQuirkydMigrationManifest(view, target, {
    migrationId: cutover.migrationId,
    destinationEnvironmentId: cutover.destinationEnvironmentId,
    now: () => new Date(cutover.manifest.createdAt)
  })
  const relinked: QuirkydMigrationSourceCutover = {
    ...cutover,
    phase: 'source-fenced',
    updatedAt: (args.now ?? (() => new Date()))().toISOString(),
    manifestSha256: manifest.manifestSha256,
    manifest,
    ...linkedIds,
    // The retained rows still hold the linked projects, so the baseline is the whole fenced source.
    sourceBaselineFingerprint:
      cutover.sourceBaselineFingerprint ?? quirkydCatalogFingerprint(cutover.manifest.payload)
  }
  const aborted = await abortQuirkydMigrationCutover(
    { userDataPath, store: args.store, claims: args.claims, destination: args.destination, source },
    cutover.migrationId,
    // Why keep the fence: the move goes on to the same server, now without the linked projects.
    async () => writeQuirkydMigrationSourceCutover(userDataPath, relinked)
  )
  if (aborted.outcome !== 'released') {
    throw new Error(aborted.code)
  }
  return relinked
}
