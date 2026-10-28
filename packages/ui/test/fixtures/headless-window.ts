import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { RuntimeInfo } from '@quirky/protocol/node'
import type { Connection } from '../../src/connection'
import type { WindowPluginHost } from '../../src/plugins/host'
import type { Store } from '../../src/store'

const REPO_PLUGINS = join(import.meta.dir, '..', '..', '..', '..', 'plugins')
const WAIT_MS = 8000

export type HeadlessWindow = {
  host: WindowPluginHost
  store: Store
  connection: Connection
  document: Document
  /** Polls until `check` returns something truthy and returns it; throws with the page text on timeout. */
  waitFor<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs?: number): Promise<T>
  /** Clicks the first element matching `selector` and lets React render the result. */
  click(selector: string): Promise<void>
  /** Gives the window or takes away the focus the browser would report. */
  setFocus(focused: boolean): void
  stop(): Promise<void>
}

export type HeadlessWindowOptions = {
  home: string
  runtime: RuntimeInfo
  /** Extra plugin directories (each holding `<id>/`) searched before the home and the repo's. */
  pluginDirs?: string[]
}

// happy-dom replaces these with versions tied to its window, which stop working once it closes;
// React's scheduler keeps whichever it saw first, so each window needs the runtime's versions.
// Fetch classes must also stay in Bun's realm: Bun.serve cannot return a Happy DOM Response.
const RUNTIME_GLOBALS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'MessageChannel',
  'performance',
  'Request',
  'Response',
  'Headers',
  'fetch',
  'WebSocket'
] as const

/** Where the daemon's `/plugins/<id>/<path>` URL points on disk: dist/ui.js is the source it is built from. */
function moduleFile(dirs: string[], url: string): string | null {
  const match = /^\/plugins\/([^/]+)\/(.+?)(\?.*)?$/.exec(url)
  if (!match) return null
  const [, id, path, query = ''] = match
  for (const dir of dirs) {
    const pluginDir = join(dir, id!)
    const source = path === 'dist/ui.js' ? join(pluginDir, 'src', 'ui.tsx') : null
    if (source && existsSync(source)) return source + query
    if (existsSync(join(pluginDir, path!))) return join(pluginDir, path!) + query
  }
  return null
}

/**
 * The real app in a headless DOM, connected as a `ui` client to the daemon in `runtime`. Plugin UI
 * modules load from source: `/plugins/<id>/dist/ui.js` is `plugins/<id>/src/ui.tsx`, and any other
 * path is that file in the plugin's directory (`<home>/plugins/<id>` for installed plugins).
 * Registers happy-dom globally, so only one window can be open at a time; `stop` removes it.
 */
export async function startHeadlessWindow(options: HeadlessWindowOptions): Promise<HeadlessWindow> {
  if (GlobalRegistrator.isRegistered) throw new Error('a headless window is already open')
  const { runtime } = options
  const native = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
  const host = `127.0.0.1:${runtime.port}`
  GlobalRegistrator.register({ url: `http://${host}/#token=${runtime.token}` })
  for (const [name, value] of native) {
    if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }
  // xterm's WebGL addon asks for a context happy-dom cannot give; the plugin falls back to the DOM renderer
  const getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    try {
      return (getContext as (...a: unknown[]) => unknown).apply(this, args) ?? null
    } catch {
      return null
    }
  } as typeof getContext

  const [{ createElement, act }, { createRoot }, { App }, { AppContext }, { createShell }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../../src/App'),
    import('../../src/context'),
    import('../../src/shell')
  ])

  let stopped = false
  let focused = false
  const listeners = new Set<(focused: boolean) => void>()
  const dirs = [...(options.pluginDirs ?? []), join(options.home, 'plugins'), REPO_PLUGINS]
  const shell = createShell({
    where: { hash: `#token=${runtime.token}`, host },
    initialDelayMs: 50,
    importModule: async (url) => {
      const file = moduleFile(dirs, url)
      if (!file) throw new Error(`no file for ${url}`)
      return import(file)
    },
    log: () => {},
    windowFocus: {
      hasFocus: () => focused,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  })

  const container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(AppContext.Provider, { value: shell }, createElement(App)))
  shell.connection.start()

  const pageText = () => {
    try {
      return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
    } catch {
      return '(the window is closed)'
    }
  }
  const waitFor: HeadlessWindow['waitFor'] = async (check, timeoutMs = WAIT_MS) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`waitFor timed out; the page shows: ${pageText().slice(0, 400)}`)
      await Bun.sleep(10)
    }
  }

  const window_: HeadlessWindow = {
    host: shell.plugins,
    store: shell.store,
    connection: shell.connection,
    document,
    waitFor,
    async click(selector) {
      const element = document.querySelector(selector) as HTMLElement | null
      if (!element) throw new Error(`nothing matches ${selector}; the page shows: ${pageText().slice(0, 400)}`)
      element.click()
      await Bun.sleep(0)
    },
    setFocus(next) {
      focused = next
      for (const listener of [...listeners]) listener(next)
    },
    async stop() {
      if (stopped) return
      stopped = true
      const previousActEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
      try {
        await act(async () => {
          shell.connection.stop()
          shell.plugins.stop()
          root.unmount()
        })
      } finally {
        if (previousActEnvironment === undefined) Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
        else Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment)
        await GlobalRegistrator.unregister()
      }
    }
  }
  await waitFor(() => shell.store.getState().connection === 'connected' && shell.plugins.getState().model !== null)
  return window_
}
