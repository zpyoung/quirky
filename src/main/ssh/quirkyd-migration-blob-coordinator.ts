/**
 * Sending a migration's blobs to the destination in bounded, resumable chunks, beside the
 * manifest's scrollback snapshots. Every kind is checked against the destination's capabilities
 * before the first byte: a kind it cannot install is refused by name, never dropped. Offsets
 * resume from the destination's staged state, and a lost acknowledgement is confirmed by
 * re-reading that state, never assumed.
 */
import {
  QUIRKYD_MIGRATION_BLOB_CHUNK_BYTES,
  type QuirkydMigrationBlobChunkRequest,
  type QuirkydMigrationBlobChunkResult,
  type QuirkydMigrationBlobDescriptor,
  assertQuirkydMigrationBlobSet,
  findUnsupportedMigrationBlobKind,
  quirkydMigrationBlobIdentity,
  quirkydMigrationBlobKindUnsupportedBlocker,
  sameQuirkydMigrationBlob
} from '../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import type {
  QuirkydMigrationCatalogState,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'

export type QuirkydMigrationBlobSource = {
  /** Up to `maxBytes` bytes of the blob starting at `offset`, exactly as the descriptor hashed. */
  readChunk: (
    descriptor: QuirkydMigrationBlobDescriptor,
    offset: number,
    maxBytes: number
  ) => Promise<Buffer>
}

export type QuirkydMigrationBlobDestination = {
  readCapabilities: () => Promise<readonly string[]>
  readState: (manifest: QuirkydMigrationManifest) => Promise<QuirkydMigrationCatalogState>
  stageChunk: (
    request: QuirkydMigrationBlobChunkRequest
  ) => Promise<QuirkydMigrationBlobChunkResult>
}

export type QuirkydMigrationBlobTransfer = {
  source: QuirkydMigrationBlobSource
  manifest: QuirkydMigrationManifest
  blobs: readonly QuirkydMigrationBlobDescriptor[]
  destination: QuirkydMigrationBlobDestination
}

type StagedCatalogState = Extract<QuirkydMigrationCatalogState, { state: 'staged' }>

export async function transferQuirkydMigrationBlobs(
  transfer: QuirkydMigrationBlobTransfer
): Promise<void> {
  if (transfer.blobs.length === 0) {
    return
  }
  assertQuirkydMigrationBlobSet(transfer.blobs)
  const unsupported = findUnsupportedMigrationBlobKind(
    transfer.blobs,
    await transfer.destination.readCapabilities()
  )
  if (unsupported) {
    throw new Error(quirkydMigrationBlobKindUnsupportedBlocker(unsupported))
  }
  const offsets = receivedOffsets(transfer, await readStagedState(transfer))
  for (const blob of transfer.blobs) {
    let offset = offsets.get(quirkydMigrationBlobIdentity(blob)) ?? 0
    while (offset < blob.byteLength) {
      const bytes = await transfer.source.readChunk(
        blob,
        offset,
        Math.min(QUIRKYD_MIGRATION_BLOB_CHUNK_BYTES, blob.byteLength - offset)
      )
      if (
        bytes.length === 0 ||
        bytes.length > QUIRKYD_MIGRATION_BLOB_CHUNK_BYTES ||
        offset + bytes.length > blob.byteLength
      ) {
        throw new Error(`quirkyd_migration_source_blob_changed:${blob.blobKind}`)
      }
      const request: QuirkydMigrationBlobChunkRequest = {
        migrationId: transfer.manifest.migrationId,
        manifestSha256: transfer.manifest.manifestSha256,
        blob: { ...blob },
        offset,
        bytesBase64: bytes.toString('base64')
      }
      offset = await stageChunkWithRecovery(transfer, request, offset + bytes.length)
    }
  }
  assertAllReceived(transfer, await readStagedState(transfer))
}

async function readStagedState(
  transfer: QuirkydMigrationBlobTransfer
): Promise<StagedCatalogState> {
  const state = await transfer.destination.readState(transfer.manifest)
  if (state.state !== 'staged') {
    throw new Error('quirkyd_migration_blob_catalog_not_staged')
  }
  return state
}

function receivedOffsets(
  transfer: QuirkydMigrationBlobTransfer,
  state: StagedCatalogState
): Map<string, number> {
  const wanted = new Map(transfer.blobs.map((blob) => [quirkydMigrationBlobIdentity(blob), blob]))
  const offsets = new Map<string, number>()
  for (const upload of state.blobUploads ?? []) {
    const blob = wanted.get(quirkydMigrationBlobIdentity(upload))
    // A staged key with other bytes is a different capture; restaging it would mix the two.
    if (!blob || !sameQuirkydMigrationBlob(blob, upload)) {
      throw new Error(`quirkyd_migration_blob_descriptor_conflict:${upload.blobKind}`)
    }
    offsets.set(quirkydMigrationBlobIdentity(upload), upload.receivedBytes)
  }
  return offsets
}

function assertAllReceived(
  transfer: QuirkydMigrationBlobTransfer,
  state: StagedCatalogState
): void {
  const received = receivedOffsets(transfer, state)
  for (const blob of transfer.blobs) {
    if (received.get(quirkydMigrationBlobIdentity(blob)) !== blob.byteLength) {
      throw new Error(`quirkyd_migration_blob_transfer_incomplete:${blob.blobKind}`)
    }
  }
}

async function stageChunkWithRecovery(
  transfer: QuirkydMigrationBlobTransfer,
  request: QuirkydMigrationBlobChunkRequest,
  expectedOffset: number
): Promise<number> {
  try {
    const result = await transfer.destination.stageChunk(request)
    if (result.receivedBytes !== expectedOffset) {
      throw new Error('quirkyd_migration_blob_ack_invalid')
    }
    return result.receivedBytes
  } catch (error) {
    try {
      const observed = await transfer.destination.readState(transfer.manifest)
      const received =
        observed.state === 'staged'
          ? observed.blobUploads?.find(
              (entry) =>
                quirkydMigrationBlobIdentity(entry) === quirkydMigrationBlobIdentity(request.blob)
            )?.receivedBytes
          : undefined
      if (received === expectedOffset) {
        return received
      }
    } catch {
      // The chunk stays unverifiable; report the first failure.
    }
    throw error
  }
}
