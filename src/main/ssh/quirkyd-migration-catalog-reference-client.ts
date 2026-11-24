import { parseQuirkydMigrationCatalogReferenceAbortResult } from '../../shared/quirkyd-migration/quirkyd-migration-catalog-state'
import type {
  QuirkydMigrationCatalogReferenceAbortResult,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { QUIRKYD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY } from '../../shared/quirkyd-runtime-capabilities'
import { parsePairingCode } from '../../shared/pairing'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  QUIRKYD_MIGRATION_DESTINATION_UNSUPPORTED,
  sendSupportedMigrationRequest,
  type CatalogRequestOptions
} from './quirkyd-migration-catalog-client'

/** Not the release evidence `QUIRKYD_MIGRATION_DESTINATION_UNSUPPORTED` is: the host may hold a stage. */
export const QUIRKYD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED =
  'quirkyd_migration_destination_abort_by_reference_unsupported:Update Quirky on this host to cancel this move.'

/** Sends only the manifest's identity, for a manifest whose whole request would overflow the frame. */
export async function abortRemoteQuirkydMigrationCatalogByReference(
  pairingCode: string,
  manifest: QuirkydMigrationManifest,
  options: CatalogRequestOptions = {}
): Promise<QuirkydMigrationCatalogReferenceAbortResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('quirkyd_migration_pairing_code_invalid')
  }
  let supportsReference = false
  let response: RuntimeRpcResponse<unknown>
  try {
    response = await sendSupportedMigrationRequest(
      pairing,
      'quirkyd.migration.abortCatalogByReference',
      { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 },
      options,
      false,
      null,
      (capabilities) => {
        supportsReference = capabilities.includes(
          QUIRKYD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY
        )
        if (!supportsReference) {
          throw new Error(QUIRKYD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED)
        }
      }
    )
  } catch (error) {
    // A missing method on a host that advertised it proves nothing about what it staged.
    if (
      supportsReference &&
      error instanceof Error &&
      error.message === QUIRKYD_MIGRATION_DESTINATION_UNSUPPORTED
    ) {
      throw new Error(QUIRKYD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED)
    }
    throw error
  }
  if (!response.ok) {
    throw new Error(`quirkyd_migration_abort_failed:${response.error.message}`)
  }
  return parseQuirkydMigrationCatalogReferenceAbortResult(response.result, manifest)
}
