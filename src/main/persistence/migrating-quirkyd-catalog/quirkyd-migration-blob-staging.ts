/**
 * Destination side of the migration blob channel. Blobs are not named by the signed manifest, so
 * a staged file's name carries its whole descriptor (`<key>.<sha256>.<byteLength>.part` under a
 * per-kind directory) and the staged set is read back from disk after a restart. At catalog commit
 * every staged blob must be complete and digest-exact, then moves to the migration's received
 * directory; installing received blobs into live state is each kind's installer (D1b-6b/6c).
 */
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  QUIRKYD_MIGRATION_BLOB_KINDS,
  assertQuirkydMigrationBlobSet,
  decodeQuirkydMigrationBlobChunk,
  quirkydMigrationBlobIdentity,
  parseQuirkydMigrationBlobDescriptor,
  sameQuirkydMigrationBlob,
  type QuirkydMigrationBlobChunkRequest,
  type QuirkydMigrationBlobChunkResult,
  type QuirkydMigrationBlobDescriptor,
  type QuirkydMigrationBlobKind,
  type QuirkydMigrationBlobUploadState
} from '../../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  appendQuirkydMigrationStagedChunk,
  ensureQuirkydMigrationDirectory,
  inspectQuirkydMigrationFinalFile,
  linkQuirkydMigrationStagedFile,
  quirkydMigrationFileMatches,
  quirkydMigrationStagedFileSize,
  quirkydMigrationStagingDirectory,
  quirkydMigrationStagingKey,
  pruneQuirkydMigrationKeyedDirectories,
  pruneQuirkydMigrationStagingDirectories,
  removeQuirkydMigrationStagingDirectory,
  requireStagedQuirkydMigrationManifest,
  type QuirkydMigrationRequestIdentity
} from './quirkyd-migration-staged-file'

const RECEIVED_DIRECTORY = 'received'
const STAGED_BLOB_NAME = /^([^.]+)\.([a-f0-9]{64})\.([1-9][0-9]*)\.part$/

type QuirkydMigrationBlobName = Pick<QuirkydMigrationBlobDescriptor, 'blobKind' | 'key'>

type ReceivedBlobPathResolver = (
  root: string,
  manifest: QuirkydMigrationRequestIdentity,
  descriptor: QuirkydMigrationBlobName
) => string

const receivedDirectoryPath: ReceivedBlobPathResolver = (root, manifest, descriptor) =>
  join(receivedBlobsDirectory(root, manifest), descriptor.blobKind, descriptor.key)

/** Where each kind lands at commit; every kind waits in the received directory for its installer. */
const RECEIVED_BLOB_DESTINATIONS: Record<QuirkydMigrationBlobKind, ReceivedBlobPathResolver> = {
  'terminal-restore-hints': receivedDirectoryPath,
  'shell-history': receivedDirectoryPath,
  'agent-session-records': receivedDirectoryPath
}

export function getQuirkydMigrationReceivedBlobPath(
  root: string,
  manifest: QuirkydMigrationRequestIdentity,
  descriptor: QuirkydMigrationBlobName
): string {
  return RECEIVED_BLOB_DESTINATIONS[descriptor.blobKind](root, manifest, descriptor)
}

/** Names in a committed migration's received directory for `blobKind`; the caller checks the key. */
export function listQuirkydMigrationReceivedBlobNames(
  root: string,
  manifest: QuirkydMigrationRequestIdentity,
  blobKind: QuirkydMigrationBlobKind
): string[] {
  return readDirectory(join(receivedBlobsDirectory(root, manifest), blobKind))
}

export type QuirkydMigrationBlobChunkStaging = {
  /** The manifest the importer holds staged for this migration, if any. */
  stagedManifest: QuirkydMigrationManifest | null
  root: string
  request: QuirkydMigrationBlobChunkRequest
}

export function stageQuirkydMigrationBlobChunk(
  args: QuirkydMigrationBlobChunkStaging
): QuirkydMigrationBlobChunkResult {
  const manifest = requireStagedQuirkydMigrationManifest(
    args.stagedManifest,
    args.request,
    'quirkyd_migration_blob_catalog_not_staged'
  )
  const descriptor = parseQuirkydMigrationBlobDescriptor(args.request.blob)
  const bytes = decodeQuirkydMigrationBlobChunk(args.request.bytesBase64)
  const staged = stagedBlobDescriptors(args.root, manifest)
  const existing = staged.find(
    (entry) => quirkydMigrationBlobIdentity(entry) === quirkydMigrationBlobIdentity(descriptor)
  )
  if (existing && !sameQuirkydMigrationBlob(existing, descriptor)) {
    // Never replace bytes already staged under this key; the sender aborts and restages instead.
    throw new Error(`quirkyd_migration_blob_descriptor_conflict:${descriptor.blobKind}`)
  }
  if (!existing) {
    assertQuirkydMigrationBlobSet([...staged, descriptor])
  }
  const path = stagedBlobPath(args.root, manifest, descriptor)
  ensureQuirkydMigrationDirectory(dirname(path))
  const receivedBytes = appendQuirkydMigrationStagedChunk({
    channel: 'blob',
    path,
    offset: args.request.offset,
    bytes,
    byteLength: descriptor.byteLength
  })
  return {
    migrationId: args.request.migrationId,
    manifestSha256: args.request.manifestSha256,
    blobKind: descriptor.blobKind,
    key: descriptor.key,
    receivedBytes
  }
}

export function inspectQuirkydMigrationBlobUploads(
  manifest: QuirkydMigrationManifest,
  root: string
): QuirkydMigrationBlobUploadState[] | undefined {
  const uploads = stagedBlobDescriptors(root, manifest).map((descriptor) => ({
    ...descriptor,
    receivedBytes:
      inspectReceivedBlob(root, manifest, descriptor) === 'matching'
        ? descriptor.byteLength
        : quirkydMigrationStagedFileSize(
            stagedBlobPath(root, manifest, descriptor),
            descriptor.byteLength
          )
  }))
  return uploads.length > 0 ? uploads : undefined
}

export function assertQuirkydMigrationBlobsReady(
  manifest: QuirkydMigrationManifest,
  root: string
): void {
  for (const upload of inspectQuirkydMigrationBlobUploads(manifest, root) ?? []) {
    const label = `${upload.blobKind}:${upload.key}`
    const finalStatus = inspectReceivedBlob(root, manifest, upload)
    if (finalStatus === 'conflict') {
      throw new Error(`quirkyd_migration_blob_destination_conflict:${label}`)
    }
    if (upload.receivedBytes !== upload.byteLength) {
      throw new Error(`quirkyd_migration_blob_incomplete:${label}`)
    }
    if (
      finalStatus !== 'matching' &&
      !quirkydMigrationFileMatches(stagedBlobPath(root, manifest, upload), upload)
    ) {
      throw new Error(`quirkyd_migration_blob_digest_mismatch:${label}`)
    }
  }
}

/**
 * Each still-staged blob's verified file; one an earlier attempt already moved was checked then.
 * Only meaningful after `assertQuirkydMigrationBlobsReady` in the same synchronous turn.
 */
export function stagedQuirkydMigrationBlobFiles(
  manifest: QuirkydMigrationManifest,
  root: string
): { descriptor: QuirkydMigrationBlobDescriptor; path: string }[] {
  return stagedBlobDescriptors(root, manifest).map((descriptor) => ({
    descriptor,
    path: stagedBlobPath(root, manifest, descriptor)
  }))
}

/**
 * Refuses commit unless the staged and already-received blobs are exactly the set the sender
 * moved, so a blob lost on the way (or left from another capture) fails instead of vanishing.
 */
export function assertQuirkydMigrationBlobSetMatches(
  manifest: QuirkydMigrationManifest,
  root: string,
  expected: readonly QuirkydMigrationBlobDescriptor[]
): void {
  assertQuirkydMigrationBlobSet(expected)
  const wanted = new Map(expected.map((entry) => [quirkydMigrationBlobIdentity(entry), entry]))
  const staged = stagedBlobDescriptors(root, manifest)
  const stagedIds = new Set(staged.map(quirkydMigrationBlobIdentity))
  for (const descriptor of staged) {
    const match = wanted.get(quirkydMigrationBlobIdentity(descriptor))
    if (!match || !sameQuirkydMigrationBlob(match, descriptor)) {
      throw blobSetMismatch(descriptor)
    }
  }
  for (const identity of receivedBlobIdentities(root, manifest)) {
    if (!wanted.has(identity)) {
      throw new Error('quirkyd_migration_blob_set_mismatch')
    }
  }
  for (const descriptor of expected) {
    // An earlier commit attempt may already have moved it; the received bytes must still match.
    if (
      !stagedIds.has(quirkydMigrationBlobIdentity(descriptor)) &&
      inspectReceivedBlob(root, manifest, descriptor) !== 'matching'
    ) {
      throw blobSetMismatch(descriptor)
    }
  }
}

/**
 * The caller must run `assertQuirkydMigrationBlobsReady` first, in the same synchronous turn: that
 * pass hashes every staged file, and no chunk can land between it and these links.
 */
export function commitQuirkydMigrationBlobs(
  manifest: QuirkydMigrationManifest,
  root: string
): void {
  const directories = new Set<string>()
  for (const descriptor of stagedBlobDescriptors(root, manifest)) {
    const finalPath = getQuirkydMigrationReceivedBlobPath(root, manifest, descriptor)
    ensureQuirkydMigrationDirectory(dirname(finalPath))
    linkQuirkydMigrationStagedFile({
      stagedPath: stagedBlobPath(root, manifest, descriptor),
      finalPath,
      expected: descriptor,
      conflictError: `quirkyd_migration_blob_destination_conflict:${descriptor.blobKind}:${descriptor.key}`
    })
    directories.add(dirname(finalPath))
  }
  for (const directory of directories) {
    syncDirectoryDurablySync(directory)
  }
  removeQuirkydMigrationStagingDirectory(root, manifest)
}

/** Also drops blobs a failed commit already moved: the catalog they belonged to never landed. */
export function abortQuirkydMigrationBlobs(manifest: QuirkydMigrationManifest, root: string): void {
  removeQuirkydMigrationStagingDirectory(root, manifest)
  rmSync(receivedBlobsDirectory(root, manifest), { recursive: true, force: true })
}

/** Received blobs stay only for staged or committed migrations; a failed commit's are dropped. */
export function pruneQuirkydMigrationBlobStaging(
  stagedManifests: readonly QuirkydMigrationManifest[],
  committedMigrations: readonly QuirkydMigrationRequestIdentity[],
  root: string
): void {
  pruneQuirkydMigrationStagingDirectories(root, stagedManifests)
  pruneQuirkydMigrationKeyedDirectories(join(root, RECEIVED_DIRECTORY), [
    ...stagedManifests,
    ...committedMigrations
  ])
}

function blobSetMismatch(descriptor: QuirkydMigrationBlobDescriptor): Error {
  return new Error(`quirkyd_migration_blob_set_mismatch:${descriptor.blobKind}:${descriptor.key}`)
}

function receivedBlobIdentities(root: string, manifest: QuirkydMigrationManifest): string[] {
  const received = receivedBlobsDirectory(root, manifest)
  return QUIRKYD_MIGRATION_BLOB_KINDS.flatMap((blobKind) =>
    readDirectory(join(received, blobKind)).map((key) =>
      quirkydMigrationBlobIdentity({ blobKind, key })
    )
  )
}

function stagedBlobDescriptors(
  root: string,
  manifest: QuirkydMigrationManifest
): QuirkydMigrationBlobDescriptor[] {
  const staging = quirkydMigrationStagingDirectory(root, manifest)
  const descriptors: QuirkydMigrationBlobDescriptor[] = []
  for (const blobKind of QUIRKYD_MIGRATION_BLOB_KINDS) {
    for (const name of readDirectory(join(staging, blobKind))) {
      const match = STAGED_BLOB_NAME.exec(name)
      if (!match) {
        continue
      }
      try {
        descriptors.push(
          parseQuirkydMigrationBlobDescriptor({
            blobKind,
            key: match[1],
            sha256: match[2],
            byteLength: Number(match[3])
          })
        )
      } catch {
        // Not a name this channel writes; it cannot belong to the staged set.
      }
    }
  }
  return descriptors
}

function readDirectory(path: string): string[] {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

function inspectReceivedBlob(
  root: string,
  manifest: QuirkydMigrationManifest,
  descriptor: QuirkydMigrationBlobDescriptor
): 'absent' | 'matching' | 'conflict' {
  return inspectQuirkydMigrationFinalFile(
    getQuirkydMigrationReceivedBlobPath(root, manifest, descriptor),
    descriptor
  )
}

function receivedBlobsDirectory(root: string, manifest: QuirkydMigrationRequestIdentity): string {
  return join(root, RECEIVED_DIRECTORY, quirkydMigrationStagingKey(manifest))
}

function stagedBlobPath(
  root: string,
  manifest: QuirkydMigrationManifest,
  descriptor: QuirkydMigrationBlobDescriptor
): string {
  return join(
    quirkydMigrationStagingDirectory(root, manifest),
    descriptor.blobKind,
    `${descriptor.key}.${descriptor.sha256}.${descriptor.byteLength}.part`
  )
}
