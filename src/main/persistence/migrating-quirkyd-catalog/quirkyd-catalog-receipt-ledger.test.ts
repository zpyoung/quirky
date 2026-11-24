import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import { manifest } from '../../persistence-quirkyd-migration-catalog-fixture'
import {
  expireQuirkydMigrationStages,
  findQuirkydMigrationImportReceipt,
  QUIRKYD_MIGRATION_STAGE_TTL_MS,
  recordQuirkydMigrationImportReceipt
} from './quirkyd-catalog-receipt-ledger'

const empty = { repositories: [], projectGroups: [], folderWorkspaces: [] }

function receiptFor(migrationId: string) {
  const input = manifest({ migrationId, payload: empty })
  return {
    input,
    receipt: {
      version: input.version,
      migrationId,
      manifestSha256: input.manifestSha256,
      source: input.source,
      importedAt: '2026-10-01T00:00:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
  }
}

describe('quirkyd migration receipt ledger', () => {
  it('keeps answering for a commit whose receipt aged out of the bounded list', () => {
    const state = getDefaultPersistedState('/tmp/quirkyd-receipt-ledger')
    const first = receiptFor('migration-0')
    recordQuirkydMigrationImportReceipt(state, first.receipt)
    for (let index = 1; index <= MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS; index++) {
      recordQuirkydMigrationImportReceipt(state, receiptFor(`migration-${index}`).receipt)
    }
    expect(state.quirkydMigrationImportReceipts).toHaveLength(MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS)
    expect(findQuirkydMigrationImportReceipt(state, first.input)).toEqual(first.receipt)
    expect(findQuirkydMigrationImportReceipt(state, receiptFor('never').input)).toBeUndefined()
  })

  it('expires a stage no client came back for', () => {
    const state = getDefaultPersistedState('/tmp/quirkyd-receipt-ledger')
    const stagedAt = '2026-10-01T00:00:00.000Z'
    state.quirkydMigrationStagedCatalogs = [{ version: 1, manifest: manifest(), stagedAt }]
    const start = Date.parse(stagedAt)
    expect(expireQuirkydMigrationStages(state, start + QUIRKYD_MIGRATION_STAGE_TTL_MS - 1)).toBe(
      false
    )
    expect(expireQuirkydMigrationStages(state, start + QUIRKYD_MIGRATION_STAGE_TTL_MS)).toBe(true)
    expect(state.quirkydMigrationStagedCatalogs).toEqual([])
  })
})
