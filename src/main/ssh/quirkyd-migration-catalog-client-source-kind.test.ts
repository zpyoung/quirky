import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QUIRKYD_MIGRATION_MANIFEST_VERSION } from '../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import type { QuirkydMigrationManifest } from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { QUIRKYD_MIGRATION_SOURCE_KIND_UNKNOWN } from '../../shared/quirkyd-migration/quirkyd-migration-source-kind'
import {
  QUIRKYD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
  QUIRKYD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
} from '../../shared/quirkyd-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { computeQuirkydMigrationManifestSha256 } from '../quirkyd/quirkyd-migration-manifest-digest'

const sendRequest = vi.hoisted(() => vi.fn())
const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
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
      result: { capabilities: status.capabilities }
    })
    return sendRequest(pairing, method, params)
  }
}))

const {
  QUIRKYD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED,
  abortRemoteQuirkydMigrationCatalog,
  commitRemoteQuirkydMigrationCatalog,
  readRemoteQuirkydMigrationCatalogState,
  stageRemoteQuirkydMigrationCatalog
} = await import('./quirkyd-migration-catalog-client')

const OPERATIONS = [
  stageRemoteQuirkydMigrationCatalog,
  commitRemoteQuirkydMigrationCatalog,
  readRemoteQuirkydMigrationCatalogState,
  abortRemoteQuirkydMigrationCatalog
]

function sshManifest(): QuirkydMigrationManifest {
  const unsigned = {
    version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-kind',
    createdAt: '2026-10-01T00:00:00.000Z',
    source: { sshTargetId: 'ssh-prod', sshTargetGeneration: 7, targetLabel: 'Production' },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
  }
  return { ...unsigned, manifestSha256: computeQuirkydMigrationManifestSha256(unsigned) }
}

/** A WSL source, or any other `kind` as a newer or confused peer could put on the wire. */
function manifestOfKind(kind: string): QuirkydMigrationManifest {
  const source: QuirkydMigrationManifest['source'] = {
    kind: 'local-wsl',
    distro: 'Ubuntu',
    scopeRepoIds: [],
    scopeFolderWorkspaceIds: [],
    generation: 1
  }
  Object.assign(source, { kind })
  return { ...sshManifest(), source }
}

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

beforeEach(() => {
  vi.clearAllMocks()
  sendRequest.mockResolvedValue({ ok: false, error: { code: 'x', message: 'sent' } })
  // What an older destination advertises.
  status.capabilities = [QUIRKYD_MIGRATION_CATALOG_RUNTIME_CAPABILITY]
})

describe('quirkyd migration source-kind capability gate', () => {
  it.each(OPERATIONS)('sends an SSH manifest unchanged to an older destination', async (op) => {
    await expect(op(pairingCode, sshManifest())).rejects.toThrow('sent')
    expect(sendRequest).toHaveBeenCalledTimes(1)
    const params = sendRequest.mock.calls[0][2]
    expect(params).toEqual({ manifest: sshManifest() })
    expect(JSON.stringify(params)).not.toContain('"kind"')
  })

  it.each(OPERATIONS)('never sends a WSL manifest to an older destination', async (op) => {
    await expect(op(pairingCode, manifestOfKind('local-wsl'))).rejects.toThrow(
      QUIRKYD_MIGRATION_DESTINATION_SOURCE_KIND_UNSUPPORTED
    )
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it.each(OPERATIONS)('sends a WSL manifest once the destination advertises it', async (op) => {
    status.capabilities = [
      QUIRKYD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      QUIRKYD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
    ]
    await expect(op(pairingCode, manifestOfKind('local-wsl'))).rejects.toThrow('sent')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it.each(['ssh-relay', 'wsl', ''])(
    'refuses an unregistered kind %j before any request',
    async (kind) => {
      status.capabilities = [
        QUIRKYD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
        QUIRKYD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
      ]
      await expect(
        stageRemoteQuirkydMigrationCatalog(pairingCode, manifestOfKind(kind))
      ).rejects.toThrow(QUIRKYD_MIGRATION_SOURCE_KIND_UNKNOWN)
      expect(sendRequest).not.toHaveBeenCalled()
    }
  )
})
