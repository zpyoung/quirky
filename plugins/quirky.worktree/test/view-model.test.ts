import { describe, expect, test } from 'bun:test'
import type { ProjectGroup, Repo, Session } from '@quirky/protocol'
import type { UiActivityMarkState, UiTagColor } from '@quirky/ui'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import { activityMark, buildTree, needsYou, type BuildTreeInput, type ChecksState, type ViewGroup, type ViewTree } from '../src/view-model'
import {
  DEFAULT_ACTIVITY_PREFERENCES,
  allSpecFromStock,
  type ActivityMarkState,
  type Tag,
  type TagColor,
  type ViewSpec
} from '../src/view-types'

const NOW = 1_000_000_000
const HOUR = 3_600_000

const wt = (id: string, patch: Partial<WorktreeControl> = {}): WorktreeControl => ({
  id,
  repoId: 'quirky',
  path: `/p/${id}`,
  branch: id,
  head: 'abc',
  isMain: false,
  name: id,
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 0,
  createdBy: 'window',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 0,
  instanceId: `i-${id}`,
  manualOrder: 0,
  sleeping: false,
  sleepChangedAt: null,
  references: [],
  archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true,
  externalVisibility: 'show',
  externalInboxSuppressed: false,
  tagIds: [],
  ...patch
})

const repo = (id: string, patch: Partial<Repo> = {}): Repo => ({
  id,
  name: id,
  path: `/r/${id}`,
  addedAt: 0,
  kind: 'git',
  displayName: null,
  groupId: null,
  ...patch
})

const section = (id: string, order: number, patch: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name: id,
  parentPath: null,
  collapsed: false,
  order,
  createdFrom: 'manual',
  repoIds: [],
  parentId: null,
  ...patch
})

const tag = (id: string, color: TagColor | null = null): Tag => ({ id, name: id, color })

const allSpec = (patch: { filter?: Partial<ViewSpec['filter']>; display?: Partial<ViewSpec['display']> } = {}): ViewSpec => {
  const base = allSpecFromStock({ ...DEFAULT_STOCK_OPTIONS, filterRepoIds: [], showProperties: [], hideArchived: false }, DEFAULT_ACTIVITY_PREFERENCES)
  return { filter: { ...base.filter, ...patch.filter }, display: { ...base.display, ...patch.display } }
}

const build = (input: Partial<BuildTreeInput> & Pick<BuildTreeInput, 'worktrees'>): ViewTree =>
  buildTree({
    repos: [repo('quirky'), repo('harbor-api')],
    groups: [],
    tags: [],
    spec: allSpec(),
    viewId: 'all',
    projection: null,
    marks: new Map(),
    checks: new Map(),
    ...input
  })

const shape = (tree: ViewTree) => tree.groups.map((group) => ({ key: group.key, rows: group.rows.map((row) => row.worktree.id) }))
const ids = (group: ViewGroup | undefined) => group?.rows.map((row) => row.worktree.id) ?? []
const byKey = (tree: ViewTree, key: string) => tree.groups.find((group) => group.key === key)

const session = (worktreeId: string, patch: Partial<Session> = {}): Session =>
  ({ id: `s-${worktreeId}`, worktreeId, status: 'running', ...patch }) as Session

describe('activityMark', () => {
  const idle = wt('a')
  const summary = (display: string, evidenceAt = NOW) =>
    ({ display, label: display, state: display, evidenceAt, progress: null, restoredUnconfirmed: false }) as unknown as Session['agentStatus']

  test('a pending ask is waiting, ahead of a sleeping worktree and any session state', () => {
    expect(activityMark(idle, [], 1, NOW)).toBe('waiting')
    expect(activityMark(wt('a', { sleeping: true }), [], 2, NOW)).toBe('waiting')
    expect(activityMark(idle, [session('a', { status: 'working' })], 1, NOW)).toBe('waiting')
  })

  test('the pending ask count may come as a per-worktree map', () => {
    expect(activityMark(idle, [], new Map([['a', 1]]), NOW)).toBe('waiting')
    expect(activityMark(idle, [], new Map([['b', 1]]), NOW)).toBe('idle')
    expect(activityMark(idle, [], null, NOW)).toBe('idle')
  })

  test('sleeping is asleep, ahead of a running session', () => {
    expect(activityMark(wt('a', { sleeping: true }), [session('a', { status: 'working' })], 0, NOW)).toBe('asleep')
  })

  test('a removal in flight reads as running', () => {
    expect(activityMark(wt('a', { removing: true }), [], 0, NOW)).toBe('running')
  })

  test('working and queued session states are running', () => {
    expect(activityMark(idle, [session('a', { status: 'working' })], 0, NOW)).toBe('running')
    expect(activityMark(idle, [session('a', { status: 'running' })], 0, NOW)).toBe('running')
    expect(activityMark(idle, [session('a', { status: 'starting' })], 0, NOW)).toBe('running')
    expect(activityMark(idle, [session('a', { agentStatus: summary('monitoring') })], 0, NOW)).toBe('running')
  })

  test('a session that is waiting, or an agent asking permission or blocked, is waiting', () => {
    expect(activityMark(idle, [session('a', { status: 'waiting' })], 0, NOW)).toBe('waiting')
    expect(activityMark(idle, [session('a', { agentStatus: summary('permission') })], 0, NOW)).toBe('waiting')
    expect(activityMark(idle, [session('a', { agentStatus: summary('blocked') })], 0, NOW)).toBe('waiting')
  })

  test('a failed agent is error', () => {
    expect(activityMark(idle, [session('a', { agentStatus: summary('failed') })], 0, NOW)).toBe('error')
  })

  test('done, exited and no session are idle', () => {
    expect(activityMark(idle, [session('a', { status: 'done' })], 0, NOW)).toBe('idle')
    expect(activityMark(idle, [session('a', { status: 'exited' })], 0, NOW)).toBe('idle')
    expect(activityMark(idle, [], 0, NOW)).toBe('idle')
    expect(activityMark(idle, [session('other', { status: 'working' })], 0, NOW)).toBe('idle')
  })

  test('the most urgent of several sessions wins', () => {
    const sessions = [session('a', { id: 's1', status: 'working' }), session('a', { id: 's2', status: 'waiting' })]
    expect(activityMark(idle, sessions, 0, NOW)).toBe('waiting')
  })

  test('a stale unfinished state decays to idle', () => {
    const stale = summary('working', NOW - 31 * 60 * 1000)
    expect(activityMark(idle, [session('a', { status: 'running', agentStatus: stale })], 0, NOW)).toBe('idle')
  })

  test('with sessions unavailable the row reads as queued, which is running', () => {
    expect(activityMark(idle, null, 0, NOW)).toBe('running')
  })
})

describe('needsYou', () => {
  const w = wt('a')
  test('waiting, error, unread or failing checks need you', () => {
    expect(needsYou(w, 'waiting', null)).toBe(true)
    expect(needsYou(w, 'error', null)).toBe(true)
    expect(needsYou(wt('a', { unread: true }), 'idle', null)).toBe(true)
    expect(needsYou(w, 'idle', 'failure')).toBe(true)
  })

  test('running, idle and asleep with passing, pending, neutral or unknown checks do not', () => {
    for (const mark of ['running', 'idle', 'asleep'] as const) {
      for (const checks of ['success', 'pending', 'neutral', null] as const) expect(needsYou(w, mark, checks)).toBe(false)
    }
  })
})

describe('SC-1 tree order', () => {
  const repos = [repo('quirky'), repo('harbor-api'), repo('docs-site')]
  const groups = [section('release', 1, { name: 'Release 2.4' })]
  const worktrees = [
    wt('release-notes', { pinned: true, lastActivityAt: 10 * HOUR }),
    wt('retry-queue', { repoId: 'harbor-api', projectGroupId: 'release', lastActivityAt: 9 * HOUR }),
    wt('export-csv', { projectGroupId: 'release', lastActivityAt: 8 * HOUR }),
    wt('ui-review-notes', { projectGroupId: 'release', lastActivityAt: 7 * HOUR }),
    wt('main', { isMain: true }),
    wt('sidebar-tags', { lastActivityAt: 6 * HOUR }),
    wt('docs-refresh', { lastActivityAt: 5 * HOUR })
  ]

  test('Pinned, then the section, then projects, each worktree once', () => {
    const tree = build({ worktrees, repos, groups })
    expect(shape(tree)).toEqual([
      { key: 'pinned', rows: ['release-notes'] },
      { key: 'section:release', rows: ['retry-queue', 'export-csv', 'ui-review-notes'] },
      { key: 'project:quirky', rows: ['main', 'sidebar-tags', 'docs-refresh'] }
    ])
    const all = tree.groups.flatMap((group) => ids(group))
    expect(new Set(all).size).toBe(worktrees.length)
    expect(all.length).toBe(worktrees.length)
  })

  test('group kinds and titles', () => {
    const tree = build({ worktrees, repos, groups })
    expect(tree.groups.map((group) => [group.kind, group.title])).toEqual([
      ['pinned', 'Pinned'],
      ['section', 'Release 2.4'],
      ['project', 'quirky']
    ])
  })

  test('a worktree moved into a section carries its project name, and one left in its project does not', () => {
    const tree = build({ worktrees, repos, groups })
    expect(byKey(tree, 'section:release')!.rows.map((row) => row.inSectionFromProject)).toEqual(['harbor-api', 'quirky', 'quirky'])
    expect(byKey(tree, 'project:quirky')!.rows.every((row) => row.inSectionFromProject === undefined)).toBe(true)
  })

  test('the project label is the display name when set', () => {
    const tree = build({ worktrees, repos: [repo('quirky', { displayName: 'Quirky App' }), repo('harbor-api')], groups })
    expect(byKey(tree, 'project:quirky')!.title).toBe('Quirky App')
  })

  test('sections follow their order, then projects follow manual project order', () => {
    const tree = build({
      worktrees: [
        wt('a', { projectGroupId: 'late' }),
        wt('b', { projectGroupId: 'early' }),
        wt('c', { repoId: 'harbor-api' }),
        wt('d', { repoId: 'docs-site' }),
        wt('e')
      ],
      repos,
      groups: [section('late', 5), section('early', 2)],
      projectOrder: ['docs-site', 'quirky']
    })
    expect(tree.groups.map((group) => group.key)).toEqual(['section:early', 'section:late', 'project:docs-site', 'project:quirky', 'project:harbor-api'])
  })

  test('recent project order puts the project with the latest activity first', () => {
    const tree = build({
      worktrees: [wt('a', { lastActivityAt: 100 * HOUR }), wt('b', { repoId: 'harbor-api', lastActivityAt: 500 * HOUR })],
      repos,
      spec: allSpec({ display: { projectOrder: 'recent' } }),
      projectOrder: ['quirky', 'harbor-api']
    })
    expect(tree.groups.map((group) => group.key)).toEqual(['project:harbor-api', 'project:quirky'])
  })

  test('a project that belongs to a section is listed right after it, under its own header', () => {
    const tree = build({
      worktrees: [wt('a', { projectGroupId: 'g' }), wt('b', { repoId: 'harbor-api' }), wt('c')],
      repos: [repo('quirky'), repo('harbor-api', { groupId: 'g' })],
      groups: [section('g', 1)]
    })
    expect(shape(tree)).toEqual([
      { key: 'section:g', rows: ['a'] },
      { key: 'project:harbor-api', rows: ['b'] },
      { key: 'project:quirky', rows: ['c'] }
    ])
  })

  test('a folder worktree owned by a section shows in that section with no project name', () => {
    const tree = build({
      worktrees: [wt('f', { repoId: 'group:g', kind: 'folder' })],
      groups: [section('g', 1)]
    })
    expect(shape(tree)).toEqual([{ key: 'section:g', rows: ['f'] }])
    expect(tree.groups[0]!.rows[0]!.inSectionFromProject).toBeUndefined()
  })

  test('a section with nothing assigned to it still shows while nothing is filtered, and goes once a filter is active', () => {
    const empty = [section('empty', 1)]
    expect(shape(build({ worktrees: [wt('a')], groups: empty }))).toEqual([
      { key: 'section:empty', rows: [] },
      { key: 'project:quirky', rows: ['a'] }
    ])
    expect(shape(build({ worktrees: [wt('a')], groups: empty, spec: allSpec({ filter: { statuses: ['in-progress'] } }) }))).toEqual([
      { key: 'project:quirky', rows: ['a'] }
    ])
  })

  test('a section whose worktrees are all filtered out has no header', () => {
    const tree = build({
      worktrees: [wt('a', { projectGroupId: 'g', archivedAt: 1 }), wt('b')],
      groups: [section('g', 1)],
      spec: allSpec({ filter: { hideArchived: true } })
    })
    expect(shape(tree)).toEqual([{ key: 'project:quirky', rows: ['b'] }])
  })
})

describe('sorting and filtering as today', () => {
  const sortIds = (worktrees: WorktreeControl[], sortBy: ViewSpec['display']['sortBy'], extra: Partial<BuildTreeInput> = {}) =>
    ids(build({ worktrees, spec: allSpec({ display: { sortBy, groupBy: 'none' } }), ...extra }).groups[0])

  const trio = [
    wt('b', { lastActivityAt: 30 * HOUR, manualOrder: 1, createdAt: 1 }),
    wt('c', { lastActivityAt: 10 * HOUR, manualOrder: 3, createdAt: 2 }),
    wt('a', { lastActivityAt: 20 * HOUR, manualOrder: 2, createdAt: 3 })
  ]

  test('recent sorts by latest activity, with the five-minute create grace', () => {
    expect(sortIds(trio, 'recent')).toEqual(['b', 'a', 'c'])
    const fresh = wt('fresh', { createdAt: 5_000_000, lastActivityAt: 0 })
    expect(sortIds([wt('old', { lastActivityAt: 5_000_000 }), fresh], 'recent')).toEqual(['fresh', 'old'])
  })

  test('name sorts alphabetically, and ties fall to the id', () => {
    expect(sortIds(trio, 'name')).toEqual(['a', 'b', 'c'])
    expect(sortIds([wt('z1', { name: 'same' }), wt('a1', { name: 'same' })], 'name')).toEqual(['a1', 'z1'])
  })

  test('manual sorts by highest order first, then creation', () => {
    expect(sortIds(trio, 'manual')).toEqual(['c', 'a', 'b'])
  })

  test('project sorts by project label, then recent', () => {
    const items = [wt('x', { repoId: 'quirky', lastActivityAt: 1 * HOUR }), wt('y', { repoId: 'harbor-api', lastActivityAt: 1 * HOUR }), wt('z', { repoId: 'quirky', lastActivityAt: 9 * HOUR })]
    expect(sortIds(items, 'project')).toEqual(['y', 'z', 'x'])
  })

  test('agent activity puts waiting sessions first', () => {
    expect(sortIds(trio, 'agent-activity', { sessions: [session('c', { status: 'waiting' })] })).toEqual(['c', 'b', 'a'])
  })

  test('agent activity falls back to waiting marks when sessions are not given', () => {
    expect(sortIds(trio, 'agent-activity', { marks: new Map<string, ActivityMarkState>([['c', 'waiting']]) })).toEqual(['c', 'b', 'a'])
  })

  test('the primary worktree leads every sort, except ungrouped by name', () => {
    const items = [wt('a'), wt('main-wt', { isMain: true, name: 'zzz' })]
    expect(sortIds(items, 'name')).toEqual(['a', 'main-wt'])
    const grouped = build({ worktrees: items, spec: allSpec({ display: { sortBy: 'name' } }) })
    expect(ids(grouped.groups[0])).toEqual(['main-wt', 'a'])
  })

  test('hide flags drop archived, CLI-created, default-branch and detached worktrees', () => {
    const items = [
      wt('keep'),
      wt('archived', { archivedAt: 1 }),
      wt('cli', { createdBy: 'cli' }),
      wt('main', { isMain: true }),
      wt('detached', { branch: null })
    ]
    const filter = { hideArchived: true, hideCliCreated: true, hideDefaultBranch: true, hideDetachedHead: true }
    const tree = build({ worktrees: items, spec: allSpec({ filter }) })
    expect(shape(tree)).toEqual([{ key: 'project:quirky', rows: ['keep'] }])
    expect(tree.hidden.count).toBe(4)
  })

  test('detached HEAD is only hidden for non-primary git worktrees', () => {
    const items = [wt('main', { isMain: true, branch: null }), wt('folder', { kind: 'folder', branch: null })]
    const tree = build({ worktrees: items, spec: allSpec({ filter: { hideDetachedHead: true } }) })
    expect(tree.groups.flatMap(ids).sort()).toEqual(['folder', 'main'])
  })

  test('other desktop clients are hidden only when a desktop client is authenticated', () => {
    const items = [wt('mine'), wt('theirs')]
    const spec = allSpec({ filter: { hideOtherDesktopClients: true } })
    const other = new Map([['theirs', true], ['mine', false]])
    expect(build({ worktrees: items, spec, otherClients: { authenticated: true, byWorktree: other } }).groups.flatMap(ids)).toEqual(['mine'])
    expect(build({ worktrees: items, spec, otherClients: { authenticated: false, byWorktree: other } }).groups.flatMap(ids)).toEqual(['mine', 'theirs'])
    expect(build({ worktrees: items, spec }).groups.flatMap(ids)).toEqual(['mine', 'theirs'])
  })

  test('the project filter keeps only the listed projects', () => {
    const tree = build({ worktrees: [wt('a'), wt('b', { repoId: 'harbor-api' })], spec: allSpec({ filter: { repoIds: ['harbor-api'] } }) })
    expect(shape(tree)).toEqual([{ key: 'project:harbor-api', rows: ['b'] }])
  })

  test('an external worktree the user has hidden never shows', () => {
    const tree = build({ worktrees: [wt('a'), wt('ext', { externalVisible: false })] })
    expect(tree.groups.flatMap(ids)).toEqual(['a'])
    expect(tree.hidden).toEqual({ count: 1, reasons: ['external'] })
  })

  test('asleep worktrees hide unless Show asleep is on, but the primary stays when always shown', () => {
    const items = [wt('nap', { sleeping: true }), wt('main', { isMain: true, sleeping: true }), wt('up')]
    const hide = allSpec({ display: { showAsleep: false } })
    expect(build({ worktrees: items, spec: hide }).groups.flatMap(ids)).toEqual(['main', 'up'])
    const noPrimary = allSpec({ display: { showAsleep: false }, filter: { activity: { ...DEFAULT_ACTIVITY_PREFERENCES, alwaysShowDefaultBranchWorkspace: false } } })
    const tree = build({ worktrees: items, spec: noPrimary })
    expect(tree.groups.flatMap(ids)).toEqual(['up'])
    expect(tree.hidden).toEqual({ count: 2, reasons: ['asleep'] })
    expect(build({ worktrees: items, spec: allSpec({ display: { showAsleep: true } }) }).groups.flatMap(ids).sort()).toEqual(['main', 'nap', 'up'])
  })

  test('the activity projection keeps only its visible ids, and names why the rest are hidden', () => {
    const items = [wt('seen'), wt('auto'), wt('merged'), wt('green'), wt('old')]
    const tree = build({
      worktrees: items,
      projection: {
        visibleIds: ['seen'],
        automationHiddenIds: ['auto'],
        reviewHiddenIds: ['merged', 'green'],
        workspaces: [
          { worktreeId: 'merged', reviewReason: 'completed' },
          { worktreeId: 'green', reviewReason: 'passing' }
        ]
      }
    })
    expect(tree.groups.flatMap(ids)).toEqual(['seen'])
    expect(tree.hidden.count).toBe(4)
    expect(tree.hidden.reasons).toEqual(['automation-created', 'completed review', 'passing checks', 'inactive'])
  })

  test('a null projection filters nothing', () => {
    expect(build({ worktrees: [wt('a'), wt('b')], projection: null }).groups.flatMap(ids)).toEqual(['a', 'b'])
  })

  test('reveal.filtered brings back worktrees the filters hid, and reveal.asleep the sleeping ones', () => {
    const items = [wt('archived', { archivedAt: 1 }), wt('nap', { sleeping: true }), wt('up')]
    const spec = allSpec({ filter: { hideArchived: true }, display: { showAsleep: false } })
    expect(build({ worktrees: items, spec }).groups.flatMap(ids)).toEqual(['up'])
    expect(build({ worktrees: items, spec, reveal: { filtered: true } }).groups.flatMap(ids).sort()).toEqual(['archived', 'up'])
    expect(build({ worktrees: items, spec, reveal: { asleep: true } }).groups.flatMap(ids).sort()).toEqual(['nap', 'up'])
  })
})

describe('hidden count and reasons', () => {
  test('counts each hidden worktree once and names its first reason, in a fixed order', () => {
    const items = [wt('a', { archivedAt: 1, sleeping: true }), wt('b', { archivedAt: 1 }), wt('c', { sleeping: true }), wt('d')]
    const tree = build({ worktrees: items, spec: allSpec({ filter: { hideArchived: true }, display: { showAsleep: false } }) })
    expect(tree.hidden).toEqual({ count: 3, reasons: ['archived', 'asleep'] })
  })

  test('a single archived worktree reads as "1 hidden: archived"', () => {
    const tree = build({ worktrees: [wt('a'), wt('b', { archivedAt: 1 })], spec: allSpec({ filter: { hideArchived: true } }) })
    expect(tree.hidden).toEqual({ count: 1, reasons: ['archived'] })
  })

  test('nothing hidden is a zero count and no reasons', () => {
    expect(build({ worktrees: [wt('a')] }).hidden).toEqual({ count: 0, reasons: [] })
  })
})

describe('SC-3 attention survives folding', () => {
  const worktrees = [
    wt('export-csv', { projectGroupId: 'release' }),
    wt('export-csv-tests', { projectGroupId: 'release', parentId: 'export-csv' }),
    wt('quiet', { projectGroupId: 'release' })
  ]
  const groups = [section('release', 1)]

  test('a waiting child colours its parent and the section, and counts', () => {
    const tree = build({ worktrees, groups, marks: new Map<string, ActivityMarkState>([['export-csv-tests', 'waiting']]) })
    const release = byKey(tree, 'section:release')!
    expect(release.attention).toBe('waiting')
    expect(release.attentionCount).toBe(1)
    const parent = release.rows.find((row) => row.worktree.id === 'export-csv')!
    expect(parent.childCount).toBe(1)
    expect(parent.childAttention).toBe('waiting')
    expect(parent.mark).toBe('idle')
    expect(release.rows.find((row) => row.worktree.id === 'quiet')!.childAttention).toBe('none')
  })

  test('the child nests one level under its parent', () => {
    const tree = build({ worktrees, groups })
    expect(byKey(tree, 'section:release')!.rows.map((row) => [row.worktree.id, row.depth])).toEqual([
      ['export-csv', 0],
      ['export-csv-tests', 1],
      ['quiet', 0]
    ])
  })

  test('an errored descendant turns the parent and the section red, even beside a waiting one', () => {
    const marks = new Map<string, ActivityMarkState>([['export-csv-tests', 'error'], ['quiet', 'waiting']])
    const release = byKey(build({ worktrees, groups, marks }), 'section:release')!
    expect(release.attention).toBe('error')
    expect(release.attentionCount).toBe(2)
    expect(release.rows[0]!.childAttention).toBe('error')
  })

  test('attention reaches the grandparent through nested children', () => {
    const deep = [wt('g'), wt('p', { parentId: 'g' }), wt('c', { parentId: 'p' })]
    const tree = build({ worktrees: deep, marks: new Map<string, ActivityMarkState>([['c', 'error']]) })
    const rows = byKey(tree, 'project:quirky')!.rows
    expect(rows.map((row) => [row.worktree.id, row.depth, row.childCount, row.childAttention])).toEqual([
      ['g', 0, 1, 'error'],
      ['p', 1, 1, 'error'],
      ['c', 2, 0, 'none']
    ])
  })

  test('a group with only idle rows has no attention', () => {
    const quiet = byKey(build({ worktrees, groups }), 'section:release')!
    expect(quiet.attention).toBe('none')
    expect(quiet.attentionCount).toBe(0)
  })

  test('each row carries its mark, defaulting to idle', () => {
    const tree = build({ worktrees, groups, marks: new Map<string, ActivityMarkState>([['quiet', 'running']]) })
    expect(byKey(tree, 'section:release')!.rows.map((row) => row.mark)).toEqual(['idle', 'idle', 'running'])
  })

  test('with nesting off the children list flat', () => {
    const tree = build({ worktrees, groups, spec: allSpec({ display: { showNested: false } }), marks: new Map<string, ActivityMarkState>([['export-csv-tests', 'waiting']]) })
    const release = byKey(tree, 'section:release')!
    expect(release.rows.map((row) => [row.depth, row.childCount, row.childAttention])).toEqual([[0, 0, 'none'], [0, 0, 'none'], [0, 0, 'none']])
    expect(release.attention).toBe('waiting')
  })

  test('needs-you and errored counts cover every worktree, hidden or not', () => {
    const items = [
      wt('a', { archivedAt: 1 }),
      wt('b', { unread: true }),
      wt('c'),
      wt('d')
    ]
    const tree = build({
      worktrees: items,
      spec: allSpec({ filter: { hideArchived: true } }),
      marks: new Map<string, ActivityMarkState>([['a', 'error'], ['c', 'waiting']]),
      checks: new Map<string, ChecksState | null>([['d', 'failure']])
    })
    expect(tree.needsYouCount).toBe(4)
    expect(tree.erroredCount).toBe(1)
    expect(tree.groups.flatMap(ids)).toEqual(['b', 'c', 'd'])
  })
})

describe('SC-6 group by tag', () => {
  const tags = [tag('urgent'), tag('release-2.4', 'blue'), tag('unused')]
  const worktrees = [
    wt('retry-queue', { tagIds: ['urgent', 'release-2.4'], lastActivityAt: 3 * HOUR }),
    wt('sidebar-tags', { tagIds: ['urgent'], lastActivityAt: 2 * HOUR }),
    wt('docs-refresh', { lastActivityAt: 1 * HOUR })
  ]
  const spec = allSpec({ display: { groupBy: 'tag' } })

  test('a worktree with two tags shows under both, and untagged ones come last', () => {
    const tree = build({ worktrees, tags, spec })
    expect(shape(tree)).toEqual([
      { key: 'tag:urgent', rows: ['retry-queue', 'sidebar-tags'] },
      { key: 'tag:release-2.4', rows: ['retry-queue'] },
      { key: 'untagged', rows: ['docs-refresh'] }
    ])
    expect(tree.groups.map((group) => group.kind)).toEqual(['tag', 'tag', 'untagged'])
    expect(tree.groups.map((group) => group.title)).toEqual(['urgent', 'release-2.4', 'Untagged'])
  })

  test('a tag with no worktree has no group, and no untagged group appears when everything is tagged', () => {
    const tree = build({ worktrees: [worktrees[0]!], tags, spec })
    expect(tree.groups.map((group) => group.key)).toEqual(['tag:urgent', 'tag:release-2.4'])
  })

  test('a pinned worktree shows only in Pinned', () => {
    const tree = build({ worktrees: [wt('p', { pinned: true, tagIds: ['urgent'] }), worktrees[1]!], tags, spec })
    expect(shape(tree)).toEqual([
      { key: 'pinned', rows: ['p'] },
      { key: 'tag:urgent', rows: ['sidebar-tags'] }
    ])
  })

  test('unknown tag ids on a worktree are ignored, so it is untagged', () => {
    const tree = build({ worktrees: [wt('a', { tagIds: ['gone'] })], tags, spec })
    expect(shape(tree)).toEqual([{ key: 'untagged', rows: ['a'] }])
  })

  test('filtering to a tag keeps only worktrees carrying it, and counts the rest as hidden', () => {
    const tree = build({ worktrees, tags, spec: allSpec({ filter: { tagIds: ['urgent'] } }) })
    expect(tree.groups.flatMap(ids)).toEqual(['retry-queue', 'sidebar-tags'])
    expect(tree.hidden).toEqual({ count: 1, reasons: ['no matching tag'] })
  })

  test('a tag filter matches any of the listed tags', () => {
    const tree = build({ worktrees, tags, spec: allSpec({ filter: { tagIds: ['release-2.4', 'unused'] } }) })
    expect(tree.groups.flatMap(ids)).toEqual(['retry-queue'])
  })

  test('a filter naming only deleted tags filters nothing', () => {
    const tree = build({ worktrees, tags, spec: allSpec({ filter: { tagIds: ['gone'] } }) })
    expect(tree.groups.flatMap(ids)).toEqual(['retry-queue', 'sidebar-tags', 'docs-refresh'])
    expect(tree.hidden.count).toBe(0)
  })
})

describe('other groupings', () => {
  test('status lanes follow the status order, and a child follows its root', () => {
    const items = [
      wt('r', { status: 'in-review' }),
      wt('child', { status: 'todo', parentId: 'r' }),
      wt('t', { status: 'todo' }),
      wt('d', { status: 'done' })
    ]
    const tree = build({ worktrees: items, spec: allSpec({ display: { groupBy: 'status', sortBy: 'name' } }) })
    expect(shape(tree)).toEqual([
      { key: 'status:todo', rows: ['t'] },
      { key: 'status:in-review', rows: ['r', 'child'] },
      { key: 'status:done', rows: ['d'] }
    ])
    expect(tree.groups.map((group) => group.title)).toEqual(['Todo', 'In review', 'Done'])
    expect(tree.groups[1]!.rows.map((row) => row.depth)).toEqual([0, 1])
  })

  test('status titles come from the definitions given, including custom ones', () => {
    const tree = build({
      worktrees: [wt('a', { status: 'qa' as never }), wt('b')],
      spec: allSpec({ display: { groupBy: 'status' } }),
      statuses: [{ id: 'in-progress', label: 'Doing' }, { id: 'qa', label: 'QA' }]
    })
    expect(tree.groups.map((group) => [group.key, group.title])).toEqual([['status:in-progress', 'Doing'], ['status:qa', 'QA']])
  })

  test('pull request lanes group by PR, with worktrees that have none last', () => {
    const pr = (number: number) => ({ number, url: `https://x/${number}`, title: `T${number}` }) as WorktreeControl['linkedPR']
    const items = [wt('none'), wt('a', { linkedPR: pr(7) }), wt('b', { linkedPR: pr(7) }), wt('c', { linkedPR: pr(3) })]
    const tree = build({ worktrees: items, spec: allSpec({ display: { groupBy: 'pull-request', sortBy: 'name' } }) })
    expect(tree.groups.map((group) => [group.kind, group.title, ids(group)])).toEqual([
      ['pr', 'PR #7 · T7', ['a', 'b']],
      ['pr', 'PR #3 · T3', ['c']],
      ['pr', 'No pull request', ['none']]
    ])
  })

  test('project grouping ignores sections and lists a moved worktree under its project', () => {
    const tree = build({
      worktrees: [wt('a', { projectGroupId: 'g' }), wt('b', { repoId: 'harbor-api' })],
      groups: [section('g', 1)],
      spec: allSpec({ display: { groupBy: 'project' } }),
      projectOrder: ['quirky', 'harbor-api']
    })
    expect(shape(tree)).toEqual([
      { key: 'project:quirky', rows: ['a'] },
      { key: 'project:harbor-api', rows: ['b'] }
    ])
    expect(tree.groups[0]!.rows[0]!.inSectionFromProject).toBeUndefined()
  })

  test('no grouping is one flat list after Pinned, with no nesting', () => {
    const tree = build({
      worktrees: [wt('p', { pinned: true }), wt('a'), wt('b', { parentId: 'a' })],
      spec: allSpec({ display: { groupBy: 'none', sortBy: 'name' } })
    })
    expect(tree.groups.map((group) => [group.kind, ids(group)])).toEqual([['pinned', ['p']], ['flat', ['a', 'b']]])
    expect(tree.groups[1]!.rows.map((row) => [row.depth, row.childCount])).toEqual([[0, 0], [0, 0]])
  })
})

describe('Needs you view', () => {
  const worktrees = [
    wt('waiting', { archivedAt: 1 }),
    wt('unread', { unread: true, sleeping: true, projectGroupId: 'release' }),
    wt('failing-checks', { repoId: 'harbor-api' }),
    wt('fine'),
    wt('pinned-error', { pinned: true })
  ]
  const marks = new Map<string, ActivityMarkState>([['waiting', 'waiting'], ['pinned-error', 'error']])
  const checks = new Map<string, ChecksState | null>([['failing-checks', 'failure'], ['fine', 'success']])
  const groups = [section('release', 1)]
  const filtered = allSpec({ filter: { hideArchived: true, tagIds: ['nope'], statuses: ['done'], repoIds: ['harbor-api'] }, display: { groupBy: 'tag', showAsleep: false } })

  test('shows only waiting, unread, error and failing-check worktrees, ignoring the spec filters, grouped by section and project', () => {
    const tree = build({ worktrees, groups, marks, checks, spec: filtered, viewId: 'needs-you', tags: [tag('nope')] })
    expect(shape(tree)).toEqual([
      { key: 'pinned', rows: ['pinned-error'] },
      { key: 'section:release', rows: ['unread'] },
      { key: 'project:harbor-api', rows: ['failing-checks'] },
      { key: 'project:quirky', rows: ['waiting'] }
    ])
    expect(tree.needsYouCount).toBe(4)
    expect(tree.erroredCount).toBe(1)
    expect(tree.hidden).toEqual({ count: 0, reasons: [] })
  })

  test('the activity projection does not narrow it either', () => {
    const tree = build({ worktrees, groups, marks, checks, viewId: 'needs-you', projection: { visibleIds: [] } })
    expect(tree.groups.flatMap(ids).sort()).toEqual(['failing-checks', 'pinned-error', 'unread', 'waiting'])
  })

  test('with nothing needing you the tree is empty and the counts are zero', () => {
    const tree = build({ worktrees: [wt('a')], viewId: 'needs-you' })
    expect(tree).toEqual({ groups: [], hidden: { count: 0, reasons: [] }, needsYouCount: 0, erroredCount: 0 })
  })

  test('a child that needs you shows at depth 0 when its parent does not', () => {
    const tree = build({
      worktrees: [wt('parent'), wt('child', { parentId: 'parent' })],
      marks: new Map<string, ActivityMarkState>([['child', 'waiting']]),
      viewId: 'needs-you'
    })
    expect(tree.groups[0]!.rows.map((row) => [row.worktree.id, row.depth])).toEqual([['child', 0]])
  })
})

describe('error rules: stale data never throws', () => {
  test('an unknown view id behaves as All', () => {
    const items = [wt('a'), wt('b', { archivedAt: 1 })]
    const spec = allSpec({ filter: { hideArchived: true } })
    expect(build({ worktrees: items, spec, viewId: 'deleted-view' })).toEqual(build({ worktrees: items, spec, viewId: 'all' }))
    expect(build({ worktrees: items, spec, viewId: 'deleted-view' }).groups.flatMap(ids)).toEqual(['a'])
  })

  test('a project_group_id naming a missing group puts the worktree under its project', () => {
    const tree = build({ worktrees: [wt('a', { projectGroupId: 'gone' })], groups: [section('other', 1)], spec: allSpec({ filter: { statuses: ['in-progress'] } }) })
    expect(shape(tree)).toEqual([{ key: 'project:quirky', rows: ['a'] }])
    expect(tree.groups[0]!.rows[0]!.inSectionFromProject).toBeUndefined()
  })

  test('unknown tag ids in a filter or an assignment are ignored', () => {
    const tree = build({
      worktrees: [wt('a', { tagIds: ['gone', 'urgent'] }), wt('b', { tagIds: ['gone'] })],
      tags: [tag('urgent')],
      spec: allSpec({ filter: { tagIds: ['gone', 'urgent'] } })
    })
    expect(tree.groups.flatMap(ids)).toEqual(['a'])
  })

  test('a missing parent shows the child at depth 0', () => {
    const tree = build({ worktrees: [wt('child', { parentId: 'ghost' })] })
    expect(tree.groups[0]!.rows.map((row) => [row.depth, row.childCount])).toEqual([[0, 0]])
  })

  test('a parent filtered out shows the child at depth 0', () => {
    const tree = build({
      worktrees: [wt('parent', { archivedAt: 1 }), wt('child', { parentId: 'parent' })],
      spec: allSpec({ filter: { hideArchived: true } })
    })
    expect(tree.groups[0]!.rows.map((row) => [row.worktree.id, row.depth])).toEqual([['child', 0]])
  })

  test('a parent that is pinned leaves the child at depth 0 in its project', () => {
    const tree = build({ worktrees: [wt('parent', { pinned: true }), wt('child', { parentId: 'parent' })] })
    expect(shape(tree)).toEqual([{ key: 'pinned', rows: ['parent'] }, { key: 'project:quirky', rows: ['child'] }])
    expect(byKey(tree, 'project:quirky')!.rows[0]!.depth).toBe(0)
  })

  test('a parent cycle and a self-parent still list every worktree once', () => {
    const tree = build({ worktrees: [wt('a', { parentId: 'b' }), wt('b', { parentId: 'a' }), wt('c', { parentId: 'c' })] })
    expect(tree.groups.flatMap(ids).sort()).toEqual(['a', 'b', 'c'])
  })

  test('an empty result is no groups, with hidden filled', () => {
    const tree = build({ worktrees: [wt('a', { archivedAt: 1 })], spec: allSpec({ filter: { hideArchived: true } }) })
    expect(tree.groups).toEqual([])
    expect(tree.hidden).toEqual({ count: 1, reasons: ['archived'] })
  })

  test('no worktrees at all is an empty tree', () => {
    expect(build({ worktrees: [] })).toEqual({ groups: [], hidden: { count: 0, reasons: [] }, needsYouCount: 0, erroredCount: 0 })
  })

  test('a worktree whose project is missing still shows, under its id', () => {
    const tree = build({ worktrees: [wt('a', { repoId: 'removed-repo' })] })
    expect(tree.groups.map((group) => [group.key, group.title])).toEqual([['project:removed-repo', 'removed-repo']])
  })

  test('a worktree with no tagIds field is untagged', () => {
    const legacy = { ...wt('a'), tagIds: undefined } as unknown as WorktreeControl
    expect(shape(build({ worktrees: [legacy], spec: allSpec({ display: { groupBy: 'tag' } }) }))).toEqual([{ key: 'untagged', rows: ['a'] }])
  })
})

describe('types shared with the design system', () => {
  test('TagColor and ActivityMarkState are assignable both ways with the UI literals', () => {
    const toUi = (color: TagColor, mark: ActivityMarkState): [UiTagColor, UiActivityMarkState] => [color, mark]
    const fromUi = (color: UiTagColor, mark: UiActivityMarkState): [TagColor, ActivityMarkState] => [color, mark]
    expect(toUi('blue', 'idle')).toEqual(['blue', 'idle'])
    expect(fromUi('rose', 'asleep')).toEqual(['rose', 'asleep'])
  })
})
