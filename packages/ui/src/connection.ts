import {
  QuirkyClient,
  type MethodName,
  type ParamsOf,
  type QuirkyEvent,
  type ResultOf
} from '@quirky/protocol'
import { INITIAL_DELAY_MS, nextDelay } from './lib/backoff'
import { daemonAnswers } from './lib/probe'
import { parseHashToken, rpcUrl } from './lib/token'
import type { Store } from './store'

/** Consecutive socket failures after which the page checks whether the daemon is up at all. */
export const FAILURES_BEFORE_PROBE = 3

type ConnectionOptions = { initialDelayMs?: number }

/**
 * Owns the daemon connection for the page: connects, keeps the store current from events, and
 * reconnects with backoff, refetching all state each time. The daemon keeps its port and token
 * across restarts, so every retry uses the same URL; after repeated failures it also checks
 * `/health` to tell a down daemon from a slow one.
 */
export class Connection {
  client: QuirkyClient | null = null
  private stopped = false
  private readonly eventListeners = new Set<(event: QuirkyEvent) => void>()
  private readonly connectedListeners = new Set<() => void>()

  constructor(
    readonly store: Store,
    private readonly where: { hash: string; host: string } = location,
    private readonly options: ConnectionOptions = {}
  ) {}

  start(): void {
    const token = parseHashToken(this.where.hash)
    if (!token) {
      this.store.dispatch({ type: 'connection', status: 'no-token' })
      return
    }
    void this.loop(rpcUrl(this.where.host, token))
  }

  stop(): void {
    this.stopped = true
    this.client?.close()
  }

  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (!this.client || this.client.isClosed) return Promise.reject(new Error('Not connected'))
    return this.client.call(method, params)
  }

  /** Like `call`, for any method name including ones plugins provide; the result is untyped. */
  callAny(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.client || this.client.isClosed) return Promise.reject(new Error('Not connected'))
    return this.client.callAny(method, params)
  }

  /** Receives every daemon event, in addition to the store dispatch; the returned function unsubscribes. */
  onEvent(listener: (event: QuirkyEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Runs after each successful (re)connect once the store holds a fresh snapshot. */
  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener)
    return () => this.connectedListeners.delete(listener)
  }

  /** Calls a method and reports a failure as an error toast; resolves undefined on failure. */
  async attempt<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    title = 'Request failed'
  ): Promise<ResultOf<M> | undefined> {
    try {
      return await this.call(method, params)
    } catch (error) {
      this.toastError(title, error)
      return undefined
    }
  }

  toastError(title: string, error: unknown): void {
    const body = error instanceof Error ? error.message : String(error)
    this.store.dispatch({ type: 'toast', toast: { kind: 'error', title, body } })
  }

  async refreshRepos(): Promise<void> {
    const [repos, worktrees] = await Promise.all([
      this.call('repo.list', {}),
      this.call('worktree.list', {})
    ])
    this.store.dispatch({ type: 'repos', repos })
    this.store.dispatch({ type: 'worktrees', worktrees })
  }

  async refreshWorktrees(): Promise<void> {
    this.store.dispatch({ type: 'worktrees', worktrees: await this.call('worktree.list', {}) })
  }

  async refreshAll(): Promise<void> {
    const [repos, worktrees, sessions, asks, settings] = await Promise.all([
      this.call('repo.list', {}),
      this.call('worktree.list', {}),
      this.call('session.list', {}),
      this.call('ask.list', { pendingOnly: true }),
      this.call('settings.get', {})
    ])
    this.store.dispatch({ type: 'snapshot', repos, worktrees, sessions, asks, settings })
  }

  private async loop(url: string): Promise<void> {
    const initialDelay = this.options.initialDelayMs ?? INITIAL_DELAY_MS
    let delay = initialDelay
    let failures = 0
    while (!this.stopped) {
      try {
        const client = await QuirkyClient.connect(url, {
          role: 'ui',
          name: 'quirky-ui',
          subscribe: true
        })
        const closed = new Promise<void>((resolve) => client.onClose(resolve))
        client.onEvent((event) => this.handleEvent(event))
        this.client = client
        delay = initialDelay
        failures = 0
        await this.refreshAll()
        this.store.dispatch({ type: 'connection', status: 'connected' })
        this.notify(this.connectedListeners)
        await closed
      } catch {
        failures += 1
        this.client?.close()
      }
      this.client = null
      if (this.stopped) return
      const down = failures >= FAILURES_BEFORE_PROBE && !(await daemonAnswers(this.where.host))
      if (this.stopped) return
      this.store.dispatch({ type: 'connection', status: down ? 'unreachable' : 'reconnecting' })
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = nextDelay(delay)
    }
  }

  /** A throwing listener must not fail the connection loop or starve the other listeners. */
  private notify<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
    for (const listener of [...listeners]) {
      try {
        listener(...args)
      } catch {
        // listeners report their own failures
      }
    }
  }

  private handleEvent(event: QuirkyEvent): void {
    this.notify(this.eventListeners, event)
    if (event.type === 'repo.changed') {
      void this.refreshRepos().catch(() => {})
    } else if (event.type === 'worktree.changed') {
      void this.refreshWorktrees().catch(() => {})
    } else {
      this.store.dispatch({ type: 'event', event })
    }
  }
}
