import type { QuirkyEvent } from '@quirky/protocol'

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unreachable'
  | 'no-token'

export type Toast = {
  id: number
  kind: 'info' | 'error'
  title: string
  body: string
  /** The view a click on the toast opens, from the `notify` event that made it. */
  open?: { view: string; input?: unknown }
}

/** What the shell itself keeps: connection status and toasts. Layout is the daemon's, held by the plugin host. */
export type AppState = {
  connection: ConnectionStatus
  /** Counts successful connects, so a view can tell a reconnect from a re-render. */
  epoch: number
  toasts: Toast[]
  nextToastId: number
}

export type Action =
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'event'; event: QuirkyEvent }
  | { type: 'toast'; toast: Omit<Toast, 'id'> }
  | { type: 'dismissToast'; id: number }

export function initialState(): AppState {
  return { connection: 'connecting', epoch: 0, toasts: [], nextToastId: 1 }
}

function withToast(state: AppState, toast: Omit<Toast, 'id'>): AppState {
  return {
    ...state,
    toasts: [...state.toasts, { ...toast, id: state.nextToastId }],
    nextToastId: state.nextToastId + 1
  }
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'connection':
      return {
        ...state,
        connection: action.status,
        epoch: action.status === 'connected' ? state.epoch + 1 : state.epoch
      }
    case 'event':
      return action.event.type === 'notify'
        ? withToast(state, {
            kind: 'info',
            title: action.event.title,
            body: action.event.body,
            ...(action.event.open ? { open: action.event.open } : {})
          })
        : state
    case 'toast':
      return withToast(state, action.toast)
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
  }
}
