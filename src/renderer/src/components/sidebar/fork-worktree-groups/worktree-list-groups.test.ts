import { describe, expect, it } from 'vitest'
import { getExecutionHostLabel } from '../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../shared/project-group-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { OccurrenceSectionPath } from '../../../../../shared/worktree-occurrence-plan'
import {
  getLooseSectionProjectGroupId,
  isLooseProjectGroupTopRow
} from '../../../../../shared/fork-worktree-groups/worktree-loose-group-membership'
import { buildRows, buildSidebarRowPlan } from '../worktree-list/grouping/build-rows.test-fixture'

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')
const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/quirky',
  displayName: 'quirky',
  badgeColor: '#000000',
  addedAt: 0
}
const remoteRepo: Repo = {
  id: 'repo-remote',
  path: '/home/alice/quirky',
  displayName: 'quirky',
  badgeColor: '#111111',
  addedAt: 1,
  connectionId: 'gpu-vm'
}
const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/tmp/quirky-feature',
  branch: 'refs/heads/feature/super-critical',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'feature/super-critical',
  sortOrder: 0,
  lastActivityAt: 0
}
const repoMap = new Map([[repo.id, repo]])

function getRevealSectionKeys(
  target: Worktree,
  repos: readonly Repo[],
  projectGroups: readonly ProjectGroup[]
): string[] {
  const plan = buildSidebarRowPlan(
    'repo',
    [target],
    new Map(repos.map((entry) => [entry.id, entry])),
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    projectGroups
  )
  const keys: string[] = []
  let path: OccurrenceSectionPath | undefined = plan.occurrencePlan.preferredByIdentity.get(
    getWorktreeHostIdentity(target)
  )?.sectionPath
  while (path) {
    keys.unshift(path.key)
    path = path.parent
  }
  return keys
}

describe('cross-repo worktree groups (loose worktrees)', () => {
  const crossGroup: ProjectGroup = {
    id: 'group-cross',
    name: 'Cross Repo',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }

  it('renders a loose worktree under its group and excludes it from its repo section', () => {
    const normalWorktree: Worktree = { ...worktree, id: 'wt-normal' }
    const looseWorktree: Worktree = { ...worktree, id: 'wt-loose', projectGroupId: crossGroup.id }

    const rows = buildRows(
      'repo',
      [normalWorktree, looseWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project-group:group-cross' },
      { type: 'item', worktree: { id: 'wt-loose' } },
      { type: 'header', key: 'repo:repo-1', count: 1 },
      { type: 'item', worktree: { id: 'wt-normal' } }
    ])
    expect(
      rows.some(
        (row) =>
          row.type === 'item' && row.sectionKey === 'repo:repo-1' && row.worktree.id === 'wt-loose'
      )
    ).toBe(false)
  })

  it('excludes a grouped worktree from its repo header count', () => {
    const normalWorktree: Worktree = { ...worktree, id: 'wt-normal' }
    const looseWorktree: Worktree = { ...worktree, id: 'wt-loose', projectGroupId: crossGroup.id }

    const rows = buildRows(
      'repo',
      [normalWorktree, looseWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    const repoHeader = rows.find((row) => row.type === 'header' && row.key === 'repo:repo-1')
    expect(repoHeader).toMatchObject({ count: 1 })
  })

  it('includes loose worktrees in getProjectGroupSubtreeCount', () => {
    const looseOne: Worktree = { ...worktree, id: 'wt-loose-1', projectGroupId: crossGroup.id }
    const looseTwo: Worktree = {
      ...worktree,
      id: 'wt-loose-2',
      repoId: 'repo-2',
      projectGroupId: crossGroup.id
    }
    const repoTwo: Repo = { ...repo, id: 'repo-2', displayName: 'repo-two' }

    const rows = buildRows(
      'repo',
      [looseOne, looseTwo],
      new Map([
        [repo.id, repo],
        [repoTwo.id, repoTwo]
      ]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    expect(rows[0]).toMatchObject({
      type: 'header',
      key: 'project-group:group-cross',
      count: 2
    })
  })

  it('orders group rows as folder workspaces, then loose worktrees, then nested repo sections', () => {
    const folderGroup: ProjectGroup = {
      ...crossGroup,
      id: 'group-folder-order',
      parentPath: '/monorepo',
      createdFrom: 'folder-scan'
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-order',
      projectGroupId: folderGroup.id,
      name: 'Folder work',
      folderPath: '/monorepo',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 10,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }
    const nestedRepo: Repo = {
      ...repo,
      id: 'repo-nested',
      displayName: 'nested-repo',
      projectGroupId: folderGroup.id
    }
    const nestedWorktree: Worktree = { ...worktree, id: 'wt-nested', repoId: nestedRepo.id }
    const looseWorktree: Worktree = {
      ...worktree,
      id: 'wt-loose-order',
      projectGroupId: folderGroup.id
    }

    const rows = buildRows(
      'repo',
      [nestedWorktree, looseWorktree],
      new Map([[nestedRepo.id, nestedRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [folderGroup],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [folderWorkspace]
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project-group:group-folder-order' },
      { type: 'folder-workspace', folderWorkspace: { id: 'folder-workspace-order' } },
      { type: 'item', worktree: { id: 'wt-loose-order' } },
      { type: 'header', key: 'repo:repo-nested' },
      { type: 'item', worktree: { id: 'wt-nested' } }
    ])
  })

  it('does not hoist a grouped main worktree to the front of the loose-worktree block', () => {
    const secondWorktree: Worktree = {
      ...worktree,
      id: 'wt-second',
      projectGroupId: crossGroup.id,
      isMainWorktree: false
    }
    const mainWorktree: Worktree = {
      ...worktree,
      id: 'wt-main',
      projectGroupId: crossGroup.id,
      isMainWorktree: true
    }

    const rows = buildRows(
      'repo',
      [secondWorktree, mainWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    const looseItems = rows.filter((row) => row.type === 'item')
    expect(looseItems.map((row) => row.worktree.id)).toEqual(['wt-second', 'wt-main'])
  })

  it('single-location: a pinned+grouped worktree renders only in Pinned, absent from its group, excluded from its count', () => {
    const pinnedGrouped: Worktree = {
      ...worktree,
      id: 'wt-pinned-grouped',
      isPinned: true,
      projectGroupId: crossGroup.id
    }

    const rows = buildRows(
      'repo',
      [pinnedGrouped],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned', count: 1 },
      { type: 'item', worktree: { id: 'wt-pinned-grouped' }, sectionKey: 'pinned' },
      { type: 'header', key: 'project-group:group-cross', count: 0 }
    ])
    expect(rows.some((row) => row.type === 'item' && row.sectionKey !== 'pinned')).toBe(false)
  })

  it('duplicate-in-groups: a pinned+grouped worktree appears in both Pinned and its group', () => {
    const pinnedGrouped: Worktree = {
      ...worktree,
      id: 'wt-pinned-grouped-dup',
      isPinned: true,
      projectGroupId: crossGroup.id
    }

    const rows = buildRows(
      'repo',
      [pinnedGrouped],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      { showPinnedWorktreesInGroups: true } as never,
      [crossGroup]
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned', count: 1 },
      { type: 'item', worktree: { id: 'wt-pinned-grouped-dup' }, sectionKey: 'pinned' },
      { type: 'header', key: 'project-group:group-cross', count: 1 },
      { type: 'item', worktree: { id: 'wt-pinned-grouped-dup' } }
    ])
  })

  it('adds a hostContextLabel to a loose worktree whose host differs from the group effective host', () => {
    const sshGroup: ProjectGroup = { ...crossGroup, id: 'group-ssh', connectionId: 'gpu-vm' }
    const differentHostWorktree: Worktree = {
      ...worktree,
      id: 'wt-different-host',
      projectGroupId: sshGroup.id
    }

    const rows = buildRows(
      'repo',
      [differentHostWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [sshGroup]
    )
    const item = rows.find((row) => row.type === 'item')
    expect(item).toMatchObject({ hostContextLabel: LOCAL_HOST_LABEL })
  })

  it('omits hostContextLabel for a loose worktree whose host matches the group effective host', () => {
    const sshGroup: ProjectGroup = { ...crossGroup, id: 'group-ssh-match', connectionId: 'gpu-vm' }
    const matchingHostWorktree: Worktree = {
      ...worktree,
      id: 'wt-matching-host',
      projectGroupId: sshGroup.id,
      hostId: 'ssh:gpu-vm'
    }

    const rows = buildRows(
      'repo',
      [matchingHostWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [sshGroup]
    )

    const item = rows.find((row) => row.type === 'item')
    expect(item).toMatchObject({ worktree: { id: 'wt-matching-host' } })
    expect((item as { hostContextLabel?: string } | undefined)?.hostContextLabel).toBeUndefined()
  })

  it('keeps a worktree in its repo section when its group id is the empty string', () => {
    const emptyIdGroup: ProjectGroup = { ...crossGroup, id: '', name: 'Empty Id' }
    const looseWorktree: Worktree = { ...worktree, projectGroupId: '' }

    const rows = buildRows(
      'repo',
      [looseWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [emptyIdGroup]
    )

    expect(rows.find((row) => row.type === 'item')).toMatchObject({
      worktree: { id: looseWorktree.id },
      sectionKey: 'repo:repo-1'
    })
    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:ungrouped',
      'repo:repo-1'
    ])
  })

  it('reads the displayed group off a loose section key, not off the repo', () => {
    expect(getLooseSectionProjectGroupId('project-group:group-cross::loose')).toBe('group-cross')
    expect(getLooseSectionProjectGroupId('repo:repo-1')).toBeNull()
    expect(getLooseSectionProjectGroupId('project-group:group-cross')).toBeNull()
    expect(getLooseSectionProjectGroupId('pinned')).toBeNull()
    expect(getLooseSectionProjectGroupId('project-group:a::loose::loose')).toBe('a::loose')
  })

  it('marks only the top row of a loose section as carrying origin identity', () => {
    expect(isLooseProjectGroupTopRow('project-group:group-cross::loose', false)).toBe(true)
    expect(isLooseProjectGroupTopRow('project-group:group-cross::loose', true)).toBe(false)
    expect(isLooseProjectGroupTopRow('repo:repo-1', false)).toBe(false)
    expect(isLooseProjectGroupTopRow('pinned', false)).toBe(false)
  })

  it('labels only the differing members of a mixed-host group, not every member', () => {
    const sshGroup: ProjectGroup = { ...crossGroup, id: 'group-ssh-mixed', connectionId: 'gpu-vm' }
    const matchingHostWorktree: Worktree = {
      ...worktree,
      id: 'wt-mixed-matching',
      projectGroupId: sshGroup.id,
      hostId: 'ssh:gpu-vm'
    }
    const differingHostWorktree: Worktree = {
      ...worktree,
      id: 'wt-mixed-differing',
      projectGroupId: sshGroup.id
    }

    const rows = buildRows(
      'repo',
      [matchingHostWorktree, differingHostWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [sshGroup]
    )

    const items = rows.filter((row) => row.type === 'item')
    expect(
      items.find((row) => row.worktree.id === matchingHostWorktree.id)?.hostContextLabel
    ).toBeUndefined()
    expect(items.find((row) => row.worktree.id === differingHostWorktree.id)).toMatchObject({
      hostContextLabel: LOCAL_HOST_LABEL
    })
  })

  it('regression: omitted baselineHostId leaves top-level host labels unchanged when every host matches', () => {
    const secondLocal: Worktree = { ...worktree, id: 'wt-local-second' }
    const rows = buildRows('none', [worktree, secondLocal], repoMap, null, new Set())

    const items = rows.filter((row) => row.type === 'item')
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item.hostContextLabel).toBeUndefined()
    }
  })

  it('regression: omitted baselineHostId leaves top-level host labels unchanged when hosts mix', () => {
    const remoteOne: Worktree = { ...worktree, id: 'wt-remote-one', repoId: remoteRepo.id }
    const rows = buildRows(
      'none',
      [worktree, remoteOne],
      new Map([
        [repo.id, repo],
        [remoteRepo.id, remoteRepo]
      ]),
      null,
      new Set()
    )

    const items = rows.filter((row) => row.type === 'item')
    expect(items.find((row) => row.worktree.id === worktree.id)).toMatchObject({
      hostContextLabel: LOCAL_HOST_LABEL
    })
    expect(items.find((row) => row.worktree.id === remoteOne.id)).toMatchObject({
      hostContextLabel: 'gpu-vm'
    })
  })

  it('falls through to its repo section when projectGroupId names a nonexistent group', () => {
    const orphanWorktree: Worktree = {
      ...worktree,
      id: 'wt-orphan',
      projectGroupId: 'missing-group-id'
    }

    const rows = buildRows(
      'repo',
      [orphanWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project-group:group-cross', count: 0 },
      { type: 'header', key: 'repo:repo-1', count: 1 },
      { type: 'item', worktree: { id: 'wt-orphan' } }
    ])
  })
  it('renders a projectGroupId-tagged worktree normally in workspace-status mode', () => {
    const groupedWorktree: Worktree = {
      ...worktree,
      id: 'wt-grouped-workspace-status',
      projectGroupId: crossGroup.id
    }

    const rows = buildRows(
      'workspace-status',
      [groupedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    expect(rows.some((row) => row.type === 'item' && row.worktree.id === groupedWorktree.id)).toBe(
      true
    )
  })

  it('renders a projectGroupId-tagged worktree normally in pr-status mode', () => {
    const groupedWorktree: Worktree = {
      ...worktree,
      id: 'wt-grouped-pr-status',
      projectGroupId: crossGroup.id
    }

    const rows = buildRows(
      'pr-status',
      [groupedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    expect(rows.some((row) => row.type === 'item' && row.worktree.id === groupedWorktree.id)).toBe(
      true
    )
  })

  it('renders a projectGroupId-tagged worktree normally in groupBy none', () => {
    const groupedWorktree: Worktree = {
      ...worktree,
      id: 'wt-grouped-none',
      projectGroupId: crossGroup.id
    }

    const rows = buildRows(
      'none',
      [groupedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [crossGroup]
    )

    expect(rows.some((row) => row.type === 'item' && row.worktree.id === groupedWorktree.id)).toBe(
      true
    )
  })

  describe('reveal path for loose worktrees', () => {
    it("reveals through the worktree's own group and its ancestors, not its repo's", () => {
      const ownParentGroup: ProjectGroup = {
        ...crossGroup,
        id: 'group-own-parent',
        name: 'Own Parent'
      }
      const ownChildGroup: ProjectGroup = {
        ...crossGroup,
        id: 'group-own-child',
        name: 'Own Child',
        parentGroupId: ownParentGroup.id
      }
      const repoOwnGroup: ProjectGroup = {
        ...crossGroup,
        id: 'group-repo-own',
        name: 'Repo Own'
      }
      const groupedRepo: Repo = { ...repo, projectGroupId: repoOwnGroup.id }
      const looseWorktree: Worktree = { ...worktree, projectGroupId: ownChildGroup.id }

      expect(
        getRevealSectionKeys(
          looseWorktree,
          [groupedRepo],
          [ownParentGroup, ownChildGroup, repoOwnGroup]
        )
      ).toEqual([
        'project-group:group-own-parent',
        'project-group:group-own-child',
        'project-group:group-own-child::loose'
      ])
    })

    it("regression: a worktree with no own projectGroupId still reveals through its repo's group", () => {
      const groupedRepo: Repo = { ...repo, projectGroupId: crossGroup.id }
      const plainWorktree: Worktree = { ...worktree }

      expect(getRevealSectionKeys(plainWorktree, [groupedRepo], [crossGroup])).toEqual([
        'project-group:group-cross',
        'repo:repo-1'
      ])
    })

    it('falls back to the repo-derived keys when the worktree names a group absent from projectGroups', () => {
      const groupedRepo: Repo = { ...repo, projectGroupId: crossGroup.id }
      const orphanWorktree: Worktree = { ...worktree, projectGroupId: 'missing-group-id' }

      expect(getRevealSectionKeys(orphanWorktree, [groupedRepo], [crossGroup])).toEqual([
        'project-group:group-cross',
        'repo:repo-1'
      ])
    })
  })
})
