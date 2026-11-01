import { afterEach, expect, test } from 'bun:test'
import { bootTasks, type TasksTest } from './helpers'
import { RpcErrorCode, type PluginContext, type UiLayout, type UiToolSlot } from '@quirky/protocol'
import { TASKS_SETTINGS_VIEW, TASKS_VIEW, type TasksState } from '../src/contracts'
import { createTasksEnv } from '../src/env'

const runs: TasksTest[] = []
afterEach(async () => { for (const run of runs.splice(0).reverse()) await run.cleanup() })
const gh = `if(process.argv.includes('auth')) { console.log('Logged in to github.com account fixture (keyring)\\nActive account: true\\nToken scopes: repo,project,read:org'); } else console.log('{}')`

async function boot(extraBuiltins: string[] = []) { const run = await bootTasks(gh, { extraBuiltins }); runs.push(run); return run }

const TOOL = 'sidebar-section:quirky.tasks/tasks'
const REVIEW_VIEW = 'view:quirky.reviews/review'
const CENTER = { id: REVIEW_VIEW, input: { keep: true } }

async function bootWithCenter() { return boot(['quirky.reviews', 'quirky.git']) }

async function layoutOf(run: TasksTest): Promise<UiLayout> {
  return ((await run.client.callAny('ui.state', {})) as { layout: UiLayout }).layout
}

function toolOpen(layout: UiLayout): boolean {
  return Object.values(layout.tools!.open).includes(TOOL)
}

function target(run: TasksTest, number = 281) {
  return { worktree: run.worktree, kind: 'issue' as const, number }
}

test('a plain open shows the panel and leaves the center alone', async () => {
  const run = await bootWithCenter()
  const center = CENTER
  await run.client.callAny('ui.view.open', center)
  await run.call('open')
  const layout = await layoutOf(run)
  expect(toolOpen(layout)).toBe(true)
  expect(layout.view).toEqual(center)
  expect(layout.viewTabs).toEqual([center])
  await run.call('open')
  expect(toolOpen(await layoutOf(run))).toBe(true)
}, 20_000)

test('opening with a row, a project, a new issue or the Projects mode expands and closes the panel', async () => {
  const run = await boot()
  const project = { id: 'p1', owner: 'o', ownerType: 'organization', number: 1, url: 'https://github.com/orgs/o/projects/1' }
  const cases: Record<string, unknown>[] = [{ detail: target(run) }, { project }, { newIssue: true }, { mode: 'projects' }]
  for (const params of cases) {
    await run.client.callAny('ui.tool.open', { id: TOOL })
    expect(toolOpen(await layoutOf(run))).toBe(true)
    await run.call('open', params)
    const layout = await layoutOf(run)
    expect(toolOpen(layout)).toBe(false)
    expect(layout.view?.id).toBe(TASKS_VIEW)
    const state = await run.call('state') as TasksState
    expect(layout.view?.input).toMatchObject({ navigation: { mode: state.navigation.mode }, revision: state.revision })
    await run.call('close')
    expect(toolOpen(await layoutOf(run))).toBe(false)
    await run.call('navigate', { detail: null, project: null, newIssue: false, mode: 'issues' })
  }
}, 30_000)

test('a plain open keeps the open row and the tab that is showing', async () => {
  const run = await boot()
  await run.call('open', { detail: target(run) })
  await run.call('open')
  const state = await run.call('state') as TasksState
  expect(state.navigation.detail).toEqual(target(run))
  const layout = await layoutOf(run)
  expect(layout.view?.id).toBe(TASKS_VIEW)
  expect(toolOpen(layout)).toBe(false)
}, 20_000)

test('a plain open brings a background Tasks tab forward instead of opening the panel', async () => {
  const run = await bootWithCenter()
  await run.call('open', { detail: target(run) })
  await run.client.callAny('ui.view.open', { id: REVIEW_VIEW })
  await run.call('open')
  const layout = await layoutOf(run)
  expect(layout.view?.id).toBe(TASKS_VIEW)
  expect(layout.viewTabs?.map(({ id }) => id)).toEqual([TASKS_VIEW, REVIEW_VIEW])
  expect(toolOpen(layout)).toBe(false)
}, 20_000)

test('navigate never opens or closes anything, and republishes only while the tab is active', async () => {
  const run = await bootWithCenter()
  const before = await layoutOf(run)
  await run.call('navigate', { mode: 'prs', query: 'is:pr is:open', page: 2 })
  expect(await layoutOf(run)).toEqual(before)

  await run.client.callAny('ui.tool.open', { id: TOOL })
  const withPanel = await layoutOf(run)
  await run.call('navigate', { page: 3 })
  expect(await layoutOf(run)).toEqual(withPanel)

  await run.call('open', { detail: target(run) })
  const revision = ((await run.call('state')) as TasksState).revision
  await run.call('navigate', { page: 4 })
  let layout = await layoutOf(run)
  expect(layout.view?.input).toMatchObject({ navigation: { page: 4 }, revision: revision + 1 })

  await run.client.callAny('ui.view.open', { id: REVIEW_VIEW })
  const behind = await layoutOf(run)
  await run.call('navigate', { page: 5 })
  layout = await layoutOf(run)
  expect(layout.view).toEqual(behind.view)
  expect(layout.viewTabs).toEqual(behind.viewTabs)
  expect(layout.viewTabs?.find(({ id }) => id === TASKS_VIEW)?.input).toMatchObject({ navigation: { page: 4 } })
}, 30_000)

test('lastList follows every issues or PRs state and ignores Projects', async () => {
  const run = await boot()
  const initial = await run.call('state') as TasksState
  expect(initial.navigation.lastList).toEqual({ mode: 'issues', query: 'is:issue is:open', page: 1 })
  await run.call('navigate', { mode: 'prs', query: 'is:pr label:ready', page: 3 })
  expect(((await run.call('state')) as TasksState).navigation.lastList).toEqual({ mode: 'prs', query: 'is:pr label:ready', page: 3 })
  await run.call('navigate', { page: 4 })
  expect(((await run.call('state')) as TasksState).navigation.lastList).toEqual({ mode: 'prs', query: 'is:pr label:ready', page: 4 })
  await run.call('navigate', { mode: 'projects' })
  const projects = await run.call('state') as TasksState
  expect(projects.navigation.mode).toBe('projects')
  expect(projects.navigation.lastList).toEqual({ mode: 'prs', query: 'is:pr label:ready', page: 4 })
  await run.call('navigate', { mode: 'issues' })
  expect(((await run.call('state')) as TasksState).navigation.lastList).toEqual({ mode: 'issues', query: 'is:issue is:open', page: 1 })
}, 20_000)

test('the first open sets lastList from the default preset, including when it opens on Projects', async () => {
  const run = await boot()
  await run.call('preferences', { defaultTaskViewPreset: 'needs-review' })
  await run.call('open', { mode: 'projects' })
  const state = await run.call('state') as TasksState
  expect(state.navigation.mode).toBe('projects')
  expect(state.navigation.lastList).toEqual({ mode: 'prs', query: 'review-requested:@me is:pr is:open', page: 1 })
}, 20_000)

test('prepare applies the first-open defaults once and changes no layout', async () => {
  const run = await boot()
  await run.call('preferences', { defaultTaskViewPreset: 'needs-review', defaultRepoSelection: [run.repoId] })
  const before = await layoutOf(run)
  const prepared = await run.call('prepare') as TasksState
  expect(prepared.navigation).toMatchObject({
    mode: 'prs',
    query: 'review-requested:@me is:pr is:open',
    repoIds: [run.repoId],
    lastList: { mode: 'prs', query: 'review-requested:@me is:pr is:open', page: 1 }
  })
  expect(await layoutOf(run)).toEqual(before)

  await run.call('navigate', { query: 'is:pr label:ready', page: 2 })
  const again = await run.call('prepare') as TasksState
  expect(again.navigation).toMatchObject({ query: 'is:pr label:ready', page: 2 })
  await run.call('open')
  expect(((await run.call('state')) as TasksState).navigation).toMatchObject({ query: 'is:pr label:ready', page: 2 })
  expect(toolOpen(await layoutOf(run))).toBe(true)
}, 20_000)

test('a detail open after prepare keeps the prepared defaults and expands', async () => {
  const run = await boot()
  await run.call('preferences', { defaultTaskViewPreset: 'mine' })
  await run.call('prepare')
  await run.call('open', { detail: target(run) })
  const state = await run.call('state') as TasksState
  expect(state.navigation).toMatchObject({ mode: 'prs', query: 'author:@me is:pr is:open', detail: target(run) })
  expect((await layoutOf(run)).view?.id).toBe(TASKS_VIEW)
}, 20_000)

test('close shuts the slot, the active tab or a background tab, and does nothing when Tasks is closed', async () => {
  const run = await bootWithCenter()
  const center = CENTER
  await run.client.callAny('ui.view.open', center)

  expect(await run.call('close')).toEqual({ closed: true })
  expect(await layoutOf(run)).toMatchObject({ view: center, viewTabs: [center] })

  await run.client.callAny('ui.tool.open', { id: TOOL })
  expect(await run.call('close')).toEqual({ closed: true })
  const afterSlot = await layoutOf(run)
  expect(toolOpen(afterSlot)).toBe(false)
  expect(afterSlot.view).toEqual(center)

  await run.call('open', { detail: target(run) })
  expect(await run.call('close')).toEqual({ closed: true })
  const afterTab = await layoutOf(run)
  expect(afterTab.view).toEqual(center)
  expect(afterTab.viewTabs).toEqual([center])
  expect(toolOpen(afterTab)).toBe(false)

  await run.call('open', { detail: target(run) })
  await run.client.callAny('ui.view.open', { id: TASKS_SETTINGS_VIEW })
  expect(await run.call('close')).toEqual({ closed: true })
  const afterBackground = await layoutOf(run)
  expect(afterBackground.viewTabs?.map(({ id }) => id)).toEqual([REVIEW_VIEW, TASKS_SETTINGS_VIEW])
  expect(toolOpen(afterBackground)).toBe(false)
}, 30_000)

test('Tasks navigation and close stay in the open tool without changing the center view', async () => {
  const run = await boot()
  const center = { id: TASKS_SETTINGS_VIEW, input: { source: 'keep' } }
  await run.client.callAny('ui.view.open', center)
  await run.client.callAny('ui.tool.open', { id: TOOL })

  const before = await layoutOf(run)
  const slot = before.tools!.placements[TOOL] as UiToolSlot
  expect(before.tools!.open[slot]).toBe(TOOL)

  await run.call('navigate', { mode: 'prs', query: 'is:pr is:open' })
  const navigated = await layoutOf(run)
  expect(navigated.view).toEqual(center)
  expect(navigated.viewTabs).toEqual([center])
  expect(navigated.tools!.open[slot]).toBe(TOOL)

  await run.call('close')
  const closed = await layoutOf(run)
  expect(closed.tools!.open[slot]).toBeNull()
  expect(closed.view).toEqual(center)
  expect(closed.viewTabs).toEqual([center])
}, 20_000)

test('returning from Task Sources closes the settings tab, then follows the open rules and keeps the workspace', async () => {
  const run = await boot(['quirky.agents', 'quirky.session'])
  const workspaceView = { id: 'view:quirky.session/worktree', input: { worktree: run.worktree } }
  await run.client.callAny('ui.view.open', workspaceView)
  await run.client.callAny('ui.tool.open', { id: TOOL })

  await run.client.callAny('quirky.tasks/settings', {})
  let visible = await layoutOf(run)
  expect(visible.view).toEqual({ id: TASKS_SETTINGS_VIEW, input: { worktree: run.worktree } })
  expect(visible.viewTabs).toContainEqual(workspaceView)

  await run.client.callAny('quirky.tasks/open', {})
  visible = await layoutOf(run)
  expect(visible.view).toEqual(workspaceView)
  expect(visible.viewTabs?.map(({ id }) => id)).toEqual([workspaceView.id])
  expect(toolOpen(visible)).toBe(true)

  await run.client.callAny('quirky.tasks/settings', {})
  await run.client.callAny('quirky.tasks/open', { detail: target(run) })
  visible = await layoutOf(run)
  expect(visible.view?.id).toBe(TASKS_VIEW)
  expect(visible.view?.input).toMatchObject({ worktree: run.worktree })
  expect(visible.viewTabs?.map(({ id }) => id)).toEqual([workspaceView.id, TASKS_VIEW])
  expect(toolOpen(visible)).toBe(false)
}, 30_000)

test('Task Sources falls back to the predecessor workspace only when Tasks is the center view', async () => {
  const run = await boot(['quirky.agents', 'quirky.session'])
  const workspaceView = { id: 'view:quirky.session/worktree', input: { worktree: run.worktree } }
  await run.client.callAny('ui.view.open', workspaceView)
  await run.client.callAny('quirky.tasks/open', { detail: target(run) })
  expect((await layoutOf(run)).view?.id).toBe(TASKS_VIEW)

  await run.client.callAny('quirky.tasks/settings', {})
  let visible = await layoutOf(run)
  expect(visible.view).toMatchObject({ id: TASKS_SETTINGS_VIEW, input: { worktree: run.worktree } })

  await run.client.callAny('ui.view.open', { id: TASKS_SETTINGS_VIEW, input: { source: 'unrelated' } })
  await run.client.callAny('quirky.tasks/settings', {})
  visible = await layoutOf(run)
  expect(visible.view).toEqual({ id: TASKS_SETTINGS_VIEW })
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


type ViewOpen = { id: string; input: { revision: number } }

/** A context whose layout shows the Tasks tab; `open` handles each ui.view.open and `stateDelays` slows successive ui.state reads. */
function stubbedContext(open: (params: ViewOpen) => Promise<unknown>, stateDelays: number[] = []): PluginContext {
  let stateReads = 0
  return {
    openStore: () => ({ get: () => undefined, run: () => undefined }),
    getSetting: () => undefined,
    emit: () => true,
    error: (_kind: string, message: string) => new Error(message),
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'ui.state') {
        const delay = stateDelays[stateReads++] ?? 0
        await new Promise((resolve) => setTimeout(resolve, delay))
        return { layout: { view: { id: TASKS_VIEW } } }
      }
      if (method === 'ui.contributions') return {}
      if (method === 'ui.view.open') return open(params as unknown as ViewOpen)
      throw new Error(`unexpected call ${method}`)
    }
  } as unknown as PluginContext
}

test('overlapping navigates leave the view input at the daemon revision', async () => {
  const published: number[] = []
  const env = createTasksEnv(stubbedContext(async ({ input }) => { published.push(input.revision) }, [40, 0]))
  await Promise.all([env.navigate({ page: 2 }), env.navigate({ page: 3 })])
  expect(published.at(-1)).toBe(env.read().revision)
  expect(env.read().revision).toBe(2)
})

test('overlapping navigates against the daemon leave the open tab at the current revision', async () => {
  const run = await boot()
  await run.call('open', { detail: target(run) })
  await Promise.all([run.call('navigate', { page: 2 }), run.call('navigate', { page: 3 }), run.call('navigate', { page: 4 })])
  const state = await run.call('state') as TasksState
  expect((await layoutOf(run)).view?.input).toMatchObject({ revision: state.revision })
}, 20_000)

test('navigate keeps its state change when several windows are open', async () => {
  const conflict = Object.assign(new Error('multiple Quirky windows are open; specify connId'), { code: RpcErrorCode.Conflict })
  const env = createTasksEnv(stubbedContext(async () => { throw conflict }))
  const result = await env.navigate({ page: 2 })
  expect(result.navigation.page).toBe(2)
  expect(env.read().navigation.page).toBe(2)
})

test('navigate still rejects when the view republish fails for another reason', async () => {
  const env = createTasksEnv(stubbedContext(async () => { throw Object.assign(new Error('boom'), { code: RpcErrorCode.Internal }) }))
  await expect(env.navigate({ page: 2 })).rejects.toThrow('boom')
})
