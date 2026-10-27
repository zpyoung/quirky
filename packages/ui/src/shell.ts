import { confirmForPlugin } from './components/ConfirmHost'
import { dismissToastByKey } from './components/Toasts'
import { Connection } from './connection'
import type { AppContextValue } from './context'
import { WindowPluginHost, type HostDeps } from './plugins/host'
import { reportedToasts } from './lib/state'
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

/** User input in the window as the browser reports it: pointer, key and wheel events. */
export function browserWindowActivity(): NonNullable<HostDeps['windowActivity']> {
  const types = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const
  return {
    subscribe(listener) {
      for (const type of types) window.addEventListener(type, listener, true)
      return () => {
        for (const type of types) window.removeEventListener(type, listener, true)
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
  windowActivity?: HostDeps['windowActivity']
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
    toast: (title, body, kind, toastOptions) =>
      store.dispatch({ type: 'toast', toast: { ...toastOptions, kind, title, body } }),
    dismissToast: (key) => dismissToastByKey({ store, plugins }, key),
    log: options.log,
    windowFocus: options.windowFocus,
    windowActivity: options.windowActivity
  })
  const reportToasts = () => {
    connection.callAny('ui.shell.report', { toasts: reportedToasts(store.getState().toasts) }).catch(() => undefined)
  }
  let reportedFrom = store.getState().toasts
  store.subscribe(() => {
    const { toasts } = store.getState()
    if (toasts === reportedFrom) return
    reportedFrom = toasts
    reportToasts()
  })
  connection.onConnected(() => {
    reportToasts()
    plugins.connected().catch((error) => options.log(`plugin refresh failed: ${error}`))
  })
  return { store, connection, plugins }
}
