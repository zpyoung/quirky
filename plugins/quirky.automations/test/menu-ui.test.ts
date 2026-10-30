import { afterAll, afterEach, expect, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import {
  API,
  type AutomationEditorData,
  type AutomationNavigation,
  type AutomationSurfaceProps,
  type ExternalListResult,
  type ExternalManager
} from '../src/ui-contracts'
import type { AutomationDefinition } from '../types'

const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
GlobalRegistrator.register()
actGlobal.IS_REACT_ACT_ENVIRONMENT = true

// React reads DOM and act support during module initialization, so these imports must follow registration.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AutomationsPage } = await import('../src/list/AutomationsPage')
const { ToolPanelFrame } = await import('@quirky/ui')

const AUTOMATION_ID = 'automation-paused'
const EXTERNAL_JOB_ID = 'openclaw-job-1'
const editorData: AutomationEditorData = {
  hosts: [{ id: 'local', label: 'Local', available: true }],
  projects: [{ id: 'repo-1', name: 'Repository', hostId: 'local', path: '/repo-1', kind: 'git' }],
  workspaces: [{ id: 'workspace-1', repoId: 'repo-1', name: 'Main workspace', path: '/repo-1/workspace', isMain: false }],
  agents: [],
  errors: []
}
const mounted: { container: HTMLElement; root: Root }[] = []

type ChangeListener = (event: QuirkyEvent) => void | Promise<void>
type CallRecord = { method: string; params: Record<string, unknown> }
type MenuKind = 'native' | 'external'

function definition(): AutomationDefinition {
  return {
    id: AUTOMATION_ID,
    name: 'Paused weekly review',
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
    enabled: false,
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

function localOpenClawManager(): ExternalManager {
  return {
    id: 'openclaw:local',
    provider: 'openclaw',
    hostId: 'local',
    label: 'Local OpenClaw',
    status: 'ready',
    canManage: true,
    error: null,
    jobs: [{
      id: EXTERNAL_JOB_ID,
      name: 'Local OpenClaw review',
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
    owner: { provider: 'openclaw', hostId: 'local', generation: 'local-generation-1' }
  }
}

function makeContext(options: { definitions?: AutomationDefinition[]; managers?: ExternalManager[] } = {}) {
  const definitions = options.definitions ?? [definition()]
  const externalResult: ExternalListResult = { managers: options.managers ?? [] }
  const calls: CallRecord[] = []
  const listeners = new Set<ChangeListener>()
  const context = {
    pluginId: 'quirky.automations',
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === `${API}list`) return definitions
      if (method === `${API}editorData`) return editorData
      if (method === `${API}externalList`) return externalResult
      if (method === `${API}show`) {
        const id = typeof params.id === 'string' ? params.id : definitions[0]?.id
        return definitions.find((candidate) => candidate.id === id) ?? null
      }
      if (method === `${API}target`) return { available: true }
      if (method === `${API}setting.get`) return { value: true }
      if (method === `${API}runs`) return { runs: [], nextCursor: null }
      return null
    },
    subscribe: (listener: ChangeListener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    openView: () => {}
  } as unknown as UiPluginContext
  return { context, calls, listeners }
}

function fixtureFor(kind: MenuKind) {
  return kind === 'native'
    ? makeContext({ definitions: [definition()] })
    : makeContext({ definitions: [], managers: [localOpenClawManager()] })
}

function navigation(page: AutomationNavigation['page'], patch: Partial<AutomationNavigation> = {}): AutomationNavigation {
  return {
    page,
    automationId: page === 'detail' ? AUTOMATION_ID : null,
    runId: null,
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
    ...patch
  }
}

async function mountPage(
  context: UiPluginContext,
  page: AutomationNavigation['page'],
  options: { navigation?: Partial<AutomationNavigation>; refresh?: () => Promise<void> } = {}
) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  const reports: unknown[] = []
  let revision = 0
  const render = async (nextPage: AutomationNavigation['page'], patch: Partial<AutomationNavigation> = {}) => {
    revision++
    const props: AutomationSurfaceProps = {
      context,
      state: { revision, navigation: navigation(nextPage, patch), editor: null },
      refresh: options.refresh ?? (async () => {}),
      notify: () => {},
      report: (state) => reports.push(state)
    }
    await act(async () => root.render(createElement(ToolPanelFrame, { title: 'Automations', children: createElement(AutomationsPage, props) })))
  }
  await render(page, options.navigation)
  return { container, reports, render }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === label)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button with aria-label: ${label}`)
  return button
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`)
  return button
}

function menuItem(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing menu item: ${text}`)
  return button
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.click())
}

function dispatchKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function reportedMenuKey(reports: readonly unknown[]): unknown {
  const latest = reports.at(-1)
  return typeof latest === 'object' && latest !== null
    ? (latest as Record<string, unknown>).openMenuKey
    : undefined
}

function menuSideEffects(calls: readonly CallRecord[]): CallRecord[] {
  const methods = new Set([
    `${API}run`, `${API}edit`, `${API}remove`, `${API}externalAction`, `${API}uiNavigate`, `${API}setting.set`
  ])
  return calls.filter(({ method }) => methods.has(method))
}

async function openMenu(kind: MenuKind, refresh?: () => Promise<void>) {
  const rig = fixtureFor(kind)
  const page = await mountPage(rig.context, 'list', { refresh })
  await settle()
  const label = kind === 'native' ? 'Automation actions' : 'External automation actions'
  const trigger = buttonByLabel(page.container, label)
  await click(trigger)
  await settle()
  expect(page.container.querySelector('[role="menu"]')).not.toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  return { rig, page, trigger }
}

async function assertEscapeDismissesMenu(kind: MenuKind): Promise<void> {
  const { rig, page, trigger } = await openMenu(kind)
  const menu = page.container.querySelector<HTMLElement>('[role="menu"]')
  if (!menu) throw new Error('Expected the row action menu to be open')
  const item = menu.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
  if (!item) throw new Error('Expected an enabled menu item')
  await act(async () => item.focus())
  expect(document.activeElement).toBe(item)

  const effectsBeforeEscape = menuSideEffects(rig.calls)
  let event!: KeyboardEvent
  await act(async () => { event = dispatchKey(item, 'Escape') })
  await settle()

  expect(page.container.querySelector('[role="menu"]')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
  expect(event.defaultPrevented).toBe(true)
  expect(page.container.querySelector('main[aria-label="Automations"]')).not.toBeNull()
  expect(menuSideEffects(rig.calls)).toEqual(effectsBeforeEscape)
  expect(reportedMenuKey(page.reports)).toBeNull()

  await click(trigger)
  expect(page.container.querySelector('[role="menu"]')).not.toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
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

test('Escape dismisses a native row menu and restores its exact trigger without acting or navigating', async () => {
  await assertEscapeDismissesMenu('native')
})

test('Escape dismisses a local OpenClaw row menu and restores its exact trigger without an external action', async () => {
  await assertEscapeDismissesMenu('external')
})

async function assertRefreshDismissesMenu(kind: MenuKind): Promise<void> {
  const { promise: refreshPromise, resolve: finishRefresh } = Promise.withResolvers<void>()
  let refreshCalls = 0
  const refresh = () => {
    refreshCalls++
    return refreshPromise
  }
  const { page, trigger } = await openMenu(kind, refresh)
  let menuClosedBeforeRefreshResolved = false
  await click(buttonByLabel(page.container, 'Refresh automations'))
  menuClosedBeforeRefreshResolved = page.container.querySelector('[role="menu"]') === null
  await act(async () => { finishRefresh() })
  await settle()

  expect(refreshCalls).toBe(1)
  expect(menuClosedBeforeRefreshResolved).toBe(true)
  expect(page.container.querySelector('[role="menu"]')).toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(reportedMenuKey(page.reports)).toBeNull()
}

test('explicit Refresh closes a native row menu before refresh work completes', async () => {
  await assertRefreshDismissesMenu('native')
})

test('explicit Refresh closes a local OpenClaw row menu before refresh work completes', async () => {
  await assertRefreshDismissesMenu('external')
})

test('Escape and detail arrow keys keep their existing navigation when no row menu is open', async () => {
  const rig = makeContext({ definitions: [definition()] })
  const page = await mountPage(rig.context, 'detail', { navigation: { tab: 'runs' } })
  await settle()
  expect(page.container.querySelector('[role="menu"]')).toBeNull()
  const selectedTab = page.container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
  if (!selectedTab) throw new Error('Expected the active shared detail tab')
  const navigationsBeforeArrow = rig.calls.filter(({ method }) => method === `${API}uiNavigate`).length

  await act(async () => { dispatchKey(selectedTab, 'ArrowLeft') })
  await settle()
  expect(rig.calls.filter(({ method }) => method === `${API}uiNavigate`)).toHaveLength(navigationsBeforeArrow + 1)
  expect(rig.calls.filter(({ method }) => method === `${API}uiNavigate`).at(-1)?.params).toEqual({ tab: 'overview' })

  await act(async () => { dispatchKey(document.body, 'Escape') })
  await settle()
  expect(rig.calls.filter(({ method }) => method === `${API}uiNavigate`).at(-1)?.params).toEqual({
    page: 'list', automationId: null, runId: null, tab: 'overview'
  })
})

async function assertConfirmationOwnsEscape(kind: MenuKind): Promise<void> {
  const { rig, page, trigger } = await openMenu(kind)
  await click(buttonByText(page.container, 'Delete'))
  await settle()
  const dialog = page.container.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog).not.toBeNull()
  if (!dialog) throw new Error('Expected the delete confirmation to be open')

  const expandedBeforeEscape = trigger.getAttribute('aria-expanded')
  const menuKeyBeforeEscape = reportedMenuKey(page.reports)
  const effectsBeforeEscape = menuSideEffects(rig.calls)
  const cancel = buttonByText(dialog, 'Cancel')
  await act(async () => cancel.focus())
  let event!: KeyboardEvent
  await act(async () => { event = dispatchKey(cancel, 'Escape') })
  await settle()

  expect(page.container.querySelector('[role="dialog"]')).not.toBeNull()
  expect(trigger.getAttribute('aria-expanded')).toBe(expandedBeforeEscape)
  expect(reportedMenuKey(page.reports)).toBe(menuKeyBeforeEscape)
  expect(menuSideEffects(rig.calls)).toEqual(effectsBeforeEscape)
  expect(event.cancelBubble).toBe(true)

  await click(cancel)
  expect(page.container.querySelector('[role="dialog"]')).toBeNull()
}

test('Escape inside a native delete confirmation stays owned by the confirmation', async () => {
  await assertConfirmationOwnsEscape('native')
})

test('Escape inside a local OpenClaw delete confirmation stays owned by the confirmation', async () => {
  await assertConfirmationOwnsEscape('external')
})
