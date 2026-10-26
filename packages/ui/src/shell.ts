import { confirmForPlugin } from './components/ConfirmHost'
import { Connection } from './connection'
import type { AppContextValue } from './context'
import { WindowPluginHost, type HostDeps } from './plugins/host'
import { Store } from './store'

/** Window focus as the browser reports it. */
export function browserWindowFocus(): NonNullable<HostDeps['windowFocus']> {
  return {
    hasFocus: () => document.hasFocus(),
    subscribe(listener) {
      const gained = () => listener(true)
      const lost = () => listener(false)
      window.addEventListener('focus', gained)
      window.addEventListener('blur', lost)
      return () => {
        window.removeEventListener('focus', gained)
        window.removeEventListener('blur', lost)
      }
    }
  }
}

export type ShellOptions = {
  /** Where the daemon is and the token to use; defaults to the page's location. */
  where?: { hash: string; host: string }
  /** Loads a plugin UI module from the URL the daemon's UI model gives. */
  importModule(url: string): Promise<unknown>
  log(message: string): void
  windowFocus?: HostDeps['windowFocus']
  /** Delay before the first reconnect attempt. */
  initialDelayMs?: number
}

/**
 * The window's store, daemon connection and plugin host, wired together: the host refreshes on
 * every (re)connect. Call `connection.start()` on the result to connect.
 */
export function createShell(options: ShellOptions): AppContextValue {
  const store = new Store()
  const connection = new Connection(store, options.where, { initialDelayMs: options.initialDelayMs })
  const plugins = new WindowPluginHost({
    call: (method, params) => connection.callAny(method, params),
    onEvent: (listener) => connection.onEvent(listener),
    onStream: (streamId, listener) => connection.onStream(streamId, listener),
    onConnection: (listener) => connection.onStatus(listener),
    importModule: options.importModule,
    confirm: confirmForPlugin,
    toast: (title, body, kind) => store.dispatch({ type: 'toast', toast: { kind, title, body } }),
    log: options.log,
    windowFocus: options.windowFocus
  })
  connection.onConnected(() => {
    plugins.connected().catch((error) => options.log(`plugin refresh failed: ${error}`))
  })
  return { store, connection, plugins }
}
