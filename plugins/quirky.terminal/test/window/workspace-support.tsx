import { act } from 'react'
import { RpcError, RpcErrorCode, type Session } from '@quirky/protocol'
import * as ops from '../../src/layout/ops'
import { sequentialIds } from '../../src/layout/tree'
import { isTerminalTab } from '../../src/layout/types'
import type { Group, GroupNode, PaneLeaf, PaneNode, Tab, TerminalTab, Workspace } from '../../src/layout/types'
import { fakeContext, paneHandlers, settle, type FakeContext } from '../ui-fake'
import { loadPane, startRecording, stopRecording, terminals, unloadPane } from './pane-support'

type Handler = (params: Record<string, any>) => unknown
type WorkspaceModule = typeof import('../../src/window/workspace')

export { fakeContext, settle, terminals, startRecording, stopRecording }
export type { FakeContext }

let workspace: WorkspaceModule
let restoreRect: (() => void) | null = null
const rects = new WeakMap<Element, { left: number; top: number; width: number; height: number }>()

/** The size every measured workspace container reports, since happy-dom does no layout. */
export const AREA = { width: 1000, height: 600 }

/** Registers happy-dom and loads the pane and the workspace after it, since xterm reads `window` when imported. */
export async function loadWorkspace(): Promise<WorkspaceModule> {
  await loadPane()
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const own = rects.get(this)
    const measured = own ?? (/\bqt-(panes|groups|body)\b/.test(this.getAttribute('class') ?? '') ? { left: 0, top: 0, ...AREA } : null)
    if (!measured) return original.call(this)
    return { ...measured, x: measured.left, y: measured.top, right: measured.left + measured.width, bottom: measured.top + measured.height, toJSON: () => ({}) } as DOMRect
  }
  restoreRect = () => {
    Element.prototype.getBoundingClientRect = original
  }
  workspace = await import('../../src/window/workspace')
  return workspace
}

export async function unloadWorkspace(): Promise<void> {
  restoreRect?.()
  restoreRect = null
  await unloadPane()
}

/** Gives an element a fixed bounding box, for tests that drag across it. */
export function setRect(element: Element, rect: { left: number; top: number; width: number; height: number }): void {
  rects.set(element, rect)
}

// ---- fixtures

export const WORKTREE = 'wt-main'

export function pane(id: string, session: string, over: Partial<PaneLeaf> = {}): PaneLeaf {
  return { kind: 'pane', id, session, title: null, exit: null, ...over }
}

export function paneSplit(id: string, direction: 'right' | 'down', first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode {
  return { kind: 'split', id, direction, ratio, first, second }
}

export function tab(id: string, root: PaneNode, over: Partial<TerminalTab> = {}): TerminalTab {
  const first = root.kind === 'pane' ? root.id : firstLeaf(root)
  return {
    id,
    defaultTitle: `Tab ${id}`,
    customTitle: null,
    liveTitle: null,
    color: 'none',
    pinned: false,
    root,
    activePane: first,
    expandedPane: null,
    createdAt: '2026-10-26T00:00:00.000Z',
    ...over
  }
}

function firstLeaf(node: PaneNode): string {
  return node.kind === 'pane' ? node.id : firstLeaf(node.first)
}

export function group(id: string, tabs: Tab[], over: Partial<Group> = {}): Group {
  return { kind: 'group', id, tabs, activeTab: tabs[0]?.id ?? null, recent: tabs.map((entry) => entry.id), lastQuickCommand: null, ...over }
}

export function groupSplit(id: string, direction: 'right' | 'down', first: GroupNode, second: GroupNode, ratio = 0.5): GroupNode {
  return { kind: 'split', id, direction, ratio, first, second }
}

export function makeWorkspace(root: GroupNode, over: Partial<Workspace> = {}): Workspace {
  const first = (node: GroupNode): string => (node.kind === 'group' ? node.id : first(node.first))
  return { id: WORKTREE, revision: 5, root, activeGroup: first(root), closed: [], ...over }
}

/** One group with a single tab "Terminal 1" on pane-1 (session s-1). */
export function simpleWorkspace(): Workspace {
  return makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' })]))
}

/**
 * The workspace of the spec's conceptual model: grp-1 holds "Terminal 1" (blue) and "Build"
 * (pane-2 | pane-3 over pane-4, pane-3 active), grp-2 holds "Hello"; pane-3 is focused.
 */
export function conceptualWorkspace(): Workspace {
  const build = tab('tab-2', paneSplit('split-2', 'right', pane('pane-2', 's-2'), paneSplit('split-3', 'down', pane('pane-3', 's-3'), pane('pane-4', 's-4'))), {
    defaultTitle: 'Terminal 2',
    customTitle: 'Build',
    activePane: 'pane-3'
  })
  const first = group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1', color: 'blue' }), build], { activeTab: 'tab-2', recent: ['tab-2', 'tab-1'] })
  const second = group('grp-2', [tab('tab-3', pane('pane-5', 's-5'), { defaultTitle: 'Hello' })])
  return makeWorkspace(groupSplit('split-1', 'right', first, second))
}

export function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    kind: 'terminal',
    agent: 'shell',
    worktreeId: WORKTREE,
    cwd: '/tmp/w/api',
    title: id,
    status: 'running',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false,
    ...over
  }
}

export function leavesOf(node: PaneNode): PaneLeaf[] {
  return node.kind === 'pane' ? [node] : [...leavesOf(node.first), ...leavesOf(node.second)]
}

export function allSessionIds(ws: Workspace): string[] {
  const groups = (node: GroupNode): Group[] => (node.kind === 'group' ? [node] : [...groups(node.first), ...groups(node.second)])
  return groups(ws.root).flatMap((entry) => entry.tabs.flatMap((candidate) => isTerminalTab(candidate) ? leavesOf(candidate.root).map((leaf) => leaf.session) : []))
}

// ---- fake daemon

const MUTATIONS = [
  'newTab', 'closeTab', 'closeTabs', 'renameTab', 'setTabColor', 'pinTab', 'moveTab', 'activateTab', 'reopenTab', 'splitPane',
  'closePane', 'restartPane', 'focusPane', 'setPaneTitle', 'expandPane', 'equalize', 'resizeSplit', 'movePane', 'closeGroup'
]

export type DaemonOptions = {
  sessions?: Session[]
  /** The answer of `describeClose`; a function sees its params. */
  describe?: string | null | ((params: Record<string, any>) => string | null)
  /** Replaces what a mutation does; the result is the workspace after it (revision is bumped afterwards). */
  transforms?: Record<string, (ws: Workspace, params: Record<string, any>) => Workspace>
  agents?: unknown
  replay?: string
}

const fakeIds = sequentialIds(500)

/** What each mutation does to the workspace, using the daemon's own operations; methods not listed leave it as it is. */
const OPERATIONS: Record<string, (ws: Workspace, params: Record<string, any>) => ops.OpResult> = {
  activateTab: (ws, p) => (p.tab ? ops.activateTab(ws, p.tab) : p.index ? ops.activateTabAt(ws, p.group, p.index) : ops.activateTabBy(ws, p.offset, p.order ?? 'position')),
  focusPane: (ws, p) => (p.pane ? ops.focusPaneOp(ws, p.pane) : ops.focusPaneBy(ws, p.tab, p.offset)),
  renameTab: (ws, p) => ops.renameTab(ws, p.tab, p.title),
  setTabColor: (ws, p) => ops.setTabColor(ws, p.tab, p.color),
  pinTab: (ws, p) => ops.pinTab(ws, p.tab, p.pinned),
  setPaneTitle: (ws, p) => ops.setPaneTitle(ws, p.pane, p.title),
  expandPane: (ws, p) => ops.expandPaneOp(ws, p.pane, p.expanded),
  equalize: (ws, p) => ops.equalizeTab(ws, p.tab),
  resizeSplit: (ws, p) => ops.resizeSplitOp(ws, p as ops.ResizeTarget),
  closeTab: (ws, p) => ops.removeTab(ws, p.tab, null),
  closePane: (ws, p) => ops.closePaneOp(ws, p.pane, null),
  closeGroup: (ws, p) => ops.closeGroupOp(ws, p.group),
  moveTab: (ws, p) => (p.split ? ops.moveTabToSplit(ws, p.tab, p.split, p.of, fakeIds) : ops.moveTabToGroup(ws, p.tab, p.group, p.index)),
  movePane: (ws, p) => (p.toTab ? ops.movePaneToTab(ws, p.pane, p.toTab, fakeIds) : ops.movePaneToPane(ws, p.pane, p.toPane, p.edge, fakeIds))
}

/**
 * The daemon methods a mounted workspace calls, over one workspace that mutations bump by one
 * revision, applying the daemon's own operation for the method (or `transforms[method]`). `workspace`
 * always answers the current one.
 */
export function fakeDaemon(initial: Workspace, options: DaemonOptions = {}) {
  const daemon = {
    current: initial,
    sessions: options.sessions ?? allSessionIds(initial).map((id) => session(id)),
    describe: options.describe ?? null,
    failures: new Map<string, RpcError>()
  }
  const handlers: Record<string, Handler> = {
    ...paneHandlers({ replay: options.replay }),
    'quirky.terminal/workspace': () => ({ workspace: daemon.current }),
    'quirky.terminal/describeClose': (params) => (typeof daemon.describe === 'function' ? daemon.describe(params) : daemon.describe),
    'quirky.terminal/setFloating': () => ({}),
    'quirky.session/list': () => daemon.sessions,
    'quirky.agents/list': () => options.agents ?? { defaultAgent: 'claude', agents: [] },
    'setting.set': () => ({}),
    'quirky.structured/create': () => ({})
  }
  for (const method of MUTATIONS) {
    handlers[`quirky.terminal/${method}`] = (params) => {
      const failure = daemon.failures.get(method)
      if (failure) throw failure
      let next = daemon.current
      const custom = options.transforms?.[method]
      if (custom) next = custom(daemon.current, params)
      else if (OPERATIONS[method]) {
        const result = OPERATIONS[method]!(daemon.current, params)
        if (!result.ok) throw new RpcError(result.error.kind === 'not-found' ? RpcErrorCode.NotFound : RpcErrorCode.InvalidParams, result.error.message)
        next = result.value
      }
      daemon.current = { ...next, revision: daemon.current.revision + 1 }
      return { workspace: daemon.current }
    }
  }
  for (const method of ['clearPane', 'resetPane']) handlers[`quirky.terminal/${method}`] = () => ({ ok: true })
  return {
    ...daemon,
    handlers,
    /** Replaces the workspace as if another client changed it, with the revision one higher. */
    set(next: Workspace) {
      daemon.current = { ...next, revision: daemon.current.revision + 1 }
      return daemon.current
    },
    fail(method: string, code: number, message: string) {
      daemon.failures.set(method, new RpcError(code, message))
    },
    get workspace() {
      return daemon.current
    }
  }
}

export type FakeDaemon = ReturnType<typeof fakeDaemon>

export const notFound = (message: string) => new RpcError(RpcErrorCode.NotFound, message)

// ---- mounting

export type MountedWorkspace = Awaited<ReturnType<typeof mountFixture>>

/** Mounts the workspace view over `daemon` and waits until it has loaded. */
export async function mountFixture(
  daemon: FakeDaemon,
  options: { input?: unknown; settings?: Record<string, unknown>; extra?: Record<string, Handler>; view?: Record<string, unknown> } = {}
) {
  const fake = fakeContext({ ...daemon.handlers, ...options.extra }, options.settings)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: any[] = []
  const input = options.input ?? { worktree: WORKTREE }
  let cleanup: (() => void) | void = undefined
  await act(async () => {
    cleanup = workspace.mountWorkspace(fake.context, element, { input, report: (state) => void reports.push(state) }, options.view)
  })
  await settle()
  await settle()
  return {
    fake,
    element,
    reports,
    daemon,
    last: () => reports.at(-1),
    controller: () => workspace.focusedController()!,
    q: <T extends Element = HTMLElement>(selector: string) => element.querySelector<T>(selector),
    qa: <T extends Element = HTMLElement>(selector: string) => [...element.querySelectorAll<T>(selector)],
    unmount: async () => {
      await act(async () => cleanup?.())
      element.remove()
    }
  }
}

// ---- gestures

export async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('no element to click')
  await act(async () => (element as HTMLElement).click())
  await settle()
}

export async function fire(element: Element | Window | null, event: Event): Promise<void> {
  if (!element) throw new Error('no element to dispatch to')
  await act(async () => void element.dispatchEvent(event))
  await settle()
}

export function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
}

export async function key(element: Element | Window, name: string, init: KeyboardEventInit = {}): Promise<void> {
  await fire(element, new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
}

/** Types into a controlled React input; happy-dom lacks the `oninput` support React checks, so its change plugin needs focus and a keyup. */
export async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => void input.focus())
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function callsTo(daemon: FakeContext, method: string) {
  return daemon.callsTo(`quirky.terminal/${method}`).map((call) => call.params)
}
