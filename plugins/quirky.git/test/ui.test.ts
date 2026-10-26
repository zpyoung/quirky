import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { GitDiff, GitStatus, QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { activate } = await import('../src/ui')

afterAll(() => GlobalRegistrator.unregister())

const PANEL = 'panel:quirky.git/source-control'

const layoutFor = (worktree: string | null): UiLayout => ({
  view: worktree === null ? null : { id: 'view:quirky.session/worktree', input: { worktree } },
  panel: PANEL,
  sidebar: true,
  focus: 'panel'
})

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  branch: 'main',
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [
    { path: 'staged.ts', index: 'M', worktree: ' ', untracked: false },
    { path: 'edited.ts', index: ' ', worktree: 'M', untracked: false },
    { path: 'new.txt', index: '?', worktree: '?', untracked: true }
  ],
  ...overrides
})

const diffOf = (path: string, staged: boolean): GitDiff => ({
  path,
  staged,
  original: 'one\n',
  modified: 'two\n',
  binary: false
})

type Call = { method: string; params: Record<string, unknown> }

type Fake = {
  context: UiPluginContext
  calls: Call[]
  reports: unknown[]
  toasts: Array<[string, string]>
  setLayout(layout: UiLayout): void
  emit(event: QuirkyEvent): void
  listeners(): { events: number; layout: number }
  statuses: Record<string, GitStatus>
  failing: Set<string>
}

function fakeContext(initial: UiLayout): Fake {
  let layout = initial
  const eventListeners = new Set<(event: QuirkyEvent) => void>()
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  const calls: Call[] = []
  const toasts: Array<[string, string]> = []
  const fake: Fake = {
    calls,
    reports: [],
    toasts,
    statuses: {},
    failing: new Set(),
    setLayout(next) {
      layout = next
      for (const listener of [...layoutListeners]) listener(next)
    },
    emit(event) {
      for (const listener of [...eventListeners]) void listener(event)
    },
    listeners: () => ({ events: eventListeners.size, layout: layoutListeners.size }),
    context: {
      pluginId: 'quirky.git',
      log() {},
      provide() {},
      async call(method, params = {}) {
        calls.push({ method, params })
        if (fake.failing.has(method)) throw new Error(`${method} refused`)
        switch (method) {
          case 'quirky.git/status':
            return fake.statuses[params.worktree as string] ?? status()
          case 'quirky.git/diff':
            return diffOf(params.path as string, params.staged as boolean)
          case 'quirky.git/stage':
          case 'quirky.git/unstage':
            return { ok: true }
          case 'quirky.git/commit':
            return { sha: 'c'.repeat(40) }
        }
        throw new Error(`unexpected call ${method}`)
      },
      subscribe(listener) {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
      getSetting: () => undefined,
      executeCommand: async () => {},
      openView() {},
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
      toast: (title, body) => toasts.push([title, body]),
      setPanelBadge() {}
    }
  }
  return fake
}

type Mount = (
  element: HTMLElement,
  props: { input?: unknown; report?(state: unknown): void }
) => (() => void) | void

function mountPanel(fake: Fake): { element: HTMLElement; unmount: () => void } {
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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

const click = async (target: Element | null | undefined) => {
  if (!target) throw new Error('nothing to click')
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

const button = (root: HTMLElement, predicate: (el: HTMLButtonElement) => boolean) =>
  [...root.querySelectorAll('button')].find(predicate)

const methods = (fake: Fake) => fake.calls.map((c) => c.method)

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('quirky.git source-control panel', () => {
  test('SC-36: the manifest points at the built module and declares the panel activate provides', async () => {
    const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json()
    expect(manifest.ui).toBe('dist/ui.js')
    expect(manifest.contributes.panel.map((p: { id: string }) => `panel:${manifest.id}/${p.id}`)).toEqual([PANEL])
  })

  test('SC-36: activate provides the declared panel', () => {
    const fake = fakeContext(layoutFor(null))
    const provided: string[] = []
    fake.context.provide = (id) => void provided.push(id)
    void activate(fake.context)
    expect(provided).toEqual([PANEL])
  })

  test('SC-36: with no worktree open it asks for one and reports nothing selected', async () => {
    const fake = fakeContext(layoutFor(null))
    const { element, unmount } = mountPanel(fake)
    await settle()
    expect(element.textContent).toContain('Pick a worktree to see its changes')
    expect(fake.calls).toEqual([])
    expect(fake.reports.at(-1)).toEqual({ worktree: null, branch: null, staged: 0, unstaged: 0 })
    unmount()
  })

  test('SC-36: it shows the changes of the worktree in the open view and reports them', async () => {
    const fake = fakeContext(layoutFor('fix-login'))
    const { element, unmount } = mountPanel(fake)
    await settle()
    expect(fake.calls[0]).toEqual({ method: 'quirky.git/status', params: { worktree: 'fix-login' } })
    expect(element.textContent).toContain('Staged (1)')
    expect(element.textContent).toContain('Changes (2)')
    expect(element.textContent).toContain('staged.ts')
    expect(element.textContent).toContain('main')
    expect(fake.reports.at(-1)).toEqual({ worktree: 'fix-login', branch: 'main', staged: 1, unstaged: 2 })
    unmount()
  })

  test('SC-36: opening another worktree swaps the panel to it', async () => {
    const fake = fakeContext(layoutFor('one'))
    fake.statuses.two = status({ branch: 'feature', files: [] })
    const { element, unmount } = mountPanel(fake)
    await settle()
    await act(async () => fake.setLayout(layoutFor('two')))
    await settle()
    expect(fake.calls.at(-1)).toEqual({ method: 'quirky.git/status', params: { worktree: 'two' } })
    expect(element.textContent).toContain('No changes.')
    expect(fake.reports.at(-1)).toEqual({ worktree: 'two', branch: 'feature', staged: 0, unstaged: 0 })
    await act(async () => fake.setLayout(layoutFor(null)))
    await settle()
    expect(element.textContent).toContain('Pick a worktree to see its changes')
    unmount()
  })

  test('refreshes on quirky.git/changed and ignores other events', async () => {
    const fake = fakeContext(layoutFor('w1'))
    const { unmount } = mountPanel(fake)
    await settle()
    const before = fake.calls.length
    await act(async () => fake.emit({ type: 'quirky.session/changed', data: {} }))
    await settle()
    expect(fake.calls.length).toBe(before)
    fake.statuses.w1 = status({ files: [] })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(methods(fake).slice(before)).toEqual(['quirky.git/status'])
    expect(fake.reports.at(-1)).toEqual({ worktree: 'w1', branch: 'main', staged: 0, unstaged: 0 })
    unmount()
  })

  test('keeps polling status every 3 seconds', async () => {
    const intervals: number[] = []
    const realSetInterval = globalThis.setInterval
    globalThis.setInterval = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 3000) intervals.push(ms)
      return (realSetInterval as (...args: unknown[]) => unknown)(handler, ms, ...rest)
    }) as typeof setInterval
    try {
      const { unmount } = mountPanel(fakeContext(layoutFor('w1')))
      await settle()
      unmount()
    } finally {
      globalThis.setInterval = realSetInterval
    }
    expect(intervals).toEqual([3000])
  })

  test('stages a file, then refetches status', async () => {
    const fake = fakeContext(layoutFor('w1'))
    const { element, unmount } = mountPanel(fake)
    await settle()
    const before = fake.calls.length
    await click(button(element, (b) => b.getAttribute('aria-label') === 'Stage edited.ts'))
    expect(fake.calls.slice(before)).toEqual([
      { method: 'quirky.git/stage', params: { worktree: 'w1', paths: ['edited.ts'] } },
      { method: 'quirky.git/status', params: { worktree: 'w1' } }
    ])
    unmount()
  })

  test('unstages all staged files', async () => {
    const fake = fakeContext(layoutFor('w1'))
    const { element, unmount } = mountPanel(fake)
    await settle()
    await click(button(element, (b) => b.textContent === 'Unstage all'))
    expect(fake.calls.find((c) => c.method === 'quirky.git/unstage')?.params).toEqual({
      worktree: 'w1',
      paths: ['staged.ts']
    })
    unmount()
  })

  test('a failed stage toasts the error and the panel stays up', async () => {
    const fake = fakeContext(layoutFor('w1'))
    fake.failing.add('quirky.git/stage')
    const { element, unmount } = mountPanel(fake)
    await settle()
    await click(button(element, (b) => b.getAttribute('aria-label') === 'Stage edited.ts'))
    expect(fake.toasts).toEqual([['Git failed', 'quirky.git/stage refused']])
    expect(element.textContent).toContain('edited.ts')
    unmount()
  })

  test('commits the staged changes with the typed message', async () => {
    const fake = fakeContext(layoutFor('w1'))
    const { element, unmount } = mountPanel(fake)
    await settle()
    const box = element.querySelector('textarea') as HTMLTextAreaElement
    const commitButton = () => button(element, (b) => b.textContent === 'Commit')
    expect(commitButton()?.disabled).toBe(true)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box, '  fix the login  ')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(commitButton())
    expect(fake.calls.find((c) => c.method === 'quirky.git/commit')?.params).toEqual({
      worktree: 'w1',
      message: 'fix the login'
    })
    expect(box.value).toBe('')
    unmount()
  })

  test('selecting a file shows its diff', async () => {
    const fake = fakeContext(layoutFor('w1'))
    const { element, unmount } = mountPanel(fake)
    await settle()
    await click(element.querySelector('.file-main[title="edited.ts"]'))
    expect(fake.calls.find((c) => c.method === 'quirky.git/diff')?.params).toEqual({
      worktree: 'w1',
      path: 'edited.ts',
      staged: false
    })
    expect(element.querySelector('.diff-host')).not.toBeNull()
    unmount()
  })

  test('closing the panel unsubscribes from events and layout', async () => {
    const fake = fakeContext(layoutFor('w1'))
    const { unmount } = mountPanel(fake)
    await settle()
    expect(fake.listeners().events).toBeGreaterThan(0)
    unmount()
    expect(fake.listeners()).toEqual({ events: 0, layout: 0 })
  })
})
