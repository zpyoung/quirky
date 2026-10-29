import { expect, test } from 'bun:test'
import type { ProjectGroup, Repo, Session, Worktree } from '@quirky/protocol'
import { buildReport, projectSeparatorBoundaries, type ReportInput } from '../src/report'

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
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 0
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
  instanceId: id,
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
  parentId: null,
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
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
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

test('separator projection excludes leading and sticky boundaries', () => {
  const sections = ['pinned', 'group:team', 'repo:notes', 'repo:web']
  expect(projectSeparatorBoundaries(sections, new Set(['repo:notes']), true)).toEqual(['group:team'])
  expect(projectSeparatorBoundaries(sections, new Set(), false)).toEqual([])
})

test('separator boundaries keep Pinned first and omit host-adjacent and sticky edges', () => {
  expect(projectSeparatorBoundaries(['pinned', 'group:team'], new Set(), true)).toEqual(['group:team'])
  expect(projectSeparatorBoundaries(['pinned', 'group:team'], new Set(['pinned']), true)).toEqual([])
  expect(projectSeparatorBoundaries(
    ['repo:local', 'host:remote', 'repo:remote', 'repo:next'],
    new Set(),
    true
  )).toEqual(['repo:next'])
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

test('SC-44: a group reports its own folder workspaces in tree order, as the sidebar shows them', () => {
  const report = buildReport(
    input({
      groups: [group('g1', 'apps', [])],
      worktrees: [
        worktree('w1', 'group:g1', 'apps-root', { kind: 'folder', branch: null, path: '/r/apps' }),
        worktree('w2', 'group:g1', 'scratch', { kind: 'folder', branch: null, parentId: 'w1', pinned: true })
      ],
      selectedId: 'w2'
    })
  )
  expect(report.groups).toEqual([
    {
      id: 'g1',
      name: 'apps',
      collapsed: false,
      worktrees: [
        expect.objectContaining({ id: 'w1', name: 'apps-root', kind: 'folder', branch: null, depth: 0, selected: false }),
        expect.objectContaining({ id: 'w2', name: 'scratch', parentId: 'w1', depth: 1, pinned: true, selected: true })
      ],
      projects: []
    }
  ])
  expect(report.pinned).toEqual(['w2'])
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
  const worktrees = report.projects[0]!.worktrees
  expect(worktrees.find((row) => row.id === 'w1')).toMatchObject({ removing: true, pending: false })
  expect(worktrees.find((row) => row.id === 'pending:feature-y')).toMatchObject({
    name: 'feature-y',
    workspaceStatus: 'in-progress',
    pending: true
  })
})

test('SC-62: the open dialog is reported', () => {
  expect(buildReport(input({ dialog: { kind: 'create', repoId: 'r1' } })).dialog).toEqual({ kind: 'create', repoId: 'r1' })
  expect(buildReport(input({})).dialog).toBeNull()
})

test('a worktree drawn from an agent summary also reports its display and label', () => {
  const summary = {
    state: 'waiting' as const,
    display: 'permission' as const,
    label: 'Needs attention',
    detail: '',
    progress: null,
    stateStartedAt: 1000,
    evidenceAt: 1000,
    restoredUnconfirmed: false
  }
  const report = buildReport(
    input({
      repos: [repo('r1', 'api')],
      worktrees: [worktree('w1', 'r1', 'main'), worktree('w2', 'r1', 'fix')],
      sessions: [{ ...session('s1', 'w1', 'waiting'), agentStatus: summary }, session('s2', 'w2', 'working')],
      now: 2000
    })
  )
  const [main, fix] = report.projects[0]!.worktrees
  expect(main).toMatchObject({ id: 'w1', status: 'waiting', display: 'permission', label: 'Needs attention' })
  expect(fix).toMatchObject({ id: 'w2', status: 'working' })
  expect(fix).not.toHaveProperty('display')
  expect(fix).not.toHaveProperty('label')
})
test('the report preserves linked GitHub identity and PR push metadata separately from notes', () => {
  const linkedPR = {
    provider: 'github' as const,
    kind: 'pullRequest' as const,
    number: 3,
    title: 'Reword the README',
    url: 'https://github.com/acme/api/pull/3',
    repository: { host: 'github.com', owner: 'acme', repo: 'api' }
  }
  const linkedIssue = {
    provider: 'github' as const,
    kind: 'issue' as const,
    number: 4,
    title: 'Add a multiply function',
    url: 'https://github.com/acme/api/issues/4',
    repository: { host: 'github.com', owner: 'acme', repo: 'api' }
  }
  const pushTarget = { remoteName: 'pr-acme-api', branchName: 'feat/conflict', maintainerCanModify: false }
  const report = buildReport(input({
    repos: [repo('r1', 'api')],
    worktrees: [
      worktree('w-pr', 'r1', 'Reword the README', { linkedPR, pushTarget, comment: 'Editable note' }),
      worktree('w-issue', 'r1', 'Add a multiply function', { linkedIssue })
    ]
  }))
  expect(report.projects[0]!.worktrees[0]).toMatchObject({ linkedPR, pushTarget })
  expect(report.projects[0]!.worktrees[0]).not.toHaveProperty('linkedIssue')
  expect(report.projects[0]!.worktrees[1]).toMatchObject({ linkedIssue })
})
