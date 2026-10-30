import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ProjectGroup, QuirkyEvent, Repo, Session, UiLayout, UiPluginContext, WorkspaceOriginView, WorktreeAutomationProvenance } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'
import type { WorktreeControl } from '../src/control-types'
import type { WorkspaceReport, WorktreesReport } from '../src/report'

const SLOT = 'sidebar-section:quirky.worktree/worktrees'
const AUTOMATION_ID = 'auto/id:recorded'
const RUN_ID = 'run/id:recorded'
const NEWER_RUN_ID = 'run/newer'
const provenance: WorktreeAutomationProvenance = {
  kind: 'created-by-automation',
  automationId: AUTOMATION_ID,
  automationName: 'Snapshot audit',
  runId: RUN_ID,
  runTitle: 'Snapshot audit · 2026-10-28',
  projectId: 'project-1',
  hostId: 'local'
}

const DEFAULTS: Omit<WorktreeControl, 'id' | 'repoId' | 'path' | 'branch' | 'head' | 'isMain' | 'name' | 'instanceId'> = {
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false,
  parentId: null, createdAt: 0, createdBy: 'api', baseRef: null, keepBranch: false, removing: false,
  groupId: null, projectGroupId: null, lastActivityAt: 0,
  manualOrder: 0, sleeping: false, sleepChangedAt: null, references: [], archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false
}

type RunPage = { runs: { id: string; automationId: string }[]; nextCursor: string | null }
type Call = { method: string; params: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
type World = {
  worktrees: WorktreeControl[]
  calls: Call[]
  navigations: Record<string, unknown>[]
  definitionFailure: Error & { code?: number } | null
  historyFailure: Error & { code?: number } | null
  automationDisabled: boolean
  definitionReply?: () => Promise<unknown>
  historyReply?: (params: Record<string, unknown>) => Promise<unknown>
}
type Mount = (element: HTMLElement, props: { report?(value: unknown): void }) => () => void
type UiHarness = {
  world: World
  reports: unknown[]
  mount(): Promise<void>
  unmount(): Promise<void>
  flush(): Promise<void>
  click(element: Element): Promise<void>
  emit(type: string, data?: unknown): Promise<void>
}

let act: (callback: () => unknown) => Promise<void>
let activate: (context: UiPluginContext) => void
let host: HTMLElement
let cleanup: (() => Promise<void>) | null = null

// Happy DOM must install window globals before React and the renderer modules are loaded.
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  ;({ activate } = await import('../src/ui'))
})

afterAll(async () => { await GlobalRegistrator.unregister() })
beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

class RpcLike extends Error {
  constructor(message: string, readonly code: number) { super(message) }
}

function deferred<T>(): Deferred<T> {
  const value = Promise.withResolvers<T>()
  return { promise: value.promise, resolve: value.resolve, reject: value.reject }
}

const repo: Repo = { id: 'repo-1', name: 'repo', path: '/repo', addedAt: 1, kind: 'git', displayName: null, groupId: null }
const automationWorktree = (id = 'wt-auto', name = 'auto-recorded', extra: Partial<WorktreeControl> = {}): WorktreeControl => ({
  id, repoId: repo.id, path: `/worktrees/${id}`, branch: name, head: 'abc', isMain: false, name,
  instanceId: `instance-${id}`, ...DEFAULTS, automationProvenance: provenance, ...extra
})
const ordinaryWorktree = (id = 'wt-api', name = 'auto-user-created'): WorktreeControl => ({
  id, repoId: repo.id, path: `/worktrees/${id}`, branch: name, head: 'def', isMain: false, name,
  instanceId: `instance-${id}`, ...DEFAULTS
})
const runPage = (runs: RunPage['runs'], nextCursor: string | null): RunPage => ({ runs, nextCursor })

function setup() {
  const world: World = {
    worktrees: [automationWorktree(), ordinaryWorktree(), automationWorktree('wt-auto-second', 'auto-second')],
    calls: [], navigations: [], definitionFailure: null, historyFailure: null, automationDisabled: false
  }
  const reports: unknown[] = []
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const provided = new Map<string, unknown>()
  let layout: UiLayout = { worktree: null, view: null, panel: null, sidebar: true, focus: null }
  const state = () => ({
    client: 'desktop',
    preferences: {
      workspaceActivityWindow: 'all', workspaceActivityCustomDays: 30,
      alwaysShowDefaultBranchWorkspace: true, workspaceActivityWindowBeforeLiveOnly: 'all',
      hideCompletedReviewWorkspaces: false, hidePassingCheckWorkspaces: false, hideAutomationCreated: false
    },
    active: null, visits: {}, exits: {}
  })
  const context = {
    pluginId: 'quirky.worktree',
    log() {},
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      world.calls.push({ method, params })
      switch (method) {
        case 'ui.window.self': return { connId: 1 }
        case 'quirky.worktree/origins':
          return world.worktrees.map((item) => ({
            worktreeId: item.id,
            automation: item.automationProvenance?.kind === 'created-by-automation',
            otherClient: null
          }))
        case 'quirky.repo/list': return [repo]
        case 'quirky.repo/groupList': return [] as ProjectGroup[]
        case 'quirky.worktree/list': return [...world.worktrees]
        case 'quirky.worktree/projectOrder': return [repo.id]
        case 'quirky.worktree/statusDefinitions': return [
          { id: 'todo', label: 'To do', color: '#8b8b8b' },
          { id: 'in-progress', label: 'In progress', color: '#3478c5' },
          { id: 'in-review', label: 'In review', color: '#a57de8' },
          { id: 'done', label: 'Done', color: '#48a878' }
        ]
        case 'quirky.worktree/projectMetadataList': return [{ repoId: repo.id, identity: { displayName: null, icon: null, color: null, trackerProject: null }, externalVisibility: 'inherit', effectiveExternalVisibility: 'hide', externalInboxSuppressed: false, sharedDirectories: [] }]
        case 'quirky.worktree/navigate':
        case 'quirky.worktree/openIn': {
          const id = params.target === 'changes' ? 'view:quirky.git/diff' : 'view:quirky.session/worktree'
          const input = { worktree: params.worktree }
          layout = {
            ...layout,
            worktree: typeof params.worktree === 'string' && params.worktree !== '' ? params.worktree : layout.worktree ?? null,
            view: { id, input }
          }
          for (const listener of layoutListeners) listener(layout)
          return { worktreeId: params.worktree, target: params.target ?? 'terminal' }
        }
        case 'quirky.session/list': return [] as Session[]
        case 'quirky.heimdall/fleet': throw new RpcLike('not enabled', RpcErrorCode.MethodNotFound)
        case 'quirky.sidebar-extras/state': return state()
        case 'quirky.sidebar-extras/activate': return state()
        case 'quirky.sidebar-extras/projection': {
          const ids = world.worktrees.map((item) => item.id)
          return {
            ...state(), visibleIds: ids, hiddenIds: [], hiddenCount: 0, filterCount: 0,
            automationHiddenIds: [], automationHiddenCount: 0, reviewHiddenIds: [], reviewHiddenCount: 0,
            workspaces: ids.map((worktreeId) => ({ worktreeId, activityAt: 1, live: false, reason: 'all' }))
          }
        }
        case 'quirky.sidebar-extras/set': return state()
        case 'quirky.automations/show':
          if (world.automationDisabled) throw new RpcLike('Automations plugin is disabled', RpcErrorCode.MethodNotFound)
          if (world.definitionFailure) throw world.definitionFailure
          if (world.definitionReply) return world.definitionReply()
          return { id: String(params.id), name: provenance.automationName }
        case 'quirky.automations/runs':
          if (world.automationDisabled) throw new RpcLike('Automations plugin is disabled', RpcErrorCode.MethodNotFound)
          if (world.historyFailure) throw world.historyFailure
          if (world.historyReply) return world.historyReply(params)
          if (params.cursor === undefined) return runPage([{ id: NEWER_RUN_ID, automationId: AUTOMATION_ID }], 'older')
          return runPage([{ id: RUN_ID, automationId: AUTOMATION_ID }], null)
        case 'quirky.automations/uiNavigate':
          if (world.automationDisabled) throw new RpcLike('Automations plugin is disabled', RpcErrorCode.MethodNotFound)
          world.navigations.push(params)
          return { opened: true }
        default: throw new Error(`unexpected call ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) { listeners.add(listener); return () => void listeners.delete(listener) },
    getSetting: () => undefined,
    executeCommand: async () => {},
    openView(id: string, input?: unknown) {
      const viewWorktree = typeof input === 'object' && input !== null && 'worktree' in input
        ? input.worktree
        : undefined
      layout = {
        ...layout,
        ...(typeof viewWorktree === 'string' && viewWorktree !== '' ? { worktree: viewWorktree } : {}),
        view: { id, input }
      }
      for (const listener of layoutListeners) listener(layout)
    },
    closeView() {}, togglePanel() {}, getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) { layoutListeners.add(listener); return () => void layoutListeners.delete(listener) },
    onStream: () => () => {}, onConnection: () => () => {}, confirm: async () => true, toast() {}, setPanelBadge() {}
  } as unknown as UiPluginContext
  activate(context)
  const mount = provided.get(SLOT) as Mount
  const flush = async () => act(async () => {
    for (let index = 0; index < 12; index++) await Promise.resolve()
  })
  return {
    world, reports,
    async mount() {
      let unmount = () => {}
      await act(async () => { unmount = mount(host, { report: (value) => reports.push(value) }) })
      cleanup = async () => act(async () => unmount())
      await flush()
    },
    async unmount() {
      const mountedCleanup = cleanup
      cleanup = null
      await mountedCleanup?.()
    },
    flush,
    async click(element: Element) { await act(async () => { (element as HTMLElement).click(); await Promise.resolve() }); await flush() },
    async emit(type: string, data: unknown = {}) {
      await act(async () => {
        await Promise.all([...listeners].map((listener) => listener({ type, data } as QuirkyEvent)))
        await Promise.resolve()
      })
      await flush()
    }
  }
}

const rowFor = (id: string) => [...host.querySelectorAll<HTMLElement>('li.worktree')].find((row) => row.querySelector('.worktree-name')?.textContent === (id === 'wt-auto' ? 'auto-recorded' : id === 'wt-api' ? 'auto-user-created' : 'auto-second'))
const button = (name: string, root: ParentNode = host) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)
const reportFor = (h: UiHarness, id: string): WorkspaceReport | undefined => {
  const report = h.reports.at(-1) as WorktreesReport | undefined
  return report?.projects.flatMap((project) => project.worktrees).find((workspace) => workspace.id === id)
}
const expand = async (h: UiHarness, id = 'wt-auto') => {
  const card = rowFor(id)
  const toggle = card?.querySelector<HTMLButtonElement>(`button[aria-label="Automation details for ${id}"]`)
  if (!toggle) throw new Error(`no automation details toggle for ${id}`)
  await h.click(toggle)
  return card!
}

async function readyDetails(h: UiHarness, id = 'wt-auto'): Promise<HTMLElement> {
  const card = await expand(h, id)
  await h.flush()
  return card
}

test('lazy details preserve provenance and open the exact recorded automation and older run', async () => {
  const h = setup()
  await h.mount()
  const attributed = rowFor('wt-auto')!
  const ordinary = rowFor('wt-api')!
  expect(attributed.textContent).toContain('Created by automation')
  expect(ordinary.textContent).not.toContain('Created by automation')
  expect(reportFor(h, 'wt-auto')?.automation).toMatchObject({
    provenance,
    expanded: false,
    availability: { definition: 'not-checked', runHistory: 'not-checked' },
    navigation: {
      automation: { page: 'detail', automationId: AUTOMATION_ID },
      run: { page: 'run', automationId: AUTOMATION_ID, runId: RUN_ID }
    }
  })
  expect(reportFor(h, 'wt-api')?.automation).toBeUndefined()
  expect(h.world.calls.some(({ method }) => method === 'quirky.automations/show' || method === 'quirky.automations/runs')).toBe(false)

  const definition = deferred<unknown>()
  const firstPage = deferred<unknown>()
  h.world.definitionReply = () => definition.promise
  h.world.historyReply = (params) => params.cursor === undefined ? firstPage.promise : Promise.resolve(runPage([{ id: RUN_ID, automationId: AUTOMATION_ID }], null))
  const card = await expand(h)
  expect(card.textContent).toContain('Checking automation availability...')
  expect(button('Open automation', card)?.disabled).toBe(true)
  definition.resolve({ id: AUTOMATION_ID, name: provenance.automationName })
  await h.flush()
  expect(card.textContent).toContain(provenance.automationName)
  expect(card.textContent).toContain(provenance.runTitle)
  expect(card.textContent).toContain('Checking automation availability...')
  firstPage.resolve(runPage([{ id: NEWER_RUN_ID, automationId: AUTOMATION_ID }], 'older'))
  await h.flush()

  expect(card.textContent).not.toContain('Checking automation availability...')
  expect(card.textContent).toContain('Run history available.')
  const historyCalls = h.world.calls.filter(({ method }) => method === 'quirky.automations/runs')
  expect(historyCalls.map(({ params }) => params)).toEqual([
    { automationId: AUTOMATION_ID, limit: 100 },
    { automationId: AUTOMATION_ID, limit: 100, cursor: 'older' }
  ])
  expect(button('Open automation', card)?.disabled).toBe(false)
  expect(button('Open run', card)?.disabled).toBe(false)
  expect(reportFor(h, 'wt-auto')?.automation).toMatchObject({
    provenance,
    expanded: true,
    availability: { definition: 'available', runHistory: 'available' },
    navigation: {
      automation: { page: 'detail', automationId: AUTOMATION_ID },
      run: { page: 'run', automationId: AUTOMATION_ID, runId: RUN_ID }
    }
  })

  await h.click(button('Open automation', card)!)
  await h.click(button('Open run', card)!)
  expect(h.world.navigations).toEqual([
    { page: 'detail', automationId: AUTOMATION_ID },
    { page: 'run', automationId: AUTOMATION_ID, runId: RUN_ID }
  ])
})

test('a confirmed missing definition disables definition navigation', async () => {
  const h = setup()
  h.world.definitionFailure = new RpcLike('Automation not found', RpcErrorCode.NotFound)
  h.world.historyReply = async () => runPage([], null)
  await h.mount()
  const card = await readyDetails(h)
  expect(card.textContent).toContain('Automation no longer available.')
  expect(card.textContent).toContain('Run history no longer available.')
  expect(button('Open automation', card)?.disabled).toBe(true)
  expect(button('Open run', card)?.disabled).toBe(true)
})

test('a successful complete history scan proves the recorded run was pruned', async () => {
  const h = setup()
  h.world.historyReply = async () => runPage([], null)
  await h.mount()
  const card = await readyDetails(h)
  expect(card.textContent).toContain('Run history no longer available.')
  expect(card.textContent).not.toContain('Automation no longer available.')
  expect(button('Open automation', card)?.disabled).toBe(false)
  expect(button('Open run', card)?.disabled).toBe(true)
})

test('failed availability reads are not reported as deleted', async () => {
  const h = setup()
  h.world.definitionFailure = new RpcLike('temporary read failure', RpcErrorCode.Internal)
  h.world.historyFailure = new RpcLike('temporary history failure', RpcErrorCode.Internal)
  await h.mount()
  const card = await readyDetails(h)
  expect(card.textContent).toContain('Automation availability could not be checked.')
  expect(card.textContent).not.toContain('Automation no longer available.')
  expect(card.textContent).not.toContain('Run history no longer available.')
  expect(button('Open automation', card)?.disabled).toBe(true)
  expect(button('Open run', card)?.disabled).toBe(true)
})

test('a disabled automation plugin is unavailable rather than deleted', async () => {
  const h = setup()
  h.world.automationDisabled = true
  await h.mount()
  const card = await readyDetails(h)
  expect(card.textContent).toContain('Automations plugin unavailable.')
  expect(card.textContent).not.toContain('Automation no longer available.')
  expect(button('Open automation', card)?.disabled).toBe(true)
  expect(button('Open run', card)?.disabled).toBe(true)
})


test('unmount prevents a pending availability response from changing the report', async () => {
  const h = setup()
  const delayed = deferred<unknown>()
  h.world.definitionReply = () => delayed.promise
  await h.mount()
  const card = await expand(h)
  const reportCount = h.reports.length

  await h.unmount()
  delayed.resolve({ id: AUTOMATION_ID, name: 'late definition' })
  await h.flush()

  expect(h.reports).toHaveLength(reportCount)
  expect(h.world.navigations).toEqual([])
  expect(card.isConnected).toBe(false)
})
test('plugin events recheck expanded availability and a collapsed request cannot replace the next workspace', async () => {
  const h = setup()
  await h.mount()
  const delayed = deferred<unknown>()
  h.world.definitionReply = () => delayed.promise
  const first = await expand(h, 'wt-auto')
  const firstToggle = first.querySelector<HTMLButtonElement>('button[aria-label="Automation details for wt-auto"]')!
  await h.click(firstToggle)
  expect(first.querySelector('.automation-detail')).toBeNull()

  h.world.definitionReply = undefined
  const second = await readyDetails(h, 'wt-auto-second')
  expect(second.textContent).toContain('Run history available.')
  delayed.resolve({ id: AUTOMATION_ID, name: 'stale response' })
  await h.flush()
  expect(second.textContent).not.toContain('stale response')
  expect(reportFor(h, 'wt-auto-second')?.automation?.availability).toEqual({ definition: 'available', runHistory: 'available' })

  h.world.automationDisabled = true
  await h.emit('plugin.changed')
  expect(second.textContent).toContain('Automations plugin unavailable.')
  expect(button('Open automation', second)?.disabled).toBe(true)
  await h.click(button('Open automation', second)!)
  expect(h.world.navigations).toHaveLength(0)
})
