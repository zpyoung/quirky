import { expect, test } from 'bun:test'
import type { ProjectGroup, Repo } from '@quirky/protocol'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import { buildTree } from '../src/view-model'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES } from '../src/view-types'

const repo = (id: string, groupId: string | null = null): Repo =>
  ({ id, name: id, path: `/repo/${id}`, addedAt: 1, kind: 'git', displayName: null, groupId }) as Repo
const section = (id: string, repoIds: string[], order: number): ProjectGroup =>
  ({ id, name: id, parentPath: null, collapsed: false, order, createdFrom: 'manual', repoIds, parentId: null }) as ProjectGroup
const worktree = (id: string, repoId: string, extra: Partial<WorktreeControl> = {}): WorktreeControl => ({
  id, repoId, path: `/repo/${repoId}/${id}`, branch: id, head: 'abc', isMain: false, name: id, instanceId: id,
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false,
  parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false, removing: false,
  groupId: null, projectGroupId: null, lastActivityAt: 1, manualOrder: 0, sleeping: false, sleepChangedAt: null,
  references: [], archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false, tagIds: [],
  ...extra
}) as WorktreeControl

const worktrees = [
  worktree('wt-a', 'a'),
  worktree('wt-b', 'b'),
  worktree('wt-c', 'c'),
  worktree('wt-pinned-a', 'a', { pinned: true }),
  worktree('wt-pinned-b', 'b', { pinned: true })
]
const repos = [repo('a'), repo('b', 'holds-b'), repo('c', 'holds-c')]
const sections = [section('holds-c', ['c'], 0), section('holds-b', ['b'], 1), section('empty', [], 2)]

function tree(filterRepoIds: string[]) {
  const spec = allSpecFromStock({ ...DEFAULT_STOCK_OPTIONS, filterRepoIds }, DEFAULT_ACTIVITY_PREFERENCES)
  return buildTree({ worktrees, repos, groups: sections, tags: [], spec, viewId: 'all', projection: null, marks: new Map(), checks: new Map() })
}
const keys = (filterRepoIds: string[]) => tree(filterRepoIds).groups.map((group) => group.key)

test('all projects keeps every project, its pinned rows and the empty section', () => {
  expect(keys([])).toEqual(['pinned', 'project:c', 'project:b', 'section:empty', 'project:a'])
  expect(tree([]).groups[0]!.rows.map((row) => row.worktree.id)).toEqual(['wt-pinned-a', 'wt-pinned-b'])
  expect(tree([]).hidden.count).toBe(0)
})

test('narrowing drops other projects and their pinned rows', () => {
  const narrowed = tree(['a'])
  expect(narrowed.groups.map((group) => group.key)).toEqual(['pinned', 'project:a'])
  expect(narrowed.groups[0]!.rows.map((row) => row.worktree.id)).toEqual(['wt-pinned-a'])
  expect(narrowed.hidden).toEqual({ count: 3, reasons: ['other project'] })
})

test('narrowing drops a section left with nothing to show, and keeps a project whose rows remain', () => {
  const narrowed = tree(['c'])
  expect(narrowed.groups.map((group) => group.key)).toEqual(['project:c'])
  expect(keys(['b'])).toEqual(['pinned', 'project:b'])
})
