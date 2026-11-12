import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { QuirkyEvent, Repo, UiPluginContext } from '@quirky/protocol'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { DEFAULT_STOCK_OPTIONS, type WorktreeControl } from '../src/control-types'
import type { TreeProps } from '../src/Tree'
import { buildTree } from '../src/view-model'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES, type ActivityMarkState } from '../src/view-types'
import type { TreeData } from '../src/useTree'
import { useAvatarHandoff } from '../src/useAvatarHandoff'

const NOW = 10_000_000
const REPO: Repo = { id: 'r1', name: 'QuirkyApp', path: '/repo/QuirkyApp', addedAt: 1, kind: 'git', displayName: null, groupId: null }
type AvatarStatus = { state: string; level: 'shadow' | 'local' | 'own-branch' | 'full'; needsYou: number }
const STATUS: AvatarStatus = { state: 'working', level: 'full', needsYou: 0 }
const MAIN_MENU_LABELS = ['Rename', 'Tags…', 'Move to section', 'Move to status', 'Sleep', 'Open in', 'Copy', 'More', 'Delete…']

type Call = { method: string; params: Record<string, unknown> | undefined }
type Toast = { title: string; body?: string }
type HarnessOptions = {
  commandIds?: string[]
  contributionsReply?: unknown
  contributionsError?: Error
  worktrees?: WorktreeControl[]
  sidebarStatus?: () => unknown | Promise<unknown>
  executeCommandError?: Error
}
type Harness = {
  context: UiPluginContext
  calls: Call[]
  commands: Array<{ id: string; args: unknown }>
  toasts: Toast[]
  logs: string[]
  emit(event: QuirkyEvent): void
  reconnect(): void
  setContributions(reply: unknown, error?: Error): void
  setExecuteCommandError(error?: Error): void
}
type TreePropsWithHandoff = TreeProps & { onHandoffToAvatar?: (worktreeIds: string[]) => void }

const worktree = (id: string, name: string, extra: Partial<WorktreeControl> & { avatarStatus?: unknown } = {}): WorktreeControl => ({
  id, repoId: 'r1', path: `/repo/QuirkyApp/${id}`, branch: id, head: 'abc', isMain: false, name, instanceId: id,
  kind: 'git', displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false,
  parentId: null, createdAt: 1, createdBy: 'api', baseRef: null, keepBranch: false, removing: false,
  groupId: null, projectGroupId: null, lastActivityAt: 1, manualOrder: 0, sleeping: false, sleepChangedAt: null,
  references: [], archivedAt: null, tagIds: [],
  cleanupContext: { archivedAt: null, volatile: null, remoteConnected: null },
  externalVisible: true, externalVisibility: 'show', externalInboxSuppressed: false,
  ...extra
}) as WorktreeControl

function harness(options: HarnessOptions = {}): Harness {
  const calls: Call[] = []
  const commands: Array<{ id: string; args: unknown }> = []
  const toasts: Toast[] = []
  const logs: string[] = []
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const connectionListeners = new Set<(status: string) => void>()
  let contributionsReply = options.contributionsReply
  let hasContributionsReply = 'contributionsReply' in options
  let contributionsError = options.contributionsError
  let executeCommandError = options.executeCommandError
  const context = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      switch (method) {
        case 'ui.contributions':
          if (contributionsError) throw contributionsError
          if (hasContributionsReply) return contributionsReply
          return { commands: (options.commandIds ?? []).map((id) => ({ id })) }
        case 'quirky.avatar/sidebarStatus':
          if (options.sidebarStatus) return options.sidebarStatus()
          throw new Error('no such method')
        case 'quirky.repo/list': return [REPO]
        case 'quirky.repo/groupList': return []
        case 'quirky.worktree/list': return options.worktrees ?? []
        case 'quirky.worktree/tags': return { tags: [], assignments: {} }
        case 'quirky.worktree/origins': return []
        case 'quirky.session/list': return []
        case 'quirky.heimdall/fleet': return { generatedAtMs: 0, rows: [] }
        case 'ui.window.self': return {}
        default: return []
      }
    },
    executeCommand: async (id: string, args?: unknown) => {
      commands.push({ id, args })
      if (executeCommandError) throw executeCommandError
    },
    toast: (title: string, body?: string) => { toasts.push({ title, ...(body === undefined ? {} : { body }) }) },
    log: (message: string) => { logs.push(message) },
    subscribe: (listener: (event: QuirkyEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onConnection: (listener: (status: string) => void) => { connectionListeners.add(listener); return () => connectionListeners.delete(listener) }
  } as unknown as UiPluginContext
  return {
    context,
    calls,
    commands,
    toasts,
    logs,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    reconnect: () => connectionListeners.forEach((listener) => listener('connected')),
    setContributions: (reply, error) => {
      contributionsReply = reply
      hasContributionsReply = true
      contributionsError = error
    },
    setExecuteCommandError: (error) => { executeCommandError = error }
  }
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
const click = async (element: Element) => act(async () => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

async function mountTree(h: Harness, worktrees: WorktreeControl[], options: { marks?: Record<string, ActivityMarkState>; pendingAsks?: ReadonlyMap<string, number>; onHandoffToAvatar?: (ids: string[]) => void } = {}) {
  host = document.createElement('div')
  document.body.append(host)
  const model = buildTree({
    worktrees,
    repos: [REPO],
    groups: [],
    tags: [],
    spec: allSpecFromStock(DEFAULT_STOCK_OPTIONS, DEFAULT_ACTIVITY_PREFERENCES),
    viewId: 'all',
    projection: null,
    marks: new Map(Object.entries(options.marks ?? {})),
    checks: new Map()
  })
  const props: TreePropsWithHandoff = {
    context: h.context,
    model,
    tagsById: new Map(),
    rowFact: 'last-activity',
    repos: [REPO],
    groups: [],
    sessions: [],
    selectedId: null,
    pendingAsks: options.pendingAsks,
    automationExpandedId: null,
    automationAvailability: null,
    onToggleAutomationDetails: () => {},
    now: NOW,
    separatorEnabled: false,
    options: DEFAULT_STOCK_OPTIONS,
    canShowSleeping: () => true,
    statusDefinitions: [],
    projectIdentities: {},
    allWorktrees: worktrees,
    openDialog: () => {},
    requestDelete: () => {},
    onDropPreviewChange: () => {},
    onSeparatorStateChange: () => {},
    onHandoffToAvatar: options.onHandoffToAvatar
  }
  root = createRoot(host)
  await act(async () => root!.render(createElement(Tree, props as TreeProps)))
  await settle()
  return model
}

const rowOf = (id: string) => host.querySelector<HTMLElement>(`[data-worktree-id="${id}"]`)!
const markOf = (id: string) => rowOf(id).querySelector<HTMLElement>('.ui-activity-mark')!
const nameOf = (id: string) => rowOf(id).querySelector<HTMLElement>('.worktree-name')!
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const visibleText = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return ''
  return [...node.childNodes].map(visibleText).join('')
}
const labelOf = (item: Element) => visibleText(item).replace(/\s+/g, ' ').trim()
const menuLabels = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].map(labelOf)
const handoffItem = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((item) => labelOf(item).includes('Hand off to Avatar'))

async function openMenu(name: string) {
  await click(host.querySelector<HTMLElement>(`[aria-label="Actions for ${name}"]`)!)
  await settle()
}

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

const avatarStatusOf = (data: TreeData, id: string) => (data.worktrees.find((item) => item.id === id) as unknown as { avatarStatus: AvatarStatus | null }).avatarStatus

test('the row puts the accent ring and Avatar title on its own mark and prefixes the name', async () => {
  const h = harness()
  await mountTree(h, [worktree('handed', 'handed-one', { avatarStatus: STATUS })])
  expect(markOf('handed').getAttribute('data-ring')).toBe('accent')
  expect(markOf('handed').getAttribute('title')).toBe('Avatar: Working · Full')
  expect(nameOf('handed').textContent).toBe('Avatar · handed-one')
  expect(nameOf('handed').getAttribute('title')).toBe('handed-one')
  expect(rowOf('handed').querySelectorAll('.ui-activity-mark')).toHaveLength(1)
  expect(rowOf('handed').querySelector('[data-avatar-ring]')).toBeNull()
})

test('a needs-you avatar status uses its ring and singular and plural title wording', async () => {
  const h = harness()
  await mountTree(h, [worktree('one', 'one', { avatarStatus: { state: 'gate-failed', level: 'own-branch', needsYou: 1 } })])
  expect(markOf('one').getAttribute('data-ring')).toBe('needs-you')
  expect(markOf('one').getAttribute('title')).toBe('Avatar: Gate failed · 1 needs you · Own branch')

  const two = worktree('two', 'two', { avatarStatus: { state: 'gate-failed', level: 'own-branch', needsYou: 2 } })
  await act(async () => root!.unmount())
  root = null
  await mountTree(h, [two])
  expect(markOf('two').getAttribute('title')).toBe('Avatar: Gate failed · 2 need you · Own branch')
})

test('the avatar mark title falls back to an unknown state string', async () => {
  await mountTree(harness(), [worktree('unknown', 'unknown', { avatarStatus: { state: 'weird', level: 'local', needsYou: 0 } })])
  expect(markOf('unknown').getAttribute('title')).toBe('Avatar: weird · Local')
})

test('null, missing, and malformed avatar status leave the row unchanged', async () => {
  const malformed: unknown[] = [
    { state: 'working', level: 'other', needsYou: 0 },
    { state: 'working', level: 'local', needsYou: Number.NaN },
    { state: 'working', level: 'local', needsYou: Number.POSITIVE_INFINITY },
    { state: 7, level: 'local', needsYou: 0 }
  ]
  const items = [
    worktree('null', 'null-name', { avatarStatus: null }),
    worktree('missing', 'missing-name'),
    ...malformed.map((avatarStatus, index) => worktree(`bad-${index}`, `bad-name-${index}`, { avatarStatus }))
  ]
  await mountTree(harness(), items)
  for (const id of ['null', 'missing', ...malformed.map((_, index) => `bad-${index}`)]) {
    expect(markOf(id).hasAttribute('data-ring')).toBe(false)
    expect(markOf(id).hasAttribute('title')).toBe(false)
    expect(nameOf(id).textContent).toBe(items.find((item) => item.id === id)!.name)
    expect(nameOf(id).getAttribute('title')).toBe(items.find((item) => item.id === id)!.name)
  }
})

test('avatar needs do not change the mark state, accessible name, or tree attention count', async () => {
  const model = await mountTree(harness(), [worktree('handed', 'handed-one', { avatarStatus: { state: 'gate-failed', level: 'full', needsYou: 3 } })], {
    marks: { handed: 'waiting' },
    pendingAsks: new Map([['handed', 2]])
  })
  expect(markOf('handed').dataset.state).toBe('waiting')
  expect(markOf('handed').getAttribute('aria-label')).toBe('Waiting on you: 2 pending questions')
  expect(model.needsYouCount).toBe(1)
})

test('avatar attention preserves a running mark and leaves the tree attention count at zero', async () => {
  const model = await mountTree(harness(), [
    worktree('plain', 'plain-one'),
    worktree('handed', 'handed-one', { avatarStatus: { state: 'gate-failed', level: 'full', needsYou: 2 } })
  ], {
    marks: { plain: 'running', handed: 'running' },
    pendingAsks: new Map()
  })
  expect(markOf('plain').dataset.state).toBe('running')
  expect(markOf('handed').dataset.state).toBe(markOf('plain').dataset.state)
  expect(markOf('handed').getAttribute('aria-label')).toBe(markOf('plain').getAttribute('aria-label'))
  expect(model.needsYouCount).toBe(0)
  expect(markOf('plain').getAttribute('aria-label')).toBe('Running')
})

test('a menu without a hand-off callback keeps main’s actions and ordering', async () => {
  await mountTree(harness(), [worktree('plain', 'plain-one')])
  await openMenu('plain-one')
  expect(menu()).not.toBeNull()
  expect(menuLabels()).toEqual(MAIN_MENU_LABELS)
  expect(handoffItem()).toBeUndefined()
})

test('the hand-off menu action follows Sleep, calls the callback once, and closes', async () => {
  const calls: string[][] = []
  await mountTree(harness(), [worktree('plain', 'plain-one')], { onHandoffToAvatar: (ids) => calls.push(ids) })
  await openMenu('plain-one')
  const labels = menuLabels()
  expect(labels.indexOf('Hand off to Avatar…')).toBe(labels.indexOf('Sleep') + 1)
  expect(labels.indexOf('Open in')).toBe(labels.indexOf('Hand off to Avatar…') + 1)
  await click(handoffItem()!)
  await settle()
  expect(calls).toEqual([['plain']])
  expect(menu()).toBeNull()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('useTree requests sidebar statuses once, attaches them, and refreshes removed entries on avatar changes', async () => {
  let current: Record<string, unknown> = { w1: STATUS }
  const h = harness({ worktrees: [worktree('w1', 'one'), worktree('w2', 'two')], sidebarStatus: () => current })
  const data = await mountProbe(h)
  expect(h.calls.filter((call) => call.method === 'quirky.avatar/sidebarStatus')).toEqual([{ method: 'quirky.avatar/sidebarStatus', params: {} }])
  expect(avatarStatusOf(data(), 'w1')).toEqual(STATUS)
  expect(avatarStatusOf(data(), 'w2')).toBeNull()

  current = { w2: { state: 'parked', level: 'local', needsYou: 2 } }
  await act(async () => h.emit({ type: 'quirky.avatar/changed', data: {} } as QuirkyEvent))
  await settle()
  expect(avatarStatusOf(data(), 'w1')).toBeNull()
  expect(avatarStatusOf(data(), 'w2')).toEqual({ state: 'parked', level: 'local', needsYou: 2 })
  expect(h.calls.filter((call) => call.method === 'quirky.avatar/sidebarStatus')).toHaveLength(2)
})

test('useTree reloads sidebar statuses after plugin changes and reconnects', async () => {
  let current: Record<string, unknown> = { w1: STATUS }
  const h = harness({ worktrees: [worktree('w1', 'one')], sidebarStatus: () => current })
  const data = await mountProbe(h)
  current = {}
  await act(async () => h.emit({ type: 'plugin.changed', data: {} } as QuirkyEvent))
  await settle()
  expect(avatarStatusOf(data(), 'w1')).toBeNull()

  const reconnectedStatus: AvatarStatus = { state: 'waiting-on-you', level: 'own-branch', needsYou: 1 }
  current = { w1: reconnectedStatus }
  await act(async () => h.reconnect())
  await settle()
  expect(avatarStatusOf(data(), 'w1')).toEqual(reconnectedStatus)
  expect(h.calls.filter((call) => call.method === 'quirky.avatar/sidebarStatus')).toHaveLength(3)
})

test('useTree ignores an older sidebar-status response that resolves last', async () => {
  const older = deferred<Record<string, unknown>>()
  const newer = deferred<Record<string, unknown>>()
  let loads = 0
  const h = harness({
    worktrees: [worktree('w1', 'one')],
    sidebarStatus: () => ++loads === 1 ? older.promise : newer.promise
  })
  const data = await mountProbe(h)
  expect(loads).toBe(1)

  await act(async () => h.emit({ type: 'quirky.avatar/changed', data: {} } as QuirkyEvent))
  expect(loads).toBe(2)
  newer.resolve({ w1: { state: 'done', level: 'local', needsYou: 0 } })
  await settle()
  expect(avatarStatusOf(data(), 'w1')).toEqual({ state: 'done', level: 'local', needsYou: 0 })

  older.resolve({ w1: STATUS })
  await settle()
  expect(avatarStatusOf(data(), 'w1')).toEqual({ state: 'done', level: 'local', needsYou: 0 })
})

test('a failed sidebar-status call leaves every row null without logging or toasting', async () => {
  const h = harness({ worktrees: [worktree('w1', 'one'), worktree('w2', 'two')], sidebarStatus: () => { throw new Error('avatar unavailable') } })
  const data = await mountProbe(h)
  expect(h.calls.filter((call) => call.method === 'quirky.avatar/sidebarStatus')).toHaveLength(1)
  expect(avatarStatusOf(data(), 'w1')).toBeNull()
  expect(avatarStatusOf(data(), 'w2')).toBeNull()
  expect(h.toasts).toEqual([])
  expect(h.logs).toEqual([])
})

test('a failed sidebar-status refresh clears previously loaded statuses without logging or toasting', async () => {
  let unavailable = false
  const h = harness({
    worktrees: [worktree('w1', 'one'), worktree('w2', 'two')],
    sidebarStatus: () => {
      if (unavailable) throw new Error('avatar unavailable')
      return { w1: STATUS, w2: STATUS }
    }
  })
  const data = await mountProbe(h)
  expect(avatarStatusOf(data(), 'w1')).toEqual(STATUS)
  expect(avatarStatusOf(data(), 'w2')).toEqual(STATUS)

  unavailable = true
  await act(async () => h.emit({ type: 'plugin.changed', data: {} } as QuirkyEvent))
  await settle()
  expect(avatarStatusOf(data(), 'w1')).toBeNull()
  expect(avatarStatusOf(data(), 'w2')).toBeNull()
  expect(h.toasts).toEqual([])
  expect(h.logs).toEqual([])
})

type HandoffAction = ((worktreeIds: string[]) => void) | null

function HandoffProbe({ context, onAction }: {
  context: UiPluginContext
  onAction(action: HandoffAction): void
}) {
  onAction(useAvatarHandoff(context))
  return null
}

async function mountHandoffProbe(h: Harness) {
  let latest: HandoffAction = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(HandoffProbe, {
    context: h.context,
    onAction: (action) => { latest = action }
  })))
  await settle()
  return () => latest
}

test('useAvatarHandoff ignores malformed discovery, reloads on plugin changes and reconnect, and preserves command ids', async () => {
  const h = harness({ contributionsReply: {} })
  const action = await mountHandoffProbe(h)
  expect(h.calls.filter((call) => call.method === 'ui.contributions')).toHaveLength(1)
  expect(action()).toBeNull()

  h.setContributions({ commands: [{ id: 'command:quirky.avatar/handoff' }] })
  await act(async () => h.emit({ type: 'plugin.changed', data: {} } as QuirkyEvent))
  await settle()
  expect(typeof action()).toBe('function')

  h.setContributions({ commands: 'not-an-array' })
  await act(async () => h.emit({ type: 'plugin.changed', data: {} } as QuirkyEvent))
  await settle()
  expect(action()).toBeNull()

  h.setContributions({ commands: [{ id: 'command:quirky.avatar/handoff' }] })
  await act(async () => h.emit({ type: 'plugin.changed', data: {} } as QuirkyEvent))
  await settle()
  expect(typeof action()).toBe('function')

  h.setContributions({}, new Error('contributions unavailable'))
  await act(async () => h.emit({ type: 'plugin.changed', data: {} } as QuirkyEvent))
  await settle()
  expect(action()).toBeNull()

  h.setContributions({ commands: [{ id: 'quirky.avatar/handoff' }] })
  await act(async () => h.reconnect())
  await settle()
  const execute = action()
  expect(typeof execute).toBe('function')
  h.setExecuteCommandError(new Error('boom'))
  execute?.(['plain'])
  await settle()
  expect(h.commands).toEqual([{ id: 'quirky.avatar/handoff', args: { worktreeIds: ['plain'] } }])
  expect(h.toasts).toEqual([{ title: 'Could not hand off to Avatar', body: 'boom' }])
  expect(h.calls.filter((call) => call.method === 'ui.contributions')).toHaveLength(6)
})

test('useAvatarHandoff rejects unrelated commands and selects the hand-off id beside them', async () => {
  const unrelated = 'command:quirky.session/new-shell'
  const handoff = 'command:quirky.avatar/handoff'
  const h = harness({ commandIds: [unrelated] })
  const action = await mountHandoffProbe(h)
  expect(action()).toBeNull()

  h.setContributions({ commands: [{ id: unrelated }, { id: handoff }] })
  await act(async () => h.emit({ type: 'plugin.changed', data: {} } as QuirkyEvent))
  await settle()
  const execute = action()
  expect(typeof execute).toBe('function')
  execute?.(['plain'])
  await settle()
  expect(h.commands).toEqual([{ id: handoff, args: { worktreeIds: ['plain'] } }])
})
