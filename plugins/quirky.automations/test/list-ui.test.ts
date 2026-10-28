import { afterAll, afterEach, expect, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { API, type AutomationNavigation, type AutomationSurfaceProps } from '../src/ui-contracts'
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
const RUN_ID = 'run-background'
const editorData = { hosts: [], projects: [], workspaces: [], agents: [], errors: [] }
const mounted: { container: HTMLElement; root: Root }[] = []

type ChangeListener = (event: QuirkyEvent) => void | Promise<void>

function definition(name: string, id = AUTOMATION_ID): AutomationDefinition {
  return {
    id,
    name,
    prompt: 'Review the requested change.',
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
    id: RUN_ID,
    automationId: AUTOMATION_ID,
    title: 'Background run',
    runNumber: 1,
    scheduledFor: 1_000,
    trigger: 'scheduled',
    status: 'dispatched',
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
    createdAt: 10_000 - index,
    status: 'completed'
  })
}

function navigation(page: AutomationNavigation['page'], patch: Partial<AutomationNavigation> = {}): AutomationNavigation {
  return {
    page,
    automationId: AUTOMATION_ID,
    runId: page === 'run' ? RUN_ID : null,
    tab: 'runs',
    query: '',
    host: 'all',
    status: 'all',
    lastRun: 'all',
    agent: 'all',
    sort: 'name',
    direction: 'asc',
    runQuery: '',
    runStatus: 'all',
    ...patch
  }
}

function makeContext(initialDefinition: AutomationDefinition, initialRuns: AutomationRun[]) {
  let currentDefinition = initialDefinition
  let currentRuns = initialRuns
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const listeners = new Set<ChangeListener>()
  const deferredRunPages = new Map<string, Promise<AutomationRunsPage>>()
  const context = {
    pluginId: 'quirky.automations',
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === `${API}list`) return [currentDefinition]
      if (method === `${API}editorData`) return editorData
      if (method === `${API}externalList`) return { managers: [] }
      if (method === `${API}show`) return currentDefinition
      if (method === `${API}target`) return { available: true }
      if (method === `${API}runs`) {
        const automationId = typeof params.automationId === 'string' ? params.automationId : AUTOMATION_ID
        const cursor = typeof params.cursor === 'string' ? params.cursor : ''
        const key = `${automationId}:${cursor}`
        const deferred = deferredRunPages.get(key)
        if (deferred) {
          deferredRunPages.delete(key)
          return deferred
        }
        const limit = typeof params.limit === 'number' ? params.limit : 25
        const offset = cursor === '' ? 0 : Number(cursor)
        const filteredRuns = currentRuns.filter((candidate) => candidate.automationId === automationId)
        const runs = filteredRuns.slice(offset, offset + limit)
        const nextOffset = offset + runs.length
        return { runs, nextCursor: nextOffset < filteredRuns.length ? String(nextOffset) : null } satisfies AutomationRunsPage
      }
      return null
    },
    subscribe: (listener: ChangeListener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    openView: () => {}
  } as unknown as UiPluginContext
  return {
    context,
    calls,
    listeners,
    setDefinition(value: AutomationDefinition) { currentDefinition = value },
    setRuns(value: AutomationRun[]) { currentRuns = value },
    deferRunPage(automationId: string, cursor: string) {
      const deferred = Promise.withResolvers<AutomationRunsPage>()
      deferredRunPages.set(`${automationId}:${cursor}`, deferred.promise)
      return deferred.resolve
    },
    async emitChanged() {
      await act(async () => {
        for (const listener of [...listeners]) await listener({ type: `${API}changed`, data: { automationId: AUTOMATION_ID } } as QuirkyEvent)
      })
    }
  }
}

async function mountPage(context: UiPluginContext, page: AutomationNavigation['page'], automationId = AUTOMATION_ID) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  let revision = 0
  const render = async (nextPage: AutomationNavigation['page'], nextAutomationId = automationId) => {
    revision++
    const props: AutomationSurfaceProps = {
      context,
      state: { revision, navigation: navigation(nextPage, { automationId: nextAutomationId }), editor: null },
      refresh: async () => {},
      notify: () => {}
    }
    await act(async () => root.render(createElement(AutomationsPage, props)))
  }
  await render(page)
  return { container, render }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`)
  return button
}

function historyRows(container: HTMLElement): HTMLTableRowElement[] {
  return [...container.querySelectorAll<HTMLTableRowElement>('table[aria-label="Run history"] tbody tr')]
}

async function clickButton(container: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    buttonByText(container, text).click()
  })
}

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT
  else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})
afterEach(async () => {
  await act(async () => {
    for (const { root, container } of mounted.splice(0)) {
      root.unmount()
      container.remove()
    }
  })
})

test('a native change event refreshes saved definitions and background-completed run evidence', async () => {
  const initialRun = run()
  const rig = makeContext(definition('Saved draft'), [initialRun])
  const { container } = await mountPage(rig.context, 'run')
  await settle()

  expect(container.textContent).not.toContain('Background completion output')
  rig.setDefinition(definition('Saved definition'))
  rig.setRuns([run({
    status: 'completed',
    completedAt: 2_000,
    outputSnapshot: { format: 'plain_text', content: 'Background completion output', capturedAt: 2_000, truncated: false },
    usage: { status: 'known', estimatedCostUsd: 0.42, totalTokens: 240 }
  })])
  await rig.emitChanged()
  await settle()

  expect(container.textContent).toContain('Saved definition')
  expect(container.textContent).toContain('Background completion output')
  expect(container.textContent).toContain('Done')
  expect(rig.calls.filter(({ method }) => method === `${API}list`).length).toBeGreaterThan(1)
})

test('loaded history beyond 100 rows remains reachable and Show newer returns to its prior offset', async () => {
  const runs = Array.from({ length: 125 }, (_, index) => historyRun(index))
  const rig = makeContext(definition('History owner'), runs)
  const { container } = await mountPage(rig.context, 'detail')
  await settle()

  for (let page = 0; page < 4; page++) {
    await clickButton(container, 'Load older runs')
    await settle()
  }

  let rows = historyRows(container)
  expect(rows).toHaveLength(100)
  expect(rows[0]?.textContent).toContain('History 025')
  expect(rows.at(-1)?.textContent).toContain('History 124')
  expect(container.textContent).not.toContain('History 000')

  await clickButton(container, 'Show newer runs')
  rows = historyRows(container)
  expect(rows).toHaveLength(100)
  expect(rows[0]?.textContent).toContain('History 000')
  expect(rows.at(-1)?.textContent).toContain('History 099')
  expect(container.textContent).not.toContain('History 124')

  await clickButton(container, 'Show older runs')
  rows = historyRows(container)
  expect(rows).toHaveLength(100)
  expect(rows[0]?.textContent).toContain('History 025')
  expect(rows.at(-1)?.textContent).toContain('History 124')
})

test('an older history response cannot overwrite the newly selected automation', async () => {
  const automationA = 'automation-a'
  const automationB = 'automation-b'
  const runsA = Array.from({ length: 30 }, (_, index) => historyRun(index, automationA))
  const rig = makeContext(definition('Automation A', automationA), runsA)
  const page = await mountPage(rig.context, 'detail', automationA)
  await settle()

  const resolveOlderA = rig.deferRunPage(automationA, '25')
  await clickButton(page.container, 'Load older runs')
  rig.setDefinition(definition('Automation B', automationB))
  rig.setRuns([historyRun(0, automationB)])
  await page.render('detail', automationB)
  await settle()
  expect(historyRows(page.container)[0]?.textContent).toContain('History 000')

  await act(async () => {
    resolveOlderA({ runs: [historyRun(25, automationA)], nextCursor: null })
  })
  await settle()

  expect(historyRows(page.container)).toHaveLength(1)
  expect(historyRows(page.container)[0]?.textContent).toContain('History 000')
  expect(historyRows(page.container).some((row) => row.textContent?.includes('History 025'))).toBe(false)
})
