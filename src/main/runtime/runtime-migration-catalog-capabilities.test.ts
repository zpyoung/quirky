import { describe, expect, it, vi } from 'vitest'
import { QuirkyRuntimeService } from './quirky-runtime-test-mocks.spec'
import { store } from './quirky-runtime-test-fixtures.spec'
import { QUIRKYD_MIGRATION_MANIFEST_VERSION } from '../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import type {
  QuirkydMigrationCatalogState,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'

const manifest: QuirkydMigrationManifest = {
  version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
  migrationId: 'migration-capabilities',
  createdAt: '2026-08-30T12:00:00.000Z',
  source: { sshTargetId: 'source', sshTargetGeneration: null, targetLabel: 'Source' },
  payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
  manifestSha256: '0'.repeat(64)
}

const staged: QuirkydMigrationCatalogState = {
  state: 'staged',
  migrationId: manifest.migrationId,
  manifestSha256: manifest.manifestSha256,
  stagedAt: manifest.createdAt
}

describe('runtime migration catalog capabilities', () => {
  it('refuses a catalog read when the runtime has no store', () => {
    const runtime = new QuirkyRuntimeService(null)
    expect(() => runtime.getQuirkydMigrationCatalogState(manifest)).toThrow('runtime_unavailable')
  })

  it('refuses a missing catalog reader on a partial store', () => {
    const runtime = new QuirkyRuntimeService(store)
    expect(() => runtime.getQuirkydMigrationCatalogState(manifest)).toThrow('runtime_unavailable')
  })

  it('refuses staging before mutation when the partial store cannot flush', async () => {
    const stage = vi.fn(() => staged)
    const runtime = new QuirkyRuntimeService({ ...store, stageQuirkydMigrationCatalog: stage })
    await expect(runtime.stageQuirkydMigrationCatalog(manifest)).rejects.toThrow(
      'runtime_unavailable'
    )
    expect(stage).not.toHaveBeenCalled()
  })

  it('admits staging with only the methods that operation needs', async () => {
    const stage = vi.fn(() => staged)
    const flush = vi.fn(async () => {})
    const runtime = new QuirkyRuntimeService({
      ...store,
      stageQuirkydMigrationCatalog: stage,
      flushPendingOrThrowAsync: flush
    })
    await expect(runtime.stageQuirkydMigrationCatalog(manifest)).resolves.toBe(staged)
    expect(stage).toHaveBeenCalledWith(manifest)
    expect(flush).toHaveBeenCalledOnce()
  })
})
