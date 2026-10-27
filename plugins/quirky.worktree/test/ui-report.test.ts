import { expect, test } from 'bun:test'
import type { ProjectGroup, Repo, Session, Worktree } from '@quirky/protocol'
import { buildReport, type ReportInput } from '../src/report'

const WORKTREE_DEFAULTS = {
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 0,
  createdBy: 'external',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null
} as const

const repo = (id: string, name: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  name,
  path: `/r/${name}`,
  addedAt: 0,
  kind: 'git',
  displayName: null,
  groupId: null,
  ...extra
})

const worktree = (id: string, repoId: string, name: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  repoId,
  path: `/w/${name}`,
  branch: name,
  head: 'abc',
  isMain: false,
  name,
  ...WORKTREE_DEFAULTS,
  ...extra
})

const group = (id: string, name: string, repoIds: string[], extra: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name,
  parentPath: null,
  collapsed: false,
  order: 0,
  createdFrom: 'manual',
  repoIds,
  ...extra
})

const session = (id: string, worktreeId: string, status: Session['status']): Session => ({
  id,
  kind: 'terminal',
  agent: 'shell',
  worktreeId,
  cwd: '/x',
  title: id,
  status,
  createdAt: 0,
  lastActivityAt: 0,
  exitCode: null
})

const input = (extra: Partial<ReportInput>): ReportInput => ({
  repos: [],
  groups: [],
  worktrees: [],
  sessions: [],
  selectedId: null,
  pending: [],
  dialog: null,
  ...extra
})

test('SC-44: the report nests children under their parent with depth, and the primary comes first', () => {
  const report = buildReport(
    input({
      repos: [repo('r1', 'api')],
      worktrees: [
        worktree('w1', 'r1', 'main', { isMain: true }),
        worktree('w2', 'r1', 'fix-login'),
        worktree('w4', 'r1', 'docs'),
        worktree('w3', 'r1', 'child', { parentId: 'w2' })
      ],
      sessions: [session('s1', 'w2', 'running'), session('s2', 'w2', 'waiting')],
      selectedId: 'w2'
    })
  )
  expect(report.projects).toEqual([
    {
      id: 'r1',
      name: 'api',
      kind: 'git',
      worktrees: [
        expect.objectContaining({ id: 'w1', primary: true, depth: 0, status: null, selected: false }),
        expect.objectContaining({ id: 'w2', primary: false, depth: 0, status: 'waiting', selected: true }),
        expect.objectContaining({ id: 'w3', parentId: 'w2', depth: 1 }),
        expect.objectContaining({ id: 'w4', depth: 0 })
      ]
    }
  ])
})

test('SC-44: groups hold their projects in the group order; ungrouped projects follow; pinned lists IDs', () => {
  const report = buildReport(
    input({
      repos: [repo('r1', 'api', { groupId: 'g1' }), repo('r2', 'web'), repo('r3', 'ui', { groupId: 'g1' })],
      groups: [group('g1', 'services', ['r3', 'r1'], { collapsed: true })],
      worktrees: [
        worktree('w1', 'r1', 'main', { isMain: true, pinned: true }),
        worktree('w2', 'r2', 'main', { isMain: true, status: 'in-review', unread: true }),
        worktree('w3', 'r3', 'main', { isMain: true })
      ]
    })
  )
  expect(report.pinned).toEqual(['w1'])
  expect(report.groups.map((g) => [g.id, g.name, g.collapsed, g.projects.map((p) => p.name)])).toEqual([
    ['g1', 'services', true, ['ui', 'api']]
  ])
  expect(report.projects.map((p) => p.name)).toEqual(['web'])
  expect(report.projects[0]!.worktrees[0]).toMatchObject({ workspaceStatus: 'in-review', unread: true, pinned: false })
})

test('SC-44: a project reports its display name, and a folder project its kind', () => {
  const report = buildReport(input({ repos: [repo('r1', 'notes', { kind: 'folder', displayName: 'Notes' })] }))
  expect(report.projects).toEqual([{ id: 'r1', name: 'Notes', kind: 'folder', worktrees: [] }])
})

test('SC-35: every status is null when quirky.session is off', () => {
  const report = buildReport(
    input({ repos: [repo('r1', 'api')], worktrees: [worktree('w1', 'r1', 'main')], sessions: null })
  )
  expect(report.projects[0]!.worktrees[0]!.status).toBeNull()
})

test('a detached worktree reports a null branch and a repo with none reports an empty list', () => {
  const report = buildReport(
    input({ repos: [repo('r1', 'api'), repo('r2', 'web')], worktrees: [worktree('w1', 'r1', 'x', { branch: null })] })
  )
  expect(report.projects[0]!.worktrees[0]!.branch).toBeNull()
  expect(report.projects[1]!.worktrees).toEqual([])
})

test('a removing worktree and a pending create are reported with their flags', () => {
  const report = buildReport(
    input({
      repos: [repo('r1', 'api')],
      worktrees: [worktree('w1', 'r1', 'gone', { removing: true })],
      pending: [{ repoId: 'r1', name: 'feature-y' }]
    })
  )
  expect(report.projects[0]!.worktrees).toEqual([
    expect.objectContaining({ id: 'w1', removing: true, pending: false }),
    {
      id: 'pending:feature-y',
      name: 'feature-y',
      branch: null,
      kind: 'git',
      primary: false,
      status: null,
      workspaceStatus: 'in-progress',
      pinned: false,
      unread: false,
      parentId: null,
      depth: 0,
      pending: true,
      removing: false,
      selected: false
    }
  ])
})

test('SC-62: the open dialog is reported', () => {
  expect(buildReport(input({ dialog: { kind: 'create', repoId: 'r1' } })).dialog).toEqual({ kind: 'create', repoId: 'r1' })
  expect(buildReport(input({})).dialog).toBeNull()
})
