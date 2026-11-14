import { realpathSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ProcessSpawner, SpawnedProcess } from '@quirky/protocol'
import { MessageReader } from './framing'
import type { NavigationServer, ServerLocation } from './servers'

type Position = { line: number; offset: number }
type Response = { body?: unknown }
type OpenFile = { mtimeMs: number; size: number; used: number }
type PendingRequest = { resolve: (response: Response) => void; reject: (error: Error) => void }
type TsServerOptions = {
  process: ProcessSpawner
  worktreePath: string
  serverPath: string
  runtime: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function toLocation(value: unknown): ServerLocation | undefined {
  if (!isRecord(value) || typeof value.file !== 'string' || !isRecord(value.start) || !isRecord(value.end)) return
  const start = value.start
  const end = value.end
  if (
    typeof start.line !== 'number' || typeof start.offset !== 'number' ||
    typeof end.line !== 'number' || typeof end.offset !== 'number'
  ) return
  return {
    path: value.file,
    line: start.line,
    column: start.offset,
    endLine: end.line,
    endColumn: end.offset,
  }
}

function mapLocations(value: unknown): ServerLocation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const location = toLocation(item)
    return location ? [location] : []
  })
}

export class TsServer implements NavigationServer {
  readonly pid: number | null
  readonly runtime: string
  readonly serverPath: string
  readonly exited: Promise<{ exitCode: number | null; stderrTail: string }>

  private readonly worktreePath: string
  private readonly child: SpawnedProcess
  private readonly messageReader = new MessageReader()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly openFiles = new Map<string, OpenFile>()
  private sequence = 0
  private useSequence = 0
  private stopping = false
  private stopPromise: Promise<void> | undefined

  constructor(options: TsServerOptions) {
    this.worktreePath = realpathSync(options.worktreePath)
    this.runtime = basename(options.runtime) === 'node' ? 'node' : 'bun'
    this.serverPath = options.serverPath
    this.child = options.process.spawn(
      [options.runtime, options.serverPath, '--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents', '--locale', 'en'],
      { cwd: this.worktreePath, stdin: 'pipe', stdout: 'pipe', stderr: 'tail', timeoutMs: null },
    )
    this.pid = this.child.pid
    this.exited = this.child.exited.then(({ exitCode }) => {
      this.failPending(new Error(`tsserver for ${this.worktreePath} exited with code ${exitCode}`))
      return { exitCode, stderrTail: this.child.stderrTail() }
    })
    void this.readOutput().catch((error: unknown) => {
      this.stopping = true
      this.failPending(asError(error))
      void this.child.stop()
    })
  }

  async definition(path: string, line: number, column: number): Promise<ServerLocation[]> {
    const file = this.prepareFile(path)
    const response = await this.request('definition', { file, line, offset: column })
    return mapLocations(response.body)
  }

  async references(path: string, line: number, column: number): Promise<ServerLocation[]> {
    const file = this.prepareFile(path)
    const response = await this.request('references', { file, line, offset: column })
    return mapLocations(isRecord(response.body) ? response.body.refs : undefined)
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true
      this.stopPromise = (async () => {
        void this.child.write(this.encodeRequest(this.sequence++, 'exit'))
        await this.child.stop()
      })()
    }
    return this.stopPromise
  }

  private prepareFile(path: string): string {
    if (this.stopping) throw new Error(`tsserver for ${this.worktreePath} is stopping`)
    const file = resolve(this.worktreePath, path)
    const stats = statSync(file)
    const open = this.openFiles.get(file)
    if (!open) {
      this.openFiles.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, used: ++this.useSequence })
      this.sendWithoutResponse('open', { file, projectRootPath: this.worktreePath })
      this.closeLeastRecentlyUsed()
    } else {
      open.used = ++this.useSequence
    }
    for (const [openPath, openFile] of this.openFiles) {
      const openStats = openPath === file ? stats : statSync(openPath, { throwIfNoEntry: false })
      if (!openStats?.isFile()) {
        this.openFiles.delete(openPath)
        this.sendWithoutResponse('close', { file: openPath })
        continue
      }
      if (openFile.mtimeMs === openStats.mtimeMs && openFile.size === openStats.size) continue
      openFile.mtimeMs = openStats.mtimeMs
      openFile.size = openStats.size
      this.sendWithoutResponse('reload', { file: openPath, tmpfile: openPath })
    }
    return file
  }

  private closeLeastRecentlyUsed(): void {
    while (this.openFiles.size > 64) {
      let oldestPath: string | undefined
      let oldestUse = Number.POSITIVE_INFINITY
      for (const [path, open] of this.openFiles) {
        if (open.used < oldestUse) {
          oldestPath = path
          oldestUse = open.used
        }
      }
      if (oldestPath === undefined) return
      this.openFiles.delete(oldestPath)
      this.sendWithoutResponse('close', { file: oldestPath })
    }
  }

  private sendWithoutResponse(command: string, args: Record<string, unknown>): void {
    void this.child.write(this.encodeRequest(this.sequence++, command, args))
  }

  private async request(command: string, args: Record<string, unknown>): Promise<Response> {
    if (this.stopping) throw new Error(`tsserver for ${this.worktreePath} is stopping`)
    const sequence = this.sequence++
    let resolveResponse!: (response: Response) => void
    let rejectResponse!: (error: Error) => void
    const response = new Promise<Response>((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    void response.catch(() => {})
    this.pending.set(sequence, { resolve: resolveResponse, reject: rejectResponse })
    const written = await this.child.write(this.encodeRequest(sequence, command, args))
    if (!written) {
      const pending = this.pending.get(sequence)
      if (pending) {
        this.pending.delete(sequence)
        pending.reject(new Error(`tsserver for ${this.worktreePath} is not accepting requests`))
      }
    }
    return response
  }

  private encodeRequest(sequence: number, command: string, args?: Record<string, unknown>): string {
    const request = args
      ? { seq: sequence, type: 'request', command, arguments: args }
      : { seq: sequence, type: 'request', command }
    return `${JSON.stringify(request)}\n`
  }

  private async readOutput(): Promise<void> {
    const reader = this.child.stdout.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        for (const message of this.messageReader.push(value)) this.receive(message)
      }
    } finally {
      reader.releaseLock()
    }
  }

  private receive(value: unknown): void {
    if (!isRecord(value) || value.type !== 'response' || typeof value.request_seq !== 'number') return
    const pending = this.pending.get(value.request_seq)
    if (!pending) return
    this.pending.delete(value.request_seq)
    if (value.success === false) {
      const message = typeof value.message === 'string'
        ? value.message.split(/\r?\n/, 1)[0]!
        : 'tsserver request failed'
      pending.reject(new Error(message))
      return
    }
    pending.resolve(value)
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
