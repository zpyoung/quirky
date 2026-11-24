import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuirkydMigrationBlobDescriptor } from '../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import type { QuirkydMigrationManifest } from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import {
  MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES,
  QUIRKYD_MIGRATION_MANIFEST_VERSION
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import {
  QUIRKYD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  QUIRKYD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY,
  QUIRKYD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
} from '../../shared/quirkyd-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const sendRequest = vi.hoisted(() => vi.fn())
const extraCapabilities = vi.hoisted((): string[] => [])
vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    pairing: unknown,
    method: string,
    params: unknown,
    _timeoutMs: number,
    validate: (response: unknown) => void
  ) => {
    validate({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: {
        capabilities: [
          QUIRKYD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
          QUIRKYD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
          'quirkyd.migration-blob.agent-session-records.v1',
          ...extraCapabilities
        ]
      }
    })
    return sendRequest(pairing, method, params)
  }
}))

const { commitRemoteQuirkydMigrationCatalog, stageRemoteQuirkydMigrationCatalog } =
  await import('./quirkyd-migration-catalog-client')
const {
  abortRemoteQuirkydMigrationCatalogByReference,
  QUIRKYD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED
} = await import('./quirkyd-migration-catalog-reference-client')

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

/** A manifest whose JSON is exactly `bytes` long. */
function manifestOfBytes(bytes: number): QuirkydMigrationManifest {
  const withLabel = (targetLabel: string): QuirkydMigrationManifest => ({
    version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-frame',
    createdAt: '2026-10-18T12:00:00.000Z',
    source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    manifestSha256: 'a'.repeat(64)
  })
  return withLabel('x'.repeat(bytes - JSON.stringify(withLabel('')).length))
}

const manyBlobs: QuirkydMigrationBlobDescriptor[] = Array.from({ length: 200 }, (_, index) => ({
  blobKind: 'agent-session-records',
  key: `session-${index}-${'s'.repeat(64)}`,
  sha256: 'c'.repeat(64),
  byteLength: 1024
}))

beforeEach(() => {
  vi.clearAllMocks()
  extraCapabilities.length = 0
  sendRequest.mockResolvedValue({
    ok: true,
    _meta: { runtimeId: 'runtime' },
    result: {
      state: 'staged',
      migrationId: 'migration-frame',
      manifestSha256: 'a'.repeat(64),
      stagedAt: '2026-10-18T12:00:00.000Z'
    }
  })
})

describe("quirkyd migration requests fit the host's sealed inbound frame", () => {
  it('stages a large manifest that still fits', async () => {
    await stageRemoteQuirkydMigrationCatalog(pairingCode, manifestOfBytes(760 * 1024))
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('refuses, unsent, a manifest at the validation cap: sealed, it overflows the 1 MiB frame', async () => {
    await expect(
      stageRemoteQuirkydMigrationCatalog(
        pairingCode,
        manifestOfBytes(MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES)
      )
    ).rejects.toThrow(/\(quirkyd_migration_manifest_too_large\)$/)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('refuses, unsent, a commit whose blob list pushes a fitting manifest past the frame', async () => {
    const manifest = manifestOfBytes(760 * 1024)
    await expect(
      commitRemoteQuirkydMigrationCatalog(pairingCode, manifest, { expectedBlobs: manyBlobs })
    ).rejects.toThrow(/too large to move to its Quirky server/)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('aborts a manifest no request can carry by its identity alone, durably', async () => {
    extraCapabilities.push(QUIRKYD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY)
    const manifest = manifestOfBytes(MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES)
    const identity = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ...identity, state: 'absent', aborted: true, durableAbsent: true }
    })
    await expect(
      abortRemoteQuirkydMigrationCatalogByReference(pairingCode, manifest)
    ).resolves.toEqual({ ...identity, state: 'absent', aborted: true, durableAbsent: true })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      'quirkyd.migration.abortCatalogByReference',
      identity
    )

    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ...identity, state: 'absent', aborted: true }
    })
    await expect(
      abortRemoteQuirkydMigrationCatalogByReference(pairingCode, manifest)
    ).rejects.toThrow('quirkyd_migration_catalog_abort_durability_invalid')
  })

  it('refuses, unsent, an abort by reference to a host that predates it', async () => {
    await expect(
      abortRemoteQuirkydMigrationCatalogByReference(
        pairingCode,
        manifestOfBytes(MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES)
      )
    ).rejects.toThrow(QUIRKYD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED)
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
