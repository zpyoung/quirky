import type { FolderWorkspace } from '../folder-workspace-types'
import type { Automation, AutomationRun } from '../automations-types'
import type { QuirkydMigrationManifestVersion } from './quirkyd-migration-manifest-validation'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { SparsePreset } from '../worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from '../worktree/lineage-types'
import type { WorktreeMeta } from '../worktree/meta-types'
import type { RetiredNameRegistry } from '../worktree/retired-name-registry'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type { QuirkydMigrationClientStatePayload } from './quirkyd-migration-client-state'
import type {
  QuirkydMigrationSnapshotUploadState,
  QuirkydMigrationTerminalScrollbackSnapshot
} from './quirkyd-migration-scrollback'
import type { QuirkydMigrationBlobUploadState } from './quirkyd-migration-blob-transfer'

import { isRecord } from './quirkyd-migration-manifest-fields'

/** The relay-era SSH source: on the wire it never carries `kind` (see quirkyd-migration-source-kind). */
export type QuirkydMigrationSshManifestSource = {
  sshTargetId: string
  sshTargetGeneration: number | null
  targetLabel: string
}

/**
 * Local WSL projects on this desktop, moving to the quirkyd that runs inside their distro. Scope is
 * explicit so a destination never infers it from paths, and `generation` orders delta moves.
 */
export type QuirkydMigrationLocalWslManifestSource = {
  kind: 'local-wsl'
  distro: string
  /** The distro's registry id, when known: a re-registered distro of the same name is another one. */
  distroGuid?: string
  scopeRepoIds: string[]
  scopeFolderWorkspaceIds: string[]
  generation: number
}

export type QuirkydMigrationManifestSource =
  | QuirkydMigrationSshManifestSource
  | QuirkydMigrationLocalWslManifestSource

export type QuirkydMigrationCatalogPayload = {
  repositories: Repo[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  dormantState?: QuirkydMigrationDormantStatePayload
}

export type QuirkydMigrationDormantWorktreeMeta = {
  sourceKey: string
  worktreeId: string
  meta: WorktreeMeta
}

export type QuirkydMigrationDormantWorktreeLineage = {
  sourceKey: string
  worktreeId: string
  lineage: WorktreeLineage
}

export type QuirkydMigrationDormantWorkspaceLineage = {
  sourceKey: string
  childWorkspaceKey: string
  lineage: WorkspaceLineage
}

export type QuirkydMigrationDormantRetiredNames = {
  repoId: string
  registry: RetiredNameRegistry
}

export type QuirkydMigrationDormantRetirementNamespace = {
  sourceNamespaceKeys: string[]
  namespaceKey: string
  registry: RetiredNameRegistry
}

export type QuirkydMigrationDormantStatePayload = {
  version: 1
  worktreeMeta: QuirkydMigrationDormantWorktreeMeta[]
  worktreeLineage: QuirkydMigrationDormantWorktreeLineage[]
  workspaceLineage: QuirkydMigrationDormantWorkspaceLineage[]
  sparsePresets: SparsePreset[]
  retiredWorktreeNames: QuirkydMigrationDormantRetiredNames[]
  retiredWorktreeNamespaces: QuirkydMigrationDormantRetirementNamespace[]
  workspaceSession?: WorkspaceSessionState
  terminalScrollbackSnapshots?: QuirkydMigrationTerminalScrollbackSnapshot[]
  automations?: Automation[]
  automationRuns?: AutomationRun[]
  /** Client-owned durable intent projected to the destination authority. */
  clientState?: QuirkydMigrationClientStatePayload
}

export type QuirkydMigrationManifest = {
  version: QuirkydMigrationManifestVersion
  migrationId: string
  createdAt: string
  source: QuirkydMigrationManifestSource
  payload: QuirkydMigrationCatalogPayload
  /** Destination runtime identity used to re-key desktop routing after commit. */
  destinationEnvironmentId?: string
  manifestSha256: string
}

export type QuirkydMigrationImportReceipt = {
  version: QuirkydMigrationManifestVersion
  migrationId: string
  manifestSha256: string
  source: QuirkydMigrationManifestSource
  importedAt: string
  repositoryIds: string[]
  projectGroupIds: string[]
  folderWorkspaceIds: string[]
}

export type QuirkydMigrationStagedCatalog = {
  version: QuirkydMigrationManifestVersion
  manifest: QuirkydMigrationManifest
  stagedAt: string
}

export type QuirkydMigrationCatalogState =
  | {
      state: 'absent'
      migrationId: string
      manifestSha256: string
    }
  | {
      state: 'staged'
      migrationId: string
      manifestSha256: string
      stagedAt: string
      snapshotUploads?: QuirkydMigrationSnapshotUploadState[]
      /** Blobs staged so far; absent from hosts without the blob channel. */
      blobUploads?: QuirkydMigrationBlobUploadState[]
    }
  | {
      state: 'committed'
      migrationId: string
      manifestSha256: string
      receipt: QuirkydMigrationImportReceipt
    }

export type QuirkydMigrationCatalogAbortResult = QuirkydMigrationCatalogState & {
  aborted: boolean
  durableAbsent?: true
}

export type QuirkydMigrationCatalogReference = Pick<
  QuirkydMigrationManifest,
  'migrationId' | 'manifestSha256'
>

/** An abort by reference: no receipt, since an evicted one is rebuilt only from the manifest. */
export type QuirkydMigrationCatalogReferenceAbortResult = QuirkydMigrationCatalogReference & {
  state: 'absent' | 'committed'
  aborted: boolean
  durableAbsent?: true
}

export function quirkydMigrationManifestHashInput(
  manifest: Omit<QuirkydMigrationManifest, 'manifestSha256'>
): string {
  return serializeQuirkydMigrationValue(manifest)
}

export function serializeQuirkydMigrationValue(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value))
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJsonValue(entry)])
  )
}
