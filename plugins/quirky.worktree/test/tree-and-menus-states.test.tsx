import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ProjectGroup, QuirkyEvent, Repo, Session, UiPluginContext, WorktreeAutomationProvenance } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import type { ActivityPreferencePatch } from '../src/useSidebarActivity'
import type { AutomationAvailabilitySnapshot } from '../src/report'
import type { KeptBranch } from '../src/actions'
import type { Tree as TreeComponent, TreeProps } from '../src/Tree'
import type { ExternalInbox as ExternalInboxComponent } from '../src/ExternalInbox'
import type { Notices as NoticesComponent } from '../src/Notices'
import type { OrchestrationRows as OrchestrationRowsComponent, OrchestrationWorkerRow } from '../src/OrchestrationRows'
import type { useSidebarActivity as UseSidebarActivity } from '../src/useSidebarActivity'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES } from '../src/view-types'
import { buildTree } from '../src/view-model'



const repo: Repo = { id: 'repo-1', name: 'repo', path: '/repo', addedAt: 1, kind: 'git', displayName: null, groupId: null }
const provenance: WorktreeAutomationProvenance = {
  kind: 'created-by-automation', automationId: 'automation-1', automationName: 'Automation',
  runId: 'run-1', runTitle: 'Automation run', projectId: 'project-1', hostId: 'local'
}
const preferences = { ...DEFAULT_ACTIVITY_PREFERENCES }

type Call = { method: string; params: Record<string, unknown> }
type Toast = { title: string; body: string }
type Fake = {
  context: UiPluginContext
  calls: Call[]
  toasts: Toast[]
  emit(type: string): Promise<void>
}
type CallHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
type EventListener = (event: QuirkyEvent) => void | Promise<void>

function fakeContext(callHandler?: CallHandler): Fake {
  const calls: Call[] = []
  const toasts: Toast[] = []
  const listeners = new Set<EventListener>()
  const context = {
    pluginId: 'quirky.worktree',
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (callHandler) return callHandler(method, params)
      return method === 'plugin.list' ? [] : []
    },
    toast(title: string, body: string) { toasts.push({ title, body }) },
    log() {},
    subscribe(listener: EventListener) { listeners.add(listener); return () => void listeners.delete(listener) },
    onConnection() { return () => {} },
    openView() {}
  } as unknown as UiPluginContext
  return {
    context,
    calls,
    toasts,
    async emit(type: string) {
      await Promise.all([...listeners].map((listener) => listener({ type, data: {} } as QuirkyEvent)))
    }
  }
}

let Tree: typeof TreeComponent
let ExternalInbox: typeof ExternalInboxComponent
let Notices: typeof NoticesComponent
let OrchestrationRows: typeof OrchestrationRowsComponent
let useSidebarActivity: typeof UseSidebarActivity
let createRoot: typeof CreateRoot
let root: Root | null = null
let host: HTMLElement
let setPreferences!: (patch: ActivityPreferencePatch) => Promise<boolean>

// The rendered modules are loaded dynamically after happy-dom installs browser globals.

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Tree = (await import('../src/Tree')).Tree
  ExternalInbox = (await import('../src/ExternalInbox')).ExternalInbox
  Notices = (await import('../src/Notices')).Notices
  OrchestrationRows = (await import('../src/OrchestrationRows')).OrchestrationRows
  useSidebarActivity = (await import('../src/useSidebarActivity')).useSidebarActivity
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host.remove()
})

async function render(element: ReactNode): Promise<void> {
  if (!root) root = createRoot(host)
  await act(async () => root!.render(element))
  await flush()
}


async function flush(): Promise<void> {
  await act(async () => { for (let index = 0; index < 10; index++) await Promise.resolve() })
}

function clickButton(label: string, within: ParentNode = host): Promise<void> {
  const button = [...within.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!button) throw new Error(`button not found: ${label}`)
  return act(async () => {
    button.click()
    for (let index = 0; index < 8; index++) await Promise.resolve()
  })
}

function worktree(extra: Partial<WorktreeControl> = {}): WorktreeControl {
  return {
    id: 'wt-auto', repoId: repo.id, path: '/repo/wt-auto', branch: 'auto', head: 'abc', isMain: false,
    name: 'auto', instanceId: 'instance-auto', kind: 'git', displayName: null, comment: '', status: 'in-progress',
    pinned: false, unread: false, parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false,
    removing: false, groupId: null, projectGroupId: null, lastActivityAt: 1, manualOrder: 0, sleeping: false,
    sleepChangedAt: null, references: [], archivedAt: null,
    cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
    externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false, tagIds: [],
    automationProvenance: provenance, ...extra
  } as WorktreeControl
}

function availability(
  definition: AutomationAvailabilitySnapshot['definition'],
  runHistory: AutomationAvailabilitySnapshot['runHistory']
): AutomationAvailabilitySnapshot {
  return { worktreeId: 'wt-auto', automationId: provenance.automationId, runId: provenance.runId, definition, runHistory }
}

function treeProps(context: UiPluginContext, snapshot: AutomationAvailabilitySnapshot): TreeProps {
  const rows = [worktree()]
  const repos = [repo]
  const groups: ProjectGroup[] = []
  const model = buildTree({
    worktrees: rows,
    repos,
    groups,
    tags: [],
    spec: allSpecFromStock(DEFAULT_STOCK_OPTIONS, preferences),
    viewId: 'all',
    projection: null,
    marks: new Map(),
    checks: new Map()
  })
  return {
    context,
    model,
    tagsById: new Map(),
    rowFact: 'last-activity',
    repos,
    groups,
    sessions: [],
    selectedId: null,
    automationExpandedId: 'wt-auto',
    automationAvailability: snapshot,
    onToggleAutomationDetails() {},
    now: 10_000_000,
    separatorEnabled: false,
    options: DEFAULT_STOCK_OPTIONS,
    allWorktrees: rows,
    canShowSleeping: () => true,
    statusDefinitions: [{ id: 'todo', label: 'To do' }] as TreeProps['statusDefinitions'],
    projectIdentities: {},
    openDialog() {},
    requestDelete() {},
    onDropPreviewChange() {},
    onSeparatorStateChange() {}
  }
}

async function renderTree(fake: Fake, snapshot: AutomationAvailabilitySnapshot): Promise<void> {
  await render(createElement<TreeProps>(Tree, treeProps(fake.context, snapshot)))
}

function findButton(label: string, within: ParentNode = host): HTMLButtonElement | undefined {
  return [...within.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label)
}

test('automation checking uses the shared notice and disappears when both lookups settle', async () => {
  const fake = fakeContext()
  for (const snapshot of [availability('checking', 'available'), availability('available', 'checking')]) {
    await renderTree(fake, snapshot)
    const checking = host.querySelector<HTMLElement>('.automation-detail [role="status"]')
    expect(checking?.tagName).toBe('DIV')
    expect(checking?.querySelector('.ui-notice-line')).not.toBeNull()
    expect(checking?.textContent ?? '').toContain('Checking automation availability...')

  }

  await renderTree(fake, availability('available', 'available'))
  expect(host.querySelector('.automation-detail .ui-notice-line')).toBeNull()
  expect(host.querySelector('.automation-detail [role="status"]')?.textContent).toContain('Automation available.')
})

test('automation lookup errors and mixed missing states stay independent', async () => {
  const fake = fakeContext()
  const cases = [
    { definition: 'available', runHistory: 'error', alert: true, automation: false, run: true, copy: ['Automation available.'], absent: ['Run history no longer available.'] },
    { definition: 'error', runHistory: 'available', alert: true, automation: true, run: false, copy: ['Run history available.'], absent: ['Automation no longer available.'] },
    { definition: 'error', runHistory: 'error', alert: true, automation: true, run: true, copy: [], absent: ['Automation no longer available.', 'Run history no longer available.'] },
    { definition: 'missing', runHistory: 'available', alert: false, automation: true, run: false, copy: ['Automation no longer available.', 'Run history available.'], absent: ['Run history no longer available.'] },
    { definition: 'missing', runHistory: 'error', alert: true, automation: true, run: true, copy: ['Automation no longer available.'], absent: ['Run history no longer available.'] }
  ] as const

  for (const item of cases) {
    await renderTree(fake, availability(item.definition, item.runHistory))
    const detail = host.querySelector<HTMLElement>('.automation-detail')!
    const text = detail.textContent ?? ''
    for (const copy of item.copy) expect(text).toContain(copy)
    for (const copy of item.absent) expect(text).not.toContain(copy)
    expect(Boolean(detail.querySelector('[role="alert"]'))).toBe(item.alert)
    if (item.alert) expect(detail.querySelector('[role="alert"]')?.textContent).toBe('Automation availability could not be checked.')
    expect(findButton('Open automation', detail)?.disabled).toBe(item.automation)
    expect(findButton('Open run', detail)?.disabled).toBe(item.run)
  }
})

test('automation plugin unavailability keeps its advisory diagnostic', async () => {
  const fake = fakeContext()
  await renderTree(fake, availability('unavailable', 'available'))
  expect(host.querySelector('.automation-detail')?.textContent).toContain('Automations plugin unavailable.')
  expect(host.querySelector('.automation-detail [role="alert"]')).toBeNull()
  expect(findButton('Open automation')?.disabled).toBe(true)
  expect(findButton('Open run')?.disabled).toBe(false)
})

const hiddenExternal = worktree({
  id: 'external-wt', name: 'External worktree', createdBy: 'external', externalVisible: false, externalVisibility: 'hide'
})

test('empty external inbox, kept notices, and orchestration rows render nothing', async () => {
  const fake = fakeContext()
  await render(createElement('div', null,
    createElement(ExternalInbox, { context: fake.context, repos: [], worktrees: [] }),
    createElement(Notices, { context: fake.context, kept: [], onDismiss() {} }),
    createElement(OrchestrationRows, { context: fake.context, workers: [], sessions: [], worktreeId: 'wt-auto' })
  ))
  expect(host.querySelector('[aria-label="Hidden external worktrees"]')).toBeNull()
  expect(host.querySelector('[aria-label="Kept branches"]')).toBeNull()
  expect(host.querySelector('[aria-label="Orchestration workers"]')).toBeNull()
  expect(host.textContent).toBe('')
})

test('external inbox failures toast for metadata updates and suppression', async () => {
  const fake = fakeContext(async (method) => { throw new Error(`failed ${method}`) })
  await render(createElement(ExternalInbox, { context: fake.context, repos: [repo], worktrees: [hiddenExternal] }))
  await clickButton('Show in worktree list')
  await clickButton('Don’t show again')
  expect(fake.toasts).toEqual([
    { title: 'Could not show external worktrees', body: 'failed quirky.worktree/setProjectMetadata' },
    { title: 'Could not hide external worktree review', body: 'failed quirky.worktree/suppressExternalInbox' }
  ])
})

const kept: KeptBranch = { repoId: repo.id, branch: 'kept-branch', head: 'deadbeef' }

test('kept branch notices preserve status copy and both actions', async () => {
  const fake = fakeContext()
  const dismissed: KeptBranch[] = []
  await render(createElement(Notices, { context: fake.context, kept: [kept], onDismiss: (item: KeptBranch) => dismissed.push(item) }))
  expect(host.querySelector('[aria-label="Kept branches"] [role="status"]')?.textContent)
    .toContain("Kept branch kept-branch because it isn't merged.")
  await clickButton('Dismiss')
  expect(dismissed).toEqual([kept])

  await clickButton('Delete branch')
  expect(fake.calls).toContainEqual({
    method: 'quirky.worktree/deleteBranch',
    params: { repo: repo.id, branch: kept.branch, head: kept.head, yes: true }
  })
  expect(dismissed).toEqual([kept, kept])
})

test('kept branch deletion failures remain visible as error toasts', async () => {
  const fake = fakeContext(async () => { throw new Error('branch moved') })
  await render(createElement(Notices, { context: fake.context, kept: [kept], onDismiss() {} }))
  await clickButton('Delete branch')
  expect(fake.toasts).toEqual([{ title: 'Could not delete branch', body: 'branch moved' }])
})

function workerRow(): OrchestrationWorkerRow {
  return {
    dispatchId: 'dispatch-1', taskId: 'task-1', runId: 'run-1', workerState: 'ready', currentAssignment: true,
    taskTitle: 'Task title', displayName: 'Agent label', coordinatorSessionId: 'coordinator-session',
    parentSessionId: 'coordinator-session', dispatchStatus: 'dispatched', agentTerminalHandle: 'worker-session',
    terminalState: 'active',
    resource: {
      ownerDispatchId: 'dispatch-1', ownershipState: 'owned', releaseState: 'not_requested',
      worktreeId: 'wt-auto', sessionId: 'worker-session'
    },
    projection: {
      workspace: { id: 'wt-auto' },
      liveness: { status: 'live', reason: null },
      evidence: { liveStatus: 'fresh', lastObservedAt: new Date().toISOString() },
      stage: { activity: 'working' }
    }
  } as OrchestrationWorkerRow
}

const workerSession: Session = {
  id: 'worker-session', kind: 'terminal', agent: 'claude', worktreeId: 'wt-auto', cwd: '/repo/wt-auto',
  title: 'Worker terminal', status: 'running', createdAt: 1, lastActivityAt: 1,
  exitCode: null, exitSignal: null, exitCause: null, restorable: false
}

async function renderWorker(fake: Fake, row = workerRow()): Promise<void> {
  await render(createElement(OrchestrationRows, {
    context: fake.context, workers: [row], sessions: [workerSession], worktreeId: 'wt-auto'
  }))
}

test('orchestration rows toast when a task no longer has an inspectable assignment', async () => {
  const fake = fakeContext(async () => ({}))
  await renderWorker(fake)
  await clickButton('Open Agent label terminal')
  expect(fake.toasts).toEqual([{
    title: 'Could not open worker', body: 'The task no longer has a current inspectable assignment.'
  }])
})

test('orchestration rows toast when the task dispatch changed', async () => {
  const fake = fakeContext(async () => ({
    taskId: 'task-1', dispatchId: 'dispatch-new', sessionId: 'worker-session', worktreeId: 'wt-auto'
  }))
  await renderWorker(fake)
  await clickButton('Open Agent label terminal')
  expect(fake.toasts).toEqual([{
    title: 'Could not open worker terminal', body: 'The task assignment changed; refresh the sidebar before opening its terminal.'
  }])
})

test('orchestration terminal lookup failures toast the RPC error', async () => {
  const fake = fakeContext(async () => { throw new Error('terminal lookup failed') })
  await renderWorker(fake)
  await clickButton('Open Agent label terminal')
  expect(fake.toasts).toEqual([{ title: 'Could not open worker terminal', body: 'terminal lookup failed' }])
})

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function SidebarActivityProbe({ context }: { context: UiPluginContext }) {
  const state = useSidebarActivity(context, null, true)
  setPreferences = state.setPreferences
  return createElement('output', { 'data-status': state.status })
}

test('a stale sidebar preference update failure stays visible as an error toast', async () => {
  const update = deferred<unknown>()
  const projection = {
    preferences,
    visibleIds: [], hiddenIds: [], hiddenCount: 0, filterCount: 0,
    automationHiddenIds: [], automationHiddenCount: 0, reviewHiddenIds: [], reviewHiddenCount: 0, workspaces: []
  }
  const fake = fakeContext((method) => {
    if (method === 'quirky.sidebar-extras/state' || method === 'quirky.sidebar-extras/activate') return { preferences }
    if (method === 'quirky.sidebar-extras/projection') return projection
    if (method === 'quirky.sidebar-extras/set') return update.promise
    return []
  })
  await render(createElement(SidebarActivityProbe, { context: fake.context }))
  expect(host.querySelector('output')?.getAttribute('data-status')).toBe('available')

  const updating = setPreferences({ hideAutomationCreated: true })
  await act(async () => {
    await fake.emit('quirky.worktree/changed')
    for (let index = 0; index < 10; index++) await Promise.resolve()
  })

  await act(async () => {
    update.reject(new Error('preference write failed'))
    await updating
  })
  expect(fake.toasts).toEqual([{
    title: 'Could not update workspace activity filters', body: 'preference write failed'
  }])
})
