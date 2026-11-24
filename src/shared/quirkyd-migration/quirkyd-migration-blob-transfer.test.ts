import { describe, expect, it } from 'vitest'
import {
  MAX_QUIRKYD_MIGRATION_BLOB_TOTAL_BYTES,
  QUIRKYD_MIGRATION_BLOB_KIND_CONTRACTS,
  QuirkydMigrationBlobChunkRequestSchema,
  QuirkydMigrationBlobDescriptorSchema,
  advertisedQuirkydMigrationBlobCapabilities,
  assertQuirkydMigrationBlobSet,
  findUnsupportedMigrationBlobKind,
  quirkydMigrationBlobKindUnsupportedBlocker,
  parseQuirkydMigrationBlobChunkResult,
  parseQuirkydMigrationBlobDescriptor,
  parseQuirkydMigrationBlobUploadStates,
  requiredMigrationBlobCapabilities,
  type QuirkydMigrationBlobDescriptor
} from './quirkyd-migration-blob-transfer'
import { parseQuirkydMigrationCatalogState } from './quirkyd-migration-catalog-state'
import { QUIRKYD_MIGRATION_MANIFEST_VERSION } from './quirkyd-migration-manifest-validation'
import type { QuirkydMigrationManifest } from './quirkyd-migration-manifest'
import { QUIRKYD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY } from '../quirkyd-runtime-capabilities'

const HASH = 'a'.repeat(16)
const DIGEST = 'b'.repeat(64)

function blob(
  overrides: Partial<QuirkydMigrationBlobDescriptor> = {}
): QuirkydMigrationBlobDescriptor {
  return {
    blobKind: 'shell-history',
    key: `${HASH}-zsh`,
    sha256: DIGEST,
    byteLength: 10,
    ...overrides
  }
}

const manifest: QuirkydMigrationManifest = {
  version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
  migrationId: 'migration-1',
  manifestSha256: 'c'.repeat(64),
  createdAt: '2026-08-30T12:00:00.000Z',
  source: { sshTargetId: 'ssh-prod', sshTargetGeneration: 7, targetLabel: 'Production' },
  payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
}

describe('quirkyd migration blob contract', () => {
  it.each([
    ['terminal-restore-hints', 'migration', true],
    ['terminal-restore-hints', HASH, false],
    ['shell-history', `${HASH}-bash`, true],
    ['shell-history', `${HASH}-fish`, true],
    ['shell-history', `${HASH}-pwsh`, false],
    ['shell-history', `${'A'.repeat(16)}-zsh`, false],
    ['shell-history', `${HASH}.zsh`, false],
    ['agent-session-records', '0f8e2c1a-7b3d-4e5f-9a0b-1c2d3e4f5a6b', true],
    ['agent-session-records', 'Session-Mixed-Case', false],
    ['agent-session-records', '../escape', false],
    ['agent-session-records', 'a.b', false],
    ['agent-session-records', 'x'.repeat(129), false],
    // Windows device names: one with any extension is the device too.
    ['agent-session-records', 'con', false],
    ['agent-session-records', 'prn', false],
    ['agent-session-records', 'aux', false],
    ['agent-session-records', 'nul', false],
    ['agent-session-records', 'com0', false],
    ['agent-session-records', 'com9', false],
    ['agent-session-records', 'lpt1', false],
    ['agent-session-records', 'console', true],
    ['agent-session-records', 'com10', true],
    ['agent-session-records', 'nul-1', true]
  ] as const)('%s key %s valid=%s', (blobKind, key, valid) => {
    const parse = () => parseQuirkydMigrationBlobDescriptor(blob({ blobKind, key }))
    if (valid) {
      expect(parse().key).toBe(key)
    } else {
      expect(parse).toThrow('quirkyd_migration_blob_key_invalid')
    }
  })

  it('enforces per-kind byte caps, a non-empty body, and the set caps', () => {
    const cap = QUIRKYD_MIGRATION_BLOB_KIND_CONTRACTS['terminal-restore-hints'].maxBytes
    const hints = blob({ blobKind: 'terminal-restore-hints', key: 'migration' })
    expect(parseQuirkydMigrationBlobDescriptor({ ...hints, byteLength: cap }).byteLength).toBe(cap)
    expect(() => parseQuirkydMigrationBlobDescriptor({ ...hints, byteLength: cap + 1 })).toThrow(
      'quirkyd_migration_blob_too_large'
    )
    expect(() => parseQuirkydMigrationBlobDescriptor(blob({ byteLength: 0 }))).toThrow()
    expect(() => assertQuirkydMigrationBlobSet([blob(), blob({ sha256: 'd'.repeat(64) })])).toThrow(
      'quirkyd_migration_blob_duplicate'
    )
    const big = QUIRKYD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].maxBytes
    const many = Array.from({ length: MAX_QUIRKYD_MIGRATION_BLOB_TOTAL_BYTES / big + 1 }, (_, i) =>
      blob({ key: `${i.toString(16).padStart(16, '0')}-zsh`, byteLength: big })
    )
    expect(() => assertQuirkydMigrationBlobSet(many)).toThrow('quirkyd_migration_blobs_too_large')
  })

  it('requires the channel plus each sent kind, and names the first missing kind', () => {
    const hints = blob({ blobKind: 'terminal-restore-hints', key: 'migration' })
    expect(requiredMigrationBlobCapabilities([])).toEqual([])
    expect(requiredMigrationBlobCapabilities([blob(), hints, blob()])).toEqual([
      QUIRKYD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
      'quirkyd.migration-blob.terminal-restore-hints.v1',
      'quirkyd.migration-blob.shell-history.v1'
    ])
    const all = requiredMigrationBlobCapabilities([blob(), hints])
    expect(findUnsupportedMigrationBlobKind([blob(), hints], all)).toBeNull()
    expect(
      findUnsupportedMigrationBlobKind(
        [blob(), hints],
        all.filter((entry) => entry !== QUIRKYD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY)
      )
    ).toBe('shell-history')
    expect(
      findUnsupportedMigrationBlobKind(
        [blob(), hints],
        [
          QUIRKYD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
          'quirkyd.migration-blob.shell-history.v1'
        ]
      )
    ).toBe('terminal-restore-hints')
    expect(quirkydMigrationBlobKindUnsupportedBlocker('shell-history')).toMatch(
      /^quirkyd_migration_destination_blob_kind_unsupported:shell-history:/
    )
  })

  it('advertises the channel and only the kinds that have an installer', () => {
    expect(advertisedQuirkydMigrationBlobCapabilities()).toEqual([
      QUIRKYD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
      'quirkyd.migration-blob.terminal-restore-hints.v1',
      'quirkyd.migration-blob.shell-history.v1'
    ])
    // A kind with no installer stays unadvertised, so no desktop sends it here.
    expect(advertisedQuirkydMigrationBlobCapabilities()).not.toContain(
      'quirkyd.migration-blob.agent-session-records.v1'
    )
  })

  // Drafts stay on each desktop; a chunk from a build that once shed them is refused, not stored.
  it('refuses the retired editor-drafts kind', () => {
    expect(
      QuirkydMigrationBlobDescriptorSchema.safeParse({
        blobKind: 'editor-drafts',
        key: 'drafts',
        sha256: 'b'.repeat(64),
        byteLength: 4
      }).success
    ).toBe(false)
  })

  it('keeps unknown request fields out and checks the acknowledged length', () => {
    const request = QuirkydMigrationBlobChunkRequestSchema.parse({
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      blob: blob(),
      offset: 4,
      bytesBase64: 'YWJj',
      futureField: true
    })
    expect(request).not.toHaveProperty('futureField')
    const result = {
      migrationId: manifest.migrationId,
      manifestSha256: manifest.manifestSha256,
      blobKind: 'shell-history',
      key: `${HASH}-zsh`,
      receivedBytes: 7
    }
    expect(parseQuirkydMigrationBlobChunkResult(result, request).receivedBytes).toBe(7)
    expect(() =>
      parseQuirkydMigrationBlobChunkResult({ ...result, receivedBytes: 6 }, request)
    ).toThrow('quirkyd_migration_blob_chunk_result_invalid')
  })

  it('parses upload states strictly and treats an absent list as nothing staged', () => {
    expect(parseQuirkydMigrationBlobUploadStates(undefined)).toBeUndefined()
    expect(parseQuirkydMigrationBlobUploadStates([{ ...blob(), receivedBytes: 3 }])).toEqual([
      { ...blob(), receivedBytes: 3 }
    ])
    expect(() => parseQuirkydMigrationBlobUploadStates([{ ...blob(), receivedBytes: 11 }])).toThrow(
      'quirkyd_migration_blob_state_invalid'
    )
    expect(() => parseQuirkydMigrationBlobUploadStates({})).toThrow(
      'quirkyd_migration_blob_state_invalid'
    )
  })
})

describe('quirkyd migration catalog state with blob uploads', () => {
  const staged = {
    state: 'staged',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    stagedAt: '2026-08-30T12:01:00.000Z'
  }

  it('still accepts a staged state from a host that predates blobs', () => {
    expect(parseQuirkydMigrationCatalogState(staged, manifest)).toEqual(staged)
  })

  it('carries blob uploads from a host that has them', () => {
    const uploads = [{ ...blob(), receivedBytes: 10 }]
    expect(
      parseQuirkydMigrationCatalogState({ ...staged, blobUploads: uploads }, manifest)
    ).toEqual({
      ...staged,
      blobUploads: uploads
    })
    expect(() =>
      parseQuirkydMigrationCatalogState(
        { ...staged, blobUploads: [{ ...blob({ key: 'bad' }), receivedBytes: 0 }] },
        manifest
      )
    ).toThrow('quirkyd_migration_blob_key_invalid')
  })
})
