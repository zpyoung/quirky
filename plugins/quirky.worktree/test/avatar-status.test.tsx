import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { QuirkyEvent, Repo, UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import type { TreeModel, TreeRow } from '../src/report'
import type { TreeProps } from '../src/Tree'
import type { TreeData } from '../src/useTree'

const REPO: Repo = { id: 'r1', name: 'QuirkyApp', path: '/repo/QuirkyApp', addedAt: 1, kind: 'git', displayName: null, groupId: null }
const STATUS = { state: 'working', level: 'full', needsYou: 0 }

const worktree = (id: string, name: string, extra: Record<string, unknown> = {}): WorktreeControl => ({
  id, repoId: 'r1', path: `/repo/QuirkyApp/${id}`, branch: id, head: 'abc', isMain: false, name, instanceId: id,
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false,
  parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false, removing: false,
  groupId: null, projectGroupId: null, lastActivityAt: 1, manualOrder: 0, sleeping: false, sleepChangedAt: null,
  references: [], archivedAt: null,
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false,
  ...extra
}) as WorktreeControl

const row = (item: WorktreeControl): TreeRow => ({ worktree: item, depth: 0, childCount: 0, descendants: [], ancestors: [] })

type Call = { method: string; params?: Record<string, unknown> }
type Harness = {
  context: UiPluginContext
  calls: Call[]
  commands: { id: string; args: unknown }[]
  emit(event: QuirkyEvent): void
}

function harness(options: { commandIds?: string[]; sidebarStatus?: () => unknown } = {}): Harness {
  const calls: Call[] = []
  const commands: { id: string; args: unknown }[] = []
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const context = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'ui.contributions') {
        return { commands: (options.commandIds ?? []).map((id) => ({ id, plugin: 'x', title: id, module: null })) }
      }
      if (method === 'quirky.avatar/sidebarStatus') {
        if (options.sidebarStatus) return options.sidebarStatus()
        throw new Error('no such method')
      }
      return []
    },
    executeCommand: async (id: string, args?: unknown) => { commands.push({ id, args }) },
    toast: () => {},
    log: () => {},
    subscribe: (listener: (event: QuirkyEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onConnection: () => () => {}
  } as unknown as UiPluginContext
  return { context, calls, commands, emit: (event) => listeners.forEach((listener) => listener(event)) }
}

let Tree: typeof import('../src/Tree').Tree
let useTree: typeof import('../src/useTree').useTree
let createRoot: typeof import('react-dom/client').createRoot
let root: Root | null = null
let host: HTMLElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Tree = (await import('../src/Tree')).Tree
  useTree = (await import('../src/useTree')).useTree
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })

async function mountTree(h: Harness, avatarStatus: unknown) {
  host = document.createElement('div')
  document.body.append(host)
  const model: TreeModel = {
    pinned: [],
    groups: [],
    projects: [{ repo: REPO, rows: [row(worktree('plain', 'plain-one', { avatarStatus: null })), row(worktree('handed', 'handed-one', { avatarStatus }))], pending: [] }]
  }
  const props: TreeProps = {
    context: h.context, model, groups: [], sessions: [], selectedId: null,
    automationExpandedId: null, automationAvailability: null, onToggleAutomationDetails: () => {},
    now: 1, separatorEnabled: false, options: DEFAULT_STOCK_OPTIONS, canShowSleeping: () => true, statusDefinitions: [], projectIdentities: {},
    openDialog: () => {}, requestDelete: () => {}, onDropPreviewChange: () => {}, onSeparatorStateChange: () => {}
  }
  root = createRoot(host)
  await act(async () => root!.render(createElement(Tree, props)))
  await settle()
}

const rowOf = (id: string) => host.querySelector<HTMLElement>(`[data-worktree-id="${id}"]`)!
const ringOf = (id: string) => rowOf(id).querySelector<HTMLElement>('[data-avatar-ring]')
const nameOf = (id: string) => rowOf(id).querySelector<HTMLElement>('.worktree-name')!.textContent

async function openMenu(name: string) {
  const button = host.querySelector<HTMLElement>(`[aria-label="Actions for ${name}"]`)!
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  await settle()
}

const handoffItem = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('Hand off to Avatar'))

test('a row with an avatar status gets the accent ring and the Avatar prefix', async () => {
  await mountTree(harness(), STATUS)
  expect(ringOf('handed')).not.toBeNull()
  expect(nameOf('handed')).toBe('Avatar · handed-one')
})

test('a row without an avatar status is unchanged', async () => {
  await mountTree(harness(), STATUS)
  expect(ringOf('plain')).toBeNull()
  expect(nameOf('plain')).toBe('plain-one')
})

test('a null avatar status renders no ring and no prefix', async () => {
  await mountTree(harness(), null)
  expect(ringOf('handed')).toBeNull()
  expect(nameOf('handed')).toBe('handed-one')
})

test('the hand-off item is absent when the command is not loaded', async () => {
  await mountTree(harness({ commandIds: ['command:quirky.session/new-shell'] }), null)
  await openMenu('plain-one')
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(handoffItem()).toBeUndefined()
})

test('the hand-off item shows when the command is loaded and runs it with the worktree id', async () => {
  const h = harness({ commandIds: ['command:quirky.avatar/handoff'] })
  await mountTree(h, null)
  await openMenu('plain-one')
  const item = handoffItem()
  expect(item?.textContent).toContain('Hand off to Avatar…')
  await act(async () => { item!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  expect(h.commands).toEqual([{ id: 'command:quirky.avatar/handoff', args: { worktreeIds: ['plain'] } }])
})

test('the hand-off item also matches a bare command id', async () => {
  const h = harness({ commandIds: ['quirky.avatar/handoff'] })
  await mountTree(h, null)
  await openMenu('plain-one')
  await act(async () => { handoffItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  expect(h.commands).toEqual([{ id: 'quirky.avatar/handoff', args: { worktreeIds: ['plain'] } }])
})

function Probe({ context, onData }: { context: UiPluginContext; onData(data: TreeData): void }) {
  onData(useTree(context))
  return null
}

async function mountProbe(h: Harness) {
  let latest: TreeData | null = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(Probe, { context: h.context, onData: (data) => { latest = data } })))
  await settle()
  return () => latest!
}

const statusOf = (data: TreeData, id: string) => (data.worktrees.find((item) => item.id === id) as unknown as { avatarStatus: unknown }).avatarStatus

test('useTree attaches sidebar statuses and reloads on quirky.avatar/changed', async () => {
  let current: Record<string, unknown> = { w1: STATUS }
  const h = harness({ sidebarStatus: () => current })
  const original = h.context.call.bind(h.context)
  ;(h.context as { call: unknown }).call = async (method: string, params?: Record<string, unknown>) =>
    method === 'quirky.worktree/list' ? [worktree('w1', 'one'), worktree('w2', 'two')] : original(method, params)
  const data = await mountProbe(h)
  expect(statusOf(data(), 'w1')).toEqual(STATUS)
  expect(statusOf(data(), 'w2')).toBeNull()
  current = { w2: { state: 'parked', level: 'local', needsYou: 2 } }
  await act(async () => h.emit({ type: 'quirky.avatar/changed', data: {} } as unknown as QuirkyEvent))
  await settle()
  expect(statusOf(data(), 'w1')).toBeNull()
  expect(statusOf(data(), 'w2')).toEqual({ state: 'parked', level: 'local', needsYou: 2 })
})

test('useTree gives every row a null avatar status when the method fails', async () => {
  const h = harness()
  const original = h.context.call.bind(h.context)
  ;(h.context as { call: unknown }).call = async (method: string, params?: Record<string, unknown>) =>
    method === 'quirky.worktree/list' ? [worktree('w1', 'one')] : original(method, params)
  const data = await mountProbe(h)
  expect(data().worktrees).toHaveLength(1)
  expect(statusOf(data(), 'w1')).toBeNull()
})
