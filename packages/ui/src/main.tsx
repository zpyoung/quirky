import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppContext } from './context'
import { browserWindowActivity, browserWindowFocus, createShell } from './shell'
import { desktopBridgeForWindow, parseDesktopWindowRoute } from './desktop-bridge'
import { createBrowserHost } from './browser-host'
import './styles.css'

const desktopBridge = desktopBridgeForWindow()
const windowRoute = parseDesktopWindowRoute(window.location.href)
const browserHost = desktopBridge ? null : createBrowserHost({
  openWindow: (url, target) => window.open(url, target),
  currentUrl: () => window.location.href,
  windowRoute,
  async focusOwner() {
    const opener = window.opener
    if (!opener || opener.closed) return false
    opener.focus()
    const { promise, resolve } = Promise.withResolvers<void>()
    window.setTimeout(resolve, 0)
    await promise
    try {
      return opener.document.hasFocus()
    } catch {
      return false
    }
  }
})

const shell = createShell({
  // the URL is only known at runtime, so the bundler must leave this import alone
  importModule: (url) => import(/* @vite-ignore */ url),
  log: (message) => console.warn(message),
  windowFocus: browserWindowFocus(),
  windowActivity: browserWindowActivity(),
  desktopBridge,
  browserHost,
  windowRoute
})
shell.connection.start()

createRoot(document.getElementById('root')!).render(
  <AppContext.Provider value={shell}>
    <App browserHost={browserHost} />
  </AppContext.Provider>
)
