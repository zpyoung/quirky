import { TextDecoder } from 'node:util'
import type { ProcessSpawner, SpawnExit, SpawnedProcess } from '@quirky/protocol'

export type CodexRpcId = string | number
export type CodexRpcMessage = Record<string, unknown>

export type CodexConnectionHandlers = {
  notification(message: CodexRpcMessage): void
  serverRequest(request: { id: CodexRpcId; method: string; params: unknown }): void
  failure(error: Error): void
}

type PendingRequest = {
  method: string
  resolve(result: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const MAX_FRAME_BYTES = 1024 * 1024
const STDERR_TAIL_CHARS = 16 * 1024
const STDERR_TAIL_BYTES = STDERR_TAIL_CHARS * 3
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000
const STDOUT_EXIT_WAIT_MS = 250
const CLOSE_EXIT_WAIT_MS = 250
const STOP_GRACE_MS = 2_000

const isRpcId = (value: unknown): value is CodexRpcId => typeof value === 'string' || typeof value === 'number'
const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value))

/** Owns one stdio app-server process and correlates bidirectional JSON-RPC messages. */
export class CodexConnection {
  private readonly handle: SpawnedProcess
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly pending = new Map<CodexRpcId, PendingRequest>()
  private readonly exited: Promise<SpawnExit>
  private frameBuffer = ''
  private nextId = 1
  private failure: Error | null = null
  private closing = false
  private exitResult: SpawnExit | undefined
  private closePromise: Promise<void> | undefined

  constructor(
    process: ProcessSpawner,
    executable: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly handlers: CodexConnectionHandlers
  ) {
    this.handle = process.spawn([executable, 'app-server'], {
      timeoutMs: null,
      cwd,
      env,
      stdin: 'pipe',
      stderrTailBytes: STDERR_TAIL_BYTES,
      killGraceMs: STOP_GRACE_MS
    })
    this.exited = this.handle.exited.then((exit) => {
      this.exitResult = exit
      if (exit.spawnError) this.fail(new Error(`could not start Codex app-server: ${exit.spawnError.message}`))
      return exit
    })
    void this.readStdout().catch((error) => {
      if (!this.closing && !this.failure) this.fail(new Error(`Codex app-server stdout failed: ${asError(error).message}`))
    })
  }

  get stderrTail(): string {
    const tail = this.handle.stderrTail()
    return tail.length > STDERR_TAIL_CHARS ? tail.slice(-STDERR_TAIL_CHARS) : tail
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing || this.exitResult) return Promise.reject(new Error('Codex app-server connection is closed'))

    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      const error = new Error(`Codex app-server ${method} timed out after ${timeoutMs}ms`)
      reject(error)
      this.fail(error)
    }, timeoutMs)
    this.pending.set(id, { method, resolve, reject, timer })
    try {
      this.write({ id, method, params })
    } catch (error) {
      clearTimeout(timer)
      this.pending.delete(id)
      const failure = asError(error)
      reject(failure)
      this.fail(failure)
    }
    return promise
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  respond(id: CodexRpcId, result: unknown): void {
    if (this.closing || this.exitResult) return
    this.write({ id, result })
  }

  respondError(id: CodexRpcId, code: number, message: string): void {
    if (this.closing || this.exitResult) return
    this.write({ id, error: { code, message } })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.rejectPending(new Error('Codex app-server connection closed'))
    this.closePromise = this.closeProcess()
    return this.closePromise
  }

  private async closeProcess(): Promise<void> {
    void this.handle.closeInput()
    await this.waitForExit(CLOSE_EXIT_WAIT_MS)
    await this.handle.stop({ graceMs: STOP_GRACE_MS })
  }

  private write(message: Record<string, unknown>): void {
    if (this.failure) throw this.failure
    if (this.closing || this.exitResult) throw new Error('Codex app-server connection is closed')
    let frame: string
    try {
      frame = JSON.stringify(message)
    } catch (error) {
      throw new Error(`could not encode Codex app-server message: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('Codex app-server message exceeds the frame limit')
    try {
      void this.handle.write(`${frame}\n`).then(
        (written) => {
          if (written || this.closing || this.failure) return
          const pipeError = new Error('Codex app-server stdin failed: the pipe is closed')
          this.fail(pipeError)
        },
        (error) => {
          if (!this.closing && !this.failure) this.fail(new Error(`Codex app-server stdin failed: ${asError(error).message}`))
        }
      )
    } catch (error) {
      const failure = asError(error)
      this.fail(failure)
      throw failure
    }
  }

  private async readStdout(): Promise<void> {
    const reader = this.handle.stdout.getReader()
    try {
      for (;;) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            await this.finishStdout()
            return
          }
          this.readStdoutChunk(value)
        } catch (error) {
          if (!this.closing && !this.failure) this.fail(new Error(`Codex app-server stdout failed: ${asError(error).message}`))
          return
        }
        if (this.closing || this.failure) return
      }
    } finally {
      reader.releaseLock()
    }
  }

  private readStdoutChunk(chunk: Uint8Array): void {
    if (this.closing || this.failure) return
    try {
      this.frameBuffer += this.decoder.decode(chunk, { stream: true })
      for (;;) {
        const newline = this.frameBuffer.indexOf('\n')
        if (newline < 0) break
        let frame = this.frameBuffer.slice(0, newline)
        this.frameBuffer = this.frameBuffer.slice(newline + 1)
        if (frame.endsWith('\r')) frame = frame.slice(0, -1)
        if (frame.length === 0) throw new Error('Codex app-server sent an empty JSONL frame')
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('Codex app-server frame exceeds the limit')
        let message: unknown
        try {
          message = JSON.parse(frame)
        } catch (error) {
          throw new Error(`Codex app-server sent malformed JSON: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.receive(message)
        if (this.failure) return
      }
      if (Buffer.byteLength(this.frameBuffer) > MAX_FRAME_BYTES) throw new Error('Codex app-server frame exceeds the limit')
    } catch (error) {
      this.fail(asError(error))
    }
  }

  private async finishStdout(): Promise<void> {
    if (this.closing || this.failure) return
    try {
      this.frameBuffer += this.decoder.decode()
      if (this.frameBuffer.length > 0) throw new Error('Codex app-server closed with an incomplete JSONL frame')
    } catch (error) {
      this.fail(asError(error))
      return
    }
    await this.waitForExit(STDOUT_EXIT_WAIT_MS)
    if (!this.closing && !this.failure) this.fail(new Error('Codex app-server stdout closed'))
  }

  private receive(value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Codex app-server sent a non-object JSON-RPC message')
    }
    const message = value as Record<string, unknown>
    if (Object.hasOwn(message, 'method')) {
      if (typeof message.method !== 'string' || message.method.length === 0) throw new Error('Codex app-server sent an invalid method')
      if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw new Error('Codex app-server request also contained a response')
      if (Object.hasOwn(message, 'id')) {
        if (!isRpcId(message.id)) throw new Error('Codex app-server request has an invalid ID')
        this.handlers.serverRequest({ id: message.id, method: message.method, params: message.params })
      } else {
        this.handlers.notification(message)
      }
      return
    }

    if (!Object.hasOwn(message, 'id') || !isRpcId(message.id)) throw new Error('Codex app-server response has an invalid ID')
    const hasResult = Object.hasOwn(message, 'result')
    const hasError = Object.hasOwn(message, 'error')
    if (hasResult === hasError) throw new Error('Codex app-server response must contain exactly one of result or error')
    const pending = this.pending.get(message.id)
    if (!pending) throw new Error(`Codex app-server sent a response for unknown ID ${String(message.id)}`)
    if (hasError) {
      const rawError = message.error
      if (typeof rawError !== 'object' || rawError === null || Array.isArray(rawError)) {
        throw new Error(`Codex app-server returned an invalid error for ${pending.method}`)
      }
      const rpcError = rawError as Record<string, unknown>
      if (typeof rpcError.code !== 'number' || typeof rpcError.message !== 'string') {
        throw new Error(`Codex app-server returned an invalid error for ${pending.method}`)
      }
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.reject(new Error(`Codex app-server ${pending.method} failed (${rpcError.code}): ${rpcError.message}`))
    } else {
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve(message.result)
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.closing) return
    this.failure = error
    this.rejectPending(error)
    try {
      this.handlers.failure(error)
    } catch {
      // Failure observers do not own connection cleanup.
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.exitResult) return
    const timeout = Promise.withResolvers<void>()
    const timer = setTimeout(timeout.resolve, timeoutMs)
    await Promise.race([this.exited, timeout.promise])
    clearTimeout(timer)
  }
}
