import { initialState, reduce, type Action, type AppState } from './lib/state'

/** A minimal external store: a reducer over `AppState` readable through `useSyncExternalStore`. */
export class Store {
  private state: AppState
  private readonly listeners = new Set<() => void>()

  constructor(initial: AppState = initialState()) {
    this.state = initial
  }

  getState = (): AppState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispatch = (action: Action): void => {
    const next = reduce(this.state, action)
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
