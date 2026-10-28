import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ItemTarget, TasksState } from '../src/contracts'
import type { UiPluginContext } from '@quirky/protocol'
import { TasksList } from '../src/list/TasksList'
import { IssueSurface } from '../src/issue/IssueSurface'
import { bootTasks, type TasksTest } from './helpers'
import { fixtureIssue, fixturePullRequest, listFixtureSource, seedListFixture } from './fixtures/list'
import { issueFixtureSource, seedIssueFixture } from './fixtures/issue'
import { useReviewNavigation } from '../src/list/useReviewNavigation'

const hosts: TasksTest[] = []
const roots: { root: Root; container: HTMLElement }[] = []
afterEach(async () => {
  for (const mounted of roots.splice(0).reverse()) {
    await React.act(async () => { mounted.root.unmount() })
    mounted.container.remove()
  }
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
beforeAll(() => {
  GlobalRegistrator.register()
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}
function values(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function taskState(value: unknown): TasksState { return value as TasksState }
function fixtureState(host: TasksTest): Record<string, unknown> { return record(host.readState()) }
function ReviewNavigationHarness(props: { context: UiPluginContext; target: ItemTarget; errors: string[] }) {
  const open = useReviewNavigation(props.context, (message) => props.errors.push(message))
  return React.createElement('button', { type: 'button', onClick: () => { void open(props.target, 'checks') } }, 'Open review')
}
test('the rendered Tasks review hook forwards full source identity to the public Reviews method', async () => {
  const host = await bootTasks(listFixtureSource, {
    upstream: 'https://github.com/upstream-owner/upstream-repo.git',
    extraBuiltins: ['quirky.reviews', 'quirky.git']
  })
  hosts.push(host)
  const origin = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  const upstream = fixturePullRequest('upstream-owner', 'upstream-repo', 12, '2026-10-02T00:00:00Z')
  host.writeState(seedListFixture({
    'test-owner/test-repo': [origin],
    'upstream-owner/upstream-repo': [upstream]
  }))
  const target: ItemTarget = {
    worktree: host.worktree,
    kind: 'pullRequest',
    number: 12,
    url: upstream.url,
    host: 'github.com',
    owner: 'upstream-owner',
    repo: 'upstream-repo'
  }
  const driver = uiContext(host)
  const errors: string[] = []
  const opened = driver.wait('quirky.reviews/open')
  const mounted = await mount(React.createElement(ReviewNavigationHarness, { context: driver.context, target, errors }))
  await React.act(async () => { button(mounted.container, 'Open review').click(); await opened })

  const state = await host.client.callAny('quirky.reviews/state', { worktree: host.worktree })
  expect(record(record(state).detail).target).toMatchObject({
    number: 12,
    tab: 'checks',
    prRepo: { host: 'github.com', owner: 'upstream-owner', repo: 'upstream-repo' }
  })
  expect(errors).toEqual([])
}, 30_000)


function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}
function initializeRepo(path: string, remote: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '--quiet', '--initial-branch=main')
  git(path, 'config', 'user.name', 'Tasks fixture')
  git(path, 'config', 'user.email', 'tasks@example.invalid')
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  git(path, 'add', 'README.md')
  git(path, 'commit', '--quiet', '-m', 'fixture')
  git(path, 'remote', 'add', 'origin', remote)
}
async function addRepo(host: TasksTest, folder: string, remote: string): Promise<string> {
  const path = join(host.root, folder)
  initializeRepo(path, remote)
  const repository = record(await host.client.callAny('quirky.repo/add', { path }))
  if (typeof repository.id !== 'string') throw new Error('repository registration returned no ID')
  return repository.id
}
function repoIds(value: unknown): string[] {
  const result = record(value)
  return values(result.items).map((item) => record(item).repoId).filter((id): id is string => typeof id === 'string')
}

type CallWaiter = { method: string; resolve(): void }
type CallHold = {
  method: string
  predicate?: (params: Record<string, unknown>) => boolean
  reached: Promise<void>
  reach(): void
  released: Promise<void>
  release(): void
  finished: Promise<void>
  finish(): void
}
function uiContext(host: TasksTest) {
  const waiters: CallWaiter[] = []
  const holds: CallHold[] = []
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      const completeWaiters = () => {
        const index = waiters.findIndex((waiter) => waiter.method === method)
        if (index >= 0) waiters.splice(index, 1)[0]!.resolve()
      }
      let result: unknown
      try {
        result = await host.client.callAny(method, { worktree: host.worktree, ...params })
      } catch (error) {
        completeWaiters()
        throw error
      }
      completeWaiters()
      const holdIndex = holds.findIndex((hold) => hold.method === method && (!hold.predicate || hold.predicate(params)))
      if (holdIndex >= 0) {
        const hold = holds.splice(holdIndex, 1)[0]!
        hold.reach()
        await hold.released
        hold.finish()
      }
      return result
    },
    executeCommand: (command: string, params: Record<string, unknown> = {}) => host.client.callAny(command.replace(/^command:/u, ''), { worktree: host.worktree, ...params }),
    confirm: async () => true,
    toast: () => undefined
  } as unknown as UiPluginContext
  return {
    context,
    wait(method: string): Promise<void> {
      const deferred = Promise.withResolvers<void>()
      waiters.push({ method, resolve: deferred.resolve })
      return deferred.promise
    },
    hold(method: string, predicate?: (params: Record<string, unknown>) => boolean) {
      const reached = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<void>()
      const hold: CallHold = {
        method,
        predicate,
        reached: reached.promise,
        reach: () => reached.resolve(),
        released: released.promise,
        release: () => released.resolve(),
        finished: finished.promise,
        finish: () => finished.resolve()
      }
      holds.push(hold)
      return { reached: reached.promise, finished: finished.promise, release: hold.release }
    }
  }
}

async function mount(element: React.ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await React.act(async () => { root.render(element) })
  return { container, root }
}
async function click(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('expected a rendered button')
  await React.act(async () => { element.click() })
}
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!found) throw new Error(`button not found: ${text}`)
  return found
}


test('sticky all includes repositories added later and API, CLI, and visible navigation retain their exact projection', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const betaId = await addRepo(host, 'repo-beta', 'https://github.com/beta-owner/beta-repo.git')
  host.writeState(seedListFixture({
    'test-owner/test-repo': [fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')],
    'beta-owner/beta-repo': [fixtureIssue('beta-owner', 'beta-repo', 8, '2026-10-02T00:00:00Z')]
  }))
  await host.call('preferences', { defaultRepoSelection: null })
  await host.call('open', { mode: 'issues', repoIds: null, query: 'is:issue is:open' })

  const initial = await host.call('list', { mode: 'issues', query: 'is:issue is:open' })
  expect(new Set(repoIds(initial))).toEqual(new Set([host.repoId, betaId]))

  const gammaId = await addRepo(host, 'repo-gamma', 'https://github.com/gamma-owner/gamma-repo.git')
  const stored = fixtureState(host)
  host.writeState({ ...stored, items: { ...record(stored.items), 'gamma-owner/gamma-repo': [fixtureIssue('gamma-owner', 'gamma-repo', 9, '2026-10-03T00:00:00Z')] } })
  const apiList = await host.call('list', { mode: 'issues', query: 'is:issue is:open', refresh: true })
  expect(new Set(repoIds(apiList))).toEqual(new Set([host.repoId, betaId, gammaId]))

  const cli = await host.cli(['--json', 'tasks', 'list', '--worktree', host.worktree, '--mode', 'issues', '--query', 'is:issue is:open'])
  expect(cli).toMatchObject({ code: 0, stderr: '' })
  expect(new Set(repoIds(JSON.parse(cli.stdout)))).toEqual(new Set([host.repoId, betaId, gammaId]))
  const state = taskState(await host.call('state'))
  expect(state.preferences.defaultRepoSelection).toBeNull()
  expect(state.navigation.repoIds).toBeNull()
  const visible = record(await host.client.callAny('ui.state', {}))
  expect(record(record(visible.layout).view).input).toMatchObject({ navigation: { repoIds: null } })
}, 30_000)

test('an explicit saved repository survives a temporary Beta deep link in API, CLI, and visible navigation', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const betaId = await addRepo(host, 'repo-beta', 'https://github.com/beta-owner/beta-repo.git')
  host.writeState(seedListFixture({
    'test-owner/test-repo': [fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')],
    'beta-owner/beta-repo': [fixtureIssue('beta-owner', 'beta-repo', 8, '2026-10-02T00:00:00Z')]
  }))
  await host.call('preferences', { defaultRepoSelection: [host.repoId] })
  await host.call('open', { mode: 'issues', repoIds: [betaId], query: 'is:issue is:open' })

  const state = taskState(await host.call('state'))
  expect(state.preferences.defaultRepoSelection).toEqual([host.repoId])
  expect(state.navigation.repoIds).toEqual([betaId])
  const apiList = await host.call('list', { mode: 'issues', query: 'is:issue is:open' })
  expect(new Set(repoIds(apiList))).toEqual(new Set([betaId]))
  const cli = await host.cli(['--json', 'tasks', 'list', '--worktree', host.worktree, '--mode', 'issues', '--query', 'is:issue is:open'])
  expect(cli).toMatchObject({ code: 0, stderr: '' })
  expect(new Set(repoIds(JSON.parse(cli.stdout)))).toEqual(new Set([betaId]))
  const visible = record(await host.client.callAny('ui.state', {}))
  expect(record(record(visible.layout).view).input).toMatchObject({ navigation: { repoIds: [betaId] } })
}, 30_000)

test('changing Tasks mode clears an old issue target before publishing the new view', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const target = { worktree: host.worktree, kind: 'issue', number: 7, url: 'https://github.com/test-owner/test-repo/issues/7' }
  await host.call('navigate', { mode: 'issues', detail: target, query: 'is:issue is:open' })
  await host.call('navigate', { mode: 'prs' })
  const state = taskState(await host.call('state'))
  expect(state.navigation).toMatchObject({ mode: 'prs', query: 'is:pr is:open', detail: null })
  const visible = record(await host.client.callAny('ui.state', {}))
  expect(record(record(visible.layout).view).input).toMatchObject({ navigation: { mode: 'prs', detail: null } })
}, 20_000)

test('queued PR outcomes remain open, and auto-merge enable/disable outcomes remain distinct from merge', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  const target = { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url }
  const expectedHead = pull.headRefOid
  if (!expectedHead) throw new Error('fixture pull-request head was not set')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }, {
    mergeQueueRequired: true,
    autoMergeAllowed: true,
    asyncMergeOutcome: 'enqueued'
  }))

  const queued = record(await host.call('row', { target, action: 'merge', method: 'squash', mergeAction: 'queue', expectedHead, yes: true }))
  expect(queued.kind).toBe('enqueued')
  const queuedItem = record(values(record(fixtureState(host).items)['test-owner/test-repo'])[0])
  expect(queuedItem.state).toBe('open')
  const listed = record(await host.call('list', { mode: 'prs', repoIds: [host.repoId], query: 'is:pr is:open', refresh: true }))
  expect(values(listed.items).map((item) => record(item).state)).toEqual(['open'])

  const directHost = await bootTasks(listFixtureSource)
  hosts.push(directHost)
  const directPull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  const directHead = directPull.headRefOid
  if (!directHead) throw new Error('fixture pull-request head was not set')
  directHost.writeState(seedListFixture({ 'test-owner/test-repo': [directPull] }, { mergeQueueRequired: false, autoMergeAllowed: true }))
  const directTarget = { worktree: directHost.worktree, kind: 'pullRequest', number: 12, url: directPull.url }
  const enabled = record(await directHost.call('row', { target: directTarget, action: 'autoMerge', autoMergeAction: 'enable', expectedHead: directHead, method: 'squash' }))
  expect(record(enabled.result)).toMatchObject({ enabled: true, number: 12 })
  const enabledMetadata = record(await directHost.call('mergeMetadata', { target: directTarget }))
  expect(enabledMetadata.autoMergeEnabled).toBe(true)
  expect(typeof record(record(enabledMetadata.review).autoMergeRequest).enabledAt).toBe('string')
  const disabled = record(await directHost.call('row', { target: directTarget, action: 'autoMerge', autoMergeAction: 'disable' }))
  expect(record(disabled.result)).toMatchObject({ enabled: false, number: 12 })
  const disabledMetadata = record(await directHost.call('mergeMetadata', { target: directTarget }))
  expect(disabledMetadata.autoMergeEnabled).toBe(false)
  const finalItem = record(values(record(fixtureState(directHost).items)['test-owner/test-repo'])[0])
  expect(finalItem.state).toBe('open')
}, 30_000)

test('a pull request whose head advances after safety metadata cannot be merged with the stale head', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  const expectedHead = pull.headRefOid
  if (!expectedHead) throw new Error('fixture pull-request head was not set')
  const target = { worktree: host.worktree, kind: 'pullRequest', number: 12, url: pull.url }
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }, { mergeQueueRequired: false, autoMergeAllowed: true }))
  await host.call('mergeMetadata', { target })

  const nextHead = 'c'.repeat(40)
  const state = fixtureState(host)
  const items = record(state.items)
  const changedPull = { ...record(values(items['test-owner/test-repo'])[0]), headRefOid: nextHead }
  host.writeState({ ...state, items: { ...items, 'test-owner/test-repo': [changedPull] } })
  const beforeMutation = host.invocations().length
  await expect(host.call('row', { target, action: 'merge', method: 'squash', expectedHead, yes: true })).rejects.toThrow(/head changed/i)

  const afterCalls = host.invocations().slice(beforeMutation)
  expect(afterCalls.some((call) => call.args[0] === 'pr' && call.args[1] === 'merge')).toBe(false)
  const persisted = record(values(record(fixtureState(host).items)['test-owner/test-repo'])[0])
  expect(persisted).toMatchObject({ state: 'open', headRefOid: nextHead })
}, 30_000)

test('an origin switch prevents a lagging upstream refresh from repainting the current issue list', async () => {
  const host = await bootTasks(listFixtureSource, { upstream: 'https://github.com/upstream-owner/upstream-repo.git' })
  hosts.push(host)
  const origin = fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')
  origin.title = 'Origin issue 7'
  const upstream = fixtureIssue('upstream-owner', 'upstream-repo', 7, '2026-10-02T00:00:00Z')
  upstream.title = 'Upstream issue 7'
  host.writeState(seedListFixture({
    'test-owner/test-repo': [origin],
    'upstream-owner/upstream-repo': [upstream]
  }))
  await host.call('navigate', { mode: 'issues', repoIds: [host.repoId], query: 'is:issue is:open' })
  const state = taskState(await host.call('state'))
  const driver = uiContext(host)
  const initialList = driver.wait('quirky.tasks/list')
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  await React.act(async () => { await initialList })
  expect(mounted.container.textContent).toContain('Upstream issue 7')

  const oldRefresh = driver.hold('quirky.tasks/list', (params) => params.noCache === true)
  const oldRead = driver.wait('quirky.tasks/list')
  await React.act(async () => { button(mounted.container, 'Refresh').click(); await oldRead; await oldRefresh.reached })
  const sourceWrite = driver.wait('quirky.tasks/row')
  const originList = driver.wait('quirky.tasks/list')
  await React.act(async () => { button(mounted.container, 'Origin').click(); await sourceWrite; await originList })
  expect(mounted.container.textContent).toContain('Origin issue 7')

  await React.act(async () => { oldRefresh.release(); await oldRefresh.finished })
  expect(mounted.container.textContent).toContain('Origin issue 7')
  expect(mounted.container.textContent).not.toContain('Upstream issue 7')
}, 30_000)

test('a delayed issue list cannot repaint the PR view after a mode switch', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  host.writeState(seedListFixture({
    'test-owner/test-repo': [
      fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z'),
      fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-02T00:00:00Z')
    ]
  }))
  await host.call('navigate', { mode: 'issues', repoIds: [host.repoId], query: 'is:issue is:open' })
  const initialState = taskState(await host.call('state'))
  const driver = uiContext(host)
  const oldResponse = driver.hold('quirky.tasks/list', (params) => params.mode === 'issues')
  const firstLoad = driver.wait('quirky.tasks/list')
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state: initialState, refresh: async () => undefined }))
  await React.act(async () => { await firstLoad; await oldResponse.reached })

  const nextState = {
    ...initialState,
    navigation: { ...initialState.navigation, mode: 'prs' as const, query: 'is:pr is:open' }
  }
  const nextLoad = driver.wait('quirky.tasks/list')
  const checksLoaded = driver.wait('quirky.tasks/checks')
  const metadataLoaded = driver.wait('quirky.tasks/mergeMetadata')
  await React.act(async () => {
    mounted.root.render(React.createElement(TasksList, { context: driver.context, state: nextState, refresh: async () => undefined }))
    await nextLoad
    await checksLoaded
    await metadataLoaded
  })
  expect(mounted.container.textContent).toContain('Pull request 12')
  expect(mounted.container.textContent).not.toContain('Issue 7')

  await React.act(async () => { oldResponse.release(); await oldResponse.finished })
  expect(mounted.container.textContent).toContain('Pull request 12')
  expect(mounted.container.textContent).not.toContain('Issue 7')
}, 30_000)

test('a failed assignee edit preserves an earlier successful status change in the rendered row', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const issue = fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')
  issue.assignees = ['alex']
  host.writeState(seedListFixture({ 'test-owner/test-repo': [issue] }))
  await host.call('navigate', { mode: 'issues', repoIds: [host.repoId], query: 'is:issue' })
  const state = taskState(await host.call('state'))
  const driver = uiContext(host)
  const firstList = driver.wait('quirky.tasks/list')
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  await React.act(async () => { await firstList })

  const statusMenu = mounted.container.querySelector('tbody button[aria-haspopup="menu"]')
  await click(statusMenu)
  const closeRequest = driver.wait('quirky.tasks/row')
  await React.act(async () => { button(mounted.container, 'Close as completed').click(); await closeRequest })
  expect(mounted.container.textContent).toContain('Closed ▾')

  const current = fixtureState(host)
  host.writeState({ ...current, failIssueUpdate: true })
  const optionsRead = driver.wait('quirky.tasks/options')
  const assigneeButton = mounted.container.querySelector('tbody button[aria-haspopup="dialog"]')
  await React.act(async () => { if (!(assigneeButton instanceof HTMLElement)) throw new Error('assignee button was not rendered'); assigneeButton.click(); await optionsRead })
  const selectable = [...mounted.container.querySelectorAll('label')].find((label) => label.textContent?.includes('fixture-user'))
  const checkbox = selectable?.querySelector('input[type="checkbox"]')
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('assignable user checkbox was not rendered')
  await click(checkbox)
  const failedUpdate = driver.wait('quirky.tasks/row')
  const adoptionRead = driver.wait('quirky.tasks/list')
  await React.act(async () => { button(mounted.container, 'Save assignees').click(); await failedUpdate })
  await React.act(async () => { await adoptionRead })

  expect(mounted.container.textContent).toContain('Closed ▾')
  expect(mounted.container.textContent).toContain('fixture issue update failure')
}, 30_000)

test('quiet adoption retains a confirmed status while search indexing lags, then adopts the indexed row', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const issue = fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [issue] }))
  await host.call('navigate', { mode: 'issues', repoIds: [host.repoId], query: 'is:issue' })
  const state = taskState(await host.call('state'))
  const driver = uiContext(host)
  const firstList = driver.wait('quirky.tasks/list')
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  await React.act(async () => { await firstList })
  host.writeState({
    ...fixtureState(host),
    lagSearch: { repository: 'test-owner/test-repo', remaining: 1, items: [issue] }
  })

  await click(mounted.container.querySelector('tbody button[aria-haspopup="menu"]'))
  const rowCall = driver.wait('quirky.tasks/row')
  const firstQuietRead = driver.wait('quirky.tasks/list')
  await React.act(async () => { button(mounted.container, 'Close as completed').click(); await rowCall })
  await React.act(async () => { await firstQuietRead })
  const secondQuietRead = driver.wait('quirky.tasks/list')
  await React.act(async () => { await secondQuietRead })

  expect(mounted.container.textContent).toContain('Closed ▾')
  expect(record(fixtureState(host).lagSearch).remaining).toBe(0)
  expect(record(values(record(fixtureState(host).items)['test-owner/test-repo'])[0]).state).toBe('closed')
}, 30_000)

test('a failed later reviewer request retains an earlier confirmed reviewer update', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const pull = fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  pull.requestedReviewers = ['existing-reviewer']
  host.writeState(seedListFixture({ 'test-owner/test-repo': [pull] }))
  await host.call('navigate', { mode: 'prs', repoIds: [host.repoId], query: 'is:pr is:open' })
  const state = taskState(await host.call('state'))
  const driver = uiContext(host)
  const firstList = driver.wait('quirky.tasks/list')
  const checksLoaded = driver.wait('quirky.tasks/checks')
  const initialMetadata = driver.wait('quirky.tasks/mergeMetadata')
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  await React.act(async () => { await firstList; await initialMetadata; await checksLoaded })

  const reviewerButton = () => mounted.container.querySelector('tbody button[aria-haspopup="dialog"]')
  await click(reviewerButton())
  const reviewerBox = () => mounted.container.querySelector('textarea[aria-label="Type or choose a reviewer"]')
  const input = reviewerBox()
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('reviewer input was not rendered')
  await React.act(async () => {
    input.value = 'first-reviewer'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const firstWrite = driver.wait('quirky.tasks/row')
  const reviewerAdoption = driver.wait('quirky.tasks/list')
  await React.act(async () => { button(mounted.container, 'Request reviewers').click(); await firstWrite })
  await React.act(async () => { await reviewerAdoption })
  expect(reviewerButton()?.textContent).toContain('first-reviewer')

  host.writeState({ ...fixtureState(host), failPRReviewerEdit: true })
  await click(reviewerButton())
  const nextInput = reviewerBox()
  if (!(nextInput instanceof HTMLTextAreaElement)) throw new Error('reviewer input was not rendered after reopening')
  await React.act(async () => {
    nextInput.value = 'second-reviewer'
    nextInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const failedWrite = driver.wait('quirky.tasks/row')
  await React.act(async () => { button(mounted.container, 'Request reviewers').click(); await failedWrite })

  expect(reviewerButton()?.textContent).toContain('first-reviewer')
  expect(reviewerButton()?.textContent).not.toContain('second-reviewer')
  expect(mounted.container.querySelector('[role="alert"]')).not.toBeNull()
}, 30_000)

test('confirmed issue comments remain visible after a lagging detail read', async () => {
  const host = await bootTasks(issueFixtureSource)
  hosts.push(host)
  const priorComment = {
    id: 491,
    body: 'original comment',
    issue_url: 'https://api.github.com/repos/test-owner/test-repo/issues/22',
    html_url: 'https://github.com/test-owner/test-repo/issues/22#issuecomment-491',
    created_at: '2026-10-01T00:00:00Z',
    user: { login: 'prior-author' }
  }
  host.writeState(seedIssueFixture(host.readState(), { number: 22, comments: [priorComment] }))
  await host.call('navigate', {
    mode: 'issues',
    repoIds: [host.repoId],
    detail: { worktree: host.worktree, kind: 'issue', number: 22, url: 'https://github.com/test-owner/test-repo/issues/22' }
  })
  const state = taskState(await host.call('state'))
  const driver = uiContext(host)
  const initialDetail = driver.wait('quirky.tasks/issue')
  const choiceReads = [driver.wait('quirky.tasks/issueChoices'), driver.wait('quirky.tasks/issueChoices'), driver.wait('quirky.tasks/issueChoices')]
  const mounted = await mount(React.createElement(IssueSurface, { context: driver.context, state, refresh: async () => undefined }))
  await React.act(async () => { await initialDetail; await Promise.all(choiceReads) })
  expect(mounted.container.textContent).toContain('original comment')

  const commentBox = mounted.container.querySelector('textarea[aria-label="Add a comment"]')
  if (!(commentBox instanceof HTMLTextAreaElement)) throw new Error('issue comment composer was not rendered')
  await React.act(async () => {
    commentBox.value = 'confirmed new comment'
    commentBox.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const posted = driver.wait('quirky.tasks/issueComment')
  await React.act(async () => { button(mounted.container, 'Comment').click(); await posted })
  expect(mounted.container.textContent).toContain('confirmed new comment')

  const updated = fixtureState(host)
  host.writeState({ ...updated, laggingCommentReads: 1 })
  const refreshRead = driver.wait('quirky.tasks/issue')
  const refreshButton = [...mounted.container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Refresh')
  await React.act(async () => {
    if (!(refreshButton instanceof HTMLElement)) throw new Error('issue refresh button was not rendered')
    refreshButton.click()
    await refreshRead
  })
  expect(mounted.container.textContent).toContain('confirmed new comment')
  expect(mounted.container.textContent).toContain('Comments (2)')
}, 30_000)
