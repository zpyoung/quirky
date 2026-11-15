import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ProjectGroup, Repo, UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import { dispatchUiControl, requestUiControl, UI_CONTROL_COMMAND, type ScopedUiControlInput, type UiControlResult } from '../src/ui-control'
import type { TreeProps } from '../src/Tree'
import { PRIMARY_DELETE_TIP } from '../src/Menu'
import type { ViewGroup, ViewTree } from '../src/view-model'
import { buildTree } from '../src/view-model'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES, type GroupBy } from '../src/view-types'

const NOW = 10_000_000
const REPO: Repo = { id: 'r1', name: 'QuirkyApp', path: '/repo/QuirkyApp', addedAt: 1, kind: 'git', displayName: null, groupId: null }
const repo = (id: string, patch: Partial<Repo> = {}): Repo => ({ ...REPO, id, name: id, path: `/repo/${id}`, ...patch })
const section = (id: string, parentId: string | null = null, repoIds: string[] = [], collapsed = false): ProjectGroup => ({
  id, name: id, parentPath: null, collapsed, order: 0, createdFrom: 'manual', repoIds, parentId
})
const worktree = (id: string, extra: Partial<WorktreeControl> = {}): WorktreeControl => ({
  id, repoId: 'r1', path: `/repo/QuirkyApp/${id}`, branch: id, head: 'abc', isMain: false, name: id, instanceId: `instance:${id}`,
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false, parentId: null,
  createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false, removing: false, groupId: null, projectGroupId: null,
  lastActivityAt: NOW - 60_000, manualOrder: 0, sleeping: false, sleepChangedAt: null, references: [], archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null }, externalVisible: true,
  externalVisibility: 'show', externalInboxSuppressed: false, tagIds: [], ...extra
}) as WorktreeControl

type Call = { method: string; params: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type World = {
  context: UiPluginContext
  calls: Call[]
  toasts: Array<[string, string | undefined]>
  logs: string[]
  connId: number
  selfReply?: unknown
  selfFailure: unknown
  commandFailure: unknown
  holdOperation: string | null
  commandGate: Promise<unknown> | null
}
const windows = new Map<number, UiPluginContext>()
function world(connId: number): World {
  const value: World = {
    context: null as unknown as UiPluginContext,
    calls: [],
    toasts: [],
    logs: [],
    connId,
    selfFailure: null,
    commandFailure: null,
    holdOperation: null,
    commandGate: null
  }
  const rawContext = {
    async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      value.calls.push({ method, params })
      if (method === 'ui.window.self') {
        if (value.selfFailure) throw value.selfFailure
        if (value.selfReply !== undefined) return value.selfReply
        return { connId: value.connId }
      }
      if (method === 'ui.window.command.run') {
        if (value.commandFailure) throw value.commandFailure
        const args = params.args as { operation?: string } | undefined
        if (args?.operation === value.holdOperation && value.commandGate) await value.commandGate
        const target = windows.get(params.connId as number)
        if (!target) throw new Error(`no live UI window ${String(params.connId)}`)
        return { result: dispatchUiControl(target, params.args) }
      }
      if (method === 'plugin.list') return []
      return {}
    },
    executeCommand() { throw new Error('executeCommand must not be used') },
    subscribe() { return () => {} },
    onConnection() { return () => {} },
    openView() {},
    toast(title: string, message?: string) { value.toasts.push([title, message]) },
    log(message: string) { value.logs.push(message) },
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    getSetting: () => undefined
  }
  value.context = rawContext as unknown as UiPluginContext
  windows.set(connId, value.context)
  return value
}

let Tree: typeof import('../src/Tree').Tree
let createRoot: typeof import('react-dom/client').createRoot
let host: HTMLElement
const mounts: Array<{ root: Root; mounted: boolean }> = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Tree = (await import('../src/Tree')).Tree
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => windows.clear())
afterEach(async () => {
  await act(async () => {
    for (const mounted of mounts.splice(0)) {
      if (mounted.mounted) mounted.root.unmount()
    }
  })
  document.body.replaceChildren()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}
async function waitFor<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    await flush()
    const value = read()
    if (value !== null && value !== undefined && value !== false) return value as T
  }
  throw new Error('Tree did not reach the expected state')
}
async function click(target: Element | null | undefined): Promise<void> {
  if (!target) throw new Error('Expected a rendered control')
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  await flush()
}
async function keydown(target: Element, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  await flush()
}
function labelled(root: ParentNode, label: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('[aria-label]')].find((item) => item.getAttribute('aria-label') === label) ?? null
}
function menu(): HTMLElement | null { return document.querySelector<HTMLElement>('[role="menu"]') }
function menuLabel(item: HTMLElement): string {
  return item.querySelector<HTMLElement>('.qt-menu-label')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}
function menuItems(): HTMLElement[] { return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')] }
function menuItem(label: string): HTMLElement | null {
  return menuItems().find((item) => menuLabel(item) === label) ?? null
}
function control(target: string, operation: string, payload?: Record<string, unknown>): ScopedUiControlInput {
  return { action: 'control', scope: 'tree', target, operation, ...(payload === undefined ? {} : { payload }) }
}
async function dispatchTree(h: Mounted, target: string, operation: string, payload?: Record<string, unknown>) {
  let result!: UiControlResult
  await act(async () => { result = dispatchUiControl(h.context, control(target, operation, payload)) })
  await flush()
  return result
}
async function dispatchContextControl(context: UiPluginContext, args: unknown): Promise<UiControlResult> {
  let result!: UiControlResult
  await act(async () => { result = dispatchUiControl(context, args) })
  await flush()
  return result
}
async function requestContextControl(context: UiPluginContext, args: ScopedUiControlInput): Promise<UiControlResult> {
  let result!: UiControlResult
  await act(async () => { result = await requestUiControl(context, args) })
  await flush()
  return result
}

type Config = {
  world?: World
  context?: UiPluginContext
  worktrees?: WorktreeControl[]
  repos?: Repo[]
  groups?: ProjectGroup[]
  display?: GroupBy
  emptyProjects?: boolean
  collapsed?: ReadonlySet<string>
  model?: ViewTree
  treeProps?: Partial<TreeProps>
  withoutGroupAction?: boolean
}
type Mounted = {
  context: UiPluginContext
  world: World
  host: HTMLElement
  calls: Call[]
  toasts: Array<[string, string | undefined]>
  logs: string[]
  dialogs: unknown[]
  deletes: Array<[string, number]>
  toggles: string[]
  renames: Array<[string, string]>
  groupActions: Array<[string, string]>
  render(changes?: Partial<Config>): Promise<void>
  unmount(): Promise<void>
}
async function mountTree(options: Config = {}): Promise<Mounted> {
  const current: Config = { ...options }
  const contextWorld = current.world ?? world(7)
  const dialogs: unknown[] = []
  const deletes: Array<[string, number]> = []
  const toggles: string[] = []
  const renames: Array<[string, string]> = []
  const groupActions: Array<[string, string]> = []
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const mounted = { root, mounted: true }
  mounts.push(mounted)

  const draw = async (changes: Partial<Config> = {}) => {
    Object.assign(current, changes)
    const rows = current.worktrees ?? [worktree('w1')]
    const repos = current.repos ?? [REPO]
    const groups = current.groups ?? []
    const display = current.display ?? 'section-project'
    const stock = { ...DEFAULT_STOCK_OPTIONS }
    const base = allSpecFromStock(stock, DEFAULT_ACTIVITY_PREFERENCES)
    const model = current.model ?? buildTree({
      worktrees: rows,
      repos,
      groups,
      tags: [],
      spec: { ...base, display: { ...base.display, groupBy: display } },
      viewId: 'all',
      projection: null,
      marks: new Map(),
      checks: new Map()
    })
    const props: TreeProps = {
      context: current.context ?? contextWorld.context,
      model,
      tagsById: new Map(),
      rowFact: 'last-activity',
      repos,
      groups,
      sessions: [],
      selectedId: null,
      automationExpandedId: null,
      automationAvailability: null,
      onToggleAutomationDetails: () => {},
      now: NOW,
      separatorEnabled: false,
      options: stock,
      groupBy: display,
      emptyProjects: current.emptyProjects ?? false,
      collapsed: current.collapsed,
      allWorktrees: rows,
      canShowSleeping: () => true,
      statusDefinitions: [],
      projectIdentities: {},
      openDialog: (dialog) => { dialogs.push(dialog) },
      requestDelete: (target, count) => { deletes.push([target.id, count]) },
      onDropPreviewChange: () => {},
      onSeparatorStateChange: () => {},
      onRename: (id, name) => { renames.push([id, name]) },
      onToggleCollapsed: (key) => { toggles.push(key) },
      onGroupAction: (group, action) => { groupActions.push([group.key, action]) },
      ...current.treeProps
    }
    if (current.withoutGroupAction) delete props.onGroupAction
    await act(async () => { root.render(createElement(Tree, props)); await Promise.resolve() })
    await flush()
  }
  await draw()
  return {
    get context() { return current.context ?? contextWorld.context },
    world: contextWorld,
    host,
    calls: contextWorld.calls,
    toasts: contextWorld.toasts,
    logs: contextWorld.logs,
    dialogs,
    deletes,
    toggles,
    renames,
    groupActions,
    render: draw,
    async unmount() {
      if (!mounted.mounted) return
      await act(async () => root.unmount())
      mounted.mounted = false
    }
  }
}

const row = (h: Mounted, id: string) => h.host.querySelector<HTMLElement>(`[data-worktree-id="${id}"]`)
const menuButton = (h: Mounted, id: string, occurrence = 0) =>
  [...h.host.querySelectorAll<HTMLElement>(`[data-worktree-id="${id}"] .worktree-menu`)][occurrence] ?? null
async function openRowMenu(h: Mounted, id: string, occurrence = 0): Promise<void> {
  const trigger = menuButton(h, id, occurrence)
  trigger?.focus()
  await click(trigger)
  await waitFor(() => menu())
}


test('routes only to the active window and cleans up registrations on unmount and context replacement', async () => {
  const a = await mountTree({ world: world(7) })
  const b = await mountTree({ world: world(9) })
  const request = control('w1', 'start-rename')
  expect(await requestContextControl(a.context, request)).toMatchObject({ delivered: 1 })
  expect(a.host.querySelector('.worktree-rename')).not.toBeNull()
  expect(b.host.querySelector('.worktree-rename')).toBeNull()
  expect(await requestContextControl(b.context, request)).toMatchObject({ delivered: 1 })
  expect(b.host.querySelector('.worktree-rename')).not.toBeNull()
  for (const h of [a, b]) {
    expect(h.calls.filter((call) => call.method === 'ui.window.command.run')).toEqual([{
      method: 'ui.window.command.run',
      params: { connId: h.world.connId, id: UI_CONTROL_COMMAND, args: request }
    }])
  }

  const replacement = world(8)
  await a.render({ context: replacement.context })
  expect((await dispatchContextControl(a.world.context, request)).delivered).toBe(0)
  expect((await dispatchContextControl(replacement.context, request)).delivered).toBe(1)
  await a.unmount()
  expect((await dispatchContextControl(replacement.context, request)).delivered).toBe(0)
})

test('rejects malformed tree-control payloads, unknown operations, and hidden or invented targets', async () => {
  const h = await mountTree({ worktrees: [worktree('parent'), worktree('child', { parentId: 'parent' })] })
  const child = row(h, 'child')!
  expect(child).not.toBeNull()
  expect((await dispatchTree(h, 'child', 'open-workspace-menu', { x: 1 })).delivered).toBe(0)
  expect((await dispatchTree(h, 'child', 'open-workspace-menu', { x: Number.NaN, y: 1 })).delivered).toBe(0)
  expect((await dispatchTree(h, 'child', 'open-workspace-menu', { x: 1, y: 2, focus: 'yes' as unknown as boolean })).delivered).toBe(0)
  expect((await dispatchTree(h, 'child', 'open-workspace-menu', { x: 1, y: Number.POSITIVE_INFINITY })).delivered).toBe(0)
  expect((await dispatchTree(h, 'child', 'open-workspace-menu', { x: 1, y: 2, other: true })).delivered).toBe(0)
  expect((await dispatchTree(h, 'missing', 'copy-path')).delivered).toBe(0)
  expect((await dispatchTree(h, 'w1', 'not-a-tree-operation')).delivered).toBe(0)
  expect((await dispatchTree(h, 'flat', 'toggle-fold')).delivered).toBe(0)
  expect((await dispatchTree(h, 'section:g1', 'toggle-fold')).delivered).toBe(0)
  expect((await dispatchTree(h, 'group:g1', 'toggle-fold')).delivered).toBe(0)
  expect((await dispatchTree(h, 'lane:in-progress', 'toggle-fold')).delivered).toBe(0)
  expect((await dispatchTree(h, 'child', 'toggle-fold')).delivered).toBe(0)

  expect((await dispatchTree(h, 'parent', 'open-workspace-menu', { x: 1, y: 2, focus: false })).delivered).toBe(1)
  expect((await dispatchTree(h, 'parent', 'close-menu', { seq: -1 })).delivered).toBe(0)
  expect(menu()).not.toBeNull()
  expect((await dispatchTree(h, 'parent', 'close-menu', { seq: 1, extra: true })).delivered).toBe(0)
  expect(menu()).not.toBeNull()
  expect((await dispatchTree(h, 'parent', 'close-menu', { seq: 1 })).delivered).toBe(1)
  expect(menu()).toBeNull()

  expect((await dispatchTree(h, 'parent', 'start-rename')).delivered).toBe(1)
  expect((await dispatchTree(h, 'parent', 'cancel-rename', { seq: Number.NaN })).delivered).toBe(0)
  expect((await dispatchTree(h, 'parent', 'cancel-rename', { seq: 1, extra: true })).delivered).toBe(0)
  expect(h.host.querySelector('.worktree-rename')).not.toBeNull()
  expect((await dispatchTree(h, 'parent', 'cancel-rename', { seq: 1 })).delivered).toBe(1)
  expect(h.host.querySelector('.worktree-rename')).toBeNull()

  const malformed = control('parent', 'copy-path') as unknown as Record<string, unknown>
  for (const payload of [null, [], 'text', 42]) {
    expect(() => dispatchUiControl(h.context, { ...malformed, payload })).toThrow()
  }
  expect(dispatchUiControl(h.context, { ...malformed, payload: new Date() }).delivered).toBe(0)
  expect(dispatchUiControl(h.context, { ...malformed, payload: Object.create({ inherited: true }) }).delivered).toBe(0)
  expect(h.toasts).toEqual([])
})
test('derives menu coordinates and default focus from the visible trigger', async () => {
  const h = await mountTree()
  const trigger = menuButton(h, 'w1')!
  trigger.focus()
  expect((await dispatchTree(h, 'w1', 'open-workspace-menu')).delivered).toBe(1)
  expect(menu()).not.toBeNull()
  await keydown(menu()!, 'Escape')
  expect(document.activeElement).toBe(trigger)

  expect((await dispatchTree(h, 'w1', 'open-workspace-menu', { focus: false })).delivered).toBe(1)
  expect(menu()).not.toBeNull()
  await keydown(menu()!, 'Escape')
  expect(document.activeElement).not.toBe(trigger)
})

test('includes visible empty projects and synthetic nested sections, but excludes folded descendants', async () => {
  const empty = await mountTree({ worktrees: [], repos: [REPO], display: 'project', emptyProjects: true })
  expect(empty.host.querySelector('[data-repo-target="r1"]')).not.toBeNull()
  expect((await dispatchTree(empty, 'r1', 'open-project-menu', { x: 1, y: 2, focus: false })).delivered).toBe(1)
  expect((await dispatchTree(empty, 'project:r1', 'toggle-fold')).delivered).toBe(1)

  const parent = section('g-parent')
  const child = section('g-child', 'g-parent', ['r1'])
  const groupedRepo = repo('r1', { groupId: 'g-child' })
  const nested = await mountTree({
    worktrees: [worktree('w1', { projectGroupId: 'g-child' })],
    repos: [groupedRepo],
    groups: [parent, child],
    display: 'section-project'
  })
  expect(nested.host.querySelector('[data-group-target="g-parent"]')).not.toBeNull()
  expect((await dispatchTree(nested, 'g-parent', 'open-group-menu', { x: 1, y: 2, focus: false })).delivered).toBe(1)
  await nested.render({ groups: [section('g-parent', null, [], true), child] })
  expect(nested.host.querySelector('[data-group-target="g-child"]')).toBeNull()
  expect((await dispatchTree(nested, 'g-child', 'open-group-menu', { x: 1, y: 2 })).delivered).toBe(0)
  expect((await dispatchTree(nested, 'w1', 'copy-name')).delivered).toBe(0)

  const folded = await mountTree({
    worktrees: [worktree('parent'), worktree('child', { parentId: 'parent' })],
    collapsed: new Set(['parent'])
  })
  expect(row(folded, 'child')).toBeNull()
  expect((await dispatchTree(folded, 'child', 'open-workspace-menu', { x: 1, y: 2 })).delivered).toBe(0)
  expect((await dispatchTree(folded, 'child', 'toggle-fold')).delivered).toBe(0)
})

test('accepts only visible collapsible worktree, pinned, project, and non-flat lane keys', async () => {
  const rows = [worktree('parent'), worktree('child', { parentId: 'parent' }), worktree('pinned', { pinned: true }), worktree('other')]
  const h = await mountTree({ worktrees: rows, display: 'section-project' })
  expect((await dispatchTree(h, 'parent', 'toggle-fold')).delivered).toBe(1)
  expect((await dispatchTree(h, 'pinned', 'toggle-fold')).delivered).toBe(1)
  expect((await dispatchTree(h, 'project:r1', 'toggle-fold')).delivered).toBe(1)
  const lane = await mountTree({ worktrees: [worktree('w1')], display: 'status' })
  expect((await dispatchTree(lane, 'status:in-progress', 'toggle-fold')).delivered).toBe(1)
  expect((await dispatchTree(lane, 'flat', 'toggle-fold')).delivered).toBe(0)
  expect((await dispatchTree(lane, 'lane:status:in-progress', 'toggle-fold')).delivered).toBe(0)
  expect(h.toggles).toEqual(['parent', 'pinned', 'project:r1'])
  expect(lane.toggles).toEqual(['status:in-progress'])
})

test('delayed bridge dispatch rechecks current visibility after removal, hiding, and ancestor folding', async () => {
  const h = await mountTree({ worktrees: [worktree('parent'), worktree('child', { parentId: 'parent' })] })
  const gate = deferred<unknown>()
  h.world.holdOperation = 'open-workspace-menu'
  h.world.commandGate = gate.promise
  const pending = requestUiControl(h.context, control('child', 'open-workspace-menu', { x: 1, y: 2 }))
  await waitFor(() => h.calls.find((call) => call.method === 'ui.window.command.run'))
  await h.render({ collapsed: new Set(['parent']) })
  gate.resolve(undefined)
  expect((await pending).delivered).toBe(0)
  expect(menu()).toBeNull()

  h.world.holdOperation = 'copy-path'
  const secondGate = deferred<unknown>()
  h.world.commandGate = secondGate.promise
  const copy = requestUiControl(h.context, control('child', 'copy-path'))
  await waitFor(() => h.calls.filter((call) => call.method === 'ui.window.command.run').length === 2)
  await h.render({ worktrees: [worktree('parent')] })
  secondGate.resolve(undefined)
  expect((await copy).delivered).toBe(0)
})

test('keeps an older delayed menu close from closing a replacement menu on the same target', async () => {
  const h = await mountTree()
  expect((await dispatchTree(h, 'w1', 'open-workspace-menu', { x: 1, y: 2, focus: false })).delivered).toBe(1)
  const gate = deferred<unknown>()
  h.world.holdOperation = 'close-menu'
  h.world.commandGate = gate.promise
  const oldClose = requestUiControl(h.context, control('w1', 'close-menu', { seq: 1 }))
  await waitFor(() => h.calls.some((call) => call.method === 'ui.window.command.run' && (call.params.args as { operation?: string }).operation === 'close-menu'))
  expect((await dispatchTree(h, 'w1', 'open-workspace-menu', { x: 3, y: 4, focus: false })).delivered).toBe(1)
  expect(menu()).not.toBeNull()
  gate.resolve(undefined)
  expect((await oldClose).delivered).toBe(0)
  expect(menu()).not.toBeNull()
})

test('routes project and section create actions through interception and preserves default dialogs', async () => {
  let intercept: boolean | undefined = true
  const group = section('g1', null, ['r1'])
  const h = await mountTree({
    worktrees: [worktree('w1', { projectGroupId: 'g1' })],
    repos: [repo('r1', { groupId: 'g1' })],
    groups: [group],
    emptyProjects: true,
    treeProps: { onGroupAction: (view, action) => { h.groupActions.push([view.key, action]); return intercept } }
  })
  await click(labelled(h.host, 'New worktree in r1'))
  await click(labelled(h.host, 'New section'))
  expect(h.groupActions).toEqual([['project:r1', 'new-worktree'], ['section:g1', 'new-section']])
  expect(h.dialogs).toEqual([])

  intercept = false
  await click(labelled(h.host, 'New worktree in r1'))
  await click(labelled(h.host, 'New section'))
  expect(h.dialogs).toEqual([{ kind: 'create', repoId: 'r1' }, { kind: 'group', action: 'new-section' }])

  intercept = undefined
  expect((await dispatchTree(h, 'r1', 'new-worktree')).delivered).toBe(1)
  expect((await dispatchTree(h, 'g1', 'new-section')).delivered).toBe(1)
  expect(h.dialogs.slice(-2)).toEqual([{ kind: 'create', repoId: 'r1' }, { kind: 'group', action: 'new-section' }])
  expect(h.groupActions.slice(-2)).toEqual([['project:r1', 'new-worktree'], ['section:g1', 'new-section']])

  const interceptedCount = h.groupActions.length
  const absentDialogCount = h.dialogs.length
  await h.render({ withoutGroupAction: true })
  await click(labelled(h.host, 'New worktree in r1'))
  await click(labelled(h.host, 'New section'))
  expect(h.groupActions).toHaveLength(interceptedCount)
  expect(h.dialogs.slice(absentDialogCount)).toEqual([{ kind: 'create', repoId: 'r1' }, { kind: 'group', action: 'new-section' }])

  const absentCommandCount = h.dialogs.length
  expect((await dispatchTree(h, 'r1', 'new-worktree')).delivered).toBe(1)
  expect((await dispatchTree(h, 'g1', 'new-section')).delivered).toBe(1)
  expect(h.dialogs.slice(absentCommandCount)).toEqual([{ kind: 'create', repoId: 'r1' }, { kind: 'group', action: 'new-section' }])
})

test('refuses delayed create actions after their header target is removed or hidden', async () => {
  const parent = section('g-parent')
  const group = section('g-child', 'g-parent', ['r1'])
  const h = await mountTree({
    worktrees: [worktree('w1', { projectGroupId: 'g-child' })],
    repos: [repo('r1', { groupId: 'g-child' })],
    groups: [parent, group],
    emptyProjects: true
  })
  const gate = deferred<unknown>()
  h.world.holdOperation = 'new-worktree'
  h.world.commandGate = gate.promise
  const request = requestUiControl(h.context, control('r1', 'new-worktree'))
  await waitFor(() => h.calls.find((call) => call.method === 'ui.window.command.run'))
  await h.render({ repos: [], groups: [], worktrees: [] })
  gate.resolve(undefined)
  expect((await request).delivered).toBe(0)
  expect(h.dialogs).toEqual([])

  const sectionGate = deferred<unknown>()
  h.world.holdOperation = 'new-section'
  h.world.commandGate = sectionGate.promise
  const hiddenSection = requestUiControl(h.context, control('g-child', 'new-section'))
  await waitFor(() => h.calls.filter((call) => call.method === 'ui.window.command.run').length === 2)
  await h.render({
    worktrees: [worktree('w1', { projectGroupId: 'g-child' })],
    repos: [repo('r1', { groupId: 'g-child' })],
    groups: [section('g-parent', null, [], true), group],
    emptyProjects: true
  })
  sectionGate.resolve(undefined)
  expect((await hiddenSection).delivered).toBe(0)
  expect(h.dialogs).toEqual([])
})

test('preserves exact workspace menu order and disabled destructive or unavailable items', async () => {
  const main = worktree('main', { isMain: true })
  const missingRepo = worktree('orphan', { repoId: 'missing' })
  const folderRepo = repo('folder', { kind: 'folder' })
  const folder = worktree('folder-wt', { repoId: 'folder', kind: 'folder' as WorktreeControl['kind'] })
  const h = await mountTree({ worktrees: [worktree('w1'), main, missingRepo, folder], repos: [REPO, folderRepo] })
  await openRowMenu(h, 'w1')
  expect(menuItems().slice(0, 9).map(menuLabel)).toEqual([
    'Rename', 'Tags…', 'Move to section', 'Move to status', 'Sleep', 'Open in', 'Copy', 'More', 'Delete…'
  ])
  await keydown(menu()!, 'Escape')

  await openRowMenu(h, 'main')
  const deleteMain = menuItem('Delete…') as HTMLButtonElement
  expect(deleteMain.disabled || deleteMain.getAttribute('aria-disabled') === 'true').toBe(true)
  expect(deleteMain.title).toBe(PRIMARY_DELETE_TIP)
  await click(menuItem('More'))
  const archiveMain = menuItem('Archive') as HTMLButtonElement
  expect(archiveMain.disabled || archiveMain.getAttribute('aria-disabled') === 'true').toBe(true)
  await keydown(menu()!, 'Escape')

  await openRowMenu(h, 'folder-wt')
  await click(menuItem('More'))
  const archiveFolder = menuItem('Archive') as HTMLButtonElement
  expect(archiveFolder.disabled || archiveFolder.getAttribute('aria-disabled') === 'true').toBe(true)
  await keydown(menu()!, 'Escape')

  await openRowMenu(h, 'orphan')
  const move = menuItem('Move to section') as HTMLButtonElement
  expect(move.disabled || move.getAttribute('aria-disabled') === 'true').toBe(true)
  expect((await dispatchTree(h, 'main', 'delete')).delivered).toBe(0)
  expect((await dispatchTree(h, 'main', 'archive')).delivered).toBe(0)
  expect((await dispatchTree(h, 'orphan', 'move-to-section')).delivered).toBe(0)
  expect(h.deletes).toEqual([])
})

test('closes before rename selection without stealing focus, and Enter plus blur commits once', async () => {
  const h = await mountTree()
  await openRowMenu(h, 'w1')
  const gate = deferred<unknown>()
  h.world.holdOperation = 'close-menu'
  h.world.commandGate = gate.promise
  await click(menuItem('Rename'))
  const input = await waitFor(() => h.host.querySelector<HTMLInputElement>('.worktree-rename'))
  expect(document.activeElement).toBe(input)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, 'renamed')
  await keydown(input, 'Enter')
  input.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
  await flush()
  expect(h.renames).toEqual([['w1', 'renamed']])
  gate.resolve(undefined)
  await flush()
  expect(h.renames).toEqual([['w1', 'renamed']])
})

test('copies Path and Worktree name once while the earlier menu close is still pending', async () => {
  const h = await mountTree()
  const writes: string[] = []
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  try {
    await openRowMenu(h, 'w1')
    const gate = deferred<unknown>()
    h.world.holdOperation = 'close-menu'
    h.world.commandGate = gate.promise
    await click(menuItem('Copy'))
    await click(menuItem('Path'))
    await waitFor(() => writes.length === 1)
    expect(writes).toEqual(['/repo/QuirkyApp/w1'])
    gate.resolve(undefined)
    await waitFor(() => menu() === null)
    expect(writes).toHaveLength(1)

    const nameGate = deferred<unknown>()
    h.world.commandGate = nameGate.promise
    await openRowMenu(h, 'w1')
    await click(menuItem('Copy'))
    await click(menuItem('Worktree name'))
    await waitFor(() => writes.length === 2)
    expect(writes).toEqual(['/repo/QuirkyApp/w1', 'w1'])
    nameGate.resolve(undefined)
    await waitFor(() => menu() === null)
    expect(writes).toHaveLength(2)
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('Escape cancellation recovers from failure and cannot cancel a newer rename session', async () => {
  const h = await mountTree()
  expect((await dispatchTree(h, 'w1', 'start-rename')).delivered).toBe(1)
  const input = await waitFor(() => h.host.querySelector<HTMLInputElement>('.worktree-rename'))
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, 'cancelled')

  h.world.commandFailure = new Error('window unavailable')
  await keydown(input, 'Escape')
  expect(h.host.querySelector('.worktree-rename')).toBe(input)
  expect(document.activeElement).toBe(input)
  expect(h.toasts.at(-1)?.[0]).toBe('Could not update tree control')
  h.world.commandFailure = null

  world(8)
  h.world.connId = 8
  await keydown(input, 'Escape')
  expect(h.host.querySelector('.worktree-rename')).toBe(input)
  expect(document.activeElement).toBe(input)
  h.world.connId = 7

  const gate = deferred<unknown>()
  h.world.holdOperation = 'cancel-rename'
  h.world.commandGate = gate.promise
  await keydown(input, 'Escape')
  const cancelCall = await waitFor(() => h.calls.find((call) =>
    call.method === 'ui.window.command.run' && (call.params.args as { operation?: string }).operation === 'cancel-rename'
  ))
  expect((cancelCall.params.args as { payload?: { seq?: number } }).payload?.seq).toBe(1)
  expect((await dispatchTree(h, 'w1', 'start-rename')).delivered).toBe(1)
  gate.resolve(undefined)
  await flush()
  expect(h.host.querySelector('.worktree-rename')).not.toBeNull()
  expect(document.activeElement?.classList.contains('worktree-rename')).toBe(true)

  const current = h.host.querySelector<HTMLInputElement>('.worktree-rename')!
  setter.call(current, 'saved-after-retry')
  await keydown(current, 'Enter')
  current.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
  await flush()
  expect(h.renames).toEqual([['w1', 'saved-after-retry']])
})

test('successful Escape exits rename without saving and routes cancel-rename', async () => {
  const h = await mountTree()
  expect((await dispatchTree(h, 'w1', 'start-rename')).delivered).toBe(1)
  const input = await waitFor(() => h.host.querySelector<HTMLInputElement>('.worktree-rename'))
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'not-saved')
  await keydown(input, 'Escape')
  await waitFor(() => h.host.querySelector('.worktree-rename') === null)
  expect(h.renames).toEqual([])
  const cancel = h.calls.find((call) => call.method === 'ui.window.command.run' && (call.params.args as { operation?: string }).operation === 'cancel-rename')
  expect(cancel).toBeDefined()
  expect((cancel?.params.args as { payload?: { seq?: number } }).payload?.seq).toBe(1)
})

test('shows button focus return, leaves right-click without a return target, and handles pinned duplicate rows', async () => {
  const base = buildTree({
    worktrees: [worktree('w1')], repos: [REPO], groups: [], tags: [],
    spec: { ...allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES), display: { ...allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES).display, groupBy: 'project' } },
    viewId: 'all', projection: null, marks: new Map(), checks: new Map()
  })
  const source = base.groups.find((group) => group.kind === 'project')!
  const project: ViewGroup = { ...source, key: 'project:r1', kind: 'project', title: 'QuirkyApp' }
  const rowView = source.rows[0]!
  const duplicate = {
    ...base,
    groups: [
      { ...project, key: 'pinned', kind: 'pinned' as const, title: 'Pinned', rows: [rowView] },
      project
    ]
  } as ViewTree
  const h = await mountTree({ worktrees: [worktree('w1')], model: duplicate, display: 'project' })
  const triggers = h.host.querySelectorAll('.worktree-menu')
  expect(triggers).toHaveLength(2)
  ;(triggers[1] as HTMLElement).focus()
  await click(triggers[1])
  await waitFor(() => menu())
  await keydown(menu()!, 'Escape')
  expect(document.activeElement).toBe(triggers[1])

  const rowElement = row(h, 'w1')!
  await act(async () => {
    rowElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
  })
  await waitFor(() => menu())
  await keydown(menu()!, 'Escape')
  expect(document.activeElement).not.toBe(triggers[0])

  await openRowMenu(h, 'w1', 0)
  await click(menuItem('More'))
  await click(menuItem('Pin'))
  await waitFor(() => menu() === null)
  expect(document.activeElement?.classList.contains('worktree-menu')).toBe(true)

  await h.render({ worktrees: [worktree('w1', { pinned: true })] })
  await openRowMenu(h, 'w1', 1)
  await click(menuItem('More'))
  expect(menuItem('Unpin')).not.toBeNull()
  await click(menuItem('Unpin'))
  await waitFor(() => menu() === null)
  expect(document.activeElement?.classList.contains('worktree-menu')).toBe(true)

  await openRowMenu(h, 'w1', 1)
  await click(menuItem('Rename'))
  expect(h.host.querySelectorAll('.worktree-rename').length).toBeGreaterThan(0)
  expect(document.activeElement?.outerHTML ?? 'no active element').toContain('worktree-rename')
  expect(h.renames).toEqual([])
  const input = document.activeElement as HTMLInputElement
  expect(input).toBe(h.host.querySelectorAll<HTMLInputElement>('.worktree-rename')[1])
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'duplicate-retry')
  h.world.commandFailure = new Error('cancel unavailable')
  await keydown(input, 'Escape')
  expect(document.activeElement).toBe(input)
  expect(h.renames).toEqual([])
  h.world.commandFailure = null
  const cancelGate = deferred<unknown>()
  h.world.holdOperation = 'cancel-rename'
  h.world.commandGate = cancelGate.promise
  await keydown(input, 'Escape')
  const duplicateInput = h.host.querySelector<HTMLInputElement>('.worktree-rename')!
  await act(async () => duplicateInput.focus())
  expect(h.renames).toEqual([])
  await act(async () => cancelGate.reject(new Error('delayed cancel unavailable')))
  await flush()
  expect(document.activeElement).toBe(input)
  expect(h.renames).toEqual([])
  h.world.holdOperation = null
  h.world.commandGate = null
  await keydown(input, 'Enter')
  expect(h.renames).toEqual([['w1', 'duplicate-retry']])
})

test('reports bridge failures for open, fold, rename, and copy, but keeps close-menu quiet', async () => {
  const h = await mountTree({ worktrees: [worktree('parent'), worktree('child', { parentId: 'parent' })] })
  h.world.commandFailure = new Error('route failed')
  await click(menuButton(h, 'parent'))
  await click(labelled(h.host, 'Collapse project QuirkyApp'))
  expect(h.toasts.filter(([title]) => title === 'Could not update tree control').length).toBeGreaterThanOrEqual(2)
  h.world.commandFailure = null

  await openRowMenu(h, 'parent')
  h.world.commandFailure = new Error('rename route failed')
  await click(menuItem('Rename'))
  expect(h.toasts.filter(([title]) => title === 'Could not update tree control').length).toBeGreaterThanOrEqual(3)
  expect(h.host.querySelector('.worktree-rename')).toBeNull()
  h.world.commandFailure = null
  if (menu()) await keydown(menu()!, 'Escape')

  await openRowMenu(h, 'parent')
  await click(menuItem('Copy'))
  h.world.commandFailure = new Error('copy route failed')
  await click(menuItem('Path'))
  expect(h.toasts.filter(([title]) => title === 'Could not update tree control').length).toBeGreaterThanOrEqual(4)
  h.world.commandFailure = null
  if (menu()) await keydown(menu()!, 'Escape')

  await openRowMenu(h, 'parent')
  const beforeClose = h.toasts.length
  h.world.commandFailure = new Error('close failed')
  await keydown(menu()!, 'Escape')
  expect(h.toasts).toHaveLength(beforeClose)
  h.world.commandFailure = null

  h.world.selfReply = { connId: 0 }
  await click(menuButton(h, 'parent'))
  expect(h.toasts.at(-1)?.[0]).toBe('Could not update tree control')
  expect(h.calls.some((call) => call.method === 'ui.window.command.run' && call.params.connId === 0)).toBe(false)
})
test('rejects invalid or unavailable window identities and returns zero for a live connection without a scope', async () => {
  const h = await mountTree()
  const request = control('w1', 'copy-path')
  h.world.selfReply = { connId: 0 }
  await expect(requestUiControl(h.context, request)).rejects.toThrow('invalid connection identity')

  h.world.selfReply = undefined
  h.world.selfFailure = new Error('self lookup failed')
  await expect(requestUiControl(h.context, request)).rejects.toThrow('self lookup failed')

  h.world.selfFailure = null
  h.world.connId = 404
  await expect(requestUiControl(h.context, request)).rejects.toThrow('no live UI window 404')

  world(8)
  h.world.connId = 8
  expect(await requestUiControl(h.context, request)).toMatchObject({ delivered: 0 })
})
