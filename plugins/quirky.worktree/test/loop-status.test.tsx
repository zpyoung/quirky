import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { ProjectGroup, QuirkyEvent, Repo, UiLayout, UiPluginContext, WorkspaceOriginView } from '@quirky/protocol'
import { act } from 'react'
import type { WorktreeControl } from '../src/control-types'

const SLOT = 'sidebar-section:quirky.worktree/worktrees'
const LOOP_VIEW = 'view:quirky.loops/loop'
const CLOSE_GUARD = 'quirky.loops/viewCloseGuard'

const REPO: Repo = {
  id: 'repo-1',
  name: 'sidebar-fixture',
  path: '/repo/sidebar-fixture',
  addedAt: 1,
  kind: 'git',
  displayName: null,
  groupId: null
}

const WORKTREE_DEFAULTS: Omit<WorktreeControl, 'id' | 'repoId' | 'path' | 'branch' | 'head' | 'isMain' | 'name' | 'instanceId'> = {
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 1,
  createdBy: 'external',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 1,
  manualOrder: 0,
  sleeping: false,
  sleepChangedAt: null,
  references: [],
  archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true,
  externalVisibility: 'show',
  externalInboxSuppressed: false
}

type LoopState = 'running' | 'needs-you' | 'paused'
type LoopSummaryFixture = {
  id: string
  worktreeId: string
  state: LoopState
  pauseReason: string | null
  iterationsCompleted: number
  maxIterations: number | null
  updatedAt: number
}
type LoopPresentation = 'running' | 'needs-you' | 'paused' | 'detached' | 'unverifiable'
type LoopReportFixture = {
  id: string
  state: LoopState
  pauseReason: string | null
  presentation: LoopPresentation
  iterationsCompleted: number
  maxIterations: number | null
  label: string
}
type WorkspaceReportFixture = { id: string; unread: boolean; loop?: LoopReportFixture; status: string | null }
type WorktreesReportFixture = {
  loops?: { status: 'loading' | 'available' | 'unavailable' | 'disabled'; error: string | null }
  projects: { worktrees: WorkspaceReportFixture[] }[]
}
type Mount = (element: HTMLElement, props: { report?(state: unknown): void }) => () => void
type Call = { method: string; params: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

type World = {
  worktrees: WorktreeControl[]
  origins: WorkspaceOriginView[]
  summaries: LoopSummaryFixture[]
  summaryFailure: Error | null
  summaryGates: Deferred<LoopSummaryFixture[]>[]
  pluginState: 'active' | 'disabled'
  layouts: Map<string, unknown | Error>
}

function worktree(id: string, unread = false): WorktreeControl {
  return {
    id,
    repoId: REPO.id,
    path: `/workspace/${id}`,
    branch: id,
    head: 'abc123',
    isMain: false,
    name: id,
    ...WORKTREE_DEFAULTS,
    instanceId: id,
    unread
  }
}

function summary(
  id: string,
  worktreeId: string,
  state: LoopState,
  over: Partial<Omit<LoopSummaryFixture, 'id' | 'worktreeId' | 'state'>> = {}
): LoopSummaryFixture {
  return {
    id,
    worktreeId,
    state,
    pauseReason: null,
    iterationsCompleted: 0,
    maxIterations: 4,
    updatedAt: 1,
    ...over
  }
}

function hostedView(loopId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'view',
    id: `tab-${loopId}`,
    viewId: LOOP_VIEW,
    key: loopId,
    input: { loopId },
    title: `Loop ${loopId}`,
    color: 'none',
    pinned: false,
    preview: false,
    closeCommand: 'command:quirky.loops/close-tab',
    closeMethod: CLOSE_GUARD,
    closeParams: { loopId },
    closeContext: true,
    createdAt: '2026-10-28T00:00:00.000Z',
    ...over
  }
}

function terminalGroup(id: string, tabs: unknown[]) {
  const activeTab = isRecord(tabs[0]) && typeof tabs[0].id === 'string' ? tabs[0].id : null
  return {
    kind: 'group',
    id,
    tabs,
    activeTab,
    recent: activeTab ? [activeTab] : [],
    lastQuickCommand: null
  }
}

function terminalLayout(workspaceId: string, tabs: unknown[] = []): unknown {
  const root = terminalGroup('group-1', tabs)
  return { workspace: { id: workspaceId, revision: 0, root, activeGroup: root.id, closed: [] } }
}

function splitTerminalLayout(workspaceId: string, first: unknown[], second: unknown[]): unknown {
  const root = {
    kind: 'split',
    id: 'split-1',
    direction: 'right',
    ratio: 0.5,
    first: terminalGroup('group-1', first),
    second: terminalGroup('group-2', second)
  }
  return { workspace: { id: workspaceId, revision: 0, root, activeGroup: 'group-1', closed: [] } }
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let activate: (context: UiPluginContext) => void
const cleanups: Array<() => Promise<void>> = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  activate = (await import('../src/ui')).activate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})


afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve()
  })
}

function setup(ids: string[], unreadIds: string[] = []) {
  const world: World = {
    worktrees: ids.map((id) => worktree(id, unreadIds.includes(id))),
    origins: ids.map((worktreeId) => ({ worktreeId, automation: null, otherClient: null })),
    summaries: [],
    summaryFailure: null,
    summaryGates: [],
    pluginState: 'active',
    layouts: new Map()
  }
  const calls: Call[] = []
  const reports: unknown[] = []
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const provided = new Map<string, unknown>()
  const layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }
  const context = {
    pluginId: 'quirky.worktree',
    log() {},
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ method, params })
      switch (method) {
        case 'ui.window.self':
          return { connId: 1 }
        case 'quirky.worktree/origins':
          return [...world.origins]
        case 'quirky.repo/list':
          return [REPO]
        case 'quirky.repo/groupList':
          return [] as ProjectGroup[]
        case 'quirky.worktree/list':
          return [...world.worktrees]
        case 'quirky.session/list':
          return []
        case 'plugin.list':
          return [
            { id: 'quirky.loops', state: world.pluginState },
            { id: 'quirky.sidebar-extras', state: 'disabled' }
          ]
        case 'quirky.loops/summaries': {
          const gate = world.summaryGates.shift()
          if (gate) return gate.promise
          if (world.summaryFailure) throw world.summaryFailure
          return world.summaries.map((item) => ({ ...item }))
        }
        case 'quirky.terminal/workspace': {
          const workspaceId = String(params.workspace)
          const result = world.layouts.get(workspaceId)
          if (result instanceof Error) throw result
          return result === undefined ? terminalLayout(workspaceId) : result
        }
        case 'quirky.sidebar-extras/state':
        case 'quirky.sidebar-extras/activate':
          return {}
        case 'quirky.sidebar-extras/projection':
          return {
            client: 'sidebar-fixture',
            preferences: {
              workspaceActivityWindow: 'all',
              workspaceActivityCustomDays: 7,
              alwaysShowDefaultBranchWorkspace: true,
              workspaceActivityWindowBeforeLiveOnly: 'all',
              hideCompletedReviewWorkspaces: false,
              hidePassingCheckWorkspaces: false
            },
            active: null,
            visits: {},
            exits: {},
            visibleIds: ids,
            hiddenIds: [],
            hiddenCount: 0,
            filterCount: 0,
            reviewHiddenIds: [],
            reviewHiddenCount: 0,
            workspaces: []
          }
        default:
          throw new Error(`unexpected public call ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onConnection(listener: (status: 'connected' | 'reconnecting') => void) {
      connectionListeners.add(listener)
      return () => void connectionListeners.delete(listener)
    },
    getSetting: () => undefined,
    executeCommand: async () => {},
    openView: () => {},
    closeView: () => {},
    togglePanel: () => {},
    getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) {
      layoutListeners.add(listener)
      return () => void layoutListeners.delete(listener)
    },
    onStream: () => () => {},
    confirm: async () => true,
    toast: () => {},
    setPanelBadge: () => {}
  } as unknown as UiPluginContext

  activate(context)
  const mountSection = provided.get(SLOT) as Mount | undefined
  if (!mountSection) throw new Error(`worktree plugin did not provide ${SLOT}`)
  const host = document.createElement('div')
  document.body.append(host)
  let unmount: (() => void) | undefined
  let mounted: Promise<void> | null = null
  const mount = async () => {
    if (mounted) return mounted
    mounted = (async () => {
      await act(async () => {
        unmount = mountSection(host, { report: (state) => reports.push(state) })
      })
      await flush()
    })()
    await mounted
  }
  const cleanup = async () => {
    if (mounted) await mounted
    if (unmount) await act(async () => unmount!())
    host.remove()
  }
  cleanups.push(cleanup)

  return {
    world,
    calls,
    reports,
    host,
    mount,
    callsTo(method: string) { return calls.filter((call) => call.method === method) },
    async settle() { await flush() },
    async emit(type: string, data: unknown = {}) {
      const event = { type, data } as unknown as QuirkyEvent
      await act(async () => {
        await Promise.all([...listeners].map((listener) => listener(event)))
        for (let i = 0; i < 16; i++) await Promise.resolve()
      })
    },
    async connection(status: 'connected' | 'reconnecting') {
      await act(async () => {
        for (const listener of [...connectionListeners]) listener(status)
        for (let i = 0; i < 16; i++) await Promise.resolve()
      })
    }
  }
}

function reportOf(h: ReturnType<typeof setup>): WorktreesReportFixture {
  const value = h.reports.at(-1)
  if (!isRecord(value)) throw new Error('WorktreesSection has not reported its state')
  return value as unknown as WorktreesReportFixture
}

function workspaceReport(h: ReturnType<typeof setup>, id: string): WorkspaceReportFixture {
  const row = reportOf(h).projects.flatMap((project) => project.worktrees).find((candidate) => candidate.id === id)
  if (!row) throw new Error(`worktree ${id} is missing from the sidebar report`)
  return row
}

function card(h: ReturnType<typeof setup>, id: string): HTMLButtonElement {
  const row = [...h.host.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((candidate) => {
    const label = candidate.getAttribute('aria-label')
    return label === `Open ${id}` || label === `Wake and open ${id}`
  })
  if (!row) throw new Error(`worktree ${id} is missing from the rendered sidebar`)
  return row
}

function requireLoop(row: WorkspaceReportFixture): LoopReportFixture {
  if (!row.loop) throw new Error(`worktree ${row.id} has no reported loop projection`)
  return row.loop
}

function eventCallCount(h: ReturnType<typeof setup>, method: string): number {
  return h.callsTo(method).length
}

test('selects each worktree loop by priority, update recency, and stable ID with strict attachment evidence', async () => {
  const h = setup(['w-priority', 'w-paused', 'w-running', 'w-detached', 'w-unknown', 'w-fresh-needs-you', 'w-unverifiable-pause', 'w-newest'])
  const summaries = [
    summary('run-newer', 'w-priority', 'running', { iterationsCompleted: 8, maxIterations: 9, updatedAt: 2_000 }),
    summary('pause-newer', 'w-priority', 'paused', { pauseReason: 'cap-iterations', iterationsCompleted: 3, maxIterations: 3, updatedAt: 1_500 }),
    summary('needs-z', 'w-priority', 'needs-you', { iterationsCompleted: 1, updatedAt: 200 }),
    summary('needs-a', 'w-priority', 'needs-you', { iterationsCompleted: 2, updatedAt: 200 }),
    summary('paused-only', 'w-paused', 'paused', { pauseReason: 'cap-iterations', iterationsCompleted: 2, maxIterations: 2 }),
    summary('detached-newer', 'w-paused', 'running', { updatedAt: 9_000 }),
    summary('running-only', 'w-running', 'running', { maxIterations: 4 }),
    summary('paused-newer-than-running', 'w-running', 'paused', { pauseReason: 'user', updatedAt: 9_000 }),
    summary('detached-running', 'w-detached', 'running', { iterationsCompleted: 5, maxIterations: null }),
    summary('unknown-running', 'w-unknown', 'running', { maxIterations: 3 }),
    summary('fresh-needs-you', 'w-fresh-needs-you', 'needs-you', { iterationsCompleted: 1, maxIterations: 3 }),
    summary('unknown-running-needs-you', 'w-fresh-needs-you', 'running', { iterationsCompleted: 2 }),
    summary('unverifiable-pause', 'w-unverifiable-pause', 'paused', { pauseReason: 'unverifiable', iterationsCompleted: 1, maxIterations: 3 }),
    summary('running-lower', 'w-unverifiable-pause', 'running', { updatedAt: 9_000 }),
    summary('needs-a-older', 'w-newest', 'needs-you', { iterationsCompleted: 1, updatedAt: 200 }),
    summary('needs-z-newer', 'w-newest', 'needs-you', { iterationsCompleted: 2, updatedAt: 300 })
  ]
  h.world.summaries = summaries
  h.world.layouts.set('w-priority', splitTerminalLayout('w-priority',
    [hostedView('run-newer'), hostedView('pause-newer')],
    [hostedView('needs-z'), hostedView('needs-a')]
  ))
  h.world.layouts.set('w-paused', terminalLayout('w-paused', [hostedView('paused-only')]))
  h.world.layouts.set('w-running', terminalLayout('w-running', [hostedView('running-only'), hostedView('paused-newer-than-running')]))
  // All fields except closeContext match: this view must not prove loop attachment.
  h.world.layouts.set('w-detached', terminalLayout('w-detached', [hostedView('detached-running', { closeContext: false })]))
  h.world.layouts.set('w-unknown', new Error('layout read unavailable'))
  h.world.layouts.set('w-fresh-needs-you', new Error('layout read unavailable'))
  h.world.layouts.set('w-unverifiable-pause', terminalLayout('w-unverifiable-pause', [hostedView('running-lower')]))
  h.world.layouts.set('w-newest', terminalLayout('w-newest', [hostedView('needs-a-older'), hostedView('needs-z-newer')]))
  await h.mount()
  await h.settle()

  expect(reportOf(h).loops).toEqual({ status: 'available', error: null })
  expect(requireLoop(workspaceReport(h, 'w-priority'))).toEqual({
    id: 'needs-a', state: 'needs-you', pauseReason: null, presentation: 'needs-you',
    iterationsCompleted: 2, maxIterations: 4, label: 'Loop 2/4 · needs-you'
  })
  expect(requireLoop(workspaceReport(h, 'w-paused'))).toEqual({
    id: 'paused-only', state: 'paused', pauseReason: 'cap-iterations', presentation: 'paused',
    iterationsCompleted: 2, maxIterations: 2, label: 'Loop 2/2 · paused: cap-iterations'
  })
  expect(requireLoop(workspaceReport(h, 'w-running'))).toEqual({
    id: 'running-only', state: 'running', pauseReason: null, presentation: 'running',
    iterationsCompleted: 0, maxIterations: 4, label: 'Loop 0/4 · running'
  })
  expect(requireLoop(workspaceReport(h, 'w-detached'))).toEqual({
    id: 'detached-running', state: 'running', pauseReason: null, presentation: 'detached',
    iterationsCompleted: 5, maxIterations: null, label: 'Loop 5 · detached'
  })
  expect(requireLoop(workspaceReport(h, 'w-unknown'))).toMatchObject({
    id: 'unknown-running', state: 'running', presentation: 'unverifiable', label: 'Loop 0/3 · unverifiable'
  })
  expect(requireLoop(workspaceReport(h, 'w-unverifiable-pause'))).toMatchObject({
    id: 'unverifiable-pause', state: 'paused', pauseReason: 'unverifiable',
    presentation: 'unverifiable', label: 'Loop 1/3 · unverifiable'
  })
  // Fresh needs-you outranks unknown attachment evidence; stale evidence is covered below.
  expect(requireLoop(workspaceReport(h, 'w-fresh-needs-you'))).toMatchObject({ id: 'fresh-needs-you', presentation: 'needs-you' })
  expect(requireLoop(workspaceReport(h, 'w-newest'))).toMatchObject({ id: 'needs-z-newer', iterationsCompleted: 2 })
  for (const id of ['w-priority', 'w-paused', 'w-running', 'w-detached', 'w-unknown', 'w-fresh-needs-you', 'w-unverifiable-pause', 'w-newest']) {
    const loop = requireLoop(workspaceReport(h, id))
    const badge = [...card(h, id).querySelectorAll<HTMLElement>('[aria-label]')]
      .find((element) => element.getAttribute('aria-label') === loop.label)
    expect(badge?.textContent).toBe('Loop')
  }
})

test('unread keeps its bell while JSON retains the loop, and an empty snapshot removes the projection', async () => {
  const h = setup(['w-unread', 'w-visible'], ['w-unread'])
  h.world.summaries = [
    summary('unread-loop', 'w-unread', 'needs-you', { iterationsCompleted: 2 }),
    summary('visible-loop', 'w-visible', 'running', { iterationsCompleted: 1 })
  ]
  h.world.layouts.set('w-unread', terminalLayout('w-unread', [hostedView('unread-loop')]))
  h.world.layouts.set('w-visible', terminalLayout('w-visible', [hostedView('visible-loop')]))
  await h.mount()
  await h.settle()

  const unreadRow = workspaceReport(h, 'w-unread')
  expect(requireLoop(unreadRow).id).toBe('unread-loop')
  const visibleLoopLabel = requireLoop(workspaceReport(h, 'w-visible')).label
  const unreadBadge = [...card(h, 'w-unread').querySelectorAll<HTMLElement>('[aria-label]')]
    .find((element) => element.getAttribute('aria-label') === 'Unread')
  expect(unreadBadge).toBeDefined()
  const hiddenLoopBadge = [...card(h, 'w-unread').querySelectorAll<HTMLElement>('[aria-label]')]
    .find((element) => element.getAttribute('aria-label') === unreadRow.loop!.label)
  expect(hiddenLoopBadge).toBeUndefined()
  const visibleLoopBadge = [...card(h, 'w-visible').querySelectorAll<HTMLElement>('[aria-label]')]
    .find((element) => element.getAttribute('aria-label') === visibleLoopLabel)
  expect(visibleLoopBadge?.textContent).toBe('Loop')

  h.world.summaries = []
  await h.emit('quirky.loops/changed', { loopId: 'visible-loop' })
  expect(reportOf(h).loops).toEqual({ status: 'available', error: null })
  expect(workspaceReport(h, 'w-unread')).not.toHaveProperty('loop')
  expect(workspaceReport(h, 'w-visible')).not.toHaveProperty('loop')
  expect([...card(h, 'w-unread').querySelectorAll<HTMLElement>('[aria-label]')]
    .some((element) => element.getAttribute('aria-label') === 'Unread')).toBe(true)
  expect([...card(h, 'w-visible').querySelectorAll<HTMLElement>('[aria-label]')]
    .some((element) => element.getAttribute('aria-label') === visibleLoopLabel)).toBe(false)
})

test('disconnects and failed refreshes make cached needs-you unverifiable until fresh evidence returns', async () => {
  const h = setup(['w-needs-you'])
  h.world.summaries = [summary('needs-you', 'w-needs-you', 'needs-you', { iterationsCompleted: 3 })]
  h.world.layouts.set('w-needs-you', new Error('terminal workspace is unknown'))
  await h.mount()
  await h.settle()

  expect(reportOf(h).loops).toMatchObject({ status: 'available' })
  expect(requireLoop(workspaceReport(h, 'w-needs-you')).presentation).toBe('needs-you')

  await h.connection('reconnecting')
  expect(reportOf(h).loops).toMatchObject({ status: 'unavailable' })
  expect(requireLoop(workspaceReport(h, 'w-needs-you')).presentation).toBe('unverifiable')

  await h.connection('connected')
  expect(reportOf(h).loops).toMatchObject({ status: 'available' })
  expect(requireLoop(workspaceReport(h, 'w-needs-you')).presentation).toBe('needs-you')

  h.world.summaryFailure = new Error('summary refresh failed')
  await h.emit('quirky.loops/changed', { loopId: 'needs-you' })
  expect(reportOf(h).loops).toMatchObject({ status: 'unavailable', error: expect.stringContaining('summary refresh failed') })
  expect(requireLoop(workspaceReport(h, 'w-needs-you')).presentation).toBe('unverifiable')
})

test('a stale initial summary response cannot overwrite the snapshot invalidated by a loop event', async () => {
  const h = setup(['w-stale'])
  const initial = deferred<LoopSummaryFixture[]>()
  h.world.summaries = [summary('fresh-after-event', 'w-stale', 'running', { iterationsCompleted: 2 })]
  h.world.summaryGates.push(initial)
  await h.mount()
  await h.settle()

  expect(reportOf(h).loops).toMatchObject({ status: 'loading' })
  expect(eventCallCount(h, 'quirky.loops/summaries')).toBe(1)
  h.world.summaries = [summary('fresh-after-event', 'w-stale', 'running', { iterationsCompleted: 2 })]
  await h.emit('quirky.loops/changed', { loopId: 'fresh-after-event' })
  initial.resolve([summary('stale-initial', 'w-stale', 'needs-you', { iterationsCompleted: 1 })])
  await h.settle()

  expect(requireLoop(workspaceReport(h, 'w-stale'))).toMatchObject({ id: 'fresh-after-event', iterationsCompleted: 2 })
  expect(JSON.stringify(reportOf(h))).not.toContain('stale-initial')
})

test('plugin disable clears cached rows and fences a delayed summaries response', async () => {
  const h = setup(['w-disabled'])
  h.world.summaries = [summary('cached-needs-you', 'w-disabled', 'needs-you', { iterationsCompleted: 2 })]
  h.world.layouts.set('w-disabled', terminalLayout('w-disabled', [hostedView('cached-needs-you')]))
  await h.mount()
  await h.settle()

  expect(reportOf(h).loops).toMatchObject({ status: 'available' })
  expect(requireLoop(workspaceReport(h, 'w-disabled')).id).toBe('cached-needs-you')

  const delayed = deferred<LoopSummaryFixture[]>()
  const previousReads = eventCallCount(h, 'quirky.loops/summaries')
  h.world.summaryGates.push(delayed)
  await h.emit('quirky.loops/changed', { loopId: 'cached-needs-you' })
  expect(eventCallCount(h, 'quirky.loops/summaries')).toBeGreaterThan(previousReads)

  h.world.pluginState = 'disabled'
  await h.emit('plugin.changed', {})
  expect(reportOf(h).loops).toMatchObject({ status: 'disabled' })
  expect(workspaceReport(h, 'w-disabled')).not.toHaveProperty('loop')

  delayed.resolve([summary('cached-needs-you', 'w-disabled', 'needs-you', { iterationsCompleted: 2 })])
  await h.settle()
  expect(reportOf(h).loops).toMatchObject({ status: 'disabled' })
  expect(workspaceReport(h, 'w-disabled')).not.toHaveProperty('loop')
})
