import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root, createRoot as ReactCreateRoot } from 'react-dom/client'
import type { Repo, Session, TerminalTabCounts, Worktree } from '@quirky/protocol'
import type { MobilePageBridge, MobileRoute } from '../src/contracts'
import { validatePageRpc, WORKSPACE_PAGE_GRANTS } from '../src/shell/bridge-policy'
import { WorkspacesPage } from '../src/pages/WorkspacesPage'

const repo: Repo = {
  id: 'repo-counts', name: 'project', path: '/repos/project', addedAt: 1, kind: 'git', displayName: null, groupId: null
}

function worktree(id: string, name: string): Worktree {
  return {
    id, repoId: repo.id, path: `/workspaces/${name}`, branch: name, head: 'deadbeef', isMain: false, name, kind: 'git',
    displayName: null, comment: '', status: 'in-progress', pinned: false, unread: false, parentId: null, createdAt: 1,
    createdBy: 'api', baseRef: null, keepBranch: false, removing: false, groupId: null, projectGroupId: null, lastActivityAt: 1,
    instanceId: `${id}-instance`
  }
}

function session(id: string, worktreeId: string): Session {
  return {
    id, kind: 'terminal', agent: 'shell', worktreeId, cwd: `/workspaces/${worktreeId}`, title: id, status: 'running',
    createdAt: 1, lastActivityAt: 1, exitCode: null, exitSignal: null, exitCause: null, restorable: false
  }
}

function bridgeFor(options: {
  worktrees: Worktree[]
  sessions: Session[]
  tabCounts?: unknown
  tabCountProvider?: () => Promise<unknown>
  failTabCounts?: boolean
}) {
  const navigations: MobileRoute[] = []
  const state: MobilePageBridge['state'] = { phase: 'connected', attempts: 0 }
  const preferences = {
    sessionView: 'terminal' as const, onboardingCompleted: true, notificationChoice: 'disabled' as const,
    terminalTextScale: 1 as const, autocomplete: false, terminalLinkMode: 'phone' as const, shortcuts: []
  }
  const bridge = {
    init: {
      v: 1,
      sessionId: 'workspace-count-page',
      host: { id: 'host-counts', name: 'Desk', endpoint: 'wss://desk.invalid/rpc', publicKeyB64: 'public-key', lastConnected: 1 },
      route: { kind: 'workspaces' as const },
      grants: ['rpc', 'terminal'],
      preferences,
      connectionState: state,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 }
    },
    state,
    async call<T>(method: string): Promise<T> {
      switch (method) {
        case 'quirky.repo/list': return [repo] as T
        case 'quirky.repo/groupList': return [] as T
        case 'quirky.worktree/list': return options.worktrees as T
        case 'quirky.session/list': return options.sessions as T
        case 'quirky.worktree/origins': return [] as T
        case 'quirky.session/workspaceSleepStates': return [] as T
        case 'quirky.loops/summaries': return [] as T
        case 'quirky.terminal/tabCounts':
          if (options.failTabCounts) throw new Error('tab count method is unavailable')
          if (options.tabCountProvider) return await options.tabCountProvider() as T
          return options.tabCounts as T
      }
    },
    onEvent: () => () => {},
    onStream: () => () => {},
    onState: () => () => {},
    storage: { async get() { return null }, async set() {}, async remove() {} },
    native: { async clipboardRead() { return '' }, async clipboardWrite() {}, async openExternal() {}, async haptic() {} },
    async navigate(route: MobileRoute) { navigations.push(route) },
    report() {},
    close() {}
  } as unknown as MobilePageBridge
  return { bridge, navigations }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let createRoot: typeof ReactCreateRoot

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function renderPage(bridge: MobilePageBridge, connected = true): Promise<void> {
  await act(async () => {
    root!.render(createElement(WorkspacesPage, {
      bridge, connected, onNavigate: (route) => bridge.navigate(route), onReport() {}
    }))
    await Promise.resolve()
  })
}

async function mountPage(bridge: MobilePageBridge): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await renderPage(bridge)
}

function buttonNamed(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label)
  if (!button) throw new Error(`No button named ${label}`)
  return button
}

async function waitForButton(label: string): Promise<HTMLButtonElement> {
  const until = Date.now() + 2000
  while (Date.now() < until) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label)
    if (button) return button
    await act(async () => { await Bun.sleep(5) })
  }
  throw new Error(`No button named ${label}`)
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

async function waitForNavigation(navigations: MobileRoute[], worktreeId: string): Promise<void> {
  const until = Date.now() + 2000
  while (Date.now() < until) {
    if (navigations.some((route) => route.kind === 'session' && route.worktreeId === worktreeId)) return
    await act(async () => { await Bun.sleep(5) })
  }
  throw new Error(`Workspace ${worktreeId} did not open`)
}


test('workspace Open uses actual layout count and treats an omitted ID as zero', async () => {
  const actual = worktree('wt-actual', 'actual')
  const empty = worktree('wt-empty', 'empty')
  const fixture = bridgeFor({
    worktrees: [actual, empty],
    sessions: [session('session-one', actual.id), session('session-two', actual.id)],
    tabCounts: { counts: [{ worktreeId: actual.id, tabCount: 3 }], unavailableWorktrees: [] } satisfies TerminalTabCounts
  })
  await mountPage(fixture.bridge)

  const actualButton = await waitForButton('Open actual')
  const emptyButton = await waitForButton('Open empty')
  expect(actualButton.textContent).toContain('3 tabs')
  expect(emptyButton.textContent).toContain('0 tabs')

  await click(actualButton)
  await waitForNavigation(fixture.navigations, actual.id)
})

test('unreadable layouts omit only their count while other workspaces remain counted', async () => {
  const available = worktree('wt-available', 'available')
  const unreadable = worktree('wt-unreadable', 'unreadable')
  const fixture = bridgeFor({
    worktrees: [available, unreadable],
    sessions: [session('session-1', unreadable.id), session('session-2', unreadable.id)],
    tabCounts: { counts: [{ worktreeId: available.id, tabCount: 2 }], unavailableWorktrees: [unreadable.id] } satisfies TerminalTabCounts
  })
  await mountPage(fixture.bridge)

  expect((await waitForButton('Open available')).textContent).toContain('2 tabs')
  const unreadableButton = await waitForButton('Open unreadable')
  expect(unreadableButton.textContent).not.toMatch(/\d+ tabs?\b/)
  expect(unreadableButton.disabled).toBe(false)
  expect(container?.textContent).toContain('Stale')

  await click(unreadableButton)
  await waitForNavigation(fixture.navigations, unreadable.id)
})

test('failed or malformed tab counts never replace the session count guess', async () => {
  const item = worktree('wt-duplicate', 'duplicate')
  const worktrees = [item]
  const sessions = [session('s1', item.id), session('s2', item.id), session('s3', item.id)]
  const snapshots: Array<{ tabCounts?: unknown; failTabCounts?: boolean }> = [
    { failTabCounts: true },
    { tabCounts: { counts: [
      { worktreeId: item.id, tabCount: 1 }, { worktreeId: item.id, tabCount: 4 }
    ], unavailableWorktrees: [] } },
    { tabCounts: { counts: [{ worktreeId: item.id, tabCount: -1 }], unavailableWorktrees: [] } },
    { tabCounts: { counts: [{ worktreeId: item.id, tabCount: Number.MAX_SAFE_INTEGER + 1 }], unavailableWorktrees: [] } },
    { tabCounts: { counts: [{ worktreeId: item.id, tabCount: 2 }], unavailableWorktrees: [item.id] } }
  ]

  for (const snapshot of snapshots) {
    const fixture = bridgeFor({ worktrees, sessions, ...snapshot })
    await mountPage(fixture.bridge)
    const openButton = await waitForButton('Open duplicate')
    expect(openButton.textContent).not.toMatch(/\d+ tabs?\b/)
    expect(openButton.disabled).toBe(false)
    expect(container?.textContent).toContain('Stale')
    await click(openButton)
    await waitForNavigation(fixture.navigations, item.id)
    if (root) await act(async () => root?.unmount())
    root = null
    container?.remove()
    container = null
  }
})
test('an older tab count response cannot replace the current workspace load', async () => {
  const item = worktree('wt-generation', 'generation')
  const pending = Promise.withResolvers<unknown>()
  let countRequests = 0
  const fixture = bridgeFor({
    worktrees: [item],
    sessions: [],
    tabCountProvider: () => {
      countRequests += 1
      return countRequests === 1
        ? pending.promise
        : Promise.resolve({ counts: [{ worktreeId: item.id, tabCount: 2 }], unavailableWorktrees: [] })
    }
  })
  await mountPage(fixture.bridge)

  await renderPage(fixture.bridge, false)
  await renderPage(fixture.bridge, true)
  const openButton = await waitForButton('Open generation')
  expect(openButton.textContent).toContain('2 tabs')

  await act(async () => {
    pending.resolve({ counts: [{ worktreeId: item.id, tabCount: 9 }], unavailableWorktrees: [] })
    await pending.promise
    await Promise.resolve()
  })
  expect(buttonNamed('Open generation').textContent).toContain('2 tabs')
  expect(buttonNamed('Open generation').textContent).not.toContain('9 tabs')
})

test('tabCounts rejects widened params, missing grants, and unrelated routes', () => {
  const method = 'quirky.terminal/tabCounts'
  const workspaceRoute = { kind: 'workspaces' } as const
  const sessionRoute = { kind: 'session', worktreeId: 'wt-1' } as const
  const panelRoute = { kind: 'files', worktreeId: 'wt-1' } as const
  const artifactRoute = { kind: 'terminal-artifacts', worktreeId: 'wt-1', sessionId: 'session-1' } as const

  expect(() => validatePageRpc(method, { worktree: 'wt-1' }, WORKSPACE_PAGE_GRANTS, workspaceRoute)).toThrow()
  expect(() => validatePageRpc(method, {}, [], workspaceRoute)).toThrow(/rpc grant/i)
  expect(() => validatePageRpc(method, {}, ['rpc'], workspaceRoute)).toThrow(/terminal grant/i)
  expect(() => validatePageRpc(method, {}, WORKSPACE_PAGE_GRANTS, sessionRoute)).toThrow()
  expect(() => validatePageRpc(method, {}, WORKSPACE_PAGE_GRANTS, panelRoute)).toThrow()
  expect(() => validatePageRpc(method, {}, WORKSPACE_PAGE_GRANTS, artifactRoute)).toThrow()
})
