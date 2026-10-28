import { afterEach, expect, test } from 'bun:test'
import { bootTasks, type TasksTest } from './helpers'
import type { UiLayout } from '@quirky/protocol'
import type { TasksState } from '../src/contracts'

const runs: TasksTest[] = []
afterEach(async () => { for (const run of runs.splice(0).reverse()) await run.cleanup() })
const gh = `if(process.argv.includes('auth')) { console.log('Logged in to github.com account fixture (keyring)\\nActive account: true\\nToken scopes: repo,project,read:org'); } else console.log('{}')`

async function boot() { const run = await bootTasks(gh); runs.push(run); return run }

test('Tasks open and navigation publish the exact daemon-owned view and close restores its predecessor', async () => {
  const run = await boot()
  const before = await run.client.callAny('ui.state', {}) as { layout: UiLayout }
  await run.call('open', { mode: 'prs', repoIds: [run.repoId], query: 'is:pr is:open', page: 3 })
  const state = await run.call('state') as TasksState
  expect(state.navigation.mode).toBe('prs')
  expect(state.navigation.repoIds).toEqual([run.repoId])
  expect(state.navigation.page).toBe(3)
  const visible = await run.client.callAny('ui.state', {}) as { layout: UiLayout }
  expect(visible.layout.view?.id).toBe('view:quirky.tasks/tasks')
  expect(visible.layout.view?.input).toMatchObject({ navigation: { page: 3 } })
  await run.call('close')
  const after = await run.client.callAny('ui.state', {}) as { layout: UiLayout }
  expect(after.layout.view).toEqual(before.layout.view)
}, 20_000)

test('task preferences preserve sticky all and reject hiding the final provider without corrupting prior state', async () => {
  const run = await boot()
  await run.call('preferences', { defaultRepoSelection: null, visibleTaskProviders: ['github'] })
  await expect(run.call('preferences', { visibleTaskProviders: [] })).rejects.toThrow()
  const state = await run.call('state') as TasksState
  expect(state.preferences.visibleTaskProviders).toEqual(['github'])
  expect(state.preferences.defaultRepoSelection).toBeNull()
  await run.call('preferences', { showTasksButton: false, defaultRepoSelection: [run.repoId] })
  await run.call('open')
  const selected = await run.call('state') as TasksState
  expect(selected.preferences.showTasksButton).toBe(false)
  expect(selected.navigation.repoIds).toEqual([run.repoId])
}, 20_000)

test('invalid navigation is atomic and context changes reset page while explicit paging remains direct', async () => {
  const run = await boot()
  await run.call('open', { mode: 'issues', page: 8 })
  await expect(run.call('navigate', { mode: 'invalid', page: 2 })).rejects.toThrow()
  const unchanged = await run.call('state') as TasksState
  expect(unchanged.navigation.page).toBe(8)
  await run.call('navigate', { query: 'is:issue label:bug' })
  const changed = await run.call('state') as TasksState
  expect(changed.navigation.page).toBe(1)
  await run.call('navigate', { page: 11 })
  const paged = await run.call('state') as TasksState
  expect(paged.navigation.page).toBe(11)
}, 20_000)

test('reactivation retains preferences but not transient navigation, and reopening preserves the current list position', async () => {
  const run = await boot()
  await run.call('preferences', { defaultTaskViewPreset: 'mine', defaultRepoSelection: [run.repoId] })
  await run.call('open', { mode: 'issues', page: 9, newIssue: true })
  await run.client.callAny('plugin.disable', { id: 'quirky.tasks' })
  await run.client.callAny('plugin.enable', { id: 'quirky.tasks' })
  const reactivated = await run.call('state') as TasksState
  expect(reactivated.preferences.defaultTaskViewPreset).toBe('mine')
  expect(reactivated.preferences.defaultRepoSelection).toEqual([run.repoId])
  expect(reactivated.navigation.page).toBe(1)
  expect(reactivated.navigation.newIssue).toBe(false)
  await run.call('open')
  const opened = await run.call('state') as TasksState
  expect(opened.navigation.mode).toBe('prs')
  expect(opened.navigation.query).toBe('author:@me is:pr is:open')
  await run.call('navigate', { query: 'is:pr label:ready', page: 4 })
  await run.call('close')
  await run.call('open')
  const reopened = await run.call('state') as TasksState
  expect(reopened.navigation.query).toBe('is:pr label:ready')
  expect(reopened.navigation.page).toBe(4)
}, 20_000)
