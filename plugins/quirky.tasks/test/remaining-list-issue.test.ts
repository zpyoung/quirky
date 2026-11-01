import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as React from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { ItemTarget, TasksState } from '../src/contracts'
import type { UiPluginContext } from '@quirky/protocol'
import { TasksList } from '../src/list/TasksList'
import { IssueSurface } from '../src/issue/IssueSurface'
import { bootTasks, type TasksTest } from './helpers'
import { fixtureIssue, fixturePullRequest, listFixtureSource, seedListFixture } from './fixtures/list'
import { issueFixtureSource, seedIssueFixture } from './fixtures/issue'
import { useReviewNavigation } from '../src/list/useReviewNavigation'

const hosts: TasksTest[] = []
let createRoot: typeof CreateRoot

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
beforeAll(async () => {
  GlobalRegistrator.register()
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
  // React DOM binds its scheduler at import; register happy-dom before loading it.
  const reactDom = await import('react-dom/client')
  createRoot = reactDom.createRoot
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
function fixtureItem(host: TasksTest, number: number): Record<string, unknown> {
  const item = values(record(fixtureState(host).items)['test-owner/test-repo']).map(record).find((entry) => entry.number === number)
  if (!item) throw new Error(`fixture item #${number} was not found`)
  return item
}
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
type CallReceipt = { method: string; params: Record<string, unknown>; value?: unknown; error?: unknown; completed: boolean }
type CallHold = {
  method: string
  predicate?: (params: Record<string, unknown>) => boolean
  reached: Promise<void>
  reach(): void
  wasReached(): boolean
  released: Promise<void>
  release(): void
  finished: Promise<void>
  finish(): void
  wasFinished(): boolean
}
function uiContext(host: TasksTest) {
  const waiters: CallWaiter[] = []
  const holds: CallHold[] = []
  const receipts: CallReceipt[] = []
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      const receipt: CallReceipt = { method, params, completed: false }
      receipts.push(receipt)
      const completeWaiters = () => {
        const index = waiters.findIndex((waiter) => waiter.method === method)
        if (index >= 0) waiters.splice(index, 1)[0]!.resolve()
      }
      let result: unknown
      try {
        result = await host.client.callAny(method, { worktree: host.worktree, ...params })
      } catch (error) {
        receipt.error = error
        receipt.completed = true
        completeWaiters()
        throw error
      }
      receipt.value = result
      completeWaiters()
      const holdIndex = holds.findIndex((hold) => hold.method === method && (!hold.predicate || hold.predicate(params)))
      if (holdIndex >= 0) {
        const hold = holds.splice(holdIndex, 1)[0]!
        hold.reach()
        await hold.released
        hold.finish()
      }
      receipt.completed = true
      return result
    },
    executeCommand: (command: string, params: Record<string, unknown> = {}) => host.client.callAny(command.replace(/^command:/u, ''), { worktree: host.worktree, ...params }),
    confirm: async () => true,
    toast: () => undefined
  } as unknown as UiPluginContext
  return {
    context,
    receipts,
    wait(method: string): Promise<void> {
      const deferred = Promise.withResolvers<void>()
      waiters.push({ method, resolve: deferred.resolve })
      return deferred.promise
    },
    hold(method: string, predicate?: (params: Record<string, unknown>) => boolean) {
      const reached = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<void>()
      let wasReached = false
      let wasFinished = false
      const hold: CallHold = {
        method,
        predicate,
        reached: reached.promise,
        reach: () => { wasReached = true; reached.resolve() },
        wasReached: () => wasReached,
        released: released.promise,
        release: () => released.resolve(),
        finished: finished.promise,
        finish: () => { wasFinished = true; finished.resolve() },
        wasFinished: () => wasFinished
      }
      holds.push(hold)
      return { reached: reached.promise, wasReached: hold.wasReached, finished: finished.promise, wasFinished: hold.wasFinished, release: hold.release }
    }
  }
}

function completedCall(
  receipts: CallReceipt[],
  method: string,
  predicate: (receipt: CallReceipt) => boolean = () => true
): boolean {
  return receipts.some((receipt) => receipt.method === method && receipt.completed && predicate(receipt))
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

async function waitForUi(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (predicate()) return
    const { promise, resolve } = Promise.withResolvers<void>()
    await React.act(async () => {
      setImmediate(resolve)
      await promise
    })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function listItemState(value: unknown, number: number): string | null {
  const item = values(record(value).items).map(record).find((entry) => entry.number === number)
  return typeof item?.state === 'string' ? item.state : null
}

function closedStatusMenuOpen(container: HTMLElement): boolean {
  const menu = container.querySelector('[role="menu"]')
  if (!menu) return false
  const items = [...menu.querySelectorAll('[role="menuitem"]')]
  const open = items.find((item) => item.textContent?.trim() === 'Open')
  const close = items.find((item) => item.textContent?.trim() === 'Close as completed')
  return open instanceof HTMLButtonElement && close instanceof HTMLButtonElement && !open.disabled && close.disabled
}

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('Textarea value setter is unavailable')
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function menuItem(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`menu item not found: ${name}`)
  return found
}

async function expectClosedIssueStatus(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector('tbody button[aria-haspopup="menu"]')
  if (!(trigger instanceof HTMLButtonElement)) throw new Error('issue status menu button was not rendered')
  await click(trigger)
  expect(menuItem(container, 'Open').disabled).toBe(false)
  expect(menuItem(container, 'Close as completed').disabled).toBe(true)
  await click(trigger)
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
  await host.call('open', { mode: 'projects' })
  await host.call('open', { mode: 'issues', repoIds: null, query: 'is:issue is:open' })
  await host.call('navigate', {})

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
  await host.call('open', { mode: 'projects' })
  await host.call('open', { mode: 'issues', repoIds: [betaId], query: 'is:issue is:open' })
  await host.call('navigate', {})

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
  await host.call('open', { mode: 'projects' })
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

test.each(['issues', 'prs'] as const)('a repository without an origin leads with an empty state and hides unusable GitHub controls in %s', async (mode) => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const item = mode === 'issues'
    ? fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')
    : fixturePullRequest('test-owner', 'test-repo', 12, '2026-10-01T00:00:00Z')
  item.title = 'Task recovered after adding a remote'
  host.writeState(seedListFixture({ 'test-owner/test-repo': [item] }))
  git(host.repoPath, 'remote', 'remove', 'origin')
  await host.call('navigate', { mode, repoIds: [host.repoId], query: 'is:open' })
  const state = taskState(await host.call('state'))
  const driver = uiContext(host)
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  await waitForUi(() => completedCall(driver.receipts, 'quirky.tasks/list'), 'missing-origin list response')

  expect(mounted.container.querySelector('button[aria-label="New GitHub issue"]')).toBeNull()
  expect(mounted.container.querySelector('[aria-label^="Search GitHub"]')).toBeNull()
  expect(mounted.container.querySelector('[aria-label="Task presets"]')).toBeNull()
  expect(mounted.container.querySelector('button[aria-haspopup="dialog"]')).toBeNull()
  expect(mounted.container.querySelector('[aria-label="GitHub task filters"]')).toBeNull()
  expect(mounted.container.querySelector('[aria-label="Active task filters"]')).toBeNull()
  expect(mounted.container.querySelector<HTMLButtonElement>('button[aria-label$="GitHub work"]')?.disabled).toBe(false)
  expect(mounted.container.textContent).not.toContain('Open repository in GitHub')
  expect(mounted.container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')?.disabled).toBe(false)
  expect(mounted.container.querySelectorAll('[role="alert"]')).toHaveLength(0)
  expect(mounted.container.querySelectorAll('.tasks-list__notice')).toHaveLength(0)
  expect(mounted.container.querySelectorAll('.tasks-list__empty')).toHaveLength(1)
  expect(mounted.container.querySelector('.tasks-list__empty')?.textContent).toMatch(/no GitHub remote/i)
  const emptyState = mounted.container.querySelector('.tasks-list__empty')!
  const sourceContext = mounted.container.querySelector('[aria-label="Task source context"]')!
  expect(emptyState.compareDocumentPosition(sourceContext) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(mounted.container.querySelector('[aria-label="Task source context"]')?.textContent).not.toMatch(/no origin|unavailable/i)
  expect(mounted.container.textContent).not.toContain(host.repoId)

  git(host.repoPath, 'remote', 'add', 'origin', 'https://github.com/test-owner/test-repo.git')
  await click(button(mounted.container, 'Refresh'))
  await waitForUi(() => mounted.container.textContent?.includes(item.title) === true, 'tasks loaded from the newly added remote')
  expect(mounted.container.querySelector('.tasks-list__empty')).toBeNull()
  expect(mounted.container.textContent).not.toMatch(/no GitHub remote/i)
  expect(mounted.container.querySelector('[aria-label^="Search GitHub"]')).not.toBeNull()
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
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  await waitForUi(() => mounted.container.textContent?.includes('Upstream issue 7') === true, 'initial upstream issue row')

  const oldRefresh = driver.hold('quirky.tasks/list', (params) => params.noCache === true)
  await React.act(async () => { button(mounted.container, 'Refresh').click() })
  await waitForUi(() => oldRefresh.wasReached(), 'delayed upstream refresh')
  await React.act(async () => { button(mounted.container, 'Origin').click() })
  await waitForUi(() => mounted.container.textContent?.includes('Origin issue 7') === true, 'confirmed origin issue row')

  oldRefresh.release()
  await waitForUi(() => oldRefresh.wasFinished(), 'released stale upstream response')
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
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state: initialState, refresh: async () => undefined }))
  await waitForUi(() => oldResponse.wasReached(), 'initial issue list request')

  const nextState = {
    ...initialState,
    navigation: { ...initialState.navigation, mode: 'prs' as const, query: 'is:pr is:open' }
  }
  await React.act(async () => {
    mounted.root.render(React.createElement(TasksList, { context: driver.context, state: nextState, refresh: async () => undefined }))
  })
  await waitForUi(
    () => completedCall(driver.receipts, 'quirky.tasks/list', (receipt) => receipt.params.mode === 'prs')
      && mounted.container.textContent?.includes('Pull request 12') === true,
    'current PR list result'
  )
  expect(mounted.container.textContent).not.toContain('Issue 7')

  oldResponse.release()
  await waitForUi(() => oldResponse.wasFinished(), 'release of the delayed issue response')
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
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  await waitForUi(
    () => completedCall(driver.receipts, 'quirky.tasks/list', (receipt) => receipt.params.mode === 'issues')
      && mounted.container.querySelector('tbody tr') !== null,
    'initial issue row'
  )

  await click(mounted.container.querySelector('tbody button[aria-haspopup="menu"]'))
  await React.act(async () => { menuItem(mounted.container, 'Close as completed').click() })
  await waitForUi(
    () => fixtureItem(host, 7).state === 'closed'
      && completedCall(driver.receipts, 'quirky.tasks/row', (receipt) => receipt.params.action === 'issueStatus')
      && mounted.container.querySelector('[role="menu"]') === null,
    'confirmed issue status update'
  )
  await expectClosedIssueStatus(mounted.container)

  host.writeState({ ...fixtureState(host), failIssueUpdate: true })
  const assigneeButton = mounted.container.querySelector('tbody button[aria-haspopup="dialog"]')
  await React.act(async () => {
    if (!(assigneeButton instanceof HTMLElement)) throw new Error('assignee button was not rendered')
    assigneeButton.click()
  })
  await waitForUi(() => {
    const dialog = mounted.container.querySelector('[role="dialog"]')
    return dialog !== null && [...dialog.querySelectorAll('label')].some((label) => label.textContent?.includes('fixture-user'))
  }, 'assignable user choice')
  const selectable = [...mounted.container.querySelectorAll('label')].find((label) => label.textContent?.includes('fixture-user'))
  const checkbox = selectable?.querySelector('input[type="checkbox"]')
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('assignable user checkbox was not rendered')
  await click(checkbox)
  await React.act(async () => { button(mounted.container, 'Save assignees').click() })
  await waitForUi(() => {
    const alert = mounted.container.querySelector('[role="alert"]')
    return completedCall(driver.receipts, 'quirky.tasks/row', (receipt) =>
      receipt.params.action === 'assignees' && receipt.error instanceof Error &&
      alert?.textContent?.includes(receipt.error.message) === true)
  }, 'failed assignee update')

  expect(fixtureItem(host, 7).state).toBe('closed')
  await expectClosedIssueStatus(mounted.container)
}, 30_000)

test('quiet adoption retains a confirmed status while search indexing lags, then adopts the indexed row', async () => {
  const host = await bootTasks(listFixtureSource)
  hosts.push(host)
  const issue = fixtureIssue('test-owner', 'test-repo', 7, '2026-10-01T00:00:00Z')
  host.writeState(seedListFixture({ 'test-owner/test-repo': [issue] }))
  await host.call('navigate', { mode: 'issues', repoIds: [host.repoId], query: 'is:issue' })
  const state = taskState(await host.call('state'))
  const driver = uiContext(host)
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  await waitForUi(
    () => completedCall(driver.receipts, 'quirky.tasks/list', (receipt) => receipt.params.mode === 'issues')
      && mounted.container.querySelector('tbody tr') !== null,
    'initial issue row'
  )
  host.writeState({
    ...fixtureState(host),
    lagSearch: { repository: 'test-owner/test-repo', remaining: 1, items: [issue] }
  })

  await click(mounted.container.querySelector('tbody button[aria-haspopup="menu"]'))
  await React.act(async () => { menuItem(mounted.container, 'Close as completed').click() })
  await waitForUi(
    () => fixtureItem(host, 7).state === 'closed'
      && completedCall(driver.receipts, 'quirky.tasks/row', (receipt) => receipt.params.action === 'issueStatus')
      && mounted.container.querySelector('[role="menu"]') === null,
    'confirmed issue status update'
  )
  const statusTrigger = mounted.container.querySelector('tbody button[aria-haspopup="menu"]')
  await click(statusTrigger)

  const staleIndexReturned = () => completedCall(
    driver.receipts,
    'quirky.tasks/list',
    (receipt) => receipt.params.noCache === true && listItemState(receipt.value, 7) === 'open'
  )
  const indexedRowReturned = () => completedCall(
    driver.receipts,
    'quirky.tasks/list',
    (receipt) => receipt.params.noCache === true && listItemState(receipt.value, 7) === 'closed'
  )
  await waitForUi(
    () => staleIndexReturned() && closedStatusMenuOpen(mounted.container),
    'confirmed status through the stale indexed result'
  )
  expect(record(fixtureState(host).lagSearch).remaining).toBe(0)
  expect(fixtureItem(host, 7).state).toBe('closed')
  await waitForUi(
    () => indexedRowReturned() && closedStatusMenuOpen(mounted.container),
    'adoption of the indexed closed row'
  )

  expect(record(fixtureState(host).lagSearch).remaining).toBe(0)
  expect(fixtureItem(host, 7).state).toBe('closed')
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
  const mounted = await mount(React.createElement(TasksList, { context: driver.context, state, refresh: async () => undefined }))
  const reviewerButton = () => mounted.container.querySelector('tbody button[aria-haspopup="dialog"]')
  await waitForUi(
    () => completedCall(driver.receipts, 'quirky.tasks/list', (receipt) => receipt.params.mode === 'prs')
      && reviewerButton()?.textContent?.includes('existing-reviewer') === true,
    'initial requested reviewer state'
  )

  await click(reviewerButton())
  const reviewerBox = () => mounted.container.querySelector('textarea[aria-label="Type or choose a reviewer"]')
  const input = reviewerBox()
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('reviewer input was not rendered')
  await React.act(async () => { setTextareaValue(input, 'first-reviewer') })
  await React.act(async () => { button(mounted.container, 'Request reviewers').click() })
  await waitForUi(() => {
    const reviewers = values(fixtureItem(host, 12).requestedReviewers)
    return reviewers.includes('first-reviewer')
      && reviewerButton()?.textContent?.includes('first-reviewer') === true
      && mounted.container.querySelector('[role="dialog"]') === null
      && completedCall(driver.receipts, 'quirky.tasks/row', (receipt) => receipt.params.action === 'reviewers' && receipt.error === undefined)
  }, 'first reviewer update')

  host.writeState({ ...fixtureState(host), failPRReviewerEdit: true })
  await click(reviewerButton())
  const nextInput = reviewerBox()
  if (!(nextInput instanceof HTMLTextAreaElement)) throw new Error('reviewer input was not rendered after reopening')
  await React.act(async () => { setTextareaValue(nextInput, 'second-reviewer') })
  await React.act(async () => { button(mounted.container, 'Request reviewers').click() })
  await waitForUi(() => {
    const reviewers = values(fixtureItem(host, 12).requestedReviewers)
    const alert = mounted.container.querySelector('[role="alert"]')
    return reviewers.includes('first-reviewer')
      && !reviewers.includes('second-reviewer')
      && reviewerButton()?.textContent?.includes('first-reviewer') === true
      && reviewerButton()?.textContent?.includes('second-reviewer') !== true
      && completedCall(driver.receipts, 'quirky.tasks/row', (receipt) =>
        receipt.params.action === 'reviewers' && receipt.error instanceof Error &&
        alert?.textContent?.includes(receipt.error.message) === true)
  }, 'failed later reviewer update')

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
  const mounted = await mount(React.createElement(IssueSurface, { context: driver.context, state, refresh: async () => undefined }))
  await waitForUi(() => mounted.container.textContent?.includes('original comment') === true, 'initial issue detail')

  const commentBox = mounted.container.querySelector('textarea[aria-label="Add a comment"]')
  if (!(commentBox instanceof HTMLTextAreaElement)) throw new Error('issue comment composer was not rendered')
  await React.act(async () => { setTextareaValue(commentBox, 'confirmed new comment') })
  await React.act(async () => { button(mounted.container, 'Comment').click() })
  const commentsSection = () => mounted.container.querySelector('section[aria-labelledby="issue-comments-heading"]')
  const visibleCommentCount = () => commentsSection()?.querySelectorAll('article').length ?? 0
  await waitForUi(
    () => completedCall(driver.receipts, 'quirky.tasks/issueComment')
      && mounted.container.textContent?.includes('confirmed new comment') === true
      && visibleCommentCount() === 2,
    'confirmed issue comment'
  )

  host.writeState({ ...fixtureState(host), laggingCommentReads: 1 })
  const refreshButton = [...mounted.container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Refresh')
  await React.act(async () => {
    if (!(refreshButton instanceof HTMLElement)) throw new Error('issue refresh button was not rendered')
    refreshButton.click()
  })
  await waitForUi(
    () => completedCall(driver.receipts, 'quirky.tasks/issue', (receipt) =>
      receipt.params.refresh === true && values(record(receipt.value).comments).length === 1)
      && refreshButton instanceof HTMLButtonElement && !refreshButton.disabled
      && mounted.container.textContent?.includes('confirmed new comment') === true
      && visibleCommentCount() === 2,
    'confirmed comment after a lagging detail read'
  )
  expect(fixtureState(host).laggingCommentReads).toBe(0)
}, 30_000)
