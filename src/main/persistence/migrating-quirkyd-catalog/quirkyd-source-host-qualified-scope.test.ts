import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { QUIRKYD_MIGRATION_MANIFEST_VERSION } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest-validation'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { Tab } from '../../../shared/tab-types'
import { subtractQuirkydMigrationClientState } from './quirkyd-source-client-subtraction'
import { collectQuirkydMigrationUntransferredDependencyCensus } from './quirkyd-source-dependency-census'
import { collectQuirkydMigrationSourceDormantState } from './quirkyd-source-dormant-state'
import { subtractQuirkydMigrationSourceDormantState } from './quirkyd-source-dormant-subtraction'
import {
  quirkydMigrationOwnerMatchesScope,
  createQuirkydMigrationSourceScope
} from './quirkyd-source-scope'

// Two SSH hosts registered the same repository id; only host A converts.
const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'Repository',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: 'host-a'
}
const WORKTREE = `${REPO.id}::/srv/repo`
const HOST_B = 'ssh:host-b'

function tab(id: string): Tab {
  return {
    id,
    entityId: `/srv/repo/${id}.md`,
    groupId: `group-${id}`,
    worktreeId: WORKTREE,
    contentType: 'editor',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function manifest(state: PersistedState): QuirkydMigrationManifest {
  const source = { sshTargetId: 'host-a', sshTargetGeneration: null, targetLabel: 'A' }
  const payload = { repositories: [REPO], projectGroups: [], folderWorkspaces: [] }
  return {
    version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-1',
    createdAt: '2026-10-05T12:00:00.000Z',
    source,
    payload: {
      ...payload,
      dormantState: collectQuirkydMigrationSourceDormantState(
        state,
        source,
        payload,
        undefined,
        'env-1'
      ).payload
    },
    destinationEnvironmentId: 'env-1',
    manifestSha256: 'a'.repeat(64)
  }
}

function twoHostState(): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [REPO, { ...REPO, connectionId: 'host-b' }]
  state.workspaceSessionsByHostId = {
    'ssh:host-a': { ...state.workspaceSession, unifiedTabs: { [WORKTREE]: [tab('a')] } },
    [HOST_B]: { ...state.workspaceSession, unifiedTabs: { [WORKTREE]: [tab('b')] } }
  }
  // Host B's row, qualified, in the local partition.
  state.workspaceSession.unifiedTabs = { [`${HOST_B}|${WORKTREE}`]: [tab('b-local')] }
  state.worktreeMeta[`${HOST_B}|${WORKTREE}`] = {
    displayName: 'B worktree',
    comment: '',
    isUnread: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    hostId: HOST_B
  }
  return state
}

describe('migration scope with host-qualified owners', () => {
  const scope = createQuirkydMigrationSourceScope({
    source: { sshTargetId: 'host-a', sshTargetGeneration: null, targetLabel: 'A' },
    catalog: { repositories: [REPO], projectGroups: [], folderWorkspaces: [] },
    repos: [REPO]
  })

  it('owns only keys qualified with its own host', () => {
    expect(quirkydMigrationOwnerMatchesScope(`ssh:host-a|${WORKTREE}`, scope)).toBe(true)
    expect(quirkydMigrationOwnerMatchesScope(`${HOST_B}|${WORKTREE}`, scope)).toBe(false)
    expect(quirkydMigrationOwnerMatchesScope(`runtime:env-1|${WORKTREE}`, scope)).toBe(false)
    expect(quirkydMigrationOwnerMatchesScope(WORKTREE, scope)).toBe(true)
  })

  it("never moves, counts or retires another host's state that shares a repo id", () => {
    const state = twoHostState()
    const moved = manifest(state)
    const session = moved.payload.dormantState?.workspaceSession
    expect(
      Object.values(session?.unifiedTabs ?? {})
        .flat()
        .map((entry) => entry.id)
    ).toEqual(['a'])
    expect(
      collectQuirkydMigrationUntransferredDependencyCensus(state, moved).counts['workspace-session']
    ).toBe(0)

    subtractQuirkydMigrationSourceDormantState(state, moved)

    expect(state.workspaceSessionsByHostId?.[HOST_B]?.unifiedTabs?.[WORKTREE]).toHaveLength(1)
    expect(state.workspaceSession.unifiedTabs?.[`${HOST_B}|${WORKTREE}`]).toHaveLength(1)
    expect(state.worktreeMeta[`${HOST_B}|${WORKTREE}`]).toBeDefined()
    expect(state.workspaceSessionsByHostId?.['ssh:host-a']?.unifiedTabs?.[WORKTREE]).toBeUndefined()
  })

  it('subtracts selected-worktree routing by retargeting it to the destination', () => {
    const state = getDefaultPersistedState('/home/test')
    state.repos = [REPO]
    state.ui.lastActiveWorktreeId = WORKTREE
    const moved = manifest(state)
    expect(moved.payload.dormantState?.clientState?.uiRouting?.lastActiveWorktreeId).toBe(WORKTREE)

    subtractQuirkydMigrationClientState(state, moved)

    expect(state.ui.lastActiveWorktreeId).toBe(`runtime:env-1|${WORKTREE}`)
  })
})
