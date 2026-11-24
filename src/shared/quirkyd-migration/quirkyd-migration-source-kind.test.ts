import { describe, expect, it } from 'vitest'
import { isRecord } from './quirkyd-migration-manifest-fields'
import {
  QUIRKYD_MIGRATION_MANIFEST_VERSION,
  normalizeQuirkydMigrationImportReceipts,
  parseQuirkydMigrationManifest
} from './quirkyd-migration-manifest-validation'
import {
  QUIRKYD_MIGRATION_SOURCE_KIND_UNKNOWN,
  quirkydMigrationManifestSourceKind,
  requiredQuirkydMigrationSourceCapability
} from './quirkyd-migration-source-kind'
import {
  QUIRKYD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY,
  QUIRKYD_RUNTIME_CAPABILITIES
} from '../quirkyd-runtime-capabilities'

const SSH_SOURCE = { sshTargetId: 'ssh-1', sshTargetGeneration: 2, targetLabel: 'Prod' }
const WSL_SOURCE = {
  kind: 'local-wsl',
  distro: 'Ubuntu',
  scopeRepoIds: ['repo-1'],
  scopeFolderWorkspaceIds: [],
  generation: 1
}
const WSL_REPO = {
  id: 'repo-1',
  path: '/home/dev/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 0
}

/** Exactly what a desktop that predates `source.kind` sends. */
function manifestWithSource(source: unknown) {
  return {
    version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-kind',
    createdAt: '2026-10-01T00:00:00.000Z',
    source,
    payload: {
      repositories: isRecord(source) && source.kind === 'local-wsl' ? [WSL_REPO] : [],
      projectGroups: [],
      folderWorkspaces: []
    },
    manifestSha256: 'a'.repeat(64)
  }
}

describe('quirkyd migration source kind', () => {
  it('reads an absent kind as the relay-era SSH source, which needs no extra capability', () => {
    expect(quirkydMigrationManifestSourceKind(SSH_SOURCE)).toBe('ssh-relay')
    expect(quirkydMigrationManifestSourceKind({ ...SSH_SOURCE, kind: undefined })).toBe('ssh-relay')
    expect(requiredQuirkydMigrationSourceCapability(SSH_SOURCE)).toBeNull()
  })

  it('gates a WSL source on its own capability, which only a WSL host advertises', () => {
    expect(requiredQuirkydMigrationSourceCapability({ kind: 'local-wsl' })).toBe(
      QUIRKYD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
    )
    expect(QUIRKYD_RUNTIME_CAPABILITIES).not.toContain(
      QUIRKYD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
    )
  })

  it.each(['ssh-relay', 'toString', 'wsl', 7, null])('refuses unregistered kind %j', (kind) => {
    expect(() => quirkydMigrationManifestSourceKind({ kind })).toThrow(
      QUIRKYD_MIGRATION_SOURCE_KIND_UNKNOWN
    )
  })
})

describe('quirkyd migration manifest source on the destination', () => {
  it('accepts an older desktop manifest and its receipt unchanged', () => {
    expect(parseQuirkydMigrationManifest(manifestWithSource(SSH_SOURCE)).source).toEqual(SSH_SOURCE)
    const receipt = {
      version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'migration-kind',
      manifestSha256: 'a'.repeat(64),
      source: SSH_SOURCE,
      importedAt: '2026-10-01T00:00:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
    expect(normalizeQuirkydMigrationImportReceipts([receipt])).toEqual([receipt])
  })

  it('refuses an explicit SSH kind, and a WSL source carrying SSH fields', () => {
    expect(() =>
      parseQuirkydMigrationManifest(manifestWithSource({ ...SSH_SOURCE, kind: 'ssh-relay' }))
    ).toThrow('quirkyd_migration_manifest_source_kind_unsupported')
    expect(() =>
      parseQuirkydMigrationManifest(manifestWithSource({ ...WSL_SOURCE, sshTargetId: 'ssh-1' }))
    ).toThrow('quirkyd_migration_manifest_source_invalid')
  })

  it('parses a WSL source whose scope is exactly the catalog it moves', () => {
    const manifest = parseQuirkydMigrationManifest(
      manifestWithSource({ ...WSL_SOURCE, distroGuid: '{guid}' })
    )
    expect(manifest.source).toEqual({ ...WSL_SOURCE, distroGuid: '{guid}' })
  })

  it.each([
    { scopeRepoIds: ['repo-other'] },
    { scopeRepoIds: [] },
    { scopeFolderWorkspaceIds: ['folder-1'] },
    { generation: 0 },
    { distro: '' }
  ])('refuses a WSL source that does not describe its catalog: %j', (override) => {
    expect(() =>
      parseQuirkydMigrationManifest(manifestWithSource({ ...WSL_SOURCE, ...override }))
    ).toThrow(/source/)
  })

  it('fails a WSL source closed on a destination that drops the kind', () => {
    // Without the SSH fields, even a parser that ignores `kind` cannot read it as an SSH source.
    const { kind: _kind, ...asOlderDestinationSeesIt } = {
      kind: 'local-wsl',
      distro: 'Ubuntu',
      targetLabel: 'Ubuntu'
    }
    expect(() =>
      parseQuirkydMigrationManifest(manifestWithSource(asOlderDestinationSeesIt))
    ).toThrow(/^quirkyd_migration_manifest_source/)
  })
})
