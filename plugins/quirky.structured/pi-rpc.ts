import { TextDecoder } from 'node:util'
import type { ProcessSpawner, SpawnedProcess } from '@quirky/protocol'
import { stderrLines } from './items'
import { MAX_IMAGE_BYTES } from './queue'

/** The two agents that speak pi's line-delimited JSON RPC; omp is a pi fork with its own additions. */
export type PiVariant = 'pi' | 'omp'

export type PiFrame = Record<string, unknown>

export type PiTransportSpec = { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

/** How the child ended; `protocolError` is set when Quirky stopped it for sending a frame it could not read. */
export type PiExit = { code: number | null; signal: string | null; stderrTail: string[]; protocolError?: string }

export type PiTransportHandlers = {
  frame(frame: PiFrame): void
  exit(exit: PiExit): void
}

/** One child process's stdio as whole frames; tests replace it with a scripted fake. */
export interface PiTransport {
  write(frame: PiFrame): void
  close(): Promise<void>
  readonly stderrTail: string[]
}

export type PiTransportFactory = (spec: PiTransportSpec, handlers: PiTransportHandlers, process: ProcessSpawner) => PiTransport

/** A command the agent answered with `success: false`, or that could not be answered at all. */
export class PiRpcError extends Error {
  constructor(
    message: string,
    readonly command: string
  ) {
    super(message)
    this.name = 'PiRpcError'
  }
}

const MAX_FRAME_BYTES = 4 * 1024 * 1024
// one image at the structured cap after base64, plus room for the message text and JSON framing
export const MAX_WRITE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 * 1024 * 1024
const STDERR_TAIL_BYTES = 16 * 1024 * 3
const STDOUT_DRAIN_MS = 250
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const STDIN_GRACE_MS = 500
const TERM_GRACE_MS = 2_000

// omp rejects --no-mcp, so its offered tools are checked before each message instead
const DENY_ALL_ARGS: Record<PiVariant, string[]> = { pi: ['--no-tools', '--no-extensions', '--no-mcp'], omp: ['--no-tools', '--no-extensions'] }

/** The command-line arguments that start a pi or omp RPC child, resuming `resume` when given; only omp takes an approval mode. */
export function piLaunchArgs(
  variant: PiVariant,
  options: { model?: string; effort?: string; resume?: string; approvalMode?: string; denyAll?: boolean }
): string[] {
  const args = ['--mode', 'rpc']
  if (options.denyAll === true) args.push(...DENY_ALL_ARGS[variant])
  if (options.resume !== undefined) args.push(variant === 'pi' ? '--session' : '--resume', options.resume)
  if (options.model !== undefined) args.push('--model', options.model)
  if (options.effort !== undefined) args.push('--thinking', options.effort)
  if (options.approvalMode !== undefined && variant === 'omp') args.push('--approval-mode', options.approvalMode)
  return args
}

/** Starts the agent through the shared process runner and reads its stdout as LF-delimited JSON frames. */
export function spawnPiTransport(spec: PiTransportSpec, handlers: PiTransportHandlers, process: ProcessSpawner): PiTransport {
  return new ChildTransport(spec, handlers, process)
}

class ChildTransport implements PiTransport {
  private readonly handle: SpawnedProcess
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly exited = Promise.withResolvers<void>()
  private buffer = ''
  private startError = ''
  private closing = false
  private isExited = false
  private reported = false

  constructor(
    spec: PiTransportSpec,
    private readonly handlers: PiTransportHandlers,
    process: ProcessSpawner
  ) {
    this.handle = process.spawn([spec.executable, ...spec.args], {
      timeoutMs: null,
      cwd: spec.cwd,
      env: spec.env,
      stdin: 'pipe',
      stderrTailBytes: STDERR_TAIL_BYTES,
      killGraceMs: TERM_GRACE_MS
    })
    const stdoutDone = this.readStdout()
    void this.handle.exited.then(async (exit) => {
      if (exit.spawnError) this.startError = `\ncould not start ${spec.executable}: ${exit.spawnError.message}`
      await Promise.race([stdoutDone, new Promise((resolve) => setTimeout(resolve, STDOUT_DRAIN_MS))])
      this.isExited = true
      this.report({ code: exit.exitCode, signal: exit.signal })
      this.exited.resolve()
    })
  }

  get stderrTail(): string[] {
    return stderrLines(this.handle.stderrTail() + this.startError)
  }

  write(frame: PiFrame): void {
    if (this.closing || this.isExited) throw new Error('pi connection is closed')
    const line = JSON.stringify(frame)
    if (Buffer.byteLength(line) > MAX_WRITE_BYTES) throw new Error('pi message exceeds the frame limit')
    void this.handle.write(`${line}\n`)
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.exited.promise
      return
    }
    this.closing = true
    void this.handle.closeInput()
    await this.waitForExit(STDIN_GRACE_MS)
    if (this.isExited) return
    await this.handle.stop({ graceMs: TERM_GRACE_MS })
    await this.waitForExit(TERM_GRACE_MS)
  }

  private async readStdout(): Promise<void> {
    const reader = this.handle.stdout.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        this.readChunk(value)
      }
    } catch {
      // a stalled or failed pipe surfaces through the exit report
    } finally {
      reader.releaseLock()
    }
  }

  private readChunk(chunk: Uint8Array): void {
    if (this.closing || this.reported) return
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true })
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        let line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') continue
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('pi sent a frame over the size limit')
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          throw new Error('pi sent a line that is not JSON')
        }
        if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) throw new Error('pi sent a frame that is not an object')
        this.handlers.frame(frame as PiFrame)
        if (this.reported) return
      }
      if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) throw new Error('pi sent a frame over the size limit')
    } catch (error) {
      this.protocolFailure(error instanceof Error ? error.message : String(error))
    }
  }

  private protocolFailure(message: string): void {
    this.report({ code: null, signal: null, protocolError: message })
    void this.handle.stop()
  }

  private report(exit: Omit<PiExit, 'stderrTail'>): void {
    if (this.reported || this.closing) return
    this.reported = true
    try {
      this.handlers.exit({ ...exit, stderrTail: this.stderrTail })
    } catch {
      // the runner owns failures in its own exit handling
    }
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.isExited) return
    const timeout = Promise.withResolvers<void>()
    const timer = setTimeout(timeout.resolve, timeoutMs)
    await Promise.race([this.exited.promise, timeout.promise])
    clearTimeout(timer)
  }
}

type Pending = {
  command: string
  resolve(data: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export type PiRpcHandlers = {
  /** Every frame that is not the response to a request, in arrival order. */
  event(frame: PiFrame): void
  exit(exit: PiExit): void
}

/**
 * Request/response correlation over a `PiTransport`: `request` resolves with a response's `data`
 * and rejects on `success: false`, a timeout, or the child ending. Everything else the child
 * writes goes to `handlers.event`.
 */
export class PiRpc {
  private readonly pending = new Map<string, Pending>()
  private readonly transport: PiTransport
  private nextId = 1
  private ended: PiExit | null = null
  private closed = false

  constructor(
    spec: PiTransportSpec,
    private readonly handlers: PiRpcHandlers,
    process: ProcessSpawner,
    factory: PiTransportFactory = spawnPiTransport
  ) {
    this.transport = factory(
      spec,
      {
        frame: (frame) => this.receive(frame),
        exit: (exit) => this.end(exit)
      },
      process
    )
  }

  get stderrTail(): string[] {
    return this.transport.stderrTail
  }

  request(type: string, params: PiFrame = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.ended) return Promise.reject(new PiRpcError(describeExit(this.ended), type))
    if (this.closed) return Promise.reject(new PiRpcError('pi connection is closed', type))
    const id = `q${this.nextId++}`
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new PiRpcError(`${type} timed out after ${timeoutMs}ms`, type))
    }, timeoutMs)
    this.pending.set(id, { command: type, resolve, reject, timer })
    try {
      this.transport.write({ ...params, id, type })
    } catch (error) {
      clearTimeout(timer)
      this.pending.delete(id)
      reject(new PiRpcError(error instanceof Error ? error.message : String(error), type))
    }
    return promise
  }

  /** Writes a frame that expects no response, such as an `extension_ui_response`. */
  send(frame: PiFrame): void {
    if (this.ended || this.closed) return
    this.transport.write(frame)
  }

  async close(): Promise<void> {
    this.closed = true
    this.rejectPending((command) => new PiRpcError('pi connection closed', command))
    await this.transport.close()
  }

  private receive(frame: PiFrame): void {
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.success === true) pending.resolve(frame.data)
      else pending.reject(new PiRpcError(typeof frame.error === 'string' ? frame.error : `${pending.command} failed`, pending.command))
      return
    }
    if (frame.type === 'response') return
    this.handlers.event(frame)
  }

  private end(exit: PiExit): void {
    if (this.ended || this.closed) return
    this.ended = exit
    this.rejectPending((command) => new PiRpcError(describeExit(exit), command))
    this.handlers.exit(exit)
  }

  private rejectPending(error: (command: string) => Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error(pending.command))
    }
    this.pending.clear()
  }
}

/** One readable line for how a child ended, with the last of its stderr. */
export function describeExit(exit: PiExit): string {
  const how = exit.protocolError ?? `exited${exit.code === null ? '' : ` with code ${exit.code}`}${exit.signal ? ` (${exit.signal})` : ''}`
  return exit.stderrTail.length > 0 ? `${how}\n${exit.stderrTail.join('\n')}` : how
}
