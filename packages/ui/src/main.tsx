import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Connection } from './connection'
import { AppContext } from './context'
import { browserStorage, readSelection, writeSelection } from './lib/persist'
import { initialState } from './lib/state'
import { Store } from './store'
import './styles.css'

const storage = browserStorage()
const store = new Store(initialState(readSelection(storage)))
store.subscribe(() => {
  const { selectedWorktreeId, selectedSessionId, loaded } = store.getState()
  if (loaded) writeSelection(storage, { worktreeId: selectedWorktreeId, sessionId: selectedSessionId })
})
const connection = new Connection(store)
connection.start()

createRoot(document.getElementById('root')!).render(
  <AppContext.Provider value={{ store, connection }}>
    <App />
  </AppContext.Provider>
)
