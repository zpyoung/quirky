import type {
  GitCompare,
  GitStatus,
  GitStatusEntry,
  QuirkyEvent,
  UiLayout,
  UiPluginContext
} from '@quirky/protocol'

// the caller registers happy-dom first, then imports this module
const { act } = await import('react')
const { activate } = await import('../../src/ui')

export { act }

export const PANEL = 'panel:quirky.git/source-control'
export const DIFF_VIEW = 'view:quirky.git/diff'

export const layoutFor = (worktree: string | null): UiLayout => ({
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
      log() {},
      provide() {},
      async call(method, params = {}) {
        fake.calls.push({ method, params })
        const scripted = handlers.get(method)
        if (scripted) return scripted(params)
        switch (method) {
          case 'quirky.git/status':
            return fake.statuses[params.worktree as string] ?? fake.status
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
      openView: (id, input) => void fake.views.push({ id, input }),
      closeView() {},
      togglePanel() {},
      getLayout: () => layout,
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
/** The row button of a file: its main button, found by the path in its title. */
export const rowOf = (root: ParentNode, path: string, section?: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`${section ? `[data-section="${section}"] ` : ''}.scm-row-main[title="${path}"]`)

export const sectionHeadings = (root: ParentNode): string[] => qa(root, '.scm-section-title').map((el) => el.textContent ?? '')
