import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentDisplayState, AgentStatusSummary, ProjectGroup, QuirkyEvent, Repo, Session, UiLayout, UiPluginContext, Worktree } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'
import type { CleanupCandidate, CleanupRemovalResult, StockWorktreeOptions } from '../src/control-types'

const SLOT = 'sidebar-section:quirky.worktree/worktrees'
const COMMAND = 'command:quirky.worktree/new-worktree'
const SESSION_VIEW = 'view:quirky.session/worktree'
const PRIMARY_TIP = 'the primary worktree cannot be deleted; remove the project instead'

const WORKTREE_DEFAULTS = {
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 0,
  createdBy: 'external',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 0,
  sleeping: false,
  manualOrder: 0
} as const

const REPO_DEFAULTS = { kind: 'git', displayName: null, groupId: null } as const

type Mount = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => () => void
type Call = { method: string; params: Record<string, unknown> }

let act: (callback: () => unknown) => Promise<void>
let activate: (context: UiPluginContext) => void

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const repos: Repo[] = [
  { id: 'r1', name: 'api', path: '/r/api', addedAt: 0, ...REPO_DEFAULTS },
  { id: 'r2', name: 'web', path: '/r/web', addedAt: 0, ...REPO_DEFAULTS }
]

const wt = (id: string, repoId: string, name: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  repoId,
  path: `/w/${name}`,
  branch: name,
  head: 'abc',
  isMain: false,
  name,
  ...WORKTREE_DEFAULTS,
  instanceId: id,
  ...extra
})

const NO_HOOKS = { file: null, setup: null, archive: null, agentStartup: null, sharedDirectories: [], warnings: [] }

const group = (id: string, name: string, repoIds: string[], extra: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name,
  parentPath: null,
  collapsed: false,
  order: 0,
  createdFrom: 'manual',
  repoIds,
  parentId: null,
  ...extra
})

const session = (id: string, worktreeId: string, status: Session['status']): Session => ({
  id,
  kind: 'terminal',
  agent: 'shell',
  worktreeId,
  cwd: '/x',
  title: id,
  status,
  createdAt: 0,
  lastActivityAt: 0,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
})

class RpcLike extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message)
  }
}

type World = {
  repos: Repo[]
  groups: ProjectGroup[]
  worktrees: Worktree[]
  sessions: Session[] | null
  confirms: boolean[]
  failRemove: (Error | null)[]
  failSet: Error | null
  /** When set, `create` waits for it, so a test can look at the pending row. */
  createGate: Promise<void> | null
  /** Errors the next creates throw, in order. */
  createFailures: Error[]
  /** What `create` returns beyond the worktree. */
  createExtra: Record<string, unknown>
  /** Changed files `quirky.git/status` reports; null makes the call fail. */
  changedFiles: number | null
  /** The `confirmDelete` setting the window reads. */
  confirmDelete: boolean
  /** The branch a remove reports as kept. */
  keptBranch: { name: string; head: string } | null
  options: StockWorktreeOptions
  cleanupCandidates: CleanupCandidate[]
  cleanupResults: CleanupRemovalResult[]
}

function setup(layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }) {
  const world: World = {
    repos: [...repos],
    groups: [],
    worktrees: [wt('w1', 'r1', 'main', { isMain: true }), wt('w2', 'r1', 'fix-login'), wt('w3', 'r2', 'main', { isMain: true })],
    sessions: [session('s1', 'w2', 'working')],
    confirms: [],
    failRemove: [],
    failSet: null,
    createGate: null,
    createFailures: [],
    createExtra: {},
    changedFiles: 0,
    confirmDelete: true,
    keptBranch: null,
    options: { groupBy: 'project', sortBy: 'recent', compact: false, showBranch: true, showComment: true, showSleeping: true },
    cleanupCandidates: [
      { worktreeId: 'w2', name: 'fix-login', fingerprint: 'fix-fingerprint', reason: 'idle-clean', ignored: false, eligible: true, blockers: [] },
      { worktreeId: 'w1', name: 'main', fingerprint: 'main-fingerprint', reason: 'idle-clean', ignored: false, eligible: false, blockers: [{ code: 'main-worktree', detail: 'Primary worktrees cannot be deleted.' }] }
    ],
    cleanupResults: [{ worktreeId: 'w2', removed: true }]
  }
  const calls: Call[] = []
  const confirmed: { title: string; body?: string }[] = []
  const toasts: { title: string; body: string }[] = []
  const opened: { id: string; input?: unknown }[] = []
  const reports: unknown[] = []
  const eventListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const provided = new Map<string, unknown>()
  let current = layout

  const context = {
    pluginId: 'quirky.worktree',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      switch (method) {
        case 'quirky.repo/list':
          return [...world.repos]
        case 'quirky.repo/groupList':
          return [...world.groups]
        case 'quirky.repo/resolve': {
          const found = world.repos.find((r) => r.id === params.selector || r.name === params.selector)
          if (!found) throw new RpcLike(`no project matches ${String(params.selector)}`, RpcErrorCode.NotFound)
          return found
        }
        case 'quirky.worktree/list':
          return [...world.worktrees]
        case 'quirky.worktree/options':
          return { ...world.options }
        case 'quirky.worktree/setOptions':
          world.options = { ...world.options, ...params } as StockWorktreeOptions
          return { ...world.options }
        case 'quirky.worktree/reorder':
          return { ok: true }
        case 'quirky.worktree/sleepPreview': {
          const target = world.worktrees.find((worktree) => worktree.id === params.worktree)!
          const sleeping = 'sleeping' in target && target.sleeping === true
          return { worktrees: [{ worktreeId: target.id, name: target.name, sleeping, allowed: true, blockers: [] }] }
        }
        case 'quirky.worktree/sleep':
        case 'quirky.worktree/wake': {
          const target = world.worktrees.find((worktree) => worktree.id === params.worktree)!
          const sleeping = method === 'quirky.worktree/sleep'
          world.worktrees = world.worktrees.map((worktree) =>
            worktree.id === target.id ? { ...worktree, sleeping } as Worktree : worktree
          )
          return { worktrees: [{ worktreeId: target.id, sleeping, changedAt: Date.now() }] }
        }
        case 'quirky.worktree/cleanupPreview':
          return { generatedAt: Date.now(), candidates: [...world.cleanupCandidates] }
        case 'quirky.worktree/cleanupIgnore': {
          world.cleanupCandidates = world.cleanupCandidates.map((candidate) =>
            candidate.worktreeId === params.worktreeId
              ? { ...candidate, ignored: true, eligible: false, blockers: [...candidate.blockers, { code: 'dismissed', detail: 'Ignored by the user.' }] }
              : candidate
          )
          return { ok: true }
        }
        case 'quirky.worktree/cleanupRestoreIgnored': {
          const restored = world.cleanupCandidates.filter((candidate) => candidate.ignored).length
          world.cleanupCandidates = world.cleanupCandidates.map((candidate) => ({
            ...candidate,
            ignored: false,
            eligible: candidate.blockers.every((blocker) => blocker.code !== 'main-worktree' && blocker.code !== 'dismissed'),
            blockers: candidate.blockers.filter((blocker) => blocker.code !== 'dismissed')
          }))
          return { restored }
        }
        case 'quirky.worktree/cleanupRemove':
          return { results: world.cleanupResults }
        case 'quirky.session/list':
          if (world.sessions === null) throw new RpcLike('method not found', RpcErrorCode.MethodNotFound)
          return world.sessions
        case 'quirky.sidebar-extras/state':
          throw new RpcLike('method not found', RpcErrorCode.MethodNotFound)
        case 'quirky.worktree/set': {
          if (world.failSet) throw world.failSet
          const target = world.worktrees.find((w) => w.id === params.worktree)!
          return target
        }
        case 'quirky.repo/groupCollapse':
        case 'quirky.repo/groupAdd':
          return { ok: true }
        case 'quirky.worktree/remove': {
          const failure = world.failRemove.shift()
          if (failure) throw failure
          return { ok: true, removed: [], ...(world.keptBranch ? { keptBranch: world.keptBranch } : {}) }
        }
        case 'quirky.worktree/deleteBranch':
          return { ok: true }
        case 'quirky.worktree/create':
          await world.createGate
          if (world.createFailures.length > 0) throw world.createFailures.shift()
          return { worktree: wt('w9', String(params.repo), String(params.name)), warnings: [], setup: { ran: 'none' }, ...world.createExtra }
        case 'quirky.repo/trustHooks':
          return {}
        case 'quirky.worktree/suggestName':
          return { name: `suggested-${String(params.repo)}` }
        case 'quirky.repo/show':
          return { repo: world.repos.find((r) => r.id === params.repo), settings: { defaultBase: null, setupPolicy: 'ask' }, hooks: NO_HOOKS }
        case 'quirky.repo/hooks':
          return NO_HOOKS
        case 'quirky.repo/add':
          return repos[0]
        case 'quirky.git/status':
          if (world.changedFiles === null) throw new RpcLike('not a git workspace', RpcErrorCode.InvalidParams)
          return { branch: 'x', upstream: null, ahead: 0, behind: 0, files: Array.from({ length: world.changedFiles }, () => ({})) }
        case 'setting.set':
          return {}
        default:
          throw new Error(`unexpected call ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    getSetting: (name: string) => (name === 'setting:quirky.worktree/confirmDelete' ? world.confirmDelete : undefined),
    executeCommand: async () => {},
    openView(id: string, input?: unknown) {
      opened.push({ id, input })
    },
    closeView() {},
    togglePanel() {},
    getLayout: () => current,
    onLayout(listener: (layout: UiLayout) => void) {
      layoutListeners.add(listener)
      return () => void layoutListeners.delete(listener)
    },
    onStream: () => () => {},
    onConnection: () => () => {},
    async confirm(options: { title: string; body?: string }) {
      confirmed.push(options)
      return world.confirms.shift() ?? true
    },
    toast(title: string, body: string) {
      toasts.push({ title, body })
    },
    setPanelBadge() {}
  } as unknown as UiPluginContext

  activate(context)
  const mount = provided.get(SLOT) as Mount

  return {
    world,
    calls,
    confirmed,
    toasts,
    opened,
    reports,
    provided,
    callsTo: (method: string) => calls.filter((c) => c.method === method).map((c) => c.params),
    listenerCount: () => eventListeners.size + layoutListeners.size,
    emit: (event: QuirkyEvent) =>
      act(async () => {
        await Promise.all([...eventListeners].map((l) => l(event)))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }),
    setLayout: (next: UiLayout) =>
      act(async () => {
        current = next
        for (const listener of layoutListeners) listener(next)
      }),
    runCommand: (args?: unknown) =>
      act(async () => {
        await (provided.get(COMMAND) as (args?: unknown) => unknown)(args)
      }),
    async mountInto(element: HTMLElement) {
      let cleanup: () => void = () => {}
      await act(async () => {
        cleanup = mount(element, { report: (state) => void reports.push(state) })
      })
      return () => act(async () => cleanup())
    }
  }
}

let host: HTMLElement
let copied: string[]
let copyFails: boolean
beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
  copied = []
  copyFails = false
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (copyFails) throw new Error('clipboard denied')
        copied.push(text)
      }
    }
  })
})

const lastReport = (h: ReturnType<typeof setup>) => h.reports[h.reports.length - 1] as any
const projectSection = (repoName: string) =>
  [...host.querySelectorAll('section.repo')].find((s) => s.querySelector('.repo-name')?.textContent === repoName)!
const rowOf = (name: string, repoName: string) =>
  Array.from(projectSection(repoName).querySelectorAll('li.worktree')).find(
    (li) => li.querySelector('.worktree-name')?.textContent === name
  ) as HTMLElement
const pinnedRow = (name: string) =>
  Array.from(host.querySelectorAll('section.pinned li.worktree')).find(
    (li) => li.querySelector('.worktree-name')?.textContent === name
  ) as HTMLElement
const click = (element: Element) => act(async () => void (element as HTMLElement).click())
const contextMenu = (element: Element, x = 30, y = 40) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  })
const menu = () => document.querySelector('[role="menu"]') as HTMLElement | null
const items = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')] as HTMLButtonElement[]
const itemLabels = () => items().map((e) => e.textContent!.replace(/\s*▸$/, ''))
const itemNamed = (label: string) => items().find((e) => e.textContent!.replace(/\s*▸$/, '') === label)!
const press = (key: string) => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
const typeInto = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

test('the module provides the declared sidebar slot and the new-worktree command', () => {
  const h = setup()
  expect([...h.provided.keys()].sort()).toEqual([COMMAND, SLOT])
})

test('SC-35: renders repos and worktrees and reports them with status and selection', async () => {
  const h = setup({ view: { id: SESSION_VIEW, input: { worktree: 'w2' } }, panel: null, sidebar: true, focus: 'view' })
  await h.mountInto(host)
  expect([...host.querySelectorAll('.repo-name')].map((e) => e.textContent)).toEqual(['api', 'web'])
  expect(rowOf('fix-login', 'api').className).toContain('selected')
  expect(rowOf('main', 'api').className).not.toContain('selected')
  expect(lastReport(h)).toMatchObject({
    pinned: [],
    groups: [],
    projects: [
      {
        id: 'r1',
        name: 'api',
        kind: 'git',
        worktrees: [
          { id: 'w1', name: 'main', primary: true, status: null, selected: false },
          { id: 'w2', name: 'fix-login', status: 'working', workspaceStatus: 'in-progress', selected: true }
        ]
      },
      {
        id: 'r2',
        name: 'web',
        kind: 'git',
        worktrees: [{ id: 'w3', name: 'main', primary: true, status: null, selected: false }]
      }
    ]
  })
  expect(rowOf('fix-login', 'api').querySelector('.dot-working')).not.toBeNull()
})

test('shows the empty message with no repositories', async () => {
  const h = setup()
  h.world.repos = []
  await h.mountInto(host)
  expect(host.textContent).toContain('No repositories yet.')
  expect(lastReport(h)).toMatchObject({ pinned: [], groups: [], projects: [], dialog: null, notices: [] })
})

test('SC-36: the selected row follows the open view input', async () => {
  const h = setup()
  await h.mountInto(host)
  expect(host.querySelector('li.worktree.selected')).toBeNull()
  await h.setLayout({ view: { id: SESSION_VIEW, input: { worktree: 'w3' } }, panel: null, sidebar: true, focus: null })
  expect(rowOf('main', 'web').className).toContain('selected')
  expect(lastReport(h).projects[1].worktrees[0].selected).toBe(true)
  await h.setLayout({ view: null, panel: null, sidebar: true, focus: null })
  expect(host.querySelector('li.worktree.selected')).toBeNull()
})

test('SC-37: clicking a worktree opens the session view on it', async () => {
  const h = setup()
  await h.mountInto(host)
  await click(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  expect(h.opened).toEqual([{ id: SESSION_VIEW, input: { worktree: 'w2' } }])
  expect(h.callsTo('quirky.worktree/set')).toEqual([])
})

test('SC-43: opening an unread worktree marks it read', async () => {
  const h = setup()
  h.world.worktrees[1] = wt('w2', 'r1', 'fix-login', { unread: true })
  await h.mountInto(host)
  const bell = rowOf('fix-login', 'api').querySelector('.glyph-unread')!
  expect(bell.getAttribute('role')).toBe('img')
  expect(bell.getAttribute('aria-label')).toBe('Unread')
  expect(rowOf('fix-login', 'api').querySelector('.dot, .glyph:not(.glyph-unread)')).toBeNull()
  expect(rowOf('fix-login', 'api').querySelector('.worktree-name')!.classList.contains('worktree-name-unread')).toBe(true)
  expect(rowOf('fix-login', 'api').querySelector('.unread-mark')).toBeNull()
  await click(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  expect(h.opened).toEqual([{ id: SESSION_VIEW, input: { worktree: 'w2' } }])
  expect(h.callsTo('quirky.worktree/set')).toEqual([{ worktree: 'w2', unread: false }])
})

test('shows no status dots and reports null statuses when quirky.session is off', async () => {
  const h = setup()
  h.world.sessions = null
  await h.mountInto(host)
  expect(host.querySelector('.dot-working')).toBeNull()
  expect(host.querySelectorAll('.dot-none').length).toBe(3)
  expect(lastReport(h).projects[0].worktrees[1].status).toBeNull()
})

test('status follows the session events', async () => {
  const h = setup()
  await h.mountInto(host)
  await h.emit({ type: 'quirky.session/changed', data: { session: session('s1', 'w2', 'waiting') } })
  expect(rowOf('fix-login', 'api').querySelector('.dot-waiting')).not.toBeNull()
  await h.emit({ type: 'quirky.session/changed', data: { session: session('s2', 'w1', 'done') } })
  expect(lastReport(h).projects[0].worktrees[0].status).toBe('done')
  await h.emit({ type: 'quirky.session/removed', data: { sessionId: 's1' } })
  expect(lastReport(h).projects[0].worktrees[1].status).toBeNull()
})

test('refreshes the tree on repo, group and worktree changes', async () => {
  const h = setup()
  await h.mountInto(host)
  h.world.worktrees.push(wt('w4', 'r2', 'feature-x'))
  await h.emit({ type: 'quirky.worktree/changed', data: { repoId: 'r2' } })
  expect(rowOf('feature-x', 'web')).not.toBeUndefined()
  h.world.repos.push({ id: 'r3', name: 'docs', path: '/r/docs', addedAt: 0, ...REPO_DEFAULTS })
  await h.emit({ type: 'quirky.repo/changed', data: {} })
  expect([...host.querySelectorAll('.repo-name')].map((e) => e.textContent)).toEqual(['api', 'web', 'docs'])
  h.world.groups = [group('g1', 'services', ['r1'])]
  h.world.repos[0] = { ...h.world.repos[0]!, groupId: 'g1' }
  await h.emit({ type: 'quirky.repo/changed', data: { groupId: 'g1' } })
  expect([...host.querySelectorAll('.group-name')].map((e) => e.textContent)).toEqual(['services'])
  expect(lastReport(h).groups[0].projects.map((p: { name: string }) => p.name)).toEqual(['api'])
})

test('a plugin.changed event reloads the tree and the sessions', async () => {
  const h = setup()
  await h.mountInto(host)
  const before = h.callsTo('quirky.session/list').length
  h.world.sessions = [session('s1', 'w2', 'done')]
  await h.emit({ type: 'plugin.changed' })
  expect(h.callsTo('quirky.session/list').length).toBe(before + 1)
  expect(rowOf('fix-login', 'api').querySelector('.dot-done')).not.toBeNull()
})

test('does not report again when nothing changed', async () => {
  const h = setup()
  await h.mountInto(host)
  const before = h.reports.length
  await h.emit({ type: 'quirky.worktree/changed', data: { repoId: 'r1' } })
  expect(h.reports.length).toBe(before)
})

test('SC-44: groups, the Pinned section, the primary badge, nested children and status labels', async () => {
  const h = setup()
  h.world.repos = [
    { ...repos[0]!, groupId: 'g1' },
    { ...repos[1]!, kind: 'folder' }
  ]
  h.world.groups = [group('g1', 'services', ['r1'])]
  h.world.worktrees = [
    wt('w1', 'r1', 'main', { isMain: true }),
    wt('w2', 'r1', 'fix-login', { status: 'in-review', pinned: true, unread: true }),
    wt('w5', 'r1', 'child', { parentId: 'w2', status: 'todo' }),
    wt('w6', 'r1', 'old', { removing: true }),
    wt('w3', 'r2', 'notes', { isMain: true, kind: 'folder', branch: null }),
    wt('w7', 'group:g1', 'shared', { kind: 'folder', branch: null, groupId: 'g1' })
  ]
  await h.mountInto(host)

  expect([...host.querySelectorAll('section.pinned li .worktree-name')].map((e) => e.textContent)).toEqual(['fix-login'])
  const group1 = host.querySelector('section.group')!
  expect(group1.querySelector('.group-name')?.textContent).toBe('services')
  expect([...group1.querySelectorAll('section.repo .repo-name')].map((e) => e.textContent)).toEqual(['api'])
  expect(rowOf('main', 'api').querySelector('.tag-primary')?.textContent).toBe('primary')
  expect(rowOf('fix-login', 'api').querySelector('.tag-status')?.textContent).toBe('In review')
  expect(rowOf('child', 'api').querySelector('.tag-status')?.textContent).toBe('Todo')
  expect(rowOf('main', 'api').querySelector('.tag-status')).toBeNull()
  expect(rowOf('child', 'api').style.getPropertyValue('--depth')).toBe('1')
  expect(rowOf('old', 'api').textContent).toContain('Deleting')

  const chip = rowOf('fix-login', 'api').querySelector('.children-chip') as HTMLElement
  expect(chip.textContent).toBe('1 child')
  expect(chip.getAttribute('aria-expanded')).toBe('true')
  await click(chip)
  expect(rowOf('child', 'api')).toBeUndefined()
  expect(rowOf('fix-login', 'api').querySelector('.children-chip')!.getAttribute('aria-expanded')).toBe('false')
  await click(rowOf('fix-login', 'api').querySelector('.children-chip')!)
  expect(rowOf('child', 'api')).not.toBeUndefined()

  const report = lastReport(h)
  expect(report.pinned).toEqual(['w2'])
  expect(report.groups).toEqual([
    {
      id: 'g1',
      name: 'services',
      collapsed: false,
      worktrees: [expect.objectContaining({ id: 'w7', name: 'shared', kind: 'folder', depth: 0 })],
      projects: [
        {
          id: 'r1',
          name: 'api',
          kind: 'git',
          worktrees: [
            expect.objectContaining({ id: 'w1', primary: true, depth: 0 }),
            expect.objectContaining({ id: 'w2', workspaceStatus: 'in-review', pinned: true, unread: true, depth: 0 }),
            expect.objectContaining({ id: 'w5', parentId: 'w2', depth: 1, workspaceStatus: 'todo' }),
            expect.objectContaining({ id: 'w6', removing: true })
          ]
        }
      ]
    }
  ])
  expect(report.projects).toEqual([
    { id: 'r2', name: 'web', kind: 'folder', worktrees: [expect.objectContaining({ id: 'w3', kind: 'folder', primary: true })] }
  ])
})

test('SC-44: a group header collapses its projects through groupCollapse', async () => {
  const h = setup()
  h.world.repos = [{ ...repos[0]!, groupId: 'g1' }]
  h.world.groups = [group('g1', 'services', ['r1'])]
  await h.mountInto(host)
  await click(host.querySelector('.group-toggle')!)
  expect(h.callsTo('quirky.repo/groupCollapse')).toEqual([{ group: 'g1', collapsed: true }])
  h.world.groups = [group('g1', 'services', ['r1'], { collapsed: true })]
  await h.emit({ type: 'quirky.repo/changed', data: { groupId: 'g1' } })
  expect(host.querySelector('section.group section.repo')).toBeNull()
  expect(host.querySelector('.group-toggle')!.getAttribute('aria-expanded')).toBe('false')
  expect(lastReport(h).groups[0].collapsed).toBe(true)
  await click(host.querySelector('.group-toggle')!)
  expect(h.callsTo('quirky.repo/groupCollapse')[1]).toEqual({ group: 'g1', collapsed: false })
})

test('project menu opens its ledger and moves projects through the shared action', async () => {
  const h = setup()
  h.world.groups = [group('g1', 'services', ['r1'])]
  await h.mountInto(host)

  const actions = projectSection('api').querySelector('.project-menu')!
  await click(actions)
  await click(itemNamed('Open ledger'))
  expect(h.opened).toEqual([{
    id: 'view:quirky.ledger/ledger',
    input: { target: { owner: { tier: 'project', id: 'r1' } } }
  }])

  await click(actions)
  await click(itemNamed('Move to Group'))
  await click(itemNamed('services'))
  expect(h.callsTo('quirky.repo/groupAdd')).toEqual([{ group: 'g1', repo: 'r1' }])
})

test('SC-43: the card menu opens and closes on Escape and outside click', async () => {
  const h = setup()
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!, 120, 80)
  expect(menu()!.getAttribute('role')).toBe('menu')
  expect(menu()!.style.left).toBe('120px')
  expect(menu()!.style.top).toBe('80px')
  await press('Escape')
  expect(menu()).toBeNull()

  await click(rowOf('fix-login', 'api').querySelector('.worktree-menu')!)
  expect(menu()).not.toBeNull()
  await act(async () => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(menu()).toBeNull()
})

test('SC-43: Move to Status, Pin and Mark Unread call set; the current values read the other way', async () => {
  const h = setup()
  h.world.worktrees[1] = wt('w2', 'r1', 'fix-login', { pinned: true, unread: true, parentId: 'w1' })
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Move to Status'))
  expect(itemLabels().slice(2, 6)).toEqual(['Todo', 'In progress', 'In review', 'Done'])
  await click(itemNamed('In review'))
  expect(menu()).toBeNull()
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Unpin'))
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Mark Read'))
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Remove from Parent'))
  expect(h.callsTo('quirky.worktree/set')).toEqual([
    { worktree: 'w2', status: 'in-review' },
    { worktree: 'w2', pinned: false },
    { worktree: 'w2', unread: false },
    { worktree: 'w2', noParent: true }
  ])
})

test('a failed set becomes a toast', async () => {
  const h = setup()
  h.world.failSet = new RpcLike('nope', RpcErrorCode.Conflict)
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Pin'))
  expect(h.toasts).toEqual([{ title: 'Could not update workspace', body: 'nope' }])
})

test('SC-43: Copy Path and Copy Worktree Name use the clipboard and a failure toasts', async () => {
  const h = setup()
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Copy Path'))
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Copy Worktree Name'))
  expect(copied).toEqual(['/w/fix-login', 'fix-login'])
  copyFails = true
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Copy Path'))
  expect(h.toasts).toEqual([{ title: 'Could not copy', body: 'clipboard denied' }])
})

test('SC-59: the primary worktree has Delete disabled with a tooltip', async () => {
  const h = setup()
  await h.mountInto(host)
  await contextMenu(rowOf('main', 'api').querySelector('.worktree-main')!)
  const del = itemNamed('Delete')
  expect(del.disabled).toBe(true)
  expect(del.title).toBe(PRIMARY_TIP)
  await click(del)
  expect(h.confirmed).toEqual([])
  expect(h.callsTo('quirky.worktree/remove')).toEqual([])
})

test('a parent offers Delete with Descendants and removes them together', async () => {
  const h = setup()
  h.world.worktrees.push(wt('w5', 'r1', 'child', { parentId: 'w2' }), wt('w6', 'r1', 'grandchild', { parentId: 'w5' }))
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete with Descendants (2)…'))
  expect(h.callsTo('quirky.worktree/remove')).toEqual([])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Child workspaces will be deleted')
  expect(lastReport(h).dialog).toEqual({ kind: 'delete', worktreeId: 'w2', withDescendants: true })
  await click(dialogButton('Delete Workspace'))
  expect(h.callsTo('quirky.worktree/remove')).toEqual([{ worktree: 'w2', force: true, withDescendants: true, yes: true }])
})

test('Update and Set Parent open their dialogs and the report names them', async () => {
  const h = setup()
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Update…'))
  expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Workspace details')
  expect(lastReport(h).dialog).toEqual({ kind: 'update', worktreeId: 'w2' })
  await press('Escape')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(lastReport(h).dialog).toBeNull()
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Set Parent Worktree…'))
  expect(document.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Set parent worktree')
  expect(lastReport(h).dialog).toEqual({ kind: 'parent', worktreeId: 'w2' })
})


test('SC-47: Delete asks in the window and passes force and yes with no ask card', async () => {
  const h = setup()
  h.world.changedFiles = 2
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete'))
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe('Delete Workspace')
  expect(dialog.textContent).toContain('/w/fix-login')
  expect(dialog.textContent).toContain('2 uncommitted or untracked changes')
  expect(dialog.textContent).not.toContain('Child workspaces')
  expect(h.confirmed).toEqual([])
  expect(h.callsTo('quirky.worktree/remove')).toEqual([])
  await click(dialogButton('Delete Workspace'))
  expect(h.callsTo('quirky.worktree/remove')).toEqual([{ worktree: 'w2', force: true, yes: true }])
  expect(h.callsTo('setting.set')).toEqual([])
  expect(h.calls.some((c) => c.method.startsWith('quirky.ask/'))).toBe(false)
})

test('the delete dialog leaves out the change count for no changes or a failed status', async () => {
  const h = setup()
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete'))
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toMatch(/\d+ uncommitted/)
  await click(dialogButton('Cancel'))
  h.world.changedFiles = null
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete'))
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toMatch(/\d+ uncommitted/)
  expect(h.toasts).toEqual([])
})

test('a cancelled delete removes nothing', async () => {
  const h = setup()
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete'))
  await click(dialogButton('Cancel'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(h.callsTo('quirky.worktree/remove')).toEqual([])
})

test('Don\'t ask again turns the setting off first and toasts', async () => {
  const h = setup()
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete'))
  await click(document.querySelector('[role="dialog"] input[type="checkbox"]')!)
  await click(dialogButton('Delete Workspace'))
  expect(h.calls.filter((c) => c.method === 'setting.set' || c.method === 'quirky.worktree/remove').map((c) => c.method)).toEqual(['setting.set', 'quirky.worktree/remove'])
  expect(h.callsTo('setting.set')).toEqual([{ id: 'setting:quirky.worktree/confirmDelete', value: false }])
  expect(h.toasts).toEqual([{ title: "We'll skip this confirmation next time. You can change this in Settings.", body: '' }])
})

test('with confirmDelete off, Delete removes at once', async () => {
  const h = setup()
  h.world.confirmDelete = false
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(h.callsTo('quirky.worktree/remove')).toEqual([{ worktree: 'w2', force: true, yes: true }])
})

test('a refused delete toasts the failure with its message, and the card is not left showing Deleting', async () => {
  const h = setup()
  h.world.confirmDelete = false
  h.world.failRemove = [new RpcLike('locked by git', RpcErrorCode.Conflict, { reason: 'locked' })]
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete'))
  expect(h.toasts).toEqual([{ title: 'Failed to delete workspace fix-login', body: 'locked by git' }])
  expect(rowOf('fix-login', 'api').className).not.toContain('removing')
})

test('a delete that keeps its branch shows a notice whose Delete branch calls deleteBranch', async () => {
  const h = setup()
  h.world.confirmDelete = false
  h.world.keptBranch = { name: 'zoe/fix-login', head: 'abc' }
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Delete'))
  const notice = host.querySelector('.notice')!
  expect(notice.textContent).toContain("Kept branch zoe/fix-login because it isn't merged.")
  expect(lastReport(h).notices).toEqual([{ kind: 'kept-branch', branch: 'zoe/fix-login', repoId: 'r1' }])
  await click([...notice.querySelectorAll('button')].find((b) => b.textContent === 'Delete branch')!)
  expect(h.callsTo('quirky.worktree/deleteBranch')).toEqual([{ repo: 'r1', branch: 'zoe/fix-login', head: 'abc', yes: true }])
  expect(host.querySelector('.notice')).toBeNull()
  expect(lastReport(h).notices).toEqual([])
})

test('the Add project button opens a dialog whose Add submits the trimmed path', async () => {
  const h = setup()
  await h.mountInto(host)
  await click(host.querySelector('button.add-project')!)
  expect(lastReport(h).dialog).toEqual({ kind: 'add-project' })
  const input = document.querySelector('[role="dialog"] input') as HTMLInputElement
  const submit = dialogButton('Add')
  expect(submit.disabled).toBe(true)
  await typeInto(input, '  /r/new  ')
  await click(submit)
  expect(h.callsTo('quirky.repo/add')).toEqual([{ path: '/r/new' }])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

const dialogField = (label: string) => {
  const holder = [...document.querySelectorAll('[role="dialog"] label')].find((l) => l.querySelector(':scope > span')?.textContent === label)
  return holder?.querySelector('input, select, textarea') as HTMLInputElement | undefined
}
const projectChosen = () => (dialogField('Project') as unknown as HTMLSelectElement).selectedOptions[0]!.textContent

test('the new-worktree dialog creates a worktree through a pending row and opens it', async () => {
  const h = setup()
  let release: () => void = () => {}
  h.world.createGate = new Promise((resolve) => (release = resolve))
  await h.mountInto(host)
  await click(host.querySelector('button[aria-label="New worktree in api"]')!)
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe('New workspace')
  expect(projectChosen()).toBe('api')
  expect(lastReport(h).dialog).toEqual({ kind: 'create', repoId: 'r1' })
  expect(dialogField('Name')!.placeholder).toBe('suggested-r1')
  await typeInto(dialogField('Name')!, ' feature-y ')
  await typeInto(dialogField('Base')!, 'main')
  await act(async () => void (dialog.querySelector('button[type="submit"]') as HTMLButtonElement).click())

  const pending = rowOf('feature-y', 'api')
  expect(pending.className).toContain('pending')
  expect(lastReport(h).projects[0].worktrees.at(-1)).toMatchObject({ id: 'pending:feature-y', name: 'feature-y', pending: true })
  await act(async () => release())

  expect(h.callsTo('quirky.worktree/create')).toEqual([
    { repo: 'r1', name: 'feature-y', base: 'main', createdBy: 'window' }
  ])
  expect(h.opened).toEqual([{ id: SESSION_VIEW, input: { worktree: 'w9' } }])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(rowOf('feature-y', 'api')).toBeUndefined()
  expect(lastReport(h).dialog).toBeNull()
})

test('a create is not opened when the view changed meanwhile, and a toast names it', async () => {
  const h = setup()
  let release: () => void = () => {}
  h.world.createGate = new Promise((resolve) => (release = resolve))
  await h.mountInto(host)
  await click(host.querySelector('button[aria-label="New worktree in api"]')!)
  await typeInto(dialogField('Name')!, 'later')
  await act(async () => void (document.querySelector('[role="dialog"] button[type="submit"]') as HTMLButtonElement).click())
  await h.setLayout({ view: { id: SESSION_VIEW, input: { worktree: 'w1' } }, panel: null, sidebar: true, focus: 'view' })
  await act(async () => release())
  expect(h.opened).toEqual([])
  expect(h.toasts).toEqual([{ title: 'Created later', body: '/w/later' }])
})

test('SC-62: the new-worktree command opens the create dialog on the named, open or first project', async () => {
  const h = setup()
  await h.mountInto(host)
  await h.runCommand()
  expect(projectChosen()).toBe('api')
  expect(lastReport(h).dialog).toEqual({ kind: 'create', repoId: 'r1' })
  await press('Escape')

  await h.runCommand({ repo: 'web' })
  expect(projectChosen()).toBe('web')
  expect(lastReport(h).dialog).toEqual({ kind: 'create', repoId: 'r2' })
  expect(h.callsTo('quirky.repo/resolve')).toEqual([{ selector: 'web' }])
  await press('Escape')

  await h.setLayout({ view: { id: SESSION_VIEW, input: { worktree: 'w3' } }, panel: null, sidebar: true, focus: 'view' })
  await h.runCommand()
  expect(lastReport(h).dialog).toEqual({ kind: 'create', repoId: 'r2' })
})

const untrusted = (changed = false) =>
  new RpcLike('The setup script in quirky.yaml has not been trusted', RpcErrorCode.Conflict, {
    reason: 'hooks-untrusted',
    repo: 'r1',
    kind: 'setup',
    script: 'touch ran.txt',
    hash: 'a'.repeat(64),
    changed,
    ref: 'abc123'
  })

async function submitNamed(h: ReturnType<typeof setup>, name: string) {
  await h.mountInto(host)
  await click(host.querySelector('button[aria-label="New worktree in api"]')!)
  await typeInto(dialogField('Name')!, name)
  await act(async () => void (document.querySelector('[role="dialog"] button[type="submit"]') as HTMLButtonElement).click())
}
const dialogTitles = () => [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-label'))
const dialogButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label)!

test('SC-33: an untrusted script asks, and each answer retries the create its own way', async () => {
  const answers = ['Run hooks', "Don't run", 'Always trust'] as const
  for (const label of answers) {
    document.body.innerHTML = ''
    host = document.createElement('div')
    document.body.append(host)
    const h = setup()
    h.world.createFailures = [untrusted()]
    await submitNamed(h, 'trusted')
    expect(dialogTitles()).toEqual(['New workspace', 'Run setup from api?'])
    expect(document.querySelector('.script-preview')!.textContent).toBe('touch ran.txt')
    expect(lastReport(h).dialog).toEqual({ kind: 'trust', repoId: 'r1' })
    await click(dialogButton(label))
    expect(h.callsTo('quirky.repo/trustHooks')).toEqual(label === 'Always trust' ? [{ repo: 'r1', kind: 'setup', ref: 'abc123' }] : [])
    expect(h.opened).toEqual([{ id: SESSION_VIEW, input: { worktree: 'w9' } }])
    expect(dialogTitles()).toEqual([])
  }
})

test('SC-33: a changed script is asked about with its own title', async () => {
  const h = setup()
  h.world.createFailures = [untrusted(true)]
  await submitNamed(h, 'again')
  expect(dialogTitles()).toEqual(['New workspace', "api's setup changed — run the new version?"])
})

test('SC-33: Escape on the trust question abandons the create and leaves the form open', async () => {
  const h = setup()
  h.world.createFailures = [untrusted()]
  await submitNamed(h, 'nope')
  await press('Escape')
  expect(dialogTitles()).toEqual(['New workspace'])
  expect(h.callsTo('quirky.worktree/create').length).toBe(1)
  expect(h.toasts).toEqual([])
  expect(rowOf('nope', 'api')).toBeUndefined()
})

test('any other create failure toasts and keeps the dialog open', async () => {
  const h = setup()
  h.world.createFailures = [new RpcLike('Branch "x" was not found.', RpcErrorCode.InvalidParams, { reason: 'x' })]
  await submitNamed(h, 'broken')
  expect(h.toasts).toEqual([{ title: 'Could not create worktree', body: 'Branch "x" was not found.' }])
  expect(dialogTitles()).toEqual(['New workspace'])
  expect(h.opened).toEqual([])
})

test('a setup-decision-required refusal opens the setup choice instead of a toast, and the answer goes with the retry', async () => {
  const h = setup()
  h.world.createFailures = [new RpcLike('Setup decision required', RpcErrorCode.Conflict, { reason: 'setup-decision-required', repo: 'r1' })]
  await submitNamed(h, 'branchy')
  expect(h.toasts).toEqual([])
  expect(dialogTitles()).toEqual(['New workspace'])
  const create = () => document.querySelector('[role="dialog"] button[type="submit"]') as HTMLButtonElement
  expect(dialogButton('Run setup now')).toBeDefined()
  expect(create().disabled).toBe(true)

  await click(dialogButton('Skip for now'))
  expect(create().disabled).toBe(false)
  await act(async () => void create().click())
  expect(h.callsTo('quirky.worktree/create')).toEqual([
    { repo: 'r1', name: 'branchy', createdBy: 'window' },
    { repo: 'r1', name: 'branchy', createdBy: 'window', setup: 'skip' }
  ])
  expect(dialogTitles()).toEqual([])
})

test('SC-20: a base fallback is shown in its own dialog with Got it', async () => {
  const h = setup()
  h.world.createExtra = { baseFallback: { requestedRef: 'origin/main', localRef: 'main', message: 'used local main' } }
  await submitNamed(h, 'offline')
  expect(dialogTitles()).toEqual(['Workspace created from a local base'])
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('used local main')
  expect(lastReport(h).dialog).toEqual({ kind: 'base-fallback', worktreeId: 'w9' })
  await click(dialogButton('Got it'))
  expect(dialogTitles()).toEqual([])
})

test('SC-42: Update saves the display name and notes through set', async () => {
  const h = setup()
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Update…'))
  await typeInto(dialogField('Display Name')!, ' Login fix ')
  await act(async () => {
    const notes = dialogField('Notes') as unknown as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'some notes')
    notes.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(dialogButton('Save'))
  expect(h.callsTo('quirky.worktree/set')).toEqual([{ worktree: 'w2', displayName: 'Login fix', comment: 'some notes' }])
  expect(dialogTitles()).toEqual([])
})

test('SC-41: Set Parent offers the other workspaces, not the workspace or its descendants', async () => {
  const h = setup()
  h.world.worktrees.push(wt('w4', 'r1', 'child', { parentId: 'w2' }), wt('w5', 'r1', 'docs'))
  await h.mountInto(host)
  await contextMenu(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  await click(itemNamed('Set Parent Worktree…'))
  const select = dialogField('Parent worktree') as unknown as HTMLSelectElement
  expect([...select.options].map((o) => o.textContent)).toEqual(['main · api · main', 'main · web · main', 'docs · api · docs'])
  await act(async () => {
    select.value = 'w5'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(dialogButton('Save'))
  expect(h.callsTo('quirky.worktree/set')).toEqual([{ worktree: 'w2', parent: 'w5' }])
})

test('SC-62: the new-worktree command rejects a project that does not resolve', async () => {
  const h = setup()
  await h.mountInto(host)
  await expect((async () => h.runCommand({ repo: 'nope' }))()).rejects.toThrow('no project matches nope')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('SC-62: a command that arrives before the section mounts opens the dialog once it does', async () => {
  const h = setup()
  await h.runCommand({ repo: 'web' })
  await h.mountInto(host)
  expect(lastReport(h).dialog).toEqual({ kind: 'create', repoId: 'r2' })
})

test('unmounting removes the listeners and the markup', async () => {
  const h = setup()
  const unmount = await h.mountInto(host)
  expect(h.listenerCount()).toBeGreaterThan(0)
  await unmount()
  expect(h.listenerCount()).toBe(0)
  expect(host.innerHTML).toBe('')
})

describe('agent status glyphs', () => {
  const MIN = 60_000
  const summary = (display: AgentDisplayState, label: string, over: Partial<AgentStatusSummary> = {}): AgentStatusSummary => ({
    state: display === 'done' || display === 'failed' || display === 'interrupted' ? 'done' : 'working',
    display,
    label,
    detail: '',
    progress: null,
    stateStartedAt: Date.now(),
    evidenceAt: Date.now(),
    restoredUnconfirmed: false,
    ...over
  })
  const withSummary = (id: string, display: AgentDisplayState, label: string, over: Partial<AgentStatusSummary> = {}): Session => ({
    ...session(id, 'w2', 'working'),
    agentStatus: summary(display, label, over)
  })
  const glyph = () => rowOf('fix-login', 'api').querySelector('.glyph') as HTMLElement | null

  const states: [AgentDisplayState, string][] = [
    ['working', 'Working'],
    ['monitoring', 'Monitoring background tasks'],
    ['waiting', 'Waiting for input'],
    ['permission', 'Needs attention'],
    ['blocked', 'Blocked'],
    ['failed', 'Failed'],
    ['interrupted', 'Interrupted'],
    ['done', 'Done'],
    ['unverifiable', 'No recent update'],
    ['idle', 'Idle'],
    ['unconfirmed', "Couldn't confirm"]
  ]
  for (const [display, label] of states) {
    test(`${display} draws glyph-${display} with the label "${label}"`, async () => {
      const h = setup()
      h.world.sessions = [withSummary('s1', display, label)]
      await h.mountInto(host)
      expect(glyph()!.className).toBe(`glyph glyph-${display}`)
      expect(glyph()!.getAttribute('title')).toBe(label)
      expect(glyph()!.getAttribute('aria-label')).toBe(label)
      expect(rowOf('fix-login', 'api').querySelector('.dot')).toBeNull()
      expect(lastReport(h).projects[0].worktrees[1]).toMatchObject({ status: 'working', display, label })
    })
  }

  test('SC-35: the card follows its most urgent session as they change', async () => {
    const h = setup()
    h.world.sessions = [withSummary('s1', 'waiting', 'Waiting for input'), withSummary('s2', 'working', 'Working')]
    await h.mountInto(host)
    expect(glyph()!.className).toBe('glyph glyph-waiting')
    await h.emit({ type: 'quirky.session/changed', data: { session: withSummary('s1', 'done', 'Done') } })
    expect(glyph()!.className).toBe('glyph glyph-working')
    await h.emit({ type: 'quirky.session/changed', data: { session: withSummary('s2', 'done', 'Done') } })
    expect(glyph()!.className).toBe('glyph glyph-done')
    expect(lastReport(h).projects[0].worktrees[1].display).toBe('done')
  })

  test('a session with no summary keeps the coarse dot', async () => {
    const h = setup()
    await h.mountInto(host)
    expect(glyph()).toBeNull()
    expect(rowOf('fix-login', 'api').querySelector('.dot-working')).not.toBeNull()
    expect(lastReport(h).projects[0].worktrees[1]).not.toHaveProperty('display')
  })

  test('SC-36: progress shows a ring on live states only', async () => {
    const h = setup()
    h.world.sessions = [withSummary('s1', 'working', 'Working', { progress: 60 })]
    await h.mountInto(host)
    expect(glyph()!.className).toBe('glyph glyph-working glyph-ring')
    expect(glyph()!.style.getPropertyValue('--progress')).toBe('60%')
    await h.emit({ type: 'quirky.session/changed', data: { session: withSummary('s1', 'done', 'Done', { progress: 100 }) } })
    expect(glyph()!.className).toBe('glyph glyph-done')
  })

  test('an unfinished state with no evidence for 30 minutes decays, and a done one does not', async () => {
    const h = setup()
    h.world.sessions = [withSummary('s1', 'working', 'Working', { evidenceAt: Date.now() - 31 * MIN })]
    await h.mountInto(host)
    expect(glyph()!.className).toBe('glyph glyph-unverifiable')
    expect(glyph()!.getAttribute('title')).toBe('No recent update')
    await h.emit({ type: 'quirky.session/changed', data: { session: withSummary('s1', 'done', 'Done', { evidenceAt: Date.now() - 90 * MIN }) } })
    expect(glyph()!.className).toBe('glyph glyph-done')
  })

  test('a one-minute tick shows decay and updates the report with no event', async () => {
    const realNow = Date.now
    const realSetInterval = globalThis.setInterval
    const ticks: (() => void)[] = []
    globalThis.setInterval = ((callback: () => void, ms?: number) => {
      if (ms === MIN) {
        ticks.push(callback)
        return 0
      }
      return realSetInterval(callback, ms)
    }) as typeof setInterval
    try {
      const t0 = realNow()
      const h = setup()
      h.world.sessions = [withSummary('s1', 'working', 'Working', { evidenceAt: t0 - 29 * MIN })]
      await h.mountInto(host)
      expect(glyph()!.className).toBe('glyph glyph-working')
      Date.now = () => t0 + 2 * MIN
      await act(async () => ticks.forEach((tick) => tick()))
      expect(glyph()!.className).toBe('glyph glyph-unverifiable')
      expect(lastReport(h).projects[0].worktrees[1].display).toBe('unverifiable')
    } finally {
      Date.now = realNow
      globalThis.setInterval = realSetInterval
    }
  })
})
test('stock worktree controls persist options, reveal sleeping rows and wake without replacing the session', async () => {
  const h = setup()
  h.world.options = { groupBy: 'status', sortBy: 'name', compact: false, showBranch: true, showComment: true, showSleeping: false }
  h.world.worktrees[1] = { ...h.world.worktrees[1]!, comment: 'keep this note', sleeping: true } as Worktree
  const unmount = await h.mountInto(host)

  expect([...host.querySelectorAll('li.worktree .worktree-name')].map((node) => node.textContent)).not.toContain('fix-login')
  await click(host.querySelector('button[aria-label="Workspace options"]')!)
  const group = host.querySelector('select[aria-label="Group by"]') as HTMLSelectElement
  await act(async () => {
    group.value = 'none'
    group.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const sort = host.querySelector('select[aria-label="Sort by"]') as HTMLSelectElement
  await act(async () => {
    sort.value = 'manual'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
  })

  const reveal = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Show 1 hidden sleeping worktree')!
  await click(reveal)
  expect([...host.querySelectorAll('li.worktree .worktree-name')].map((node) => node.textContent)).toContain('fix-login')
  expect(rowOf('fix-login', 'api').querySelector('.worktree-branch')?.textContent).toBe('fix-login')
  expect(rowOf('fix-login', 'api').querySelector('.worktree-comment')?.textContent).toBe('keep this note')
  await click(host.querySelector('input[aria-label="Compact cards"]')!)
  await click(host.querySelector('input[aria-label="Show branch"]')!)
  await click(host.querySelector('input[aria-label="Show comment"]')!)
  expect(rowOf('fix-login', 'api').querySelector('.worktree-branch')).toBeNull()
  expect(rowOf('fix-login', 'api').querySelector('.worktree-comment')).toBeNull()
  await contextMenu(rowOf('fix-login', 'api'))
  expect(itemLabels()).toContain('Wake')
  await click(itemNamed('Wake'))
  await contextMenu(rowOf('fix-login', 'api'))
  expect(itemLabels()).toContain('Sleep')
  expect(itemLabels()).not.toContain('Wake')
  await unmount()
})

test('cleanup review prevents blocked selection and supports ignoring and restoring suggestions', async () => {
  const h = setup()
  const unmount = await h.mountInto(host)
  await click([...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Review cleanup')!)

  const dialog = document.querySelector('[role="dialog"]') as HTMLElement
  expect(dialog.textContent).toContain('Primary worktrees cannot be deleted.')
  expect(dialog.textContent).toContain('fix-login')
  await click([...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Ignore fix-login')!)
  expect((dialog.querySelector('input[aria-label="Select fix-login"]') as HTMLInputElement).disabled).toBe(true)
  await click([...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Restore ignored suggestions')!)
  expect((dialog.querySelector('input[aria-label="Select fix-login"]') as HTMLInputElement).disabled).toBe(false)

  expect((dialog.querySelector('input[aria-label="Select main"]') as HTMLInputElement).disabled).toBe(true)
  expect([...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Delete selected')!.disabled).toBe(true)
  await unmount()
})

test('Escape dismisses cleanup review and leaves the workspace available', async () => {
  const h = setup()
  const unmount = await h.mountInto(host)
  await click([...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Review cleanup')!)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(rowOf('fix-login', 'api').textContent).toContain('fix-login')
  await unmount()
})
