import type {
  Ask,
  Repo,
  Session,
  Settings,
  StructuredMessage,
  QuirkyEvent,
  Worktree
} from '@quirky/protocol'

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
  sessionId?: string
  worktreeId?: string
}

export type AppState = {
  connection: ConnectionStatus
  epoch: number
  repos: Repo[]
  worktrees: Worktree[]
  sessions: Session[]
  asks: Ask[]
  settings: Settings | null
  selectedWorktreeId: string | null
  selectedSessionId: string | null
  lastSessionByWorktree: Record<string, string>
  structured: Record<string, StructuredMessage[]>
  toasts: Toast[]
  nextToastId: number
  scmOpen: boolean
  /** True once the first snapshot arrived; before it, a restored selection must not be reset. */
  loaded: boolean
}

export type Action =
  | { type: 'connection'; status: ConnectionStatus }
  | {
      type: 'snapshot'
      repos: Repo[]
      worktrees: Worktree[]
      sessions: Session[]
      asks: Ask[]
      settings: Settings
    }
  | { type: 'repos'; repos: Repo[] }
  | { type: 'worktrees'; worktrees: Worktree[] }
  | { type: 'session'; session: Session }
  | { type: 'event'; event: QuirkyEvent }
  | { type: 'selectWorktree'; id: string | null }
  | { type: 'selectSession'; id: string | null }
  | { type: 'structured'; sessionId: string; messages: StructuredMessage[] }
  | { type: 'toast'; toast: Omit<Toast, 'id'> }
  | { type: 'dismissToast'; id: number }
  | { type: 'toggleScm' }
  | { type: 'settings'; settings: Settings }

export function initialState(selection?: {
  worktreeId: string | null
  sessionId: string | null
}): AppState {
  return {
    connection: 'connecting',
    epoch: 0,
    repos: [],
    worktrees: [],
    sessions: [],
    asks: [],
    settings: null,
    selectedWorktreeId: selection?.worktreeId ?? null,
    selectedSessionId: selection?.sessionId ?? null,
    lastSessionByWorktree: {},
    structured: {},
    toasts: [],
    nextToastId: 1,
    scmOpen: false,
    loaded: false
  }
}

export function sessionsOf(state: AppState, worktreeId: string | null): Session[] {
  if (!worktreeId) return []
  return state.sessions.filter((s) => s.worktreeId === worktreeId)
}

function sortWorktrees(worktrees: Worktree[]): Worktree[] {
  return [...worktrees].sort(
    (a, b) =>
      a.repoId.localeCompare(b.repoId) ||
      Number(b.isMain) - Number(a.isMain) ||
      a.name.localeCompare(b.name)
  )
}

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => a.createdAt - b.createdAt)
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((existing) => existing.id === item.id)
  if (index === -1) return [...list, item]
  const next = list.slice()
  next[index] = item
  return next
}

/** Keeps the selection pointing at things that exist, falling back to the first available. */
function normalizeSelection(state: AppState): AppState {
  if (!state.loaded) return state
  let worktreeId = state.selectedWorktreeId
  if (!worktreeId || !state.worktrees.some((w) => w.id === worktreeId)) {
    worktreeId = state.worktrees[0]?.id ?? null
  }
  const sessions = sessionsOf(state, worktreeId)
  let sessionId = state.selectedSessionId
  if (!sessionId || !sessions.some((s) => s.id === sessionId)) {
    const remembered = worktreeId ? state.lastSessionByWorktree[worktreeId] : undefined
    sessionId = sessions.find((s) => s.id === remembered)?.id ?? sessions[0]?.id ?? null
  }
  if (worktreeId === state.selectedWorktreeId && sessionId === state.selectedSessionId) return state
  return { ...state, selectedWorktreeId: worktreeId, selectedSessionId: sessionId }
}

function withToast(state: AppState, toast: Omit<Toast, 'id'>): AppState {
  return {
    ...state,
    toasts: [...state.toasts, { ...toast, id: state.nextToastId }],
    nextToastId: state.nextToastId + 1
  }
}

function appendMessages(
  existing: StructuredMessage[] | undefined,
  incoming: StructuredMessage[]
): StructuredMessage[] {
  const bySeq = new Map((existing ?? []).map((m) => [m.seq, m]))
  for (const message of incoming) if (!bySeq.has(message.seq)) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function reduceEvent(state: AppState, event: QuirkyEvent): AppState {
  switch (event.type) {
    case 'session.changed':
      return reduce(state, { type: 'session', session: event.session })
    case 'session.removed': {
      const { [event.sessionId]: _dropped, ...structured } = state.structured
      return normalizeSelection({
        ...state,
        sessions: state.sessions.filter((s) => s.id !== event.sessionId),
        structured
      })
    }
    case 'ask.created':
      return { ...state, asks: upsert(state.asks, event.ask) }
    case 'ask.resolved':
      return { ...state, asks: state.asks.filter((a) => a.id !== event.askId) }
    case 'notify':
      return withToast(state, {
        kind: 'info',
        title: event.title,
        body: event.body,
        sessionId: event.sessionId,
        worktreeId: event.worktreeId
      })
    case 'structured.message':
      return {
        ...state,
        structured: {
          ...state.structured,
          [event.message.sessionId]: appendMessages(state.structured[event.message.sessionId], [
            event.message
          ])
        }
      }
    default:
      return state
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
    case 'snapshot':
      return normalizeSelection({
        ...state,
        repos: [...action.repos].sort((a, b) => a.addedAt - b.addedAt),
        worktrees: sortWorktrees(action.worktrees),
        sessions: sortSessions(action.sessions),
        asks: action.asks,
        settings: action.settings,
        loaded: true
      })
    case 'repos':
      return { ...state, repos: [...action.repos].sort((a, b) => a.addedAt - b.addedAt) }
    case 'worktrees':
      return normalizeSelection({ ...state, worktrees: sortWorktrees(action.worktrees) })
    case 'session':
      return normalizeSelection({
        ...state,
        sessions: sortSessions(upsert(state.sessions, action.session))
      })
    case 'event':
      return reduceEvent(state, action.event)
    case 'selectWorktree': {
      const next = normalizeSelection({
        ...state,
        selectedWorktreeId: action.id,
        selectedSessionId: null
      })
      return next
    }
    case 'selectSession': {
      const session = state.sessions.find((s) => s.id === action.id)
      if (!session) return state
      return {
        ...state,
        selectedWorktreeId: session.worktreeId,
        selectedSessionId: session.id,
        lastSessionByWorktree: { ...state.lastSessionByWorktree, [session.worktreeId]: session.id }
      }
    }
    case 'structured':
      return {
        ...state,
        structured: {
          ...state.structured,
          [action.sessionId]: appendMessages(state.structured[action.sessionId], action.messages)
        }
      }
    case 'toast':
      return withToast(state, action.toast)
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case 'toggleScm':
      return { ...state, scmOpen: !state.scmOpen }
    case 'settings':
      return { ...state, settings: action.settings }
  }
}
