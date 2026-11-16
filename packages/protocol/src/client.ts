import { decodeTerminalFrame } from './frames'
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

/** Per-call options; `requestId` sets the idempotency key and `timeoutMs` bounds local waiting only. */
export type CallOptions = { requestId?: string; timeoutMs?: number }

export type TerminalStreamOptions = {
  onLagged?: () => void
}

export type ClientHello = {
  role: ClientRole
  name?: string
  subscribe?: boolean
  token?: string
  sessionToken?: string
  cwd?: string
  sessionId?: string
  worktreeId?: string
  /** Stable first-party UI installation identity; accepted only for an authenticated `ui` hello. */
  desktopClientId?: string
}

/** What the JSON-RPC core needs from a connection: send one JSON text, close. */
type Transport = { send(text: string): void; close(): void }

/** Unix socket messages are one JSON document per line; a longer pending line is a protocol error. */
const MAX_SOCKET_LINE_BYTES = 16 * 1024 * 1024

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type StreamHandler = {
  handler: (bytes: Uint8Array) => void
  onLagged?: () => void
  fired: boolean
  active: boolean
}

// frames can land before the caller registers a handler for a fresh stream id
const MAX_BUFFERED_BYTES_PER_STREAM = 4 * 1024 * 1024
const MAX_LAGGED_STREAMS = 1_024

/**
 * A daemon connection. `connect` uses WebSocket, which works in browsers and in Bun, with `url`
 * the full `ws://127.0.0.1:<port>/rpc?token=<token>`. `connectSocket` uses the daemon's unix
 * socket (Bun only) and carries no terminal output.
 */
export class QuirkyClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventHandlers = new Set<(event: QuirkyEvent) => void>()
  private readonly closeHandlers = new Set<() => void>()
  private readonly streamHandlers = new Map<number, StreamHandler>()
  private readonly streamBuffers = new Map<number, Uint8Array[]>()
  private readonly laggedStreams = new Set<number>()
  private closed = false

  private constructor(private readonly transport: Transport) {}

  static connect(url: string, hello: ClientHello = { role: 'ui' }): Promise<QuirkyClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      const fail = () => reject(new Error(`could not connect to quirkyd at ${redactToken(url)}`))
      socket.addEventListener('error', fail, { once: true })
      socket.addEventListener(
        'open',
        () => {
          socket.removeEventListener('error', fail)
          const client = new QuirkyClient({ send: (text) => socket.send(text), close: () => socket.close() })
          socket.addEventListener('message', (event) => client.handleMessage(event.data))
          socket.addEventListener('close', () => client.handleClose())
          client.handshake(hello).then(() => resolve(client), reject)
        },
        { once: true }
      )
    })
  }

  /**
   * Connects over the daemon's unix socket (newline-delimited JSON, Bun only). `hello.token`
   * must be the runtime token; `options.signal` aborts connection/hello and force-closes the socket.
   */
  static async connectSocket(path: string, hello: ClientHello, options: { signal?: AbortSignal } = {}): Promise<QuirkyClient> {
    const signal = options.signal
    if (signal?.aborted) throw signal.reason

    let client: QuirkyClient | undefined
    let socket: Bun.Socket<undefined> | undefined
    const abortWait = signal ? Promise.withResolvers<never>() : undefined
    const onAbort = () => {
      socket?.terminate()
      client?.handleClose()
      abortWait?.reject(signal?.reason)
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }

    const decoder = new TextDecoder()
    let pendingLine = ''
    let pendingBytes: Uint8Array | null = null

    const flush = () => {
      while (socket && pendingBytes && pendingBytes.length > 0) {
        const written = socket.write(pendingBytes)
        if (written <= 0) return
        pendingBytes = written >= pendingBytes.length ? null : pendingBytes.subarray(written)
      }
    }

    try {
      let connectedSocket: Bun.Socket<undefined>
      try {
        const opening = Bun.connect<undefined>({
          unix: path,
          socket: {
            open(openedSocket) {
              socket = openedSocket
              if (signal?.aborted) openedSocket.terminate()
            },
            data(_socket, chunk) {
              pendingLine += decoder.decode(chunk, { stream: true })
              let newline = pendingLine.indexOf('\n')
              while (newline !== -1) {
                const line = pendingLine.slice(0, newline)
                pendingLine = pendingLine.slice(newline + 1)
                if (line !== '') client?.handleMessage(line)
                newline = pendingLine.indexOf('\n')
              }
              if (pendingLine.length > MAX_SOCKET_LINE_BYTES) {
                pendingLine = ''
                client?.close()
              }
            },
            drain: flush,
            close: () => client?.handleClose(),
            error: () => client?.handleClose()
          }
        })
        const connecting = opening.then((openedSocket) => {
          socket = openedSocket
          if (signal?.aborted) openedSocket.terminate()
          return openedSocket
        })
        connectedSocket = await (abortWait ? Promise.race([connecting, abortWait.promise]) : connecting)
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw new Error(`could not connect to quirkyd at ${path}: ${(error as Error).message}`)
      }

      socket = connectedSocket
      client = new QuirkyClient({
        send(text) {
          const bytes = new TextEncoder().encode(`${text}\n`)
          pendingBytes = pendingBytes ? concat(pendingBytes, bytes) : bytes
          flush()
        },
        close: () => connectedSocket.end()
      })
      const handshake = client.handshake(hello)
      await (abortWait ? Promise.race([handshake, abortWait.promise]) : handshake)
      return client
    } catch (error) {
      if (signal?.aborted) {
        socket?.terminate()
        client?.handleClose()
        throw signal.reason
      }
      client?.close()
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async handshake(hello: ClientHello): Promise<void> {
    try {
      await this.call('client.hello', {
        role: hello.role,
        name: hello.name,
        protocolVersion: PROTOCOL_VERSION,
        ...(hello.token !== undefined ? { token: hello.token } : {}),
        ...(hello.sessionToken !== undefined ? { sessionToken: hello.sessionToken } : {}),
        ...(hello.cwd !== undefined ? { cwd: hello.cwd } : {}),
        ...(hello.sessionId !== undefined ? { sessionId: hello.sessionId } : {}),
        ...(hello.worktreeId !== undefined ? { worktreeId: hello.worktreeId } : {}),
        ...(hello.desktopClientId !== undefined ? { desktopClientId: hello.desktopClientId } : {})
      })
      if (hello.subscribe) await this.call('events.subscribe', {})
    } catch (error) {
      this.close()
      throw error
    }
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
    if (this.closed) return Promise.reject(new ConnectionLost('quirky daemon connection is closed'))
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending: Pending = {
      resolve(value) {
        clearTimeout(timer)
        resolve(value)
      },
      reject(error) {
        clearTimeout(timer)
        reject(error)
      }
    }
    this.pending.set(id, pending)
    const requestId = options?.requestId
    if (options?.timeoutMs !== undefined) {
      const { timeoutMs } = options
      timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return
        this.pending.delete(id)
        pending.reject(new Error(`RPC call timed out after ${timeoutMs} ms`))
      }, timeoutMs)
    }
    try {
      this.transport.send(
        JSON.stringify({ jsonrpc: '2.0', id, method, params, ...(requestId !== undefined ? { requestId } : {}) })
      )
    } catch (error) {
      this.pending.delete(id)
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  onEvent(handler: (event: QuirkyEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  /**
   * Receives a terminal stream's bytes, including any that arrived before this call.
   * A gap discards buffered output and reports onLagged once; pre-registration gaps notify asynchronously.
   */
  onTerminalOutput(
    streamId: number,
    handler: (bytes: Uint8Array) => void,
    options?: TerminalStreamOptions
  ): () => void {
    const previous = this.streamHandlers.get(streamId)
    if (previous) previous.active = false
    const registration: StreamHandler = { handler, onLagged: options?.onLagged, fired: false, active: true }
    this.streamHandlers.set(streamId, registration)

    if (this.laggedStreams.has(streamId)) {
      this.streamBuffers.delete(streamId)
      queueMicrotask(() => this.notifyLagged(registration))
    } else {
      const buffered = this.streamBuffers.get(streamId)
      this.streamBuffers.delete(streamId)
      for (const bytes of buffered ?? []) handler(bytes)
    }

    return () => {
      registration.active = false
      if (this.streamHandlers.get(streamId) === registration) {
        this.streamHandlers.delete(streamId)
        this.streamBuffers.delete(streamId)
        this.laggedStreams.delete(streamId)
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.transport.close()
    this.handleClose()
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      const frame = decodeTerminalFrame(data as ArrayBuffer | Uint8Array)
      if (!frame) return
      const registration = this.streamHandlers.get(frame.streamId)
      if (this.laggedStreams.has(frame.streamId)) {
        if (frame.kind === 'lagged') this.notifyLagged(registration)
        return
      }
      if (frame.kind === 'lagged') {
        this.streamBuffers.delete(frame.streamId)
        this.latchLagged(frame.streamId)
        this.notifyLagged(registration)
        return
      }
      if (registration) {
        registration.handler(frame.bytes)
        return
      }
      const buffer = this.streamBuffers.get(frame.streamId) ?? []
      const size = buffer.reduce((sum, chunk) => sum + chunk.length, 0)
      if (size + frame.bytes.length > MAX_BUFFERED_BYTES_PER_STREAM) {
        this.streamBuffers.delete(frame.streamId)
        this.latchLagged(frame.streamId)
      } else {
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

  private notifyLagged(registration: StreamHandler | undefined): void {
    if (!registration || !registration.active || registration.fired) return
    registration.fired = true
    registration.onLagged?.()
  }

  private latchLagged(streamId: number): void {
    if (this.laggedStreams.has(streamId)) return
    this.laggedStreams.add(streamId)
    if (this.laggedStreams.size > MAX_LAGGED_STREAMS) {
      const oldest = this.laggedStreams.values().next().value
      if (oldest !== undefined) this.laggedStreams.delete(oldest)
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const registration of this.streamHandlers.values()) registration.active = false
    for (const { reject } of this.pending.values()) reject(new ConnectionLost())
    this.pending.clear()
    this.streamBuffers.clear()
    this.laggedStreams.clear()
    for (const handler of this.closeHandlers) handler()
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function redactToken(url: string): string {
  return url.replace(/token=[^&]+/, 'token=…')
}
