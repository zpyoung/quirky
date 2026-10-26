import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Connection } from './connection'
import { AppContext } from './context'
import { browserStorage, readSelection, writeSelection } from './lib/persist'
import { initialState } from './lib/state'
import { WindowPluginHost } from './plugins/host'
import { Store } from './store'
import './styles.css'

const storage = browserStorage()
const store = new Store(initialState(readSelection(storage)))
store.subscribe(() => {
  const { selectedWorktreeId, selectedSessionId, loaded } = store.getState()
  if (loaded) writeSelection(storage, { worktreeId: selectedWorktreeId, sessionId: selectedSessionId })
})
const connection = new Connection(store)
const plugins = new WindowPluginHost({
  call: (method, params) => connection.callAny(method, params),
  onEvent: (listener) => connection.onEvent(listener),
  // the URL is only known at runtime, so the bundler must leave this import alone
  importModule: (url) => import(/* @vite-ignore */ url),
  toast: (title, body) => store.dispatch({ type: 'toast', toast: { kind: 'error', title, body } }),
  log: (message) => console.warn(message)
})
connection.onConnected(() => {
  plugins.refresh().catch((error) => console.warn(`plugin refresh failed: ${error}`))
})
connection.start()

createRoot(document.getElementById('root')!).render(
  <AppContext.Provider value={{ store, connection, plugins }}>
    <App />
  </AppContext.Provider>
)
