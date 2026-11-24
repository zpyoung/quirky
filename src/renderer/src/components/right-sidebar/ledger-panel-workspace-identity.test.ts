import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getLedgerPanelWorkspaceIdentity } from './ledger-panel-workspace-identity'

const groupedFolder = { id: 'f1', name: 'Notes', projectGroupId: 'g1' } as FolderWorkspace
const worktree = { id: 'repo::/path', displayName: 'fix-login', repoId: 'repo' } as Worktree
const groupedWorktree = { ...worktree, projectGroupId: 'g2' } as Worktree
const repos = [{ id: 'repo', displayName: 'quirky' } as Repo]
const groupedRepos = [{ id: 'repo', displayName: 'quirky', projectGroupId: 'g3' } as Repo]

describe('ledger panel workspace identity', () => {
  it('names a folder workspace from the scoped key', () => {
    expect(
      getLedgerPanelWorkspaceIdentity('folder:f1', { folderWorkspaces: [groupedFolder] })
    ).toEqual({ name: 'Notes', hasGroup: true })
  })
  it('names a worktree from the known-worktree lookup', () => {
    expect(
      getLedgerPanelWorkspaceIdentity('repo::/path', {
        getKnownWorktreeById: () => worktree,
        repos
      })
    ).toEqual({ name: 'fix-login', hasGroup: false })
  })
  it.each([
    ['the worktree own membership', groupedWorktree, repos],
    ['the repo membership', worktree, groupedRepos]
  ])('reports a group from %s', (_case, known, repoList) => {
    expect(
      getLedgerPanelWorkspaceIdentity('repo::/path', {
        getKnownWorktreeById: () => known,
        repos: repoList
      }).hasGroup
    ).toBe(true)
  })
  it.each([
    ['folder:missing', { folderWorkspaces: [groupedFolder] }],
    ['repo::/gone', { getKnownWorktreeById: () => undefined, repos }],
    [null, { folderWorkspaces: [groupedFolder] }]
  ])('returns no name and no group for %s', (workspaceId, source) => {
    expect(getLedgerPanelWorkspaceIdentity(workspaceId, source)).toEqual({
      name: null,
      hasGroup: false
    })
  })
})
