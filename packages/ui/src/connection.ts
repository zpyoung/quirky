import {
  QuirkyClient,
  type MethodName,
  type ParamsOf,
  type QuirkyEvent,
  type ResultOf
} from '@quirky/protocol'
import { INITIAL_DELAY_MS, nextDelay } from './lib/backoff'
import { parseHashToken, rpcUrl } from './lib/token'
import type { Store } from './store'

/**
 * Owns the daemon connection for the page: connects, keeps the store current from events, and
 * reconnects with backoff, refetching all state each time.
 */
export class Connection {
  client: QuirkyClient | null = null
  private stopped = false

  constructor(
    readonly store: Store,
    private readonly where: { hash: string; host: string } = location
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
    let delay = INITIAL_DELAY_MS
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
        delay = INITIAL_DELAY_MS
        await this.refreshAll()
        this.store.dispatch({ type: 'connection', status: 'connected' })
        await closed
      } catch {
        this.client?.close()
      }
      this.client = null
      if (this.stopped) return
      this.store.dispatch({ type: 'connection', status: 'reconnecting' })
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = nextDelay(delay)
    }
  }

  private handleEvent(event: QuirkyEvent): void {
    if (event.type === 'repo.changed') {
      void this.refreshRepos().catch(() => {})
    } else if (event.type === 'worktree.changed') {
      void this.refreshWorktrees().catch(() => {})
    } else {
      this.store.dispatch({ type: 'event', event })
    }
  }
}
