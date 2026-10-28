import { act } from 'react'
import { RpcError, RpcErrorCode, type QuirkyEvent, type UiLayout, type UiPluginContext } from '@quirky/protocol'

type Handler = (params: Record<string, any>) => unknown

export type FakeContext = ReturnType<typeof fakeContext>

/** Every setting `quirky.terminal` declares, at its manifest default. */
export const TERMINAL_SETTING_DEFAULTS: Record<string, unknown> = {
  'font-family': 'SF Mono',
  'font-size': 14,
  'font-weight': 500,
  'font-weight-bold': 700,
  'line-height': 1,
  'cursor-style': 'block',
  'cursor-blink': true,
  scrollback: 2000,
  'word-separators': " ()[]{}',\"`",
  'option-as-alt': 'auto',
  'jis-yen-backslash': false,
  'copy-on-select': false,
  'trim-gutter-on-copy': true,
  'allow-osc52': true,
  'right-click-paste': false,
  'focus-follows-mouse': false,
  'scroll-sensitivity': 1.15,
  'fast-scroll-sensitivity': 5,
  'gpu-acceleration': 'auto',
  'minimum-contrast': 1,
  'inactive-pane-opacity': 0.9,
  'divider-thickness': 3,
  'padding-x': 4,
  'padding-y': 4,
  'background-opacity': 1,
  'link-click': 'actions',
  'link-middle-click': 'open',
  'confirm-close-running': true,
  'confirm-close-pinned': true,
  'ctrl-tab-order': 'mru',
  'shortcut-policy': 'app-first',
  'floating-enabled': true,
  'floating-cwd': '~'
}

/**
 * A `UiPluginContext` for `quirky.terminal` whose daemon calls are served by `handlers`; every
 * other method rejects as unknown. Settings not in `settings` read their manifest default, by
 * short name or as `setting:quirky.terminal/<name>`. Context keys and mounted views are recorded.
 */
export function fakeContext(handlers: Record<string, Handler> = {}, settings: Record<string, unknown> = {}) {
  const calls: { method: string; params: Record<string, any> }[] = []
  const provided = new Map<string, (...args: any[]) => any>()
  const eventListeners = new Set<(event: QuirkyEvent) => void>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const streams = new Map<number, (bytes: Uint8Array) => void>()
  const opened: { id: string; input: unknown }[] = []
  const toasts: { title: string; body: string }[] = []
  const confirms: { title: string; body?: string; confirmLabel?: string }[] = []
  const contextKeys: { key: string; value: boolean | undefined }[] = []
  const mountedViews: { viewId: string; element: HTMLElement; input: unknown; unmounted: boolean }[] = []
  const values = new Map<string, boolean>()
  const state = { confirmAnswer: true }
  const layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }
  const known = { ...TERMINAL_SETTING_DEFAULTS, ...settings }

  const context: UiPluginContext = {
    pluginId: 'quirky.terminal',
    log() {},
    provide(id, implementation) {
      provided.set(id, implementation as (...args: any[]) => any)
    },
    async call(method, params = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) throw new RpcError(RpcErrorCode.MethodNotFound, `unknown method: ${method}`)
      return handler(params)
    },
    subscribe(listener) {
      eventListeners.add(listener as (event: QuirkyEvent) => void)
      return () => eventListeners.delete(listener as (event: QuirkyEvent) => void)
    },
    getSetting(name) {
      const short = name.replace(/^setting:quirky\.terminal\//, '')
      if (!(short in known)) throw new Error(`no setting ${name}`)
      return known[short]
    },
    async executeCommand() {},
    createCommandDrag() { throw new Error('command dragging is unavailable in this fake') },
    consumeCommandDrag() { return null },
    cancelCommandDrag() {},
    openView(id, input) {
      opened.push({ id, input })
      layout.view = { id, input }
    },
    closeView() {
      layout.view = null
    },
    togglePanel() {},
    getLayout: () => layout,
    onLayout: () => () => {},
    onStream(streamId, listener) {
      streams.set(streamId, listener)
      return () => streams.delete(streamId)
    },
    onConnection(listener) {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
    async confirm(options) {
      confirms.push(options)
      return state.confirmAnswer
    },
    toast(title, body) {
      toasts.push({ title, body })
    },
    setPanelBadge() {},
    setContext(key, value) {
      contextKeys.push({ key, value })
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
    mountView(viewId, element, input) {
      const entry = { viewId, element, input, unmounted: false }
      mountedViews.push(entry)
      return () => {
        entry.unmounted = true
      }
    }
  }

  return {
    context,
    calls,
    provided,
    opened,
    toasts,
    confirms,
    streams,
    layout,
    state,
    contextKeys,
    mountedViews,
    /** The current value of a window-global context key. */
    contextValue: (key: string) => values.get(key),
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    emit: (event: QuirkyEvent) => act(async () => void eventListeners.forEach((listener) => listener(event))),
    setConnection: (status: 'connected' | 'reconnecting') => act(async () => void connectionListeners.forEach((listener) => listener(status))),
    /** Delivers `bytes` on stream `streamId` as the daemon would. */
    push: (streamId: number, bytes: string | Uint8Array) =>
      act(async () => void streams.get(streamId)!(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes))
  }
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** The result of `quirky.terminal/attach` for a live session, with `over` applied. */
export function attachResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    streamId: 7,
    replay: '',
    offset: 0,
    historyCursor: null,
    cols: 80,
    rows: 24,
    restored: false,
    shellState: 'unsupported',
    live: true,
    ...over
  }
}

/**
 * Handlers for the daemon methods a pane calls. Each attach opens a new stream with the next
 * ID (starting at 101) and replays `replay`; `pathsExist` answers true for the paths in `existing`.
 */
export function paneHandlers(options: { replay?: string; existing?: string[] } = {}, extra: Record<string, Handler> = {}): Record<string, Handler> {
  let nextStream = 100
  const existing = new Set(options.existing ?? [])
  return {
    'quirky.terminal/attach': () => attachResult({ streamId: ++nextStream, replay: options.replay ?? '' }),
    'quirky.terminal/detach': () => ({ ok: true }),
    'quirky.terminal/write': () => ({ ok: true }),
    'quirky.terminal/resize': () => ({ ok: true }),
    'quirky.terminal/pathsExist': (params) => ({ exists: (params.paths as string[]).map((path) => existing.has(path)) }),
    'quirky.terminal/openExternal': () => ({ ok: true }),
    ...extra
  }
}
