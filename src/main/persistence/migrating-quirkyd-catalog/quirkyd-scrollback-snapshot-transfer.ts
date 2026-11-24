import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import {
  decodeQuirkydMigrationSnapshotChunk,
  type QuirkydMigrationSnapshotChunkRequest,
  type QuirkydMigrationSnapshotChunkResult,
  type QuirkydMigrationSnapshotUploadState,
  type QuirkydMigrationTerminalScrollbackSnapshot
} from '../../../shared/quirkyd-migration/quirkyd-migration-scrollback'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getTerminalScrollbackSnapshotPath,
  getTerminalScrollbackSnapshotRoot,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import {
  appendQuirkydMigrationStagedChunk,
  ensureQuirkydMigrationDirectory,
  inspectQuirkydMigrationFinalFile,
  linkQuirkydMigrationStagedFile,
  quirkydMigrationFileMatches,
  quirkydMigrationStagedFileSize,
  quirkydMigrationStagingDirectory,
  pruneQuirkydMigrationStagingDirectories,
  removeQuirkydMigrationStagingDirectory,
  requireStagedQuirkydMigrationManifest
} from './quirkyd-migration-staged-file'

/**
 * Destination side: append one verified chunk to the staging file for a snapshot the staged
 * manifest names. `stagedManifest` is the manifest the importer accepted; a request for any
 * other migration or digest is refused. Retries of an already-written range must match it.
 */
export function stageQuirkydMigrationSnapshotChunk(args: {
  stagedManifest: QuirkydMigrationManifest | null
  storage: TerminalScrollbackSnapshotStorage
  request: QuirkydMigrationSnapshotChunkRequest
}): QuirkydMigrationSnapshotChunkResult {
  const manifest = requireStagedQuirkydMigrationManifest(
    args.stagedManifest,
    args.request,
    'quirkyd_migration_snapshot_catalog_not_staged'
  )
  const descriptor = requireDescriptor(manifest, args.request.ref)
  const bytes = decodeQuirkydMigrationSnapshotChunk(args.request.bytesBase64)
  ensureQuirkydMigrationDirectory(stagingDirectory(args.storage, manifest))
  const acknowledgedOffset = appendQuirkydMigrationStagedChunk({
    channel: 'snapshot',
    path: stagedSnapshotPath(args.storage, manifest, descriptor),
    offset: args.request.offset,
    bytes,
    byteLength: descriptor.byteLength
  })
  return {
    migrationId: args.request.migrationId,
    manifestSha256: args.request.manifestSha256,
    ref: args.request.ref,
    acknowledgedOffset
  }
}

export function inspectQuirkydMigrationSnapshotUploads(
  manifest: QuirkydMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): QuirkydMigrationSnapshotUploadState[] | undefined {
  const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  if (snapshots.length === 0) {
    return undefined
  }
  return snapshots.map((descriptor) => ({
    ...descriptor,
    receivedBytes:
      inspectFinalSnapshot(storage, descriptor) === 'matching'
        ? descriptor.byteLength
        : quirkydMigrationStagedFileSize(
            stagedSnapshotPath(storage, manifest, descriptor),
            descriptor.byteLength
          )
  }))
}

export function assertQuirkydMigrationSnapshotsReady(
  manifest: QuirkydMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  for (const upload of inspectQuirkydMigrationSnapshotUploads(manifest, storage) ?? []) {
    const finalStatus = inspectFinalSnapshot(storage, upload)
    if (finalStatus === 'conflict') {
      throw new Error(`quirkyd_migration_snapshot_destination_conflict:${upload.ref}`)
    }
    if (upload.receivedBytes !== upload.byteLength) {
      throw new Error(`quirkyd_migration_snapshot_incomplete:${upload.ref}`)
    }
    const path =
      finalStatus === 'matching'
        ? getTerminalScrollbackSnapshotPath(upload.ref, storage)
        : stagedSnapshotPath(storage, manifest, upload)
    if (!path || !quirkydMigrationFileMatches(path, upload)) {
      throw new Error(`quirkyd_migration_snapshot_digest_mismatch:${upload.ref}`)
    }
  }
}

export function commitQuirkydMigrationSnapshots(
  manifest: QuirkydMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  assertQuirkydMigrationSnapshotsReady(manifest, storage)
  const root = getTerminalScrollbackSnapshotRoot(storage)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const descriptor of snapshots) {
    const finalPath = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
    if (!finalPath) {
      throw new Error('quirkyd_migration_snapshot_ref_invalid')
    }
    linkQuirkydMigrationStagedFile({
      stagedPath: stagedSnapshotPath(storage, manifest, descriptor),
      finalPath,
      expected: descriptor,
      conflictError: `quirkyd_migration_snapshot_destination_conflict:${descriptor.ref}`
    })
  }
  syncDirectoryDurablySync(root)
  removeQuirkydMigrationStagingDirectory(root, manifest)
}

export function abortQuirkydMigrationSnapshots(
  manifest: QuirkydMigrationManifest,
  storage: TerminalScrollbackSnapshotStorage
): void {
  removeQuirkydMigrationStagingDirectory(getTerminalScrollbackSnapshotRoot(storage), manifest)
}

/** Removes staging for every migration the importer no longer holds staged. */
export function pruneQuirkydMigrationSnapshotStaging(
  stagedManifests: readonly QuirkydMigrationManifest[],
  storage: TerminalScrollbackSnapshotStorage
): void {
  pruneQuirkydMigrationStagingDirectories(
    getTerminalScrollbackSnapshotRoot(storage),
    stagedManifests
  )
}

function requireDescriptor(
  manifest: QuirkydMigrationManifest,
  ref: string
): QuirkydMigrationTerminalScrollbackSnapshot {
  const descriptor = manifest.payload.dormantState?.terminalScrollbackSnapshots?.find(
    (entry) => entry.ref === ref
  )
  if (!descriptor) {
    throw new Error('quirkyd_migration_snapshot_unknown')
  }
  return descriptor
}

function inspectFinalSnapshot(
  storage: TerminalScrollbackSnapshotStorage,
  descriptor: QuirkydMigrationTerminalScrollbackSnapshot
): 'absent' | 'matching' | 'conflict' {
  return inspectQuirkydMigrationFinalFile(
    getTerminalScrollbackSnapshotPath(descriptor.ref, storage),
    descriptor
  )
}

function stagingDirectory(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: QuirkydMigrationManifest
): string {
  return quirkydMigrationStagingDirectory(getTerminalScrollbackSnapshotRoot(storage), manifest)
}

function stagedSnapshotPath(
  storage: TerminalScrollbackSnapshotStorage,
  manifest: QuirkydMigrationManifest,
  descriptor: QuirkydMigrationTerminalScrollbackSnapshot
): string {
  return join(stagingDirectory(storage, manifest), `${descriptor.ref}.${descriptor.sha256}.part`)
}
