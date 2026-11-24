/**
 * The server's record of which migrations it committed and which are still staged. A commit must
 * read as committed for as long as a client could ask, and an abandoned stage must not hold the
 * server awake or take a staging slot forever.
 */
import { MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import type {
  QuirkydMigrationImportReceipt,
  QuirkydMigrationManifest
} from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { MAX_QUIRKYD_MIGRATION_EVICTED_RECEIPTS } from '../../../shared/quirkyd-migration/quirkyd-migration-evicted-receipts'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  quirkydMigrationStagingKey,
  type QuirkydMigrationRequestIdentity
} from './quirkyd-migration-staged-file'

// A client resumes a stage within minutes; a week only covers a host left offline meanwhile.
export const QUIRKYD_MIGRATION_STAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function findQuirkydMigrationImportReceipt(
  state: PersistedState,
  manifest: QuirkydMigrationManifest
): QuirkydMigrationImportReceipt | undefined {
  const receipt = state.quirkydMigrationImportReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  if (receipt) {
    return receipt
  }
  const evicted = state.quirkydMigrationEvictedReceipts?.find(
    (entry) => entry.migrationId === manifest.migrationId
  )
  // Everything else a receipt holds is the manifest's own: rebuilt, it still checks against it.
  return evicted
    ? {
        version: manifest.version,
        migrationId: evicted.migrationId,
        manifestSha256: evicted.manifestSha256,
        source: structuredClone(manifest.source),
        importedAt: evicted.importedAt,
        repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
        projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
        folderWorkspaceIds: manifest.payload.folderWorkspaces.map((workspace) => workspace.id)
      }
    : undefined
}

/** Appends a receipt; one that ages out of the bounded list keeps its commit as a compact record. */
export function recordQuirkydMigrationImportReceipt(
  state: PersistedState,
  receipt: QuirkydMigrationImportReceipt
): void {
  const receipts = [...(state.quirkydMigrationImportReceipts ?? []), receipt]
  const overflow = receipts.length - MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS
  if (overflow > 0) {
    state.quirkydMigrationEvictedReceipts = [
      ...(state.quirkydMigrationEvictedReceipts ?? []),
      ...receipts.slice(0, overflow).map(({ migrationId, manifestSha256, importedAt }) => ({
        migrationId,
        manifestSha256,
        importedAt
      }))
    ].slice(-MAX_QUIRKYD_MIGRATION_EVICTED_RECEIPTS)
  }
  state.quirkydMigrationImportReceipts = receipts.slice(-MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS)
}

export function isLiveQuirkydMigrationStage(stagedAt: string, now: number): boolean {
  return now - Date.parse(stagedAt) < QUIRKYD_MIGRATION_STAGE_TTL_MS
}

/** Drops stages no client came back for; returns whether any went. */
export function expireQuirkydMigrationStages(state: PersistedState, now: number): boolean {
  const staged = state.quirkydMigrationStagedCatalogs ?? []
  const live = staged.filter((entry) => isLiveQuirkydMigrationStage(entry.stagedAt, now))
  if (live.length === staged.length) {
    return false
  }
  state.quirkydMigrationStagedCatalogs = live
  return true
}

export type QuirkydMigrationCommitGenerationRuntime = Pick<
  StoreRuntimeState,
  'writeGeneration' | 'lastDurableWriteGeneration' | 'quirkydMigrationCommitWriteGenerations'
>

/** Call right after the commit's `scheduleSave`; `generationBefore` is read just before it. */
export function recordQuirkydMigrationCommitWriteGeneration(
  runtime: QuirkydMigrationCommitGenerationRuntime,
  migration: QuirkydMigrationRequestIdentity,
  generationBefore: number
): void {
  // A save suppressed by quit or maintenance never bumps the generation, so no in-process write
  // can prove this commit; only a restart that reads it from disk does.
  runtime.quirkydMigrationCommitWriteGenerations.set(
    quirkydMigrationStagingKey(migration),
    runtime.writeGeneration > generationBefore ? runtime.writeGeneration : Number.POSITIVE_INFINITY
  )
}

/**
 * Whether the receipt is on disk. A catalog-state query can see an in-memory receipt whose flush
 * failed; consuming its received blobs then would leave a retry after restart without them.
 */
export function isQuirkydMigrationCommitDurable(
  runtime: QuirkydMigrationCommitGenerationRuntime,
  migration: QuirkydMigrationRequestIdentity
): boolean {
  const key = quirkydMigrationStagingKey(migration)
  const required = runtime.quirkydMigrationCommitWriteGenerations.get(key)
  if (required === undefined) {
    return true
  }
  if (runtime.lastDurableWriteGeneration < required) {
    return false
  }
  // Durable stays durable, so the entry is no longer needed.
  runtime.quirkydMigrationCommitWriteGenerations.delete(key)
  return true
}
