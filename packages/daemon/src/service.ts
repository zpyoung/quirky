import type { PluginNotification, QuirkyEvent } from '@quirky/protocol'
import { sendNotification, type Notifier } from './notify'
import type { PtyClient } from './pty-client'
import type { ClientConn } from './types'

export type CoreOptions = {
  home: string
  pty: PtyClient
  notifier: Notifier
  daemonVersion: string
  startedAt: number
  hookToken: string
  hookUrl: () => string
  /** True when the daemon runs in safe mode; reported by `status`. */
  safeMode?: boolean
  /** The unix socket path the daemon listens on, or null; reported by `status`. */
  socketPath?: string | null
  /** Called after a client connection is removed. */
  onRemoveClient?: (conn: ClientConn) => void
  /** Called at the end of `broadcast` with every event. */
  onEvent?: (event: QuirkyEvent) => void
}

/**
 * The kernel's shared state: who is connected, how events reach them and the daemon's status.
 * Features live in plugins and reach the kernel through their context, never through here.
 */
export class Core {
  private readonly connected = new Set<ClientConn>()

  constructor(private readonly options: CoreOptions) {}

  get home(): string {
    return this.options.home
  }

  get hookToken(): string {
    return this.options.hookToken
  }

  /** The loopback URL agents post hooks to, as the daemon is listening now. */
  get hookUrl(): string {
    return this.options.hookUrl()
  }

  get pty(): PtyClient {
    return this.options.pty
  }

  addClient(conn: ClientConn): void {
    this.connected.add(conn)
  }

  /** Forgets `conn` and closes every stream a plugin opened on it. */
  removeClient(conn: ClientConn): void {
    conn.closed = true
    this.connected.delete(conn)
    conn.streams.clear()
    for (const close of [...conn.streamClosers.values()]) close()
    this.options.onRemoveClient?.(conn)
  }

  /** The currently connected clients, in connection order. */
  clients(): ClientConn[] {
    return [...this.connected]
  }

  /** Sends one event to one connection, whether or not it subscribed. */
  sendTo(conn: ClientConn, event: QuirkyEvent): void {
    if (conn.closed) return
    conn.sendText(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event }))
  }

  /** Sends `event` to every subscribed client and to plugin listeners; `hook.received` goes to plugins only. */
  broadcast(event: QuirkyEvent): void {
    if (event.type !== 'hook.received') {
      const text = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event })
      for (const conn of this.connected) {
        if (conn.subscribed) conn.sendText(text)
      }
    }
    this.options.onEvent?.(event)
  }

  /** Hands `event` to plugin listeners without sending it to any client. */
  deliverToPlugins(event: QuirkyEvent): void {
    this.options.onEvent?.(event)
  }

  status() {
    return {
      daemonVersion: this.options.daemonVersion,
      pid: process.pid,
      startedAt: this.options.startedAt,
      home: this.options.home,
      ptyHost: { pid: this.options.pty.hostPid, alive: this.options.pty.connected },
      clients: [...this.connected]
        .filter((conn) => conn.role !== null)
        .map((conn) => ({ role: conn.role!, ...(conn.name ? { name: conn.name } : {}) })),
      safeMode: this.options.safeMode ?? false,
      socket: this.options.socketPath ?? null
    }
  }

  /**
   * Broadcasts a `notify` event and, when `n.desktop` is not false and no desktop client is
   * connected, shows an OS notification through the daemon's notifier.
   */
  notify(n: PluginNotification): void {
    sendNotification(
      {
        broadcast: (event) => this.broadcast(event),
        hasDesktopClient: () => [...this.connected].some((conn) => conn.role === 'desktop'),
        notifier: this.options.notifier
      },
      n
    )
  }
}
