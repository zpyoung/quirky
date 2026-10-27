import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { TextDecoder } from 'node:util'

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
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000
const STDIN_GRACE_MS = 250
const TERM_GRACE_MS = 2_000
const FINAL_CLOSE_GRACE_MS = 500


const isRpcId = (value: unknown): value is CodexRpcId => typeof value === 'string' || typeof value === 'number'

/** Owns one stdio app-server process and correlates bidirectional JSON-RPC messages. */
export class CodexConnection {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly stderrDecoder = new TextDecoder()
  private readonly pending = new Map<CodexRpcId, PendingRequest>()
  private readonly closed = Promise.withResolvers<void>()
  private readonly cleanup = Promise.withResolvers<void>()
  private frameBuffer = ''
  private stderr = ''
  private nextId = 1
  private failure: Error | null = null
  private closing = false
  private isClosed = false

  constructor(
    executable: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly handlers: CodexConnectionHandlers
  ) {
    this.child = spawn(executable, ['app-server'], {
      cwd,
      env,
      stdio: 'pipe',
      detached: process.platform !== 'win32'
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.readStdout(chunk))
    this.child.stdout.on('end', () => this.finishStdout())
    this.child.stdout.on('error', (error) => this.fail(new Error(`Codex app-server stdout failed: ${error.message}`)))
    this.child.stderr.on('data', (chunk: Buffer) => this.readStderr(chunk))
    this.child.stderr.on('error', (error) => this.fail(new Error(`Codex app-server stderr failed: ${error.message}`)))
    this.child.stdin.on('error', (error) => this.fail(new Error(`Codex app-server stdin failed: ${error.message}`)))
    this.child.once('error', (error) => this.fail(new Error(`could not start Codex app-server: ${error.message}`)))
    this.child.once('close', (code, signal) => {
      this.isClosed = true
      if (!this.closing) this.fail(this.childExitError(code, signal))
      this.closed.resolve()
    })
  }

  get stderrTail(): string {
    return this.stderr
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing || this.isClosed) return Promise.reject(new Error('Codex app-server connection is closed'))

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
      const failure = error instanceof Error ? error : new Error(String(error))
      reject(failure)
      this.fail(failure)
    }
    return promise
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  respond(id: CodexRpcId, result: unknown): void {
    if (this.closing || this.isClosed) return
    this.write({ id, result })
  }

  respondError(id: CodexRpcId, code: number, message: string): void {
    if (this.closing || this.isClosed) return
    this.write({ id, error: { code, message } })
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.cleanup.promise
      return
    }
    this.closing = true
    try {
      this.rejectPending(new Error('Codex app-server connection closed'))
      if (!this.isClosed) {
        try {
          this.child.stdin.end()
        } catch {
          // A process that already closed its pipe is handled by the close event.
        }
      }
      await this.waitForClose(STDIN_GRACE_MS)
      await this.terminateProcessGroup()
      if (!this.isClosed) {
        this.child.stdin.destroy()
        this.child.stdout.destroy()
        this.child.stderr.destroy()
        await this.waitForClose(FINAL_CLOSE_GRACE_MS)
      }
    } finally {
      this.cleanup.resolve()
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.failure) throw this.failure
    if (this.closing || this.isClosed) throw new Error('Codex app-server connection is closed')
    let frame: string
    try {
      frame = JSON.stringify(message)
    } catch (error) {
      throw new Error(`could not encode Codex app-server message: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('Codex app-server message exceeds the frame limit')
    this.child.stdin.write(`${frame}\n`)
  }

  private readStdout(chunk: Buffer): void {
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
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private finishStdout(): void {
    if (this.closing || this.failure) return
    try {
      this.frameBuffer += this.decoder.decode()
      if (this.frameBuffer.length > 0) throw new Error('Codex app-server closed with an incomplete JSONL frame')
      throw new Error('Codex app-server stdout closed')
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private readStderr(chunk: Buffer): void {
    this.stderr += this.stderrDecoder.decode(chunk, { stream: true })
    if (this.stderr.length > STDERR_TAIL_CHARS) this.stderr = this.stderr.slice(-STDERR_TAIL_CHARS)
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
      // The runner owns its own diagnostic callback failures.
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private childExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const details = this.stderr.trim()
    return new Error(
      `Codex app-server exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}${details ? `: ${details}` : ''}`
    )
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      if (process.platform === 'win32') this.child.kill(signal)
      else process.kill(-pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        try {
          this.child.kill(signal)
        } catch {
          // The process group is signalled again with SIGKILL if necessary.
        }
      }
    }
  }

  private processGroupExists(): boolean {
    const pid = this.child.pid
    if (pid === undefined) return false
    if (process.platform === 'win32') return !this.isClosed
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  private async terminateProcessGroup(): Promise<void> {
    this.signalGroup('SIGTERM')
    await this.waitForGroupExit(TERM_GRACE_MS)
    if (!this.processGroupExists()) return
    this.signalGroup('SIGKILL')
    await this.waitForGroupExit(TERM_GRACE_MS)
  }

  private async waitForGroupExit(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.processGroupExists()) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, Math.min(25, remaining))
      await promise
    }
  }

  private async waitForClose(timeoutMs: number): Promise<void> {
    if (this.isClosed) return
    const timeout = Promise.withResolvers<void>()
    const timer = setTimeout(timeout.resolve, timeoutMs)
    await Promise.race([this.closed.promise, timeout.promise])
    clearTimeout(timer)
  }

}
