import { spawn } from 'node:child_process'
import { closeSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'bun'
import {
  PTY_PROTOCOL_VERSION,
  PtyFrameDecoder,
  encodePtyData,
  encodePtyJson,
  type PtyEvent,
  type PtyFrame,
  type PtyRequest,
  type PtyResults
} from '@quirky/protocol'
import { openPrivateLog } from '@quirky/protocol/node'

type PtyParams<T extends PtyRequest['type']> = Omit<Extract<PtyRequest, { type: T }>, 'id' | 'type'>

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onResult?: (result: unknown) => void
}

export type PtyClientOptions = {
  home: string
  /** Script that starts quirky-pty when it does not answer. */
  hostEntry?: string
  connectTimeoutMs?: number
  log?: (message: string) => void
}

export function defaultPtyHostEntry(): string {
  return (
    process.env.QUIRKY_PTY_HOST_ENTRY ??
    fileURLToPath(new URL('../../pty-host/src/main.ts', import.meta.url))
  )
}

/**
 * The daemon's connection to quirky-pty over `<home>/pty.sock`. It starts the host if nothing
 * answers and reconnects when the socket drops, since sessions outlive the connection.
 */
export class PtyClient {
  private socket: Socket<undefined> | null = null
  private ready: Socket<undefined> | null = null
  private decoder = new PtyFrameDecoder()
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly outQueue: Uint8Array[] = []
  private readonly dataHandlers = new Set<(sessionId: string, bytes: Uint8Array) => void>()
  private readonly exitHandlers = new Set<(sessionId: string, exitCode: number | null) => void>()
  private readonly reconnectHandlers = new Set<() => void>()
  private connecting: Promise<void> | null = null
  private reconnecting = false
  private closing = false
  hostPid: number | null = null

  constructor(private readonly options: PtyClientOptions) {}

  get connected(): boolean {
    return this.ready !== null
  }

  onData(handler: (sessionId: string, bytes: Uint8Array) => void): void {
    this.dataHandlers.add(handler)
  }

  onExit(handler: (sessionId: string, exitCode: number | null) => void): void {
    this.exitHandlers.add(handler)
  }

  /** Called after the connection was re-established following a drop. */
  onReconnect(handler: () => void): void {
    this.reconnectHandlers.add(handler)
  }

  /** Connects, starting the PTY host first when it does not answer. Safe to call repeatedly. */
  connect(): Promise<void> {
    if (this.ready) return Promise.resolve()
    this.connecting ??= this.establish().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  /**
   * Sends one control request. `onResult` runs synchronously while the response frame is being
   * dispatched, before any DATA frame that follows it on the socket.
   */
  async request<T extends PtyRequest['type']>(
    type: T,
    params: PtyParams<T>,
    options: { onResult?: (result: PtyResults[T]) => void } = {}
  ): Promise<PtyResults[T]> {
    await this.connect()
    return this.rawRequest(type, params, options.onResult as ((result: unknown) => void) | undefined)
  }

  /** Sends input bytes to a session's terminal. */
  sendData(sessionId: string, bytes: Uint8Array): void {
    if (!this.ready) throw new Error('pty host is not connected')
    this.write(encodePtyData(sessionId, bytes))
  }

  close(): void {
    this.closing = true
    const socket = this.socket
    this.socket = null
    this.ready = null
    socket?.end()
    this.failPending(new Error('pty client closed'))
  }

  private rawRequest(
    type: string,
    params: object,
    onResult?: (result: unknown) => void
  ): Promise<never> {
    if (!this.socket) return Promise.reject(new Error('pty host is not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onResult })
      this.write(encodePtyJson({ id, type, ...params }))
    })
  }

  private write(bytes: Uint8Array): void {
    this.outQueue.push(bytes)
    this.flush()
  }

  private flush(): void {
    const socket = this.socket
    if (!socket) return
    while (this.outQueue.length > 0) {
      const head = this.outQueue[0]
      const written = socket.write(head)
      if (written < head.length) {
        this.outQueue[0] = head.subarray(Math.max(written, 0))
        return
      }
      this.outQueue.shift()
    }
  }

  private async establish(): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? 15000
    const deadline = Date.now() + timeoutMs
    let spawned = false
    for (;;) {
      try {
        await this.openAndHello()
        return
      } catch (error) {
        if (this.closing) throw error
        if (!spawned) {
          spawned = true
          this.spawnHost()
        }
        if (Date.now() > deadline) {
          throw new Error(
            `quirky-pty did not answer within ${timeoutMs}ms: ${(error as Error).message}; see ${join(this.options.home, 'logs', 'pty-host.log')}`
          )
        }
        await Bun.sleep(100)
      }
    }
  }

  private async openAndHello(): Promise<void> {
    const token = readFileSync(join(this.options.home, 'pty.token'), 'utf8').trim()
    const decoder = new PtyFrameDecoder()
    this.decoder = decoder
    const socket = await Bun.connect<undefined>({
      unix: join(this.options.home, 'pty.sock'),
      socket: {
        data: (sock, chunk) => {
          if (this.socket === sock) this.handleChunk(sock, chunk)
        },
        drain: () => this.flush(),
        close: (sock) => this.handleClose(sock),
        error: () => {}
      }
    })
    this.socket = socket
    try {
      const hello = await this.rawRequest('hello', { token, version: PTY_PROTOCOL_VERSION })
      this.hostPid = (hello as PtyResults['hello']).pid
      this.ready = socket
    } catch (error) {
      if (this.socket === socket) this.socket = null
      socket.end()
      throw error
    }
  }

  private handleChunk(socket: Socket<undefined>, chunk: Uint8Array): void {
    let frames: PtyFrame[]
    try {
      frames = this.decoder.push(new Uint8Array(chunk))
    } catch (error) {
      this.options.log?.(`pty frame error: ${(error as Error).message}`)
      socket.end()
      return
    }
    for (const frame of frames) {
      try {
        this.dispatch(frame)
      } catch (error) {
        this.options.log?.(`pty dispatch error: ${(error as Error).message}`)
      }
    }
  }

  private dispatch(frame: PtyFrame): void {
    if (frame.kind === 'data') {
      for (const handler of this.dataHandlers) handler(frame.sessionId, frame.bytes)
      return
    }
    const message = frame.message as { id?: number; ok?: boolean; result?: unknown; error?: string } & Partial<PtyEvent>
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) {
        try {
          pending.onResult?.(message.result)
        } finally {
          pending.resolve(message.result)
        }
      } else {
        pending.reject(new Error(message.error ?? 'pty request failed'))
      }
      return
    }
    if (message.type === 'exit' && typeof message.sessionId === 'string') {
      for (const handler of this.exitHandlers) handler(message.sessionId, message.exitCode ?? null)
    }
  }

  private handleClose(socket: Socket<undefined>): void {
    if (this.socket !== socket) return
    this.socket = null
    this.outQueue.length = 0
    this.failPending(new Error('pty host connection lost'))
    const wasReady = this.ready === socket
    this.ready = null
    if (wasReady && !this.closing) void this.reconnectLoop()
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    try {
      while (!this.closing) {
        try {
          await this.connect()
          break
        } catch (error) {
          this.options.log?.(`pty reconnect failed: ${(error as Error).message}`)
          await Bun.sleep(1000)
        }
      }
    } finally {
      this.reconnecting = false
    }
    if (this.closing) return
    for (const handler of this.reconnectHandlers) {
      try {
        handler()
      } catch (error) {
        this.options.log?.(`pty reconnect handler failed: ${(error as Error).message}`)
      }
    }
  }

  private spawnHost(): void {
    const entry = this.options.hostEntry ?? defaultPtyHostEntry()
    if (!existsSync(entry)) throw new Error(`quirky-pty entry not found: ${entry}`)
    const log = openPrivateLog(join(this.options.home, 'logs', 'pty-host.log'))
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, QUIRKY_HOME: this.options.home }
    })
    child.unref()
    closeSync(log)
  }
}
