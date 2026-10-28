import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { QuirkyEvent, Session, UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OrchestrationRows, type OrchestrationWorkerRow } from '../src/OrchestrationRows'
import { useOrchestrationRows } from '../src/useOrchestrationRows'

const SESSION_VIEW = 'view:quirky.session/worktree'
const RESOURCE = {
  ownerDispatchId: 'dispatch-1',
  ownershipState: 'owned',
  releaseState: 'not_requested',
  worktreeId: 'wt-main',
  sessionId: 'worker-session-1'
} as const
const PROJECTION = {
  workspace: { id: 'wt-main' },
  liveness: { status: 'live', reason: null },
  evidence: { liveStatus: 'fresh', lastObservedAt: new Date().toISOString() },
  stage: { activity: 'working' }
} as const

type RowOverrides = Omit<Partial<OrchestrationWorkerRow>, 'projection'> & {
  projection?: Partial<OrchestrationWorkerRow['projection']>
}

function workerRow(overrides: RowOverrides = {}): OrchestrationWorkerRow {
  const { projection, ...fields } = overrides
  return {
    dispatchId: 'dispatch-1',
    taskId: 'task-1',
    runId: 'run-1',
    workerState: 'ready',
    currentAssignment: true,
    taskTitle: 'Task title',
    displayName: 'Agent label',
    coordinatorSessionId: 'coordinator-session',
    parentSessionId: 'coordinator-session',
    dispatchStatus: 'dispatched',
    agentTerminalHandle: 'worker-session-1',
    terminalState: 'active',
    resource: { ...RESOURCE },
    ...fields,
    projection: { ...PROJECTION, ...projection }
  }
}

function session(id: string, worktreeId: string, options: Partial<Session> = {}): Session {
  return {
    id,
    kind: 'terminal',
    agent: 'claude',
    worktreeId,
    cwd: `/work/${worktreeId}`,
    title: id,
    status: 'running',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false,
    ...options
  }
}

let host: HTMLElement
let root: Root | null = null
let intervals: Array<{ id: number; callback: () => void; delay: number; cleared: boolean }> = []
let realSetInterval: typeof globalThis.setInterval
let realClearInterval: typeof globalThis.clearInterval
const opened: Array<{ id: string; input?: unknown }> = []
const toasts: Array<{ title: string; body: string }> = []
let terminalResultOverride: unknown | Error | null = null
let terminalCalls: Array<{ method: string; params: Record<string, unknown> }> = []

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  opened.length = 0
  toasts.length = 0
  terminalCalls = []
  terminalResultOverride = null
  host = document.createElement('div')
  document.body.append(host)
  intervals = []
  realSetInterval = globalThis.setInterval
  realClearInterval = globalThis.clearInterval
  globalThis.setInterval = ((callback: () => void, delay = 0) => {
    const item = { id: intervals.length + 1, callback, delay, cleared: false }
    intervals.push(item)
    return item.id
  }) as typeof globalThis.setInterval
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    const item = intervals.find((entry) => entry.id === (id as unknown as number))
    if (item) item.cleared = true
  }) as typeof globalThis.clearInterval
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = null
  }
  host.remove()
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
})

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  root = createRoot(host)
  await act(async () => root?.render(element))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderRows(workers: readonly OrchestrationWorkerRow[], sessions: readonly Session[] | null, worktreeId = 'wt-main') {
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      terminalCalls.push({ method, params })
      if (method !== 'quirky.orchestration/taskTerminal') throw new Error(`unexpected public call ${method}`)
      if (terminalResultOverride instanceof Error) throw terminalResultOverride
      if (terminalResultOverride !== null) return terminalResultOverride
      const row = workers.find((candidate) => candidate.taskId === params.taskId && candidate.resource?.ownerDispatchId === candidate.dispatchId)
      if (!row?.resource) throw new Error('The task has no current terminal.')
      return { taskId: row.taskId, dispatchId: row.dispatchId, sessionId: row.resource.sessionId, worktreeId: row.resource.worktreeId }
    },
    toast: (title: string, body: string) => toasts.push({ title, body }),
    openView: (id: string, input?: unknown) => opened.push({ id, input })
  } as unknown as UiPluginContext
  return render(createElement(OrchestrationRows, { context, workers, sessions, worktreeId }))
}

function fakeContext() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const connections = new Set<(status: 'connected' | 'reconnecting') => void>()
  const pages: unknown[] = []
  let pluginState: 'active' | 'disabled' | 'inactive' | 'missing' = 'active'
  const context = {
    pluginId: 'quirky.worktree',
    log() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'plugin.list') {
        return pluginState === 'missing' ? [] : [{ id: 'quirky.orchestration', state: pluginState }]
      }
      if (method === 'quirky.orchestration/workerList') {
        const page = pages.shift()
        if (page === undefined) return { workers: [], page: { nextCursor: null, snapshotId: 'empty', total: 0 }, partialHostErrors: [] }
        return page
      }
      throw new Error(`unexpected public call ${method}`)
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onConnection(listener: (status: 'connected' | 'reconnecting') => void) {
      connections.add(listener)
      return () => void connections.delete(listener)
    }
  } as unknown as UiPluginContext
  return {
    context,
    calls,
    listeners,
    connections,
    pages,
    setPluginState(state: typeof pluginState) { pluginState = state },
    async emit(event: QuirkyEvent) {
      await Promise.all([...listeners].map((listener) => listener(event)))
    }
  }
}

function HookProbe({ context }: { context: UiPluginContext }) {
  const workers = useOrchestrationRows(context)
  return createElement('output', { 'data-count': workers.length }, workers.map((worker) => worker.displayName).join(','))
}

test('nests descendants under their creator, preserves fleet order, and caps visual depth', async () => {
  const child = workerRow({
    dispatchId: 'dispatch-child', taskId: 'task-child', taskTitle: 'Child task', displayName: 'Child agent',
    coordinatorSessionId: 'worker-session-1', parentSessionId: 'worker-session-1',
    agentTerminalHandle: 'worker-session-2',
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-child', sessionId: 'worker-session-2' },
    projection: { workspace: { id: 'wt-main' }, stage: { activity: 'waiting' } }
  })
  Object.assign(child.projection.stage, { detail: 'Internal stage detail' })
  const parent = workerRow({
    dispatchId: 'dispatch-parent', taskId: 'task-parent', taskTitle: 'Parent task', displayName: 'Parent agent',
    coordinatorSessionId: 'coordinator-session', parentSessionId: 'coordinator-session',
    agentTerminalHandle: 'worker-session-1',
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-parent' },
    projection: { stage: { activity: 'working' } }
  })
  const fallback = workerRow({
    dispatchId: 'dispatch-fallback', taskId: 'task-fallback', displayName: '', taskTitle: 'Fallback task title',
    parentSessionId: 'coordinator-session', agentTerminalHandle: 'worker-session-3',
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-fallback', sessionId: 'worker-session-3' }
  })
  await renderRows([child, parent, fallback], [session('coordinator-session', 'wt-main', { title: 'Coordinator' }), session('worker-session-1', 'wt-main'), session('worker-session-2', 'wt-main'), session('worker-session-3', 'wt-main')])

  const rows = [...host.querySelectorAll<HTMLButtonElement>('.orchestration-worker-row')]
  expect(host.querySelector('.orchestration-coordinator-row')?.textContent).toContain('Coordinator')
  expect(rows.map((row) => row.textContent)).toEqual(['Parent agent · Working', 'Child agent · Waiting', 'Fallback task title · Working'])
  expect(rows.map((row) => row.dataset.visualDepth)).toEqual(['1', '1', '1'])
  expect(host.textContent).not.toContain('Internal stage detail')
})

test('shows cross-workspace and orphaned workers in the actual worker workspace', async () => {
  const crossWorkspace = workerRow({
    dispatchId: 'dispatch-cross', taskId: 'task-cross', displayName: 'Cross-workspace child',
    coordinatorSessionId: 'missing-coordinator', parentSessionId: null,
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-cross', worktreeId: 'wt-child' },
    projection: { workspace: { id: 'wt-child' } }
  })
  await renderRows([crossWorkspace], [], 'wt-child')
  expect(host.textContent).toContain('Orphaned coordinator')
  expect(host.textContent).toContain('Cross-workspace child')
  await act(async () => root?.unmount())
  root = null
  host.replaceChildren()
  await renderRows([crossWorkspace], [], 'wt-main')
  expect(host.querySelector('.orchestration-worker-row')).toBeNull()
})

test('uses only the latest retry and exact resource owner for a reused terminal', async () => {
  const current = workerRow({
    dispatchId: 'dispatch-new', taskId: 'task-retried', displayName: 'Current assignment',
    agentTerminalHandle: 'reused-session', terminalState: 'retained',
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-new', sessionId: 'reused-session', ownershipState: 'user_owned', releaseState: 'retained' }
  })
  const obsoleteRetry = workerRow({
    dispatchId: 'dispatch-old', taskId: 'task-retried', displayName: 'Old retry label',
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-new', sessionId: 'reused-session', ownershipState: 'transferred', releaseState: 'retained' }
  })
  const reusedByAnotherTask = workerRow({
    dispatchId: 'dispatch-prior', taskId: 'task-prior', displayName: 'Prior terminal label',
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-new', sessionId: 'reused-session', ownershipState: 'transferred', releaseState: 'retained' }
  })
  const released = workerRow({
    dispatchId: 'dispatch-released', taskId: 'task-released', displayName: 'Released worker',
    terminalState: 'released',
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-released', ownershipState: 'released', releaseState: 'released' }
  })
  await renderRows([current, obsoleteRetry, reusedByAnotherTask, released], [session('reused-session', 'wt-main')])

  expect(host.querySelectorAll('.orchestration-worker-row')).toHaveLength(1)
  expect(host.textContent).toContain('Current assignment')
  expect(host.textContent).not.toContain('Old retry label')
  expect(host.textContent).not.toContain('Prior terminal label')
  expect(host.textContent).not.toContain('Released worker')
})

test('retains settled human-owned terminals with explicit custody and stale liveness never says working', async () => {
  const retained = workerRow({
    displayName: 'Human-owned agent', workerState: 'succeeded', terminalState: 'retained',
    resource: { ...RESOURCE, ownershipState: 'user_owned', releaseState: 'retained' },
    projection: {
      liveness: { status: 'unverifiable', reason: 'stale_status' },
      evidence: { liveStatus: 'stale', lastObservedAt: null },
      stage: { activity: 'working' }
    }
  })
  await renderRows([retained], [session('worker-session-1', 'wt-main')])

  expect(host.textContent).toContain('User-owned · retained')
  expect(host.textContent).toContain('Activity stale')
  expect(host.textContent).not.toContain('· Working')
  expect(host.textContent).toContain('Human-owned agent')
})

test('shows unverified workers with the actual terminal label, never their stale task label', async () => {
  const uncertain = workerRow({
    currentAssignment: false,
    displayName: 'Old task display name',
    taskTitle: 'Old task title'
  })
  const replacement = session('worker-session-1', 'wt-main', { title: 'Replacement terminal', agent: 'shell' })
  await renderRows([uncertain], [replacement])

  expect(host.textContent).toContain('Replacement terminal')
  expect(host.textContent).toContain('Assignment unverified')
  expect(host.textContent).not.toContain('Old task display name')
  expect(host.textContent).not.toContain('Old task title')
  expect(host.querySelector('.orchestration-worker-row')).toBeNull()
})

test('keeps an unverified worker inspectable when no current session can be found', async () => {
  const uncertain = workerRow({
    currentAssignment: false,
    workerState: null,
    displayName: 'Old task display name',
    taskTitle: 'Old task title',
    agentTerminalHandle: 'missing-session',
    resource: { ...RESOURCE, sessionId: 'missing-session' }
  })
  await renderRows([uncertain], [])

  expect(host.textContent).toContain('Worker assignment unverified')
  expect(host.textContent).not.toContain('Old task display name')
  expect(host.textContent).not.toContain('Old task title')
  expect(host.querySelector('.orchestration-worker-row')).toBeNull()
})

test('breaks cyclic lineage without duplicating or losing worker rows', async () => {
  const left = workerRow({
    dispatchId: 'dispatch-left', taskId: 'task-left', displayName: 'Left agent', parentSessionId: 'right-session',
    agentTerminalHandle: 'left-session', resource: { ...RESOURCE, ownerDispatchId: 'dispatch-left', sessionId: 'left-session' }
  })
  const right = workerRow({
    dispatchId: 'dispatch-right', taskId: 'task-right', displayName: 'Right agent', parentSessionId: 'left-session',
    agentTerminalHandle: 'right-session', resource: { ...RESOURCE, ownerDispatchId: 'dispatch-right', sessionId: 'right-session' }
  })
  await renderRows([left, right], [session('left-session', 'wt-main'), session('right-session', 'wt-main')])

  expect(host.querySelectorAll('.orchestration-worker-row')).toHaveLength(2)
  expect(host.textContent?.match(/Left agent/g)).toHaveLength(1)
  expect(host.textContent?.match(/Right agent/g)).toHaveLength(1)
})

test('structured workers stay visible without pretending to be terminals', async () => {
  const structured = workerRow({
    displayName: 'Structured agent', agentTerminalHandle: 'structured-session', resource: null,
    projection: { workspace: { id: 'wt-main' }, stage: { activity: 'waiting' } }
  })
  await renderRows([structured], [session('structured-session', 'wt-main', { kind: 'structured' })])

  expect(host.textContent).toContain('Structured agent')
  expect(host.querySelector('.orchestration-worker-row')).toBeNull()
  expect(host.querySelector('button[aria-label*="Structured agent"]')).toBeNull()
})

test('clicking a terminal re-proves task assignment before focusing the returned exact target', async () => {
  const worker = workerRow()
  await renderRows([worker], [session('worker-session-1', 'wt-main')])

  await act(async () => host.querySelector<HTMLButtonElement>('.orchestration-worker-row')!.click())
  await flush()

  expect(terminalCalls).toEqual([{ method: 'quirky.orchestration/taskTerminal', params: { taskId: 'task-1' } }])
  expect(opened).toEqual([{ id: SESSION_VIEW, input: { worktree: 'wt-main', session: 'worker-session-1' } }])
})

test('refuses to focus a stale row when taskTerminal resolves a newer retry', async () => {
  terminalResultOverride = { taskId: 'task-1', dispatchId: 'dispatch-new', sessionId: 'new-session', worktreeId: 'wt-main' }
  await renderRows([workerRow()], [session('worker-session-1', 'wt-main')])

  await act(async () => host.querySelector<HTMLButtonElement>('.orchestration-worker-row')!.click())
  await flush()

  expect(opened).toEqual([])
  expect(toasts.some((toast) => toast.body.includes('assignment changed'))).toBe(true)
})

test('loads every page from one bounded snapshot with one shared consumer', async () => {
  const api = fakeContext()
  const firstPageWorkers = Array.from({ length: 100 }, (_, index) => {
    const dispatchId = `dispatch-page-${index + 1}`
    return workerRow({
      dispatchId,
      taskId: `task-page-${index + 1}`,
      displayName: `Page ${index + 1}`,
      resource: {
        ...RESOURCE,
        ownerDispatchId: dispatchId,
        sessionId: `worker-session-${index + 1}`
      }
    })
  })
  const lastWorker = workerRow({
    dispatchId: 'dispatch-page-101',
    taskId: 'task-page-101',
    displayName: 'Page 101',
    resource: { ...RESOURCE, ownerDispatchId: 'dispatch-page-101', sessionId: 'worker-session-101' }
  })
  api.pages.push(
    { workers: firstPageWorkers, page: { nextCursor: 'cursor-1', snapshotId: 'snapshot-1', total: 101 }, partialHostErrors: [] },
    { workers: [lastWorker], page: { nextCursor: null, snapshotId: 'snapshot-1', total: 101 }, partialHostErrors: [] }
  )
  await render(createElement(HookProbe, { context: api.context }))
  await flush()

  const output = host.querySelector('output')
  expect(output?.dataset.count).toBe('101')
  expect(output?.textContent).toContain('Page 1,Page 2')
  expect(output?.textContent).toContain('Page 100,Page 101')
  const pageCalls = api.calls.filter((call) => call.method === 'quirky.orchestration/workerList')
  expect(pageCalls).toEqual([
    { method: 'quirky.orchestration/workerList', params: { limit: 100 } },
    { method: 'quirky.orchestration/workerList', params: { limit: 100, cursor: 'cursor-1' } }
  ])
  expect(intervals.filter((timer) => !timer.cleared)).toHaveLength(1)
  const timer = intervals.find((item) => !item.cleared)!
  api.pages.push({ workers: [], page: { nextCursor: null, snapshotId: 'empty-2', total: 0 }, partialHostErrors: [] })
  await act(async () => timer.callback())
  await flush()
  expect(api.calls.filter((call) => call.method === 'quirky.orchestration/workerList')).toHaveLength(3)
  expect(intervals.every((item) => item.cleared)).toBe(true)
})

test('does not poll an empty fleet, but refreshes on a real session event', async () => {
  const api = fakeContext()
  api.pages.push(
    { workers: [], page: { nextCursor: null, snapshotId: 'empty-1', total: 0 }, partialHostErrors: [] },
    { workers: [workerRow()], page: { nextCursor: null, snapshotId: 'snapshot-2', total: 1 }, partialHostErrors: [] }
  )
  await render(createElement(HookProbe, { context: api.context }))
  await flush()
  expect(intervals.filter((timer) => !timer.cleared)).toHaveLength(0)

  await act(async () => api.emit({ type: 'quirky.session/changed', data: { session: session('worker-session-1', 'wt-main') } } as QuirkyEvent))
  await flush()
  expect(host.querySelector('output')?.textContent).toBe('Agent label')
  expect(intervals.filter((timer) => !timer.cleared)).toHaveLength(1)
})

test('does not call or poll unavailable orchestration and cleans subscriptions on unmount', async () => {
  for (const state of ['disabled', 'inactive', 'missing'] as const) {
    const api = fakeContext()
    api.setPluginState(state)
    await render(createElement(HookProbe, { context: api.context }))
    await flush()

    expect(api.calls.some((call) => call.method === 'quirky.orchestration/workerList')).toBe(false)
    expect(intervals.filter((timer) => !timer.cleared)).toHaveLength(0)
    await act(async () => root?.unmount())
    root = null
    expect(api.listeners.size).toBe(0)
    expect(api.connections.size).toBe(0)
  }
})

test('stops bounded refresh on disable and resumes after the plugin re-enables', async () => {
  const api = fakeContext()
  api.pages.push({ workers: [workerRow()], page: { nextCursor: null, snapshotId: 'snapshot-1', total: 1 }, partialHostErrors: [] })
  await render(createElement(HookProbe, { context: api.context }))
  await flush()
  expect(intervals.some((timer) => !timer.cleared)).toBe(true)

  api.setPluginState('disabled')
  await act(async () => api.emit({ type: 'plugin.changed' }))
  await flush()

  expect(host.querySelector('output')?.textContent).toBe('')
  api.setPluginState('active')
  api.pages.push({ workers: [workerRow({ displayName: 'Re-enabled agent' })], page: { nextCursor: null, snapshotId: 'snapshot-2', total: 1 }, partialHostErrors: [] })
  await act(async () => api.emit({ type: 'plugin.changed' }))
  await flush()
  expect(host.querySelector('output')?.textContent).toBe('Re-enabled agent')
  expect(intervals.filter((timer) => !timer.cleared)).toHaveLength(1)
  await act(async () => root?.unmount())
  root = null
  expect(api.listeners.size).toBe(0)
  expect(api.connections.size).toBe(0)
  expect(intervals.every((timer) => timer.cleared)).toBe(true)
})
