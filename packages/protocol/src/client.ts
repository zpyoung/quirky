import { decodeTerminalOutput } from './frames'
import {
  PROTOCOL_VERSION,
  type ClientRole,
  type MethodName,
  type ParamsOf,
  type QuirkyEvent,
  type ResultOf,
  type RpcFailure,
  type RpcNotification,
  type RpcSuccess
} from './rpc'

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** The connection dropped before a reply arrived; the call may or may not have run. */
export class ConnectionLost extends Error {
  constructor(message = 'quirkyd connection closed') {
    super(message)
    this.name = 'ConnectionLost'
  }
}

/** Per-call options; `requestId` lets the daemon return the first outcome of a repeated call. */
export type CallOptions = { requestId?: string }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

// frames can land before the caller registers a handler for a fresh stream id
const MAX_BUFFERED_BYTES_PER_STREAM = 4 * 1024 * 1024

/**
 * A daemon connection over WebSocket. Works in browsers and in Bun, since both have a global
 * WebSocket. `url` is the full `ws://127.0.0.1:<port>/rpc?token=<token>`.
 */
export class QuirkyClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventHandlers = new Set<(event: QuirkyEvent) => void>()
  private readonly closeHandlers = new Set<() => void>()
  private readonly streamHandlers = new Map<number, (bytes: Uint8Array) => void>()
  private readonly streamBuffers = new Map<number, Uint8Array[]>()
  private closed = false

  private constructor(private readonly socket: WebSocket) {
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('message', (event) => this.handleMessage(event.data))
    socket.addEventListener('close', () => this.handleClose())
  }

  static connect(
    url: string,
    hello: {
      role: ClientRole
      name?: string
      subscribe?: boolean
      token?: string
      cwd?: string
      sessionId?: string
      worktreeId?: string
    } = { role: 'ui' }
  ): Promise<QuirkyClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const fail = () => reject(new Error(`could not connect to quirkyd at ${redactToken(url)}`))
      socket.addEventListener('error', fail, { once: true })
      socket.addEventListener(
        'open',
        () => {
          socket.removeEventListener('error', fail)
          const client = new QuirkyClient(socket)
          client
            .call('client.hello', {
              role: hello.role,
              name: hello.name,
              protocolVersion: PROTOCOL_VERSION,
              ...(hello.token !== undefined ? { token: hello.token } : {}),
              ...(hello.cwd !== undefined ? { cwd: hello.cwd } : {}),
              ...(hello.sessionId !== undefined ? { sessionId: hello.sessionId } : {}),
              ...(hello.worktreeId !== undefined ? { worktreeId: hello.worktreeId } : {})
            })
            .then(async () => {
              if (hello.subscribe) await client.call('events.subscribe', {})
              resolve(client)
            })
            .catch((error) => {
              client.close()
              reject(error)
            })
        },
        { once: true }
      )
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  call<M extends MethodName>(method: M, params: ParamsOf<M>, options?: CallOptions): Promise<ResultOf<M>> {
    return this.send(method, params, options) as Promise<ResultOf<M>>
  }

  /** Like `call`, but for any method name, including ones plugins provide; the result is untyped. */
  callAny(method: string, params: Record<string, unknown>, options?: CallOptions): Promise<unknown> {
    return this.send(method, params, options)
  }

  private send(method: string, params: unknown, options?: CallOptions): Promise<unknown> {
    if (this.closed) return Promise.reject(new ConnectionLost('quirkyd connection is closed'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const requestId = options?.requestId
      this.socket.send(
        JSON.stringify({ jsonrpc: '2.0', id, method, params, ...(requestId !== undefined ? { requestId } : {}) })
      )
    })
  }

  onEvent(handler: (event: QuirkyEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  /** Receives a terminal stream's bytes, including any that arrived before this call. */
  onTerminalOutput(streamId: number, handler: (bytes: Uint8Array) => void): () => void {
    this.streamHandlers.set(streamId, handler)
    const buffered = this.streamBuffers.get(streamId)
    this.streamBuffers.delete(streamId)
    for (const bytes of buffered ?? []) handler(bytes)
    return () => {
      if (this.streamHandlers.get(streamId) === handler) this.streamHandlers.delete(streamId)
      this.streamBuffers.delete(streamId)
    }
  }

  close(): void {
    if (this.closed) return
    this.socket.close()
    this.handleClose()
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      const frame = decodeTerminalOutput(data as ArrayBuffer)
      if (!frame) return
      const handler = this.streamHandlers.get(frame.streamId)
      if (handler) {
        handler(frame.bytes)
        return
      }
      const buffer = this.streamBuffers.get(frame.streamId) ?? []
      const size = buffer.reduce((sum, chunk) => sum + chunk.length, 0)
      if (size + frame.bytes.length <= MAX_BUFFERED_BYTES_PER_STREAM) {
        buffer.push(frame.bytes.slice())
        this.streamBuffers.set(frame.streamId, buffer)
      }
      return
    }
    let message: RpcSuccess | RpcFailure | RpcNotification
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if ('method' in message && message.method === 'event') {
      for (const handler of this.eventHandlers) handler(message.params)
      return
    }
    if (!('id' in message) || message.id === null) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if ('error' in message) {
      pending.reject(new RpcError(message.error.code, message.error.message, message.error.data))
    } else {
      pending.resolve(message.result)
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const { reject } of this.pending.values()) reject(new ConnectionLost())
    this.pending.clear()
    for (const handler of this.closeHandlers) handler()
  }
}

function redactToken(url: string): string {
  return url.replace(/token=[^&]+/, 'token=…')
}
