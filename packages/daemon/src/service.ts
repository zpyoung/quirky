import type {
  ClientRole,
  PluginNotification,
  QuirkyEvent,
  ToolGateDecision,
  ToolGateProvider,
  ToolGateRequest
} from '@quirky/protocol'
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
  private toolGateProvider: ((agent: string) => Promise<ToolGateProvider | null>) | null = null

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

  /** Sends `event` to every subscribed client and to plugin listeners; `hook.received` and `ui.report.changed` go to plugins only. */
  broadcast(event: QuirkyEvent, excludeRole?: ClientRole): void {
    if (event.type !== 'hook.received' && event.type !== 'ui.report.changed') {
      const text = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event })
      for (const conn of this.connected) {
        if (conn.subscribed && conn.role !== excludeRole) conn.sendText(text)
      }
    }
    this.options.onEvent?.(event)
  }

  /** Hands `event` to plugin listeners without sending it to any client. */
  deliverToPlugins(event: QuirkyEvent): void {
    this.options.onEvent?.(event)
  }

  /** Sets how `requestToolGate` finds the active `tool-gate` provider; null from it means none. */
  setToolGateProvider(find: (agent: string) => Promise<ToolGateProvider | null>): void {
    this.toolGateProvider = find
  }

  /**
   * Asks the active `tool-gate` provider to decide `request`. Resolves `unavailable` when there is
   * no provider, it throws, the request deadline passes, or the provider returns an invalid
   * decision (including a blank denial or an `exitCode` outside 0 to 255). An unavailable answer
   * keeps its reason but is normalized to `encoded: null` with no `exitCode`. Never rejects and
   * never resolves to `allow` on a failure.
   */
  async requestToolGate(request: ToolGateRequest): Promise<ToolGateDecision> {
    const unavailable = (reason: string): ToolGateDecision => ({ decision: 'unavailable', reason, encoded: null })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<ToolGateDecision>((resolve) => {
      timer = setTimeout(() => {
        resolve(unavailable(`the tool gate did not answer within ${request.deadlineMs} ms`))
        controller.abort()
      }, request.deadlineMs)
    })
    const answer = (async (): Promise<ToolGateDecision> => {
      try {
        const provider = this.toolGateProvider ? await this.toolGateProvider(request.agent) : null
        if (provider === null) return unavailable('no tool gate provider is active')
        const decision = await provider(request, controller.signal)
        if (!isToolGateDecision(decision)) return unavailable('the tool gate returned an invalid decision')
        if (decision.decision === 'unavailable') {
          return { decision: 'unavailable', reason: decision.reason, encoded: null }
        }
        if (decision.decision === 'deny' && typeof decision.encoded === 'string' && /^[ \t\r\n]*$/.test(decision.encoded)) {
          return unavailable('the tool gate returned an invalid decision')
        }
        return decision
      } catch (error) {
        return unavailable(`the tool gate failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    try {
      return await Promise.race([answer, deadline])
    } finally {
      clearTimeout(timer)
    }
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

function isToolGateDecision(value: unknown): value is ToolGateDecision {
  if (typeof value !== 'object' || value === null) return false
  const { decision, reason, encoded, exitCode } = value as Record<string, unknown>
  return (
    (decision === 'allow' || decision === 'deny' || decision === 'passthrough' || decision === 'unavailable') &&
    typeof reason === 'string' &&
    (encoded === null || typeof encoded === 'string') &&
    (exitCode === undefined ||
      (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255))
  )
}
