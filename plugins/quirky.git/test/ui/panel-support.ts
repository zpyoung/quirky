import {
  RpcErrorCode,
  type GitCompare,
  type GitStatus,
  type GitStatusEntry,
  type QuirkyEvent,
  type UiLayout,
  type UiPluginContext
} from '@quirky/protocol'
import { createNativeBrowserCapability } from '../../../../packages/ui/src/native-browser'

// the caller registers happy-dom first, then imports this module
const { act } = await import('react')
const { activate } = await import('../../src/ui')

export { act }

export const PANEL = 'panel:quirky.git/source-control'
export const DIFF_VIEW = 'view:quirky.git/diff'

export const layoutFor = (worktree: string | null): UiLayout => ({
  worktree,
  view: worktree === null ? null : { id: 'view:quirky.session/worktree', input: { worktree } },
  panel: PANEL,
  sidebar: true,
  focus: 'panel'
})

export const entry = (
  path: string,
  area: GitStatusEntry['area'] = 'unstaged',
  status: GitStatusEntry['status'] = 'modified',
  extra: Partial<GitStatusEntry> = {}
): GitStatusEntry => ({ path, area, status: area === 'untracked' ? 'untracked' : status, ...extra })

/** A complete status snapshot; `entries` are the rows, everything else defaults to a clean branch with an upstream. */
export function statusOf(entries: GitStatusEntry[] = [], overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'zoe/feat',
    upstream: 'origin/zoe/feat',
    ahead: 0,
    behind: 0,
    files: [],
    head: 'a'.repeat(40),
    detached: false,
    unborn: false,
    entries,
    operation: 'none',
    capped: false,
    upstreamStatus: { hasUpstream: true, name: 'origin/zoe/feat', sha: 'b'.repeat(40), ahead: 0, behind: 0, behindPatchEquivalent: null },
    busy: null,
    ...overrides
  }
}

export const compareOf = (overrides: Partial<GitCompare> = {}): GitCompare => ({
  status: 'ready',
  base: 'origin/main',
  baseSource: 'detected',
  message: null,
  baseOid: 'c'.repeat(40),
  headOid: 'a'.repeat(40),
  mergeBase: 'c'.repeat(40),
  ahead: 0,
  behind: 0,
  entries: [],
  added: 0,
  removed: 0,
  ...overrides
})

export type Call = { method: string; params: Record<string, unknown> }
type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>
type HostedTab = {
  kind: 'view'
  id: string
  viewId: string
  key: string
  input: Record<string, unknown>
  title: string
  pinned: boolean
  preview: boolean
  closeMethod?: string
  closeParams?: Record<string, unknown>
  closeContext?: boolean
}
type HostedGroup = { kind: 'group'; id: string; tabs: HostedTab[]; activeTab: string | null }
type HostedRoot = HostedGroup | { kind: 'split'; id: string; direction: 'right'; first: HostedRoot; second: HostedRoot }
type HostedWorkspace = { id: string; revision: number; activeGroup: string; root: HostedRoot }

export type Fake = {
  context: UiPluginContext
  calls: Call[]
  reports: any[]
  toasts: Array<[string, string]>
  views: Array<{ id: string; input: unknown }>
  badges: Array<[string, number | null, string | undefined]>
  settings: Record<string, unknown>
  /** Status by worktree selector; `status` below is what any other selector gets. */
  statuses: Record<string, GitStatus>
  status: GitStatus
  compare: GitCompare
  /** Scripted results by method; a handler may throw to fail the call. */
  on(method: string, handler: Handler): void
  setLayout(layout: UiLayout): void
  emit(event: QuirkyEvent): void
  listeners(): { events: number; layout: number }
  /** The calls of one method. */
  called(method: string): Call[]
}

/** A daemon error carrying `data`, as the window sees one. */
export const failure = (message: string, data: Record<string, unknown> = {}): Error => Object.assign(new Error(message), { data })

/** A fake `UiPluginContext` that records what the panel does and answers methods from scripts. */
export function fakeContext(initial: UiLayout): Fake {
  let layout = initial
  const eventListeners = new Set<(event: QuirkyEvent) => void>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const handlers = new Map<string, Handler>()
  const terminalWorkspaces = new Map<string, HostedWorkspace>()
  let terminalTabSequence = 0
  const groupsFrom = (node: HostedRoot): HostedGroup[] =>
    node.kind === 'group' ? [node] : [...groupsFrom(node.first), ...groupsFrom(node.second)]
  const groupFor = (workspace: HostedWorkspace, id: string): HostedGroup | undefined =>
    groupsFrom(workspace.root).find((group) => group.id === id)
  const workspaceFor = (selector: unknown): HostedWorkspace => {
    const selected = typeof selector === 'string' ? selector.replace(/^id:/u, '') : 'default'
    let workspace = terminalWorkspaces.get(selected)
    if (!workspace) {
      const groupId = `${selected}:group`
      workspace = { id: selected, revision: 0, activeGroup: groupId, root: { kind: 'group', id: groupId, tabs: [], activeTab: null } }
      terminalWorkspaces.set(selected, workspace)
    }
    return workspace
  }
  const legacyInput = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const input = { ...(value as Record<string, unknown>) }
    delete input.groupId
    delete input.tabId
    delete input.preview
    delete input.split
    return input
  }
  const terminalCall = (method: string, params: Record<string, unknown>): unknown => {
    const workspace = workspaceFor(params.workspace)
    if (method === 'quirky.terminal/workspace') return { workspace }
    if (method === 'quirky.terminal/openViewTab') {
      const viewId = typeof params.viewId === 'string' ? params.viewId : ''
      const key = typeof params.key === 'string' ? params.key : ''
      const title = typeof params.title === 'string' ? params.title : ''
      const group = groupFor(workspace, typeof params.group === 'string' ? params.group : workspace.activeGroup)
      if (!group || viewId === '' || key === '') throw new Error('invalid fake hosted-view request')
      const supplied = typeof params.input === 'object' && params.input !== null && !Array.isArray(params.input)
        ? params.input as Record<string, unknown>
        : {}
      const replaceId = typeof params.replace === 'string' ? params.replace : undefined
      let tab = replaceId
        ? groupsFrom(workspace.root).flatMap((owner) => owner.tabs).find((candidate) => candidate.id === replaceId)
        : params.reuse === false
          ? undefined
          : groupsFrom(workspace.root).flatMap((owner) => owner.tabs).find((candidate) => candidate.viewId === viewId && candidate.key === key)
      if (!tab) {
        tab = {
          kind: 'view',
          id: `view-tab-${++terminalTabSequence}`,
          viewId,
          key,
          input: supplied,
          title,
          pinned: false,
          preview: params.preview === true
        }
        group.tabs.push(tab)
      } else {
        tab.viewId = viewId
        tab.key = key
        tab.input = supplied
        tab.title = title
        tab.preview = params.preview === true
        if (!group.tabs.includes(tab)) group.tabs.push(tab)
      }
      tab.closeMethod = typeof params.closeMethod === 'string' ? params.closeMethod : undefined
      tab.closeParams = typeof params.closeParams === 'object' && params.closeParams !== null && !Array.isArray(params.closeParams)
        ? params.closeParams as Record<string, unknown>
        : undefined
      tab.closeContext = params.closeContext === true
      if (params.activate !== false) {
        workspace.activeGroup = group.id
        group.activeTab = tab.id
      }
      workspace.revision += 1
      fake.views.push({ id: viewId, input: legacyInput(supplied) })
      fake.emit({ type: 'quirky.terminal/layout', data: { workspace: workspace.id, revision: workspace.revision } })
      return { workspace, tab: tab.id }
    }
    if (method === 'quirky.terminal/rekeyViewTabs') {
      const changes = Array.isArray(params.changes) ? params.changes : []
      for (const raw of changes) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
        const change = raw as Record<string, unknown>
        const tab = groupsFrom(workspace.root).flatMap((owner) => owner.tabs).find((candidate) => candidate.id === change.tab)
        if (!tab) continue
        if (typeof change.key === 'string') tab.key = change.key
        if (typeof change.input === 'object' && change.input !== null && !Array.isArray(change.input)) tab.input = change.input as Record<string, unknown>
        if (typeof change.title === 'string') tab.title = change.title
        if (typeof change.preview === 'boolean') tab.preview = change.preview
      }
      workspace.revision += 1
      fake.emit({ type: 'quirky.terminal/layout', data: { workspace: workspace.id, revision: workspace.revision } })
      return { workspace }
    }
    if (method === 'quirky.terminal/moveTab' && params.split === 'right') {
      const tab = groupsFrom(workspace.root).flatMap((owner) => owner.tabs).find((candidate) => candidate.id === params.tab)
      const group = typeof params.of === 'string' ? groupFor(workspace, params.of) : undefined
      if (tab && group && workspace.root.kind === 'group') {
        group.tabs = group.tabs.filter((item) => item !== tab)
        const right: HostedGroup = { kind: 'group', id: `${workspace.id}:group-${++terminalTabSequence}`, tabs: [tab], activeTab: tab.id }
        workspace.root = { kind: 'split', id: `${workspace.id}:split-${terminalTabSequence}`, direction: 'right', first: group, second: right }
        workspace.activeGroup = right.id
      }
      workspace.revision += 1
      fake.emit({ type: 'quirky.terminal/layout', data: { workspace: workspace.id, revision: workspace.revision } })
      return { workspace }
    }
    if (method === 'quirky.terminal/pinTab') {
      const tab = groupsFrom(workspace.root).flatMap((owner) => owner.tabs).find((candidate) => candidate.id === params.tab)
      if (tab) tab.pinned = params.pinned === true
      workspace.revision += 1
      fake.emit({ type: 'quirky.terminal/layout', data: { workspace: workspace.id, revision: workspace.revision } })
      return { workspace }
    }
    if (method === 'quirky.terminal/closeTab') {
      for (const group of groupsFrom(workspace.root)) group.tabs = group.tabs.filter((tab) => tab.id !== params.tab)
      workspace.revision += 1
      fake.emit({ type: 'quirky.terminal/layout', data: { workspace: workspace.id, revision: workspace.revision } })
      return { workspace }
    }
    throw new Error(`unexpected terminal method ${method}`)
  }
  const fake: Fake = {
    calls: [],
    reports: [],
    toasts: [],
    views: [],
    badges: [],
    settings: {},
    statuses: {},
    status: statusOf(),
    compare: compareOf(),
    on: (method, handler) => void handlers.set(method, handler),
    setLayout(next) {
      layout = next
      for (const listener of [...layoutListeners]) listener(next)
    },
    emit(event) {
      for (const listener of [...eventListeners]) void listener(event)
    },
    listeners: () => ({ events: eventListeners.size, layout: layoutListeners.size }),
    called: (method) => fake.calls.filter((c) => c.method === method),
    context: {
      pluginId: 'quirky.git',
      nativeBrowser: createNativeBrowserCapability(),
      nativeDropPaths: async () => null,
      readClipboardText: async () => '',
      log() {},
      provide() {},
      async call(method, params = {}) {
        fake.calls.push({ method, params })
        const scripted = handlers.get(method)
        if (scripted) return scripted(params)
        if (method.startsWith('quirky.terminal/')) return terminalCall(method, params)
        switch (method) {
          case 'quirky.git/status':
            return fake.statuses[params.worktree as string] ?? fake.status
          case 'quirky.git/notes':
            return { notes: [] }
          case 'quirky.hosting/cachedReviews':
            return { workspaces: [] }
          case 'quirky.hosting/forBranch':
            throw Object.assign(new Error(`unknown method: ${method}`), { code: RpcErrorCode.MethodNotFound })
          case 'quirky.git/compare':
            return fake.compare
          case 'quirky.worktree/resolve':
            return { path: `/repo/${params.selector}` }
          case 'quirky.git/conflictFile':
            return { path: params.path, content: 'resolved\n' }
          case 'quirky.git/commit':
            return { sha: 'd'.repeat(40) }
          case 'quirky.git/stage':
          case 'quirky.git/unstage':
          case 'quirky.git/discard':
          case 'quirky.git/push':
          case 'quirky.git/forcePush':
          case 'quirky.git/pull':
          case 'quirky.git/fastForward':
          case 'quirky.git/fetch':
          case 'quirky.git/sync':
          case 'quirky.git/rebaseFromBase':
          case 'quirky.git/abort':
          case 'quirky.git/setBase':
          case 'quirky.git/ignoreFolder':
          case 'quirky.git/reveal':
          case 'setting.set':
            return { ok: true }
          case 'quirky.git/continue':
            return { finished: true, operation: 'merge' }
          case 'quirky.git/hugeFolders':
            return { folders: [] }
          case 'quirky.git/history':
            return { commits: [], hasMore: false }
          case 'quirky.git/branches':
            return { refs: [], current: null }
        }
        throw new Error(`unexpected call ${method}`)
      },
      subscribe(listener) {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
      getSetting(name) {
        const key = name.replace(/^setting:quirky\.git\//, '')
        return fake.settings[key]
      },
      executeCommand: async () => {},
      createCommandDrag() { throw new Error('command dragging is unavailable in this fake') },
      consumeCommandDrag() { return null },
      cancelCommandDrag() {},
      openView: (id, input) => void fake.views.push({ id, input }),
      closeView() {},
      togglePanel() {},
      getLayout: () => layout,
      setPalette() {},
      onLayout(listener) {
        layoutListeners.add(listener)
        return () => layoutListeners.delete(listener)
      },
      onStream: () => () => {},
      onConnection: () => () => {},
      confirm: async () => true,
      toast: (title, body) => void fake.toasts.push([title, body]),
      setPanelBadge: (panel, count, title) => void fake.badges.push([panel, count, title]),
      setContext() {},
      mountView: () => () => {}
    }
  }
  return fake
}

type Mount = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void

/** Mounts the panel `activate` provides into a fresh element. */
export function mountPanel(fake: Fake): { element: HTMLElement; unmount: () => void } {
  let mount: Mount | undefined
  const provide = fake.context.provide
  fake.context.provide = (id, implementation) => {
    provide(id, implementation)
    if (id === PANEL) mount = implementation as Mount
  }
  void activate(fake.context)
  if (!mount) throw new Error(`activate did not provide ${PANEL}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | void
  act(() => {
    cleanup = mount!(element, { report: (state) => fake.reports.push(state) })
  })
  return {
    element,
    unmount: () => {
      act(() => {
        cleanup?.()
      })
      element.remove()
    }
  }
}

/** Lets pending promises and effects run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => {})
}

/** Wait for a rendered state change without coupling tests to async lookup timing. */
export async function waitForState(root: Node, condition: () => boolean): Promise<void> {
  if (condition()) return
  const { promise, resolve } = Promise.withResolvers<void>()
  const observer = new MutationObserver(() => {
    if (!condition()) return
    observer.disconnect()
    resolve()
  })
  observer.observe(root, { attributes: true, childList: true, subtree: true })
  await promise
}

export async function click(target: Element | null | undefined, init: MouseEventInit = {}): Promise<void> {
  if (!target) throw new Error('nothing to click')
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
  await settle()
}

export async function press(target: Element | Window | Document, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
  await settle()
}

export async function type(target: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

export const q = (root: ParentNode, selector: string): HTMLElement | null => root.querySelector<HTMLElement>(selector)
export const qa = (root: ParentNode, selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)]
export const byLabel = (root: ParentNode, label: string): HTMLElement | null => root.querySelector<HTMLElement>(`[aria-label="${label}"]`)
export const byText = (root: ParentNode, selector: string, text: string): HTMLElement | undefined =>
  qa(root, selector).find((el) => el.textContent === text)
export const buttonText = (root: ParentNode, text: string) => byText(root, 'button', text) as HTMLButtonElement | undefined
/** The selected file's shared list-row button, found by its stable row path. */
export const rowOf = (root: ParentNode, path: string, section?: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`${section ? `[data-section="${section}"] ` : ''}[data-row-path="${path}"] button[aria-pressed]`)
export const rowContainerOf = (root: ParentNode, path: string, section?: string): HTMLElement | null =>
  rowOf(root, path, section)?.parentElement ?? null

export const sectionHeadings = (root: ParentNode): string[] => qa(root, '[data-section] .ui-section-header__title').map((el) => el.textContent ?? '')
export const noticesOf = (root: ParentNode): HTMLElement[] =>
  qa(root, '[aria-label="Source control notices"] > [role="status"], [aria-label="Source control notices"] > [role="alert"]')
export const noticeOf = (root: ParentNode): HTMLElement | null => noticesOf(root)[0] ?? null
