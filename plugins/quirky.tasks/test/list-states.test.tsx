import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import type { ItemTarget, TasksState } from '../src/contracts'

type Mount = (element: HTMLElement, props: { report?: (state: unknown) => void }) => () => void
type Handler = (params: Record<string, unknown>) => unknown
type UiEvent = { type: string; [key: string]: unknown }
type Mounted = {
  element: HTMLElement
  calls: { method: string; params: Record<string, unknown> }[]
  toasts: string[]
  provided: Map<string, unknown>
  current(): TasksState
  connection(status: 'connected' | 'reconnecting'): Promise<void>
  mountAnother(): Promise<HTMLElement>
  unmount(element: HTMLElement): Promise<void>
  callProvided(id: string, input: unknown): unknown
}

let act: (callback: () => unknown) => Promise<void>
let activate: (context: UiPluginContext) => void
let place: typeof import('../src/list/place').place
let snapshotLimit: number
let cleanups: (() => void)[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
  const placeModule = await import('../src/list/place')
  place = placeModule.place
  snapshotLimit = placeModule.LIST_SNAPSHOT_LIMIT
})

function flushSnapshots() {
  const empty = { list: { items: [], repositories: [], page: 1, totalPages: 1, perRepo: 0, failures: [], sources: {} }, checks: {}, merge: {} }
  for (let index = 0; index < snapshotLimit; index++) place.setListSnapshot(`flush-${index}`, empty)
}

afterEach(async () => {
  await act(async () => { while (cleanups.length > 0) cleanups.pop()?.() })
  cleanups = []
  document.body.innerHTML = ''
  place.takeFocus()
  flushSnapshots()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const VIEW = 'view:quirky.tasks/tasks'
const LIST_CONTROL = 'command:quirky.tasks/list-control'

const prsState: TasksState = {
  revision: 1,
  navigation: { source: 'github', mode: 'prs', repoIds: null, query: 'is:open', page: 1, scrollTop: 0, detail: null, newIssue: false, project: null, lastList: { mode: 'prs', query: 'is:open', page: 1 } },
  preferences: { showTasksButton: true, visibleTaskProviders: ['github'], defaultTaskSource: 'github', defaultTaskViewPreset: 'open', defaultRepoSelection: null },
  issueDraft: { title: '', body: '', labels: [], assignees: [], repoId: null },
  projects: { pinned: [], recent: [], lastViewByProject: {}, queryByView: {}, hiddenColumns: {}, columnWidths: {}, roadmapZoom: 'month' },
  links: {}
}

function withNavigation(patch: Partial<TasksState['navigation']>): TasksState {
  return { ...prsState, navigation: { ...prsState.navigation, ...patch } }
}

const repository = { id: 'repo-1', name: 'quirky', path: '/work/quirky', kind: 'git', worktree: 'wt-main', displayName: null }
const secondRepository = { id: 'repo-2', name: 'other', path: '/work/other', kind: 'git', worktree: 'wt-other', displayName: null }
const origin = { host: 'github.com', owner: 'acme', repo: 'quirky' }

function pr(number: number, patch: Record<string, unknown> = {}) {
  return {
    kind: 'pullRequest', number, title: `Pull request ${number}`, body: `Description of ${number}`, state: 'open', url: `https://github.com/acme/quirky/pull/${number}`,
    createdAt: null, updatedAt: '2026-11-14T00:00:00.000Z', author: 'sam', labels: [], assignees: [], isDraft: false,
    worktree: 'wt-main', repoId: 'repo-1', repoName: 'quirky', headRefName: 'fix/list', baseRefName: 'main', additions: 4, deletions: 1, changedFiles: 1, ...patch
  }
}

function listResult(items: unknown[], patch: Record<string, unknown> = {}) {
  return { items, repositories: [repository], page: 1, totalPages: 1, perRepo: 20, failures: [], sources: { 'repo-1': { status: 'ready', origin } }, ...patch }
}

function detailTarget(number: number): ItemTarget {
  return { worktree: 'wt-main', kind: 'pullRequest', number, url: `https://github.com/acme/quirky/pull/${number}` }
}

function hold<T>() {
  return Promise.withResolvers<T>()
}

async function settle(milliseconds = 20) {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  await act(async () => promise)
}

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error('expected a rendered control')
  await act(async () => element.click())
  await settle()
}

async function press(key: string) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  await settle()
}

function button(root: ParentNode, label: string) {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label)
}

function rowTitles(root: ParentNode) {
  return [...root.querySelectorAll('.tasks-list__list .ui-list-row__title')].map((node) => node.textContent)
}

function inlineMessages(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>('.ui-inline-error__message')].map((node) => node.textContent)
}

function noticeTexts(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>('.ui-notice-line__text')].map((node) => node.textContent)
}

async function mountList(options: { state?: TasksState; handlers?: Record<string, Handler> } = {}): Promise<Mounted> {
  const provided = new Map<string, unknown>()
  const mountedCleanups = new Map<HTMLElement, () => void>()
  const calls: Mounted['calls'] = []
  const toasts: string[] = []
  const listeners = new Set<(event: UiEvent) => void>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  let state = options.state ?? prsState
  const current = () => state
  const defaultHandlers: Record<string, Handler> = {
    'quirky.tasks/prepare': () => current(),
    'quirky.tasks/state': () => current(),
    'quirky.tasks/navigate': (params) => {
      state = { ...state, revision: state.revision + 1, navigation: { ...state.navigation, ...params } as TasksState['navigation'] }
      for (const listener of listeners) listener({ type: 'quirky.tasks/changed' })
      return state
    },
    'quirky.tasks/list': (params) => params.mode === 'issues' ? listResult([]) : listResult([pr(274), pr(275)]),
    'quirky.tasks/counts': () => ({ issues: 2, prs: 2 }),
    'quirky.tasks/checks': () => ({ rollup: 'success', checks: [], partial: false, partialFailures: [] }),
    'quirky.tasks/mergeMetadata': () => ({ review: { requestedReviewers: ['zach'], reviews: [], assignees: [] }, mergeMetadataKnown: true }),
    'quirky.tasks/options': (params) => params.kind === 'labels' ? { labels: [] } : params.kind === 'assignees' ? { assignees: [] } : { recentlyActive: [], suggestions: [] },
    'quirky.tasks/projectView': () => ({ views: [] }),
    'quirky.hosting/viewer': () => ({ login: 'zach' }),
    'ui.window.self': () => ({ connId: 7 }),
    'ui.window.command.run': async (params) => {
      const implementation = provided.get(String(params.id))
      if (typeof implementation !== 'function') throw new Error('offline')
      return { result: await (implementation as (args: unknown) => unknown)(params.args) }
    },
    ...options.handlers
  }
  const context = {
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = defaultHandlers[method]
      if (!handler) throw new Error('offline')
      return handler(params)
    },
    subscribe: (listener: (event: UiEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onConnection: (listener: (status: 'connected' | 'reconnecting') => void) => { connectionListeners.add(listener); return () => connectionListeners.delete(listener) },
    toast: (title: string) => void toasts.push(title),
    confirm: async () => true,
    executeCommand: async () => undefined,
    openView: () => undefined
  } as unknown as UiPluginContext
  activate(context)

  const mountOne = async () => {
    const mount = provided.get(VIEW)
    if (typeof mount !== 'function') throw new Error('Tasks view was not provided')
    const element = document.createElement('div')
    document.body.append(element)
    let unmount: () => void = () => undefined
    await act(async () => { unmount = (mount as Mount)(element, {}) })
    mountedCleanups.set(element, unmount)
    cleanups.push(unmount)
    await settle()
    return element
  }
  const unmount = async (element: HTMLElement) => {
    const cleanup = mountedCleanups.get(element)
    if (!cleanup) return
    mountedCleanups.delete(element)
    const cleanupIndex = cleanups.indexOf(cleanup)
    if (cleanupIndex >= 0) cleanups.splice(cleanupIndex, 1)
    await act(async () => cleanup())
    element.remove()
  }
  const element = await mountOne()
  return {
    element,
    calls,
    toasts,
    provided,
    current,
    async connection(status) {
      await act(async () => { for (const listener of connectionListeners) listener(status) })
      await settle()
    },
    mountAnother: mountOne,
    unmount,
    callProvided(id, input) {
      const implementation = provided.get(id)
      if (typeof implementation !== 'function') throw new Error(`Command ${id} was not provided`)
      return (implementation as (value: unknown) => unknown)(input)
    }
  }
}

test('the list loading skeleton includes its shared loading notice', async () => {
  const pending = hold<unknown>().promise
  const { element } = await mountList({ handlers: { 'quirky.tasks/list': () => pending } })
  const loading = element.querySelector<HTMLElement>('.tasks-list__loading')!
  expect(loading.getAttribute('role')).toBe('status')
  expect(loading.getAttribute('aria-label')).toBe('Loading GitHub tasks')
  expect(loading.firstElementChild?.matches('.ui-notice-line')).toBe(true)
  expect(loading.querySelector('.ui-notice-line__text')?.textContent).toBe('Loading GitHub tasks…')
  expect(loading.querySelectorAll('.tasks-list__skeleton-row')).toHaveLength(12)
  expect(element.querySelector('.tasks-list .ui-inline-error')).toBeNull()
})

test('a first list failure has one retryable blocking error and a successful retry replaces it', async () => {
  for (const repoIds of [null, ['repo-1']]) {
    let recovered = false
    const mounted = await mountList({
      state: withNavigation({ repoIds }),
      handlers: { 'quirky.tasks/list': () => {
        if (!recovered) throw new Error('GitHub CLI is not signed in.')
        return listResult([pr(274), pr(275)])
      } }
    })
    const { element, calls } = mounted
    const rows = element.querySelector('.tasks-list__rows')!
    expect(rows.querySelectorAll('.ui-inline-error')).toHaveLength(1)
    expect(inlineMessages(rows)).toEqual(['GitHub CLI is not signed in.'])
    expect(rows.querySelector('.ui-inline-error__action')?.textContent?.trim()).toBe('Retry')
    expect(rows.querySelector('.ui-empty-state, .tasks-list__skeleton-row')).toBeNull()
    expect(element.querySelectorAll('.tasks-list [role="alert"]')).toHaveLength(1)
    expect(element.querySelector('[aria-label="Task source context"]')?.textContent).toMatch(/^GitHub · [^·]+ · Projects not loaded$/u)
    recovered = true
    await click(rows.querySelector('.ui-inline-error__action'))
    const listCalls = calls.filter((call) => call.method === 'quirky.tasks/list')
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1]?.params.noCache).toBe(true)
    expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
    expect(element.querySelector('.ui-inline-error')).toBeNull()
  }
})

test('a failed refresh keeps rows and offers an advisory retry without an alert', async () => {
  let fail = false
  const { element, calls } = await mountList({ handlers: { 'quirky.tasks/list': () => {
    if (fail) throw new Error('GitHub timed out.')
    return listResult([pr(274), pr(275)])
  } } })
  fail = true
  await click(button(element, 'Refresh GitHub work'))
  expect(rowTitles(element)).toEqual(['Pull request 274', 'Pull request 275'])
  const controls = element.querySelector('.tasks-list__controls')!
  expect(noticeTexts(controls)).toEqual(["Couldn't refresh GitHub tasks. Showing the last loaded results. GitHub timed out."])
  expect(controls.querySelector('.ui-notice-line__action')?.textContent?.trim()).toBe('Retry')
  expect(element.querySelector('.tasks-list [role="alert"]')).toBeNull()
  const beforeRetry = calls.filter((call) => call.method === 'quirky.tasks/list').length
  await click(controls.querySelector('.ui-notice-line__action'))
  expect(calls.filter((call) => call.method === 'quirky.tasks/list')).toHaveLength(beforeRetry + 1)
})

test('an action error has only its original message even while rows remain visible', async () => {
  const { element } = await mountList({ handlers: { 'quirky.tasks/navigate': () => { throw new Error('boom') } } })
  const search = element.querySelector<HTMLInputElement>('[data-tasks-search]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set!
  await act(async () => {
    setter.call(search, 'is:open a')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await settle()
  expect(search.value).toBe('is:open a')
  expect(element.querySelectorAll('.tasks-list .ui-inline-error')).toHaveLength(1)
  expect(inlineMessages(element.querySelector('.tasks-list')!)).toEqual(['boom'])
  expect(noticeTexts(element)).not.toContain('boom')
})

test('an all-unavailable source result renders exactly one retryable error', async () => {
  for (const [failures, expected] of [
    [[{ repoId: 'repo-1', stage: 'source', reason: 'unavailable', message: 'gh is not authenticated' }], 'gh is not authenticated'],
    [[], 'GitHub source is unavailable. Check that gh is installed and authenticated, then refresh.']
  ] as const) {
    const { element } = await mountList({ handlers: { 'quirky.tasks/list': () => listResult([], {
      sources: { 'repo-1': { status: 'unavailable', origin } }, failures
    }) } })
    const errors = element.querySelectorAll('.tasks-list [role="alert"]')
    expect(errors).toHaveLength(1)
    expect(element.querySelector('.tasks-list__controls .ui-inline-error__message')?.textContent).toBe(expected)
    expect(element.querySelector('.tasks-list__controls .ui-inline-error__action')?.textContent?.trim()).toBe('Retry')
  }
})

test('a no-row partial read failure renders one blocking error with a retry', async () => {
  const repositories = [repository, secondRepository]
  const { element, calls } = await mountList({ handlers: { 'quirky.tasks/list': () => listResult([], {
    repositories,
    sources: { 'repo-1': { status: 'ready', origin }, 'repo-2': { status: 'ready', origin: { ...origin, repo: 'other' } } },
    failures: [{ repoId: 'repo-2', stage: 'search', reason: 'rate_limited', message: 'rate limited' }]
  }) } })
  const rows = element.querySelector('.tasks-list__rows')!
  expect(rows.querySelectorAll('.ui-inline-error')).toHaveLength(1)
  expect(inlineMessages(rows)).toEqual(['GitHub data is temporarily unavailable. Its API may be down, rate-limited, or unreachable.'])
  expect(rows.querySelector('.ui-inline-error__action')?.textContent?.trim()).toBe('Retry')
  const before = calls.filter((call) => call.method === 'quirky.tasks/list').length
  await click(rows.querySelector('.ui-inline-error__action'))
  expect(calls.filter((call) => call.method === 'quirky.tasks/list')).toHaveLength(before + 1)
})

test('partial failures keep available rows and use actionable and informational notices', async () => {
  const repositories = [repository, secondRepository]
  const sources = { 'repo-1': { status: 'ready', origin }, 'repo-2': { status: 'ready', origin: { ...origin, repo: 'other' } } }
  const { element } = await mountList({ handlers: { 'quirky.tasks/list': () => listResult([pr(274)], {
    repositories, sources,
    failures: [{ repoId: 'repo-2', stage: 'search', reason: 'rate_limited', message: 'rate limited' }]
  }) } })
  const controls = element.querySelector('.tasks-list__controls')!
  expect(rowTitles(element)).toEqual(['Pull request 274'])
  expect(noticeTexts(controls)).toEqual([
    '1 selected source read failed. Showing available GitHub work; retry to reload.',
    'repo-2: rate limited'
  ])
  expect(controls.querySelectorAll('.ui-notice-line')).toHaveLength(2)
  expect(controls.querySelectorAll('.ui-notice-line__action')).toHaveLength(1)
  expect(controls.querySelector('.ui-notice-line__action')?.textContent?.trim()).toBe('Retry')
  expect(element.querySelector('.tasks-list [role="alert"]')).toBeNull()
})

test('count failures show a continuation advisory without a retry action', async () => {
  const { element } = await mountList({ handlers: { 'quirky.tasks/list': () => listResult([pr(274)], {
    repositories: [repository, secondRepository],
    sources: { 'repo-1': { status: 'ready', origin }, 'repo-2': { status: 'ready', origin } },
    failures: [{ repoId: 'repo-1', stage: 'count', reason: 'count', message: 'x' }]
  }) } })
  const controls = element.querySelector('.tasks-list__controls')!
  expect(noticeTexts(controls)[0]).toBe('1 result count unavailable. Full pages offer a continuation.')
  expect(controls.querySelector('.ui-notice-line__action')).toBeNull()
  expect(rowTitles(element)).toEqual(['Pull request 274'])
})

test('missing GitHub origins are an informational failure notice', async () => {
  const { element } = await mountList({ handlers: { 'quirky.tasks/list': () => listResult([pr(274)], {
    repositories: [repository, secondRepository],
    sources: { 'repo-1': { status: 'ready', origin }, 'repo-2': { status: 'ready', origin: { ...origin, repo: 'other' } } },
    failures: [{ repoId: 'repo-2', stage: 'source', reason: 'missing_origin', message: 'missing remote' }]
  }) } })
  expect(noticeTexts(element.querySelector('.tasks-list__controls')!)).toContain('No GitHub source detected for repo-2 — it may have no GitHub remote.')
  expect(rowTitles(element)).toEqual(['Pull request 274'])
})

test('an empty repository inventory uses the shared empty state', async () => {
  const { element } = await mountList({ handlers: { 'quirky.tasks/list': () => listResult([], { repositories: [], sources: {} }) } })
  const rows = element.querySelector('.tasks-list__rows')!
  expect(rows.querySelectorAll('[role="status"] .ui-empty-state')).toHaveLength(1)
  expect(rows.querySelector('.ui-empty-state')?.textContent).toBe('No eligible Git repositories. Add or select a registered Git repository with a local path to load GitHub tasks.')
})

test('a query with no matching work offers the default query as Reset query', async () => {
  const { element, calls } = await mountList({
    state: withNavigation({ query: 'is:open author:sam' }),
    handlers: { 'quirky.tasks/list': () => listResult([]) }
  })
  const empty = element.querySelector('.tasks-list__rows .ui-empty-state')!
  expect(empty.querySelector('.ui-empty-state__message')?.textContent).toBe('No matching GitHub work. Change the query or clear it.')
  expect(button(empty, 'Reset query')).not.toBeNull()
  await click(button(empty, 'Reset query'))
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toEqual({ page: 1, scrollTop: 0, query: 'is:open' })
})

test('an unselected detail column uses the shared Select a task empty state', async () => {
  const { element } = await mountList()
  expect(element.querySelector('.tasks-list__detail .ui-empty-state')?.textContent).toBe('Select a task')
})

test('the Filters dialog shows loading while its repository label and assignee reads are pending', async () => {
  const labels = hold<unknown>()
  const assignees = hold<unknown>()
  const { element } = await mountList({
    state: withNavigation({ repoIds: ['repo-1'] }),
    handlers: { 'quirky.tasks/options': (params) => params.kind === 'labels' ? labels.promise : assignees.promise }
  })
  await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  const dialog = element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')!
  expect(noticeTexts(dialog)).toEqual(['Loading repository labels and assignees…'])
  expect(dialog.textContent).not.toContain('No labels loaded.')
})

test('a failed Filters options read is an advisory whose Retry reloads both lists', async () => {
  const { element, calls } = await mountList({
    state: withNavigation({ repoIds: ['repo-1'] }),
    handlers: { 'quirky.tasks/options': (params) => {
      if (params.kind === 'labels') throw new Error('gh failed')
      return { assignees: [] }
    } }
  })
  await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  const dialog = element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')!
  expect(noticeTexts(dialog)).toEqual(['Repository labels and assignees could not be loaded. Showing values from loaded tasks. gh failed'])
  expect(dialog.querySelector('.ui-notice-line__action')?.textContent?.trim()).toBe('Retry')
  expect(dialog.querySelector('[role="alert"]')).toBeNull()
  const before = calls.filter((call) => call.method === 'quirky.tasks/options').length
  await click(dialog.querySelector('.ui-notice-line__action'))
  const retried = calls.filter((call) => call.method === 'quirky.tasks/options').slice(before)
  expect(retried).toHaveLength(2)
  expect(retried.map((call) => call.params.kind).sort()).toEqual(['assignees', 'labels'])
})

test('empty loaded label options use EmptyState only after loading ends', async () => {
  const { element } = await mountList({
    state: withNavigation({ repoIds: ['repo-1'] }),
    handlers: { 'quirky.tasks/options': (params) => params.kind === 'labels' ? { labels: [] } : { assignees: [] } }
  })
  await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  const dialog = element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')!
  expect(dialog.querySelector('.ui-empty-state')?.textContent).toBe('No labels loaded.')
  expect(noticeTexts(dialog)).toEqual([])
})

test('repository labels appear as choices instead of an empty state', async () => {
  const { element } = await mountList({
    state: withNavigation({ repoIds: ['repo-1'] }),
    handlers: { 'quirky.tasks/options': (params) => params.kind === 'labels' ? { labels: ['bug'] } : { assignees: [] } }
  })
  await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  const dialog = element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')!
  expect([...dialog.querySelectorAll('label')].some((label) => label.textContent?.trim() === 'bug')).toBe(true)
  expect(dialog.querySelector('.ui-empty-state')).toBeNull()
})

test.each(['resolve', 'reject'] as const)('an older reviewer read that %ss cannot replace newer suggestions', async (outcome) => {
  const first = hold<unknown>()
  const second = hold<unknown>()
  let reviewerReads = 0
  const { element } = await mountList({
    state: withNavigation({ detail: detailTarget(274) }),
    handlers: {
      'quirky.tasks/mergeMetadata': () => ({ review: { requestedReviewers: ['zach'] }, mergeMetadataKnown: true }),
      'quirky.tasks/options': (params) => {
        if (params.kind !== 'reviewers') return params.kind === 'labels' ? { labels: [] } : { assignees: [] }
        reviewerReads += 1
        return reviewerReads === 1 ? first.promise : second.promise
      }
    }
  })
  const reviewerButton = () => element.querySelector('.tasks-pr button[aria-haspopup="dialog"]')
  await click(reviewerButton())
  await click(reviewerButton())
  await click(reviewerButton())
  expect(reviewerReads).toBe(2)
  await act(async () => { second.resolve({ recentlyActive: ['alex'], suggestions: ['sam'] }) })
  const dialog = element.querySelector('[role="dialog"][aria-label="Reviewers for PR #274"]')!
  expect(dialog.textContent).toContain('alex')
  expect(dialog.textContent).toContain('sam')
  await act(async () => {
    if (outcome === 'reject') first.reject(new Error('Old reviewer read failed.'))
    else first.resolve({ recentlyActive: ['outdated'], suggestions: [] })
  })
  expect(dialog.textContent).toContain('alex')
  expect(dialog.textContent).toContain('sam')
  expect(dialog.textContent).not.toContain('outdated')
  expect(inlineMessages(element.querySelector('.tasks-list')!)).toEqual([])
  await click(reviewerButton())
  await click(reviewerButton())
  expect(reviewerReads).toBe(2)
})

test('a failed reviewer suggestions read leaves loading and can be retried on the next open', async () => {
  let reviewerReads = 0
  const heldSecondRead = hold<unknown>()
  const state = withNavigation({ detail: detailTarget(274) })
  const { element, calls } = await mountList({
    state,
    handlers: {
      'quirky.tasks/mergeMetadata': () => ({ review: { requestedReviewers: ['zach'] }, mergeMetadataKnown: true }),
      'quirky.tasks/options': (params) => {
        if (params.kind !== 'reviewers') return params.kind === 'labels' ? { labels: [] } : { assignees: [] }
        reviewerReads += 1
        if (reviewerReads === 1) throw new Error('Reviewer suggestions are unavailable.')
        return heldSecondRead.promise
      }
    }
  })
  const reviewerButton = () => element.querySelector('.tasks-pr button[aria-haspopup="dialog"]')
  await click(reviewerButton())
  const dialog = element.querySelector('[role="dialog"][aria-label="Reviewers for PR #274"]')!
  expect(dialog.textContent).not.toContain('Loading reviewer suggestions…')
  expect(dialog.textContent).toContain('No matching reviewers.')
  expect(element.querySelectorAll('.tasks-list .ui-inline-error')).toHaveLength(1)
  expect(inlineMessages(element.querySelector('.tasks-list')!)).toEqual(['Reviewer suggestions are unavailable.'])
  expect(noticeTexts(element)).toEqual([])
  await click(reviewerButton())
  await click(reviewerButton())
  expect(calls.filter((call) => call.method === 'quirky.tasks/options' && call.params.kind === 'reviewers')).toHaveLength(2)
  expect(element.querySelector('[role="dialog"][aria-label="Reviewers for PR #274"]')?.textContent).toContain('Loading reviewer suggestions…')
})

test('Filters and repository-picker clicks target their own window through the command bridge', async () => {
  const { element, calls } = await mountList()
  const filters = element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]')
  await click(filters)
  expect(element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).not.toBeNull()
  expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(1)
  expect(calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(1)
  expect(calls.filter((call) => call.method === 'ui.window.command.run').at(-1)?.params).toEqual({
    connId: 7, id: LIST_CONTROL, args: { control: 'filters', open: true }
  })
  await click(filters)
  expect(element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()
  expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(2)
  expect(calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(2)
  expect(calls.filter((call) => call.method === 'ui.window.command.run').at(-1)?.params.args).toEqual({ control: 'filters', open: false })

  await click(element.querySelector('.tasks-list__repo-picker button'))
  expect(element.querySelector('[role="group"][aria-label="Select repositories"]')).not.toBeNull()
  expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(3)
  expect(calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(3)
  expect(calls.filter((call) => call.method === 'ui.window.command.run').at(-1)?.params.args).toEqual({ control: 'repositories', open: true })
})

test('a retained Tasks context resolves the live window for every click after reconnect', async () => {
  let liveConnId = 7
  const mounted = await mountList({ handlers: {
    'ui.window.self': () => ({ connId: liveConnId }),
    'ui.window.command.run': (params) => {
      if (params.connId !== liveConnId) throw new Error(`no connected window ${params.connId}`)
      return { result: mounted.callProvided(String(params.id), params.args) }
    }
  } })
  const filters = mounted.element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]')
  await click(filters)
  expect(mounted.element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).not.toBeNull()
  await mounted.connection('reconnecting')
  liveConnId = 22
  await mounted.connection('connected')
  await click(filters)
  expect(mounted.element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()
  await click(mounted.element.querySelector('.tasks-list__repo-picker button'))
  expect(mounted.element.querySelector('[role="group"][aria-label="Select repositories"]')).not.toBeNull()
  expect(mounted.calls.filter((call) => call.method === 'ui.window.command.run').map((call) => call.params.connId)).toEqual([7, 22, 22])
  expect(mounted.calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(3)
  expect(inlineMessages(mounted.element.querySelector('.tasks-list')!)).toEqual([])
})

test('Select projects resolves the replacement window in the same retained context', async () => {
  let liveConnId = 7
  const mounted = await mountList({ state: withNavigation({ repoIds: [] }), handlers: {
    'ui.window.self': () => ({ connId: liveConnId }),
    'ui.window.command.run': (params) => {
      if (params.connId !== liveConnId) throw new Error(`no connected window ${params.connId}`)
      return { result: mounted.callProvided(String(params.id), params.args) }
    }
  } })
  await click(mounted.element.querySelector('.tasks-list__empty .ui-empty-state button'))
  await click(mounted.element.querySelector('.tasks-list__repo-picker button'))
  await mounted.connection('reconnecting')
  liveConnId = 22
  await mounted.connection('connected')
  await click(mounted.element.querySelector('.tasks-list__empty .ui-empty-state button'))
  expect(mounted.element.querySelector('[role="group"][aria-label="Select repositories"]')).not.toBeNull()
  expect(mounted.calls.filter((call) => call.method === 'ui.window.command.run').map((call) => call.params.connId)).toEqual([7, 7, 22])
  expect(inlineMessages(mounted.element.querySelector('.tasks-list')!)).toEqual([])
})

test.each([7, 22])('a pre-reconnect identity response of %i cannot dispatch or block a fresh lookup', async (oldConnId) => {
  const oldLookup = hold<unknown>()
  let selfReads = 0
  const mounted = await mountList({ handlers: {
    'ui.window.self': () => ++selfReads === 1 ? oldLookup.promise : { connId: 22 }
  } })
  await click(mounted.element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  expect(mounted.calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(0)
  await mounted.connection('reconnecting')
  await mounted.connection('connected')
  await click(mounted.element.querySelector('.tasks-list__repo-picker button'))
  expect(mounted.element.querySelector('[role="group"][aria-label="Select repositories"]')).not.toBeNull()
  expect(selfReads).toBe(2)
  await act(async () => { oldLookup.resolve({ connId: oldConnId }) })
  await settle()
  expect(mounted.element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()
  expect(inlineMessages(mounted.element.querySelector('.tasks-list')!)).toEqual(['The UI connection changed before the action could be sent. Try again.'])
  await click(mounted.element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  expect(mounted.element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).not.toBeNull()
  expect(selfReads).toBe(3)
  expect(mounted.calls.filter((call) => call.method === 'ui.window.command.run').map((call) => call.params.connId)).toEqual([22, 22])
})

test('Select projects in the empty state opens the repository picker through the command bridge', async () => {
  const { element, calls } = await mountList({ state: withNavigation({ repoIds: [] }) })
  await click(element.querySelector('.tasks-list__empty .ui-empty-state button'))
  expect(element.querySelector('[role="group"][aria-label="Select repositories"]')).not.toBeNull()
  expect(calls.filter((call) => call.method === 'ui.window.command.run').at(-1)?.params).toEqual({
    connId: 7, id: LIST_CONTROL, args: { control: 'repositories', open: true }
  })
})

test('Escape closes an open list popover without another window command', async () => {
  const { element, calls } = await mountList()
  await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  const commandCount = calls.filter((call) => call.method === 'ui.window.command.run').length
  await press('Escape')
  expect(element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()
  expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(commandCount)
})

test('a missing window connection reports one action error without opening the Filters dialog', async () => {
  const { element, calls } = await mountList({ handlers: { 'ui.window.self': () => { throw new Error('Not a UI connection.') } } })
  await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  expect(element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()
  expect(element.querySelectorAll('.tasks-list .ui-inline-error')).toHaveLength(1)
  expect(inlineMessages(element.querySelector('.tasks-list')!)).toEqual(['Not a UI connection.'])
  expect(calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(1)
  expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(0)
})

test('a window command rejection is reported as an action error', async () => {
  const { element, calls } = await mountList({ handlers: { 'ui.window.command.run': () => { throw new Error('target closed') } } })
  await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
  expect(element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()
  expect(inlineMessages(element.querySelector('.tasks-list')!)).toContain('target closed')
  expect(calls.filter((call) => call.method === 'ui.window.self')).toHaveLength(1)
  expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(1)
})

test('a window response without a positive integer connection id is rejected before dispatch', async () => {
  for (const connId of [undefined, 0, -1, 1.5, '7']) {
    const { element, calls } = await mountList({ handlers: { 'ui.window.self': () => ({ connId }) } })
    await click(element.querySelector('.tasks-list__toolbar button[aria-haspopup="dialog"]'))
    expect(element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()
    expect(inlineMessages(element.querySelector('.tasks-list')!)).toContain('The daemon did not identify this UI connection.')
    expect(calls.filter((call) => call.method === 'ui.window.command.run')).toHaveLength(0)
  }
})

test('the provided list-control command opens and closes mounted filters and counts only applicable lists', async () => {
  const mounted = await mountList()
  const command = (input: unknown) => mounted.callProvided(LIST_CONTROL, input)
  await act(async () => { expect(command({ control: 'filters', open: true })).toEqual({ delivered: 1 }) })
  expect(mounted.element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).not.toBeNull()
  await act(async () => { expect(command({ control: 'filters', open: false })).toEqual({ delivered: 1 }) })
  expect(mounted.element.querySelector('[role="dialog"][aria-label="GitHub task filters"]')).toBeNull()

  const projects = await mountList({ state: withNavigation({ mode: 'projects' }) })
  expect(projects.callProvided(LIST_CONTROL, { control: 'filters', open: true })).toEqual({ delivered: 0 })

  const noRemote = await mountList({
    state: withNavigation({ repoIds: ['repo-1'] }),
    handlers: { 'quirky.tasks/list': () => listResult([pr(274)], {
      sources: { 'repo-1': { status: 'unavailable', reason: 'missing_origin', origin: null, message: 'No GitHub remote' } }
    }) }
  })
  expect(noRemote.callProvided(LIST_CONTROL, { control: 'filters', open: true })).toEqual({ delivered: 0 })
  await act(async () => { expect(noRemote.callProvided(LIST_CONTROL, { control: 'repositories', open: true })).toEqual({ delivered: 1 }) })
  expect(noRemote.element.querySelector('[role="group"][aria-label="Select repositories"]')).not.toBeNull()

  const twoMounted = await mountList()
  const secondList = await twoMounted.mountAnother()
  await act(async () => { expect(twoMounted.callProvided(LIST_CONTROL, { control: 'repositories', open: true })).toEqual({ delivered: 2 }) })
  await twoMounted.unmount(twoMounted.element)
  await act(async () => { expect(twoMounted.callProvided(LIST_CONTROL, { control: 'repositories', open: false })).toEqual({ delivered: 1 }) })
  await twoMounted.unmount(secondList)
  expect(twoMounted.callProvided(LIST_CONTROL, { control: 'repositories', open: false })).toEqual({ delivered: 0 })

  for (const invalid of [
    { control: 'merge', open: true },
    { control: 'filters' },
    { control: 'filters', open: 'yes' },
    null
  ]) {
    expect(() => twoMounted.callProvided(LIST_CONTROL, invalid)).toThrow('list-control needs a control of repositories or filters, and open as true or false.')
  }
})

test('row navigation, Task settings, and Refresh keep their public calls', async () => {
  const { element, calls, toasts } = await mountList({ handlers: { 'quirky.tasks/settings': () => { throw new Error('no window') } } })
  await click(element.querySelector('.tasks-list__row .ui-list-row__main'))
  expect(calls.filter((call) => call.method === 'quirky.tasks/navigate').at(-1)?.params).toEqual({
    detail: detailTarget(274)
  })

  await click(button(element, 'Tasks options'))
  const settings = [...element.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((item) => item.textContent?.trim() === 'Task settings')
  await click(settings)
  expect(calls.filter((call) => call.method === 'quirky.tasks/settings').at(-1)?.params).toEqual({})
  expect(toasts).toContain('Could not open task settings')

  await click(button(element, 'Refresh GitHub work'))
  expect(calls.filter((call) => call.method === 'quirky.tasks/list').some((call) => call.params.noCache === true)).toBe(true)
})
