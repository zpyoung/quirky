import { expect } from 'bun:test'
import type { GitDiff, GitStatus, QuirkyEvent, ReviewFile, ReviewModel, UiLayout, UiPluginContext } from '@quirky/protocol'
import { createNativeBrowserCapability } from '../../../../packages/ui/src/native-browser'

// the test file registers happy-dom before importing this module
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { EditorView } = await import('@codemirror/view')
const { activate } = await import('../../src/ui')
const { registerPanel } = await import('../../src/panel/registry')

export { act, EditorView, registerPanel }

export const DIFF_VIEW = 'view:quirky.git/diff'
export const SESSIONS_VIEW = 'view:quirky.session/worktree'
export const PANEL = 'panel:quirky.git/source-control'

export type Call = { method: string; params: Record<string, unknown> }
export type Handler = (params: Record<string, unknown>) => unknown

export type Fake = {
  context: UiPluginContext
  calls: Call[]
  opened: Array<{ id: string; input: unknown }>
  panelToggles: Array<{ id: string; open?: boolean }>
  toasts: Array<[string, string]>
  settings: Record<string, unknown>
  /** Scripted results by method; a missing method throws. */
  handlers: Record<string, Handler>
  provided: Map<string, unknown>
  layout: UiLayout
  emit(event: QuirkyEvent): void
  listeners(): number
  scopes(): string[]
  callsTo(method: string): Call[]
  /** Runs `command:quirky.git/<id>` as the host would. */
  run(id: string, args?: unknown): Promise<unknown>
}

export function layoutFor(worktree: string | null): UiLayout {
  return {
    worktree,
    view: worktree === null ? null : { id: SESSIONS_VIEW, input: { worktree } },
    panel: PANEL,
    sidebar: true,
    focus: 'view'
  }
}

export function fakeContext(layout: UiLayout = layoutFor(null)): Fake {
  const listeners = new Map<(event: QuirkyEvent) => void | Promise<void>, string | null | undefined>()
  const fake: Fake = {
    calls: [],
    opened: [],
    panelToggles: [],
    toasts: [],
    settings: {},
    handlers: {
      'quirky.git/notes': () => ({ notes: [] }),
      'quirky.git/status': () => status()
    },
    provided: new Map(),
    layout,
    emit(event) {
      const taggedWorktreeId =
        event.type.includes('/') && 'worktreeId' in event && typeof event.worktreeId === 'string'
          ? event.worktreeId
          : undefined
      for (const [listener, worktreeId] of [...listeners]) {
        if (taggedWorktreeId !== undefined && (worktreeId === null || (typeof worktreeId === 'string' && worktreeId !== taggedWorktreeId))) continue
        void listener(event)
      }
    },
    listeners: () => listeners.size,
    scopes: () => [...listeners.values()].filter((worktreeId): worktreeId is string => typeof worktreeId === 'string'),
    callsTo: (method) => fake.calls.filter((c) => c.method === method),
    run: async (id, args) => {
      const handler = fake.provided.get(`command:quirky.git/${id}`)
      if (typeof handler !== 'function') throw new Error(`no command ${id}`)
      return await handler(args)
    },
    context: {
      pluginId: 'quirky.git',
      nativeBrowser: createNativeBrowserCapability(),
      nativeDropPaths: async () => null,
      readClipboardText: async () => '',
      log() {},
      provide: (id, implementation) => void fake.provided.set(id, implementation),
      async call(method, params = {}) {
        fake.calls.push({ method, params })
        if (method === 'setting.set') {
          const id = params.id as string
          fake.settings[id.slice(id.indexOf('/') + 1)] = params.value
          fake.emit({ type: 'setting.changed', id, value: params.value as boolean | number | string })
          return {}
        }
        const handler = fake.handlers[method]
        if (!handler) throw new Error(`unexpected call ${method}`)
        return handler(params)
      },
      subscribe(listener, options?: { worktreeId?: string | null }) {
        listeners.set(listener, options?.worktreeId)
        return () => listeners.delete(listener)
      },
      getSetting: (name) => fake.settings[name],
      executeCommand: async () => {},
      createCommandDrag() { throw new Error('command dragging is unavailable in this fake') },
      consumeCommandDrag() { return null },
      cancelCommandDrag() {},
      openView: (id, input) => void fake.opened.push({ id, input }),
      closeView() {},
      togglePanel: (id, open) => void fake.panelToggles.push({ id, open }),
      setPalette() {},
      getLayout: () => fake.layout,
      onLayout: () => () => {},
      onStream: () => () => {},
      onConnection: () => () => {},
      confirm: async () => true,
      toast: (title, body) => void fake.toasts.push([title, body]),
      setPanelBadge() {},
      setContext() {},
      mountView: () => () => {}
    }
  }
  void activate(fake.context)
  return fake
}

type Mount = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void

export type Mounted = {
  element: HTMLElement
  reports: Array<Record<string, unknown>>
  report(): Record<string, unknown>
  unmount(): void
}

/** Mounts the diff view with `input`, as the host does. */
export function mountView(fake: Fake, input: unknown): Mounted {
  const mount = fake.provided.get(DIFF_VIEW) as Mount | undefined
  if (!mount) throw new Error(`activate did not provide ${DIFF_VIEW}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: Array<Record<string, unknown>> = []
  let cleanup: (() => void) | void
  act(() => {
    cleanup = mount(element, { input, report: (state) => void reports.push(state as Record<string, unknown>) })
  })
  return {
    element,
    reports,
    report: () => reports[reports.length - 1],
    unmount() {
      act(() => {
        cleanup?.()
      })
      element.remove()
    }
  }
}

export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => {})
}

export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
  await settle()
}

export async function click(target: Element | null | undefined): Promise<void> {
  if (!target) throw new Error('nothing to click')
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

export const byLabel = (root: ParentNode, label: string): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

export const byText = (root: ParentNode, text: string): HTMLButtonElement | null =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) ?? null

/** The CodeMirror view that holds the modified side of the n-th diff in `root`. */
export function modifiedEditor(root: ParentNode, n = 0): InstanceType<typeof EditorView> {
  const pane = root.querySelectorAll('[data-diff-editor]')[n]
  if (!pane) throw new Error(`no editor ${n}`)
  const editors = [...pane.querySelectorAll<HTMLElement>('.cm-editor')]
  const modified = editors[editors.length - 1]
  return EditorView.findFromDOM(modified)!
}

export const edit = (root: ParentNode, text: string, n = 0): void => {
  const view = modifiedEditor(root, n)
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  })
}

export const textOf = (root: ParentNode): string => root.textContent ?? ''

export const textDiff = (overrides: Partial<GitDiff> = {}): GitDiff => ({
  path: 'math.ts',
  staged: false,
  original: 'one\ntwo\nthree\n',
  modified: 'one\n2\nthree\n',
  binary: false,
  source: 'unstaged',
  kind: 'text',
  modifiedHash: 'hash-1',
  ...overrides
})

export const numbered = (n: number, prefix = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'

export function status(entries: GitStatus['entries'] = []): GitStatus {
  return {
    branch: 'feat',
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    head: 'a'.repeat(40),
    detached: false,
    unborn: false,
    entries,
    operation: 'none',
    capped: false,
    upstreamStatus: { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null },
    busy: null
  }
}

export function failure(message: string, reason?: string): Error {
  return Object.assign(new Error(message), reason ? { data: { reason } } : {})
}

export const expectOpened = (fake: Fake, id: string, input: unknown): void => {
  expect(fake.opened.at(-1)).toEqual({ id, input })
}

/** A stand-in for IntersectionObserver whose callbacks tests fire by hand. */
export function stubIntersectionObserver() {
  type Entry = { callback: IntersectionObserverCallback; element: Element; observer: object }
  const entries: Entry[] = []
  const original = globalThis.IntersectionObserver
  class Stub {
    constructor(readonly callback: IntersectionObserverCallback) {}
    observe(element: Element) {
      entries.push({ callback: this.callback, element, observer: this })
    }
    disconnect() {
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].observer === this) entries.splice(i, 1)
    }
    unobserve() {}
    takeRecords() {
      return []
    }
  }
  globalThis.IntersectionObserver = Stub as unknown as typeof IntersectionObserver
  return {
    observed: () => entries.map((e) => e.element),
    async reveal(element: Element) {
      await act(async () => {
        for (const entry of entries.filter((e) => e.element === element)) {
          entry.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], entry.observer as IntersectionObserver)
        }
      })
      await settle()
    },
    restore() {
      globalThis.IntersectionObserver = original
    }
  }
}

/** One changed file of a review model; override any field. */
export const reviewFile = (path: string, extra: Partial<ReviewFile> = {}): ReviewFile => ({
  path,
  status: 'M',
  added: 2,
  removed: 1,
  binary: false,
  uncommitted: true,
  staged: false,
  mark: 'none',
  notes: 0,
  ...extra
})

/** A `quirky.git/review` result for `files`, with counts derived from their marks. */
export function reviewModel(files: ReviewFile[], extra: Partial<ReviewModel> = {}): ReviewModel {
  const marked = (mark: ReviewFile['mark']) => files.filter((f) => f.mark === mark).length
  return {
    worktreeId: 'w1',
    branch: 'feat',
    base: { name: 'main', source: 'detected', isCurrentBranch: false },
    compare: { status: 'ready', mergeBase: 'b'.repeat(40), headOid: 'c'.repeat(40) },
    totals: { added: files.reduce((n, f) => n + (f.added ?? 0), 0), removed: files.reduce((n, f) => n + (f.removed ?? 0), 0) },
    counts: { files: files.length, reviewed: marked('reviewed'), changed: marked('changed'), uncommitted: files.length, staged: 0 },
    capped: false,
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ...extra
  }
}

/** A stand-in for ResizeObserver whose measurements tests set by hand. */
export function stubResizeObserver() {
  type Entry = { callback: ResizeObserverCallback; element: Element; observer: object }
  const entries: Entry[] = []
  const original = globalThis.ResizeObserver
  class Stub {
    constructor(readonly callback: ResizeObserverCallback) {}
    observe(element: Element) {
      entries.push({ callback: this.callback, element, observer: this })
    }
    disconnect() {
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].observer === this) entries.splice(i, 1)
    }
    unobserve() {}
  }
  globalThis.ResizeObserver = Stub as unknown as typeof ResizeObserver
  return {
    observed: () => entries.map((e) => e.element),
    async resize(width: number) {
      await act(async () => {
        for (const entry of [...entries]) {
          entry.callback([{ target: entry.element, contentRect: { width } } as unknown as ResizeObserverEntry], entry.observer as ResizeObserver)
        }
      })
      await settle()
    },
    restore() {
      globalThis.ResizeObserver = original
    }
  }
}
