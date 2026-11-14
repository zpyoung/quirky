import { afterAll, afterEach, expect, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import {
  API,
  type AutomationEditorData,
  type AutomationNavigation,
  type AutomationSurfaceProps,
  type ExternalManager
} from '../src/ui-contracts'
import type { AutomationDefinition, AutomationRun, AutomationRunsPage } from '../types'

const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
GlobalRegistrator.register()
actGlobal.IS_REACT_ACT_ENVIRONMENT = true

// React reads DOM and act support during module initialization, so these imports must follow registration.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AutomationsPage } = await import('../src/list/AutomationsPage')

const AUTOMATION_ID = 'automation-1'
const mounted: { container: HTMLElement; root: Root }[] = []
type ChangeListener = (event: QuirkyEvent) => void | Promise<void>
type CallRecord = { method: string; params: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
type Response = unknown | ((params: Record<string, unknown>, call: CallRecord) => unknown)
type Responder = { method: string; response: Response; matches: (params: Record<string, unknown>) => boolean; once: boolean }

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function definition(name = 'Nightly review', id = AUTOMATION_ID, prompt = 'Review the requested change.'): AutomationDefinition {
  return {
    id,
    name,
    prompt,
    agentId: 'claude',
    projectId: 'repo-1',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    baseBranch: null,
    reuseSession: false,
    runContext: null,
    sourceContext: null,
    launchOverrides: null,
    precheck: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 60,
    createdAt: 1,
    updatedAt: 1,
    owner: {
      kind: 'local', repoId: 'repo-1', repoPath: '/repo-1', workspaceId: 'workspace-1',
      workspacePath: '/repo-1/workspace', workspaceInstanceId: 'instance-1'
    }
  }
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-x',
    automationId: AUTOMATION_ID,
    title: 'Run X',
    runNumber: 1,
    scheduledFor: 1_000,
    trigger: 'scheduled',
    status: 'completed',
    createdAt: 1_000,
    occurrenceCount: 1,
    runContext: null,
    sourceContext: null,
    workspaceId: null,
    sessionKind: 'structured',
    sessionId: null,
    launchSettings: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    ...overrides
  }
}

function historyRun(index: number, automationId = AUTOMATION_ID): AutomationRun {
  return run({
    id: `history-${index}`,
    automationId,
    title: `History ${String(index).padStart(3, '0')}`,
    runNumber: index + 1,
    scheduledFor: 10_000 - index,
    createdAt: 10_000 - index
  })
}

function navigation(page: AutomationNavigation['page'], patch: Partial<AutomationNavigation> = {}): AutomationNavigation {
  return {
    page,
    automationId: page === 'run' ? null : AUTOMATION_ID,
    runId: page === 'run' ? 'run-x' : null,
    tab: 'overview',
    query: '',
    host: 'all',
    status: 'all',
    lastRun: 'all',
    agent: '',
    sort: 'name',
    direction: 'asc',
    runQuery: '',
    runStatus: 'all',
    promptExpanded: false,
    historyStarts: [0],
    runLimit: 100,
    settingsNotice: false,
    ...patch
  }
}

const emptyEditorData: AutomationEditorData = { hosts: [], projects: [], workspaces: [], agents: [], errors: [] }

function makeRig(options: {
  definitions?: AutomationDefinition[]
  runs?: AutomationRun[]
  managers?: ExternalManager[]
  editorData?: AutomationEditorData
  navigation?: AutomationNavigation
  refresh?: () => Promise<void>
} = {}) {
  let definitions = options.definitions ?? [definition()]
  let runs = options.runs ?? []
  const managers = options.managers ?? []
  const editorData = options.editorData ?? emptyEditorData
  const calls: CallRecord[] = []
  const listeners = new Set<ChangeListener>()
  const responders: Responder[] = []
  const openViews: string[] = []
  let currentNavigation = options.navigation ?? navigation('list')
  let root: Root | null = null
  let container: HTMLElement | null = null
  let revision = 0
  let refreshCount = 0
  let mountedRecord: { container: HTMLElement; root: Root } | null = null

  const renderCurrent = (context: UiPluginContext) => {
    if (!root) return
    revision++
    const props: AutomationSurfaceProps = {
      context,
      state: { revision, navigation: currentNavigation, editor: null },
      refresh: async () => {
        refreshCount++
        await options.refresh?.()
      },
      notify: () => {}
    }
    root.render(createElement(AutomationsPage, props))
  }

  const context = {
    pluginId: 'quirky.automations',
    call: async (method: string, params: Record<string, unknown> = {}) => {
      const record = { method, params }
      calls.push(record)
      if (method === `${API}uiNavigate`) {
        currentNavigation = { ...currentNavigation, ...params } as AutomationNavigation
        renderCurrent(context as unknown as UiPluginContext)
      }
      const responder = responders.find((candidate) => candidate.method === method && candidate.matches(params))
      if (responder) {
        if (responder.once) responders.splice(responders.indexOf(responder), 1)
        const result = typeof responder.response === 'function'
          ? responder.response(params, record)
          : responder.response
        return await result
      }
      if (method === `${API}list`) return [...definitions]
      if (method === `${API}editorData`) return editorData
      if (method === `${API}externalList`) return { managers }
      if (method === `${API}show`) {
        const id = typeof params.id === 'string' ? params.id : AUTOMATION_ID
        return definitions.find((candidate) => candidate.id === id) ?? null
      }
      if (method === `${API}target`) return { available: true, target: { owner: { kind: 'local' } } }
      if (method === `${API}runs`) {
        const cursor = typeof params.cursor === 'string' ? Number(params.cursor) : 0
        const limit = typeof params.limit === 'number' ? params.limit : 25
        const matchingRuns = typeof params.automationId === 'string'
          ? runs.filter((candidate) => candidate.automationId === params.automationId)
          : runs
        const pageRuns = matchingRuns.slice(cursor, cursor + limit)
        const nextOffset = cursor + pageRuns.length
        return { runs: pageRuns, nextCursor: nextOffset < matchingRuns.length ? String(nextOffset) : null } satisfies AutomationRunsPage
      }
      if (method === `${API}setting.get`) return { value: true }
      if (method === `${API}externalActionDescribe`) return null
      if (method === 'quirky.worktree/list') return []
      return null
    },
    subscribe: (listener: ChangeListener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    openView: (view: string) => { openViews.push(view) }
  } as unknown as UiPluginContext

  const rig = {
    context,
    calls,
    listeners,
    openViews,
    get refreshCount() { return refreshCount },
    get navigation() { return currentNavigation },
    respond(method: string, response: Response, matches: (params: Record<string, unknown>) => boolean = () => true, once = true) {
      const responder = { method, response, matches, once }
      responders.push(responder)
      return () => {
        const index = responders.indexOf(responder)
        if (index >= 0) responders.splice(index, 1)
      }
    },
    setDefinitions(value: AutomationDefinition[]) { definitions = value },
    setRuns(value: AutomationRun[]) { runs = value },
    async mount(page: AutomationNavigation['page'], patch: Partial<AutomationNavigation> = {}) {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      mountedRecord = { container, root }
      mounted.push(mountedRecord)
      currentNavigation = navigation(page, { ...patch, ...(patch.automationId === undefined ? { automationId: page === 'run' ? null : AUTOMATION_ID } : {}) })
      await act(async () => renderCurrent(context))
      return container
    },
    async render(patch: Partial<AutomationNavigation>, nextContext: UiPluginContext = context) {
      currentNavigation = { ...currentNavigation, ...patch }
      await act(async () => renderCurrent(nextContext))
    },
    async emitChanged(automationId = AUTOMATION_ID) {
      await act(async () => {
        for (const listener of [...listeners]) {
          await listener({ type: `${API}changed`, data: { automationId } } as QuirkyEvent)
        }
      })
    },
    async unmount() {
      if (!root || !container || !mountedRecord) return
      const record = mountedRecord
      await act(async () => root?.unmount())
      container.remove()
      const index = mounted.indexOf(record)
      if (index >= 0) mounted.splice(index, 1)
      mountedRecord = null
      root = null
      container = null
    }
  }
  return rig
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${text}; controls: ${[...container.querySelectorAll('button')].map((candidate) => candidate.textContent?.trim()).join(' | ')}`)
  }
  return button
}

function historyRows(container: HTMLElement): HTMLTableRowElement[] {
  return [...container.querySelectorAll<HTMLTableRowElement>('table[aria-label="Run history"] tbody tr')]
}
function historyLabels(container: HTMLElement): string[] {
  return historyRows(container).map((row) => row.cells[0]?.textContent?.slice(0, 11) ?? '')
}

function listRows(container: HTMLElement): HTMLTableRowElement[] {
  return [...container.querySelectorAll<HTMLTableRowElement>('table[aria-label="Automation list"] tbody tr')]
}

async function clickButton(container: HTMLElement, text: string): Promise<void> {
  await act(async () => buttonByText(container, text).click())
}

function expectNoRawStateClasses(container: HTMLElement): void {
  expect(container.querySelector('.auto-error, .auto-warning, .auto-info, .auto-muted')).toBeNull()
}
function buttonByAriaLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) throw new Error(`Missing button with aria-label: ${label}`)
  return button
}

function expectNotice(container: HTMLElement, text: string): HTMLElement {
  const lines = [...container.querySelectorAll<HTMLElement>('[role="status"] > .ui-notice-line')]
  const line = lines.find((candidate) => candidate.querySelector('.ui-notice-line__text')?.textContent?.trim() === text)
  if (!line) throw new Error(`Missing notice: ${text}; notices: ${lines.map((candidate) => candidate.textContent?.trim()).join(' | ')}`)
  return line
}

function noticeActions(line: HTMLElement): string[] {
  return [...line.querySelectorAll<HTMLButtonElement>('.ui-notice-line__action')].map((button) => button.textContent?.trim() ?? '')
}

type DeferredRig = {
  respond(method: string, response: Response, matches?: (params: Record<string, unknown>) => boolean, once?: boolean): () => void
}

function deferCalls(
  rig: DeferredRig,
  method: string,
  matches: (params: Record<string, unknown>) => boolean = () => true
): { pending: { call: CallRecord; result: Deferred<unknown> }[]; stop(): void } {
  const pending: { call: CallRecord; result: Deferred<unknown> }[] = []
  const stop = rig.respond(method, (_params: Record<string, unknown>, call: CallRecord) => {
    const result = deferred<unknown>()
    pending.push({ call, result })
    return result.promise
  }, matches, false)
  return { pending, stop }
}

function externalManager(): ExternalManager {
  return {
    id: 'openclaw:local',
    provider: 'openclaw',
    hostId: 'local',
    label: 'OpenClaw',
    status: 'ready',
    canManage: true,
    error: null,
    jobs: [{
      id: 'job-1',
      name: 'Nightly',
      schedule: '0 9 * * 1-5',
      enabled: true,
      state: 'scheduled',
      promptPreview: 'Review the repository.',
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      runCount: 4,
      runs: []
    }],
    owner: { provider: 'openclaw', hostId: 'local', generation: 'g1' }
  }
}

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT
  else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

afterEach(async () => {
  await act(async () => {
    for (const { root: mountedRoot, container } of mounted.splice(0)) {
      mountedRoot.unmount()
      container.remove()
    }
  })
})

test('native list load failures render a retryable inline error and refresh the page', async () => {
  const rig = makeRig({ definitions: [] })
  rig.respond(`${API}list`, () => Promise.reject(new Error('Store offline.')))
  const container = await rig.mount('list')
  await settle()

  const errorLines = container.querySelectorAll('.ui-inline-error[role="alert"]')
  expect(errorLines).toHaveLength(1)
  expect(errorLines[0]?.querySelector('.ui-inline-error__message')?.textContent).toBe('Automations could not be loaded. Store offline.')
  expect(errorLines[0]?.querySelector('.ui-inline-error__action')?.textContent?.trim()).toBe('Retry')
  expectNoRawStateClasses(container)

  const listCallsBeforeRetry = rig.calls.filter(({ method }) => method === `${API}list`).length
  await clickButton(container, 'Retry')
  await settle()
  expect(rig.refreshCount).toBe(1)
  expect(rig.calls.filter(({ method }) => method === `${API}list`)).toHaveLength(listCallsBeforeRetry + 1)
})
test('external and catalog failures remain advisory and retry only the external source', async () => {
  const rig = makeRig({ definitions: [] })
  rig.respond(`${API}externalList`, () => Promise.reject(new Error('OpenClaw offline.')))
  const container = await rig.mount('list')
  await settle()

  const externalNotice = expectNotice(container, 'OpenClaw jobs could not be checked; native automation rows remain available. OpenClaw offline.')
  expect(noticeActions(externalNotice)).toEqual(['Retry'])
  expect(container.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(0)
  expectNoRawStateClasses(container)
  const externalCalls = rig.calls.filter(({ method }) => method === `${API}externalList`).length
  await clickButton(container, 'Retry')
  await settle()
  expect(rig.calls.filter(({ method }) => method === `${API}externalList`)).toHaveLength(externalCalls + 1)

  const catalogFailure = makeRig({ definitions: [] })
  catalogFailure.respond(`${API}editorData`, () => Promise.reject(new Error('Catalog down.')))
  const catalogContainer = await catalogFailure.mount('list')
  await settle()
  expectNotice(catalogContainer, 'Project, host, and agent labels are incomplete because the catalog could not be loaded: Catalog down.')
  expectNoRawStateClasses(catalogContainer)

  const pausedHost = makeRig({
    definitions: [],
    editorData: {
      hosts: [{ id: 'local', label: 'This Mac', available: false, reason: 'Local host is paused.' }],
      projects: [],
      workspaces: [],
      agents: [],
      errors: []
    }
  })
  const pausedHostContainer = await pausedHost.mount('list')
  await settle()
  expectNotice(pausedHostContainer, 'Local host is paused.')
  expectNoRawStateClasses(pausedHostContainer)
})

test('action failures replace the busy notice with one inline error on list and detail', async () => {
  const listRig = makeRig()
  const listContainer = await listRig.mount('list')
  await settle()
  const listEditor = deferred<unknown>()
  listRig.respond(`${API}openEditor`, listEditor.promise)
  await act(async () => buttonByAriaLabel(listContainer, 'Automation actions').click())
  await settle()
  await clickButton(listContainer, 'Edit')
  await settle()
  expectNotice(listContainer, 'Working: edit:automation-1')
  await act(async () => listEditor.reject(new Error('Editor locked.')))
  await settle()
  expect(listContainer.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(1)
  expect(listContainer.querySelector('.ui-inline-error__message')?.textContent).toBe('Editor locked.')
  expect([...listContainer.querySelectorAll('[role="status"] > .ui-notice-line')].some((line) => line.textContent?.trim().startsWith('Working:'))).toBe(false)
  expectNoRawStateClasses(listContainer)

  const detailRig = makeRig()
  const detailContainer = await detailRig.mount('detail', { automationId: AUTOMATION_ID })
  await settle()
  const detailEditor = deferred<unknown>()
  detailRig.respond(`${API}openEditor`, detailEditor.promise)
  await clickButton(detailContainer, 'Edit automation')
  await settle()
  await act(async () => detailEditor.reject(new Error('Editor locked.')))
  await settle()
  expect(detailContainer.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(1)
  expect(detailContainer.querySelector('.ui-inline-error__message')?.textContent).toBe('Editor locked.')
  expectNoRawStateClasses(detailContainer)
})

test('detail definition loading and errors expose loading, retry, and history states', async () => {
  const pendingShow = makeRig({ definitions: [] })
  const heldShows = deferCalls(pendingShow, `${API}show`)
  const loadingDetail = await pendingShow.mount('detail', { automationId: AUTOMATION_ID })
  await settle()
  expect(heldShows.pending.length).toBeGreaterThan(0)
  expectNotice(loadingDetail, 'Loading automation…')
  expectNoRawStateClasses(loadingDetail)

  const failedShow = makeRig({ definitions: [] })
  failedShow.respond(`${API}show`, () => Promise.reject(new Error('Owner moved.')), () => true, false)
  const unavailableDetail = await failedShow.mount('detail', { automationId: AUTOMATION_ID })
  await settle()
  const detailError = unavailableDetail.querySelector('.ui-inline-error[role="alert"]')
  expect(detailError?.querySelector('.ui-inline-error__message')?.textContent).toBe('Automation details are unavailable. Owner moved.')
  expect(detailError?.querySelector('.ui-inline-error__action')?.textContent?.trim()).toBe('Retry')
  const listsBeforeRetry = failedShow.calls.filter(({ method }) => method === `${API}list`).length
  await clickButton(unavailableDetail, 'Retry')
  await settle()
  expect(failedShow.calls.filter(({ method }) => method === `${API}list`)).toHaveLength(listsBeforeRetry + 1)
  expectNoRawStateClasses(unavailableDetail)

  const pendingHistory = makeRig()
  const heldHistory = deferred<unknown>()
  pendingHistory.respond(`${API}runs`, heldHistory.promise, (params) => params.limit === 25)
  const loadingHistory = await pendingHistory.mount('detail', { automationId: AUTOMATION_ID, tab: 'runs' })
  await settle()
  expectNotice(loadingHistory, 'Loading run history…')
  expectNoRawStateClasses(loadingHistory)

  const failedHistory = makeRig()
  failedHistory.respond(`${API}runs`, () => Promise.reject(new Error('History store offline.')), (params) => params.limit === 25)
  const historyContainer = await failedHistory.mount('detail', { automationId: AUTOMATION_ID, tab: 'runs' })
  await settle()
  const historyError = historyContainer.querySelector('.ui-inline-error[role="alert"]')
  expect(historyError?.querySelector('.ui-inline-error__message')?.textContent).toBe('Run history is unavailable from this host. This does not mean the automation failed or has no runs. History store offline.')
  expect(historyError?.querySelector('.ui-inline-error__action')?.textContent?.trim()).toBe('Retry')
  const historyCallsBeforeRetry = failedHistory.calls.filter(({ method, params }) => method === `${API}runs` && params.limit === 25).length
  await clickButton(historyContainer, 'Retry')
  await settle()
  const historyCallsAfterRetry = failedHistory.calls.filter(({ method, params }) => method === `${API}runs` && params.limit === 25)
  expect(historyCallsAfterRetry).toHaveLength(historyCallsBeforeRetry + 1)
  expect(historyCallsAfterRetry.at(-1)?.params).toEqual({ automationId: AUTOMATION_ID, limit: 25 })
  expectNoRawStateClasses(historyContainer)

  const failedUsage = makeRig()
  failedUsage.respond(`${API}runs`, () => Promise.reject(new Error('Usage store offline.')), (params) => params.limit === 100, false)
  const usageContainer = await failedUsage.mount('detail', { automationId: AUTOMATION_ID, tab: 'overview' })
  await settle()
  const usageNotice = expectNotice(usageContainer, 'Run history is unavailable from this host. This does not mean the automation failed or has no runs. Usage store offline.')
  expect(noticeActions(usageNotice)).toEqual(['Retry'])
  expect(usageContainer.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(0)
  const usageCallsBeforeRetry = failedUsage.calls.filter(({ method, params }) => method === `${API}runs` && params.limit === 100).length
  await clickButton(usageContainer, 'Retry')
  await settle()
  const usageCallsAfterRetry = failedUsage.calls.filter(({ method, params }) => method === `${API}runs` && params.limit === 100)
  expect(usageCallsAfterRetry).toHaveLength(usageCallsBeforeRetry + 1)
  expect(usageCallsAfterRetry.at(-1)?.params).toEqual({ automationId: AUTOMATION_ID, limit: 100 })
  expectNoRawStateClasses(usageContainer)
})
test('prompt disclosure, partial history windows, and dashboard row limits navigate through ui state', async () => {
  const prompt = 'p'.repeat(500)
  const promptRig = makeRig({ definitions: [definition('Prompt owner', AUTOMATION_ID, prompt)] })
  const promptContainer = await promptRig.mount('detail', { automationId: AUTOMATION_ID, tab: 'overview', promptExpanded: false })
  await settle()
  const promptPre = promptContainer.querySelector('.auto-prompt-disclosure pre')
  const expandButton = buttonByText(promptContainer, 'Show more')
  expect(promptPre?.textContent).toBe(`${prompt.slice(0, 400)}…`)
  expect(expandButton.getAttribute('aria-expanded')).toBe('false')
  await act(async () => expandButton.click())
  await settle()
  const promptNavigations = promptRig.calls.filter(({ method }) => method === `${API}uiNavigate`)
  expect(promptNavigations).toHaveLength(1)
  expect(promptNavigations[0]?.params).toEqual({ promptExpanded: true })
  expect(promptContainer.querySelector('.auto-prompt-disclosure pre')?.textContent).toBe(prompt)
  expect(buttonByText(promptContainer, 'Show less').getAttribute('aria-expanded')).toBe('true')

  const histories = Array.from({ length: 153 }, (_, index) => historyRun(index))
  const historyRig = makeRig({ runs: histories })
  const historyContainer = await historyRig.mount('detail', { automationId: AUTOMATION_ID, tab: 'runs', historyStarts: [0] })
  await settle()
  expect(historyRows(historyContainer)).toHaveLength(25)
  expect([...historyContainer.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Show newer runs')).toBe(false)
  const loadedCounts = [50, 75, 100, 125, 150, 153]
  const expectedStarts = [
    { historyStarts: [0, 25] },
    { historyStarts: [0, 25, 50] },
    { historyStarts: [0, 25, 50, 53] }
  ]
  for (const [index, loadedCount] of loadedCounts.entries()) {
    await clickButton(historyContainer, 'Load older runs')
    await settle()
    expect(historyContainer.textContent).toContain(`${loadedCount} loaded`)
    expect(historyRig.calls.filter(({ method }) => method === `${API}uiNavigate`).map(({ params }) => params))
      .toEqual(expectedStarts.slice(0, Math.max(0, index - 2)))
  }
  let rows = historyRows(historyContainer)
  expect(rows).toHaveLength(100)
  expect(rows[0]?.textContent).toContain('History 053')
  expect(rows.at(-1)?.textContent).toContain('History 152')
  await clickButton(historyContainer, 'Show newer runs')
  await settle()
  expect(historyRig.calls.filter(({ method }) => method === `${API}uiNavigate`).at(-1)?.params).toEqual({ historyStarts: [0, 25, 50] })
  rows = historyRows(historyContainer)
  expect(rows[0]?.textContent).toContain('History 050')
  expect(rows.at(-1)?.textContent).toContain('History 149')
  await clickButton(historyContainer, 'Show older runs')
  await settle()
  expect(historyRig.calls.filter(({ method }) => method === `${API}uiNavigate`).at(-1)?.params).toEqual({ historyStarts: [0, 25, 50, 53] })
  rows = historyRows(historyContainer)
  expect(rows[0]?.textContent).toContain('History 053')
  expect(rows.at(-1)?.textContent).toContain('History 152')

  const dashboardRig = makeRig({ runs: Array.from({ length: 150 }, (_, index) => historyRun(index)) })
  const dashboardContainer = await dashboardRig.mount('runs', { automationId: null, runLimit: 100 })
  await settle()
  expect(dashboardContainer.querySelectorAll('table[aria-label="Automation runs"] tbody tr')).toHaveLength(100)
  await clickButton(dashboardContainer, 'Load more runs')
  await settle()
  expect(dashboardRig.calls.filter(({ method }) => method === `${API}uiNavigate`).map(({ params }) => params)).toEqual([{ runLimit: 150 }])
  expect(dashboardContainer.querySelectorAll('table[aria-label="Automation runs"] tbody tr')).toHaveLength(150)
  expect([...dashboardContainer.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Load more runs')).toBe(false)
  expectNoRawStateClasses(promptContainer)
  expectNoRawStateClasses(historyContainer)
  expectNoRawStateClasses(dashboardContainer)
})

test('a delayed older history page cannot move a newer window', async () => {
  const historyRig = makeRig({ runs: Array.from({ length: 150 }, (_, index) => historyRun(index)) })
  const container = await historyRig.mount('detail', { automationId: AUTOMATION_ID, tab: 'runs' })
  await settle()
  for (let index = 0; index < 4; index++) {
    await clickButton(container, 'Load older runs')
    await settle()
  }
  expect(historyRig.navigation.historyStarts).toEqual([0, 25])
  expect(historyRows(container)[0]?.textContent).toContain('History 025')
  expect(historyRows(container).at(-1)?.textContent).toContain('History 124')

  const delayedPage = deferred<unknown>()
  historyRig.respond(`${API}runs`, delayedPage.promise, (params) => params.cursor === '125')
  await clickButton(container, 'Load older runs')
  await settle()
  const navigationsBeforeNewer = historyRig.calls.filter(({ method }) => method === `${API}uiNavigate`).length
  await clickButton(container, 'Show newer runs')
  await settle()
  expect(historyRig.navigation.historyStarts).toEqual([0])
  const navigationsAfterNewer = historyRig.calls.filter(({ method }) => method === `${API}uiNavigate`).length
  expect(navigationsAfterNewer).toBe(navigationsBeforeNewer + 1)

  await act(async () => delayedPage.resolve({
    runs: Array.from({ length: 25 }, (_, offset) => historyRun(125 + offset)),
    nextCursor: null
  }))
  await settle()
  expect(historyRows(container)).toHaveLength(100)
  expect(historyRows(container)[0]?.textContent).toContain('History 000')
  expect(historyRows(container).at(-1)?.textContent).toContain('History 099')
  expect(historyRig.calls.filter(({ method }) => method === `${API}uiNavigate`)).toHaveLength(navigationsAfterNewer)
  expectNoRawStateClasses(container)
})
test('run detail loading, errors, and unavailable workspace checks are retryable shared states', async () => {
  const pendingRig = makeRig()
  const pendingReads = deferCalls(pendingRig, `${API}runs`, (params) => params.limit === 100)
  const pendingContainer = await pendingRig.mount('run', { runId: 'run-x', automationId: null })
  await settle()
  expect(pendingReads.pending.length).toBeGreaterThan(0)
  expectNotice(pendingContainer, 'Loading run…')
  expectNoRawStateClasses(pendingContainer)

  const failedRig = makeRig()
  failedRig.respond(`${API}runs`, () => Promise.reject(new Error('Run store offline.')), (params) => params.limit === 100, false)
  const failedContainer = await failedRig.mount('run', { runId: 'run-x', automationId: null })
  await settle()
  const runError = failedContainer.querySelector('.ui-inline-error[role="alert"]')
  expect(failedContainer.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(1)
  expect(runError?.querySelector('.ui-inline-error__message')?.textContent).toBe('Run details are unavailable. Run store offline.')
  expect(runError?.querySelector('.ui-inline-error__action')?.textContent?.trim()).toBe('Retry')
  const runCallsBeforeRetry = failedRig.calls.filter(({ method }) => method === `${API}runs`).length
  await clickButton(failedContainer, 'Retry')
  await settle()
  expect(failedRig.calls.filter(({ method }) => method === `${API}runs`).length).toBeGreaterThan(runCallsBeforeRetry)
  expectNoRawStateClasses(failedContainer)

  const workspaceRun = run({ workspaceId: 'w1' })
  const unavailableRig = makeRig({ runs: [workspaceRun] })
  unavailableRig.respond('quirky.worktree/list', () => Promise.reject(new Error('workspace list failed')), () => true, false)
  const unavailableContainer = await unavailableRig.mount('run', { runId: 'run-x', automationId: null })
  await settle()
  const availabilityNotice = expectNotice(unavailableContainer, 'No workspace or session navigation link is available. Workspace availability could not be checked.')
  expect(noticeActions(availabilityNotice)).toEqual(['Retry availability check'])
  const availabilityCalls = unavailableRig.calls.filter(({ method }) => method === `${API}runs`).length
  await clickButton(unavailableContainer, 'Retry availability check')
  await settle()
  expect(unavailableRig.calls.filter(({ method }) => method === `${API}runs`).length).toBeGreaterThan(availabilityCalls)
  expectNoRawStateClasses(unavailableContainer)
})
test('native and external row actions preserve routing while external deletes are described', async () => {
  const nativeRig = makeRig()
  const nativeContainer = await nativeRig.mount('list')
  await settle()
  const nativeTargetsBefore = nativeRig.calls.filter(({ method }) => method === `${API}target`).length
  await act(async () => buttonByAriaLabel(nativeContainer, 'Automation actions').click())
  await settle()
  expect(buttonByAriaLabel(nativeContainer, 'Automation actions').getAttribute('aria-expanded')).toBe('true')
  expect(nativeRig.calls.filter(({ method }) => method === `${API}target`)).toHaveLength(nativeTargetsBefore + 1)
  expect(nativeRig.calls.filter(({ method }) => method === `${API}target`).at(-1)?.params).toEqual({ id: AUTOMATION_ID })
  expect(nativeRig.calls.filter(({ method }) => method === `${API}uiNavigate`)).toHaveLength(0)
  await clickButton(nativeContainer, 'Edit')
  await settle()
  const editorCalls = nativeRig.calls.filter(({ method }) => method === `${API}openEditor`)
  expect(editorCalls).toHaveLength(1)
  expect(editorCalls[0]?.params).toEqual({ id: AUTOMATION_ID })
  expect(nativeRig.calls.filter(({ method }) => method === `${API}uiNavigate`)).toHaveLength(0)

  const confirmation = 'Delete OpenClaw automation “Nightly”? This removes the job from OpenClaw only; native automation history and workspaces are not changed.'
  const describedRig = makeRig({ definitions: [], managers: [externalManager()] })
  describedRig.respond(`${API}externalActionDescribe`, confirmation)
  const describedContainer = await describedRig.mount('list')
  await settle()
  await act(async () => buttonByAriaLabel(describedContainer, 'External automation actions').click())
  await settle()
  await clickButton(describedContainer, 'Delete')
  await settle()
  const describeCalls = describedRig.calls.filter(({ method }) => method === `${API}externalActionDescribe`)
  expect(describeCalls).toHaveLength(1)
  expect(describeCalls[0]?.params).toEqual({
    owner: { provider: 'openclaw', hostId: 'local', generation: 'g1' },
    jobId: 'job-1',
    action: 'delete'
  })
  expect(describedContainer.querySelector('[role="dialog"] p')?.textContent).toBe(confirmation)
  const callCountBeforeCancel = describedRig.calls.length
  await clickButton(describedContainer, 'Cancel')
  await settle()
  expect(describedContainer.querySelector('[role="dialog"]')).toBeNull()
  expect(describedRig.calls).toHaveLength(callCountBeforeCancel)

  const fallbackRig = makeRig({ definitions: [], managers: [externalManager()] })
  fallbackRig.respond(`${API}externalActionDescribe`, null)
  const fallbackContainer = await fallbackRig.mount('list')
  await settle()
  await act(async () => buttonByAriaLabel(fallbackContainer, 'External automation actions').click())
  await settle()
  await clickButton(fallbackContainer, 'Delete')
  await settle()
  expect(fallbackRig.calls.filter(({ method }) => method === `${API}externalActionDescribe`)).toHaveLength(1)
  expect(fallbackContainer.querySelector('[role="dialog"] p')?.textContent).toBe('Delete Nightly from OpenClaw? This changes the OpenClaw job only and does not remove native automation history.')

  const describeFailure = makeRig({ definitions: [], managers: [externalManager()] })
  describeFailure.respond(`${API}externalActionDescribe`, () => Promise.reject(new Error('OpenClaw job job-1 no longer exists; refresh the external list')))
  const failureContainer = await describeFailure.mount('list')
  await settle()
  await act(async () => buttonByAriaLabel(failureContainer, 'External automation actions').click())
  await settle()
  await clickButton(failureContainer, 'Delete')
  await settle()
  expect(describeFailure.calls.filter(({ method }) => method === `${API}externalActionDescribe`)).toHaveLength(1)
  expect(failureContainer.querySelector('[role="dialog"]')).toBeNull()
  expect(failureContainer.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(1)
  expect(failureContainer.querySelector('.ui-inline-error__message')?.textContent).toBe('OpenClaw job job-1 no longer exists; refresh the external list')
  expectNoRawStateClasses(nativeContainer)
  expectNoRawStateClasses(describedContainer)
  expectNoRawStateClasses(fallbackContainer)
  expectNoRawStateClasses(failureContainer)
})

test('external delete action errors stay inside the confirmation dialog', async () => {
  const rig = makeRig({ definitions: [], managers: [externalManager()] })
  const container = await rig.mount('list')
  await settle()
  await act(async () => buttonByAriaLabel(container, 'External automation actions').click())
  await settle()
  await clickButton(container, 'Delete')
  await settle()
  const actionResult = deferred<unknown>()
  rig.respond(`${API}externalAction`, actionResult.promise)
  await clickButton(container, 'Delete external job')
  await settle()
  await act(async () => actionResult.reject(new Error('OpenClaw jobs changed.')))
  await settle()
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog?.querySelectorAll('.ui-inline-error[role="alert"]')).toHaveLength(1)
  expect(dialog?.querySelector('.ui-inline-error__message')?.textContent).toBe('OpenClaw jobs changed.')
  expectNoRawStateClasses(container)
})

test('native delete preference confirmation navigates in the required call order', async () => {
  const rig = makeRig()
  const container = await rig.mount('list')
  await settle()
  await act(async () => buttonByAriaLabel(container, 'Automation actions').click())
  await settle()
  await clickButton(container, 'Delete')
  await settle()
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')
  const preference = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(preference?.checked).toBe(false)
  if (!preference) throw new Error('Missing Don’t ask again checkbox')
  await act(async () => preference.click())
  expect(preference.checked).toBe(true)
  const callsBeforeConfirm = rig.calls.length
  await clickButton(dialog!, 'Delete')
  await settle()
  const confirmationCalls = rig.calls.slice(callsBeforeConfirm).filter(({ method }) =>
    method === 'setting.set' || method === `${API}uiNavigate` || method === `${API}show` || method === `${API}remove`
  )
  expect(confirmationCalls.map(({ method }) => method)).toEqual([
    'setting.set',
    `${API}uiNavigate`,
    `${API}show`,
    `${API}remove`
  ])
  expect(confirmationCalls[0]?.params).toEqual({ id: 'setting:quirky.automations/ask-before-delete', value: false })
  expect(confirmationCalls[1]?.params).toEqual({ settingsNotice: true })
  expect(confirmationCalls[2]?.params).toMatchObject({ id: AUTOMATION_ID })
  expect(confirmationCalls[3]?.params).toMatchObject({ id: AUTOMATION_ID, yes: true })
  expectNoRawStateClasses(container)
})

test('settings notice dismiss and open actions use navigation and await the view route', async () => {
  const dismissRig = makeRig()
  const dismissContainer = await dismissRig.mount('list', { settingsNotice: true })
  await settle()
  const dismissNotice = expectNotice(dismissContainer, 'The confirmation preference was saved.')
  expect(noticeActions(dismissNotice)).toEqual(['Open Settings', 'Dismiss'])
  await clickButton(dismissContainer, 'Dismiss')
  await settle()
  expect(dismissRig.calls.filter(({ method }) => method === `${API}uiNavigate`).map(({ params }) => params)).toEqual([{ settingsNotice: false }])
  expect(dismissRig.openViews).toEqual([])

  const openRig = makeRig()
  const navigationResult = deferred<unknown>()
  openRig.respond(`${API}uiNavigate`, navigationResult.promise)
  const openContainer = await openRig.mount('list', { settingsNotice: true })
  await settle()
  await clickButton(openContainer, 'Open Settings')
  await settle()
  expect(openRig.calls.filter(({ method }) => method === `${API}uiNavigate`).map(({ params }) => params)).toEqual([{ settingsNotice: false }])
  expect(openRig.openViews).toEqual([])
  await act(async () => navigationResult.resolve(null))
  await settle()
  expect(openRig.openViews).toEqual(['view:quirky.automations/settings'])
  expectNoRawStateClasses(dismissContainer)
  expectNoRawStateClasses(openContainer)
})

test('a failed last-run lookup stays on its native row without hiding the list', async () => {
  const first = definition('First automation', 'automation-1')
  const second = definition('Second automation', 'automation-2')
  const rig = makeRig({ definitions: [first, second] })
  rig.respond(`${API}runs`, () => Promise.reject(new Error('Second history unavailable.')), (params) =>
    params.limit === 1 && params.automationId === second.id, false
  )
  const container = await rig.mount('list')
  await settle()
  const rows = listRows(container)
  const firstRow = rows.find((row) => row.getAttribute('data-row-key') === 'native:automation-1')
  const secondRow = rows.find((row) => row.getAttribute('data-row-key') === 'native:automation-2')
  expect(firstRow).toBeDefined()
  expect(secondRow?.textContent).toContain('History unavailable')
  expect(firstRow?.textContent).not.toContain('History unavailable')
  expectNotice(container, 'Run history is unavailable for 1 automation; list rows remain available.')
  expectNoRawStateClasses(container)
})
test('a stale history page from an old automation cannot replace the selected automation', async () => {
  const automationA = 'automation-a'
  const automationB = 'automation-b'
  const rig = makeRig({
    definitions: [definition('Automation A', automationA), definition('Automation B', automationB)],
    runs: [historyRun(0, automationB)]
  })
  const pageA = deferCalls(rig, `${API}runs`, (params) => params.limit === 25 && params.automationId === automationA)
  const container = await rig.mount('detail', { automationId: automationA, tab: 'runs' })
  await settle()
  expect(pageA.pending.length).toBeGreaterThan(0)

  await rig.render({ automationId: automationB })
  await settle()
  expect(historyLabels(container)).toEqual(['History 000'])
  const stale = pageA.pending.at(-1)
  if (!stale) throw new Error('Missing deferred history read for automation A')
  await act(async () => stale.result.resolve({ runs: [historyRun(7, automationA)], nextCursor: null }))
  await settle()
  expect(historyLabels(container)).toEqual(['History 000'])
  expectNoRawStateClasses(container)
})

test('history tab changes invalidate pending pages and overlapping reload failures', async () => {
  const tabRig = makeRig()
  const tabs = deferCalls(tabRig, `${API}runs`, (params) => params.limit === 25)
  const tabContainer = await tabRig.mount('detail', { automationId: AUTOMATION_ID, tab: 'runs' })
  await settle()
  const firstPage = tabs.pending.at(-1)
  if (!firstPage) throw new Error('Missing first deferred history page')
  await tabRig.render({ tab: 'overview' })
  await settle()
  await tabRig.render({ tab: 'runs' })
  await settle()
  const secondPage = tabs.pending.at(-1)
  if (!secondPage || secondPage === firstPage) throw new Error('Missing second deferred history page')
  tabs.stop()
  await act(async () => firstPage.result.reject(new Error('Stale history failure.')))
  await settle()
  await act(async () => secondPage.result.resolve({ runs: [historyRun(3)], nextCursor: null }))
  await settle()
  expect(tabContainer.textContent).not.toContain('Stale history failure.')
  expect(historyLabels(tabContainer)).toEqual(['History 003'])

  const reloadRig = makeRig()
  reloadRig.respond(`${API}runs`, () => Promise.reject(new Error('History store offline.')), (params) => params.limit === 25)
  const reloadContainer = await reloadRig.mount('detail', { automationId: AUTOMATION_ID, tab: 'runs' })
  await settle()
  expect(reloadContainer.querySelector('.ui-inline-error__message')?.textContent).toContain('History store offline.')
  const overlapping = deferCalls(reloadRig, `${API}runs`, (params) => params.limit === 25)
  await clickButton(reloadContainer, 'Retry')
  await settle()
  const retryPage = overlapping.pending.at(-1)
  if (!retryPage) throw new Error('Missing deferred history retry page')
  await reloadRig.emitChanged()
  await settle()
  const changedPage = overlapping.pending.at(-1)
  if (!changedPage || changedPage === retryPage) throw new Error('Changed event did not start a second history page')
  overlapping.stop()
  await act(async () => changedPage.result.resolve({ runs: [historyRun(4)], nextCursor: null }))
  await settle()
  await act(async () => retryPage.result.reject(new Error('Retry failure.')))
  await settle()
  expect(reloadContainer.textContent).not.toContain('Retry failure.')
  expect(historyLabels(reloadContainer)).toEqual(['History 004'])
  expectNoRawStateClasses(tabContainer)
  expectNoRawStateClasses(reloadContainer)
})

test('stale usage reads are dropped after changing automation or reloading history', async () => {
  const automationA = 'automation-a'
  const automationB = 'automation-b'
  const switchRig = makeRig({
    definitions: [definition('Automation A', automationA), definition('Automation B', automationB)],
    runs: []
  })
  const usageA = deferCalls(switchRig, `${API}runs`, (params) => params.limit === 100 && params.automationId === automationA)
  const switchContainer = await switchRig.mount('detail', { automationId: automationA, tab: 'overview' })
  await settle()
  const staleUsage = usageA.pending.at(-1)
  if (!staleUsage) throw new Error('Missing deferred usage read for automation A')
  usageA.stop()
  await switchRig.render({ automationId: automationB })
  await settle()
  await act(async () => staleUsage.result.reject(new Error('Usage store offline.')))
  await settle()
  expect(switchContainer.textContent).not.toContain('Usage store offline.')

  const reloadRig = makeRig()
  const stopInitialFailure = reloadRig.respond(
    `${API}runs`,
    () => Promise.reject(new Error('Usage store offline.')),
    (params) => params.limit === 100,
    false
  )
  const reloadContainer = await reloadRig.mount('detail', { automationId: AUTOMATION_ID, tab: 'overview' })
  await settle()
  expectNotice(reloadContainer, 'Run history is unavailable from this host. This does not mean the automation failed or has no runs. Usage store offline.')
  stopInitialFailure()

  const reloads = deferCalls(reloadRig, `${API}runs`, (params) => params.limit === 100)
  await clickButton(reloadContainer, 'Retry')
  await settle()
  const retryUsage = reloads.pending.at(-1)
  if (!retryUsage) throw new Error('Missing deferred usage retry')
  await reloadRig.emitChanged()
  await settle()
  const changedUsage = reloads.pending.at(-1)
  if (!changedUsage || changedUsage === retryUsage) throw new Error('Changed event did not start a second usage read')
  reloads.stop()
  await act(async () => changedUsage.result.resolve({ runs: [], nextCursor: null }))
  await settle()
  await act(async () => retryUsage.result.reject(new Error('Late usage failure.')))
  await settle()
  expect(reloadContainer.textContent).not.toContain('Late usage failure.')
  expect(reloadContainer.textContent).not.toContain('Usage store offline.')
  expectNoRawStateClasses(switchContainer)
  expectNoRawStateClasses(reloadContainer)
})
test('run-detail requests invalidated by a run switch cannot update or open the old run', async () => {
  const automationX = 'automation-x'
  const automationY = 'automation-y'
  const staleRun = run({ id: 'run-x', automationId: automationX, title: 'Stale X' })
  const freshRun = run({ id: 'run-y', automationId: automationY, title: 'Fresh Y' })
  const rig = makeRig({
    definitions: [definition('Automation X', automationX), definition('Automation Y', automationY)],
    runs: [staleRun, freshRun]
  })
  const lookups = deferCalls(rig, `${API}runs`, (params) => params.limit === 100)
  const container = await rig.mount('run', { runId: 'run-x', automationId: null })
  await settle()
  const staleLookup = lookups.pending.at(-1)
  if (!staleLookup) throw new Error('Missing deferred lookup for run X')
  lookups.stop()

  await rig.render({ runId: 'run-y' })
  await settle()
  expect(container.textContent).toContain('Fresh Y')
  await act(async () => staleLookup.result.resolve({ runs: [staleRun], nextCursor: null }))
  await settle()
  expect(rig.calls.some(({ method, params }) => method === `${API}show` && params.id === automationX)).toBe(false)
  expect(container.textContent).not.toContain('Stale X')
  expect(container.textContent).toContain('Fresh Y')
  expectNoRawStateClasses(container)
})

test('a run switch during owner lookup prevents target and workspace follow-up calls', async () => {
  const automationX = 'automation-x'
  const automationY = 'automation-y'
  const staleRun = run({ id: 'run-x', automationId: automationX, title: 'Stale X', workspaceId: 'w1' })
  const freshRun = run({ id: 'run-y', automationId: automationY, title: 'Fresh Y' })
  const rig = makeRig({
    definitions: [definition('Automation X', automationX), definition('Automation Y', automationY)],
    runs: [staleRun, freshRun]
  })
  const ownerReads = deferCalls(rig, `${API}show`, (params) => params.id === automationX)
  const container = await rig.mount('run', { runId: 'run-x', automationId: null })
  await settle()
  const pendingOwnerReads = [...ownerReads.pending]
  if (pendingOwnerReads.length === 0) throw new Error('Missing deferred owner lookup for automation X')
  ownerReads.stop()
  await rig.render({ runId: 'run-y' })
  await settle()
  await act(async () => {
    for (const pending of pendingOwnerReads) pending.result.resolve(definition('Stale owner', automationX))
  })
  await settle()
  expect(rig.calls.some(({ method, params }) => method === `${API}target` && params.id === automationX)).toBe(false)
  expect(rig.calls.some(({ method }) => method === 'quirky.worktree/list')).toBe(false)
  expect(container.textContent).toContain('Fresh Y')
  expect(container.textContent).not.toContain('Stale X')
  expectNoRawStateClasses(container)
})

test('unmounting run details drops a pending run lookup before the owner request', async () => {
  const staleRun = run({ id: 'run-x', automationId: 'automation-x', title: 'Stale X' })
  const rig = makeRig({ definitions: [definition('Automation X', 'automation-x')], runs: [staleRun] })
  const lookups = deferCalls(rig, `${API}runs`, (params) => params.limit === 100)
  await rig.mount('run', { runId: 'run-x', automationId: null })
  await settle()
  const pendingLookups = [...lookups.pending]
  if (pendingLookups.length === 0) throw new Error('Missing deferred run lookup')
  lookups.stop()
  await rig.unmount()
  await act(async () => {
    for (const pending of pendingLookups) pending.result.resolve({ runs: [staleRun], nextCursor: null })
  })
  await settle()
  expect(rig.calls.some(({ method, params }) => method === `${API}show` && params.id === 'automation-x')).toBe(false)
})

test('replacing the run detail context drops the old lookup and keeps the new context result', async () => {
  const staleRun = run({ id: 'run-x', automationId: 'automation-x', title: 'Stale X' })
  const oldRig = makeRig({ definitions: [definition('Stale owner', 'automation-x')], runs: [staleRun] })
  const oldLookups = deferCalls(oldRig, `${API}runs`, (params) => params.limit === 100)
  const container = await oldRig.mount('run', { runId: 'run-x', automationId: null })
  await settle()
  const staleLookup = oldLookups.pending.at(-1)
  if (!staleLookup) throw new Error('Missing deferred lookup on the original context')
  oldLookups.stop()

  const freshRun = run({ id: 'run-x', automationId: 'automation-x', title: 'Fresh X' })
  const freshRig = makeRig({ definitions: [definition('Fresh owner', 'automation-x')], runs: [freshRun] })
  await oldRig.render({ page: 'run', runId: 'run-x', automationId: null }, freshRig.context)
  await settle()
  await act(async () => staleLookup.result.resolve({ runs: [staleRun], nextCursor: null }))
  await settle()
  expect(oldRig.calls.some(({ method, params }) => method === `${API}show` && params.id === 'automation-x')).toBe(false)
  expect(container.textContent).toContain('Fresh X')
  expect(container.textContent).not.toContain('Stale X')
  expectNoRawStateClasses(container)
})

test('overlapping run-detail retries keep the newest result and discard the earlier response', async () => {
  const rig = makeRig()
  const stopInitialFailures = rig.respond(
    `${API}runs`,
    () => Promise.reject(new Error('Run store offline.')),
    (params) => params.limit === 100,
    false
  )
  const container = await rig.mount('run', { runId: 'run-x', automationId: null })
  await settle()
  expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Run details are unavailable. Run store offline.')
  stopInitialFailures()

  const retries = deferCalls(rig, `${API}runs`, (params) => params.limit === 100)
  await clickButton(container, 'Retry')
  await settle()
  const firstRetry = retries.pending.at(-1)
  if (!firstRetry) throw new Error('Missing first deferred run retry')
  await rig.emitChanged()
  await settle()
  const changedRetry = retries.pending.at(-1)
  if (!changedRetry || changedRetry === firstRetry) throw new Error('Changed event did not start a newer run lookup')
  retries.stop()

  await act(async () => changedRetry.result.resolve({ runs: [run({ id: 'run-x', title: 'Fresh X' })], nextCursor: null }))
  await settle()
  await act(async () => firstRetry.result.resolve({ runs: [run({ id: 'run-x', title: 'Stale X' })], nextCursor: null }))
  await settle()
  expect(container.textContent).toContain('Fresh X')
  expect(container.textContent).not.toContain('Stale X')
  expect(container.textContent).not.toContain('Run store offline.')
  expectNoRawStateClasses(container)
})
test('a pending external delete description serializes other rows and cannot reopen after cancel', async () => {
  const manager = externalManager()
  const firstJob = manager.jobs[0]
  if (!firstJob) throw new Error('Missing external fixture job')
  const rig = makeRig({
    definitions: [],
    managers: [{
      ...manager,
      jobs: [
        { ...firstJob, id: 'job-a', name: 'Nightly A' },
        { ...firstJob, id: 'job-b', name: 'Nightly B' }
      ]
    }]
  })
  const firstDescription = deferred<unknown>()
  rig.respond(`${API}externalActionDescribe`, firstDescription.promise, (params) => params.jobId === 'job-a')
  const container = await rig.mount('list')
  await settle()
  const listRows = [...container.querySelectorAll<HTMLTableRowElement>('table[aria-label="Automation list"] tbody tr')]
  const firstRow = listRows.find((row) => row.textContent?.includes('Nightly A'))
  const secondRow = listRows.find((row) => row.textContent?.includes('Nightly B'))
  if (!firstRow || !secondRow) throw new Error('Missing one of the two external automation rows')
  await act(async () => buttonByAriaLabel(firstRow, 'External automation actions').click())
  await settle()
  await clickButton(container, 'Delete')
  await settle()
  expect(rig.calls.filter(({ method }) => method === `${API}externalActionDescribe`)[0]?.params.jobId).toBe('job-a')
  expect(rig.calls.filter(({ method }) => method === `${API}externalActionDescribe`)).toHaveLength(1)
  expect(container.querySelector('[role="dialog"]')).toBeNull()

  const currentSecondRow = [...container.querySelectorAll<HTMLTableRowElement>('table[aria-label="Automation list"] tbody tr')]
    .find((row) => row.textContent?.includes('Nightly B'))
  if (!currentSecondRow) throw new Error('Missing the second external automation row after rerender')
  await act(async () => buttonByAriaLabel(currentSecondRow, 'External automation actions').click())
  await settle()
  const openSecondRow = [...container.querySelectorAll<HTMLTableRowElement>('table[aria-label="Automation list"] tbody tr')]
    .find((row) => row.textContent?.includes('Nightly B'))
  if (!openSecondRow) throw new Error('Missing the second row after opening its menu')
  const secondDelete = [...openSecondRow.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Delete')
  if (!secondDelete) throw new Error('Missing the second row delete action')
  expect(secondDelete.disabled).toBe(true)
  await act(async () => secondDelete.click())
  await settle()
  expect(rig.calls.filter(({ method }) => method === `${API}externalActionDescribe`)).toHaveLength(1)

  await act(async () => firstDescription.resolve('Delete OpenClaw automation “Nightly A”? This removes the job from OpenClaw only; native automation history and workspaces are not changed.'))
  await settle()
  expect(container.querySelector('[role="dialog"] p')?.textContent).toBe('Delete OpenClaw automation “Nightly A”? This removes the job from OpenClaw only; native automation history and workspaces are not changed.')
  const callsBeforeCancel = rig.calls.length
  await clickButton(container, 'Cancel')
  await settle()
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  expect(rig.calls).toHaveLength(callsBeforeCancel)
  expectNoRawStateClasses(container)
})
