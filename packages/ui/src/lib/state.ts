import type { QuirkyEvent, ToastAction, ToastKind, UiToastState } from '@quirky/protocol'

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unreachable'
  | 'no-token'

export type Toast = {
  id: number
  kind: ToastKind
  title: string
  body: string
  /** The view a click on the toast opens, from the `notify` event that made it. */
  open?: { view: string; input?: unknown }
  /** A new toast with the same key replaces this one without running its `onDismiss`. */
  key?: string
  persistent?: boolean
  detail?: string
  actions?: ToastAction[]
  onDismiss?: { command: string; args?: unknown }
}

/** The toasts as `ui.shell.report` sends them: what a script may see and press. */
export function reportedToasts(toasts: Toast[]): UiToastState[] {
  return toasts.map((toast) => ({
    key: toast.key ?? null,
    kind: toast.kind,
    title: toast.title,
    body: toast.body,
    detail: toast.detail ?? null,
    persistent: toast.persistent === true,
    actions: (toast.actions ?? []).map(({ label, command, args }) => ({
      label,
      command,
      ...(args !== undefined ? { args } : {})
    }))
  }))
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
  const added = { ...toast, id: state.nextToastId }
  const at = toast.key === undefined ? -1 : state.toasts.findIndex((candidate) => candidate.key === toast.key)
  return {
    ...state,
    toasts: at === -1 ? [...state.toasts, added] : state.toasts.map((candidate, index) => (index === at ? added : candidate)),
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
      return action.event.type === 'notify' && action.event.toast !== false
        ? withToast(state, {
            kind: action.event.kind ?? 'info',
            title: action.event.title,
            body: action.event.body,
            ...(action.event.open ? { open: action.event.open } : {}),
            ...(action.event.key !== undefined ? { key: action.event.key } : {}),
            ...(action.event.persistent !== undefined ? { persistent: action.event.persistent } : {}),
            ...(action.event.detail !== undefined ? { detail: action.event.detail } : {}),
            ...(action.event.actions !== undefined ? { actions: action.event.actions } : {}),
            ...(action.event.onDismiss !== undefined ? { onDismiss: action.event.onDismiss } : {})
          })
        : state
    case 'toast':
      return withToast(state, action.toast)
    case 'dismissToast':
      return state.toasts.some((t) => t.id === action.id)
        ? { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
        : state
  }
}
