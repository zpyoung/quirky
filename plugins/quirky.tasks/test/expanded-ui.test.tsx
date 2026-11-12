import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import type { ItemTarget, TasksState } from '../src/contracts'

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
  revision: 1,
  navigation: { source: 'github', mode: 'prs', repoIds: null, query: 'is:open', page: 1, scrollTop: 0, detail: null, newIssue: false, project: null, lastList: { mode: 'prs', query: 'is:open', page: 1 } },
  preferences: { showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github', defaultTaskViewPreset: 'open', defaultRepoSelection: null },
  issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
  projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
  links: {}
}

const issuesNavigation = { mode: 'issues' as const, query: 'is:open', lastList: { mode: 'issues' as const, query: 'is:open', page: 1 } }

function withNavigation(patch: Partial<TasksState['navigation']>): TasksState {
  return { ...prsState, navigation: { ...prsState.navigation, ...patch } }
}

const repository = { id: 'repo-1', name: 'quirky', path: '/work/quirky', kind: 'git', worktree: 'wt-main', displayName: null }
const origin = { host: 'github.com', owner: 'acme', repo: 'quirky' }
const upstream = { host: 'github.com', owner: 'upstream', repo: 'quirky' }

const projectTarget = {
  id: 'PVT_4', owner: 'acme', ownerType: 'organization' as const, number: 4,
  url: 'https://github.com/orgs/acme/projects/4', title: 'Tasks project', viewId: 'VIEW_TABLE'
}
const projectStatus = { id: 'STATUS', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'TODO', name: 'Todo' }, { id: 'DONE', name: 'Done' }] }
const projectFields = [
  projectStatus,
  { id: 'START', name: 'Start date', dataType: 'DATE' },
  { id: 'TARGET', name: 'Target date', dataType: 'DATE' }
]
const projectViews = [
  { id: 'VIEW_TABLE', number: 1, name: 'Table', layout: 'TABLE', filter: '', fields: projectFields, groupByFields: [] },
  { id: 'VIEW_BOARD', number: 2, name: 'Board', layout: 'BOARD', filter: '', fields: projectFields, groupByFields: [projectStatus] },
  { id: 'VIEW_ROADMAP', number: 3, name: 'Roadmap', layout: 'ROADMAP', filter: '', fields: projectFields, groupByFields: [] }
]
const projectItem = {
  id: 'PVTI_7',
  content: {
    kind: 'issue', number: 7, title: 'Improve project table', state: 'open',
    url: 'https://github.com/acme/quirky/issues/7', repository: 'acme/quirky', author: 'zach', labels: [], assignees: []
  },
  fieldValues: [
    { fieldId: 'STATUS', value: 'TODO' },
    { fieldId: 'START', value: '2026-11-08' },
    { fieldId: 'TARGET', value: '2026-11-14' }
  ]
}

const projectHandlers: Record<string, Handler> = {
  'quirky.tasks/projectView': (params) => {
    if (params.action === 'list') return { views: projectViews }
    const view = projectViews.find((candidate) => candidate.id === params.viewId) ?? projectViews[0]!
    return { view, layout: view.layout, fields: projectFields, items: [projectItem], totalCount: 1 }
  }
}

function setTextareaValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('Textarea value setter is unavailable')
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function setInputValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('Input value setter is unavailable')
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function pr(number: number, patch: Record<string, unknown> = {}) {
  return {
    kind: 'pullRequest', number, title: `Pull request ${number}`, body: `Description of ${number}`, state: 'open', url: `https://github.com/acme/quirky/pull/${number}`,
    createdAt: null, updatedAt: new Date().toISOString(), author: 'sam', labels: ['editor'], assignees: ['zach'], isDraft: false,
    worktree: 'wt-main', repoId: 'repo-1', repoName: 'quirky', headRefName: 'fix/focus', baseRefName: 'main', additions: 84, deletions: 12, changedFiles: 5, ...patch
  }
}

function issue(number: number, patch: Record<string, unknown> = {}) {
  return { ...pr(number), kind: 'issue', title: `Issue ${number}`, body: `Body of ${number}`, url: `https://github.com/acme/quirky/issues/${number}`, ...patch }
}

function listResult(items: unknown[], patch: Record<string, unknown> = {}) {
  return { items, repositories: [repository], page: 1, totalPages: 1, perRepo: 20, failures: [], sources: { 'repo-1': { status: 'ready', origin } }, ...patch }
}

function target(item: { kind: string; number: number; url: string }): ItemTarget {
  return { worktree: 'wt-main', kind: item.kind as ItemTarget['kind'], number: item.number, url: item.url }
}

function metadata(patch: Record<string, unknown> = {}, review: Record<string, unknown> = {}) {
  return {
    review: { state: 'open', title: 'Pull request 274', url: 'https://github.com/acme/quirky/pull/274', headRefOid: 'a'.repeat(40), requestedReviewers: ['zach'], reviews: [], assignees: ['zach'], mergeMethods: { default: 'squash', allowed: ['squash', 'merge'] }, ...review },
    mergeMetadataKnown: true, mergeQueueRequired: false, autoMergeAllowed: true, mergeEligible: true, queueEligible: false,
    autoMergeEnabled: false, autoMergeEnableEligible: true, directMethods: ['squash', 'merge'], queueMethods: [], ...patch
  }
}

const passing = { rollup: 'success', checks: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'success' }], partial: false, partialFailures: [] }

function issueDetail(number: number) {
  const item = issue(number)
  return { item: { ...item, assignees: ['zach'] }, viewerCanUpdate: true, comments: [], participants: [], timeline: [], partialFailures: [], truncated: false, source: 'repository' }
}

type Mounted = {
  element: HTMLElement
  calls: { method: string; params: Record<string, unknown> }[]
  commands: { id: string; args: unknown }[]
  confirms: { title: string }[]
  toasts: string[]
  current(): TasksState
  emit(event: Event): Promise<void>
  settle(): Promise<void>
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
}

async function mountExpanded(options: { state?: TasksState; handlers?: Record<string, Handler>; beforeMount?: () => void; cloneRepoIdsOnStateRead?: boolean } = {}): Promise<Mounted> {
  const provided = new Map<string, unknown>()
  const calls: Mounted['calls'] = []
  const commands: Mounted['commands'] = []
  const confirms: Mounted['confirms'] = []
  const toasts: string[] = []
  const listeners = new Set<(event: Event) => void>()
  let state = options.state ?? prsState
  const emit = async (event: Event) => {
    await act(async () => { for (const listener of listeners) listener(event) })
    await settle()
  }
  const handlers: Record<string, Handler> = {
    'quirky.tasks/prepare': () => state,
    'quirky.tasks/state': () => {
      if (!options.cloneRepoIdsOnStateRead || state.navigation.repoIds === null) return state
      return { ...state, navigation: { ...state.navigation, repoIds: [...state.navigation.repoIds] } }
    },
    'quirky.tasks/navigate': (params) => {
      state = { ...state, revision: state.revision + 1, navigation: { ...state.navigation, ...params } as TasksState['navigation'] }
      for (const listener of listeners) listener({ type: 'quirky.tasks/changed' })
      return state
    },
    'quirky.tasks/list': (params) => params.mode === 'issues' ? listResult([issue(281), issue(279)]) : listResult([pr(274), pr(275)]),
    'quirky.tasks/counts': () => ({ issues: 12, prs: 5 }),
    'quirky.tasks/checks': () => passing,
    'quirky.tasks/mergeMetadata': (params) => metadata({}, { title: `Pull request ${(params.target as { number: number }).number}` }),
    'quirky.tasks/issue': () => issueDetail(281),
    'quirky.tasks/issueChoices': (params) => params.kind === 'source' ? { source: 'origin', sources: [{ id: 'origin', label: 'Origin' }] } : params.kind === 'labels' ? { available: true, labels: ['bug'] } : { available: true, assignees: [{ login: 'alex', avatarUrl: null }] },
    'quirky.hosting/viewer': () => ({ login: 'zach' }),
    'ui.tool.open': () => ({}),
    'quirky.reviews/open': () => ({ opened: true }),
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
    confirm: async (request: { title: string }) => { confirms.push(request); return true },
    executeCommand: async (id: string, args: unknown) => { commands.push({ id, args }) },
    openView: () => undefined
  } as unknown as UiPluginContext
  activate(context)
  options.beforeMount?.()
  const element = document.createElement('div')
  document.body.append(element)
  await act(async () => {
    cleanup = (provided.get(VIEW) as Mount)(element, {})
  })
  await settle()
  return { element, calls, commands, confirms, toasts, current: () => state, emit, settle }
}

const labelOf = (element: Element) => element.getAttribute('aria-label') ?? ''
const button = (element: ParentNode, label: string) => [...element.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => labelOf(candidate) === label || candidate.textContent?.trim() === label)
const rowTitles = (element: HTMLElement) => [...element.querySelectorAll('.tasks-list__list .ui-list-row__title')].map((node) => node.textContent)
const rowButtons = (element: HTMLElement) => [...element.querySelectorAll<HTMLButtonElement>('.tasks-list__list .ui-list-row__main')]
const menuItems = (element: ParentNode) => [...element.querySelectorAll<HTMLButtonElement>('[role="menu"] [role^="menuitem"]')]
const menuLabels = (element: ParentNode) => menuItems(element).map((item) => item.textContent?.trim())
const detailColumn = (element: HTMLElement) => element.querySelector<HTMLElement>('.tasks-list__detail')!

async function press(key: string) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  await settle()
}

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error('expected a rendered control')
  await act(async () => element.click())
  await settle()
}

const prDetailState = (number = 274) => withNavigation({ detail: target(pr(number)) })

test('rows show the status dot, title, number, repository and author, with checks and age', async () => {
  const { element } = await mountExpanded()
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
  const first = element.querySelector('.tasks-list__list .ui-list-row')!
  expect(first.querySelector('.ui-status-dot, [class*="status-dot"]')).not.toBeNull()
  expect(first.querySelector('.ui-list-row__description')?.textContent).toBe('#274 · quirky · sam')
  expect(first.textContent).toContain('2/2 passed')
  expect(first.textContent).toContain('just now')
})

test('a review request on the viewer gives the row the needs-you dot', async () => {
  const { element } = await mountExpanded()
  const first = element.querySelector('.tasks-list__list .ui-list-row')!
  expect(first.querySelector('[data-status="needs-you"], [class*="needs-you"]')).not.toBeNull()
})

test('a selected repository does not refetch the list when a row or detail-only change event occurs', async () => {
  const { element, calls, emit, current } = await mountExpanded({
    state: withNavigation({ repoIds: ['repo-1'] }),
    cloneRepoIdsOnStateRead: true
  })
  const initialReads = calls.filter((call) => call.method === 'quirky.tasks/list').length
  await click(rowButtons(element)[0])
  expect(current().navigation.detail).toEqual(target(pr(274)))
  expect(calls.filter((call) => call.method === 'quirky.tasks/list')).toHaveLength(initialReads)
  await emit({ type: 'quirky.tasks/changed' })
  expect(calls.filter((call) => call.method === 'quirky.tasks/list')).toHaveLength(initialReads)
})

test('clicking a pull request row selects it and does not open Review', async () => {
  const { element, calls } = await mountExpanded()
  await click(rowButtons(element)[0])
  expect(calls.find((call) => call.method === 'quirky.tasks/navigate')?.params).toEqual({ detail: target(pr(274)) })
  expect(calls.some((call) => call.method === 'quirky.reviews/open')).toBe(false)
})

test('clicking an issue row selects it the same way', async () => {
  const { element, calls } = await mountExpanded({ state: withNavigation(issuesNavigation) })
  await click(rowButtons(element)[1])
  expect(calls.find((call) => call.method === 'quirky.tasks/navigate')?.params).toEqual({ detail: target(issue(279)) })
})

test('the selected row is highlighted once the detail is set', async () => {
  const { element } = await mountExpanded({ state: prDetailState(275) })
  const rows = [...element.querySelectorAll('.tasks-list__list .ui-list-row')]
  expect(rows.map((row) => row.classList.contains('ui-list-row--selected'))).toEqual([false, true])
})

test('with no row open the detail column says Select a task', async () => {
  const { element } = await mountExpanded()
  expect(detailColumn(element).textContent).toContain('Select a task')
  expect(element.querySelector('.quirky-tasks-issue')).toBeNull()
})

test('an issue row opens the issue page in the detail column, and the list stays', async () => {
  const { element, calls } = await mountExpanded({ state: withNavigation({ ...issuesNavigation, detail: target(issue(281)) }) })
  expect(detailColumn(element).querySelector('.quirky-tasks-issue')).not.toBeNull()
  expect(detailColumn(element).textContent).toContain('Issue 281')
  expect(rowTitles(element)).toEqual(['Issue 281', 'Issue 279'])
  expect(calls.find((call) => call.method === 'quirky.tasks/issue')).toBeDefined()
  expect(detailColumn(element).textContent).not.toContain('Select a task')
})

test('the issue pane keeps assign, status with close as duplicate, Start, Resume and Open on GitHub', async () => {
  const { element, commands } = await mountExpanded({ state: withNavigation({ ...issuesNavigation, detail: target(issue(281)) }) })
  const pane = detailColumn(element)
  const status = pane.querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  expect([...status.options].map((option) => option.textContent)).toEqual(['Open / reopen', 'Closed', 'Close as completed', 'Close as not planned', 'Close as duplicate'])
  expect([...pane.querySelectorAll('label')].some((label) => label.textContent?.trim() === 'Add assignee login')).toBe(true)
  expect(button(pane, 'Start workspace from issue')).toBeDefined()
  await click(button(pane, 'Open on GitHub'))
  expect(commands).toEqual([{ id: 'command:quirky.tasks/open-link', args: { url: 'https://github.com/acme/quirky/issues/281' } }])
})

test('the issue pane shows Open workspace and Start new workspace for a linked issue', async () => {
  const state = { ...withNavigation({ ...issuesNavigation, detail: target(issue(281)) }), links: { w1: { name: 'issue-281', url: 'https://github.com/acme/quirky/issues/281' } } } as unknown as TasksState
  const { element } = await mountExpanded({ state })
  expect(button(detailColumn(element), 'Open workspace')).toBeDefined()
  expect(button(detailColumn(element), 'Start new workspace')).toBeDefined()
})

test('the issue pane clears its row and offers Back to Project when opened from a project', async () => {
  const { element, calls } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, detail: target(issue(281)), project: projectTarget })
  })
  const pane = element.querySelector('.quirky-tasks-issue')!
  expect(button(pane, 'Back to Project')).toBeDefined()
  await click(button(pane, 'Back to Project'))
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toEqual({ detail: null })
})

test('the expanded issue pane keeps label, description edit, and comment actions reachable', async () => {
  const issueEdits: Record<string, unknown>[] = []
  const { element, calls } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, detail: target(issue(281)) }),
    handlers: {
      'quirky.tasks/issueEdit': (params) => {
        issueEdits.push(params)
        return { item: { ...issue(281), ...params } }
      },
      'quirky.tasks/issueComment': (params) => ({
        comment: { id: 1, issueNumber: 281, body: params.body, author: 'zach', createdAt: '2026-11-11T00:00:00Z' }
      })
    }
  })
  const pane = detailColumn(element)
  await click(button(pane, '+ bug'))
  expect(issueEdits.at(-1)).toMatchObject({ labels: ['editor', 'bug'] })

  await click(button(pane, 'Edit description'))
  const description = pane.querySelector<HTMLTextAreaElement>('textarea[aria-label="Issue description"]')
  expect(description).not.toBeNull()
  await act(async () => setTextareaValue(description!, 'Updated issue description'))
  await click(button(pane, 'Save description'))
  expect(issueEdits.at(-1)).toMatchObject({ body: 'Updated issue description' })

  const comment = pane.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]')
  expect(comment).not.toBeNull()
  await act(async () => setTextareaValue(comment!, 'Expanded pane comment'))
  await click(button(pane, 'Comment'))
  expect(calls.filter((call) => call.method === 'quirky.tasks/issueComment').at(-1)?.params).toEqual({ body: 'Expanded pane comment' })
})

test('New issue is reachable from the expanded Issues tab', async () => {
  const { element, calls } = await mountExpanded({ state: withNavigation(issuesNavigation) })
  await click(button(element, 'New GitHub issue'))
  expect(element.querySelector('.quirky-tasks-new-issue')).not.toBeNull()
  expect(element.querySelector<HTMLInputElement>('#new-issue-title')).not.toBeNull()
  expect(calls.some((call) => call.method === 'quirky.tasks/issueChoices' && call.params.kind === 'repositories')).toBe(true)
})

test('creating an issue on page one refreshes the selected repository list immediately', async () => {
  let items: unknown[] = [issue(281), issue(279)]
  const created = issue(282, { title: 'Created through the expanded form' })
  const { element } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, repoIds: ['repo-1'] }),
    handlers: {
      'quirky.tasks/list': () => listResult(items),
      'quirky.tasks/issueChoices': (params) => {
        if (params.kind === 'repositories') return { repositories: [repository], defaultRepoId: repository.id }
        if (params.kind === 'source') return { source: 'origin', sources: [{ id: 'origin', label: 'Origin' }] }
        if (params.kind === 'labels') return { available: true, labels: [] }
        return { available: true, assignees: [] }
      },
      'quirky.tasks/draft': () => ({}),
      'quirky.tasks/createIssue': () => {
        items = [created, ...items]
        return { item: created }
      }
    }
  })
  await click(button(element, 'New GitHub issue'))
  await settle()
  const title = element.querySelector<HTMLInputElement>('#new-issue-title')!
  await act(async () => setInputValue(title, 'Created through the expanded form'))
  await settle()
  const submit = button(element, 'Create issue')!
  expect(submit.disabled).toBe(false)
  await click(submit)
  expect(element.querySelector('.quirky-tasks-new-issue [role="alert"]')).toBeNull()
  await click(button(element, 'Cancel'))
  expect(rowTitles(element)).toEqual(['Created through the expanded form', 'Issue 281', 'Issue 279'])
  expect(element.querySelector('.quirky-tasks-new-issue')).toBeNull()
})

test('a same-state issue edit updates the title on a retained closed row', async () => {
  let providerIssue = issue(281, { title: 'Issue title before edit' })
  const { element, calls } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, repoIds: ['repo-1'], detail: target(providerIssue) }),
    handlers: {
      'quirky.tasks/list': () => listResult([issue(281, { title: 'Stale indexed title' })]),
      'quirky.tasks/issue': () => ({ ...issueDetail(281), item: providerIssue }),
      'quirky.tasks/issueEdit': (params) => {
        providerIssue = {
          ...providerIssue,
          ...params,
          ...(params.body !== undefined ? { title: 'UPDATEDTITLE' } : {})
        }
        return { item: providerIssue }
      }
    }
  })
  const status = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  await act(async () => {
    status.value = 'closed-completed'
    status.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(element.querySelector('.tasks-list__row .ui-status-dot--done') !== null).toBe(true)
  expect(element.querySelector('.tasks-list__row')?.textContent).toContain('Pending refresh')

  const pane = detailColumn(element)
  await click(button(pane, 'Edit description'))
  const description = pane.querySelector<HTMLTextAreaElement>('textarea[aria-label="Issue description"]')!
  await act(async () => setTextareaValue(description, 'Confirmed description edit'))
  await click(button(pane, 'Save description'))
  expect(calls.some((call) => call.method === 'quirky.tasks/issueEdit' && call.params.body === 'Confirmed description edit')).toBe(true)
  expect(rowTitles(element)).toContain('UPDATEDTITLE')
  expect(element.querySelector('.tasks-list__row .ui-status-dot--done') !== null).toBe(true)
  expect(element.querySelector('.tasks-list__row')?.textContent).toContain('Pending refresh')
})

test('a closed issue stays retained when the source identity differs from its URL only by case', async () => {
  const staleIssue = issue(281, {
    title: 'Stale indexed title',
    url: 'https://github.com/acme/quirky/issues/281'
  })
  const sourceOrigin = { host: 'GitHub.COM', owner: 'Acme', repo: 'Quirky' }
  const { element } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, repoIds: ['repo-1'], detail: target(staleIssue) }),
    handlers: {
      'quirky.tasks/list': () => listResult([staleIssue], { sources: { 'repo-1': { status: 'ready', origin: sourceOrigin } } }),
      'quirky.tasks/issue': () => ({ ...issueDetail(281), item: staleIssue }),
      'quirky.tasks/issueEdit': (params) => ({ item: { ...staleIssue, ...params } })
    }
  })
  const status = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  await act(async () => {
    status.value = 'closed-completed'
    status.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()

  const row = element.querySelector('.tasks-list__row')
  expect(rowTitles(element)).toEqual(['Stale indexed title'])
  expect(row?.querySelector('.ui-status-dot--done')).not.toBeNull()
  expect(row?.textContent).toContain('Pending refresh')
})


test('creating another issue preserves a closed row retained while search results lag', async () => {
  let providerIssue = issue(281, { title: 'Closed issue 281' })
  let issueCreated = false
  const created = issue(282, { title: 'New issue after close' })
  const staleOpenIssue = issue(281, { title: 'Closed issue 281' })
  const { element } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, repoIds: ['repo-1'], detail: target(providerIssue) }),
    handlers: {
      'quirky.tasks/list': () => listResult(issueCreated ? [staleOpenIssue, created] : [staleOpenIssue]),
      'quirky.tasks/issue': () => ({ ...issueDetail(281), item: providerIssue }),
      'quirky.tasks/issueEdit': (params) => {
        providerIssue = { ...providerIssue, ...params }
        return { item: providerIssue }
      },
      'quirky.tasks/issueChoices': (params) => {
        if (params.kind === 'repositories') return { repositories: [repository], defaultRepoId: repository.id }
        if (params.kind === 'source') return { source: 'origin', sources: [{ id: 'origin', label: 'Origin' }] }
        if (params.kind === 'labels') return { available: true, labels: [] }
        return { available: true, assignees: [] }
      },
      'quirky.tasks/draft': () => ({}),
      'quirky.tasks/createIssue': () => {
        issueCreated = true
        return { item: created }
      }
    }
  })
  const status = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  await act(async () => {
    status.value = 'closed-completed'
    status.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(element.querySelector('.tasks-list__row .ui-status-dot--done') !== null).toBe(true)
  expect(element.querySelector('.tasks-list__row')?.textContent).toContain('Pending refresh')

  await click(button(element, 'New GitHub issue'))
  await settle()
  const title = element.querySelector<HTMLInputElement>('#new-issue-title')!
  await act(async () => setInputValue(title, 'New issue after close'))
  await settle()
  await click(button(element, 'Create issue'))
  const cancel = button(element, 'Cancel')
  if (cancel) await click(cancel)

  expect(rowTitles(element)).toContain('New issue after close')
  expect(rowTitles(element)).toContain('Closed issue 281')
  const closedRow = [...element.querySelectorAll('.tasks-list__row')].find((row) => row.querySelector('.ui-list-row__title')?.textContent === 'Closed issue 281')
  expect(closedRow?.querySelector('.ui-status-dot--done') !== null).toBe(true)
  expect(closedRow?.textContent?.includes('Pending refresh')).toBe(true)
})

test.each(['query', 'repository', 'page'] as const)('a pending closed issue is not carried into a different %s list', async (listChange) => {
  const otherRepository = { ...repository, id: 'repo-2', name: 'other', path: '/work/other', worktree: 'wt-other' }
  const sources = {
    'repo-1': { status: 'ready', origin },
    'repo-2': { status: 'ready', origin: { ...origin, repo: 'other' } }
  }
  const listForView = (params: Record<string, unknown>) => {
    const repoIds = Array.isArray(params.repoIds) ? params.repoIds.filter((id): id is string => typeof id === 'string') : ['repo-1', 'repo-2']
    const page = typeof params.page === 'number' ? params.page : 1
    const query = typeof params.query === 'string' ? params.query : ''
    const items = repoIds.includes('repo-1') && page === 1 && !query.includes('is:closed') ? [issue(281), issue(279)] : []
    return listResult(items, { repositories: [repository, otherRepository], page, totalPages: 2, sources })
  }
  const { element } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, repoIds: ['repo-1'], detail: target(issue(281)) }),
    handlers: {
      'quirky.tasks/list': listForView,
      'quirky.tasks/preferences': () => ({}),
      'quirky.tasks/issueEdit': (params) => ({ item: { ...issue(281), ...params } })
    }
  })
  const issueStatus = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  await act(async () => {
    issueStatus.value = 'closed-completed'
    issueStatus.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(element.querySelector('.tasks-list__row .ui-status-dot--done') !== null).toBe(true)

  if (listChange === 'query') {
    await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
    const filterStatus = element.querySelector<HTMLSelectElement>('#tasks-list-status-filter')!
    await act(async () => {
      filterStatus.value = 'closed'
      filterStatus.dispatchEvent(new Event('change', { bubbles: true }))
    })
  } else if (listChange === 'repository') {
    await click(element.querySelector('.tasks-list__repo-picker button'))
    const picker = element.querySelector('[role="group"][aria-label="Select repositories"]')!
    const originChoice = [...picker.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'quirky')!
    const otherChoice = [...picker.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'other')!
    await click(originChoice.querySelector('input[type="checkbox"]'))
    await click(otherChoice.querySelector('input[type="checkbox"]'))
  } else {
    const pagination = element.querySelector('nav[aria-label="GitHub task pagination"]')!
    await click(button(pagination, 'Next page'))
  }
  await settle()
  expect(rowTitles(element)).toEqual([])
})

test('an unfiltered issue status edit is discarded after paging away and refreshing', async () => {
  const issueFromInitialList = issue(281, { title: 'Indexed issue title' })
  let providerHasUpdatedIssue = false
  const { element } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, query: 'is:issue', repoIds: ['repo-1'], detail: target(issueFromInitialList) }),
    handlers: {
      'quirky.tasks/list': (params) => {
        const page = params.page === 2 ? 2 : 1
        const items = page === 1
          ? [providerHasUpdatedIssue ? issue(281, { title: 'Fresh provider title' }) : issueFromInitialList]
          : []
        return listResult(items, { page, totalPages: 2 })
      },
      'quirky.tasks/issue': () => ({ ...issueDetail(281), item: issueFromInitialList }),
      'quirky.tasks/issueEdit': (params) => ({ item: { ...issueFromInitialList, ...params } })
    }
  })
  const status = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  await act(async () => {
    status.value = 'closed-completed'
    status.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(element.querySelector('.tasks-list__row .ui-status-dot--done')).not.toBeNull()

  const pagination = element.querySelector('nav[aria-label="GitHub task pagination"]')!
  await click(button(pagination, 'Next page'))
  expect(rowTitles(element)).toEqual([])
  providerHasUpdatedIssue = true
  await click(button(element.querySelector('nav[aria-label="GitHub task pagination"]')!, 'Previous page'))
  expect(rowTitles(element)).toEqual(['Fresh provider title'])
  expect(element.querySelector('.tasks-list__row .ui-status-dot--done')).toBeNull()

  await click(button(element, 'Refresh GitHub work'))
  const refreshedRow = element.querySelector('.tasks-list__row')
  expect(rowTitles(element)).toEqual(['Fresh provider title'])
  expect(refreshedRow?.querySelector('.ui-status-dot, [class*="status-dot"]')).not.toBeNull()
  expect(refreshedRow?.querySelector('.ui-status-dot--done')).toBeNull()
})

test('an unfiltered issue status edit is cleared by Refresh on the same list', async () => {
  const issueFromInitialList = issue(281, { title: 'Indexed issue title' })
  let providerHasUpdatedIssue = false
  const { element } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, query: 'is:issue', repoIds: ['repo-1'], detail: target(issueFromInitialList) }),
    handlers: {
      'quirky.tasks/list': () => listResult([
        providerHasUpdatedIssue ? issue(281, { title: 'Fresh provider title' }) : issueFromInitialList
      ]),
      'quirky.tasks/issue': () => ({ ...issueDetail(281), item: issueFromInitialList }),
      'quirky.tasks/issueEdit': (params) => ({ item: { ...issueFromInitialList, ...params } })
    }
  })
  const status = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  await act(async () => {
    status.value = 'closed-completed'
    status.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(element.querySelector('.tasks-list__row .ui-status-dot--done')).not.toBeNull()

  providerHasUpdatedIssue = true
  await click(button(element, 'Refresh GitHub work'))
  const refreshedRow = element.querySelector('.tasks-list__row')
  expect(rowTitles(element)).toEqual(['Fresh provider title'])
  expect(refreshedRow?.querySelector('.ui-status-dot, [class*="status-dot"]')).not.toBeNull()
  expect(refreshedRow?.querySelector('.ui-status-dot--done')).toBeNull()
})

test('retaining a closed origin issue does not contaminate the upstream issue with the same number', async () => {
  const originListIssue = issue(7, { title: 'Origin issue 7' })
  const upstreamListIssue = issue(7, {
    title: 'Upstream issue 7',
    url: 'https://github.com/upstream/quirky/issues/7'
  })
  let originDetail = { ...originListIssue }
  let selectedSource: 'origin' | 'upstream' = 'origin'
  const sources = () => ({
    'repo-1': {
      status: 'ready',
      origin,
      issueSource: selectedSource,
      issueRepository: selectedSource === 'upstream' ? upstream : origin,
      candidates: [origin, upstream]
    }
  })
  const { element } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, repoIds: ['repo-1'], detail: target(originDetail) }),
    handlers: {
      'quirky.tasks/list': () => listResult([selectedSource === 'upstream' ? upstreamListIssue : originListIssue], { sources: sources() }),
      'quirky.tasks/row': (params) => {
        if (params.action === 'issueSource') selectedSource = params.preference as 'origin' | 'upstream'
        return {}
      },
      'quirky.tasks/issue': () => ({ ...issueDetail(7), item: originDetail }),
      'quirky.tasks/issueEdit': (params) => {
        originDetail = { ...originDetail, ...params }
        return { item: originDetail }
      }
    }
  })
  const selectStatus = async (value: 'open' | 'closed-completed') => {
    const status = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
    await act(async () => {
      status.value = value
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
  }

  await selectStatus('closed-completed')
  expect(rowTitles(element)).toEqual(['Origin issue 7'])
  expect(element.querySelector('.tasks-list__row')?.textContent).toContain('Pending refresh')
  await click(button(element, 'Tasks options'))
  await click(menuItems(element).find((item) => item.textContent?.replace('✓', '').trim() === 'Upstream'))
  expect(detailColumn(element).textContent).toContain('Origin issue 7')
  expect(rowTitles(element)).toEqual(['Upstream issue 7'])

  await selectStatus('open')
  await selectStatus('closed-completed')
  expect(rowTitles(element)).toEqual(['Upstream issue 7'])
  const upstreamRow = element.querySelector('.tasks-list__row')
  expect(upstreamRow?.querySelector('.ui-status-dot--done') === null).toBe(true)
  expect(upstreamRow?.textContent?.includes('Pending refresh')).toBe(false)
})
test('a pull request row shows the PR detail with title, state, description, checks, reviewers, assignees, labels, worktree and changes', async () => {
  const { element } = await mountExpanded({ state: prDetailState() })
  const pane = detailColumn(element)
  expect(pane.querySelector('h2')?.textContent).toBe('Pull request 274')
  expect(pane.textContent).toContain('Description of 274')
  expect(pane.textContent).toContain('2/2 passed')
  expect(pane.textContent).toContain('zach')
  expect(pane.textContent).toContain('editor')
  expect(pane.textContent).toContain('None linked yet')
  expect(pane.textContent).toContain('+84')
  expect(pane.textContent).toContain('5 files')
  expect(button(pane, 'Open pull request #274 on GitHub')).toBeDefined()
})

test('a closed pull request shows its state badge', async () => {
  const { element } = await mountExpanded({ state: prDetailState(), handlers: { 'quirky.tasks/list': () => listResult([pr(274, { state: 'merged' })]) } })
  expect(detailColumn(element).querySelector('.ui-badge')?.textContent).toBe('merged')
})

test('Review opens the Review tab on Conversation, and the checks line opens it on Checks', async () => {
  const { element, calls } = await mountExpanded({ state: prDetailState() })
  await click(button(detailColumn(element), 'Review'))
  expect(calls.filter((call) => call.method === 'quirky.reviews/open').at(-1)?.params).toMatchObject({ worktree: 'wt-main', number: 274, tab: 'conversation' })
  await click(button(detailColumn(element), 'Checks for PR #274: 2/2 passed'))
  expect(calls.filter((call) => call.method === 'quirky.reviews/open').at(-1)?.params).toMatchObject({ number: 274, tab: 'checks' })
})

test('Start, Resume and Start new call the workspace method for the pull request', async () => {
  const unlinked = await mountExpanded({ state: prDetailState() })
  await click(button(detailColumn(unlinked.element), 'Start'))
  expect(unlinked.calls.find((call) => call.method === 'quirky.tasks/workspace')?.params).toEqual({ target: target(pr(274)), action: 'start' })
  await act(async () => cleanup?.())
  cleanup = null
  document.body.innerHTML = ''
  const linked = await mountExpanded({ state: prDetailState(), handlers: { 'quirky.tasks/list': () => listResult([pr(274, { linkedWorkspace: { name: 'pr-274', worktree: 'wt-pr' } })]) } })
  expect(button(detailColumn(linked.element), 'Start')).toBeUndefined()
  await click(button(detailColumn(linked.element), 'Resume'))
  expect(linked.calls.find((call) => call.method === 'quirky.tasks/workspace')?.params).toEqual({ target: target(pr(274)), action: 'resume' })
  await click(button(detailColumn(linked.element), 'Start new'))
  expect(linked.calls.filter((call) => call.method === 'quirky.tasks/workspace').at(-1)?.params).toEqual({ target: target(pr(274)), action: 'start', newWorkspace: true })
  expect(detailColumn(linked.element).textContent).toContain('pr-274')
})

test('the merge menu of an eligible pull request offers the direct methods and auto-merge', async () => {
  const { element } = await mountExpanded({ state: prDetailState() })
  const trigger = button(detailColumn(element), 'Merge actions for PR #274')!
  expect(trigger.textContent).toContain('Merge')
  await click(trigger)
  expect(menuLabels(detailColumn(element))).toEqual(['Squash and merge', 'Create merge commit', 'Enable auto-merge', 'Open on GitHub'])
})

test('the merge menu of a queue-only pull request offers Merge when ready by method', async () => {
  const { element } = await mountExpanded({
    state: prDetailState(),
    handlers: { 'quirky.tasks/mergeMetadata': () => metadata({ mergeQueueRequired: true, mergeEligible: false, queueEligible: true, queueMethods: ['squash'] }) }
  })
  await click(button(detailColumn(element), 'Merge actions for PR #274'))
  expect(menuLabels(detailColumn(element))).toEqual(['Merge when ready (squash)', 'Merge when ready', 'Open on GitHub'])
})

test('the merge menu explains an ineligible pull request and offers no merge method', async () => {
  const { element } = await mountExpanded({
    state: prDetailState(),
    handlers: { 'quirky.tasks/mergeMetadata': () => metadata({ mergeEligible: false, autoMergeAllowed: false, autoMergeEnableEligible: false }) }
  })
  await click(button(detailColumn(element), 'Merge actions for PR #274'))
  const menu = detailColumn(element).querySelector('[role="menu"]')!
  expect(menu.textContent).toContain('Direct merge is not confirmed safe.')
  expect(menu.textContent).toContain('GitHub has disabled auto-merge for this repository.')
  expect(menuLabels(detailColumn(element))).toEqual(['Open on GitHub'])
})

test('the merge menu says when GitHub has not confirmed the merge-queue metadata', async () => {
  const { element } = await mountExpanded({
    state: prDetailState(),
    handlers: { 'quirky.tasks/mergeMetadata': () => metadata({ mergeMetadataKnown: false, mergeQueueRequired: null, mergeEligible: false, autoMergeAllowed: null, autoMergeEnableEligible: false }) }
  })
  await click(button(detailColumn(element), 'Merge actions for PR #274'))
  expect(detailColumn(element).querySelector('[role="menu"]')!.textContent).toContain('GitHub has not confirmed merge-queue safety metadata.')
})

test('choosing a merge method confirms first and sends the expected head to the row method', async () => {
  const { element, calls, confirms } = await mountExpanded({ state: prDetailState(), handlers: { 'quirky.tasks/row': () => ({ kind: 'merged' }) } })
  await click(button(detailColumn(element), 'Merge actions for PR #274'))
  await click(menuItems(detailColumn(element))[0])
  expect(confirms.map((request) => request.title)).toEqual(['Merge squash PR #274?'])
  expect(calls.find((call) => call.method === 'quirky.tasks/row')?.params).toMatchObject({ target: target(pr(274)), action: 'merge', method: 'squash', mergeAction: 'direct', expectedHead: 'a'.repeat(40), yes: true })
})

test('a metadata failure shows the unavailable merge control and Retry', async () => {
  let attempts = 0
  const { element } = await mountExpanded({
    state: prDetailState(),
    handlers: { 'quirky.tasks/mergeMetadata': () => { attempts += 1; throw new Error('GitHub is down') } }
  })
  const pane = detailColumn(element)
  expect(button(pane, 'Merge metadata unavailable for PR #274')).toBeDefined()
  expect(pane.textContent).toContain('Review metadata unavailable: GitHub is down')
  const before = attempts
  await click(button(pane, 'Retry'))
  expect(attempts).toBeGreaterThan(before)
})

test('the reviewers dialog keeps its status lines and requests reviewers through the row method', async () => {
  const { element, calls } = await mountExpanded({
    state: prDetailState(),
    handlers: {
      'quirky.tasks/mergeMetadata': () => metadata({}, { requestedReviewers: ['zach'], reviews: [{ author: 'alex', state: 'APPROVED' }], assignees: ['sam'], participantsTruncated: true }),
      'quirky.tasks/row': () => ({ result: { updated: true } })
    }
  })
  const pane = detailColumn(element)
  const trigger = pane.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  expect(trigger.textContent).toBe('zach')
  await click(trigger)
  const dialog = pane.querySelector('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe('Reviewers for PR #274')
  expect(dialog.textContent).toContain('Currently requested: zach')
  expect(dialog.textContent).toContain('Recent reviewer activity is incomplete.')
  expect(dialog.textContent).toContain('Recently active in this pull request')
  expect(dialog.textContent).toContain('Suggestions')
  const box = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Type or choose a reviewer"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'newcomer')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(button(dialog, 'Request reviewers'))
  expect(calls.find((call) => call.method === 'quirky.tasks/row')?.params).toMatchObject({ target: target(pr(274)), action: 'reviewers', reviewerAction: 'add', reviewerText: 'newcomer' })
})

test('an unknown reviewer list is stated in the dialog and on the trigger', async () => {
  const { element } = await mountExpanded({
    state: prDetailState(),
    handlers: { 'quirky.tasks/mergeMetadata': () => metadata({}, { requestedReviewers: null, reviews: null, assignees: null }) }
  })
  const pane = detailColumn(element)
  const trigger = pane.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  expect(trigger.textContent).toBe('Requested reviewers unavailable')
  await click(trigger)
  const dialog = pane.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Requested reviewers are unavailable.')
  expect(dialog.textContent).toContain('Review history is unavailable.')
  expect(dialog.textContent).toContain('Pull-request assignees are unavailable.')
})

test('a pull request that is not on the current page loads from the merge metadata and omits the description', async () => {
  const offPage = target(pr(999))
  const { element, calls } = await mountExpanded({
    state: withNavigation({ detail: offPage }),
    handlers: { 'quirky.tasks/mergeMetadata': () => metadata({}, { title: 'Far away change', url: offPage.url, state: 'open', additions: 3, deletions: 1, changedFiles: 2, requestedReviewers: ['alex'] }) }
  })
  const pane = detailColumn(element)
  expect(calls.find((call) => call.method === 'quirky.tasks/mergeMetadata')?.params).toEqual({ target: offPage })
  expect(pane.querySelector('h2')?.textContent).toBe('Far away change')
  expect(pane.textContent).toContain('alex')
  expect(pane.textContent).toContain('+3')
  expect(pane.textContent).toContain('2 files')
  expect(pane.querySelector('.tasks-pr__description')).toBeNull()
  expect(pane.textContent).not.toContain('Description of')
  expect(button(pane, 'Open pull request #999 on GitHub')).toBeDefined()
})

test('the timeline lists one line per review, newest first', async () => {
  const { element } = await mountExpanded({
    state: prDetailState(),
    handlers: { 'quirky.tasks/mergeMetadata': () => metadata({}, { reviews: [{ author: 'alex', state: 'APPROVED' }, { author: 'sam', state: 'CHANGES_REQUESTED' }, { author: null, state: 'COMMENTED' }] }) }
  })
  const lines = [...detailColumn(element).querySelectorAll('.tasks-pr__timeline li')].map((line) => line.textContent)
  expect(lines).toEqual(['Someone commented', 'sam requested changes', 'alex approved'])
})

test('the timeline is omitted when there are no reviews or they are unknown', async () => {
  for (const reviews of [[], null]) {
    const { element } = await mountExpanded({ state: prDetailState(), handlers: { 'quirky.tasks/mergeMetadata': () => metadata({}, { reviews }) } })
    expect(detailColumn(element).querySelector('.tasks-pr__timeline')).toBeNull()
    expect(detailColumn(element).textContent).not.toContain('Timeline')
    await act(async () => cleanup?.())
    cleanup = null
    document.body.innerHTML = ''
  }
})

test('the body carries data-has-detail for the narrow layout', async () => {
  const closed = await mountExpanded()
  expect(closed.element.querySelector('[data-has-detail]')?.getAttribute('data-has-detail')).toBe('false')
  await act(async () => cleanup?.())
  cleanup = null
  document.body.innerHTML = ''
  const open = await mountExpanded({ state: prDetailState() })
  expect(open.element.querySelector('[data-has-detail]')?.getAttribute('data-has-detail')).toBe('true')
})

test('the detail back button clears the row', async () => {
  const { element, calls } = await mountExpanded({ state: prDetailState() })
  const back = detailColumn(element).querySelector<HTMLButtonElement>('.tasks-list__back')!
  expect(back.getAttribute('aria-label')).toBe('Back to PRs')
  await click(back)
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toEqual({ detail: null })
})

test('there is no back button while no row is open', async () => {
  const { element } = await mountExpanded()
  expect(element.querySelector('.tasks-list__back')).toBeNull()
})

test('selecting a row saves the list scroll, and the list restores it when it shows again', async () => {
  const key = `github\u0000prs\u0000*\u0000is:open\u00001`
  const { element, emit } = await mountExpanded()
  const scroller = element.querySelector<HTMLElement>('.tasks-list__rows')!
  scroller.scrollTop = 120
  await click(rowButtons(element)[0])
  expect(place.scrollTop('expanded', key)).toBe(120)
  scroller.scrollTop = 0
  await click(detailColumn(element).querySelector('.tasks-list__back'))
  await emit({ type: 'quirky.tasks/changed' })
  expect(element.querySelector<HTMLElement>('.tasks-list__rows')!.scrollTop).toBe(120)
})

test('the list restores a scroll position saved for its view on mount', async () => {
  place.setScrollTop('expanded', `github\u0000prs\u0000*\u0000is:open\u00001`, 75)
  const { element } = await mountExpanded()
  expect(element.querySelector<HTMLElement>('.tasks-list__rows')!.scrollTop).toBe(75)
})

test('a pending row focus lands on the selected row once rows render', async () => {
  const { element } = await mountExpanded({ state: prDetailState(275), beforeMount: () => place.requestFocus('row') })
  expect(document.activeElement === rowButtons(element)[1]!).toBe(true)
  expect(place.takeFocus()).toBeNull()
})

test('a pending row focus falls back to the first row when none is selected', async () => {
  const { element } = await mountExpanded({ beforeMount: () => place.requestFocus('row') })
  expect(document.activeElement === rowButtons(element)[0]!).toBe(true)
})

test('a row focus request expires when the expanded list initially returns no rows', async () => {
  let reads = 0
  const { element } = await mountExpanded({
    beforeMount: () => place.requestFocus('row'),
    handlers: { 'quirky.tasks/list': () => ++reads === 1 ? listResult([]) : listResult([pr(274), pr(275)]) }
  })
  expect(rowTitles(element)).toEqual([])
  const refresh = button(element, 'Refresh GitHub work')!
  refresh.focus()
  await click(refresh)
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
  expect(document.activeElement === refresh).toBe(true)
})

test('a row focus request expires when the expanded list initially fails', async () => {
  let reads = 0
  const { element } = await mountExpanded({
    state: withNavigation({ repoIds: ['repo-1'] }),
    beforeMount: () => place.requestFocus('row'),
    handlers: {
      'quirky.tasks/list': () => {
        reads += 1
        if (reads === 1) throw new Error('offline')
        return listResult([pr(274), pr(275)])
      }
    }
  })
  const refresh = button(element, 'Refresh GitHub work')!
  refresh.focus()
  await click(refresh)
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
  expect(document.activeElement === refresh).toBe(true)
})

test('a row focus request does not follow the user to a different list', async () => {
  const { promise: delayedPullList, resolve: finishPullList } = Promise.withResolvers<unknown>()
  const { element } = await mountExpanded({
    beforeMount: () => place.requestFocus('row'),
    handlers: {
      'quirky.tasks/list': (params) => params.mode === 'prs' ? delayedPullList : listResult([issue(281), issue(279)])
    }
  })
  const issuesTab = [...element.querySelectorAll<HTMLElement>('.ui-tool-panel-frame__header [role="tab"]')].find((tab) => tab.textContent?.startsWith('Issues'))!
  issuesTab.focus()
  await click(issuesTab)
  expect(rowTitles(element)).toEqual(['Issue 281', 'Issue 279'])
  await act(async () => finishPullList(listResult([pr(274), pr(275)])))
  await settle()
  expect(document.activeElement === issuesTab).toBe(true)
})

test('unmounting an expanded view cancels its pending row focus', async () => {
  const { element } = await mountExpanded({ beforeMount: () => place.requestFocus('row'), handlers: { 'quirky.tasks/list': pending } })
  expect(element.querySelector('[aria-label="Loading GitHub tasks"]')).not.toBeNull()
  await act(async () => cleanup?.())
  cleanup = null
  document.body.innerHTML = ''
  const reopened = await mountExpanded()
  expect(document.activeElement === rowButtons(reopened.element)[0]).toBe(false)
})

test('the frame has Issues, PRs and Projects tabs with counts on the first two', async () => {
  const { element, calls } = await mountExpanded()
  const tabs = [...element.querySelectorAll<HTMLElement>('.ui-tool-panel-frame__header [role="tab"]')]
  expect(tabs.map((tab) => tab.textContent)).toEqual(['Issues12', 'PRs5', 'Projects'])
  expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
  expect(calls.find((call) => call.method === 'quirky.tasks/counts')?.params).toEqual({ mode: 'prs', query: 'is:open', repoIds: null })
})

test('a count that could not be read is left off its tab', async () => {
  const { element } = await mountExpanded({ handlers: { 'quirky.tasks/counts': () => ({ issues: null, prs: 5 }) } })
  expect([...element.querySelectorAll('.ui-tool-panel-frame__header [role="tab"]')].map((tab) => tab.textContent)).toEqual(['Issues', 'PRs5', 'Projects'])
})

test('a failing counts read leaves every tab without a number', async () => {
  const { element } = await mountExpanded({ handlers: { 'quirky.tasks/counts': () => { throw new Error('offline') } } })
  expect([...element.querySelectorAll('.ui-tool-panel-frame__header [role="tab"]')].map((tab) => tab.textContent)).toEqual(['Issues', 'PRs', 'Projects'])
})

test('mounting calls prepare once', async () => {
  const { calls } = await mountExpanded()
  expect(calls.filter((call) => call.method === 'quirky.tasks/prepare')).toHaveLength(1)
})

test('Collapse is in the frame actions, requests row focus and opens the tool', async () => {
  const { element, calls } = await mountExpanded()
  const collapse = button(element.querySelector('.ui-tool-panel-frame__actions')!, 'Collapse Tasks')!
  expect(collapse.querySelector('svg, .ui-control-icon')).not.toBeNull()
  await click(collapse)
  expect(calls.find((call) => call.method === 'ui.tool.open')?.params).toEqual({ id: TOOL })
  expect(place.takeFocus()).toBe('row')
})

test('the frame has no minimize button and no settings gear', async () => {
  const { element } = await mountExpanded()
  expect(button(element, 'Minimize Tasks')).toBeUndefined()
  expect(button(element.querySelector('.ui-tool-panel-frame__actions')!, 'Task settings')).toBeUndefined()
})

test('the toolbar menu holds Task settings and Open repository in GitHub', async () => {
  const { element, calls, commands } = await mountExpanded()
  expect(element.querySelector('.tasks-list')!.textContent).not.toContain('Open repository in GitHub')
  await click(button(element, 'Tasks options'))
  expect(menuLabels(element)).toEqual(['Task settings', 'Open repository in GitHub'])
  expect(menuItems(element).map((item) => item.disabled)).toEqual([false, false])
  await click(menuItems(element)[1])
  expect(commands).toEqual([{ id: 'command:quirky.tasks/open-link', args: { url: 'https://github.com/acme/quirky' } }])
  await click(button(element, 'Tasks options'))
  await click(menuItems(element)[0])
  expect(calls.find((call) => call.method === 'quirky.tasks/settings')).toBeDefined()
})

test('Open repository in GitHub is disabled unless exactly one project is selected', async () => {
  const second = { ...repository, id: 'repo-2', name: 'other', worktree: 'wt-other' }
  const { element } = await mountExpanded({
    handlers: { 'quirky.tasks/list': () => listResult([pr(274)], { repositories: [repository, second], sources: { 'repo-1': { origin }, 'repo-2': { origin: { ...origin, repo: 'other' } } } }) }
  })
  await click(button(element, 'Tasks options'))
  expect(menuItems(element).find((item) => item.textContent?.trim() === 'Open repository in GitHub')!.disabled).toBe(true)
})

test('the toolbar menu offers the issue source as checked choices and switches it', async () => {
  const sources = { 'repo-1': { status: 'ready', origin, issueSource: 'upstream', issueRepository: upstream, candidates: [origin, upstream] } }
  const { element, calls } = await mountExpanded({
    state: withNavigation(issuesNavigation),
    handlers: { 'quirky.tasks/list': () => listResult([issue(281)], { sources }), 'quirky.tasks/row': () => ({}) }
  })
  await click(button(element, 'Tasks options'))
  expect(menuLabels(element)).toEqual(['Task settings', 'Open repository in GitHub', '✓ Upstream', 'Origin'])
  expect(menuItems(element).slice(2).map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false'])
  await click(menuItems(element)[3])
  expect(calls.find((call) => call.method === 'quirky.tasks/row')?.params).toMatchObject({ action: 'issueSource', preference: 'origin' })
})

test('the issue source choice is not offered on the PRs tab', async () => {
  const sources = { 'repo-1': { status: 'ready', origin, candidates: [origin, upstream] } }
  const { element } = await mountExpanded({ handlers: { 'quirky.tasks/list': () => listResult([pr(274)], { sources }) } })
  await click(button(element, 'Tasks options'))
  expect(menuLabels(element)).toEqual(['Task settings', 'Open repository in GitHub'])
})

test('the expanded repository picker can select a repository and reload that list', async () => {
  const { element, calls } = await mountExpanded({
    state: withNavigation({ repoIds: [] }),
    handlers: { 'quirky.tasks/preferences': () => ({}) }
  })
  const initialReads = calls.filter((call) => call.method === 'quirky.tasks/list').length
  await click(element.querySelector('.tasks-list__repo-picker button'))
  const picker = element.querySelector('[role="group"][aria-label="Select repositories"]')!
  const repositoryChoice = [...picker.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'quirky')!
  const checkbox = repositoryChoice.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(checkbox.checked).toBe(false)
  await click(checkbox)
  expect(calls.filter((call) => call.method === 'quirky.tasks/preferences').at(-1)?.params).toEqual({ defaultRepoSelection: null })
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toMatchObject({ repoIds: null, page: 1 })
  expect(calls.filter((call) => call.method === 'quirky.tasks/list')).toHaveLength(initialReads + 1)
})

test('Escape closes the Filters dialog before clearing the selected row or collapsing', async () => {
  const { element, calls, current } = await mountExpanded({ state: prDetailState() })
  await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  expect(element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).not.toBeNull()
  await press('Escape')
  expect(element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()
  expect(current().navigation.detail).toEqual(target(pr(274)))
  expect(calls.some((call) => call.method === 'quirky.tasks/navigate')).toBe(false)
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(false)
})

test('Escape closes the repository picker before clearing the selected row or collapsing', async () => {
  const { element, calls, current } = await mountExpanded({ state: prDetailState() })
  await click(element.querySelector('.tasks-list__repo-picker button'))
  expect(element.querySelector('[role="group"][aria-label="Select repositories"]')).not.toBeNull()
  await press('Escape')
  expect(element.querySelector('[role="group"][aria-label="Select repositories"]')).toBeNull()
  expect(current().navigation.detail).toEqual(target(pr(274)))
  expect(calls.some((call) => call.method === 'quirky.tasks/navigate')).toBe(false)
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(false)
})



test.each([
  ['reviewers dialog', 'Filters'],
  ['merge menu', 'Filters'],
  ['reviewers dialog', 'repository picker'],
  ['merge menu', 'repository picker']
] as const)('Escape closes the focused %s before the %s list popover', async (detailOverlay, listPopover) => {
  const { element, calls, current } = await mountExpanded({ state: prDetailState() })
  const listPopoverSelector = listPopover === 'Filters'
    ? '[role="dialog"][aria-label="GitHub task filters"]'
    : '[role="group"][aria-label="Select repositories"]'
  if (listPopover === 'Filters') {
    await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  } else {
    await click(element.querySelector('.tasks-list__repo-picker button'))
  }
  expect(element.querySelector(listPopoverSelector) !== null).toBe(true)

  if (detailOverlay === 'reviewers dialog') {
    await click(detailColumn(element).querySelector('button[aria-haspopup="dialog"]'))
    detailColumn(element).querySelector<HTMLTextAreaElement>('textarea[aria-label="Type or choose a reviewer"]')!.focus()
  } else {
    const trigger = button(detailColumn(element), 'Merge actions for PR #274')!
    await click(trigger)
    trigger.focus()
  }
  await press('Escape')

  const detailPopoverSelector = detailOverlay === 'reviewers dialog' ? '[role="dialog"]' : '[role="menu"]'
  expect(detailColumn(element).querySelector(detailPopoverSelector) === null).toBe(true)
  expect(element.querySelector(listPopoverSelector) !== null).toBe(true)
  expect(current().navigation.detail).toEqual(target(pr(274)))
  expect(calls.some((call) => call.method === 'quirky.tasks/navigate')).toBe(false)
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(false)
})
test('Escape does nothing to the row or the tab while a menu is open', async () => {
  const { element, calls } = await mountExpanded({ state: prDetailState() })
  await click(button(element, 'Tasks options'))
  await press('Escape')
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(false)
  expect(calls.some((call) => call.method === 'quirky.tasks/navigate')).toBe(false)
})

test('Escape blurs a focused field before it clears the row or collapses', async () => {
  const { element, calls } = await mountExpanded({ state: prDetailState() })
  const search = element.querySelector<HTMLInputElement>('[data-tasks-search]')!
  search.focus()
  expect(document.activeElement === search).toBe(true)
  await press('Escape')
  expect(document.activeElement === search).toBe(false)
  expect(calls.some((call) => call.method === 'quirky.tasks/navigate')).toBe(false)
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(false)
})

test('Escape clears the open row, and a second Escape collapses', async () => {
  const { calls } = await mountExpanded({ state: prDetailState() })
  await press('Escape')
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toEqual({ detail: null })
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(false)
  await press('Escape')
  expect(calls.find((call) => call.method === 'ui.tool.open')?.params).toEqual({ id: TOOL })
})

test('Escape with no row open collapses to the panel', async () => {
  const { calls } = await mountExpanded()
  await press('Escape')
  expect(calls.find((call) => call.method === 'ui.tool.open')?.params).toEqual({ id: TOOL })
  expect(place.takeFocus()).toBe('row')
})

test('Projects keeps its table, board and roadmap reachable and returns after Collapse', async () => {
  const { element, calls, current } = await mountExpanded({
    state: withNavigation({ mode: 'projects', project: projectTarget }),
    handlers: projectHandlers
  })
  const projectTabs = [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
  expect(element.querySelector('.tasks-list')).toBeNull()
  expect(element.querySelector('.quirky-tasks-project-table tbody tr')?.textContent).toContain('Improve project table')

  await click(projectTabs.find((tab) => tab.textContent?.trim() === 'Board · Board')!)
  expect(element.querySelector('.quirky-tasks-project-board select[aria-label="Move Improve project table"]')).not.toBeNull()
  await click(projectTabs.find((tab) => tab.textContent?.trim() === 'Roadmap · Roadmap')!)
  expect(element.querySelector('.quirky-tasks-project-roadmap [role="img"]')).not.toBeNull()

  await click(button(element, 'Collapse Tasks'))
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(true)
  expect(current().navigation.mode).toBe('projects')
  await act(async () => cleanup?.())
  cleanup = null
  document.body.innerHTML = ''

  const reopened = await mountExpanded({ state: current(), handlers: projectHandlers })
  expect([...reopened.element.querySelectorAll('.ui-tool-panel-frame__header [role="tab"]')].find((tab) => tab.textContent?.trim() === 'Projects')?.getAttribute('aria-selected')).toBe('true')
  expect(reopened.element.querySelector('.quirky-tasks-projects__toolbar')).not.toBeNull()
})

test('an issue detail while Projects is selected fills the whole area, as it did before', async () => {
  const { element } = await mountExpanded({ state: withNavigation({ mode: 'projects', detail: target(issue(281)) }) })
  expect(element.querySelector('.tasks-list')).toBeNull()
  expect(element.querySelector('.quirky-tasks-issue')).not.toBeNull()
})

test('pagination and the toolbar controls still work beside the detail', async () => {
  const { element, calls } = await mountExpanded({ handlers: { 'quirky.tasks/list': () => listResult([pr(274), pr(275)], { totalPages: 3 }) } })
  const pagination = element.querySelector('nav[aria-label="GitHub task pagination"]')!
  await click(button(pagination, 'Next page'))
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toEqual({ page: 2, scrollTop: 0 })
  expect(button(element, 'Refresh GitHub work')).toBeDefined()
  expect(element.querySelector('[aria-label="Task presets"]')).not.toBeNull()
  expect([...element.querySelectorAll('button')].some((candidate) => candidate.textContent?.startsWith('Filters'))).toBe(true)
})

test('an edit made in the issue pane reloads the list so the row follows it', async () => {
  const { element, calls } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, detail: target(issue(281)) }),
    handlers: { 'quirky.tasks/issueEdit': () => ({ item: { ...issue(281), state: 'closed' } }) }
  })
  const select = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  const before = calls.filter((call) => call.method === 'quirky.tasks/list').length
  await act(async () => {
    select.value = 'closed-completed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(calls.find((call) => call.method === 'quirky.tasks/issueEdit')?.params).toEqual({ state: 'closed', stateReason: 'completed' })
  const reloads = calls.filter((call) => call.method === 'quirky.tasks/list').slice(before)
  expect(reloads.map((call) => call.params.noCache)).toEqual([true])
})

const tabLabels = (element: HTMLElement) => [...element.querySelectorAll('.ui-tool-panel-frame__header [role="tab"]')].map((tab) => tab.textContent)
const countReads = (calls: Mounted['calls']) => calls.filter((call) => call.method === 'quirky.tasks/counts').length

test('Escape closes the open merge menu and returns focus to its trigger, without touching the row or the tab', async () => {
  const { element, calls } = await mountExpanded({ state: prDetailState() })
  const trigger = button(detailColumn(element), 'Merge actions for PR #274')!
  await click(trigger)
  expect(detailColumn(element).querySelector('[role="menu"]')).not.toBeNull()
  await press('Escape')
  expect(detailColumn(element).querySelector('[role="menu"]')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement === trigger).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.tasks/navigate')).toBe(false)
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(false)
  await press('Escape')
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toEqual({ detail: null })
})

test('Escape closes the reviewers dialog from inside its text box and returns focus to its trigger', async () => {
  const { element, calls } = await mountExpanded({ state: prDetailState() })
  const trigger = detailColumn(element).querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  await click(trigger)
  const box = detailColumn(element).querySelector<HTMLTextAreaElement>('textarea[aria-label="Type or choose a reviewer"]')!
  box.focus()
  await press('Escape')
  expect(detailColumn(element).querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement === trigger).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.tasks/navigate')).toBe(false)
  expect(calls.some((call) => call.method === 'ui.tool.open')).toBe(false)
  await press('Escape')
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toEqual({ detail: null })
})

test('Escape with the merge menu and the reviewers dialog both open closes the one that has focus first', async () => {
  const { element } = await mountExpanded({ state: prDetailState() })
  const mergeTrigger = button(detailColumn(element), 'Merge actions for PR #274')!
  const reviewersTrigger = detailColumn(element).querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  await click(reviewersTrigger)
  await click(mergeTrigger)
  mergeTrigger.focus()
  await press('Escape')
  expect(detailColumn(element).querySelector('[role="menu"]')).toBeNull()
  expect(detailColumn(element).querySelector('[role="dialog"]')).not.toBeNull()
  await press('Escape')
  expect(detailColumn(element).querySelector('[role="dialog"]')).toBeNull()
})

test('Copy link in the PR detail copies the pull request URL through the copy-link command', async () => {
  const { element, commands } = await mountExpanded({ state: prDetailState() })
  await click(button(detailColumn(element), 'Copy link'))
  expect(commands).toEqual([{ id: 'command:quirky.tasks/copy-link', args: { url: 'https://github.com/acme/quirky/pull/274' } }])
})

test('Refresh reads the tab counts again', async () => {
  let prs = 5
  const { element, calls } = await mountExpanded({ handlers: { 'quirky.tasks/counts': () => ({ issues: 12, prs }) } })
  const before = countReads(calls)
  prs = 6
  await click(button(element, 'Refresh GitHub work'))
  expect(countReads(calls)).toBe(before + 1)
  expect(tabLabels(element)).toEqual(['Issues12', 'PRs6', 'Projects'])
})

test('a successful merge reads the tab counts again, and a failed one does not', async () => {
  let prs = 5
  let fail = true
  const { element, calls } = await mountExpanded({
    state: prDetailState(),
    handlers: {
      'quirky.tasks/counts': () => ({ issues: 12, prs }),
      'quirky.tasks/row': () => { if (fail) throw new Error('merge rejected'); return { kind: 'merged' } }
    }
  })
  const before = countReads(calls)
  await click(button(detailColumn(element), 'Merge actions for PR #274'))
  await click(menuItems(detailColumn(element))[0])
  expect(countReads(calls)).toBe(before)
  fail = false
  prs = 4
  await click(button(detailColumn(element), 'Merge actions for PR #274'))
  await click(menuItems(detailColumn(element))[0])
  expect(countReads(calls)).toBeGreaterThan(before)
  expect(tabLabels(element)).toEqual(['Issues12', 'PRs4', 'Projects'])
})

test('an issue status edit from the pane reads the tab counts again', async () => {
  const { element, calls } = await mountExpanded({
    state: withNavigation({ ...issuesNavigation, detail: target(issue(281)) }),
    handlers: { 'quirky.tasks/issueEdit': () => ({ item: { ...issue(281), state: 'closed' } }) }
  })
  const before = countReads(calls)
  const select = detailColumn(element).querySelector<HTMLSelectElement>('select[aria-label="Issue status"]')!
  await act(async () => {
    select.value = 'closed-completed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(countReads(calls)).toBeGreaterThan(before)
})

test('a counts read that a newer one superseded does not overwrite it', async () => {
  const pending: ((value: unknown) => void)[] = []
  let reads = 0
  const { element } = await mountExpanded({
    handlers: { 'quirky.tasks/counts': () => { reads += 1; return reads === 1 ? new Promise((resolve) => pending.push(resolve)) : { issues: 12, prs: 7 } } }
  })
  await click(button(element, 'Refresh GitHub work'))
  expect(tabLabels(element)).toEqual(['Issues12', 'PRs7', 'Projects'])
  await act(async () => pending[0]!({ issues: 1, prs: 1 }))
  await settle()
  expect(tabLabels(element)).toEqual(['Issues12', 'PRs7', 'Projects'])
})

const prsKey = ['github', 'prs', '*', 'is:open', 1].join('\u0000')

async function seedSnapshot(items: unknown[], extra: { merge?: Record<string, unknown> } = {}) {
  const { parseListResult } = await import('../src/list/model')
  place.setListSnapshot(prsKey, { list: parseListResult(listResult(items))!, checks: {}, merge: (extra.merge ?? {}) as never })
}

const pending = () => new Promise(() => {})

test('mounting with a snapshot shows its rows with no skeleton and still reads the list', async () => {
  await seedSnapshot([pr(274), pr(275)])
  const { element, calls } = await mountExpanded({ handlers: { 'quirky.tasks/list': pending } })
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
  expect(element.querySelector('[aria-label="Loading GitHub tasks"]')).toBeNull()
  expect(calls.filter((call) => call.method === 'quirky.tasks/list')).toHaveLength(1)
})

test('the list read replaces a snapshot without skeletons', async () => {
  await seedSnapshot([pr(274)])
  const { element } = await mountExpanded({ handlers: { 'quirky.tasks/list': () => listResult([pr(274), pr(280)]) } })
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 280'])
  expect(element.querySelector('[aria-label="Loading GitHub tasks"]')).toBeNull()
})

test('without a snapshot the list shows skeletons while it loads', async () => {
  const { element } = await mountExpanded({ handlers: { 'quirky.tasks/list': pending } })
  expect(element.querySelector('[aria-label="Loading GitHub tasks"]')).not.toBeNull()
})

test('a snapshot restores the open row, its highlight and focus on the first render', async () => {
  await seedSnapshot([pr(274), pr(275)])
  const { element } = await mountExpanded({ state: prDetailState(275), beforeMount: () => place.requestFocus('row'), handlers: { 'quirky.tasks/list': pending } })
  expect([...element.querySelectorAll('.tasks-list__list .ui-list-row')].map((row) => row.classList.contains('ui-list-row--selected'))).toEqual([false, true])
  expect(document.activeElement === rowButtons(element)[1]!).toBe(true)
})

test('merge metadata from a snapshot is read again, and merging waits for the fresh read', async () => {
  const key = ['wt-main', 'pullRequest', 274, 'https://github.com/acme/quirky/pull/274'].join('\u0000')
  await seedSnapshot([pr(274)], { merge: { [key]: metadata() } })
  const { element, calls, confirms } = await mountExpanded({ state: prDetailState(), handlers: { 'quirky.tasks/mergeMetadata': pending, 'quirky.tasks/row': () => ({ kind: 'merged' }) } })
  expect(calls.filter((call) => call.method === 'quirky.tasks/mergeMetadata' && (call.params.target as { number: number }).number === 274)).toHaveLength(1)
  await click(button(detailColumn(element), 'Merge actions for PR #274'))
  await click(menuItems(detailColumn(element))[0])
  expect(confirms).toEqual([])
  expect(calls.some((call) => call.method === 'quirky.tasks/row')).toBe(false)
})


test('auto-merge stays guarded while its metadata comes from a snapshot', async () => {
  const key = ['wt-main', 'pullRequest', 274, 'https://github.com/acme/quirky/pull/274'].join('\u0000')
  await seedSnapshot([pr(274)], { merge: { [key]: metadata() } })
  const { element, calls } = await mountExpanded({
    state: prDetailState(),
    handlers: { 'quirky.tasks/mergeMetadata': pending, 'quirky.tasks/row': () => ({ kind: 'enabled' }) }
  })
  const pane = detailColumn(element)
  await click(button(pane, 'Merge actions for PR #274'))
  const enableAutoMerge = menuItems(pane).find((item) => item.textContent?.trim() === 'Enable auto-merge')!
  await click(enableAutoMerge)
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('Merge metadata is refreshing. Try again in a moment.')
  expect(calls.some((call) => call.method === 'quirky.tasks/row')).toBe(false)
})

test('a loaded list is saved as the snapshot for its view key', async () => {
  const { element } = await mountExpanded()
  expect(rowTitles(element)).toHaveLength(2)
  expect(place.listSnapshot(prsKey)?.list.items.map((item) => item.number)).toEqual([274, 275])
})

test('a pull request with no row and no metadata yet shows one loading line and no controls', async () => {
  const { element } = await mountExpanded({ state: withNavigation({ detail: target(pr(276)) }), handlers: { 'quirky.tasks/mergeMetadata': pending } })
  const pane = detailColumn(element)
  expect(pane.querySelector('[role="status"]')?.textContent).toBe('Loading pull request…')
  expect(pane.textContent).not.toContain('unknown')
  expect(pane.textContent).not.toContain('Pull request #276 ')
  expect(pane.querySelector('h2')).toBeNull()
  expect(pane.querySelector('.ui-badge')).toBeNull()
  expect(button(pane, 'Review')).toBeUndefined()
  expect(pane.querySelector('[aria-haspopup]')).toBeNull()
})

test('a pull request whose state is not known yet shows no state badge', async () => {
  const { element } = await mountExpanded({
    state: prDetailState(),
    handlers: { 'quirky.tasks/list': () => listResult([pr(274, { state: 'unknown' })]), 'quirky.tasks/mergeMetadata': pending }
  })
  const pane = detailColumn(element)
  expect(pane.querySelector('h2')?.textContent).toBe('Pull request 274')
  expect(pane.textContent).not.toContain('unknown')
})

test('a pull request that could not be loaded says so and offers Retry', async () => {
  const { element } = await mountExpanded({ state: withNavigation({ detail: target(pr(276)) }), handlers: { 'quirky.tasks/mergeMetadata': () => { throw new Error('GitHub is down') } } })
  const pane = detailColumn(element)
  expect(pane.textContent).toContain('Could not load pull request #276: GitHub is down')
  expect(button(pane, 'Retry')).toBeDefined()
  expect(button(pane, 'Review')).toBeUndefined()
})
