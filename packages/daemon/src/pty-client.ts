import { closeSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'bun'
import {
  PTY_PROTOCOL_MIN_VERSION,
  PTY_PROTOCOL_VERSION,
  PtyFrameDecoder,
  encodePtyData,
  encodePtyJson,
  parsePtyVersionRejection,
  type ExitCause,
  type PtyEvent,
  type PtyFact,
  type PtyFrame,
  type PtyRequest,
  type PtyResults,
  type PtyWriteErrorCode
} from '@quirky/protocol'
import { openPrivateLog, socketPath } from '@quirky/protocol/node'
import { launchDetached } from '@quirky/process'

type PtyParams<T extends PtyRequest['type']> = Omit<Extract<PtyRequest, { type: T }>, 'id' | 'type'>

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onResult?: (result: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

type RawRequestOptions = {
  onResult?: (result: unknown) => void
  timeoutMs?: number
  onDispatch?: () => void
  timeoutError?: () => Error
}

export type PtyClientOptions = {
  home: string
  /** Script that starts quirky-pty when it does not answer. */
  hostEntry?: string
  connectTimeoutMs?: number
  /** Overrides how long retiring or restarting a host waits for it to stop. */
  shutdownWaitMs?: number
  log?: (message: string) => void
  /** The protocol versions this client speaks; defaults to the protocol package's constants. */
  protocol?: { min: number; max: number }
  /** The pause after a failed connection attempt and its cap; defaults to 1000 and 30000. */
  reconnectDelayMs?: { initial: number; max: number }
  /** Deadline for an acknowledged write after it has been sent to the host; default 30 seconds. */
  writeAcceptedTimeoutMs?: number
}


const RETIRE_WAIT_MS = 5000
const RESTART_WAIT_MS = 15000
const WRITE_ACCEPTED_TIMEOUT_MS = 30_000

type PtyWriteError = Error & { code: PtyWriteErrorCode; acceptedBytes: number | null }

function ptyWriteError(code: PtyWriteErrorCode, acceptedBytes: number | null, message: string): PtyWriteError {
  return Object.assign(new Error(message), { code, acceptedBytes })
}

function isPtyWriteError(error: unknown): error is PtyWriteError {
  if (!(error instanceof Error) || !('code' in error) || !('acceptedBytes' in error)) return false
  const acceptedBytes = error.acceptedBytes
  return (
    (error.code === 'PTY_WRITE_REJECTED' || error.code === 'PTY_WRITE_UNCERTAIN') &&
    (acceptedBytes === null || (typeof acceptedBytes === 'number' && Number.isSafeInteger(acceptedBytes) && acceptedBytes >= 0))
  )
}

export type PtyExitDetails = { exitSignal: string | null; exitCause: ExitCause }

/** A host reply this daemon cannot safely speak to. */
class PtyProtocolRefused extends Error {}

export function defaultPtyHostEntry(): string {
  return (
    process.env.QUIRKY_PTY_HOST_ENTRY ??
    fileURLToPath(new URL('../../pty-host/src/main.ts', import.meta.url))
  )
}

/**
 * The daemon's connection to quirky-pty over `socketPath(home, 'pty.sock')`. It starts the host if nothing
 * answers, negotiates compatible protocol versions and restores connections while PTY sessions outlive it.
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
  private readonly closeSignal = Promise.withResolvers<void>()
  private readonly closeWaiters = new Set<() => void>()
  private readonly protocol: { min: number; max: number }
  private readonly reconnectDelay: { initial: number; max: number }
  private connecting: Promise<void> | null = null
  private reconnecting = false
  private reconnectOwed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryWaitResolve: (() => void) | null = null
  private closing = false
  private restarting: Promise<{ pid: number }> | null = null
  private keepDown = false
  private negotiatedProtocolVersion: number | null = null
  hostPid: number | null = null

  constructor(private readonly options: PtyClientOptions) {
    this.protocol = options.protocol ?? { min: PTY_PROTOCOL_MIN_VERSION, max: PTY_PROTOCOL_VERSION }
    this.reconnectDelay = options.reconnectDelayMs ?? { initial: 1000, max: 30000 }
  }

  get connected(): boolean {
    return this.ready !== null
  }

  get protocolVersion(): number | null {
    return this.negotiatedProtocolVersion
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

  /** Called once when the client restores a connection after an outage. */
  onReconnect(handler: () => void): void {
    this.reconnectHandlers.add(handler)
  }

  /** Connects, starting the PTY host first when it does not answer. Safe to call repeatedly. */
  connect(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('pty client closed'))
    if (this.ready) {
      this.cancelRetryWait()
      this.notifyReconnect()
      return this.closing ? Promise.reject(new Error('pty client closed')) : Promise.resolve()
    }
    if (!this.connecting) {
      let attempt: Promise<void>
      attempt = this.establish()
        .then(() => {
          if (this.closing) throw new Error('pty client closed')
          this.cancelRetryWait()
          this.notifyReconnect()
          if (this.closing) throw new Error('pty client closed')
        })
        .catch((error) => {
          if (this.closing) throw new Error('pty client closed')
          this.reconnectOwed = true
          throw error instanceof Error ? error : new Error(String(error))
        })
        .finally(() => {
          if (this.connecting === attempt) this.connecting = null
          if (this.reconnectOwed && !this.closing && !this.keepDown && !this.restarting) {
            this.startReconnectLoop()
          }
        })
      this.connecting = attempt
    }
    return this.connecting
  }

  /**
   * Sends one control request. `onResult` runs synchronously while the response frame is being
   * dispatched, before any DATA frame that follows it on the socket. `timeoutMs` bounds the wait
   * after dispatch; an acknowledged-write timeout reports unknown acceptance.
   */
  async request<T extends PtyRequest['type']>(
    type: T,
    params: PtyParams<T>,
    options: { onResult?: (result: PtyResults[T]) => void; timeoutMs?: number } = {}
  ): Promise<PtyResults[T]> {
    let dispatched = false
    try {
      await this.connect()
    } catch (error) {
      if (type === 'writeAccepted') {
        throw ptyWriteError('PTY_WRITE_REJECTED', 0, error instanceof Error ? error.message : String(error))
      }
      throw error
    }

    const timeoutMs =
      options.timeoutMs ??
      (type === 'writeAccepted' ? (this.options.writeAcceptedTimeoutMs ?? WRITE_ACCEPTED_TIMEOUT_MS) : undefined)
    try {
      const result = await this.rawRequest(type, params, {
        onResult: options.onResult as ((result: unknown) => void) | undefined,
        timeoutMs,
        onDispatch: type === 'writeAccepted' ? () => (dispatched = true) : undefined,
        timeoutError:
          type === 'writeAccepted' && timeoutMs !== undefined
            ? () => ptyWriteError('PTY_WRITE_UNCERTAIN', null, `acknowledged PTY write timed out after ${timeoutMs}ms`)
            : undefined
      })
      return result as PtyResults[T]
    } catch (error) {
      if (type !== 'writeAccepted' || isPtyWriteError(error)) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw dispatched
        ? ptyWriteError('PTY_WRITE_UNCERTAIN', null, message)
        : ptyWriteError('PTY_WRITE_REJECTED', 0, message)
    }
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
    if (this.closing) return
    this.closing = true
    this.closeSignal.resolve()
    this.cancelRetryWait()
    this.reconnectOwed = false
    const socket = this.socket
    this.socket = null
    this.ready = null
    this.negotiatedProtocolVersion = null
    this.outQueue.length = 0
    for (const release of [...this.closeWaiters]) release()
    this.failPending(new Error('pty client closed'))
    socket?.end()
  }

  private async replaceHost(): Promise<{ pid: number }> {
    await this.connect()
    if (this.closing) throw new Error('pty client closed')
    this.keepDown = true
    try {
      if (!(await this.shutdownAndWait(this.options.shutdownWaitMs ?? RESTART_WAIT_MS))) {
        throw new Error('quirky-pty did not stop after shutdown')
      }
    } finally {
      this.keepDown = false
    }
    if (this.closing) throw new Error('pty client closed')
    await this.connect()
    if (this.closing) throw new Error('pty client closed')
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

  private rawRequest(type: string, params: object, options: RawRequestOptions = {}): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error('pty client closed'))
    if (!this.socket) return Promise.reject(new Error('pty host is not connected'))
    const frame = encodePtyJson({ id: this.nextId, type, ...params })
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const pending: Pending = { resolve, reject, onResult: options.onResult }
    this.pending.set(id, pending)
    if (options.timeoutMs !== undefined) {
      pending.timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(options.timeoutError?.() ?? new Error(`pty request timed out: ${type}`))
      }, options.timeoutMs)
    }
    try {
      options.onDispatch?.()
      this.write(frame)
    } catch (error) {
      if (this.pending.delete(id)) clearTimeout(pending.timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
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
    const retiredHostIdentities = new Set<string>()
    let spawned = false
    for (;;) {
      if (this.closing) throw new Error('pty client closed')
      try {
        await this.openAndHello(deadline, retiredHostIdentities)
        if (this.closing) throw new Error('pty client closed')
        return
      } catch (error) {
        if (this.closing) throw new Error('pty client closed')
        if (error instanceof PtyProtocolRefused) throw error
        if (!spawned) {
          if (this.closing) throw new Error('pty client closed')
          spawned = true
          this.spawnHost()
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `quirky-pty did not answer within ${timeoutMs}ms: ${(error as Error).message}; see ${join(this.options.home, 'logs', 'pty-host.log')}`
          )
        }
        await this.sleepOrClose(Math.min(100, deadline - Date.now()))
      }
    }
  }

  private async sleepOrClose(ms: number): Promise<void> {
    if (this.closing) throw new Error('pty client closed')
    const { promise: elapsed, resolve } = Promise.withResolvers<void>()
    const timer = setTimeout(resolve, ms)
    try {
      await Promise.race([elapsed, this.closeSignal.promise])
    } finally {
      clearTimeout(timer)
    }
    if (this.closing) throw new Error('pty client closed')
  }

  private async openSocket(deadline: number): Promise<Socket<undefined>> {
    if (this.closing) throw new Error('pty client closed')
    this.decoder = new PtyFrameDecoder()
    const opening = Bun.connect<undefined>({
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
    const { promise: expired, resolve } = Promise.withResolvers<void>()
    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
    let result: { socket: Socket<undefined> } | { closed: true } | { expired: true }
    try {
      result = await Promise.race([
        opening.then((socket) => ({ socket })),
        this.closeSignal.promise.then(() => ({ closed: true as const })),
        expired.then(() => ({ expired: true as const }))
      ])
    } catch (error) {
      void opening.then((socket) => socket.end(), () => {})
      clearTimeout(timer)
      if (this.closing) throw new Error('pty client closed')
      throw error
    }
    clearTimeout(timer)
    if (!('socket' in result)) {
      void opening.then((socket) => socket.end(), () => {})
      if (this.closing || 'closed' in result) throw new Error('pty client closed')
      throw new Error('pty socket connection timed out')
    }
    if (this.closing || Date.now() >= deadline) {
      result.socket.end()
      if (this.closing) throw new Error('pty client closed')
      throw new Error('pty socket connection timed out')
    }
    this.socket = result.socket
    return result.socket
  }

  private async openAndHello(deadline: number, retiredHostIdentities: Set<string>): Promise<void> {
    if (this.closing) throw new Error('pty client closed')
    const token = readFileSync(join(this.options.home, 'pty.token'), 'utf8').trim()
    const socket = await this.openSocket(deadline)
    try {
      if (this.closing) throw new Error('pty client closed')
      const hello = (await this.rawRequest('hello', {
        token,
        version: this.protocol.max,
        minVersion: this.protocol.min
      })) as PtyResults['hello']
      if (this.closing) throw new Error('pty client closed')
      if (!Number.isInteger(hello.version) || hello.version < this.protocol.min || hello.version > this.protocol.max) {
        throw new PtyProtocolRefused(
          `quirky-pty answered hello with protocol ${hello.version}; this quirkyd speaks ${this.protocol.min}-${this.protocol.max}.`
        )
      }
      this.hostPid = hello.pid
      this.negotiatedProtocolVersion = hello.version
      this.ready = socket
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null
        this.outQueue.length = 0
      }
      socket.end()
      if (this.closing) throw new Error('pty client closed')
      const rejection = parsePtyVersionRejection(error instanceof Error ? error.message : String(error))
      if (rejection) {
        if (rejection.host > this.protocol.max) {
          throw new PtyProtocolRefused(
            `quirky-pty speaks protocol ${rejection.host}; this quirkyd speaks ${this.protocol.max}. Stop it or upgrade Quirky.`
          )
        }
        if (rejection.host >= this.protocol.min && rejection.host < this.protocol.max) {
          await this.adoptHost(rejection.host, token, deadline)
          return
        }
        if (rejection.host < this.protocol.min) {
          await this.retireHost(rejection.host, token, retiredHostIdentities, deadline)
          if (this.closing) throw new Error('pty client closed')
        }
      }
      throw error
    }
  }

  private async adoptHost(version: number, token: string, deadline: number): Promise<void> {
    if (this.closing) throw new Error('pty client closed')
    const socket = await this.openSocket(deadline)
    try {
      if (this.closing) throw new Error('pty client closed')
      const hello = (await this.rawRequest('hello', { token, version })) as PtyResults['hello']
      if (this.closing) throw new Error('pty client closed')
      if (!Number.isInteger(hello.version) || hello.version < this.protocol.min || hello.version > this.protocol.max) {
        throw new Error(`quirky-pty answered hello with protocol ${hello.version} outside this quirkyd's range`)
      }
      this.hostPid = hello.pid
      this.negotiatedProtocolVersion = hello.version
      this.ready = socket
      this.options.log?.(
        `adopted quirky-pty speaking protocol ${hello.version}; this quirkyd speaks ${this.protocol.max}`
      )
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null
        this.outQueue.length = 0
      }
      socket.end()
      if (this.closing) throw new Error('pty client closed')
      throw error
    }
  }

  private async retireHost(
    version: number,
    token: string,
    retiredHostIdentities: Set<string>,
    deadline: number
  ): Promise<void> {
    const waitMs = this.options.shutdownWaitMs ?? RETIRE_WAIT_MS
    try {
      if (this.closing) throw new Error('pty client closed')
      const socket = await this.openSocket(deadline)
      try {
        if (this.closing) throw new Error('pty client closed')
        const hello = (await this.rawRequest('hello', { token, version })) as PtyResults['hello']
        if (this.closing) throw new Error('pty client closed')
        const identity = JSON.stringify([token, hello.version, hello.pid])
        if (retiredHostIdentities.has(identity)) return
        retiredHostIdentities.add(identity)
        const stopped = await this.shutdownAndWait(waitMs)
        if (this.closing) throw new Error('pty client closed')
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
      if (this.closing) throw new Error('pty client closed')
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
    const message = frame.message as {
      id?: number
      ok?: boolean
      result?: unknown
      error?: string
      code?: unknown
      acceptedBytes?: unknown
    } & Partial<PtyEvent>
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) {
        try {
          pending.onResult?.(message.result)
        } finally {
          pending.resolve(message.result)
        }
      } else {
        const error = new Error(message.error ?? 'pty request failed')
        if (
          (message.code === 'PTY_WRITE_REJECTED' || message.code === 'PTY_WRITE_UNCERTAIN') &&
          (message.acceptedBytes === null ||
            (typeof message.acceptedBytes === 'number' &&
              Number.isSafeInteger(message.acceptedBytes) &&
              message.acceptedBytes >= 0))
        ) {
          Object.assign(error, { code: message.code, acceptedBytes: message.acceptedBytes })
        }
        pending.reject(error)
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
    this.negotiatedProtocolVersion = null
    for (const release of [...this.closeWaiters]) release()
    if (wasReady && !this.closing) {
      this.reconnectOwed = true
      if (!this.keepDown && !this.restarting) this.startReconnectLoop(true)
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private startReconnectLoop(immediate = false): void {
    if (this.reconnecting || this.closing || this.ready || this.keepDown || this.restarting) return
    this.reconnecting = true
    void this.reconnectLoop(immediate)
  }

  private async reconnectLoop(immediate: boolean): Promise<void> {
    let delay = this.reconnectDelay.initial
    let lastError: string | null = null
    let waitBeforeAttempt = !immediate
    try {
      while (!this.closing && !this.ready && !this.keepDown && !this.restarting) {
        if (waitBeforeAttempt) await this.waitForRetry(delay)
        if (this.closing || this.ready || this.keepDown || this.restarting) break
        try {
          await this.connect()
          break
        } catch (error) {
          if (this.closing || this.keepDown || this.restarting) break
          const message = error instanceof Error ? error.message : String(error)
          if (message !== lastError) {
            this.options.log?.(`pty reconnect failed: ${message}`)
            lastError = message
          }
          if (waitBeforeAttempt) delay = Math.min(delay * 2, this.reconnectDelay.max)
          waitBeforeAttempt = true
        }
      }
    } finally {
      this.reconnecting = false
      if (this.reconnectOwed && !this.closing && !this.ready && !this.keepDown && !this.restarting) {
        this.startReconnectLoop()
      }
    }
  }

  private waitForRetry(delay: number): Promise<void> {
    if (this.closing || this.ready) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    this.retryWaitResolve = resolve
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryWaitResolve = null
      resolve()
    }, delay)
    return promise
  }

  private cancelRetryWait(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const resolve = this.retryWaitResolve
    this.retryWaitResolve = null
    resolve?.()
  }

  private notifyReconnect(): void {
    if (!this.reconnectOwed || this.closing || !this.ready) return
    this.reconnectOwed = false
    this.cancelRetryWait()
    for (const handler of this.reconnectHandlers) {
      if (this.closing) break
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
    try {
      launchDetached([process.execPath, entry], {
        cwd: this.options.home,
        env: { ...process.env, QUIRKY_HOME: this.options.home },
        stdout: log,
        stderr: log
      })
    } finally {
      closeSync(log)
    }
  }
}
