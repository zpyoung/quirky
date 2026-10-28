import { afterEach, expect, test } from 'bun:test'
import { bootTasks } from './helpers'
import { PROJECTS_GH_FIXTURE, seedProjectsState, setProjectScenario, type ProjectFixtureState } from './fixtures/projects'
import { buildRoadmapTimeline, MAX_ROADMAP_TICKS } from '../src/projects/timeline'

type TasksTest = {
  call(name: string, params?: Record<string, unknown>): Promise<unknown>
  writeState(value: unknown): void
  readState(): unknown
  invocations(): { args: string[]; input: string; env: Record<string, string> }[]
  cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  cleanup(): Promise<void>
}

const instances: TasksTest[] = []
afterEach(async () => {
  for (const instance of instances.splice(0).reverse()) await instance.cleanup()
})

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object result')
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array result')
  return value
}

async function tasks(state: ProjectFixtureState = seedProjectsState()): Promise<TasksTest> {
  const instance = await bootTasks(PROJECTS_GH_FIXTURE)
  instance.writeState(state)
  instances.push(instance)
  return instance
}

function preferences(value: unknown): Record<string, unknown> {
  const root = object(value)
  return object(root.preferences ?? root)
}

function viewList(value: unknown): Record<string, unknown> {
  const root = object(value)
  return { ...root, views: root.views ?? object(root.result ?? {}).views }
}

function loadedTable(value: unknown): Record<string, unknown> {
  const root = object(value)
  return object(root.result ?? root.table ?? root)
}

function projectItemQueries(instance: TasksTest): unknown[] {
  const saved = object(instance.readState())
  const calls = Array.isArray(saved.calls) ? saved.calls : []
  return calls.flatMap((value) => {
    const call = object(value)
    return typeof call.query === 'string' && call.query.includes('ProjectItems') ? [object(call.variables).query ?? null] : []
  })
}

async function expectProjectError(promise: Promise<unknown>, reason: string): Promise<Record<string, unknown>> {
  let caught: unknown
  try {
    await promise
  } catch (error: unknown) {
    caught = error
  }
  expect(caught).toBeDefined()
  const error = object(caught)
  expect(object(error.data).reason).toBe(reason)

  return error
}

function itemInBoardColumn(tableValue: unknown, fieldId: string, optionId: string | null): boolean {
  const table = loadedTable(tableValue)
  const board = list(table.boardColumns).map(object).find((column) => column.fieldId === fieldId)
  if (!board) return false
  const column = list(board.columns).map(object).find((entry) => entry.value === optionId)
  return column !== undefined && list(column.items).map(object).some((item) => item.id === 'PVTI_7')
}

test('Projects selection resolves project URLs, persists navigation and pins, and bounds recent projects', async () => {
  const state = seedProjectsState()
  const extraProjects: Record<string, unknown> = {}
  for (let number = 5; number <= 14; number += 1) {
    extraProjects[`organization/test-owner/${number}`] = {
      projectId: `PVT_${number}`,
      owner: 'test-owner',
      ownerType: 'Organization',
      number,
      title: `Fixture project ${number}`,
      url: `https://github.com/orgs/test-owner/projects/${number}`,
      views: []
    }
  }
  setProjectScenario(state, { resources: { projectViews: extraProjects } })
  const instance = await tasks(state)
  const discovery = object(await instance.call('projects', {}))
  expect(list(discovery.projects).map((value) => object(value).owner)).toContain('test-owner')
  expect(list(discovery.partialFailures)).toEqual([])
  expect(discovery.truncated).toBe(false)

  const added = object(await instance.call('projectSelect', {
    action: 'add',
    input: 'https://github.com/orgs/test-owner/projects/4/views/VIEW_BOARD'
  }))
  const selected = object(added.project)
  expect(selected.id).toBe('PVT_4')
  expect(selected.owner).toBe('test-owner')
  expect(selected.viewId).toBe('VIEW_BOARD')
  expect(added.selected).toBe(true)

  const selectedBoard = loadedTable(await instance.call('projectView', { action: 'load' }))
  expect(object(selectedBoard.view).id).toBe('VIEW_BOARD')
  const selectedAgain = object(await instance.call('projectSelect', { action: 'select', project: selected }))
  expect(selectedAgain.selected).toBe(true)

  await instance.call('projectSelect', { action: 'pin', project: selected })
  expect(list(preferences(await instance.call('projectPreferences')).pinned).map((value) => object(value).id)).toContain('PVT_4')
  for (let number = 5; number <= 14; number += 1) {
    await instance.call('projectSelect', { action: 'add', input: `test-owner/${number}` })
  }
  const recent = list(preferences(await instance.call('projectPreferences')).recent).map((value) => object(value).id)
  expect(recent).toHaveLength(10)
  expect(recent).toContain('PVT_14')
  expect(recent).not.toContain('PVT_4')

  await instance.call('projectSelect', { action: 'unpin', project: selected })
  expect(list(preferences(await instance.call('projectPreferences')).pinned).map((value) => object(value).id)).not.toContain('PVT_4')
  const cleared = object(await instance.call('projectSelect', { action: 'clear' }))
  expect(cleared.project).toBeNull()
}, 20_000)

test('Project views load public table data and keep saved and explicit queries isolated per view', async () => {
  const state = seedProjectsState()
  const projectViews = object(object(state.resources).projectViews)
  const seededProject = object(projectViews['organization/test-owner/4'])
  const savedViews = list(seededProject.views).map((value) => {
    const view = object(value)
    if (view.id === 'VIEW_TABLE') return { ...view, filter: 'is:open' }
    if (view.id === 'VIEW_BOARD') return { ...view, filter: 'is:closed' }
    return view
  })
  setProjectScenario(state, { resources: { projectViews: { 'organization/test-owner/4': { views: savedViews } } } })
  const instance = await tasks(state)
  await instance.call('projectSelect', { action: 'add', input: 'https://github.com/orgs/test-owner/projects/4' })

  const listed = viewList(await instance.call('projectView', { action: 'list' }))
  expect(list(listed.views).map((view) => object(view).layout)).toEqual(['TABLE', 'BOARD', 'ROADMAP'])

  await instance.call('projectView', { action: 'select', viewId: 'VIEW_TABLE' })
  const savedTable = loadedTable(await instance.call('projectView', { action: 'load' }))
  expect(savedTable.layout).toBe('TABLE')
  expect(list(savedTable.items).map((value) => object(value).id)).toContain('PVTI_7')
  const tableOverride = object(await instance.call('projectView', { action: 'load', viewId: 'VIEW_TABLE', query: 'is:closed' }))
  expect(object(tableOverride.query)).toMatchObject({ source: 'explicit', override: 'is:closed' })

  await instance.call('projectView', { action: 'select', viewId: 'VIEW_BOARD' })
  const board = loadedTable(await instance.call('projectView', { action: 'load' }))
  expect(board.layout).toBe('BOARD')
  const boardOverride = object(await instance.call('projectView', { action: 'load', viewId: 'VIEW_BOARD', query: 'is:open label:ready' }))
  expect(object(boardOverride.query)).toMatchObject({ source: 'explicit', override: 'is:open label:ready' })
  await instance.call('projectView', { action: 'select', viewId: 'VIEW_TABLE' })
  const rememberedTable = object(await instance.call('projectView', { action: 'load' }))
  expect(object(rememberedTable.query)).toMatchObject({ source: 'stored', override: 'is:closed' })
  await instance.call('projectView', { action: 'select', viewId: 'VIEW_BOARD' })
  const rememberedBoard = object(await instance.call('projectView', { action: 'load' }))
  expect(object(rememberedBoard.query)).toMatchObject({ source: 'stored', override: 'is:open label:ready' })
  await instance.call('projectView', { action: 'select', viewId: 'VIEW_TABLE' })

  const queries = projectItemQueries(instance)
  expect(queries).toContain('is:open')
  expect(queries).toContain('is:closed')
  expect(queries).toContain('is:open label:ready')
  const prefs = preferences(await instance.call('projectPreferences'))
  expect(Object.values(object(prefs.queryByView))).toContain('is:closed')
  expect(Object.values(object(prefs.queryByView))).toContain('is:open label:ready')
  expect(Object.values(object(prefs.lastViewByProject))).toContain('VIEW_TABLE')
}, 20_000)

test('Project field edits and clears move board items through the real project table', async () => {
  const instance = await tasks()
  await instance.call('projectSelect', { action: 'add', input: 'https://github.com/orgs/test-owner/projects/4' })
  await instance.call('projectView', { action: 'select', viewId: 'VIEW_BOARD' })
  const initial = await instance.call('projectView', { action: 'load' })
  expect(itemInBoardColumn(initial, 'PVTF_STATUS', 'OPT_TODO')).toBe(true)

  await instance.call('projectEdit', {
    action: 'field', projectId: 'PVT_4', itemId: 'PVTI_7', fieldId: 'PVTF_STATUS',
    value: { singleSelectOptionId: 'OPT_DONE' }
  })
  const moved = await instance.call('projectView', { action: 'load', viewId: 'VIEW_BOARD' })
  expect(itemInBoardColumn(moved, 'PVTF_STATUS', 'OPT_DONE')).toBe(true)
  expect(itemInBoardColumn(moved, 'PVTF_STATUS', 'OPT_TODO')).toBe(false)

  await instance.call('projectEdit', { action: 'field', projectId: 'PVT_4', itemId: 'PVTI_7', fieldId: 'PVTF_STATUS', clear: true })
  const cleared = await instance.call('projectView', { action: 'load', viewId: 'VIEW_BOARD' })
  expect(itemInBoardColumn(cleared, 'PVTF_STATUS', null)).toBe(true)
  expect(list(object(list(loadedTable(cleared).items)[0]).fieldValues).map((value) => object(value).fieldId)).not.toContain('PVTF_STATUS')
}, 20_000)

test('Project issue and issue-type edits mutate the selected project item', async () => {
  const instance = await tasks()
  const result = object(await instance.call('projectEdit', {
    action: 'issue',
    kind: 'issue',
    projectId: 'PVT_4',
    itemId: 'PVTI_7',
    number: 7,
    title: 'Updated from a project'
  }))
  expect(result.action).toBe('issue')
  expect(object(result.result).changed).toBe(true)
  expect(object(object(object(instance.readState()).resources).issues)['test-owner/test-repo/7']).toMatchObject({ title: 'Updated from a project' })
  expect(instance.invocations().some(({ args }) =>
    args.includes('PATCH') && args.includes('repos/test-owner/test-repo/issues/7')
  )).toBe(true)

  const issueTypeResult = object(await instance.call('projectEdit', {
    action: 'issueType',
    kind: 'issue',
    projectId: 'PVT_4',
    itemId: 'PVTI_7',
    number: 7,
    issueTypeName: 'Bug'
  }))
  expect(object(issueTypeResult.result).changed).toBe(true)
  expect(object(object(issueTypeResult.result).issueType).name).toBe('Bug')
  expect(object(object(object(instance.readState()).resources).issues)['test-owner/test-repo/7']).toMatchObject({
    issueType: { id: 'TYPE_BUG', name: 'Bug' }
  })
}, 20_000)

test('Project preferences persist durable view choices and reject oversized query state atomically', async () => {
  const instance = await tasks()
  const changed = preferences(await instance.call('projectPreferences', { patch: { roadmapZoom: 'year' } }))
  expect(changed.roadmapZoom).toBe('year')
  expect(preferences(await instance.call('projectPreferences')).roadmapZoom).toBe('year')

  const tooLarge = 'q'.repeat(100_000)
  let rejected = false
  try {
    await instance.call('projectPreferences', { patch: { queryByView: { oversized: tooLarge } } })
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
  expect(preferences(await instance.call('projectPreferences')).roadmapZoom).toBe('year')
  expect(Object.values(object(preferences(await instance.call('projectPreferences')).queryByView))).not.toContain(tooLarge)
}, 20_000)

test('Projects preserve typed authentication and scope errors without reporting false success', async () => {
  const state = seedProjectsState()
  setProjectScenario(state, { projectFailure: { reason: 'auth_required', query: 'ProjectDiscovery' } })
  const instance = await tasks(state)

  await expectProjectError(instance.call('projects', {}), 'auth_required')
  const scopeState = setProjectScenario(instance.readState() as ProjectFixtureState, {
    projectFailure: { reason: 'scope_missing', query: 'ProjectDiscovery' }
  })
  instance.writeState(scopeState)
  await expectProjectError(instance.call('projects', {}), 'scope_missing')

  const fieldFailureState = setProjectScenario(instance.readState() as ProjectFixtureState, {
    projectFailure: { reason: 'scope_missing', query: 'mutation SetProjectField' }
  })
  instance.writeState(fieldFailureState)
  await expectProjectError(instance.call('projectEdit', {
    action: 'field', projectId: 'PVT_4', itemId: 'PVTI_7', fieldId: 'PVTF_STATUS',
    value: { singleSelectOptionId: 'OPT_DONE' }
  }), 'scope_missing')
  const resources = object(object(instance.readState()).resources)
  expect(object(resources.projectFields)['PVT_4/PVTI_7/PVTF_STATUS']).toBeUndefined()
}, 20_000)

test('Roadmap timeline bounds absurd dates to 480 ticks for every zoom', () => {
  const fields = [
    { id: 'start-date', name: 'Start date', dataType: 'DATE' },
    { id: 'due-date', name: 'Due date', dataType: 'DATE' }
  ]
  const items = [
    {
      id: 'absurd-span',
      content: { title: 'Absurdly long project span' },
      fieldValues: [
        { fieldId: 'start-date', value: '0001-01-01' },
        { fieldId: 'due-date', value: '9999-12-31' }
      ]
    },
    {
      id: 'invalid-date',
      fieldValues: [
        { fieldId: 'start-date', value: '10000-01-01' },
        { fieldId: 'due-date', value: '9999-12-31' }
      ]
    }
  ]

  expect(MAX_ROADMAP_TICKS).toBe(480)
  for (const zoom of ['month', 'quarter', 'year'] as const) {
    const timeline = buildRoadmapTimeline(fields, items, zoom, new Date('2026-10-01T00:00:00.000Z'))
    expect(timeline.ticks.length).toBeLessThanOrEqual(MAX_ROADMAP_TICKS)
    expect(timeline.ticks.length).toBeGreaterThan(0)
    expect(timeline.todayIndex).not.toBeNull()
    expect(timeline.undatedCount).toBe(1)
    expect(timeline.placements).toHaveLength(1)
    expect(Number.isFinite(timeline.placements[0]?.left)).toBe(true)
    expect(Number.isFinite(timeline.placements[0]?.width)).toBe(true)
  }
}, 1_000)

test('Projects CLI discovery command reaches the real daemon method', async () => {
  const instance = await tasks()
  const result = await instance.cli(['--json', 'tasks', 'projects'])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  const output = object(JSON.parse(result.stdout))
  expect(list(output.projects)).toContainEqual(expect.objectContaining({
    id: 'PVT_4',
    owner: 'test-owner',
    number: 4,
    url: 'https://github.com/orgs/test-owner/projects/4'
  }))
}, 20_000)
