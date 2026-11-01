import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import type { TasksState } from '../src/contracts'

type Mount = (element: HTMLElement, props: { report?: (state: unknown) => void }) => () => void
type Handler = (params: Record<string, unknown>) => unknown
type Event = { type: string; [key: string]: unknown }

let act: (callback: () => unknown) => Promise<void>
let activate: (context: UiPluginContext) => void
let place: typeof import('../src/list/place').place
let snapshotLimit: number
let cleanup: (() => void) | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
  const placeModule = await import('../src/list/place')
  place = placeModule.place
  snapshotLimit = placeModule.LIST_SNAPSHOT_LIMIT
})

/** Pushes every real snapshot out of the bounded store so one test's list never seeds the next. */
function flushSnapshots() {
  const empty = { list: { items: [], repositories: [], page: 1, totalPages: 1, perRepo: 0, failures: [], sources: {} }, checks: {}, merge: {} }
  for (let index = 0; index < snapshotLimit; index++) place.setListSnapshot(`flush-${index}`, empty)
}

afterEach(async () => {
  await act(async () => cleanup?.())
  cleanup = null
  document.body.innerHTML = ''
  place.takeFocus()
  flushSnapshots()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const TOOL = 'sidebar-section:quirky.tasks/tasks'
const VIEW = 'view:quirky.tasks/tasks'

const prsState: TasksState = {
  revision: 3,
  navigation: { source: 'github', mode: 'prs', repoIds: null, query: 'is:pr is:open', page: 1, scrollTop: 0, detail: null, newIssue: false, project: null, lastList: { mode: 'prs', query: 'is:pr is:open', page: 1 } },
  preferences: { showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github', defaultTaskViewPreset: 'open', defaultRepoSelection: null },
  issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
  projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
  links: {}
}

function withNavigation(patch: Partial<TasksState['navigation']>): TasksState {
  return { ...prsState, navigation: { ...prsState.navigation, ...patch } }
}

const repository = { id: 'repo-1', name: 'quirky', path: '/work/quirky', kind: 'git', worktree: 'wt-main', displayName: null }

function pr(number: number, patch: Record<string, unknown> = {}) {
  return {
    kind: 'pullRequest', number, title: `Pull request ${number}`, body: '', state: 'open', url: `https://github.com/acme/quirky/pull/${number}`,
    createdAt: null, updatedAt: new Date().toISOString(), author: 'sam', labels: [], assignees: [], isDraft: false,
    worktree: 'wt-main', repoId: 'repo-1', repoName: 'quirky', ...patch
  }
}

function issue(number: number, patch: Record<string, unknown> = {}) {
  return { ...pr(number), kind: 'issue', title: `Issue ${number}`, url: `https://github.com/acme/quirky/issues/${number}`, ...patch }
}

function listResult(items: unknown[], patch: Record<string, unknown> = {}) {
  return { items, repositories: [repository], page: 1, totalPages: 1, perRepo: 20, failures: [], sources: {}, ...patch }
}

type Mounted = {
  element: HTMLElement
  calls: { method: string; params: Record<string, unknown> }[]
  opened: { id: string; input: unknown }[]
  commands: { id: string; args: unknown }[]
  toasts: string[]
  reports: unknown[]
  emit(event: Event): Promise<void>
  settle(): Promise<void>
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
}

async function mountCompact(options: { state?: TasksState; handlers?: Record<string, Handler> } = {}): Promise<Mounted> {
  const provided = new Map<string, unknown>()
  const calls: Mounted['calls'] = []
  const opened: Mounted['opened'] = []
  const commands: Mounted['commands'] = []
  const toasts: string[] = []
  const reports: unknown[] = []
  const listeners = new Set<(event: Event) => void>()
  const state = options.state ?? prsState
  const handlers: Record<string, Handler> = {
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/state': () => state,
    'quirky.tasks/navigate': () => state,
    'quirky.tasks/list': () => listResult([pr(274), pr(275)]),
    'quirky.tasks/counts': () => ({ issues: 12, prs: 5 }),
    'quirky.hosting/viewer': () => ({ login: 'zach' }),
    ...options.handlers
  }
  const context = {
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) throw new Error('offline')
      return handler(params)
    },
    subscribe: (listener: (event: Event) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    toast: (title: string) => void toasts.push(title),
    executeCommand: async (id: string, args: unknown) => { commands.push({ id, args }) },
    openView: (id: string, input: unknown) => void opened.push({ id, input })
  } as unknown as UiPluginContext
  activate(context)
  const element = document.createElement('div')
  document.body.append(element)
  await act(async () => {
    cleanup = (provided.get(TOOL) as Mount)(element, { report: (value) => void reports.push(value) })
  })
  await settle()
  return {
    element, calls, opened, commands, toasts, reports, settle,
    async emit(event) {
      await act(async () => { for (const listener of listeners) listener(event) })
      await settle()
    }
  }
}

const labelOf = (element: Element) => element.getAttribute('aria-label') ?? ''
const rowTitles = (element: HTMLElement) => [...element.querySelectorAll('.ui-list-row__title')].map((node) => node.textContent)
const rowDescriptions = (element: HTMLElement) => [...element.querySelectorAll('.ui-list-row__description')].map((node) => node.textContent)
const button = (element: ParentNode, label: string) => [...element.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => labelOf(candidate) === label || candidate.textContent === label)

test('the Tasks tool provides the compact panel and reports that it is visible', async () => {
  const { element, reports } = await mountCompact()
  expect(element.querySelector('.tasks-sidebar')).toBeNull()
  expect(element.querySelector('.tasks-compact')).not.toBeNull()
  expect(reports.at(-1)).toEqual({ visible: true })
})

test('mounting calls prepare once and lists from the state it returns', async () => {
  const state = withNavigation({ mode: 'issues', query: 'is:issue is:open', lastList: { mode: 'issues', query: 'is:issue is:open', page: 1 } })
  const { calls } = await mountCompact({ state, handlers: { 'quirky.tasks/state': () => { throw new Error('unexpected') }, 'quirky.tasks/list': () => listResult([issue(9)]) } })
  expect(calls.filter((call) => call.method === 'quirky.tasks/prepare')).toHaveLength(1)
  const list = calls.find((call) => call.method === 'quirky.tasks/list')!
  expect(list.params).toEqual({ mode: 'issues', repoIds: null, query: 'is:issue is:open', page: 1 })
})

test('Issues and PRs tabs show counts and a tab click navigates by mode', async () => {
  const { element, calls } = await mountCompact()
  const tabs = [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
  expect(tabs.map((tab) => tab.textContent)).toEqual(['Issues12', 'PRs5'])
  expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
  const counts = calls.find((call) => call.method === 'quirky.tasks/counts')!
  expect(counts.params).toEqual({ mode: 'prs', query: 'is:pr is:open', repoIds: null })
  await act(async () => tabs[0]!.click())
  expect(calls.find((call) => call.method === 'quirky.tasks/navigate')?.params).toEqual({ mode: 'issues' })
})

test('a count that could not be read shows the tab name alone', async () => {
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/counts': () => ({ issues: null, prs: 5 }) } })
  const tabs = [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
  expect(tabs[0]!.textContent).toBe('Issues')
  expect(tabs[0]!.querySelector('.ui-tabs__count')).toBeNull()
  expect(tabs[1]!.textContent).toBe('PRs5')
})

test('a failing counts read leaves both tabs without numbers', async () => {
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/counts': () => { throw new Error('offline') } } })
  expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Issues', 'PRs'])
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
})

test('a row click navigates to its detail and then opens the expanded view with the new state', async () => {
  const detail = { worktree: 'wt-main', kind: 'pullRequest', number: 274, url: 'https://github.com/acme/quirky/pull/274' }
  const selected = { ...prsState, revision: 4, navigation: { ...prsState.navigation, detail } }
  const order: string[] = []
  const { element, opened } = await mountCompact({
    handlers: { 'quirky.tasks/navigate': () => { order.push('navigate'); return selected } }
  })
  const row = [...element.querySelectorAll<HTMLButtonElement>('.ui-list-row__main')][0]!
  await act(async () => row.click())
  await settle()
  expect(order).toEqual(['navigate'])
  expect(opened).toEqual([{ id: VIEW, input: { navigation: selected.navigation, revision: 4 } }])
})

test('a row click sends its target to navigate and requests row focus first', async () => {
  const { element, calls } = await mountCompact()
  const row = [...element.querySelectorAll<HTMLButtonElement>('.ui-list-row__main')][1]!
  await act(async () => row.click())
  await settle()
  expect(calls.find((call) => call.method === 'quirky.tasks/navigate')?.params).toEqual({
    detail: { worktree: 'wt-main', kind: 'pullRequest', number: 275, url: 'https://github.com/acme/quirky/pull/275' }
  })
  expect(place.takeFocus()).toBe('row')
})

test('a failed navigate reports the problem and does not expand', async () => {
  const { element, opened, toasts } = await mountCompact({ handlers: { 'quirky.tasks/navigate': () => { throw new Error('boom') } } })
  await act(async () => [...element.querySelectorAll<HTMLButtonElement>('.ui-list-row__main')][0]!.click())
  await settle()
  expect(opened).toEqual([])
  expect(toasts).toHaveLength(1)
})

test('Expand opens the expanded view with the current navigation and revision', async () => {
  const { element, opened } = await mountCompact()
  const expand = button(element, 'Expand Tasks')!
  expect(expand.querySelector('svg, .ui-control-icon')).not.toBeNull()
  await act(async () => expand.click())
  expect(opened).toEqual([{ id: VIEW, input: { navigation: prsState.navigation, revision: 3 } }])
  expect(place.takeFocus()).toBe('row')
})

test('the host owns the title and Minimize, so the panel passes no Minimize of its own', async () => {
  const { element } = await mountCompact()
  expect(button(element, 'Minimize Tasks')).toBeUndefined()
})

test('every row keeps its Start workspace button and menu in the DOM and in tab order', async () => {
  const { element } = await mountCompact()
  for (const number of [274, 275]) {
    const start = button(element, `Start workspace for #${number}`)!
    const menu = button(element, `More actions for #${number}`)!
    expect(start).toBeDefined()
    expect(menu).toBeDefined()
    expect(start.tabIndex).toBeGreaterThanOrEqual(0)
    expect(menu.tabIndex).toBeGreaterThanOrEqual(0)
    expect(start.hidden).toBe(false)
  }
})

test('a pull request menu offers Start workspace, Review, Open on GitHub and Copy link', async () => {
  const { element } = await mountCompact()
  await act(async () => button(element, 'More actions for #274')!.click())
  const items = [...element.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent)
  expect(items).toEqual(['Start workspace', 'Review', 'Open on GitHub', 'Copy link'])
})

test('an issue menu has no Review item', async () => {
  const state = withNavigation({ mode: 'issues', query: 'is:issue is:open', lastList: { mode: 'issues', query: 'is:issue is:open', page: 1 } })
  const { element } = await mountCompact({ state, handlers: { 'quirky.tasks/list': () => listResult([issue(12)]) } })
  await act(async () => button(element, 'More actions for #12')!.click())
  const items = [...element.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent)
  expect(items).toEqual(['Start workspace', 'Open on GitHub', 'Copy link'])
})

test('right-clicking a row opens the same items', async () => {
  const { element } = await mountCompact()
  const row = element.querySelector('[data-row-key]')!
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 14 })) })
  const items = [...document.body.querySelectorAll('.qt-menu-anchor [role="menuitem"]')].map((item) => item.textContent?.trim())
  expect(items).toEqual(['Start workspace', 'Review', 'Open on GitHub', 'Copy link'])
})

test('menu actions start the workspace, open the review, open the link and copy it', async () => {
  const { element, calls, commands } = await mountCompact({ handlers: { 'quirky.reviews/open': () => ({}), 'quirky.tasks/workspace': () => ({}) } })
  const target = { worktree: 'wt-main', kind: 'pullRequest', number: 274, url: 'https://github.com/acme/quirky/pull/274' }
  await act(async () => button(element, 'Start workspace for #274')!.click())
  expect(calls.find((call) => call.method === 'quirky.tasks/workspace')?.params).toEqual({ target, action: 'start' })
  for (const label of ['Review', 'Open on GitHub', 'Copy link']) {
    await act(async () => button(element, 'More actions for #274')!.click())
    const item = [...element.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent === label)!
    await act(async () => item.click())
    await settle()
  }
  expect(calls.find((call) => call.method === 'quirky.reviews/open')?.params).toMatchObject({ worktree: 'wt-main', number: 274, tab: 'conversation' })
  expect(commands).toEqual([
    { id: 'command:quirky.tasks/open-link', args: { url: target.url } },
    { id: 'command:quirky.tasks/copy-link', args: { url: target.url } }
  ])
})

test('a linked row offers Resume and resumes its workspace', async () => {
  const linked = pr(274, { linkedWorkspace: { name: 'notebook-focus', worktree: 'wt-linked' } })
  const { element, calls } = await mountCompact({ handlers: { 'quirky.tasks/list': () => listResult([linked, pr(275)]), 'quirky.tasks/workspace': () => ({}) } })
  expect(button(element, 'Start workspace for #274')).toBeUndefined()
  await act(async () => button(element, 'Resume for #274')!.click())
  expect(calls.find((call) => call.method === 'quirky.tasks/workspace')?.params).toMatchObject({ action: 'resume' })
  await act(async () => button(element, 'More actions for #274')!.click())
  expect([...element.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)[0]).toBe('Resume')
})

test('the default query shows no filter line', async () => {
  for (const query of ['is:pr is:open', 'is:open']) {
    const { element } = await mountCompact({ state: withNavigation({ query }) })
    expect(element.querySelector('.tasks-compact__filters')).toBeNull()
    await act(async () => cleanup?.())
    cleanup = null
    document.body.innerHTML = ''
  }
})

test('filters set in the tab show as one line with a preset name and count, and clear restores the default', async () => {
  const query = 'review-requested:@me is:pr is:open label:ui label:bug'
  const { element, calls } = await mountCompact({ state: withNavigation({ query }) })
  const line = element.querySelector('.tasks-compact__filters')!
  expect(line.textContent).toBe('Needs review · 2 filters')
  await act(async () => button(line, 'Clear filters')!.click())
  expect(calls.find((call) => call.method === 'quirky.tasks/navigate')?.params).toEqual({ query: 'is:pr is:open', page: 1, scrollTop: 0 })
})

test('a query that matches no preset is Custom, and one filter is singular', async () => {
  const { element } = await mountCompact({ state: withNavigation({ query: 'author:sam' }) })
  expect(element.querySelector('.tasks-compact__filters')!.textContent).toBe('Custom · 1 filter')
})

test('a preset with no extra filters shows its name alone', async () => {
  const { element } = await mountCompact({ state: withNavigation({ query: 'author:@me is:pr is:open' }) })
  expect(element.querySelector('.tasks-compact__filters')!.textContent).toBe('Mine')
})

test('a list longer than a page ends in a More tasks row that expands', async () => {
  const { element, opened } = await mountCompact({ handlers: { 'quirky.tasks/list': () => listResult([pr(274)], { totalPages: 3 }) } })
  const more = [...element.querySelectorAll<HTMLButtonElement>('.ui-list-row__main')].find((row) => row.textContent === 'More tasks')!
  expect(more).toBeDefined()
  await act(async () => more.click())
  expect(opened).toHaveLength(1)
  expect(opened[0]!.id).toBe(VIEW)
})

test('the last page has no More tasks row', async () => {
  const { element } = await mountCompact()
  expect(element.textContent).not.toContain('More tasks')
})

test('loading shows skeleton rows', async () => {
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/list': () => new Promise(() => {}) } })
  const loading = element.querySelector('[role="status"][aria-label="Loading tasks"]')!
  expect(loading.querySelectorAll('.tasks-compact__skeleton').length).toBeGreaterThanOrEqual(3)
})

test('nothing matching shows one line and Expand to change filters', async () => {
  const { element, opened } = await mountCompact({ handlers: { 'quirky.tasks/list': () => listResult([]) } })
  expect(element.textContent).toContain('No open pull requests')
  await act(async () => button(element, 'Expand to change filters')!.click())
  expect(opened).toHaveLength(1)
})

test('no repositories selected shows one line and Expand to select projects', async () => {
  const { element, opened } = await mountCompact({ state: withNavigation({ repoIds: [] }), handlers: { 'quirky.tasks/list': () => listResult([]) } })
  expect(element.textContent).toContain('No repositories selected')
  await act(async () => button(element, 'Expand to select projects')!.click())
  expect(opened).toHaveLength(1)
})

test('no registered repositories also shows the select projects line', async () => {
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/list': () => listResult([], { repositories: [] }) } })
  expect(button(element, 'Expand to select projects')).toBeDefined()
})

test('an unavailable source shows its message and Open task sources', async () => {
  const failures = [{ repoId: 'repo-1', stage: 'availability', reason: 'unauthenticated', message: 'GitHub is not signed in.' }]
  const { element, calls } = await mountCompact({ handlers: { 'quirky.tasks/list': () => listResult([], { failures }), 'quirky.tasks/settings': () => ({}) } })
  expect(element.textContent).toContain('GitHub is not signed in.')
  await act(async () => button(element, 'Open task sources')!.click())
  expect(calls.some((call) => call.method === 'quirky.tasks/settings')).toBe(true)
})

test('a failed list read shows the problem state', async () => {
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/list': () => { throw new Error('daemon exploded') } } })
  expect(element.textContent).toContain('daemon exploded')
  expect(button(element, 'Open task sources')).toBeDefined()
})

test('when some repositories failed the loaded rows stay with one warning line', async () => {
  const failures = [{ repoId: 'repo-2', stage: 'list', message: 'rate limited' }]
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/list': () => listResult([pr(274)], { failures }) } })
  expect(rowTitles(element)).toEqual(['Pull request 274'])
  expect(element.querySelectorAll('.tasks-compact__notice')).toHaveLength(1)
})

test('while Projects is selected the panel lists the last Issues or PRs list', async () => {
  const state = withNavigation({ mode: 'projects', query: 'status:todo', page: 4, lastList: { mode: 'issues', query: 'is:issue is:open assignee:@me', page: 2 } })
  const { element, calls } = await mountCompact({ state, handlers: { 'quirky.tasks/list': () => listResult([issue(7)]) } })
  expect(calls.find((call) => call.method === 'quirky.tasks/list')!.params).toEqual({ mode: 'issues', repoIds: null, query: 'is:issue is:open assignee:@me', page: 2 })
  expect(calls.find((call) => call.method === 'quirky.tasks/counts')!.params).toMatchObject({ mode: 'issues', query: 'is:issue is:open assignee:@me' })
  expect([...element.querySelectorAll('[role="tab"]')].find((tab) => tab.getAttribute('aria-selected') === 'true')!.textContent).toContain('Issues')
  expect(rowTitles(element)).toEqual(['Issue 7'])
})

test('clearing filters while Projects is selected returns to the list it clears', async () => {
  const state = withNavigation({ mode: 'projects', lastList: { mode: 'prs', query: 'is:pr is:open label:ui', page: 1 } })
  const { element, calls } = await mountCompact({ state })
  await act(async () => button(element, 'Clear filters')!.click())
  expect(calls.find((call) => call.method === 'quirky.tasks/navigate')?.params).toEqual({ mode: 'prs', query: 'is:pr is:open', page: 1, scrollTop: 0 })
})

test('the open row is highlighted and takes focus after a Collapse', async () => {
  const detail = { worktree: 'wt-main', kind: 'pullRequest' as const, number: 275, url: 'https://github.com/acme/quirky/pull/275' }
  place.requestFocus('row')
  const { element } = await mountCompact({ state: withNavigation({ detail }) })
  const selected = element.querySelector('.ui-list-row--selected')!
  expect(selected.querySelector('.ui-list-row__title')!.textContent).toBe('Pull request 275')
  expect(document.activeElement).toBe(selected.querySelector('.ui-list-row__main'))
})

test('focus after a Collapse lands on the first row when no row is open', async () => {
  place.requestFocus('row')
  const { element } = await mountCompact()
  expect(document.activeElement).toBe(element.querySelector('.ui-list-row__main'))
})

test('a plain mount does not take focus', async () => {
  const { element } = await mountCompact()
  expect(element.contains(document.activeElement) && document.activeElement !== document.body).toBe(false)
})

test('the panel restores its saved scroll for the view and saves it on scroll', async () => {
  const key = ['github', 'prs', '*', 'is:pr is:open', 1].join('\u0000')
  place.setScrollTop('compact', key, 48)
  const { element } = await mountCompact()
  const scroller = element.querySelector<HTMLElement>('.tasks-compact__list')!
  expect(scroller.scrollTop).toBe(48)
  scroller.scrollTop = 90
  await act(async () => { scroller.dispatchEvent(new Event('scroll', { bubbles: true })) })
  expect(place.scrollTop('compact', key)).toBe(90)
})

test('a failing agent activity read leaves the panel working', async () => {
  const { element } = await mountCompact({ handlers: { 'quirky.agent-status/dashboard': () => { throw new Error('plugin disabled') } } })
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
  expect(rowDescriptions(element)[0]).toMatch(/^#274 · quirky · /)
  expect(element.querySelector('[role="alert"]')).toBeNull()
})

test('agent activity on a linked worktree sets the row dot and second line, and attention wins', async () => {
  const linked = pr(274, { linkedWorkspace: { name: 'notebook', worktree: 'wt-linked' } })
  const card = (bucket: string, label: string) => ({ bucket, thread: { worktreeId: 'wt-linked', agent: 'Claude', label } })
  const { element, emit, calls } = await mountCompact({
    handlers: {
      'quirky.tasks/list': () => listResult([linked, pr(275)]),
      'quirky.agent-status/dashboard': () => ({ cards: [card('working', 'Running tests'), card('attention', 'Needs input'), card('idle', 'Done')] })
    }
  })
  expect(rowDescriptions(element)[0]).toBe('#274 · Claude · Needs input')
  expect(element.querySelectorAll('.ui-list-row')[0]!.querySelector('[aria-label="Status: needs-you"]')).not.toBeNull()
  const reads = calls.filter((call) => call.method === 'quirky.agent-status/dashboard').length
  await emit({ type: 'quirky.agent-status/activityChanged' })
  expect(calls.filter((call) => call.method === 'quirky.agent-status/dashboard').length).toBe(reads + 1)
})

test('a row takes its dot from checks and merge metadata when they arrive', async () => {
  const { element, calls } = await mountCompact({
    handlers: {
      'quirky.tasks/list': () => listResult([pr(274), pr(275, { author: 'zach' })]),
      'quirky.tasks/mergeMetadata': (params) => ({ review: { requestedReviewers: (params.target as { number: number }).number === 274 ? ['zach'] : [] }, mergeMetadataKnown: true }),
      'quirky.tasks/checks': (params) => (params.target as { number: number }).number === 275 ? { rollup: 'failure', checks: [{ name: 'a', conclusion: 'failure' }, { name: 'b', conclusion: 'failure' }], partial: false, partialFailures: [] } : { rollup: 'success', checks: [], partial: false, partialFailures: [] }
    }
  })
  expect(rowDescriptions(element)).toEqual(['#274 · quirky · review requested', '#275 · quirky · 2 checks failing'])
  expect(calls.filter((call) => call.method === 'quirky.hosting/viewer')).toHaveLength(1)
  expect(calls.find((call) => call.method === 'quirky.hosting/viewer')!.params).toEqual({ worktree: 'wt-main' })
})

test('a row whose details have not arrived stays grey with its repository and age', async () => {
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/checks': () => new Promise(() => {}), 'quirky.tasks/mergeMetadata': () => new Promise(() => {}) } })
  expect(rowDescriptions(element)[0]).toMatch(/^#274 · quirky · (just now|\d+m ago)$/)
  expect(element.querySelectorAll('[aria-label="Status: idle"]')).toHaveLength(2)
})

test('a failed viewer read leaves the viewer-based dots off', async () => {
  const { element } = await mountCompact({
    handlers: {
      'quirky.hosting/viewer': () => { throw new Error('no auth') },
      'quirky.tasks/mergeMetadata': () => ({ review: { requestedReviewers: ['zach'] }, mergeMetadataKnown: true })
    }
  })
  expect(rowDescriptions(element)[0]).toBe('#274 · quirky · waiting on zach')
})

test('results from a previous view are discarded when the effective list changes', async () => {
  let current = prsState
  const release: Record<string, () => void> = {}
  const { element, emit } = await mountCompact({
    handlers: {
      'quirky.tasks/state': () => current,
      'quirky.tasks/list': (params) => new Promise((resolve) => {
        release[String(params.mode)] = () => resolve(params.mode === 'prs' ? listResult([pr(274)]) : listResult([issue(9)]))
      })
    }
  })
  current = { ...withNavigation({ mode: 'issues', query: 'is:issue is:open', lastList: { mode: 'issues', query: 'is:issue is:open', page: 1 } }), revision: 4 }
  await emit({ type: 'quirky.tasks/changed', revision: 4 })
  release.issues!()
  await settle()
  release.prs!()
  await settle()
  expect(rowTitles(element)).toEqual(['Issue 9'])
})

test('a change that leaves the effective list alone does not reload it', async () => {
  let current = prsState
  const { emit, calls } = await mountCompact({ handlers: { 'quirky.tasks/state': () => current } })
  current = { ...prsState, revision: 9, navigation: { ...prsState.navigation, scrollTop: 40 } }
  await emit({ type: 'quirky.tasks/changed', revision: 9 })
  expect(calls.filter((call) => call.method === 'quirky.tasks/list')).toHaveLength(1)
})

const prsKey = ['github', 'prs', '*', 'is:pr is:open', 1].join('\u0000')

async function seedSnapshot(items: unknown[], extra: { checks?: Record<string, unknown>; merge?: Record<string, unknown> } = {}) {
  const { parseListResult } = await import('../src/list/model')
  place.setListSnapshot(prsKey, { list: parseListResult(listResult(items))!, checks: (extra.checks ?? {}) as never, merge: (extra.merge ?? {}) as never })
}

const never = () => new Promise(() => {})

test('mounting with a snapshot shows its rows with no skeleton and still reads the list', async () => {
  await seedSnapshot([pr(274), pr(275)])
  const { element, calls } = await mountCompact({ handlers: { 'quirky.tasks/list': never } })
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
  expect(element.querySelector('.tasks-compact__skeleton')).toBeNull()
  expect(calls.filter((call) => call.method === 'quirky.tasks/list')).toHaveLength(1)
})

test('the list read replaces a snapshot without showing skeletons on the way', async () => {
  await seedSnapshot([pr(274)])
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/list': () => listResult([pr(274), pr(280)]) } })
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 280'])
  expect(element.querySelector('.tasks-compact__skeleton')).toBeNull()
})

test('a snapshot is only used for the view it was saved for', async () => {
  place.setListSnapshot(['github', 'prs', '*', 'is:pr label:other', 1].join('\u0000'), { list: { items: [], repositories: [], page: 1, totalPages: 1, perRepo: 0, failures: [], sources: {} }, checks: {}, merge: {} })
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/list': never } })
  expect(element.querySelector('[role="status"][aria-label="Loading tasks"]')).not.toBeNull()
})

test('a snapshot keeps its row dots until the details are read again', async () => {
  await seedSnapshot([pr(274), pr(275, { author: 'zach' })], { checks: { [['wt-main', 'pullRequest', 275, 'https://github.com/acme/quirky/pull/275'].join('\u0000')]: { rollup: 'failure', checks: [{ name: 'a', conclusion: 'failure' }, { name: 'b', conclusion: 'failure' }], partial: false, partialFailures: [] } } })
  const { element } = await mountCompact({ handlers: { 'quirky.tasks/list': never, 'quirky.tasks/checks': never, 'quirky.tasks/mergeMetadata': never } })
  expect(rowDescriptions(element)[1]).toBe('#275 · quirky · 2 checks failing')
})

test('collapsing with a snapshot focuses and highlights the open row on the first render', async () => {
  await seedSnapshot([pr(274), pr(275)])
  const detail = { worktree: 'wt-main', kind: 'pullRequest' as const, number: 275, url: 'https://github.com/acme/quirky/pull/275' }
  place.requestFocus('row')
  const { element } = await mountCompact({ state: withNavigation({ detail }), handlers: { 'quirky.tasks/list': never } })
  const selected = element.querySelector('.ui-list-row--selected')!
  expect(selected.querySelector('.ui-list-row__title')!.textContent).toBe('Pull request 275')
  expect(document.activeElement).toBe(selected.querySelector('.ui-list-row__main'))
})

test('a loaded list is saved as the snapshot for its view key', async () => {
  const { element } = await mountCompact()
  expect(rowTitles(element)).toHaveLength(2)
  expect(place.listSnapshot(prsKey)?.list.items.map((item) => item.number)).toEqual([274, 275])
})

test('the Start button is an icon, not a text glyph', async () => {
  const { element } = await mountCompact()
  const start = button(element, 'Start workspace for #274')!
  expect(start.querySelector('svg, .ui-control-icon')).not.toBeNull()
  expect(start.textContent).not.toContain('▶')
})
