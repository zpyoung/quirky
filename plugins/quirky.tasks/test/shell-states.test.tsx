import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { createRoot as CreateRoot } from 'react-dom/client'
import { registerUiDom, unregisterUiDom } from '../../quirky.loops/test/ui-dom'
import type { IssueDraft, TasksState, WorkspaceComposerRequest } from '../src/contracts'
import { NewIssueDialog } from '../src/issue/NewIssueDialog'
import { place, LIST_SNAPSHOT_LIMIT } from '../src/list/place'
import { parseItem, type ListData, type ListItem } from '../src/list/model'

type Event = { type: string; [key: string]: unknown }
type Call = { method: string; params: Record<string, unknown> }
type Command = { id: string; args: unknown }
type Handler = (params: Record<string, unknown>) => unknown
type MountFunction = (element: HTMLElement, props: { report?: (state: unknown) => void }) => () => void

type Harness = {
  context: UiPluginContext
  calls: Call[]
  commands: Command[]
  rowMenus: Command[]
  opened: { id: string; input: unknown }[]
  toasts: { title: string; detail: string }[]
  provided: Map<string, unknown>
  mount(id: string): Promise<{ element: HTMLElement; unmount(): Promise<void> }>
  mountComponent(element: ReactNode): Promise<{ element: HTMLElement; unmount(): Promise<void> }>
  emit(event: Event): Promise<void>
  settle(): Promise<void>
}

let act: (callback: () => unknown) => Promise<void>
let createRoot: typeof CreateRoot
let activate: (context: UiPluginContext) => void
const snapshotLimit = LIST_SNAPSHOT_LIMIT
const mounted: Array<() => Promise<void>> = []

const TOOL = 'sidebar-section:quirky.tasks/tasks'
const TASKS_VIEW = 'view:quirky.tasks/tasks'
const SETTINGS_VIEW = 'view:quirky.tasks/settings'
const COMPOSER_OVERLAY = 'overlay:quirky.tasks/workspace-composer'
const ROW_MENU_COMMAND = 'command:quirky.tasks/row-menu'
const noSelected = 'No registered Git repository is selected for issue creation.'
const unavailableChoices = 'Repository labels and assignable users are unavailable for this Project issue source.'
const never = Promise.withResolvers<unknown>().promise

const state: TasksState = {
  revision: 1,
  navigation: { source: 'github', mode: 'prs', repoIds: null, query: 'is:pr is:open', page: 1, scrollTop: 0, detail: null, newIssue: false, project: null, lastList: { mode: 'prs', query: 'is:pr is:open', page: 1 } },
  preferences: { showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github', defaultTaskViewPreset: 'open', defaultRepoSelection: null },
  issueDraft: { title: 'Existing title', body: '', labels: [], assignees: [], repoId: 'repo-1' },
  projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
  links: {}
}

const repository = { id: 'repo-1', name: 'quirky', path: '/work/quirky', kind: 'git', worktree: 'wt-main', displayName: null }
const otherRepository = { ...repository, id: 'repo-2', name: 'other', worktree: 'wt-other' }

function withNavigation(patch: Partial<TasksState['navigation']>): TasksState {
  return { ...state, navigation: { ...state.navigation, ...patch } }
}

function pr(number: number, patch: Record<string, unknown> = {}): ListItem {
  return {
    kind: 'pullRequest', number, title: `Pull request ${number}`, body: '', state: 'open', url: `https://github.com/acme/quirky/pull/${number}`,
    createdAt: null, updatedAt: null, author: 'sam', labels: [], assignees: [], isDraft: false,
    worktree: 'wt-main', repoId: 'repo-1', repoName: 'quirky', ...patch
  } as ListItem
}


function listResult(items: ListItem[], patch: Record<string, unknown> = {}): ListData {
  return { items, repositories: [repository], page: 1, totalPages: 1, perRepo: 20, failures: [], sources: {}, ...patch } as ListData
}

function request(overrides: Partial<WorkspaceComposerRequest> = {}): WorkspaceComposerRequest {
  return {
    requestId: 'request-7',
    target: { worktree: 'wt-main', kind: 'issue', number: 7, url: 'https://github.com/acme/quirky/issues/7' },
    repoId: 'repo-1', repoName: 'acme/quirky', name: 'workspace-7', title: 'Issue seven', prompt: 'Fix it',
    setup: 'inherit', issueCommand: 'inherit', agent: null, ...overrides
  }
}

function issueState(draft: IssueDraft = state.issueDraft): TasksState {
  return { ...state, navigation: { ...state.navigation, newIssue: true }, issueDraft: draft }
}

function choices(kind: string, patch: Record<string, unknown> = {}) {
  if (kind === 'repositories') return { repositories: [repository], defaultRepoId: repository.id }
  if (kind === 'source') return { available: true, source: 'origin', sources: [{ id: 'origin', label: 'Origin' }], repoId: repository.id, ...patch }
  if (kind === 'labels') return { available: true, labels: [], ...patch }
  return { available: true, assignees: [], ...patch }
}

beforeAll(async () => {
  registerUiDom()
  // React DOM captures its scheduler at import, so Happy DOM must be registered first.
  const react = await import('react')
  act = react.act as typeof act
  createRoot = (await import('react-dom/client')).createRoot
  activate = (await import('../src/ui')).activate
})

async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 20)
    await promise
  })
}
function flushSnapshots(): void {
  const empty = { list: { items: [], repositories: [], page: 1, totalPages: 1, perRepo: 0, failures: [], sources: {} }, checks: {}, merge: {} }
  for (let index = 0; index < snapshotLimit; index += 1) place.setListSnapshot(`shell-flush-${index}`, empty)
}

afterEach(async () => {
  for (const unmount of mounted.splice(0).reverse()) await unmount()
  document.body.innerHTML = ''
  flushSnapshots()
})

afterAll(async () => {
  await unregisterUiDom()
})

function createHarness(handlers: Record<string, Handler> = {}): Harness {
  const provided = new Map<string, unknown>()
  const calls: Call[] = []
  const commands: Command[] = []
  const rowMenus: Command[] = []
  const opened: { id: string; input: unknown }[] = []
  const toasts: { title: string; detail: string }[] = []
  const listeners = new Set<(event: Event) => void>()
  const context = {
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) throw new Error('offline')
      return handler(params)
    },
    subscribe(listener: (event: Event) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toast(title: string, detail = '') { toasts.push({ title, detail }) },
    async executeCommand(id: string, args: unknown) {
      if (id === ROW_MENU_COMMAND) {
        rowMenus.push({ id, args })
        const implementation = provided.get(id)
        if (typeof implementation !== 'function') return { delivered: 0 }
        return (implementation as (input: unknown) => unknown)(args)
      }
      commands.push({ id, args })
      return undefined
    },
    openView(id: string, input: unknown) { opened.push({ id, input }) },
    getLayout() { return {} }
  } as unknown as UiPluginContext

  const track = (element: HTMLElement, dispose: () => void) => {
    let live = true
    const unmount = async () => {
      if (!live) return
      live = false
      await act(async () => dispose())
      element.remove()
    }
    mounted.push(unmount)
    return { element, unmount }
  }

  return {
    context, calls, commands, rowMenus, opened, toasts, provided,
    async mount(id) {
      activate(context)
      const mount = provided.get(id)
      if (typeof mount !== 'function') throw new Error(`No mount provided for ${id}`)
      const element = document.createElement('div')
      document.body.append(element)
      let dispose: () => void = () => {}
      await act(async () => { dispose = (mount as MountFunction)(element, {}) })
      const result = track(element, dispose)
      await settle()
      return result
    },
    async mountComponent(node) {
      const element = document.createElement('div')
      document.body.append(element)
      const root = createRoot(element)
      await act(async () => root.render(node))
      const result = track(element, () => root.unmount())
      await settle()
      return result
    },
    async emit(event) {
      await act(async () => { for (const listener of listeners) listener(event) })
      await settle()
    },
    settle
  }
}

const labelOf = (element: Element) => element.getAttribute('aria-label') ?? ''
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((entry) => labelOf(entry) === label || entry.textContent?.trim() === label)
const rowTitles = (root: ParentNode) => [...root.querySelectorAll('.ui-list-row__title')].map((entry) => entry.textContent)
const callCount = (harness: Harness, method: string) => harness.calls.filter((call) => call.method === method).length
const namedNotice = (root: ParentNode, text: string) => [...root.querySelectorAll('.ui-notice-line')].find((entry) => entry.querySelector('.ui-notice-line__text')?.textContent === text)

function rowMenuRunner(harness: Harness): (input: unknown) => { delivered: number } {
  const implementation = harness.provided.get(ROW_MENU_COMMAND)
  if (typeof implementation !== 'function') throw new Error('Row menu command was not provided')
  return implementation as (input: unknown) => { delivered: number }
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
  if (!element) throw new Error('Expected a clickable element')
  await act(async () => { (element as HTMLButtonElement).click() })
  await settle()
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

function inputByLabel(root: ParentNode, name: string): HTMLInputElement {
  const label = [...root.querySelectorAll('label')].find((entry) => entry.textContent?.trim() === name)
  if (!(label?.control instanceof HTMLInputElement)) throw new Error(`Could not find ${name} input`)
  return label.control
}

test('Tasks view shows a blocking first-read error and Retry performs one state read', async () => {
  let fail = true
  const harness = createHarness({ 'quirky.tasks/state': () => { if (fail) throw new Error('Tasks daemon is unavailable.'); return state } })
  const { element } = await harness.mount(TASKS_VIEW)
  const alert = element.querySelector('.ui-inline-error[role="alert"]')!
  expect(alert.querySelector('.ui-inline-error__message')?.textContent).toBe('Tasks daemon is unavailable.')
  expect(alert.querySelectorAll('button.ui-inline-error__action')).toHaveLength(1)
  expect(button(alert, 'Retry')).toBeDefined()
  expect([...element.querySelectorAll('*')].some((node) => node.textContent === 'Loading Tasks…')).toBe(false)
  expect(element.querySelector('.ui-empty-state')).toBeNull()
  expect(callCount(harness, 'quirky.tasks/state')).toBe(1)
  fail = false
  await click(button(alert, 'Retry'))
  expect(callCount(harness, 'quirky.tasks/state')).toBe(2)
  expect([...element.querySelectorAll('.ui-inline-error')].some((node) => node.textContent?.includes('Tasks daemon is unavailable.'))).toBe(false)
  expect(element.querySelector('main.tasks-body')).not.toBeNull()
})

test('Tasks view uses a shared NoticeLine while its first state read is pending', async () => {
  const harness = createHarness({ 'quirky.tasks/state': () => never })
  const { element } = await harness.mount(TASKS_VIEW)
  expect(element.querySelectorAll('[role="status"] > .ui-notice-line')).toHaveLength(1)
  expect(namedNotice(element, 'Loading Tasks…')).toBeDefined()
  expect(element.querySelector('.ui-inline-error')).toBeNull()
})

test('Tasks view keeps stale rows and exposes a state-refresh NoticeLine Retry', async () => {
  let fail = false
  const harness = createHarness({
    'quirky.tasks/state': () => { if (fail) throw new Error('GitHub timed out.'); return state },
    'quirky.tasks/counts': () => ({ issues: 0, prs: 0 }),
    'quirky.tasks/list': () => listResult([pr(274)])
  })
  const { element } = await harness.mount(TASKS_VIEW)
  expect(element.querySelector('main.tasks-body')).not.toBeNull()
  fail = true
  await harness.emit({ type: 'quirky.tasks/changed' })
  expect(element.querySelector('main.tasks-body')).not.toBeNull()
  const notice = namedNotice(element, "Couldn't refresh Tasks. Showing the last loaded tasks. GitHub timed out.")!
  expect(notice).toBeDefined()
  expect(button(notice, 'Retry')).toBeDefined()
  expect([...element.querySelectorAll('.ui-inline-error')].some((entry) => entry.textContent?.includes('GitHub timed out.'))).toBe(false)
  const reads = callCount(harness, 'quirky.tasks/state')
  fail = false
  await click(button(notice, 'Retry'))
  expect(callCount(harness, 'quirky.tasks/state')).toBe(reads + 1)
})

test('Tasks shell actions route collapse, Escape and Projects navigation', async () => {
  const withDetail = withNavigation({ detail: { worktree: 'wt-main', kind: 'pullRequest', number: 274, url: 'https://github.com/acme/quirky/pull/274' } })
  const harness = createHarness({
    'quirky.tasks/state': () => withDetail,
    'quirky.tasks/counts': () => ({ issues: 1, prs: 2 }),
    'quirky.tasks/list': () => listResult([pr(274)])
  })
  const { element } = await harness.mount(TASKS_VIEW)
  harness.calls.length = 0
  await click(button(element, 'Collapse Tasks'))
  expect(harness.calls.filter((call) => call.method === 'ui.tool.open')).toEqual([{ method: 'ui.tool.open', params: { id: TOOL } }])
  await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await harness.settle()
  expect(harness.calls.filter((call) => call.method === 'quirky.tasks/navigate')).toEqual([{ method: 'quirky.tasks/navigate', params: { detail: null } }])

  const projects = [...element.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === 'Projects')
  await click(projects)
  expect(harness.calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)).toEqual({ method: 'quirky.tasks/navigate', params: { mode: 'projects', detail: null, newIssue: false } })
})

test('Task Sources uses shared loading and first-read error with a single Retry', async () => {
  const loading = createHarness({ 'quirky.tasks/state': () => never })
  const pending = await loading.mount(SETTINGS_VIEW)
  expect(namedNotice(pending.element, 'Loading task settings…')).toBeDefined()
  expect(pending.element.querySelectorAll('[role="status"] > .ui-notice-line')).toHaveLength(1)

  let fail = true
  const harness = createHarness({ 'quirky.tasks/state': () => { if (fail) throw new Error('Settings state is unavailable.'); return state } })
  const { element } = await harness.mount(SETTINGS_VIEW)
  const alert = element.querySelector('.ui-inline-error[role="alert"]')!
  expect(alert.querySelector('.ui-inline-error__message')?.textContent).toBe('Settings state is unavailable.')
  expect(button(alert, 'Retry')).toBeDefined()
  expect([...element.querySelectorAll('.ui-notice-line')].some((entry) => entry.textContent?.includes('Loading task settings…'))).toBe(false)
  fail = false
  await click(button(alert, 'Retry'))
  expect(callCount(harness, 'quirky.tasks/state')).toBe(2)
})

test('Task Sources keeps loaded settings on a failed state reread', async () => {
  let fail = false
  const harness = createHarness({
    'quirky.tasks/state': () => { if (fail) throw new Error('Settings state timed out.'); return state },
    'quirky.tasks/repositories': () => [repository],
    'quirky.hosting/diagnoseAuth': () => ({ ghAvailable: true, requiredHostAuthenticated: true })
  })
  const { element } = await harness.mount(SETTINGS_VIEW)
  expect(element.querySelector('.tasks-settings')).not.toBeNull()
  fail = true
  await harness.emit({ type: 'quirky.tasks/changed' })
  expect(element.querySelector('.tasks-settings')).not.toBeNull()
  const notice = namedNotice(element, "Couldn't refresh task settings. Showing the last loaded settings. Settings state timed out.")!
  expect(notice).toBeDefined()
  expect(button(notice, 'Retry')).toBeDefined()
  expect(element.querySelector('.tasks-settings .ui-inline-error__message')?.textContent).not.toBe('Settings state timed out.')
  const reads = callCount(harness, 'quirky.tasks/state')
  fail = false
  await click(button(notice, 'Retry'))
  expect(callCount(harness, 'quirky.tasks/state')).toBe(reads + 1)
})

test('Task Sources reports a missing project and preference write failures with InlineError', async () => {
  const noProject = createHarness({ 'quirky.tasks/state': () => state, 'quirky.tasks/repositories': () => [] })
  const empty = await noProject.mount(SETTINGS_VIEW)
  const emptyError = empty.element.querySelector('.tasks-settings .ui-inline-error[role="alert"]')!
  expect(emptyError.querySelector('.ui-inline-error__message')?.textContent).toBe('Select a Git project to diagnose this source.')
  expect(empty.element.querySelector('.tasks-settings p[role="alert"]')).toBeNull()

  const failingPreference = createHarness({
    'quirky.tasks/state': () => state,
    'quirky.tasks/repositories': () => [repository],
    'quirky.hosting/diagnoseAuth': () => ({ ghAvailable: true, requiredHostAuthenticated: true }),
    'quirky.tasks/preferences': () => { throw new Error('Preferences are read-only.') }
  })
  const loaded = await failingPreference.mount(SETTINGS_VIEW)
  const showTasks = [...loaded.element.querySelectorAll<HTMLInputElement>('.tasks-settings input[type="checkbox"]')][0]!
  await act(async () => showTasks.click())
  await failingPreference.settle()
  expect(loaded.element.querySelector('.tasks-settings .ui-inline-error__message')?.textContent).toBe('Preferences are read-only.')
  expect(loaded.element.querySelector('.tasks-settings p[role="alert"]')).toBeNull()
})

test('Task Sources keeps a failed preference save visible when pending diagnosis succeeds', async () => {
  const diagnosis = Promise.withResolvers<unknown>()
  const harness = createHarness({
    'quirky.tasks/state': () => state,
    'quirky.tasks/repositories': () => [repository],
    'quirky.hosting/diagnoseAuth': () => diagnosis.promise,
    'quirky.tasks/preferences': () => { throw new Error('Preferences are read-only.') }
  })
  const { element } = await harness.mount(SETTINGS_VIEW)
  const showTasks = element.querySelector<HTMLInputElement>('.tasks-settings input[type="checkbox"]')!
  await act(async () => showTasks.click())
  await harness.settle()
  expect(element.querySelector('.tasks-settings .ui-inline-error__message')?.textContent).toBe('Preferences are read-only.')
  await act(async () => diagnosis.resolve({ ghAvailable: true, requiredHostAuthenticated: true }))
  await harness.settle()
  expect(element.querySelector('.tasks-settings .ui-inline-error__message')?.textContent).toBe('Preferences are read-only.')
})

test('Task Sources diagnosis routes re-check and preserves the newest generation', async () => {
  const diagnoses: Array<(value: unknown) => void> = []
  const harness = createHarness({
    'quirky.tasks/state': () => state,
    'quirky.tasks/repositories': () => [repository],
    'quirky.hosting/diagnoseAuth': (params) => {
      expect(params).toEqual({ worktree: 'wt-main' })
      const { promise, resolve } = Promise.withResolvers<unknown>()
      diagnoses.push(resolve)
      return promise
    }
  })
  const { element } = await harness.mount(SETTINGS_VIEW)
  expect(diagnoses).toHaveLength(1)
  await act(async () => diagnoses[0]!({ ghAvailable: true, requiredHostAuthenticated: true }))
  await harness.settle()
  expect([...element.querySelectorAll('strong')].some((entry) => entry.textContent === 'GitHub · Ready')).toBe(true)
  await click(button(element, 'Re-check GitHub'))
  expect(callCount(harness, 'quirky.hosting/diagnoseAuth')).toBe(2)
  expect(harness.calls.filter((call) => call.method === 'quirky.hosting/diagnoseAuth').map((call) => call.params)).toEqual([{ worktree: 'wt-main' }, { worktree: 'wt-main' }])

  await act(async () => diagnoses[1]!({ ghAvailable: true, requiredHostAuthenticated: true }))
  await harness.settle()
  const latest = [...element.querySelectorAll('strong')].find((entry) => entry.textContent === 'GitHub · Ready')
  expect(latest).toBeDefined()
})

test('Task Sources discards an older diagnosis after the selected repository changes', async () => {
  const diagnoses: Array<(value: unknown) => void> = []
  let currentState = state
  const harness = createHarness({
    'quirky.tasks/state': () => currentState,
    'quirky.tasks/repositories': () => [repository, otherRepository],
    'quirky.hosting/diagnoseAuth': () => {
      const { promise, resolve } = Promise.withResolvers<unknown>()
      diagnoses.push(resolve)
      return promise
    }
  })
  const { element } = await harness.mount(SETTINGS_VIEW)
  expect(diagnoses).toHaveLength(1)
  currentState = { ...state, revision: 2, navigation: { ...state.navigation, repoIds: ['repo-2'] } }
  await harness.emit({ type: 'quirky.tasks/changed' })
  expect(diagnoses).toHaveLength(2)
  await act(async () => diagnoses[1]!({ ghAvailable: true, requiredHostAuthenticated: true }))
  await harness.settle()
  await act(async () => diagnoses[0]!({ ghAvailable: false, requiredHostAuthenticated: false }))
  await harness.settle()
  expect([...element.querySelectorAll('strong')].some((entry) => entry.textContent === 'GitHub · Ready')).toBe(true)
  expect([...element.querySelectorAll('strong')].some((entry) => entry.textContent === 'GitHub · Not installed')).toBe(false)
})

test('sidebar loading keeps skeleton rows under a shared loading NoticeLine', async () => {
  const harness = createHarness({ 'quirky.tasks/prepare': () => never })
  const { element } = await harness.mount(TOOL)
  const loading = element.querySelector('.tasks-compact__loading[role="status"][aria-label="Loading tasks"]')!
  expect(loading.firstElementChild?.matches('.ui-notice-line')).toBe(true)
  expect(loading.querySelector('.ui-notice-line__text')?.textContent).toBe('Loading tasks…')
  expect(loading.querySelectorAll('.tasks-compact__skeleton[aria-hidden="true"]').length).toBeGreaterThanOrEqual(3)
})

test('sidebar first state failure shows one InlineError and Retry repeats prepare', async () => {
  const harness = createHarness({ 'quirky.tasks/prepare': () => { throw new Error('Tasks daemon is unavailable.') } })
  const { element } = await harness.mount(TOOL)
  const problem = element.querySelector('.tasks-compact__problem')!
  expect(problem.hasAttribute('role')).toBe(false)
  const alert = problem.querySelector('.ui-inline-error[role="alert"]')!
  expect(alert.querySelector('.ui-inline-error__message')?.textContent).toBe('Tasks daemon is unavailable.')
  expect(button(alert, 'Retry')).toBeDefined()
  expect(problem.querySelectorAll('.ui-inline-error')).toHaveLength(1)
  await click(button(alert, 'Retry'))
  expect(callCount(harness, 'quirky.tasks/prepare')).toBe(2)
})

test('sidebar list failure shows InlineError and routes Open task sources', async () => {
  const harness = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => { throw new Error('list unavailable') },
    'quirky.tasks/settings': () => undefined
  })
  const { element } = await harness.mount(TOOL)
  const alert = element.querySelector('.tasks-compact__problem .ui-inline-error[role="alert"]')!
  expect(alert.querySelector('.ui-inline-error__message')?.textContent).toBe('list unavailable')
  await click(button(alert, 'Open task sources'))
  expect(callCount(harness, 'quirky.tasks/settings')).toBe(1)
})

test('sidebar repository failures show a NoticeLine and preserve rows', async () => {
  const failures = [{ repoId: 'repo-2', stage: 'list', message: 'one repository failed' }]
  const harness = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => listResult([pr(274)], { failures }),
    'quirky.tasks/counts': () => ({ issues: 0, prs: 1 })
  })
  const { element } = await harness.mount(TOOL)
  const notice = element.querySelector('.tasks-compact__notice[role="status"] > .ui-notice-line')!
  expect(notice.querySelector('.ui-notice-line__text')?.textContent).toBe('Some repositories could not be loaded.')
  expect(rowTitles(element)).toEqual(['Pull request 274'])
  expect(element.querySelector('.ui-inline-error')).toBeNull()
})

test('sidebar state reread failure keeps rows and retries only the state call', async () => {
  let fail = false
  const harness = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/state': () => { if (fail) throw new Error('state offline'); return state },
    'quirky.tasks/list': () => listResult([pr(274)]),
    'quirky.tasks/counts': () => ({ issues: 0, prs: 1 })
  })
  const { element } = await harness.mount(TOOL)
  expect(rowTitles(element)).toEqual(['Pull request 274'])
  fail = true
  await harness.emit({ type: 'quirky.tasks/changed' })
  const notice = element.querySelector('.tasks-compact__notice .ui-notice-line')!
  expect(notice.querySelector('.ui-notice-line__text')?.textContent).toBe("Couldn't refresh Tasks. Showing the last loaded tasks.")
  expect(button(notice, 'Retry')).toBeDefined()
  expect(rowTitles(element)).toEqual(['Pull request 274'])
  expect(element.querySelector('.ui-inline-error')).toBeNull()
  const reads = callCount(harness, 'quirky.tasks/state')
  fail = false
  await click(button(notice, 'Retry'))
  expect(callCount(harness, 'quirky.tasks/state')).toBe(reads + 1)
})

test('sidebar failed list refresh keeps cached rows and retries the list call', async () => {
  const viewKey = ['github', 'prs', '*', 'is:pr is:open', 1].join('\u0000')
  place.setListSnapshot(viewKey, { list: listResult([pr(274)]), checks: {}, merge: {} })
  let fail = true
  const harness = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => { if (fail) throw new Error('cached list offline'); return listResult([pr(274), pr(275)]) },
    'quirky.tasks/counts': () => ({ issues: 0, prs: 1 })
  })
  const { element } = await harness.mount(TOOL)
  const notice = element.querySelector('.tasks-compact__notice .ui-notice-line')!
  expect(notice.querySelector('.ui-notice-line__text')?.textContent).toBe("Couldn't refresh. Showing the last loaded tasks.")
  expect(rowTitles(element)).toEqual(['Pull request 274'])
  expect(element.querySelector('.ui-inline-error')).toBeNull()
  const reads = callCount(harness, 'quirky.tasks/list')
  fail = false
  await click(button(notice, 'Retry'))
  expect(callCount(harness, 'quirky.tasks/list')).toBe(reads + 1)
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
  expect(element.querySelector('.tasks-compact__notice')).toBeNull()
})

test('sidebar list reread failure preserves cached rows and stale empty actions', async () => {
  const viewKey = ['github', 'prs', '*', 'is:pr is:open', 1].join('\u0000')
  place.setListSnapshot(viewKey, {
    list: listResult([]), checks: {}, merge: {}
  })
  let fail = true
  const harness = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => { if (fail) throw new Error('cached list offline'); return listResult([]) },
    'quirky.tasks/counts': () => ({ issues: 0, prs: 0 })
  })
  const { element } = await harness.mount(TOOL)
  const notice = element.querySelector('.tasks-compact__notice .ui-notice-line')!
  expect(notice.querySelector('.ui-notice-line__text')?.textContent).toBe("Couldn't refresh. Showing the last loaded tasks.")
  expect(rowTitles(element)).toEqual([])
  expect(element.querySelector('.tasks-compact__empty[role="status"] .ui-empty-state')).not.toBeNull()
  expect(button(element, 'Expand to change filters')).toBeUndefined()
  expect([...element.querySelector('.tasks-compact__list')!.querySelectorAll('button')].map((entry) => entry.textContent?.trim())).toEqual(['Retry'])
  expect(element.querySelector('.ui-inline-error')).toBeNull()
  const reads = callCount(harness, 'quirky.tasks/list')
  fail = false
  await click(button(notice, 'Retry'))
  expect(callCount(harness, 'quirky.tasks/list')).toBe(reads + 1)
  expect(element.querySelector('.tasks-compact__notice')).toBeNull()
  expect(button(element, 'Expand to change filters')).toBeDefined()
})

test('sidebar empty cases use EmptyState in the status wrapper', async () => {
  const emptyRepos = createHarness({
    'quirky.tasks/prepare': () => withNavigation({ repoIds: [] }),
    'quirky.tasks/list': () => listResult([]),
    'quirky.tasks/counts': () => ({ issues: 0, prs: 0 })
  })
  const noRepos = await emptyRepos.mount(TOOL)
  const noRepositories = noRepos.element.querySelector('.tasks-compact__empty[role="status"] .ui-empty-state')!
  expect(noRepositories.querySelector('.ui-empty-state__message')?.textContent).toBe('No repositories selected.')
  expect(button(noRepositories, 'Expand to select projects')).toBeDefined()

  const missingOrigin = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => listResult([], { failures: [{ repoId: 'repo-1', message: 'No origin remote.' }], sources: { 'repo-1': { reason: 'missing_origin' } } }),
    'quirky.tasks/counts': () => ({ issues: 0, prs: 0 })
  })
  const noRemote = await missingOrigin.mount(TOOL)
  expect(noRemote.element.querySelectorAll('.tasks-compact__empty[role="status"] .ui-empty-state')).toHaveLength(1)
  expect(noRemote.element.querySelector('.ui-empty-state__message')?.textContent).toContain('No GitHub remote is configured for quirky.')
  expect(noRemote.element.querySelector('.ui-inline-error')).toBeNull()

  const noPullRequests = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => listResult([]),
    'quirky.tasks/counts': () => ({ issues: 0, prs: 0 })
  })
  const noRows = await noPullRequests.mount(TOOL)
  const empty = noRows.element.querySelector('.tasks-compact__empty[role="status"] .ui-empty-state')!
  expect(empty.querySelector('.ui-empty-state__message')?.textContent).toBe('No open pull requests')
  expect(button(empty, 'Expand to change filters')).toBeDefined()
})

test('row menu button and right-click route public command addresses and keep literal items', async () => {
  const harness = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => listResult([pr(274), pr(275)]),
    'quirky.tasks/counts': () => ({ issues: 0, prs: 2 }),
    'quirky.tasks/workspace': () => undefined,
    'quirky.reviews/open': () => undefined
  })
  const { element } = await harness.mount(TOOL)
  await click(button(element, 'More actions for #274'))
  expect(harness.rowMenus).toEqual([{ id: ROW_MENU_COMMAND, args: { worktree: 'wt-main', kind: 'pullRequest', number: 274 } }])
  let menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for #274"]')!
  expect([...menu.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent?.trim())).toEqual(['Start workspace', 'Review', 'Open on GitHub', 'Copy link'])
  expect(menu.querySelector('[role="menuitem"][data-highlighted]')?.textContent?.trim()).toBe('Start workspace')
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await harness.settle()

  const row = element.querySelector<HTMLElement>('[data-row-key]')!
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 14 })))
  await harness.settle()
  expect(harness.rowMenus[1]).toEqual({ id: ROW_MENU_COMMAND, args: { worktree: 'wt-main', kind: 'pullRequest', number: 274, x: 12, y: 14 } })
  menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for #274"]')!
  expect([...menu.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent?.trim())).toEqual(['Start workspace', 'Review', 'Open on GitHub', 'Copy link'])
})

test('row menu items and the primary button route through their named actions', async () => {
  const harness = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => listResult([pr(274)]),
    'quirky.tasks/counts': () => ({ issues: 0, prs: 1 }),
    'quirky.tasks/workspace': () => undefined,
    'quirky.reviews/open': () => undefined
  })
  const { element } = await harness.mount(TOOL)
  const target = { worktree: 'wt-main', kind: 'pullRequest', number: 274, url: 'https://github.com/acme/quirky/pull/274' }
  await click(button(element, 'Start workspace for #274'))
  expect(harness.calls.find((call) => call.method === 'quirky.tasks/workspace')?.params).toEqual({ target, action: 'start' })
  for (const [label, id] of [['Review', 'quirky.reviews/open'], ['Open on GitHub', 'command:quirky.tasks/open-link'], ['Copy link', 'command:quirky.tasks/copy-link']] as const) {
    await click(button(element, 'More actions for #274'))
    await click(document.querySelector<HTMLElement>('[role="menuitem"]') && [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === label))
    if (id.startsWith('command:')) expect(harness.commands).toContainEqual({ id, args: { url: target.url } })
  }
  expect(harness.calls.find((call) => call.method === 'quirky.reviews/open')?.params).toMatchObject({ worktree: 'wt-main', number: 274, tab: 'conversation' })
})

test('row menu registry delivers only to mounted matching rows and cleans up handlers', async () => {
  const harness = createHarness({
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/list': () => listResult([pr(274), pr(275)]),
    'quirky.tasks/counts': () => ({ issues: 0, prs: 2 })
  })
  const first = await harness.mount(TOOL)
  const rowMenu = rowMenuRunner(harness)
  let result = { delivered: 0 }
  await act(async () => { result = rowMenu({ worktree: 'wt-main', kind: 'pullRequest', number: 275 }) })
  await harness.settle()
  expect(result).toEqual({ delivered: 1 })
  let menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for #275"]')!
  expect(menu).not.toBeNull()
  const trigger = button(first.element, 'More actions for #275')!
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await harness.settle()
  expect(document.activeElement).toBe(trigger)

  await act(async () => { result = rowMenu({ worktree: 'wt-main', kind: 'pullRequest', number: 999 }) })
  expect(result).toEqual({ delivered: 0 })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await first.unmount()
  await act(async () => { result = rowMenu({ worktree: 'wt-main', kind: 'pullRequest', number: 275 }) })
  expect(result).toEqual({ delivered: 0 })

  const second = await harness.mount(TOOL)
  const third = await harness.mount(TOOL)
  await act(async () => { result = rowMenu({ worktree: 'wt-main', kind: 'pullRequest', number: 275 }) })
  await harness.settle()
  expect(result).toEqual({ delivered: 2 })
  expect(document.querySelectorAll('[role="menu"][aria-label="Actions for #275"]')).toHaveLength(2)
  await second.unmount()
  await third.unmount()
  await act(async () => { result = rowMenu({ worktree: 'wt-main', kind: 'pullRequest', number: 275 }) })
  expect(result).toEqual({ delivered: 0 })
})

test('row menu registry validates row identity and paired finite coordinates', async () => {
  const harness = createHarness()
  activate(harness.context)
  const rowMenu = rowMenuRunner(harness)
  const identityError = 'row-menu needs a worktree, a kind of issue or pullRequest, and a positive integer number.'
  expect(() => rowMenu({ kind: 'issue', number: 1 })).toThrow(identityError)
  expect(() => rowMenu({ worktree: 'wt-main', kind: 'issue', number: 0 })).toThrow(identityError)
  expect(() => rowMenu({ worktree: 'wt-main', kind: 'issue', number: 1, x: 5 })).toThrow('row-menu needs both x and y as finite numbers, or neither.')
  expect(() => rowMenu({ worktree: 'wt-main', kind: 'issue', number: 1, x: Number.NaN, y: 5 })).toThrow('row-menu needs both x and y as finite numbers, or neither.')
})

test('workspace composer renders its request without waiting for Tasks state', async () => {
  const harness = createHarness({
    'quirky.tasks/state': () => { throw new Error('Tasks daemon is unavailable.') },
    'quirky.tasks/workspaceComposerState': () => request(),
    'quirky.agents/list': () => ({ agents: [], defaultAgent: null })
  })
  const { element } = await harness.mount(COMPOSER_OVERLAY)
  expect(element.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  expect(element.querySelector('[role="dialog"]')?.textContent).toContain('Create workspace from issue')
  expect(callCount(harness, 'quirky.tasks/state')).toBe(1)
})

test('workspace composer reports a failed request read in a toast without a dialog', async () => {
  const harness = createHarness({ 'quirky.tasks/workspaceComposerState': () => { throw new Error('Composer state unavailable.') } })
  const { element } = await harness.mount(COMPOSER_OVERLAY)
  expect(harness.toasts).toContainEqual({ title: 'Could not read the workspace request', detail: 'Composer state unavailable.' })
  expect(element.querySelector('[role="dialog"]')).toBeNull()
})

test('workspace composer renders creation failures with InlineError and still routes Cancel', async () => {
  const harness = createHarness({
    'quirky.tasks/workspaceComposerState': () => request(),
    'quirky.agents/list': () => ({ agents: [], defaultAgent: null }),
    'quirky.tasks/workspace': () => { throw new Error('Workspace name is taken.') },
    'quirky.tasks/workspaceComposerCancel': (params) => { expect(params).toEqual({ requestId: 'request-7' }); return null }
  })
  const { element } = await harness.mount(COMPOSER_OVERLAY)
  await click(button(element, 'Create workspace'))
  expect(element.querySelector('.tasks-composer .ui-inline-error[role="alert"] .ui-inline-error__message')?.textContent).toBe('Workspace name is taken.')
  expect(element.querySelector('p.tasks-composer__error')).toBeNull()
  await click(button(element, 'Cancel'))
  expect(callCount(harness, 'quirky.tasks/workspaceComposerCancel')).toBe(1)
})

test('new issue repository loading uses NoticeLine', async () => {
  const harness = createHarness({ 'quirky.tasks/issueChoices': () => never })
  const { element } = await harness.mountComponent(<NewIssueDialog context={harness.context} state={issueState()} refresh={async () => undefined} />)
  expect(element.querySelector('[role="dialog"] .ui-notice-line__text')?.textContent).toBe('Loading selected repositories…')
})

test('new issue with no repositories shows EmptyState instead of an alert', async () => {
  const harness = createHarness({ 'quirky.tasks/issueChoices': () => ({ repositories: [] }) })
  const { element } = await harness.mountComponent(<NewIssueDialog context={harness.context} state={issueState({ ...state.issueDraft, repoId: null })} refresh={async () => undefined} />)
  expect(element.querySelectorAll('.ui-empty-state')).toHaveLength(1)
  expect(element.querySelector('.ui-empty-state__message')?.textContent).toBe(noSelected)
  expect(element.querySelector('[role="alert"]')).toBeNull()
  expect([...element.querySelectorAll('.ui-notice-line__text')].some((entry) => entry.textContent?.includes('Loading'))).toBe(false)
})

test('new issue repository read failure clears loading and reports InlineError', async () => {
  const harness = createHarness({ 'quirky.tasks/issueChoices': () => { throw new Error('Repository list failed.') } })
  const { element } = await harness.mountComponent(<NewIssueDialog context={harness.context} state={issueState()} refresh={async () => undefined} />)
  expect(element.querySelector('.ui-inline-error__message')?.textContent).toBe('Repository list failed.')
  expect(element.querySelector('.ui-notice-line__text')?.textContent).not.toBe('Loading selected repositories…')
  expect(element.querySelector('.ui-empty-state')).toBeNull()
})

test('new issue shows label and assignee loading notices and clears both when one read fails', async () => {
  const labelsRead = Promise.withResolvers<unknown>()
  const harness = createHarness({
    'quirky.tasks/issueChoices': (params) => {
      if (params.kind === 'repositories') return { repositories: [repository], defaultRepoId: repository.id }
      if (params.kind === 'source') return choices('source')
      if (params.kind === 'labels') return labelsRead.promise
      return never
    },
    'quirky.tasks/draft': () => undefined
  })
  const { element } = await harness.mountComponent(<NewIssueDialog context={harness.context} state={issueState()} refresh={async () => undefined} />)
  const labels = [...element.querySelectorAll('fieldset')].find((entry) => entry.querySelector('legend')?.textContent === 'Labels')!
  const assignees = [...element.querySelectorAll('fieldset')].find((entry) => entry.querySelector('legend')?.textContent === 'Assignees')!
  expect(labels.querySelector('.ui-notice-line__text')?.textContent).toBe('Loading repository labels…')
  expect(assignees.querySelector('.ui-notice-line__text')?.textContent).toBe('Loading assignable users…')
  await act(async () => labelsRead.reject(new Error('gh failed')))
  await harness.settle()
  expect(element.querySelector('.ui-inline-error__message')?.textContent).toBe('Issue choices could not be loaded: gh failed')
  expect([...element.querySelectorAll('.ui-notice-line__text')].some((entry) => entry.textContent === 'Loading repository labels…')).toBe(false)
  expect([...element.querySelectorAll('.ui-notice-line__text')].some((entry) => entry.textContent === 'Loading assignable users…')).toBe(false)
})

test('unavailable issue labels and assignees remain advisory NoticeLines', async () => {
  const harness = createHarness({
    'quirky.tasks/issueChoices': (params) => params.kind === 'repositories'
      ? { repositories: [repository], defaultRepoId: repository.id }
      : params.kind === 'source'
        ? choices('source')
        : choices(String(params.kind), { available: false, message: unavailableChoices }),
    'quirky.tasks/draft': () => undefined
  })
  const { element } = await harness.mountComponent(<NewIssueDialog context={harness.context} state={issueState()} refresh={async () => undefined} />)
  await harness.settle()
  const fieldsets = [...element.querySelectorAll('fieldset')]
  for (const legend of ['Labels', 'Assignees']) {
    const fieldset = fieldsets.find((entry) => entry.querySelector('legend')?.textContent === legend)!
    expect(fieldset.querySelector('.ui-notice-line__text')?.textContent).toBe(unavailableChoices)
  }
  expect(element.querySelector('[role="alert"]')).toBeNull()
})

test('new issue source choice failures are shown as advisory NoticeLines', async () => {
  const harness = createHarness({
    'quirky.tasks/issueChoices': (params) => params.kind === 'repositories'
      ? { repositories: [repository], defaultRepoId: repository.id }
      : params.kind === 'source'
        ? choices('source', { available: false, message: 'Issue source could not be checked.' })
        : choices(String(params.kind)),
    'quirky.tasks/draft': () => undefined
  })
  const { element } = await harness.mountComponent(<NewIssueDialog context={harness.context} state={issueState()} refresh={async () => undefined} />)
  await harness.settle()
  expect(element.querySelector('.ui-notice-line__text')?.textContent).toBe('Issue source could not be checked.')
  expect(element.querySelector('[role="alert"]')).toBeNull()
})

test('new issue draft save errors use InlineError', async () => {
  const harness = createHarness({
    'quirky.tasks/issueChoices': (params) => choices(String(params.kind)),
    'quirky.tasks/draft': () => { throw new Error('Draft store is read-only.') }
  })
  const draft = { ...state.issueDraft, repoId: 'repo-1' }
  const { element } = await harness.mountComponent(<NewIssueDialog context={harness.context} state={issueState(draft)} refresh={async () => undefined} />)
  await setInputValue(inputByLabel(element, 'Title'), 'An edited title')
  expect(element.querySelector('.ui-inline-error__message')?.textContent).toBe('Draft could not be saved: Draft store is read-only.')
  expect(element.querySelector('p.quirky-tasks-new-issue__error')).toBeNull()
})

test('new issue create errors use InlineError', async () => {
  const harness = createHarness({
    'quirky.tasks/issueChoices': (params) => choices(String(params.kind)),
    'quirky.tasks/draft': () => undefined,
    'quirky.tasks/createIssue': () => { throw new Error('GitHub refused the issue.') }
  })
  const draft = { ...state.issueDraft, title: 'Existing title', repoId: 'repo-1' }
  const { element } = await harness.mountComponent(<NewIssueDialog context={harness.context} state={issueState(draft)} refresh={async () => undefined} />)
  await click(button(element, 'Create issue'))
  expect(element.querySelector('.ui-inline-error__message')?.textContent).toBe('GitHub refused the issue.')
  expect(element.querySelector('p.quirky-tasks-new-issue__error')).toBeNull()
})

test('parseItem retains valid optional values and omits invalid optional fields', () => {
  const parsed = parseItem({
    kind: 'pullRequest', number: 274, title: 'Pull request', body: '', url: 'https://github.com/acme/quirky/pull/274',
    worktree: 'wt-main', repoId: 'repo-1', repoName: 'quirky', headRefName: 'feat', mergeStateStatus: 7,
    additions: 3, deletions: -1, changedFiles: 1.5
  })!
  expect(parsed.headRefName).toBe('feat')
  expect(parsed.additions).toBe(3)
  expect(Object.hasOwn(parsed, 'mergeStateStatus')).toBe(false)
  expect(Object.hasOwn(parsed, 'deletions')).toBe(false)
  expect(Object.hasOwn(parsed, 'changedFiles')).toBe(false)
})
