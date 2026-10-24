import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Connection } from './connection'
import type { AppState } from './lib/state'
import type { Store } from './store'

export type AppContextValue = { store: Store; connection: Connection }

export const AppContext = createContext<AppContextValue | null>(null)

function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('AppContext is missing')
  return value
}

export function useAppState(): AppState {
  const { store } = useApp()
  return useSyncExternalStore(store.subscribe, store.getState)
}

export function useConnection(): Connection {
  return useApp().connection
}

export function useDispatch(): Store['dispatch'] {
  return useApp().store.dispatch
}
