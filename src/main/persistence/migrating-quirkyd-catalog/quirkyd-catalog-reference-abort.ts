import type {
  QuirkydMigrationCatalogAbortResult,
  QuirkydMigrationCatalogReference,
  QuirkydMigrationCatalogReferenceAbortResult,
  QuirkydMigrationManifest
} from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'

export function stagedManifests(state: StoreRuntimeState['state']): QuirkydMigrationManifest[] {
  return (state.quirkydMigrationStagedCatalogs ?? []).map((entry) => entry.manifest)
}

export function committedMigrations(
  state: StoreRuntimeState['state']
): { migrationId: string; manifestSha256: string }[] {
  return [
    ...(state.quirkydMigrationImportReceipts ?? []),
    ...(state.quirkydMigrationEvictedReceipts ?? [])
  ]
}

/**
 * Aborts by identity, with the stored manifest standing in for the one the source cannot send.
 * A commit wins over a stage, as it does for an abort that carries the manifest.
 */
export function abortQuirkydMigrationCatalogByReference(
  state: StoreRuntimeState['state'],
  reference: QuirkydMigrationCatalogReference,
  abortStaged: (manifest: QuirkydMigrationManifest) => QuirkydMigrationCatalogAbortResult
): QuirkydMigrationCatalogReferenceAbortResult {
  const identity = { migrationId: reference.migrationId, manifestSha256: reference.manifestSha256 }
  const committed = committedMigrations(state).find(
    (entry) => entry.migrationId === reference.migrationId
  )
  const staged = stagedManifests(state).find(
    (manifest) => manifest.migrationId === reference.migrationId
  )
  const held = committed ?? staged
  if (held && held.manifestSha256 !== reference.manifestSha256) {
    throw new Error('quirkyd_migration_id_reused_with_different_manifest')
  }
  if (committed) {
    return { ...identity, state: 'committed', aborted: false }
  }
  if (!staged) {
    return { ...identity, state: 'absent', aborted: false }
  }
  const result = abortStaged(staged)
  return {
    ...identity,
    state: result.state === 'committed' ? 'committed' : 'absent',
    aborted: result.aborted
  }
}
