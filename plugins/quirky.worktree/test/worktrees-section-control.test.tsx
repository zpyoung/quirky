import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { createElement as createElementType } from 'react'
import type { Root } from 'react-dom/client'
import type { ToolPanelFrame as ToolPanelFrameComponent } from '@quirky/ui'
import type { ProjectGroup, QuirkyEvent, Repo, UiLayout, UiPluginContext, Worktree } from '@quirky/protocol'
import { DEFAULT_STOCK_OPTIONS } from '../src/control-types'
import { DEFAULT_ACTIVITY_PREFERENCES, DEFAULT_VIEWS_STATE, allSpecFromStock, type ViewsState } from '../src/view-types'
import { UI_CONTROL_COMMAND, dispatchUiControl, type UiControlResult } from '../src/ui-control'
import type { WorktreesSection as WorktreesSectionComponent } from '../src/WorktreesSection'

type Call = { method: string; params: Record<string, unknown> }
type WorktreeRow = Worktree & { tagIds: string[] }

let act: (callback: () => unknown) => Promise<void>
let createElement: typeof createElementType
let createRoot: (container: HTMLElement) => Root
let WorktreesSection: typeof WorktreesSectionComponent
let ToolPanelFrame: typeof ToolPanelFrameComponent

const repoRows: Repo[] = [
  { id: 'repo-a', name: 'alpha', path: '/projects/alpha', addedAt: 0, kind: 'git', displayName: null, groupId: null },
  { id: 'repo-b', name: 'beta', path: '/projects/beta', addedAt: 1, kind: 'git', displayName: null, groupId: null }
]
const worktreeRows: WorktreeRow[] = [
  {
    id: 'wt-a', repoId: 'repo-a', path: '/projects/alpha/main', branch: 'main', head: 'abc', isMain: true, name: 'main',
    kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false, parentId: null,
    createdAt: 0, createdBy: 'external', baseRef: null, keepBranch: false, removing: false, groupId: null,
    projectGroupId: null, lastActivityAt: 0, instanceId: 'instance-a', tagIds: [], archivedAt: null,
    cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null }, externalVisible: true,
    externalVisibility: 'show', externalInboxSuppressed: false, sleeping: false, manualOrder: 0, sleepChangedAt: null, references: []
  } as WorktreeRow,
  {
    id: 'wt-b', repoId: 'repo-a', path: '/projects/alpha/feature', branch: 'feature', head: 'def', isMain: false, name: 'feature',
    kind: 'git', displayName: null, comment: '', status: 'todo', pinned: false, unread: false, parentId: 'wt-a',
    createdAt: 0, createdBy: 'external', baseRef: 'main', keepBranch: false, removing: false, groupId: null,
    projectGroupId: null, lastActivityAt: 1, instanceId: 'instance-b', tagIds: [], archivedAt: null,
    cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null }, externalVisible: true,
    externalVisibility: 'show', externalInboxSuppressed: false, sleeping: false, manualOrder: 0, sleepChangedAt: null, references: []
  } as WorktreeRow
]

type Fixture = {
  calls: Call[]
  toasts: Array<{ title: string; message: string }>
  logs: string[]
  requests: Call[]
  executeCommands: unknown[]
  world: {
    repos: Repo[]
    groups: ProjectGroup[]
    worktrees: WorktreeRow[]
    identities: unknown
    views: ViewsState
    active: string
    setViewsCalls: ViewsState[]
    setActiveCalls: string[]
    deferActiveView: boolean
    pendingActiveReject: ((error: unknown) => void) | null
    failViews: boolean
    failNextSave: boolean
    deferNextSave: boolean
    pendingSave: ((state: ViewsState) => void) | null
    groupCreateCalls: number
    deferGroupCreate: boolean
    pendingGroupCreate: ((value: unknown) => void) | null
    createFailures: unknown[]
    createCalls: number
    createResult: unknown
    deferRepoList: boolean
    pendingRepoList: ((value: Repo[]) => void) | null
  }
  context: UiPluginContext
  setLayout(next: UiLayout): void
  emit(type: string): Promise<void>
  connect(): Promise<void>
}

function setup(connId = 7): Fixture {
  const calls: Call[] = []
  const toasts: Array<{ title: string; message: string }> = []
  const logs: string[] = []
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const connections = new Set<(status: string) => void>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const executeCommands: unknown[] = []
  const requests: Call[] = []
  let layout: UiLayout = { worktree: null, view: null, panel: null, sidebar: true, focus: null }
  const viewSpec = allSpecFromStock({
    ...DEFAULT_STOCK_OPTIONS,
    filterRepoIds: [],
    showProperties: [...DEFAULT_STOCK_OPTIONS.showProperties]
  }, DEFAULT_ACTIVITY_PREFERENCES)
  const world = {
    repos: [...repoRows],
    groups: [] as ProjectGroup[],
    worktrees: [...worktreeRows],
    identities: [] as unknown,
    views: { ...DEFAULT_VIEWS_STATE, views: [{ id: 'view_a', name: 'Release 1', starred: false, spec: viewSpec }] } as ViewsState,
    active: 'view_a',
    setViewsCalls: [] as ViewsState[],
    setActiveCalls: [] as string[],
    deferActiveView: false,
    pendingActiveReject: null as ((error: unknown) => void) | null,
    failViews: false,
    failNextSave: false,
    deferNextSave: false,
    pendingSave: null as ((state: ViewsState) => void) | null,
    groupCreateCalls: 0,
    deferGroupCreate: false,
    pendingGroupCreate: null as ((value: unknown) => void) | null,
    createFailures: [] as unknown[],
    createCalls: 0,
    createResult: {
      worktree: { id: 'wt-created', name: 'created', path: '/projects/alpha/created' },
      warnings: [],
      setup: { ran: 'none' }
    },
    deferRepoList: false,
    pendingRepoList: null as ((value: Repo[]) => void) | null
  }
  let context: UiPluginContext
  context = {
    pluginId: 'quirky.worktree',
    log(message: string) { logs.push(message) },
    provide() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      switch (method) {
        case 'ui.window.self': return { connId }
        case 'ui.window.command.run': {
          requests.push({ method, params })
          if (params.connId !== connId) throw new Error(`wrong window ${String(params.connId)}`)
          if (params.id !== UI_CONTROL_COMMAND) throw new Error(`wrong command ${String(params.id)}`)
          return { result: dispatchUiControl(context, params.args) }
        }
        case 'quirky.agents/list': return { agents: [] }
        case 'quirky.repo/show':
        case 'quirky.repo/hooks': return null
        case 'quirky.worktree/availableHosts': return []
        case 'quirky.worktree/prefetchCreate': return {}
        case 'quirky.worktree/create': {
          world.createCalls++
          const failure = world.createFailures.shift()
          if (failure !== undefined) throw failure
          return structuredClone(world.createResult)
        }
        case 'quirky.worktree/navigate': return {}
        case 'quirky.repo/list': {
          if (!world.deferRepoList) return [...world.repos]
          world.deferRepoList = false
          const { promise, resolve } = Promise.withResolvers<Repo[]>()
          world.pendingRepoList = resolve
          return promise
        }
        case 'quirky.repo/groupList': return [...world.groups]
        case 'quirky.worktree/list': return world.worktrees.map((row) => ({ ...row, tagIds: [...row.tagIds] }))
        case 'quirky.worktree/origins': return []
        case 'quirky.worktree/options': return { ...DEFAULT_STOCK_OPTIONS, filterRepoIds: [], showProperties: [...DEFAULT_STOCK_OPTIONS.showProperties] }
        case 'quirky.worktree/projectOrder': return world.repos.map((repo) => repo.id)
        case 'quirky.worktree/statusDefinitions': return [
          { id: 'todo', label: 'Todo', color: '#888' },
          { id: 'in-progress', label: 'In progress', color: '#3478c5' },
          { id: 'in-review', label: 'In review', color: '#a57de8' },
          { id: 'done', label: 'Done', color: '#48a878' }
        ]
        case 'quirky.worktree/projectMetadataList': return world.identities
        case 'quirky.session/list':
        case 'quirky.ask/list': return []
        case 'quirky.worktree/cleanupPreview': return { candidates: [] }
        case 'quirky.worktree/tags': return { tags: [], assignments: {} }
        case 'quirky.sidebar-extras/state': return { preferences: DEFAULT_ACTIVITY_PREFERENCES }
        case 'quirky.sidebar-extras/activate': return {}
        case 'quirky.sidebar-extras/projection': return {
          client: 'test', preferences: DEFAULT_ACTIVITY_PREFERENCES, active: null, visits: {}, exits: {},
          visibleIds: world.worktrees.map((row) => row.id), hiddenIds: [], hiddenCount: 0, filterCount: 0,
          automationHiddenIds: [], automationHiddenCount: 0, reviewHiddenIds: [], reviewHiddenCount: 0,
          workspaces: world.worktrees.map((row) => ({ worktreeId: row.id, activityAt: row.lastActivityAt, live: true, reason: 'all' }))
        }
        case 'quirky.worktree/views':
          if (world.failViews) throw new Error('views unavailable')
          return structuredClone(world.views)
        case 'quirky.worktree/setViews': {
          const next = structuredClone(params.state as ViewsState)
          world.setViewsCalls.push(next)
          if (world.failNextSave) {
            world.failNextSave = false
            throw new Error('views write failed')
          }
          if (world.deferNextSave) {
            world.deferNextSave = false
            const { promise, resolve } = Promise.withResolvers<ViewsState>()
            world.pendingSave = resolve
            return promise
          }
          world.views = next
          return structuredClone(next)
        }
        case 'quirky.worktree/activeView': return { viewId: world.active }
        case 'quirky.worktree/setActiveView': {
          const viewId = String(params.viewId)
          world.setActiveCalls.push(viewId)
          if (world.deferActiveView) {
            world.deferActiveView = false
            const { promise, reject } = Promise.withResolvers<unknown>()
            world.pendingActiveReject = reject
            return promise
          }
          world.active = viewId
          return {}
        }
        case 'quirky.repo/groupCreate': {
          world.groupCreateCalls++
          if (!world.deferGroupCreate) return {}
          world.deferGroupCreate = false
          const { promise, resolve } = Promise.withResolvers<unknown>()
          world.pendingGroupCreate = resolve
          return promise
        }
        default: throw new Error(`unexpected method ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    getSetting: () => undefined,
    executeCommand: async (...args: unknown[]) => { executeCommands.push(args); throw new Error('executeCommand must not handle section controls') },
    openView() {},
    closeView() {},
    togglePanel() {},
    getLayout: () => layout,
    onLayout(listener: (next: UiLayout) => void) {
      layoutListeners.add(listener)
      return () => void layoutListeners.delete(listener)
    },
    onStream: () => () => {},
    onConnection(listener: (status: string) => void) {
      connections.add(listener)
      return () => void connections.delete(listener)
    },
    async confirm() { return true },
    toast(title: string, message: string) { toasts.push({ title, message }) },
    setPanelBadge() {}
  } as unknown as UiPluginContext

  return {
    calls, toasts, logs, requests, executeCommands, world, context,
    setLayout(next: UiLayout) { layout = next; for (const listener of layoutListeners) listener(next) },
    async emit(type: string) {
      await act(async () => {
        await Promise.all([...listeners].map((listener) => listener({ type, data: {} } as QuirkyEvent)))
      })
    },
    async connect() {
      await act(async () => {
        for (const listener of connections) listener('connected')
      })
    }
  }
}

let host: HTMLElement
let root: Root | null = null
let current: Fixture

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // React DOM and the section capture the active document during module initialization.
  const react = await import('react')
  act = react.act as typeof act
  createElement = react.createElement
  createRoot = (await import('react-dom/client')).createRoot
  const ui = await import('@quirky/ui')
  ToolPanelFrame = ui.ToolPanelFrame
  WorktreesSection = (await import('../src/WorktreesSection')).WorktreesSection
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function mountSection(element: HTMLElement, context: UiPluginContext): Promise<Root> {
  const sectionRoot = createRoot(element)
  await act(async () => sectionRoot.render(createElement(ToolPanelFrame, {
    title: 'Worktrees',
    children: createElement(WorktreesSection, { context })
  })))
  await settle()
  return sectionRoot
}

beforeEach(async () => {
  current = setup()
  host = document.createElement('div')
  document.body.append(host)
  root = await mountSection(host, current.context)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host.remove()
})
async function remount(fixture: Fixture) {
  if (root) await act(async () => root!.unmount())
  root = null
  host.remove()
  current = fixture
  host = document.createElement('div')
  document.body.append(host)
  root = await mountSection(host, current.context)
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 10; index++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('expected a clickable element')
  await act(async () => {
    ;(element as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await settle()
}
async function pressEscape(target: EventTarget = window) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await settle()
}
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
}

const norm = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()
const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.getAttribute('aria-label') === label || norm(candidate.textContent) === label)
const menuItem = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => norm(item.textContent) === label)
const dialogField = (name: string) => {
  const label = [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')]
    .find((item) => norm(item.textContent) === name)
  const input = label?.control
  return input instanceof HTMLInputElement ? input : label?.querySelector<HTMLInputElement>('input') ?? null
}
async function selectNameMode() {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="tab"]')]
    .find((candidate) => norm(candidate.textContent) === 'Name')
  await click(tab)
}
const control = (operation: string, payload: Record<string, unknown> = {}) => ({
  action: 'control', scope: 'worktrees-section', target: 'worktrees', operation, payload
})
const deliver = (operation: string, payload: Record<string, unknown> = {}) =>
  dispatchUiControl(current.context, control(operation, payload))
async function dispatch(operation: string, payload: Record<string, unknown> = {}) {
  let result: UiControlResult | undefined
  await act(async () => {
    result = deliver(operation, payload)
  })
  await settle()
  return result!
}

test('a mounted header control requests the scoped command in its exact window', async () => {
  await click(button('Display'))

  expect(current.requests).toHaveLength(1)
  const request = current.requests[0]!
  expect(request.params.connId).toBe(7)
  expect(request.params.id).toBe(UI_CONTROL_COMMAND)
  expect(request.params.args).toMatchObject({
    action: 'control', scope: 'worktrees-section', target: 'worktrees', operation: 'set-menu',
    payload: { menu: 'display', owner: expect.any(String) }
  })
  expect(current.executeCommands).toHaveLength(0)
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
})

test('direct scoped commands control section menus, board, selection, and view drafts', async () => {
  expect((await dispatch('set-board', { open: true })).delivered).toBe(1)
  expect(host.querySelector('[aria-label="Workspace board"]')).not.toBeNull()

  expect((await dispatch('set-menu', { menu: 'filter' })).delivered).toBe(1)
  expect(document.querySelector('[role="dialog"][aria-label="Filter"]')).not.toBeNull()
  expect((await dispatch('set-menu', { menu: null })).delivered).toBe(1)
  expect(document.querySelector('[role="dialog"][aria-label="Filter"]')).toBeNull()

  expect((await dispatch('set-selection', { worktreeIds: ['wt-a', 'wt-b'] })).delivered).toBe(1)
  expect(host.querySelector('.worktree-tree-bulk')).not.toBeNull()
  expect((await dispatch('open-bulk-menu', { kind: 'status' })).delivered).toBe(1)
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect((await dispatch('clear-selection')).delivered).toBe(1)
  expect(host.querySelector('.worktree-tree-bulk')).toBeNull()

  expect((await dispatch('set-display', { viewId: 'view_a', patch: { sortBy: 'name' } })).delivered).toBe(1)
  expect(norm(host.querySelector('.ui-notice-line')?.textContent)).toContain('Changed: sort')
})

test('malformed exact payloads throw before mutation and other targets or absent resources are declined', async () => {
  const filter = current.world.views.views[0]!.spec.filter
  const malformed: Array<{ operation: string; payload: Record<string, unknown> }> = [
    { operation: 'not-an-operation', payload: {} },
    { operation: 'set-board', payload: { open: true, extra: true } },
    { operation: 'set-board', payload: { open: 'yes' } },
    { operation: 'set-board', payload: { open: true, owner: '' } },
    { operation: 'set-menu', payload: { menu: 'sideways' } },
    { operation: 'set-display', payload: { viewId: 'view_a', patch: {} } },
    { operation: 'set-display', payload: { viewId: 'view_a', patch: { sortBy: 'name', extra: true } } },
    { operation: 'set-filter', payload: { viewId: 'view_a', filter: { ...filter, tagIds: [1] } } },
    { operation: 'set-filter', payload: { viewId: 'view_a', filter: { ...filter, activity: { ...filter.activity, workspaceActivityCustomDays: 1.5 } } } },
    { operation: 'set-selection', payload: { worktreeIds: ['wt-a', 1] } },
    { operation: 'clear-selection', payload: { revision: -1 } },
    { operation: 'select-view', payload: { id: 'all', revision: 1.5 } },
    { operation: 'close-overlay', payload: { overlay: 'dialog', session: -1 } },
    { operation: 'request-delete', payload: { worktreeId: 'wt-a', descendants: Number.NaN } },
    { operation: 'set-row-fact', payload: { fact: 'owner' } },
    { operation: 'open-dialog', payload: { dialog: { kind: 'add-project', extra: true } } },
    { operation: 'save-new', payload: { viewId: 'view_a', name: '  ', starred: true } },
    { operation: 'save-new', payload: { viewId: 'view_a', name: 'x'.repeat(61), starred: true } }
  ]
  for (const item of malformed) {
    expect(() => deliver(item.operation, item.payload)).toThrow('Invalid worktrees-section control.')
  }
  expect(dispatchUiControl(current.context, { ...control('not-an-operation', { extra: true }), target: 'other' }).delivered).toBe(0)
  expect((await dispatch('open-dialog', { dialog: { kind: 'update', worktreeId: 'missing' } })).delivered).toBe(0)
  expect((await dispatch('select-view', { id: 'missing-view' })).delivered).toBe(0)
  expect((await dispatch('set-selection', { worktreeIds: ['wt-a', 'removed'] })).delivered).toBe(0)
  expect(current.world.setViewsCalls).toHaveLength(0)
  expect(current.calls.some((call) => call.method === 'quirky.worktree/setActiveView' && call.params.viewId === 'missing-view')).toBe(false)
})

test('a delayed close from a replaced same-target dialog leaves its replacement open', async () => {
  const dialog = {
    kind: 'group',
    action: 'new-worktree',
    worktreeId: 'wt-a',
    initialName: 'feature',
    expectedInstanceId: 'instance-a',
    expectedProjectGroupId: null
  }
  expect((await dispatch('open-dialog', { dialog })).delivered).toBe(1)
  await click(button('Close dialog', document))
  const oldCloseRequest = current.requests.filter((request) => {
    const args = request.params.args
    return typeof args === 'object' && args !== null && 'operation' in args && args.operation === 'close-overlay'
  }).at(-1)
  expect(oldCloseRequest).toBeDefined()
  const oldArgs = oldCloseRequest!.params.args

  expect((await dispatch('open-dialog', { dialog })).delivered).toBe(1)
  expect(dispatchUiControl(current.context, oldArgs).delivered).toBe(0)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

test('failed exact-window requests do not optimistically open a menu', async () => {
  const originalCall = current.context.call.bind(current.context)
  current.context.call = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'ui.window.command.run') throw new Error('no live UI window 7')
    return originalCall(method, params)
  }

  await click(button('Display'))

  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(current.toasts).toContainEqual({ title: 'Could not update worktree section', message: 'no live UI window 7' })
})
test('Display menu selection survives its preceding close request', async () => {
  await click(button('Display'))
  await click(menuItem('Save as view…'))

  const operations = current.requests.map((request) => {
    const args = request.params.args
    return typeof args === 'object' && args !== null && 'operation' in args ? args.operation : null
  })
  expect(operations.slice(-2)).toEqual(['set-menu', 'open-save'])
  expect(document.querySelector('#worktree-view-name')?.closest('[role="dialog"]')).not.toBeNull()
})

test('Escape routes selection, named-filter, and view clearing in order', async () => {
  expect((await dispatch('set-selection', { worktreeIds: ['wt-a', 'wt-b'] })).delivered).toBe(1)
  await pressEscape()
  expect(host.querySelector('.worktree-tree-bulk')).toBeNull()
  expect(current.requests.at(-1)?.params.args).toMatchObject({
    operation: 'clear-selection',
    payload: { owner: expect.any(String), revision: expect.any(Number) }
  })

  const filter = { ...current.world.views.views[0]!.spec.filter, repoIds: ['repo-b'] }
  expect((await dispatch('set-filter', { viewId: 'view_a', filter })).delivered).toBe(1)
  await pressEscape()
  expect(current.requests.at(-1)?.params.args).toMatchObject({
    operation: 'clear-filters',
    payload: { viewId: 'view_a', owner: expect.any(String), revision: expect.any(Number) }
  })

  expect((await dispatch('select-view', { id: 'needs-you' })).delivered).toBe(1)
  const filterButton = button('Filter')!
  expect((filterButton as HTMLButtonElement).disabled).toBe(true)
  expect((await dispatch('set-menu', { menu: 'filter' })).delivered).toBe(0)
  await click(button('Show all worktrees', document))
  expect(current.requests.at(-1)?.params.args).toMatchObject({ operation: 'select-view', payload: { id: 'all' } })
})

test('Escape does not clear selection while an empty contenteditable owns the key', async () => {
  expect((await dispatch('set-selection', { worktreeIds: ['wt-a', 'wt-b'] })).delivered).toBe(1)
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', '')
  host.append(editor)
  const before = current.requests.length
  await pressEscape(editor)
  expect(current.requests.slice(before)).toHaveLength(0)
  expect(host.querySelector('.worktree-tree-bulk')).not.toBeNull()
  editor.remove()
})
test('selected live worktrees remain selected while their draft filter hides them', async () => {
  expect((await dispatch('set-selection', { worktreeIds: ['wt-a', 'wt-b'] })).delivered).toBe(1)
  const filter = { ...current.world.views.views[0]!.spec.filter, repoIds: ['repo-b'] }
  expect((await dispatch('set-filter', { viewId: 'view_a', filter })).delivered).toBe(1)
  expect(host.querySelector('.worktree-tree-bulk')).not.toBeNull()
  expect((await dispatch('set-selection', { worktreeIds: ['wt-a', 'removed'] })).delivered).toBe(0)
  expect(host.querySelector('.worktree-tree-bulk')).not.toBeNull()
})

test('project identities safely retain prototype-like ids, last duplicates, and all-or-nothing reads', async () => {
  const repo = (id: string, name: string, path: string): Repo => ({
    id, name, path, addedAt: 0, kind: 'git', displayName: null, groupId: null
  })
  const worktree = (id: string, repoId: string, name: string, instanceId: string): WorktreeRow => ({
    ...worktreeRows[0]!,
    id,
    repoId,
    name,
    path: `/projects/${name}`,
    instanceId,
    branch: 'main',
    parentId: null,
    tagIds: []
  })
  const identity = (icon: string, trackerProject: string) => ({
    displayName: null,
    icon,
    color: '#336699',
    trackerProject
  })
  current.world.repos = [
    repo('__proto__', 'prototype', '/projects/prototype'),
    repo('toString', 'string-id', '/projects/string-id')
  ]
  current.world.worktrees = [
    worktree('wt-prototype', '__proto__', 'prototype-main', 'proto-instance'),
    worktree('wt-string', 'toString', 'string-main', 'string-instance')
  ]
  current.world.identities = [
    { repoId: '__proto__', identity: identity('Old', 'old-tracker') },
    { repoId: '__proto__', identity: identity('Last', 'last-tracker') },
    { repoId: 'toString', identity: identity('T', 'string-tracker') }
  ]
  await current.emit('quirky.repo/changed')
  await settle()

  const prototypeHeader = host.querySelector<HTMLElement>('[data-repo-target="__proto__"]')
  const stringHeader = host.querySelector<HTMLElement>('[data-repo-target="toString"]')
  expect(norm(prototypeHeader?.textContent)).toContain('Last prototype')
  expect(norm(prototypeHeader?.textContent)).not.toContain('Old prototype')
  expect(norm(stringHeader?.textContent)).toContain('T string-id')

  current.world.identities = [
    { repoId: '__proto__', identity: identity('Partial', 'partial-tracker') },
    { repoId: 'toString', identity: null }
  ]
  await current.emit('quirky.worktree/projectMetadataChanged')
  await settle()
  expect(norm(host.querySelector<HTMLElement>('[data-repo-target="__proto__"]')?.textContent)).toContain('Last prototype')
  expect(norm(host.querySelector<HTMLElement>('[data-repo-target="toString"]')?.textContent)).toContain('T string-id')
})

test('writes wait for saved views and reconnect retries the initial read', async () => {
  const fixture = setup()
  fixture.world.failViews = true
  await remount(fixture)

  expect((await dispatch('star-view', { id: 'view_a', starred: true })).delivered).toBe(1)
  expect(current.world.setViewsCalls).toHaveLength(0)
  expect(current.toasts).toContainEqual({ title: 'Views are still loading', message: 'Try again in a moment.' })

  current.world.failViews = false
  await current.connect()
  await settle()
  expect((await dispatch('star-view', { id: 'view_a', starred: true })).delivered).toBe(1)
  expect(current.world.setViewsCalls).toHaveLength(1)
})

test('a late Save preserves a newer draft and serializes competing view writes', async () => {
  expect((await dispatch('set-display', { viewId: 'view_a', patch: { sortBy: 'name' } })).delivered).toBe(1)
  current.world.deferNextSave = true
  expect((await dispatch('save-draft', { viewId: 'view_a' })).delivered).toBe(1)
  expect(current.world.setViewsCalls).toHaveLength(1)
  expect((await dispatch('star-view', { id: 'view_a', starred: true })).delivered).toBe(0)
  expect((await dispatch('set-display', { viewId: 'view_a', patch: { groupBy: 'status' } })).delivered).toBe(1)

  const normalized = structuredClone(current.world.setViewsCalls[0]!)
  current.world.views = normalized
  current.world.pendingSave?.(normalized)
  current.world.pendingSave = null
  await settle()
  expect(norm(host.querySelector('.ui-notice-line')?.textContent)).toContain('Changed: grouping')
  expect(current.world.setViewsCalls).toHaveLength(1)
})

test('Save as new trims its name and never pulls back an A-to-B-to-A view', async () => {
  expect((await dispatch('set-display', { viewId: 'view_a', patch: { sortBy: 'name' } })).delivered).toBe(1)
  expect((await dispatch('open-save', { viewId: 'view_a' })).delivered).toBe(1)
  await typeInto(document.querySelector<HTMLInputElement>('#worktree-view-name')!, '  Release 2.4  ')
  current.world.deferNextSave = true
  await click(button('Save view', document))
  expect(current.world.setViewsCalls).toHaveLength(1)
  const submitted = current.world.setViewsCalls[0]!
  const newView = submitted.views.find((view) => view.id !== 'view_a')!
  expect(newView.name).toBe('Release 2.4')
  expect(newView.spec.display.sortBy).toBe('name')
  expect(newView.starred).toBe(true)

  expect((await dispatch('select-view', { id: 'all' })).delivered).toBe(1)
  expect((await dispatch('select-view', { id: 'view_a' })).delivered).toBe(1)
  const normalized = structuredClone(submitted)
  normalized.views = normalized.views.map((view) => view.id === newView.id ? { ...view, name: 'Normalized release' } : view)
  current.world.views = normalized
  current.world.pendingSave?.(normalized)
  current.world.pendingSave = null
  await settle()

  expect(button('Normalized release', document)).not.toBeNull()
  expect(document.querySelector('#worktree-view-name')?.closest('[role="dialog"]')).not.toBeNull()
  expect(current.world.active).toBe('view_a')
})

test('closing and reopening Save view fences the older save completion', async () => {
  expect((await dispatch('open-save', { viewId: 'view_a' })).delivered).toBe(1)
  await typeInto(document.querySelector<HTMLInputElement>('#worktree-view-name')!, 'Release 2.4')
  current.world.deferNextSave = true
  await click(button('Save view', document))
  const submitted = current.world.setViewsCalls[0]!

  await click(button('Close dialog', document))
  expect((await dispatch('open-save', { viewId: 'view_a' })).delivered).toBe(1)
  const normalized = structuredClone(submitted)
  current.world.views = normalized
  current.world.pendingSave?.(normalized)
  current.world.pendingSave = null
  await settle()

  expect(document.querySelector('#worktree-view-name')?.closest('[role="dialog"]')).not.toBeNull()
  expect(current.world.active).toBe('view_a')
})

test('New section ignores duplicate programmatic submits while group creation is pending', async () => {
  expect((await dispatch('open-dialog', { dialog: { kind: 'group', action: 'new-section' } })).delivered).toBe(1)
  await typeInto(document.querySelector<HTMLInputElement>('#worktree-section-name')!, 'Engineering')
  current.world.deferGroupCreate = true
  const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
  expect(current.world.groupCreateCalls).toBe(1)

  current.world.pendingGroupCreate?.({})
  current.world.pendingGroupCreate = null
  await settle()
})
test('More menu dismissal routes Add project before opening the form', async () => {
  await click(button('More'))
  await click(menuItem('Add project'))
  const operations = current.requests.map((request) => {
    const args = request.params.args
    return typeof args === 'object' && args !== null && 'operation' in args ? args.operation : null
  })
  expect(operations.slice(-2)).toEqual(['set-menu', 'open-dialog'])
  expect(document.querySelector('[role="dialog"] input')).not.toBeNull()
})

test('Save view ignores duplicate programmatic submits while a write is pending', async () => {
  expect((await dispatch('open-save', { viewId: 'view_a' })).delivered).toBe(1)
  await typeInto(document.querySelector<HTMLInputElement>('#worktree-view-name')!, 'Release 2.4')
  current.world.deferNextSave = true
  const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
  expect(current.world.setViewsCalls).toHaveLength(1)
  expect((await dispatch('star-view', { id: 'view_a', starred: true })).delivered).toBe(0)

  const saveNewRequestsBefore = current.requests.filter((request) => {
    const args = request.params.args
    return typeof args === 'object' && args !== null && 'operation' in args && args.operation === 'save-new'
  }).length
  await submitForm(form)
  const saveNewRequestsAfter = current.requests.filter((request) => {
    const args = request.params.args
    return typeof args === 'object' && args !== null && 'operation' in args && args.operation === 'save-new'
  }).length
  expect(saveNewRequestsAfter).toBe(saveNewRequestsBefore)

  const normalized = structuredClone(current.world.setViewsCalls[0]!)
  current.world.views = normalized
  current.world.pendingSave?.(normalized)
  current.world.pendingSave = null
  await settle()
})

test('scope cleanup is per mount and context replacement rejects the old owner', async () => {
  await click(button('Display'))
  const oldContext = current.context
  const oldArgs = current.requests.at(-1)!.params.args
  const secondHost = document.createElement('div')
  host.append(secondHost)
  const secondRoot = await mountSection(secondHost, oldContext)
  try {
    expect((await dispatch('set-board', { open: true })).delivered).toBe(2)
    await act(async () => secondRoot.unmount())
    secondHost.remove()
    expect((await dispatch('set-board', { open: false })).delivered).toBe(1)

    const replacement = setup(9)
    await act(async () => root!.render(createElement(ToolPanelFrame, {
      title: 'Worktrees',
      children: createElement(WorktreesSection, { context: replacement.context })
    })))
    current = replacement
    await settle()
    expect(dispatchUiControl(oldContext, oldArgs).delivered).toBe(0)
    expect(dispatchUiControl(replacement.context, oldArgs).delivered).toBe(0)
    await click(button('Display'))
    expect(current.requests.at(-1)?.params.connId).toBe(9)
  } finally {
    if (secondRoot) await act(async () => secondRoot.unmount())
    secondHost.remove()
  }
})

test('a reordered but structurally valid command reply succeeds', async () => {
  const originalCall = current.context.call.bind(current.context)
  current.context.call = async (method: string, params?: Record<string, unknown>) => {
    if (method !== 'ui.window.command.run') return originalCall(method, params)
    const reply = await originalCall(method, params) as {
      result: Record<string, unknown> & { payload: Record<string, unknown> }
    }
    return {
      result: {
        ...reply.result,
        payload: Object.fromEntries(Object.entries(reply.result.payload).reverse())
      }
    }
  }

  await click(button('Display'))
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(current.toasts).toHaveLength(0)
})
test('a rejected control after unmount does not report through a revoked context', async () => {
  const { promise, reject } = Promise.withResolvers<unknown>()
  const originalCall = current.context.call.bind(current.context)
  current.context.call = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'ui.window.command.run') return promise
    return originalCall(method, params)
  }
  let revokedToasts = 0
  current.context.toast = () => {
    revokedToasts++
    throw new Error('plugin context is revoked')
  }

  await click(button('Display'))
  await act(async () => root!.unmount())
  root = null
  reject(new Error('window rejected'))
  await settle()
  expect(revokedToasts).toBe(0)
})
test('pending tree reads render a shared loading line without empty states', async () => {
  const fixture = setup()
  fixture.world.deferRepoList = true
  await remount(fixture)
  expect(norm(document.querySelector('[role="status"] .ui-notice-line')?.textContent)).toBe('Loading projects and worktrees…')
  expect(document.querySelector('.ui-empty-state')).toBeNull()

  current.world.pendingRepoList?.(current.world.repos)
  current.world.pendingRepoList = null
  await settle()
  expect(document.querySelector('.ui-empty-state')).toBeNull()
})

test('loaded zero projects use the shared EmptyState and routed Add project action', async () => {
  const fixture = setup()
  fixture.world.repos = []
  fixture.world.worktrees = []
  await remount(fixture)

  const empty = document.querySelector('.ui-empty-state')
  expect(norm(empty?.querySelector('.ui-empty-state__message')?.textContent)).toBe('No projects yet.')
  await click(button('Add project', document))
  expect(current.requests.at(-1)?.params.args).toMatchObject({
    operation: 'open-dialog',
    payload: { dialog: { kind: 'add-project' }, owner: expect.any(String) }
  })
})

test('Needs you with no waiting rows uses the shared EmptyState', async () => {
  expect((await dispatch('select-view', { id: 'needs-you' })).delivered).toBe(1)
  const empty = document.querySelector('.ui-empty-state')
  expect(norm(empty?.querySelector('.ui-empty-state__message')?.textContent)).toBe('Nothing needs you.')
  expect(button('Show all worktrees', document)).not.toBeNull()
})
test('successive trust prompts for one repo fence the older answer and fallback close', async () => {
  const untrusted = () => Object.assign(new Error('shared setup is untrusted'), {
    data: {
      reason: 'hooks-untrusted',
      repo: 'repo-a',
      kind: 'setup',
      script: 'echo setup',
      hash: 'a'.repeat(64),
      ref: 'main'
    }
  })
  current.world.createFailures = [untrusted(), untrusted()]
  current.world.createResult = {
    worktree: { id: 'wt-created', name: 'trust-test', path: '/projects/alpha/trust-test' },
    warnings: [],
    setup: { ran: 'none' },
    baseFallback: { message: 'The selected base could not be fast-forwarded.' }
  }
  expect((await dispatch('open-dialog', { dialog: { kind: 'create', repoId: 'repo-a' } })).delivered).toBe(1)
  await selectNameMode()
  await typeInto(dialogField('Name')!, 'trust-test')
  await click(button('Create', document))
  await settle()
  expect(current.world.createCalls).toBe(1)
  expect(document.body.textContent).toContain('Run setup from alpha?')

  await click(button("Don't run", document))
  await settle()
  expect(current.world.createCalls).toBe(2)
  const oldAnswer = current.requests.filter((request) => {
    const args = request.params.args
    return typeof args === 'object' && args !== null && 'operation' in args && args.operation === 'answer-trust'
  }).at(-1)!.params.args
  expect(document.body.textContent).toContain('Run setup from alpha?')
  expect(dispatchUiControl(current.context, oldAnswer).delivered).toBe(0)

  await click(button("Don't run", document))
  await settle()
  expect(current.world.createCalls).toBe(3)
  expect(document.body.textContent).toContain('The selected base could not be fast-forwarded.')
  await click(button('Close dialog', document))
  expect(current.requests.at(-1)?.params.args).toMatchObject({
    operation: 'dismiss-fallback',
    payload: { worktreeId: 'wt-created', session: expect.any(Number) }
  })
})
test('ViewTabs persistence actions route through the section controller', async () => {
  await click(button('All views'))
  await click(menuItem('Hide Needs you'))
  let args = current.requests.at(-1)?.params.args
  expect(args).toMatchObject({ operation: 'hide-needs-you', payload: { hidden: true } })
  expect(current.world.setViewsCalls).toHaveLength(1)

  const tab = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }))
  })
  await settle()
  await click(menuItem('Show as a tab'))
  const operations = current.requests.map((request) => {
    const value = request.params.args
    return typeof value === 'object' && value !== null && 'operation' in value ? value.operation : null
  })
  expect(operations.slice(-2)).toEqual(['close-view-menu', 'star-view'])
  expect(current.world.setViewsCalls).toHaveLength(2)

  const starred = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => {
    starred.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }))
  })
  await settle()
  await click(menuItem('Delete view'))
  expect(current.requests.at(-1)?.params.args).toMatchObject({ operation: 'delete-view', payload: { id: 'view_a' } })
  expect(current.world.setViewsCalls).toHaveLength(3)
})

test('a rejected ViewTabs selection callback makes no native view write', async () => {
  const tab = host.querySelector<HTMLElement>('[role="tab"][data-view-id="view_a"]')!
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }))
  })
  await settle()
  const originalCall = current.context.call.bind(current.context)
  const attempted: unknown[] = []
  current.context.call = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'ui.window.command.run') {
      attempted.push(params?.args)
      throw new Error('no live UI window 7')
    }
    return originalCall(method, params)
  }

  await click(menuItem('Show as a tab'))
  const attemptedOperations = attempted.map((value) =>
    typeof value === 'object' && value !== null && 'operation' in value ? value.operation : null
  )
  expect(attemptedOperations.slice(-2)).toEqual(['close-view-menu', 'star-view'])
  expect(current.world.setViewsCalls).toHaveLength(0)
  expect(current.toasts).toContainEqual({ title: 'Could not update worktree section', message: 'no live UI window 7' })

})
test('a delayed Add project scan cannot overwrite a replacement dialog step', async () => {
  const { promise, resolve } = Promise.withResolvers<{ repos: unknown[] }>()
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>()
  const originalCall = current.context.call.bind(current.context)
  current.context.call = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'quirky.repo/add') {
      throw Object.assign(new Error('not a repository'), { data: { reason: 'not-a-repository' } })
    }
    if (method === 'quirky.repo/scan') {
      markStarted()
      return promise
    }
    return originalCall(method, params)
  }
  expect((await dispatch('open-dialog', { dialog: { kind: 'add-project' } })).delivered).toBe(1)
  await typeInto(document.querySelector<HTMLInputElement>('#add-project-path')!, '/tmp/project-folder')
  await click(button('Add', document))
  await started

  expect((await dispatch('open-dialog', { dialog: { kind: 'group', action: 'new-section' } })).delivered).toBe(1)
  resolve({ repos: [{}] })
  await settle()

  expect(document.querySelector<HTMLInputElement>('#worktree-section-name')).not.toBeNull()
  expect(document.querySelector('#add-project-group-name')).toBeNull()
})
test('unrevisioned display and filter commands compose in one dispatch batch', async () => {
  const filter = { ...current.world.views.views[0]!.spec.filter, repoIds: ['repo-b'] }
  let displayResult: UiControlResult
  let filterResult: UiControlResult
  await act(async () => {
    displayResult = dispatchUiControl(current.context, control('set-display', {
      viewId: 'view_a',
      patch: { sortBy: 'name' }
    }))
    filterResult = dispatchUiControl(current.context, control('set-filter', {
      viewId: 'view_a',
      filter
    }))
  })
  await settle()

  expect(displayResult!.delivered).toBe(1)
  expect(filterResult!.delivered).toBe(1)
  expect(norm(host.querySelector('.ui-notice-line')?.textContent)).toContain('Changed: sort, projects')
  expect(norm(host.querySelector('.worktree-tree-filter-chip')?.textContent)).toContain('beta')
})

test('a delayed failed native view selection cannot overwrite a replacement context', async () => {
  current.world.deferActiveView = true
  const contextA = current.context
  expect((await dispatch('select-view', { id: 'all' })).delivered).toBe(1)
  await settle()
  const rejectA = current.world.pendingActiveReject!

  const replacement = setup(9)
  const viewA = replacement.world.views.views[0]!
  replacement.world.views = {
    ...replacement.world.views,
    views: [...replacement.world.views.views, { ...viewA, id: 'view_b', name: 'View B', starred: true }]
  }
  replacement.world.active = 'view_b'
  await act(async () => root!.render(createElement(ToolPanelFrame, {
    title: 'Worktrees',
    children: createElement(WorktreesSection, { context: replacement.context })
  })))
  current = replacement
  await settle()
  expect(host.querySelector('[role="tab"][data-view-id="view_b"]')?.getAttribute('aria-selected')).toBe('true')

  rejectA(new Error('old window disappeared'))
  await settle()
  expect(host.querySelector('[role="tab"][data-view-id="view_b"]')?.getAttribute('aria-selected')).toBe('true')
  expect(current.world.active).toBe('view_b')
})
test('a delayed Display open cannot replace the newer More menu', async () => {
  const originalCall = current.context.call.bind(current.context)
  const identities: Array<(value: unknown) => void> = []
  current.context.call = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'ui.window.self') {
      const { promise, resolve } = Promise.withResolvers<unknown>()
      identities.push(resolve)
      return promise
    }
    return originalCall(method, params)
  }

  await click(button('Display'))
  await click(button('More'))
  expect(identities).toHaveLength(2)
  identities[1]!({ connId: 7 })
  await settle()
  identities[0]!({ connId: 7 })
  await settle()

  const menu = document.querySelector('[role="menu"]')
  expect(norm(menu?.textContent)).toContain('Add project')
  expect(norm(menu?.textContent)).not.toContain('Group by')
})
test('a rejected Filter close preserves invalid custom-days text and validation', async () => {
  await click(button('Filter'))
  const activityWindow = document.querySelector<HTMLSelectElement>('select[aria-label="Activity window"]')!
  await act(async () => {
    activityWindow.value = 'custom'
    activityWindow.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  const days = document.querySelector<HTMLInputElement>('#worktree-tree-filter-custom-days')!
  await typeInto(days, 'not-a-day')
  await act(async () => {
    days.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await settle()

  const originalCall = current.context.call.bind(current.context)
  current.context.call = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'ui.window.command.run') throw new Error('no live UI window 7')
    return originalCall(method, params)
  }
  await click(button('Filter'))
  const openFilter = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Filter"]')
  expect(openFilter).not.toBeNull()
  expect((openFilter!.querySelector('#worktree-tree-filter-custom-days') as HTMLInputElement).value).toBe('not-a-day')
  expect(norm(openFilter!.textContent)).toContain('Enter a positive whole number of days.')

  current.context.call = originalCall
  await click(button('Filter'))
  expect(document.querySelector('[role="dialog"][aria-label="Filter"]')).toBeNull()
})

test('same-batch destination edits preserve that view’s display and remove current filters', async () => {
  const fixture = setup()
  const original = fixture.world.views.views[0]!
  const destination: ViewsState['views'][number] = {
    ...original,
    id: 'view_b',
    name: 'View B',
    starred: true,
    spec: { ...original.spec, display: { ...original.spec.display, groupBy: 'status', sortBy: 'name' } }
  }
  fixture.world.views.views.push(destination)
  await remount(fixture)

  const replies: UiControlResult[] = []
  await act(async () => {
    replies.push(deliver('select-view', { id: destination.id }))
    replies.push(deliver('set-filter', {
      viewId: destination.id,
      filter: { ...destination.spec.filter, repoIds: ['repo-b'] }
    }))
  })
  await settle()
  expect(replies.map((reply) => reply.delivered)).toEqual([1, 1])
  expect(norm(host.querySelector('.ui-notice-line')?.textContent)).toContain('Changed: projects')

  const display = { ...destination.spec.display, showAsleep: !destination.spec.display.showAsleep }
  await act(async () => {
    replies.push(deliver('set-display', { viewId: destination.id, patch: { showAsleep: display.showAsleep } }))
    replies.push(deliver('remove-filter', { viewId: destination.id, key: 'repoIds:repo-b' }))
  })
  await settle()
  expect(replies.map((reply) => reply.delivered)).toEqual([1, 1, 1, 1])
  expect(host.querySelector('.worktree-tree-filter-chip')).toBeNull()
  expect((await dispatch('save-draft', { viewId: destination.id })).delivered).toBe(1)
  const saved = current.world.setViewsCalls.at(-1)!.views.find((view) => view.id === destination.id)!
  expect(saved.spec.display).toEqual(display)
  expect(saved.spec.filter.repoIds).toEqual([])
})
