import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { QuirkyEvent, Repo, Session, UiLayout, UiPluginContext, Worktree } from '@quirky/protocol'
import { RpcErrorCode } from '@quirky/protocol'

const SLOT = 'sidebar-section:quirky.worktree/worktrees'
const SESSION_VIEW = 'view:quirky.session/worktree'

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
  groupId: null
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

const wt = (id: string, repoId: string, name: string, isMain = false): Worktree => ({
  id,
  repoId,
  path: `/w/${name}`,
  branch: name,
  head: 'abc',
  isMain,
  name,
  ...WORKTREE_DEFAULTS
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
  exitCode: null
})

class RpcLike extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message)
  }
}

type World = {
  repos: Repo[]
  worktrees: Worktree[]
  sessions: Session[] | null
  confirms: boolean[]
  failRemove: (Error | null)[]
}

function setup(layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }) {
  const world: World = {
    repos: [...repos],
    worktrees: [wt('w1', 'r1', 'main', true), wt('w2', 'r1', 'fix-login'), wt('w3', 'r2', 'main', true)],
    sessions: [session('s1', 'w2', 'working')],
    confirms: [],
    failRemove: []
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
        case 'quirky.worktree/list':
          return [...world.worktrees]
        case 'quirky.session/list':
          if (world.sessions === null) throw new RpcLike('method not found', RpcErrorCode.MethodNotFound)
          return world.sessions
        case 'quirky.worktree/remove': {
          const failure = world.failRemove.shift()
          if (failure) throw failure
          return { ok: true }
        }
        case 'quirky.worktree/create':
          return wt('w9', String(params.repo), String(params.name))
        case 'quirky.repo/add':
          return repos[0]
        default:
          throw new Error(`unexpected call ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    getSetting: () => undefined,
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
beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.append(host)
})

const lastReport = (h: ReturnType<typeof setup>) => h.reports[h.reports.length - 1] as { repos: any[] }
const rowOf = (name: string, repoName: string) =>
  Array.from(
    [...host.querySelectorAll('section.repo')]
      .find((s) => s.querySelector('.repo-name')?.textContent === repoName)!
      .querySelectorAll('li.worktree')
  ).find((li) => li.querySelector('.worktree-name')?.textContent === name) as HTMLElement
const click = (element: Element) => act(async () => void (element as HTMLElement).click())

test('the module provides the declared sidebar slot', () => {
  const h = setup()
  expect([...h.provided.keys()]).toEqual([SLOT])
})

test('SC-35: renders repos and worktrees and reports them with status and selection', async () => {
  const h = setup({ view: { id: SESSION_VIEW, input: { worktree: 'w2' } }, panel: null, sidebar: true, focus: 'view' })
  await h.mountInto(host)
  expect([...host.querySelectorAll('.repo-name')].map((e) => e.textContent)).toEqual(['api', 'web'])
  expect(rowOf('fix-login', 'api').className).toContain('selected')
  expect(rowOf('main', 'api').className).not.toContain('selected')
  expect(lastReport(h)).toEqual({
    repos: [
      {
        id: 'r1',
        name: 'api',
        worktrees: [
          { id: 'w1', name: 'main', branch: 'main', status: null, selected: false },
          { id: 'w2', name: 'fix-login', branch: 'fix-login', status: 'working', selected: true }
        ]
      },
      { id: 'r2', name: 'web', worktrees: [{ id: 'w3', name: 'main', branch: 'main', status: null, selected: false }] }
    ]
  })
  expect(rowOf('fix-login', 'api').querySelector('.dot-working')).not.toBeNull()
})

test('shows the empty message with no repositories', async () => {
  const h = setup()
  h.world.repos = []
  await h.mountInto(host)
  expect(host.textContent).toContain('No repositories yet.')
  expect(lastReport(h)).toEqual({ repos: [] })
})

test('SC-36: the selected row follows the open view input', async () => {
  const h = setup()
  await h.mountInto(host)
  expect(host.querySelector('li.worktree.selected')).toBeNull()
  await h.setLayout({ view: { id: SESSION_VIEW, input: { worktree: 'w3' } }, panel: null, sidebar: true, focus: null })
  expect(rowOf('main', 'web').className).toContain('selected')
  expect(lastReport(h).repos[1].worktrees[0].selected).toBe(true)
  await h.setLayout({ view: null, panel: null, sidebar: true, focus: null })
  expect(host.querySelector('li.worktree.selected')).toBeNull()
})

test('SC-37: clicking a worktree opens the session view on it', async () => {
  const h = setup()
  await h.mountInto(host)
  await click(rowOf('fix-login', 'api').querySelector('.worktree-main')!)
  expect(h.opened).toEqual([{ id: SESSION_VIEW, input: { worktree: 'w2' } }])
})

test('shows no status dots and reports null statuses when quirky.session is off', async () => {
  const h = setup()
  h.world.sessions = null
  await h.mountInto(host)
  expect(host.querySelector('.dot-working')).toBeNull()
  expect(host.querySelectorAll('.dot-none').length).toBe(3)
  expect(lastReport(h).repos[0].worktrees[1].status).toBeNull()
})

test('status follows the session events', async () => {
  const h = setup()
  await h.mountInto(host)
  await h.emit({ type: 'quirky.session/changed', data: { session: session('s1', 'w2', 'waiting') } })
  expect(rowOf('fix-login', 'api').querySelector('.dot-waiting')).not.toBeNull()
  await h.emit({ type: 'quirky.session/changed', data: { session: session('s2', 'w1', 'done') } })
  expect(lastReport(h).repos[0].worktrees[0].status).toBe('done')
  await h.emit({ type: 'quirky.session/removed', data: { sessionId: 's1' } })
  expect(lastReport(h).repos[0].worktrees[1].status).toBeNull()
})

test('refreshes the tree on repo and worktree changes', async () => {
  const h = setup()
  await h.mountInto(host)
  h.world.worktrees.push(wt('w4', 'r2', 'feature-x'))
  await h.emit({ type: 'quirky.worktree/changed', data: { repoId: 'r2' } })
  expect(rowOf('feature-x', 'web')).not.toBeUndefined()
  h.world.repos.push({ id: 'r3', name: 'docs', path: '/r/docs', addedAt: 0, ...REPO_DEFAULTS })
  await h.emit({ type: 'quirky.repo/changed', data: {} })
  expect([...host.querySelectorAll('.repo-name')].map((e) => e.textContent)).toEqual(['api', 'web', 'docs'])
  expect(lastReport(h).repos.length).toBe(3)
})

test('does not report again when nothing changed', async () => {
  const h = setup()
  await h.mountInto(host)
  const before = h.reports.length
  await h.emit({ type: 'quirky.worktree/changed', data: { repoId: 'r1' } })
  expect(h.reports.length).toBe(before)
})

test('the main worktree has no remove button', async () => {
  const h = setup()
  await h.mountInto(host)
  expect(rowOf('main', 'api').querySelector('button[aria-label^="Remove worktree"]')).toBeNull()
  expect(rowOf('fix-login', 'api').querySelector('button[aria-label="Remove worktree fix-login"]')).not.toBeNull()
})

test('SC-47: removing asks in the window and passes yes with no ask card', async () => {
  const h = setup()
  await h.mountInto(host)
  await click(rowOf('fix-login', 'api').querySelector('button[aria-label^="Remove worktree"]')!)
  expect(h.confirmed.length).toBe(1)
  expect(h.confirmed[0]!.body).toContain('/w/fix-login')
  const removes = h.calls.filter((c) => c.method === 'quirky.worktree/remove')
  expect(removes).toEqual([{ method: 'quirky.worktree/remove', params: { worktree: 'w2', yes: true } }])
  expect(h.calls.some((c) => c.method.startsWith('quirky.ask/'))).toBe(false)
})

test('a declined confirm removes nothing', async () => {
  const h = setup()
  h.world.confirms = [false]
  await h.mountInto(host)
  await click(rowOf('fix-login', 'api').querySelector('button[aria-label^="Remove worktree"]')!)
  expect(h.calls.some((c) => c.method === 'quirky.worktree/remove')).toBe(false)
})

test('a Conflict offers a force remove and retries with force', async () => {
  const h = setup()
  h.world.failRemove = [new RpcLike('could not remove fix-login: has changes', RpcErrorCode.Conflict)]
  await h.mountInto(host)
  await click(rowOf('fix-login', 'api').querySelector('button[aria-label^="Remove worktree"]')!)
  expect(h.confirmed.length).toBe(2)
  expect(h.confirmed[1]!.body).toContain('could not remove fix-login: has changes')
  const removes = h.calls.filter((c) => c.method === 'quirky.worktree/remove').map((c) => c.params)
  expect(removes).toEqual([
    { worktree: 'w2', yes: true },
    { worktree: 'w2', yes: true, force: true }
  ])
})

test('a declined force confirm stops after the first attempt', async () => {
  const h = setup()
  h.world.failRemove = [new RpcLike('dirty', RpcErrorCode.Conflict)]
  h.world.confirms = [true, false]
  await h.mountInto(host)
  await click(rowOf('fix-login', 'api').querySelector('button[aria-label^="Remove worktree"]')!)
  expect(h.calls.filter((c) => c.method === 'quirky.worktree/remove').length).toBe(1)
})

test('any other remove failure becomes a toast', async () => {
  const h = setup()
  h.world.failRemove = [new RpcLike('boom', RpcErrorCode.Internal)]
  await h.mountInto(host)
  await click(rowOf('fix-login', 'api').querySelector('button[aria-label^="Remove worktree"]')!)
  expect(h.toasts).toEqual([{ title: 'Could not remove worktree', body: 'boom' }])
  expect(h.confirmed.length).toBe(1)
})

test('the add-repo form adds the trimmed path', async () => {
  const h = setup()
  await h.mountInto(host)
  const input = host.querySelector('form.add-repo input') as HTMLInputElement
  const submit = host.querySelector('form.add-repo button[type="submit"]') as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, '  /r/new  ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(submit)
  expect(h.calls.filter((c) => c.method === 'quirky.repo/add')).toEqual([
    { method: 'quirky.repo/add', params: { path: '/r/new' } }
  ])
})

test('the new-worktree dialog creates a worktree and opens it', async () => {
  const h = setup()
  await h.mountInto(host)
  await click(host.querySelector('button[aria-label="New worktree in api"]')!)
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe('New worktree in api')
  const [name, base] = [...dialog.querySelectorAll('input')] as HTMLInputElement[]
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(name, ' feature-y ')
    name!.dispatchEvent(new Event('input', { bubbles: true }))
    setter.call(base, 'main')
    base!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => void (dialog.querySelector('button[type="submit"]') as HTMLButtonElement).click())
  expect(h.calls.filter((c) => c.method === 'quirky.worktree/create')).toEqual([
    { method: 'quirky.worktree/create', params: { repo: 'r1', name: 'feature-y', baseRef: 'main' } }
  ])
  expect(h.opened).toEqual([{ id: SESSION_VIEW, input: { worktree: 'w9' } }])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('unmounting removes the listeners and the markup', async () => {
  const h = setup()
  const unmount = await h.mountInto(host)
  expect(h.listenerCount()).toBeGreaterThan(0)
  await unmount()
  expect(h.listenerCount()).toBe(0)
  expect(host.innerHTML).toBe('')
})
