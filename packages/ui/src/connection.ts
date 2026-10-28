import { QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { INITIAL_DELAY_MS, nextDelay } from './lib/backoff'
import { daemonAnswers } from './lib/probe'
import { loadDesktopClientId } from './lib/desktop-client-id'
import { parseHashToken, rpcUrl } from './lib/token'
import type { ConnectionStatus } from './lib/state'
import type { Store } from './store'

/** Consecutive socket failures after which the page checks whether the daemon is up at all. */
export const FAILURES_BEFORE_PROBE = 3

type ConnectionOptions = { initialDelayMs?: number }

function pluginStatus(status: ConnectionStatus): 'connected' | 'reconnecting' {
  return status === 'connected' ? 'connected' : 'reconnecting'
}

/**
 * Owns the daemon connection for the page: connects, keeps the store's status and toasts current
 * from events, and reconnects with backoff, running the `onConnected` listeners each time. The
 * daemon keeps its port and token across restarts, so every retry uses the same URL; after
 * repeated failures it also checks `/health` to tell a down daemon from a slow one.
 */
export class Connection {
  client: QuirkyClient | null = null
  private stopped = false
  private readonly eventListeners = new Set<(event: QuirkyEvent) => void>()
  private readonly connectedListeners = new Set<() => void>()
  private readonly statusListeners = new Set<(status: 'connected' | 'reconnecting') => void>()

  constructor(
    readonly store: Store,
    private readonly where: { hash: string; host: string } = location,
    private readonly options: ConnectionOptions = {}
  ) {}

  start(): void {
    const token = parseHashToken(this.where.hash)
    if (!token) {
      this.setStatus('no-token')
      return
    }
    void this.loop(rpcUrl(this.where.host, token))
  }

  stop(): void {
    this.stopped = true
    this.client?.close()
  }

  /** Calls any daemon or plugin method; the result is untyped. */
  callAny(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.client || this.client.isClosed) return Promise.reject(new Error('Not connected'))
    return this.client.callAny(method, params)
  }

  /** Receives every daemon event, in addition to the store dispatch; the returned function unsubscribes. */
  onEvent(listener: (event: QuirkyEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Runs after each successful (re)connect. */
  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener)
    return () => this.connectedListeners.delete(listener)
  }

  /** Binary frames of terminal stream `streamId`; the returned function unsubscribes. */
  onStream(streamId: number, listener: (bytes: Uint8Array) => void): () => void {
    if (!this.client) throw new Error('Not connected')
    return this.client.onTerminalOutput(streamId, listener)
  }

  /** Reports each change between connected and not connected; the returned function unsubscribes. */
  onStatus(listener: (status: 'connected' | 'reconnecting') => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  toastError(title: string, error: unknown): void {
    const body = error instanceof Error ? error.message : String(error)
    this.store.dispatch({ type: 'toast', toast: { kind: 'error', title, body } })
  }

  private async loop(url: string): Promise<void> {
    const initialDelay = this.options.initialDelayMs ?? INITIAL_DELAY_MS
    let delay = initialDelay
    let failures = 0
    let desktopClientId: string | undefined
    try { desktopClientId = loadDesktopClientId(globalThis.localStorage) } catch {}
    while (!this.stopped) {
      try {
        const client = await QuirkyClient.connect(url, {
          role: 'ui',
          name: 'quirky-ui',
          subscribe: true,
          ...(desktopClientId === undefined ? {} : { desktopClientId })
        })
        const closed = new Promise<void>((resolve) => client.onClose(resolve))
        client.onEvent((event) => this.handleEvent(event))
        this.client = client
        delay = initialDelay
        failures = 0
        this.setStatus('connected')
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
      this.setStatus(down ? 'unreachable' : 'reconnecting')
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

  private setStatus(status: ConnectionStatus): void {
    const was = this.store.getState().connection
    this.store.dispatch({ type: 'connection', status })
    if (pluginStatus(status) !== pluginStatus(was)) this.notify(this.statusListeners, pluginStatus(status))
  }

  private handleEvent(event: QuirkyEvent): void {
    this.notify(this.eventListeners, event)
    this.store.dispatch({ type: 'event', event })
  }
}
