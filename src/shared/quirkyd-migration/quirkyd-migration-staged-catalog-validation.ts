import type { QuirkydMigrationStagedCatalog } from './quirkyd-migration-manifest'
import {
  QUIRKYD_MIGRATION_MANIFEST_VERSION,
  parseQuirkydMigrationManifest
} from './quirkyd-migration-manifest-validation'
import { isRecord } from './quirkyd-migration-manifest-fields'

export const MAX_QUIRKYD_MIGRATION_STAGED_CATALOGS = 4

export function normalizeQuirkydMigrationStagedCatalogs(
  value: unknown
): QuirkydMigrationStagedCatalog[] {
  if (!Array.isArray(value)) {
    return []
  }
  const staged: QuirkydMigrationStagedCatalog[] = []
  const seen = new Set<string>()
  for (let index = value.length - 1; index >= 0; index--) {
    try {
      const entry = parseStagedCatalog(value[index])
      if (!seen.has(entry.manifest.migrationId)) {
        seen.add(entry.manifest.migrationId)
        staged.push(entry)
        if (staged.length === MAX_QUIRKYD_MIGRATION_STAGED_CATALOGS) {
          break
        }
      }
    } catch {
      // Invalid staging cannot be trusted as fencing evidence, so it is dropped fail-closed.
    }
  }
  // Keep the migration journal runnable in the documented Node 18 rollback slot.
  return staged.reduceRight<QuirkydMigrationStagedCatalog[]>((reversed, entry) => {
    reversed.push(entry)
    return reversed
  }, [])
}

function parseStagedCatalog(value: unknown): QuirkydMigrationStagedCatalog {
  if (!isRecord(value) || value.version !== QUIRKYD_MIGRATION_MANIFEST_VERSION) {
    throw new Error('quirkyd_migration_staged_catalog_invalid')
  }
  const stagedAt = typeof value.stagedAt === 'string' ? value.stagedAt : ''
  if (!Number.isFinite(Date.parse(stagedAt))) {
    throw new Error('quirkyd_migration_staged_at_invalid')
  }
  return {
    version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
    manifest: parseQuirkydMigrationManifest(value.manifest),
    stagedAt
  }
}
