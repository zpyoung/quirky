import { createHash } from 'node:crypto'
import {
  quirkydMigrationManifestHashInput,
  serializeQuirkydMigrationValue,
  type QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'

export function computeQuirkydMigrationManifestSha256(
  manifest: Omit<QuirkydMigrationManifest, 'manifestSha256'>
): string {
  return createHash('sha256').update(quirkydMigrationManifestHashInput(manifest)).digest('hex')
}

/** Pass the manifest as received: a newer peer's unknown fields are part of what it signed. */
export function assertQuirkydMigrationManifestDigest(manifest: unknown): void {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('quirkyd_migration_manifest_invalid')
  }
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'manifestSha256')
  )
  const digest = createHash('sha256').update(serializeQuirkydMigrationValue(unsigned)).digest('hex')
  if (!('manifestSha256' in manifest) || digest !== manifest.manifestSha256) {
    throw new Error('quirkyd_migration_manifest_digest_mismatch')
  }
}
