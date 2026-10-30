import { useSyncExternalStore } from 'react'
import type { Ask, AskAnswer, AskEnvelope, QuirkyEvent, Repo, Session, Worktree } from '@quirky/protocol'
import type { Connection } from '../connection'
import { useConnection, usePluginHost } from '../context'
import type { WindowPluginHost } from '../plugins/host'

export const INBOX_TOOL_ID = 'host:inbox'
export const WORKTREE_VIEW_ID = 'view:quirky.session/worktree'
export const ATTENTION_TOAST_MS = 8000

export type AttentionClock = {
  setTimeout(run: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

type SnapshotError = 'repos' | 'worktrees' | 'sessions' | 'asks'
export type AttentionToast = {
  ask: Ask
  phase: 'ready' | 'answering' | 'failed'
  error?: string
}
/** A project's own name, mark and tile color as set in its project settings; each is null until set. */
export type ProjectIdentity = { displayName: string | null; icon: string | null; color: string | null }
export type AttentionSnapshot = {
  repos: Repo[] | null
  worktrees: Worktree[] | null
  sessions: Session[] | null
  asks: Ask[] | null
  selectedWorktreeId: string | null
  /** Projects the Worktrees panel and the worktree switcher are narrowed to; empty means All projects. */
  filterRepoIds: string[]
  projectIdentities: Record<string, ProjectIdentity>
  errors: Partial<Record<SnapshotError, string>>
  toasts: AttentionToast[]
}

type AttentionConnection = Pick<Connection, 'callAny' | 'onEvent' | 'onConnected'>
type AttentionHost = Pick<WindowPluginHost, 'getState' | 'subscribe' | 'openView' | 'openTool'>

export type AttentionStore = {
  getSnapshot(): AttentionSnapshot
  subscribe(listener: () => void): () => void
  refresh(): void
  answer(askId: string, answers: Record<string, AskAnswer>, skipped: string[]): Promise<string | null>
  openDelegatedQuestion(askId: string): Promise<boolean>
  openInbox(): void
  dismissToast(askId: string): void
  /**
   * Narrows the view to one project, or back to All projects with null. When the selected worktree
   * falls outside the project, opens its most recently active worktree. Resolves to an error
   * message, or null on success.
   */
  selectProject(repoId: string | null): Promise<string | null>
  /** Opens `worktreeId` in this window; the daemon returns the view to All projects when it is hidden. */
  openWorktree(worktreeId: string): Promise<string | null>
  /** Opens the neighbouring worktree in this window's navigation history. */
  navigateHistory(direction: 'back' | 'forward'): Promise<string | null>
}

const systemClock: AttentionClock = {
  setTimeout: (run, delay) => setTimeout(run, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function filterIdsOf(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null) return null
  const ids = (value as { filterRepoIds?: unknown }).filterRepoIds
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? ids as string[] : null
}

function identitiesOf(value: unknown): Record<string, ProjectIdentity> | null {
  if (!Array.isArray(value)) return null
  const identities: Record<string, ProjectIdentity> = {}
  const text = (field: unknown) => typeof field === 'string' ? field : null
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const { repoId, identity } = item as { repoId?: unknown; identity?: unknown }
    if (typeof repoId !== 'string' || typeof identity !== 'object' || identity === null) return null
    const fields = identity as Record<string, unknown>
    identities[repoId] = { displayName: text(fields.displayName), icon: text(fields.icon), color: text(fields.color) }
  }
  return identities
}

const sameIds = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index])
const sameIdentities = (left: Record<string, ProjectIdentity>, right: Record<string, ProjectIdentity>) =>
  JSON.stringify(left) === JSON.stringify(right)

async function windowIdOf(connection: Pick<Connection, 'callAny'>): Promise<number> {
  const self = await connection.callAny('ui.window.self', {})
  if (typeof self !== 'object' || self === null || !('connId' in self) ||
    typeof self.connId !== 'number' || !Number.isSafeInteger(self.connId) || self.connId < 1) {
    throw new Error('The daemon did not identify this window.')
  }
  return self.connId
}

function askFromEvent(event: QuirkyEvent): Ask | null {
  if (!('data' in event) || typeof event.data !== 'object' || event.data === null) return null
  const ask = (event.data as { ask?: unknown }).ask
  if (typeof ask !== 'object' || ask === null || Array.isArray(ask)) return null
  const candidate = ask as Partial<Ask>
  return typeof candidate.id === 'string' && typeof candidate.createdAt === 'number' && candidate.spec !== undefined
    ? candidate as Ask
    : null
}

function answerEnvelope(value: unknown): AskEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const envelope = value as Partial<AskEnvelope>
  return typeof envelope.askId === 'string' && typeof envelope.status === 'string' ? value as AskEnvelope : null
}

/** One canonical, per-window projection of public project/worktree/session/ask state and attention toasts. */
export function createAttentionStore(
  connection: AttentionConnection,
  host: AttentionHost,
  clock: AttentionClock = systemClock
): AttentionStore {
  const listeners = new Set<() => void>()
  const versions: Record<SnapshotError, number> = { repos: 0, worktrees: 0, sessions: 0, asks: 0 }
  const announced = new Set<string>()
  const toastTimers = new Map<string, unknown>()
  let state: AttentionSnapshot = {
    repos: null,
    worktrees: null,
    sessions: null,
    asks: null,
    selectedWorktreeId: host.getState().layout.worktree ?? null,
    filterRepoIds: [],
    projectIdentities: {},
    errors: {},
    toasts: []
  }
  let active = false
  let unsubscribeEvents: (() => void) | undefined
  let unsubscribeConnected: (() => void) | undefined
  let unsubscribeHost: (() => void) | undefined

  const publish = (patch: Partial<AttentionSnapshot>) => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const setError = (key: SnapshotError, error?: string) => {
    const errors = { ...state.errors }
    if (error === undefined) delete errors[key]
    else errors[key] = error
    publish({ errors })
  }

  const fetchList = async <T,>(key: SnapshotError, method: string, params: Record<string, unknown> = {}): Promise<T[] | null> => {
    const version = ++versions[key]
    try {
      const value = await connection.callAny(method, params)
      if (!Array.isArray(value)) throw new Error(`${method} returned an invalid list`)
      if (!active || version !== versions[key]) return null
      setError(key)
      return value as T[]
    } catch (error) {
      if (active && version === versions[key]) setError(key, messageOf(error))
      return null
    }
  }

  const refreshInventory = async () => {
    const [repos, worktrees] = await Promise.all([
      fetchList<Repo>('repos', 'quirky.repo/list', {}),
      fetchList<Worktree>('worktrees', 'quirky.worktree/list', {})
    ])
    if (!active) return
    publish({
      ...(repos === null ? {} : { repos }),
      ...(worktrees === null ? {} : { worktrees })
    })
  }

  let scopeVersion = 0
  const setFilter = (filterRepoIds: string[]) => {
    scopeVersion += 1
    if (!sameIds(state.filterRepoIds, filterRepoIds)) publish({ filterRepoIds })
  }

  const refreshScope = async () => {
    const version = ++scopeVersion
    try {
      const ids = filterIdsOf(await connection.callAny('quirky.worktree/options', {}))
      if (active && version === scopeVersion && ids !== null) setFilter(ids)
    } catch {
      // the worktree plugin may be absent; the scope then stays All projects
    }
  }

  const refreshIdentities = async () => {
    try {
      const identities = identitiesOf(await connection.callAny('quirky.worktree/projectMetadataList', {}))
      if (active && identities !== null && !sameIdentities(state.projectIdentities, identities)) publish({ projectIdentities: identities })
    } catch {
      // identities only decorate the switcher; the repo name and a generated tile stand in
    }
  }

  const refreshSessions = async () => {
    const sessions = await fetchList<Session>('sessions', 'quirky.session/list', {})
    if (active && sessions !== null) publish({ sessions })
  }

  const clearToastTimer = (askId: string) => {
    const timer = toastTimers.get(askId)
    if (timer === undefined) return
    clock.clearTimeout(timer)
    toastTimers.delete(askId)
  }

  const dismissToast = (askId: string) => {
    clearToastTimer(askId)
    if (!state.toasts.some((toast) => toast.ask.id === askId)) return
    publish({ toasts: state.toasts.filter((toast) => toast.ask.id !== askId) })
  }
  const failToast = (askId: string, error: string) => {
    clearToastTimer(askId)
    if (!state.toasts.some((toast) => toast.ask.id === askId)) return
    publish({
      toasts: state.toasts.map((toast) => toast.ask.id === askId ? { ...toast, phase: 'failed', error } : toast)
    })
  }

  const showToast = (ask: Ask) => {
    if (announced.has(ask.id) || ask.queued) return
    announced.add(ask.id)
    if (ask.worktreeId === null || ask.worktreeId === state.selectedWorktreeId) return
    clearToastTimer(ask.id)
    const toasts = state.toasts.filter((toast) => toast.ask.id !== ask.id)
    publish({ toasts: [...toasts, { ask, phase: 'ready' }] })
    const timer = clock.setTimeout(() => dismissToast(ask.id), ATTENTION_TOAST_MS)
    toastTimers.set(ask.id, timer)
  }

  const refreshAsks = async () => {
    const asks = await fetchList<Ask>('asks', 'quirky.ask/list', { pendingOnly: true })
    if (!active || asks === null) return
    const pending = asks
      .filter((ask) => ask.envelope.status === 'pending')
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
    const pendingIds = new Set(pending.map((ask) => ask.id))
    const toasts = state.toasts.filter((toast) => pendingIds.has(toast.ask.id))
    for (const toast of state.toasts) {
      if (!pendingIds.has(toast.ask.id)) {
        clearToastTimer(toast.ask.id)
        announced.delete(toast.ask.id)
      }
    }
    publish({ asks: pending, toasts })
  }

  const refresh = () => {
    if (!active) return
    void refreshInventory()
    void refreshSessions()
    void refreshAsks()
    void refreshScope()
    void refreshIdentities()
  }

  const updateSelection = () => {
    const selectedWorktreeId = host.getState().layout.worktree ?? null
    if (state.selectedWorktreeId !== selectedWorktreeId) publish({ selectedWorktreeId })
  }

  const onEvent = (event: QuirkyEvent) => {
    switch (event.type) {
      case 'quirky.repo/changed':
      case 'quirky.worktree/changed':
        void refreshInventory()
        break
      case 'quirky.worktree/projectMetadataChanged':
        void refreshInventory()
        void refreshIdentities()
        break
      case 'quirky.worktree/optionsChanged': {
        const options = 'data' in event && typeof event.data === 'object' && event.data !== null
          ? (event.data as { options?: unknown }).options
          : undefined
        const ids = filterIdsOf(options)
        if (ids === null) void refreshScope()
        else setFilter(ids)
        break
      }
      case 'quirky.session/changed':
      case 'quirky.session/removed':
        void refreshSessions()
        break
      case 'quirky.ask/created':
      case 'quirky.ask/surfaced':
      case 'quirky.ask/updated': {
        updateSelection()
        const ask = askFromEvent(event)
        if (ask?.envelope.status === 'pending') {
          const pending = state.asks?.filter((candidate) => candidate.id !== ask.id) ?? []
          pending.push(ask)
          pending.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
          publish({ asks: pending })
          if (event.type === 'quirky.ask/created' || event.type === 'quirky.ask/surfaced') showToast(ask)
        }
        void refreshAsks()
        break
      }
      case 'quirky.ask/resolved':
        if ('data' in event && typeof event.data === 'object' && event.data !== null) {
          const askId = (event.data as { askId?: unknown }).askId
          if (typeof askId === 'string') {
            announced.delete(askId)
            dismissToast(askId)
          }
        }
        void refreshAsks()
        break
    }
  }

  const start = () => {
    if (active) return
    active = true
    updateSelection()
    unsubscribeEvents = connection.onEvent(onEvent)
    unsubscribeConnected = connection.onConnected(() => refresh())
    unsubscribeHost = host.subscribe(updateSelection)
    refresh()
  }

  const stop = () => {
    if (!active) return
    active = false
    unsubscribeEvents?.()
    unsubscribeConnected?.()
    unsubscribeHost?.()
    unsubscribeEvents = undefined
    unsubscribeConnected = undefined
    unsubscribeHost = undefined
    for (const askId of toastTimers.keys()) clearToastTimer(askId)
  }

  const openDelegatedQuestion = async (askId: string): Promise<boolean> => {
    const ask = state.asks?.find((candidate) => candidate.id === askId)
    if (!ask?.handoff || !ask.sessionId) {
      failToast(askId, 'The exact delegated session is unavailable.')
      return false
    }
    clearToastTimer(askId)
    if (state.toasts.some((toast) => toast.ask.id === askId)) {
      publish({ toasts: state.toasts.map((toast) => toast.ask.id === askId ? { ...toast, phase: 'answering', error: undefined } : toast) })
    }
    let worktreeId = ask.worktreeId
    if (!worktreeId) {
      try {
        const session = await connection.callAny('quirky.session/get', { session: ask.sessionId })
        if (typeof session !== 'object' || session === null || !('worktreeId' in session) || typeof session.worktreeId !== 'string') {
          throw new Error('The delegated session has no worktree view.')
        }
        worktreeId = session.worktreeId
      } catch (error) {
        const message = messageOf(error)
        setError('sessions', message)
        failToast(askId, message)
        return false
      }
    }
    try {
      host.openView(WORKTREE_VIEW_ID, { worktree: worktreeId, session: ask.sessionId })
      dismissToast(askId)
      return true
    } catch (error) {
      failToast(askId, messageOf(error))
      return false
    }
  }

  const answer = async (askId: string, answers: Record<string, AskAnswer>, skipped: string[]): Promise<string | null> => {
    const ask = state.asks?.find((candidate) => candidate.id === askId)
    if (!ask) return 'This question is no longer pending.'
    if (ask.handoff) return 'Open the delegated question in its session to answer it.'
    const toast = state.toasts.find((candidate) => candidate.ask.id === askId)
    clearToastTimer(askId)
    if (toast) publish({ toasts: state.toasts.map((candidate) => candidate.ask.id === askId ? { ...candidate, phase: 'answering', error: undefined } : candidate) })
    try {
      const envelope = answerEnvelope(await connection.callAny('quirky.ask/answer', { askId, answers, skipped }))
      if (!envelope) throw new Error('quirky.ask/answer returned an invalid response')
      if (envelope.status === 'pending') {
        if (toast && state.toasts.some((candidate) => candidate.ask.id === askId)) {
          publish({ toasts: state.toasts.map((candidate) => candidate.ask.id === askId ? { ...candidate, phase: 'ready', error: undefined } : candidate) })
          const timer = clock.setTimeout(() => dismissToast(askId), ATTENTION_TOAST_MS)
          toastTimers.set(askId, timer)
        }
      } else {
        announced.delete(askId)
        dismissToast(askId)
      }
      return null
    } catch (error) {
      const message = messageOf(error)
      await refreshAsks()
      if (state.asks !== null && !state.errors.asks && !state.asks.some((candidate) => candidate.id === askId)) {
        announced.delete(askId)
        dismissToast(askId)
      } else {
        failToast(askId, message)
      }
      return message
    }
  }

  const openWorktree = async (worktreeId: string): Promise<string | null> => {
    try {
      const window = await windowIdOf(connection)
      await connection.callAny('quirky.worktree/navigate', { worktree: worktreeId, window })
      return null
    } catch (error) {
      return messageOf(error)
    }
  }

  const selectProject = async (repoId: string | null): Promise<string | null> => {
    const filterRepoIds = repoId === null ? [] : [repoId]
    try {
      await connection.callAny('quirky.worktree/setOptions', { filterRepoIds })
    } catch (error) {
      return messageOf(error)
    }
    setFilter(filterRepoIds)
    if (repoId === null) return null
    const selected = state.worktrees?.find((worktree) => worktree.id === state.selectedWorktreeId)
    if (selected?.repoId === repoId) return null
    const mostRecent = (state.worktrees ?? [])
      .filter((worktree) => worktree.repoId === repoId && !worktree.removing)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id))[0]
    return mostRecent ? openWorktree(mostRecent.id) : null
  }

  const navigateHistory = async (direction: 'back' | 'forward'): Promise<string | null> => {
    try {
      const window = await windowIdOf(connection)
      await connection.callAny(direction === 'back' ? 'quirky.worktree/navigationBack' : 'quirky.worktree/navigationForward', { window })
      return null
    } catch (error) {
      return messageOf(error)
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    refresh,
    answer,
    openDelegatedQuestion,
    openInbox: () => host.openTool(INBOX_TOOL_ID),
    dismissToast,
    selectProject,
    openWorktree,
    navigateHistory
  }
}

const stores = new WeakMap<Connection, AttentionStore>()

/** One store is shared by window bar, status bar, Inbox and toast consumers in this exact window. */
export function attentionStoreFor(connection: Connection, host: WindowPluginHost): AttentionStore {
  let store = stores.get(connection)
  if (!store) {
    store = createAttentionStore(connection, host)
    stores.set(connection, store)
  }
  return store
}

export function useAttention(): { snapshot: AttentionSnapshot; store: AttentionStore } {
  const connection = useConnection()
  const host = usePluginHost()
  const store = attentionStoreFor(connection, host)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { snapshot, store }
}
