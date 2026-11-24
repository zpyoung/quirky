import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { fillDefaultWorktreeMetaFields } from '../../../shared/worktree/meta-persisted-defaults'
import { prepareQuirkydMigrationDormantState } from './quirkyd-dormant-state-records'

const KEY = 'repo::/srv/worktree'

function fixture() {
  const state = getDefaultPersistedState('/tmp/quirkyd-metadata-defaults')
  const meta = {
    displayName: 'Workspace',
    comment: 'preserve',
    isUnread: true,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1
  }
  const manifest: QuirkydMigrationManifest = {
    version: 1,
    migrationId: 'migration',
    createdAt: '2026-09-06T00:00:00.000Z',
    source: { sshTargetId: 'ssh', sshTargetGeneration: 1, targetLabel: 'host' },
    manifestSha256: 'unused-by-dormant-validator',
    payload: {
      repositories: [],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1,
        worktreeMeta: [{ sourceKey: KEY, worktreeId: KEY, meta }],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: []
      }
    }
  }
  state.worktreeMeta[KEY] = { ...meta }
  fillDefaultWorktreeMetaFields(state.worktreeMeta[KEY])
  return { state, manifest }
}

describe('migration metadata default equivalence', () => {
  it('accepts load-materialized defaults without changing the manifest or state', () => {
    const { state, manifest } = fixture()
    const before = structuredClone({ state, manifest })
    expect(prepareQuirkydMigrationDormantState(manifest, state).newWorktreeMeta).toEqual([])
    expect({ state, manifest }).toEqual(before)
  })

  it.each(['isPinned', 'isArchived'] as const)('still refuses a changed %s value', (field) => {
    const { state, manifest } = fixture()
    state.worktreeMeta[KEY][field] = true
    expect(() => prepareQuirkydMigrationDormantState(manifest, state)).toThrow(
      `quirkyd_migration_dormant_id_conflict:worktree_meta:${KEY}`
    )
  })
})
