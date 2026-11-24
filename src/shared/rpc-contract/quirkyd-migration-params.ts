import { z } from 'zod'
import {
  MAX_QUIRKYD_MIGRATION_BLOBS,
  QuirkydMigrationBlobDescriptorSchema
} from '../quirkyd-migration/quirkyd-migration-blob-transfer'

// Why unknown: the handler parses and digest-checks the manifest itself, so a malformed one is
// refused with a migration error rather than a generic params failure.
export const QuirkydMigrationCatalogParams = z.object({ manifest: z.unknown() })

// Optional: sent only to a blob-channel destination, so SSH and older peers see `{ manifest }`.
export const QuirkydMigrationCommitCatalogParams = QuirkydMigrationCatalogParams.extend({
  expectedBlobs: z
    .array(QuirkydMigrationBlobDescriptorSchema)
    .max(MAX_QUIRKYD_MIGRATION_BLOBS)
    .optional()
})

// The manifest's identity alone, for a request the whole manifest would overflow.
export const QuirkydMigrationCatalogReferenceParams = z.object({
  migrationId: z.string().min(1).max(256),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/)
})
