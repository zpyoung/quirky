import { MAX_QUIRKYD_MIGRATION_STAGED_CATALOGS } from '../../../shared/quirkyd-migration/quirkyd-migration-staged-catalog-validation'
import { QUIRKYD_MIGRATION_MANIFEST_VERSION } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import type {
  QuirkydMigrationCatalogAbortResult,
  QuirkydMigrationCatalogReference,
  QuirkydMigrationCatalogReferenceAbortResult,
  QuirkydMigrationCatalogState,
  QuirkydMigrationImportReceipt,
  QuirkydMigrationManifest
} from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type {
  QuirkydMigrationSnapshotChunkRequest,
  QuirkydMigrationSnapshotChunkResult
} from '../../../shared/quirkyd-migration/quirkyd-migration-scrollback'
import type {
  QuirkydMigrationBlobChunkRequest,
  QuirkydMigrationBlobChunkResult,
  QuirkydMigrationBlobDescriptor
} from '../../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import type { RepoLifecycleOperations } from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { scheduleSave } from '../loading-store/write-scheduling'
import {
  applyPreparedQuirkydMigrationCatalog,
  assertQuirkydMigrationReceiptMatchesManifest,
  assertSameQuirkydMigrationManifest,
  prepareQuirkydMigrationCatalog,
  type PreparedQuirkydMigrationCatalog
} from './quirkyd-catalog-records'
import {
  expireQuirkydMigrationStages,
  findQuirkydMigrationImportReceipt,
  isLiveQuirkydMigrationStage,
  recordQuirkydMigrationCommitWriteGeneration,
  recordQuirkydMigrationImportReceipt,
  type QuirkydMigrationCommitGenerationRuntime
} from './quirkyd-catalog-receipt-ledger'
import {
  abortQuirkydMigrationSnapshots,
  assertQuirkydMigrationSnapshotsReady,
  commitQuirkydMigrationSnapshots,
  inspectQuirkydMigrationSnapshotUploads,
  pruneQuirkydMigrationSnapshotStaging,
  stageQuirkydMigrationSnapshotChunk
} from './quirkyd-scrollback-snapshot-transfer'
import {
  abortQuirkydMigrationBlobs,
  assertQuirkydMigrationBlobSetMatches,
  assertQuirkydMigrationBlobsReady,
  commitQuirkydMigrationBlobs,
  inspectQuirkydMigrationBlobUploads,
  pruneQuirkydMigrationBlobStaging,
  stageQuirkydMigrationBlobChunk
} from './quirkyd-migration-blob-staging'
import { assertQuirkydMigrationBlobContentsValid } from './quirkyd-migration-blob-installers'
import {
  abortQuirkydMigrationCatalogByReference,
  committedMigrations,
  stagedManifests
} from './quirkyd-catalog-reference-abort'

type QuirkydCatalogImportRuntime = QuirkydMigrationCommitGenerationRuntime &
  Pick<
    StoreRuntimeState,
    'state' | 'terminalScrollbackSnapshotStorage' | 'quirkydMigrationBlobRoot'
  >

const quirkydCatalogImportContext = Symbol('QuirkydCatalogImportPersistence')
type QuirkydCatalogImportContext = {
  runtime: QuirkydCatalogImportRuntime
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
}

// Manifests arrive parsed; the RPC boundary verified the digest over the bytes as sent.
export class QuirkydCatalogImportPersistence {
  readonly [quirkydCatalogImportContext]: QuirkydCatalogImportContext

  constructor(
    runtime: QuirkydCatalogImportRuntime,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[quirkydCatalogImportContext] = { runtime, repos, scheduling }
  }

  stageQuirkydMigrationCatalog(
    manifest: QuirkydMigrationManifest,
    options: { now?: () => Date } = {}
  ): QuirkydMigrationCatalogState {
    const context = this[quirkydCatalogImportContext]
    const now = options.now ?? (() => new Date())
    if (expireQuirkydMigrationStages(context.runtime.state, now().getTime())) {
      scheduleSave(context.scheduling)
    }
    pruneQuirkydMigrationSnapshotStaging(
      stagedManifests(context.runtime.state),
      context.runtime.terminalScrollbackSnapshotStorage
    )
    pruneQuirkydMigrationBlobStaging(
      stagedManifests(context.runtime.state),
      committedMigrations(context.runtime.state),
      context.runtime.quirkydMigrationBlobRoot
    )
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed') {
      return current
    }
    prepareQuirkydMigrationCatalog(manifest, context.runtime.state)
    if (current.state === 'staged') {
      return current
    }
    const staged = context.runtime.state.quirkydMigrationStagedCatalogs ?? []
    if (staged.length >= MAX_QUIRKYD_MIGRATION_STAGED_CATALOGS) {
      throw new Error('quirkyd_migration_staging_capacity_exceeded')
    }
    const stagedAt = now().toISOString()
    context.runtime.state.quirkydMigrationStagedCatalogs = [
      ...staged,
      {
        version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
        manifest: structuredClone(manifest),
        stagedAt
      }
    ]
    scheduleSave(context.scheduling)
    return stagedCatalogState(manifest, stagedAt, context.runtime)
  }

  stageQuirkydMigrationSnapshotChunk(
    request: QuirkydMigrationSnapshotChunkRequest
  ): QuirkydMigrationSnapshotChunkResult {
    const context = this[quirkydCatalogImportContext]
    return stageQuirkydMigrationSnapshotChunk({
      stagedManifest:
        stagedManifests(context.runtime.state).find(
          (manifest) => manifest.migrationId === request.migrationId
        ) ?? null,
      storage: context.runtime.terminalScrollbackSnapshotStorage,
      request
    })
  }

  stageQuirkydMigrationBlobChunk(
    request: QuirkydMigrationBlobChunkRequest
  ): QuirkydMigrationBlobChunkResult {
    const context = this[quirkydCatalogImportContext]
    return stageQuirkydMigrationBlobChunk({
      stagedManifest:
        stagedManifests(context.runtime.state).find(
          (manifest) => manifest.migrationId === request.migrationId
        ) ?? null,
      root: context.runtime.quirkydMigrationBlobRoot,
      request
    })
  }

  /** `expectedBlobs` absent (SSH, older senders) keeps the pre-blob-set commit unchanged. */
  commitStagedQuirkydMigrationCatalog(
    manifest: QuirkydMigrationManifest,
    options: { now?: () => Date; expectedBlobs?: readonly QuirkydMigrationBlobDescriptor[] } = {}
  ): QuirkydMigrationCatalogState {
    const context = this[quirkydCatalogImportContext]
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed') {
      return current
    }
    if (current.state !== 'staged') {
      throw new Error('quirkyd_migration_catalog_not_staged')
    }
    const prepared = prepareQuirkydMigrationCatalog(manifest, context.runtime.state)
    const blobRoot = context.runtime.quirkydMigrationBlobRoot
    assertQuirkydMigrationSnapshotsReady(
      manifest,
      context.runtime.terminalScrollbackSnapshotStorage
    )
    if (options.expectedBlobs) {
      assertQuirkydMigrationBlobSetMatches(manifest, blobRoot, options.expectedBlobs)
    }
    assertQuirkydMigrationBlobsReady(manifest, blobRoot)
    assertQuirkydMigrationBlobContentsValid(manifest, blobRoot)
    commitQuirkydMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    commitQuirkydMigrationBlobs(manifest, blobRoot)
    const receipt = commitPreparedCatalog(context, manifest, prepared, options.now)
    const generationBefore = context.runtime.writeGeneration
    scheduleSave(context.scheduling)
    recordQuirkydMigrationCommitWriteGeneration(context.runtime, manifest, generationBefore)
    return committedCatalogState(receipt)
  }

  abortStagedQuirkydMigrationCatalog(
    manifest: QuirkydMigrationManifest
  ): QuirkydMigrationCatalogAbortResult {
    const context = this[quirkydCatalogImportContext]
    const current = migrationCatalogState(context.runtime, manifest)
    if (current.state === 'committed' || current.state === 'absent') {
      return { ...current, aborted: false }
    }
    // Dormant import only: nothing but this stage references the staged rows before commit.
    context.runtime.state.quirkydMigrationStagedCatalogs = (
      context.runtime.state.quirkydMigrationStagedCatalogs ?? []
    ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
    abortQuirkydMigrationSnapshots(manifest, context.runtime.terminalScrollbackSnapshotStorage)
    abortQuirkydMigrationBlobs(manifest, context.runtime.quirkydMigrationBlobRoot)
    scheduleSave(context.scheduling)
    return { ...absentCatalogState(manifest), aborted: true }
  }

  /** For a source whose manifest no request can carry: this server's own copy stands in for it. */
  abortStagedQuirkydMigrationCatalogByReference(
    reference: QuirkydMigrationCatalogReference
  ): QuirkydMigrationCatalogReferenceAbortResult {
    return abortQuirkydMigrationCatalogByReference(
      this[quirkydCatalogImportContext].runtime.state,
      reference,
      (manifest) => this.abortStagedQuirkydMigrationCatalog(manifest)
    )
  }

  getQuirkydMigrationCatalogState(
    manifest: QuirkydMigrationManifest
  ): QuirkydMigrationCatalogState {
    const context = this[quirkydCatalogImportContext]
    return migrationCatalogState(context.runtime, manifest)
  }

  /** A migration into this server staged recently and neither committed nor aborted. */
  hasStagedQuirkydMigrationCatalog(now: number = Date.now()): boolean {
    return (
      this[quirkydCatalogImportContext].runtime.state.quirkydMigrationStagedCatalogs ?? []
    ).some((entry) => isLiveQuirkydMigrationStage(entry.stagedAt, now))
  }
}

function commitPreparedCatalog(
  context: QuirkydCatalogImportContext,
  manifest: QuirkydMigrationManifest,
  prepared: PreparedQuirkydMigrationCatalog,
  now?: () => Date
): QuirkydMigrationImportReceipt {
  applyPreparedQuirkydMigrationCatalog(prepared, context.runtime.state, context.repos)
  const receipt: QuirkydMigrationImportReceipt = {
    version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    source: structuredClone(manifest.source),
    importedAt: (now ?? (() => new Date()))().toISOString(),
    repositoryIds: prepared.repositories.map((repo) => repo.id),
    projectGroupIds: prepared.projectGroups.map((group) => group.id),
    folderWorkspaceIds: prepared.folderWorkspaces.map((workspace) => workspace.id)
  }
  context.runtime.state.quirkydMigrationStagedCatalogs = (
    context.runtime.state.quirkydMigrationStagedCatalogs ?? []
  ).filter((entry) => entry.manifest.migrationId !== manifest.migrationId)
  recordQuirkydMigrationImportReceipt(context.runtime.state, receipt)
  return receipt
}

function migrationCatalogState(
  runtime: QuirkydCatalogImportRuntime,
  manifest: QuirkydMigrationManifest
): QuirkydMigrationCatalogState {
  const { state } = runtime
  const receipt = findQuirkydMigrationImportReceipt(state, manifest)
  if (receipt) {
    assertCommittedReceipt(receipt, manifest)
    return committedCatalogState(receipt)
  }
  const staged = state.quirkydMigrationStagedCatalogs?.find(
    (entry) => entry.manifest.migrationId === manifest.migrationId
  )
  if (!staged) {
    return absentCatalogState(manifest)
  }
  assertSameQuirkydMigrationManifest(staged.manifest, manifest)
  return stagedCatalogState(manifest, staged.stagedAt, runtime)
}

/**
 * The receipt alone proves the commit: the server is live afterwards, so its rows and snapshot
 * files may legitimately change, and a later read must still say "committed".
 */
function assertCommittedReceipt(
  receipt: QuirkydMigrationImportReceipt,
  manifest: QuirkydMigrationManifest
): void {
  if (receipt.manifestSha256 !== manifest.manifestSha256) {
    throw new Error('quirkyd_migration_id_reused_with_different_manifest')
  }
  assertQuirkydMigrationReceiptMatchesManifest(receipt, manifest)
}

function absentCatalogState(manifest: QuirkydMigrationManifest): QuirkydMigrationCatalogState {
  return {
    state: 'absent',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256
  }
}

function stagedCatalogState(
  manifest: QuirkydMigrationManifest,
  stagedAt: string,
  runtime: QuirkydCatalogImportRuntime
): QuirkydMigrationCatalogState {
  const snapshotUploads = inspectQuirkydMigrationSnapshotUploads(
    manifest,
    runtime.terminalScrollbackSnapshotStorage
  )
  // Absent, not empty, when nothing is staged: the shape an older host already answers with.
  const blobUploads = inspectQuirkydMigrationBlobUploads(manifest, runtime.quirkydMigrationBlobRoot)
  return {
    state: 'staged',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    stagedAt,
    ...(snapshotUploads ? { snapshotUploads } : {}),
    ...(blobUploads ? { blobUploads } : {})
  }
}

function committedCatalogState(
  receipt: QuirkydMigrationImportReceipt
): QuirkydMigrationCatalogState {
  return {
    state: 'committed',
    migrationId: receipt.migrationId,
    manifestSha256: receipt.manifestSha256,
    receipt: structuredClone(receipt)
  }
}
