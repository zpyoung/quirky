import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'

let activate: (context: UiPluginContext) => void
let deactivate: () => void

beforeAll(async () => {
  GlobalRegistrator.register()
  // BrowserPaneWindow imports React DOM; load it only after the test DOM is registered.
  ;({ activate, deactivate } = await import('../src/ui'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(() => deactivate())

function isCommandHandler(value: unknown): value is (args?: unknown) => unknown {
  return typeof value === 'function'
}

function browserUi(worktree: string | null, viewWorktree?: string) {
  const layout: UiLayout = {
    worktree,
    view: viewWorktree === undefined ? null : { id: 'view:quirky.session/worktree', input: { worktree: viewWorktree } },
    panel: null,
    sidebar: true,
    focus: null
  }
  const provided = new Map<string, unknown>()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const opened: { id: string; input: unknown }[] = []
  const toasts: { title: string; body: string; options?: unknown }[] = []
  // This test exercises command registration only; unrelated UiPluginContext methods are unused.
  const context = {
    pluginId: 'quirky.browser',
    nativeBrowser: { available: false, clearPartitionAvailable: false },
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.browser/paneState') return { tabs: [] }
      if (method === 'quirky.browser/paneOpen') {
        return { id: 'pane-1', tabId: 'tab-1', worktreeId: params.worktree === 'floating' ? 'floating' : 'wt-resolved' }
      }
      if (method === 'quirky.terminal/setFloating') return {}
      throw new Error(`unexpected call: ${method}`)
    },
    subscribe() {
      return () => {}
    },
    getLayout: () => layout,
    openView(id: string, input: unknown) {
      opened.push({ id, input })
      layout.view = { id, input }
    },
    setContext() {},
    toast(title: string, body: string, options?: unknown) {
      toasts.push({ title, body, options })
    }
  } as unknown as UiPluginContext

  activate(context)
  const run = (args?: unknown) => {
    const handler = provided.get('command:quirky.browser/new-tab')
    if (!isCommandHandler(handler)) throw new Error('Browser new-tab command was not provided')
    return handler(args)
  }
  return { provided, calls, opened, toasts, run }
}

describe('Browser new tab workspace selection', () => {
  test('uses the selected layout worktree rather than the worktree in another view input', async () => {
    const ui = browserUi('wt-selected', 'wt-view')

    expect(await ui.run({ url: 'https://example.test' })).toEqual({ pane: 'pane-1', tabId: 'tab-1' })
    expect(ui.calls.filter((call) => call.method === 'quirky.browser/paneOpen')).toEqual([
      { method: 'quirky.browser/paneOpen', params: { worktree: 'wt-selected', url: 'https://example.test' } }
    ])
    expect(ui.opened).toEqual([{ id: 'view:quirky.session/worktree', input: { worktree: 'id:wt-resolved' } }])
  })

  test('does not fall back to a view-specific input when no worktree is selected', async () => {
    const ui = browserUi(null, 'wt-view')

    expect(await ui.run()).toEqual({ ok: false, reason: 'Open a worktree before creating a browser tab.' })
    expect(ui.calls.filter((call) => call.method === 'quirky.browser/paneOpen')).toEqual([])
    expect(ui.toasts).toEqual([{ title: 'Could not open Browser', body: 'Open a worktree before creating a browser tab.', options: { kind: 'warning' } }])
  })

  test('preserves explicit worktree and floating workspace targets', async () => {
    const ui = browserUi('wt-selected')

    await ui.run({ worktree: 'id:wt-explicit' })
    await ui.run({ workspace: 'floating' })

    expect(ui.calls.filter((call) => call.method === 'quirky.browser/paneOpen').map((call) => call.params)).toEqual([
      { worktree: 'id:wt-explicit' },
      { worktree: 'floating' }
    ])
    expect(ui.calls.filter((call) => call.method === 'quirky.terminal/setFloating').map((call) => call.params)).toEqual([{ open: true }])
    expect(ui.opened).toEqual([{ id: 'view:quirky.session/worktree', input: { worktree: 'id:wt-resolved' } }])
  })
})
