import type { DesktopShellAction, DesktopShellBridge, QuirkyEvent } from '@quirky/protocol'
import { confirmForPlugin } from './components/ConfirmHost'
import { dismissToastByKey } from './components/Toasts'
import { Connection } from './connection'
import type { AppContextValue } from './context'
import { WindowPluginHost, type HostDeps } from './plugins/host'
import { reportedToasts } from './lib/state'
import { Store } from './store'
import { desktopBridgeForWindow, noNativeDesktopCapabilities, type DesktopWindowRoute } from './desktop-bridge'

type DesktopShellRequestEvent = Extract<QuirkyEvent, { type: 'desktop.shell.request' }>

async function answerDesktopShellRequest(
  connection: Connection,
  bridge: DesktopShellBridge | null,
  event: DesktopShellRequestEvent,
  log: (message: string) => void
): Promise<void> {
  try {
    if (!bridge) throw new Error('native desktop shell is unavailable')
    let result
    const action: DesktopShellAction = event.action
    switch (action.kind) {
      case 'folder-picker':
        if (!bridge.capabilities.directoryPicker) throw new Error('native directory selection is unavailable')
        result = await bridge.pickFolder(action.request)
        break
      case 'window-open':
        if (!bridge.capabilities.auxiliaryWindows) throw new Error('auxiliary native windows are unavailable')
        result = await bridge.openWindow(action.request, event.ownerShell)
        break
      case 'window-close':
        if (!bridge.capabilities.auxiliaryWindows) throw new Error('auxiliary native windows are unavailable')
        result = await bridge.closeWindow(action.request.windowId)
        break
      case 'window-activate-owner':
        if (!bridge.capabilities.auxiliaryWindows) throw new Error('auxiliary native windows are unavailable')
        result = await bridge.activateOwner(action.request.windowId)
        if (!result.activated) throw new Error('the owning native window could not be activated')
        break
      case 'reveal-item':
        if (!bridge.capabilities.revealItem) throw new Error('native item reveal is unavailable')
        result = await bridge.revealItem(action.request)
        break
    }
    await connection.callAny('desktop.shell.reply', { requestId: event.requestId, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'native desktop operation failed'
    await connection.callAny('desktop.shell.reply', { requestId: event.requestId, error: { message } })
      .catch((replyError) => log(`native desktop reply failed: ${replyError}`))
  }
}

function markWindowInactive(inactive: boolean): void {
  document.querySelector('.app')?.toggleAttribute('data-window-inactive', inactive)
}

/**
 * Whether the window fills its whole screen, which only native fullscreen does: a zoomed window
 * stops under the menu bar. A fullscreen window on a notched display stays under the notch too, so
 * this reads false there and the bar keeps its traffic light space, which is the safe side.
 */
export function isNativeFullscreen(view: { innerWidth: number; innerHeight: number }, screen: { width: number; height: number }): boolean {
  return view.innerWidth >= screen.width && view.innerHeight >= screen.height
}

/** Keeps `data-window-fullscreen` on `.app` in step with the window size, and returns how to stop. */
export function trackWindowFullscreen(): () => void {
  const sync = () => {
    document.querySelector('.app')?.toggleAttribute('data-window-fullscreen', isNativeFullscreen(window, window.screen))
  }
  sync()
  window.addEventListener('resize', sync)
  return () => window.removeEventListener('resize', sync)
}

/** Marks `.app` inactive when the window is not focused now; for an `.app` that mounts after the window's focus events began. */
export function syncWindowInactive(): void {
  markWindowInactive(!document.hasFocus())
}

/** Window focus as the browser reports it; also keeps `data-window-inactive` on `.app` in step. */
export function browserWindowFocus(): NonNullable<HostDeps['windowFocus']> {
  return {
    hasFocus: () => document.hasFocus(),
    subscribe(listener) {
      const gained = () => {
        markWindowInactive(false)
        listener(true)
      }
      const lost = () => {
        markWindowInactive(true)
        listener(false)
      }
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
  /** Trusted native bridge from this exact desktop window, absent in browser shells. */
  desktopBridge?: DesktopShellBridge | null
  /** A local-only route used by an auxiliary native window. */
  windowRoute?: DesktopWindowRoute | null
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
  const desktopBridge = options.desktopBridge === undefined ? desktopBridgeForWindow() : options.desktopBridge

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
    readClipboardText: desktopBridge ? () => desktopBridge.readClipboardText() : undefined,
    nativeDropPaths: desktopBridge ? (fileNames) => desktopBridge.nativeDropPaths(fileNames) : undefined,
    windowFocus: options.windowFocus,
    windowActivity: options.windowActivity,
    windowRoute: options.windowRoute
  })
  connection.onEvent((event) => {
    if (event.type === 'desktop.shell.request') {
      void answerDesktopShellRequest(connection, desktopBridge, event, options.log)
    }
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
    if (options.windowRoute) {
      connection.callAny('desktop.window.attach', {
        windowId: options.windowRoute.windowId, ownerShellConnId: options.windowRoute.ownerShellConnId
      }).catch((error) => options.log(`auxiliary window attach failed: ${error}`))
    }
    connection.callAny('desktop.shell.capabilities', desktopBridge?.capabilities ?? noNativeDesktopCapabilities())
      .catch((error) => options.log(`native desktop capabilities report failed: ${error}`))
    reportToasts()
    plugins.connected().catch((error) => options.log(`plugin refresh failed: ${error}`))
  })
  return { store, connection, plugins }
}
