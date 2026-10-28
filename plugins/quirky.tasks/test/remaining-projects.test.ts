import { afterEach, expect, test } from 'bun:test'
import { bootTasks } from './helpers'
import { PROJECTS_GH_FIXTURE, seedProjectsState, setProjectScenario, type ProjectFixtureState } from './fixtures/projects'

type TasksTest = {
  call(name: string, params?: Record<string, unknown>): Promise<unknown>
  writeState(value: unknown): void
  readState(): unknown
  cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  cleanup(): Promise<void>
}

const instances: TasksTest[] = []
afterEach(async () => {
  for (const instance of instances.splice(0).reverse()) await instance.cleanup()
})

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array')
  return value
}
async function tasks(state: ProjectFixtureState = seedProjectsState()): Promise<TasksTest> {
  const instance = await bootTasks(PROJECTS_GH_FIXTURE)
  instance.writeState(state)
  instances.push(instance)
  return instance
}

async function waitForFixtureQuery(instance: TasksTest, queryName: string, matches: (variables: Record<string, unknown>) => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const calls = list(object(instance.readState()).calls).map(object)
    if (calls.some((call) => typeof call.query === 'string' && call.query.includes(queryName) && matches(object(call.variables)))) return
    const { promise, resolve } = Promise.withResolvers<void>()
    setImmediate(resolve)
    await promise
  }
  throw new Error(`Timed out waiting for fixture query ${queryName}`)
}

test('the generated Project view CLI returns the selected board and source-qualified items', async () => {
  const instance = await bootTasks(PROJECTS_GH_FIXTURE)
  instances.push(instance)
  instance.writeState(seedProjectsState())
  await instance.call('projectSelect', { action: 'add', input: 'https://github.com/orgs/test-owner/projects/4' })
  await instance.call('projectView', { action: 'select', viewId: 'VIEW_BOARD' })

  const result = await instance.cli(['--json', 'tasks', 'project-view', '--action', 'load'])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  const output = object(JSON.parse(result.stdout))
  const response = object(output.result ?? output)
  expect(object(output.view ?? response.view)).toMatchObject({ id: 'VIEW_BOARD', layout: 'BOARD' })
  const table = object(response.result ?? response.table ?? response)
  const items = list(table.items).map(object)
  expect(items).toContainEqual(expect.objectContaining({
    id: 'PVTI_8',
    content: expect.objectContaining({
      kind: 'pullRequest',
      number: 8,
      url: 'https://github.com/test-owner/test-repo/pull/8',
      repository: 'test-owner/test-repo'
    })
  }))
}, 20_000)
test('a slow Projects view selection cannot replace a newer daemon selection', async () => {
  const state = seedProjectsState({ projectViewsDelayMs: { '4': 1_000 } })
  const projects = object(object(state.resources).projectViews)
  const firstProject = object(projects['organization/test-owner/4'])
  setProjectScenario(state, {
    resources: {
      projectViews: {
        'organization/test-owner/5': {
          ...firstProject,
          projectId: 'PVT_5',
          number: 5,
          title: 'Second fixture project',
          url: 'https://github.com/orgs/test-owner/projects/5'
        }
      }
    }
  })
  const instance = await tasks(state)
  const projectA = object(object(await instance.call('projectSelect', {
    action: 'add',
    input: 'https://github.com/orgs/test-owner/projects/4'
  })).project)
  const projectB = object(object(await instance.call('projectSelect', {
    action: 'add',
    input: 'https://github.com/orgs/test-owner/projects/5'
  })).project)

  // The isolated gh child delays only ProjectViews for project 4, allowing the newer public call to finish first.
  const slowSelection = instance.call('projectView', { action: 'select', project: projectA, viewId: 'VIEW_TABLE' })
  let slowSelectionFinished = false
  void slowSelection.then(() => { slowSelectionFinished = true }, () => { slowSelectionFinished = true })
  await waitForFixtureQuery(instance, 'query ProjectViews', (variables) => Number(variables.number) === 4)
  await instance.call('projectView', { action: 'select', project: projectB, viewId: 'VIEW_BOARD' })
  expect(slowSelectionFinished).toBe(false)
  await slowSelection

  const current = object(await instance.call('state'))
  expect(object(object(current.navigation).project)).toMatchObject({ id: 'PVT_5', viewId: 'VIEW_BOARD' })
  const preferences = object(await instance.call('projectPreferences'))
  const values = Object.values(object(object(preferences.preferences ?? preferences).lastViewByProject))
  expect(values).toContain('VIEW_BOARD')
  expect(values).not.toContain('VIEW_TABLE')
}, 20_000)

test('a late same-view query cannot overwrite the newer stored query', async () => {
  const state = seedProjectsState({ projectItemQueryDelayMs: { 'assignee:@me': 1_000 } })
  const instance = await tasks(state)
  const project = object(object(await instance.call('projectSelect', {
    action: 'add',
    input: 'https://github.com/orgs/test-owner/projects/4'
  })).project)
  await instance.call('projectView', { action: 'select', project, viewId: 'VIEW_TABLE' })

  // Delay the isolated ProjectItems gh response so the second public query commits first.
  const oldQuery = instance.call('projectView', { action: 'load', project, viewId: 'VIEW_TABLE', query: 'assignee:@me' })
  let oldQueryFinished = false
  void oldQuery.then(() => { oldQueryFinished = true }, () => { oldQueryFinished = true })
  await waitForFixtureQuery(instance, 'query ProjectItems', (variables) => variables.query === 'assignee:@me')
  await instance.call('projectView', { action: 'load', project, viewId: 'VIEW_TABLE', query: 'label:latest' })
  expect(oldQueryFinished).toBe(false)
  await oldQuery

  const preferences = object(await instance.call('projectPreferences'))
  const values = Object.values(object(object(preferences.preferences ?? preferences).queryByView))
  expect(values).toContain('label:latest')
  expect(values).not.toContain('assignee:@me')
}, 20_000)
