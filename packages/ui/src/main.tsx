import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Connection } from './connection'
import { AppContext } from './context'
import { Store } from './store'
import './styles.css'

const store = new Store()
const connection = new Connection(store)
connection.start()

createRoot(document.getElementById('root')!).render(
  <AppContext.Provider value={{ store, connection }}>
    <App />
  </AppContext.Provider>
)
