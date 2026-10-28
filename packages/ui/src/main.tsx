import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppContext } from './context'
import { browserWindowActivity, browserWindowFocus, createShell } from './shell'
import { desktopBridgeForWindow, parseDesktopWindowRoute } from './desktop-bridge'
import './styles.css'

const shell = createShell({
  // the URL is only known at runtime, so the bundler must leave this import alone
  importModule: (url) => import(/* @vite-ignore */ url),
  log: (message) => console.warn(message),
  windowFocus: browserWindowFocus(),
  windowActivity: browserWindowActivity(),
  desktopBridge: desktopBridgeForWindow(),
  windowRoute: parseDesktopWindowRoute(window.location.href)
})
shell.connection.start()

createRoot(document.getElementById('root')!).render(
  <AppContext.Provider value={shell}>
    <App />
  </AppContext.Provider>
)
