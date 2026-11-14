import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ProcessSpawner, SpawnExit, SpawnedProcess } from '@quirky/protocol'
import { MessageReader } from './framing'
import type { NavigationServer, ServerLocation } from './servers'

type LspServerOptions = {
  process: ProcessSpawner
  argv: readonly string[]
  root: string
  runtime: string
  serverPath: string
  readyTimeoutMs?: number
  shutdownTimeoutMs?: number
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

type Position = { line: number; character: number }
type Range = { start: Position; end: Position }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

function locationFrom(value: unknown): ServerLocation | undefined {
  if (!isRecord(value)) return
  const uri = typeof value.uri === 'string'
    ? value.uri
    : typeof value.targetUri === 'string' ? value.targetUri : undefined
  const rangeValue = isRecord(value.range)
    ? value.range
    : isRecord(value.targetSelectionRange) ? value.targetSelectionRange : undefined
  if (uri === undefined || rangeValue === undefined) return

  let path: string
  try {
    const parsedUri = new URL(uri)
    if (parsedUri.protocol !== 'file:') return
    path = fileURLToPath(parsedUri)
  } catch {
    return
  }

  const start = rangeValue.start
  const end = rangeValue.end
  if (!isRecord(start) || !isRecord(end)) return
  if (
    typeof start.line !== 'number' || !Number.isInteger(start.line) || start.line < 0 ||
    typeof start.character !== 'number' || !Number.isInteger(start.character) || start.character < 0 ||
    typeof end.line !== 'number' || !Number.isInteger(end.line) || end.line < 0 ||
    typeof end.character !== 'number' || !Number.isInteger(end.character) || end.character < 0
  ) return

  return {
    path,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  }
}

function mapLocations(value: unknown): ServerLocation[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  return values.flatMap((item) => {
    const location = locationFrom(item)
    return location ? [location] : []
  })
}

export class LspStartError extends Error {
  readonly exitCode: number | null
  readonly stderrTail: string

  constructor(message: string, exitCode: number | null, stderrTail: string) {
    const tail = stderrTail.trim()
    super(tail && !message.includes(tail) ? `${message}: ${tail}` : message)
    this.name = 'LspStartError'
    this.exitCode = exitCode
    this.stderrTail = stderrTail
  }
}

type StartupAccess = {
  start: () => Promise<void>
  fail: (reason: unknown) => Promise<LspStartError>
}

const startupAccess = new WeakMap<LspServer, StartupAccess>()

export class LspServer implements NavigationServer {
  readonly pid: number | null
  readonly runtime: string
  readonly serverPath: string
  readonly exited: Promise<{ exitCode: number | null; stderrTail: string }>

  private readonly root: string
  private readonly child: SpawnedProcess
  private readonly messageReader = new MessageReader()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly readyTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private sequence = 0
  private stopping = false
  private stopPromise: Promise<void> | undefined
  private exitResult: SpawnExit | undefined
  private fatalError: Error | undefined

  constructor(options: LspServerOptions) {
    this.root = realpathSync(options.root)
    this.runtime = options.runtime
    this.serverPath = options.serverPath
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000
    this.child = options.process.spawn(options.argv, {
      cwd: this.root,
      timeoutMs: null,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'tail',
    })
    this.pid = this.child.pid
    this.exited = this.child.exited.then((exit) => {
      this.exitResult = exit
      const result = { exitCode: exit.exitCode, stderrTail: this.child.stderrTail() }
      this.failPending(this.exitError(exit))
      return result
    })
    startupAccess.set(this, {
      start: () => this.start(),
      fail: (reason) => this.failStartup(reason),
    })
    void this.readOutput()
  }

  async definition(path: string, line: number, column: number): Promise<ServerLocation[]> {
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: pathToFileURL(resolve(this.root, path)).href },
      position: { line: line - 1, character: column - 1 },
    })
    return mapLocations(result)
  }

  async references(path: string, line: number, column: number): Promise<ServerLocation[]> {
    const result = await this.request('textDocument/references', {
      textDocument: { uri: pathToFileURL(resolve(this.root, path)).href },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true },
    })
    return mapLocations(result)
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true
      this.stopPromise = this.stopGracefully()
    }
    return this.stopPromise
  }

  private async start(): Promise<void> {
    const rootUri = pathToFileURL(this.root).href
    const response = await this.request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: { general: { positionEncodings: ['utf-16'] } },
      workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
    }, this.readyTimeoutMs)
    if (!isRecord(response) || !isRecord(response.capabilities)) {
      throw new Error('LSP server returned an invalid initialize response')
    }
    const positionEncoding = response.capabilities.positionEncoding
    if (positionEncoding !== undefined && positionEncoding !== 'utf-16') {
      throw new Error(`LSP server selected unsupported position encoding ${String(positionEncoding)}`)
    }
    await this.sendNotification('initialized')
  }

  private async failStartup(reason: unknown): Promise<LspStartError> {
    const error = asError(reason)
    this.stopping = true
    this.failPending(error)
    const exit = await this.child.stop()
    await this.exited
    const exitCode = this.exitResult?.exitCode ?? exit.exitCode
    return new LspStartError(error.message, exitCode, this.child.stderrTail())
  }

  private async stopGracefully(): Promise<void> {
    const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<boolean>()
    const timer = setTimeout(() => resolveTimeout(false), this.shutdownTimeoutMs)
    const graceful = this.shutdownSequence().then(() => true, () => false)
    const didStopGracefully = await Promise.race([graceful, timeout])
    clearTimeout(timer)
    if (!didStopGracefully) {
      this.failPending(new Error('LSP server shutdown timed out'))
      if (!this.exitResult) await this.child.write(frame({ jsonrpc: '2.0', method: 'exit' }))
      await this.child.stop()
    }
    await this.exited
  }

  private async shutdownSequence(): Promise<void> {
    await this.request('shutdown')
    await this.sendNotification('exit')
    await this.exited
  }

  private async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.exitResult) throw this.exitError(this.exitResult)
    if (this.fatalError) throw this.fatalError
    if (this.stopping && method !== 'shutdown') throw new Error(`LSP server for ${this.root} is stopping`)

    const id = this.sequence++
    const { promise: response, resolve: resolveResponse, reject: rejectResponse } = Promise.withResolvers<unknown>()
    void response.catch(() => {})
    const pending: PendingRequest = { method, resolve: resolveResponse, reject: rejectResponse }
    this.pending.set(id, pending)
    if (timeoutMs !== undefined) {
      pending.timer = setTimeout(() => {
        this.rejectRequest(id, new Error(`LSP server did not answer initialize within ${timeoutMs}ms`))
      }, timeoutMs)
    }

    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    try {
      if (!await this.child.write(frame(message))) {
        this.rejectRequest(id, new Error(`LSP server is not accepting ${method} requests`))
      }
    } catch (error) {
      this.rejectRequest(id, asError(error))
    }
    return response
  }

  private async sendNotification(method: string): Promise<void> {
    if (this.exitResult) throw this.exitError(this.exitResult)
    const written = await this.child.write(frame({ jsonrpc: '2.0', method }))
    if (!written) throw new Error(`LSP server is not accepting ${method} notifications`)
  }

  private async readOutput(): Promise<void> {
    const reader = this.child.stdout.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (this.pending.size > 0 && !this.exitResult) await this.exited
          return
        }
        for (const message of this.messageReader.push(value)) this.receive(message)
      }
    } catch (error) {
      this.failOutput(asError(error))
    } finally {
      reader.releaseLock()
    }
  }

  private receive(value: unknown): void {
    if (!isRecord(value)) return
    if (typeof value.method === 'string') {
      if (Object.prototype.hasOwnProperty.call(value, 'id')) this.answerServerRequest(value)
      return
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'id') || typeof value.id !== 'number') return
    const pending = this.pending.get(value.id)
    if (!pending) return
    this.pending.delete(value.id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (isRecord(value.error)) {
      const message = typeof value.error.message === 'string' ? value.error.message : 'unknown server error'
      const code = typeof value.error.code === 'number' ? ` (${value.error.code})` : ''
      pending.reject(new Error(`LSP ${pending.method} request failed${code}: ${message}`))
      return
    }
    pending.resolve(value.result)
  }

  private answerServerRequest(value: Record<string, unknown>): void {
    const id = value.id
    let result: unknown = null
    if (value.method === 'workspace/configuration') {
      const params = value.params
      const items = isRecord(params) && Array.isArray(params.items) ? params.items : []
      result = items.map(() => null)
    }
    void this.child.write(frame({ jsonrpc: '2.0', id, result }))
  }

  private rejectRequest(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.reject(error)
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private failOutput(error: Error): void {
    if (this.exitResult || this.fatalError) return
    this.fatalError = error
    this.failPending(error)
    void this.child.stop()
  }

  private exitError(exit: SpawnExit): Error {
    const detail = exit.spawnError ? `: ${exit.spawnError.message}` : ''
    return new Error(`LSP server for ${this.root} exited with code ${exit.exitCode}${detail}`)
  }
}

export async function startLspServer(options: LspServerOptions): Promise<LspServer> {
  const server = new LspServer(options)
  const access = startupAccess.get(server)!
  try {
    await access.start()
  } catch (error) {
    throw await access.fail(error)
  }
  return server
}
