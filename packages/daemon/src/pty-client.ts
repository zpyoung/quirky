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
  type ExitCause,
  type PtyEvent,
  type PtyFact,
  type PtyFrame,
  type PtyRequest,
  type PtyResults
} from '@quirky/protocol'
import { openPrivateLog, socketPath } from '@quirky/protocol/node'

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
  /** Overrides how long retiring or restarting a host waits for it to stop. */
  shutdownWaitMs?: number
  log?: (message: string) => void
}

/** The host's rejection of a hello whose version it does not speak. */
const VERSION_REJECTION = /^unsupported protocol version (\d+), host speaks (\d+)$/

const RETIRE_WAIT_MS = 5000
const RESTART_WAIT_MS = 15000

export type PtyExitDetails = { exitSignal: string | null; exitCause: ExitCause }

/** A host that speaks a newer protocol than this daemon; retrying cannot fix it. */
class PtyProtocolRefused extends Error {}

export function defaultPtyHostEntry(): string {
  return (
    process.env.QUIRKY_PTY_HOST_ENTRY ??
    fileURLToPath(new URL('../../pty-host/src/main.ts', import.meta.url))
  )
}

/**
 * The daemon's connection to quirky-pty over `socketPath(home, 'pty.sock')`. It starts the host if nothing
 * answers and reconnects when the socket drops, since sessions outlive the connection. A host speaking
 * an older protocol is shut down and replaced; a newer one is refused.
 */
export class PtyClient {
  private socket: Socket<undefined> | null = null
  private ready: Socket<undefined> | null = null
  private decoder = new PtyFrameDecoder()
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly outQueue: Uint8Array[] = []
  private readonly dataHandlers = new Set<(sessionId: string, bytes: Uint8Array) => void>()
  private readonly exitHandlers = new Set<
    (sessionId: string, exitCode: number | null, details: PtyExitDetails) => void
  >()
  private readonly factHandlers = new Set<(sessionId: string, fact: PtyFact) => void>()
  private readonly reconnectHandlers = new Set<() => void>()
  private connecting: Promise<void> | null = null
  private reconnecting = false
  private closing = false
  private restarting: Promise<{ pid: number }> | null = null
  private keepDown = false
  private readonly closeWaiters = new Set<() => void>()
  hostPid: number | null = null

  constructor(private readonly options: PtyClientOptions) {}

  get connected(): boolean {
    return this.ready !== null
  }

  onData(handler: (sessionId: string, bytes: Uint8Array) => void): void {
    this.dataHandlers.add(handler)
  }

  onExit(handler: (sessionId: string, exitCode: number | null, details: PtyExitDetails) => void): void {
    this.exitHandlers.add(handler)
  }

  onFact(handler: (sessionId: string, fact: PtyFact) => void): void {
    this.factHandlers.add(handler)
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

  /**
   * Replaces the PTY host: the running one ends every session as restorable and exits, then a fresh
   * host starts. Reconnect handlers fire once afterwards. Concurrent calls share one restart.
   */
  restartHost(): Promise<{ pid: number }> {
    this.restarting ??= this.replaceHost().finally(() => {
      this.restarting = null
    })
    return this.restarting
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

  private async replaceHost(): Promise<{ pid: number }> {
    await this.connect()
    this.keepDown = true
    try {
      if (!(await this.shutdownAndWait(this.options.shutdownWaitMs ?? RESTART_WAIT_MS))) {
        throw new Error('quirky-pty did not stop after shutdown')
      }
    } finally {
      this.keepDown = false
    }
    await this.connect()
    this.notifyReconnect()
    return { pid: this.hostPid as number }
  }

  /**
   * Sends `shutdown` on the current socket and waits for it to close, all within `waitMs`. When the host
   * neither replies nor closes in time the connection is destroyed and this returns false.
   */
  private async shutdownAndWait(waitMs: number): Promise<boolean> {
    const socket = this.socket
    if (!socket) return true
    let release!: () => void
    const closed = new Promise<boolean>((resolve) => {
      release = () => resolve(true)
      this.closeWaiters.add(release)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs)
    })
    // the host may drop the connection before it replies, so a failed request is not an error
    this.rawRequest('shutdown', {}).catch(() => {})
    const result = await Promise.race([closed, timeout])
    clearTimeout(timer)
    this.closeWaiters.delete(release)
    if (!result) {
      socket.terminate()
      this.handleClose(socket)
    }
    return result
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
        if (this.closing || error instanceof PtyProtocolRefused) throw error
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

  private async openSocket(): Promise<Socket<undefined>> {
    this.decoder = new PtyFrameDecoder()
    const socket = await Bun.connect<undefined>({
      unix: socketPath(this.options.home, 'pty.sock'),
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
    return socket
  }

  private async openAndHello(): Promise<void> {
    const token = readFileSync(join(this.options.home, 'pty.token'), 'utf8').trim()
    const socket = await this.openSocket()
    try {
      const hello = await this.rawRequest('hello', { token, version: PTY_PROTOCOL_VERSION })
      this.hostPid = (hello as PtyResults['hello']).pid
      this.ready = socket
    } catch (error) {
      if (this.socket === socket) this.socket = null
      socket.end()
      const rejection = VERSION_REJECTION.exec((error as Error).message)
      const theirs = rejection ? Number(rejection[2]) : null
      if (theirs !== null && theirs > PTY_PROTOCOL_VERSION) {
        throw new PtyProtocolRefused(
          `quirky-pty speaks protocol ${theirs}; this quirkyd speaks ${PTY_PROTOCOL_VERSION}. Stop it or upgrade Quirky.`
        )
      }
      if (theirs !== null) await this.retireHost(theirs, token)
      throw error
    }
  }

  /** Shuts down a host that speaks the older protocol `version`, so `establish` can start a current one. */
  private async retireHost(version: number, token: string): Promise<void> {
    const waitMs = this.options.shutdownWaitMs ?? RETIRE_WAIT_MS
    try {
      const socket = await this.openSocket()
      try {
        await this.rawRequest('hello', { token, version })
        const stopped = await this.shutdownAndWait(waitMs)
        this.options.log?.(
          stopped
            ? `retired quirky-pty speaking protocol ${version}`
            : `quirky-pty speaking protocol ${version} did not stop within ${waitMs}ms`
        )
      } finally {
        if (this.socket === socket) this.socket = null
        socket.end()
      }
    } catch (error) {
      this.options.log?.(`could not retire quirky-pty speaking protocol ${version}: ${(error as Error).message}`)
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
      const details: PtyExitDetails = {
        exitSignal: message.exitSignal ?? null,
        exitCause: message.exitCause ?? 'exited'
      }
      for (const handler of this.exitHandlers) handler(message.sessionId, message.exitCode ?? null, details)
    } else if (message.type === 'fact' && typeof message.sessionId === 'string' && message.fact) {
      for (const handler of this.factHandlers) handler(message.sessionId, message.fact)
    }
  }

  private handleClose(socket: Socket<undefined>): void {
    if (this.socket !== socket) return
    this.socket = null
    this.outQueue.length = 0
    this.failPending(new Error('pty host connection lost'))
    const wasReady = this.ready === socket
    this.ready = null
    for (const release of [...this.closeWaiters]) release()
    if (wasReady && !this.closing && !this.keepDown) void this.reconnectLoop()
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
    this.notifyReconnect()
  }

  private notifyReconnect(): void {
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
