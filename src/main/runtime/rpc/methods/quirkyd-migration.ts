import type { z } from 'zod'
import {
  QuirkydMigrationCatalogParams,
  QuirkydMigrationCatalogReferenceParams,
  QuirkydMigrationCommitCatalogParams
} from '../../../../shared/rpc-contract/quirkyd-migration-params'
import { parseQuirkydMigrationManifest } from '../../../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import { QuirkydMigrationSnapshotChunkRequestSchema } from '../../../../shared/quirkyd-migration/quirkyd-migration-scrollback'
import { QuirkydMigrationBlobChunkRequestSchema } from '../../../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import { assertQuirkydMigrationManifestDigest } from '../../../quirkyd/quirkyd-migration-manifest-digest'
import { assertQuirkydMigrationSourceServedHere } from '../../../quirkyd/quirkyd-migration-wsl-destination'
import { defineMethod, type RpcContext } from '../core'

export const QUIRKYD_MIGRATION_METHODS = [
  defineMethod({
    name: 'quirkyd.migration.stageCatalog',
    permission: 'host-admin',
    params: QuirkydMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageQuirkydMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'quirkyd.migration.commitCatalog',
    permission: 'host-admin',
    params: QuirkydMigrationCommitCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.commitStagedQuirkydMigrationCatalog(migrationManifest(params), {
        signal: context.signal,
        ...(params.expectedBlobs ? { expectedBlobs: params.expectedBlobs } : {})
      })
    }
  }),
  defineMethod({
    name: 'quirkyd.migration.stageSnapshotChunk',
    permission: 'host-admin',
    params: QuirkydMigrationSnapshotChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageQuirkydMigrationSnapshotChunk(params)
    }
  }),
  // A separate method, not a field on stageSnapshotChunk: an older host would strip the field and
  // stage the bytes as a snapshot.
  defineMethod({
    name: 'quirkyd.migration.stageBlobChunk',
    permission: 'host-admin',
    params: QuirkydMigrationBlobChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageQuirkydMigrationBlobChunk(params)
    }
  }),
  defineMethod({
    name: 'quirkyd.migration.abortCatalog',
    permission: 'host-admin',
    params: QuirkydMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedQuirkydMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  // Why a reference: a source fenced on a manifest no request can carry must still be releasable.
  defineMethod({
    name: 'quirkyd.migration.abortCatalogByReference',
    permission: 'host-admin',
    params: QuirkydMigrationCatalogReferenceParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedQuirkydMigrationCatalogByReference(params, {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'quirkyd.migration.catalogState',
    permission: 'host-admin',
    params: QuirkydMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.getQuirkydMigrationCatalogState(migrationManifest(params))
    }
  })
]

function migrationManifest(params: z.infer<typeof QuirkydMigrationCatalogParams>) {
  const manifest = parseQuirkydMigrationManifest(params.manifest)
  // Raw, not parsed: parsing drops fields this host predates, which a newer client signed.
  assertQuirkydMigrationManifestDigest(params.manifest)
  assertQuirkydMigrationSourceServedHere(manifest.source)
  return manifest
}

function requireMigrationRuntimeClient(context: RpcContext): void {
  if (context.clientKind !== 'runtime' || !context.pairedDeviceId) {
    throw new Error('quirkyd_migration_runtime_client_required')
  }
}
