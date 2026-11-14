import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PluginErrorKind } from '@quirky/protocol'

export type Language = 'typescript' | 'python'

export type ServerLocation = {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

export interface NavigationServer {
  readonly pid: number | null
  readonly runtime: string
  readonly serverPath: string
  readonly exited: Promise<{ exitCode: number | null; stderrTail: string }>
  definition(path: string, line: number, column: number): Promise<ServerLocation[]>
  references(path: string, line: number, column: number): Promise<ServerLocation[]>
  stop(): Promise<void>
}

export type ServerFactory = (worktree: { id: string; path: string }) => Promise<NavigationServer>

export type NavServerStatus = {
  worktreeId: string
  worktreePath: string
  language: Language
  pid: number | null
  runtime: string
  serverPath: string
  startedAt: number
  lastUsedAt: number
  requests: number
  inFlight: number
}

export class ServerPoolError extends Error {
  constructor(readonly kind: Extract<PluginErrorKind, 'not-found' | 'conflict'>, message: string) {
    super(message)
    this.name = 'ServerPoolError'
  }
}

export type TypeScriptResolver = (specifier: string, fromDirectory: string) => string | null | undefined

export function findTsServer(
  worktreePath: string,
  pluginDir: string,
  resolver?: TypeScriptResolver
): string {
  let realWorktreePath: string
  try {
    realWorktreePath = realpathSync(worktreePath)
  } catch {
    realWorktreePath = resolve(worktreePath)
  }
  const worktreeServer = join(realWorktreePath, 'node_modules', 'typescript', 'lib', 'tsserver.js')
  if (existsSync(worktreeServer)) return worktreeServer

  let resolved: string | null | undefined
  try {
    resolved = (resolver ?? resolveTypeScript)(`typescript/lib/tsserver.js`, pluginDir)
  } catch {
    resolved = undefined
  }
  if (resolved) return resolve(resolved)
  throw new ServerPoolError(
    'not-found',
    `could not find typescript tsserver for worktree ${worktreePath}`
  )
}

function resolveTypeScript(specifier: string, fromDirectory: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, fromDirectory)
  } catch {
    return undefined
  }
}

export function tsRuntime(): { runtime: 'node' | 'bun'; executable: string } {
  const node = Bun.which('node')
  return node ? { runtime: 'node', executable: node } : { runtime: 'bun', executable: process.execPath }
}

type PoolSignal =
  | { type: 'exit'; exit: { exitCode: number | null; stderrTail: string } }
  | { type: 'stop' }

type Entry = {
  key: string
  worktree: { id: string; path: string }
  language: Language
  state: 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed'
  server?: NavigationServer
  startPromise: Promise<NavigationServer>
  resolveStart(server: NavigationServer): void
  rejectStart(error: unknown): void
  signal?: PoolSignal
  cancellationListeners: Set<(signal: PoolSignal) => void>
  exit?: { exitCode: number | null; stderrTail: string }
  stopPromise?: Promise<void>
  idleTimer?: ReturnType<typeof setTimeout>
  startedAt: number
  lastUsedAt: number
  requests: number
  inFlight: number
}

type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }

export class ServerPool {
  private readonly entries = new Map<string, Entry>()
  private readonly factories: Partial<Record<Language, ServerFactory>>
  private readonly limits: Partial<Record<Language, number>>
  private readonly idleMs: number
  private readonly requestTimeoutMs: number
  private readonly timers: Timers
  private readonly now: () => number
  private admission: Promise<void> = Promise.resolve()
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(options: {
    factories: Partial<Record<Language, ServerFactory>>
    limits: Partial<Record<Language, number>>
    idleMs: number
    requestTimeoutMs: number
    timers?: Timers
    now?: () => number
  }) {
    this.factories = options.factories
    this.limits = options.limits
    this.idleMs = options.idleMs
    this.requestTimeoutMs = options.requestTimeoutMs
    this.timers = options.timers ?? { setTimeout, clearTimeout }
    this.now = options.now ?? Date.now
  }

  async use<T>(
    worktree: { id: string; path: string },
    language: Language,
    run: (server: NavigationServer) => Promise<T>
  ): Promise<T> {
    const entry = await this.reserve(worktree, language)
    try {
      const timeout = Promise.withResolvers<never>()
      const timeoutTimer = this.timers.setTimeout(() => {
        timeout.reject(new Error(`language server for worktree ${worktree.path} did not answer within ${this.requestTimeoutMs} ms`))
        void this.requestStop(entry).promise.catch(() => {})
      }, this.requestTimeoutMs)
      const operation = (async () => {
        const server = await entry.startPromise
        if (entry.exit) throw this.exitError(entry, entry.exit)
        if (entry.state !== 'running') throw this.stoppedError(entry)
        return await run(server)
      })()
      const cancellation = this.registerCancellation(entry)
      try {
        return await Promise.race([operation, timeout.promise, cancellation.promise])
      } finally {
        this.timers.clearTimeout(timeoutTimer)
        cancellation.unregister()
      }
    } finally {
      entry.inFlight--
      if (entry.inFlight === 0 && entry.state === 'running') this.scheduleIdle(entry)
    }
  }

  status(): NavServerStatus[] {
    return [...this.entries.values()]
      .filter((entry): entry is Entry & { server: NavigationServer } => entry.state === 'running' && entry.server !== undefined)
      .map((entry) => ({
        worktreeId: entry.worktree.id,
        worktreePath: entry.worktree.path,
        language: entry.language,
        pid: entry.server.pid,
        runtime: entry.server.runtime,
        serverPath: entry.server.serverPath,
        startedAt: entry.startedAt,
        lastUsedAt: entry.lastUsedAt,
        requests: entry.requests,
        inFlight: entry.inFlight
      }))
      .sort((a, b) => compare(a.worktreePath, b.worktreePath) || compare(a.language, b.language) || compare(a.worktreeId, b.worktreeId))
  }

  async stop(filter?: { worktreePath?: string; language?: Language }): Promise<number> {
    return await this.withAdmission(async () => {
      const matches = [...this.entries.values()].filter((entry) =>
        (filter?.worktreePath === undefined || entry.worktree.path === filter.worktreePath) &&
        (filter?.language === undefined || entry.language === filter.language)
      )
      const stopping = matches.map((entry) => this.requestStop(entry))
      await Promise.all(stopping.map(({ promise }) => promise))
      return stopping.filter(({ started }) => started).length
    })
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true
      this.disposePromise = this.stop().then(() => undefined)
    }
    return this.disposePromise
  }

  private async reserve(worktree: { id: string; path: string }, language: Language): Promise<Entry> {
    const key = JSON.stringify([worktree.id, language])
    while (true) {
      let waitForStop: Promise<void> | undefined
      const entry = await this.withAdmission(async () => {
        if (this.disposed) throw new Error('server pool is disposed')
        const existing = this.entries.get(key)
        if (existing) {
          if (existing.state === 'stopping') {
            waitForStop = existing.stopPromise ?? Promise.resolve()
            return undefined
          }
          this.markUsed(existing)
          return existing
        }

        const limit = this.limits[language] ?? Number.POSITIVE_INFINITY
        while (this.count(language) >= limit) {
          if (this.disposed) throw new Error('server pool is disposed')
          const victim = this.leastRecentlyUsedIdle(language)
          if (!victim) {
            const stopping = [...this.entries.values()].filter((entry) =>
              entry.language === language && entry.state === 'stopping'
            )
            if (stopping.length > 0) {
              waitForStop = Promise.allSettled(stopping.map((entry) => entry.stopPromise ?? Promise.resolve()))
                .then(() => undefined)
              return undefined
            }
            throw new ServerPoolError('conflict', `all ${language} servers are busy; cannot start one for worktree ${worktree.path}`)
          }
          await this.requestStop(victim).promise
        }
        if (this.disposed) throw new Error('server pool is disposed')

        const factory = this.factories[language]
        if (!factory) throw new Error(`no server factory configured for ${language}`)
        const start = Promise.withResolvers<NavigationServer>()
        const entry: Entry = {
          key,
          worktree,
          language,
          state: 'starting',
          startPromise: start.promise,
          resolveStart: start.resolve,
          rejectStart: start.reject,
          cancellationListeners: new Set(),
          startedAt: this.now(),
          lastUsedAt: this.now(),
          requests: 0,
          inFlight: 0
        }
        this.entries.set(key, entry)
        this.markUsed(entry)
        this.start(entry, factory)
        return entry
      })
      if (entry) return entry
      await waitForStop
    }
  }

  private start(entry: Entry, factory: ServerFactory): void {
    void Promise.resolve()
      .then(() => factory(entry.worktree))
      .then((server) => {
        entry.server = server
        if (entry.state === 'starting') entry.state = 'running'
        void server.exited.then(
          (exit) => this.serverExited(entry, exit),
          (error: unknown) => this.serverExited(entry, {
            exitCode: null,
            stderrTail: error instanceof Error ? error.message : String(error)
          })
        )
        entry.resolveStart(server)
      }, (error: unknown) => {
        entry.state = 'failed'
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
        entry.rejectStart(error)
      })
  }

  private markUsed(entry: Entry): void {
    this.clearIdle(entry)
    entry.lastUsedAt = this.now()
    entry.requests++
    entry.inFlight++
  }

  private count(language: Language): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.language === language) count++
    return count
  }

  private leastRecentlyUsedIdle(language: Language): Entry | undefined {
    return [...this.entries.values()]
      .filter((entry) => entry.language === language && entry.state === 'running' && entry.inFlight === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.startedAt - b.startedAt || compare(a.worktree.id, b.worktree.id))[0]
  }

  private scheduleIdle(entry: Entry): void {
    this.clearIdle(entry)
    entry.idleTimer = this.timers.setTimeout(() => {
      entry.idleTimer = undefined
      if (entry.state === 'running' && entry.inFlight === 0) {
        void this.requestStop(entry).promise.catch(() => {})
      }
    }, this.idleMs)
  }

  private clearIdle(entry: Entry): void {
    if (entry.idleTimer !== undefined) {
      this.timers.clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  private requestStop(entry: Entry): { started: boolean; promise: Promise<void> } {
    if (entry.stopPromise) return { started: false, promise: entry.stopPromise }
    if (entry.state === 'stopped' || entry.state === 'exited' || entry.state === 'failed') {
      return { started: false, promise: Promise.resolve() }
    }
    entry.state = 'stopping'
    this.resolveSignal(entry, { type: 'stop' })
    this.clearIdle(entry)
    const promise = (async () => {
      try {
        const server = await entry.startPromise.catch(() => undefined)
        if (server && !entry.exit) await server.stop()
      } finally {
        this.clearIdle(entry)
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
        if (entry.state !== 'exited') entry.state = 'stopped'
      }
    })()
    entry.stopPromise = promise
    return { started: true, promise }
  }

  private serverExited(entry: Entry, exit: { exitCode: number | null; stderrTail: string }): void {
    entry.exit = exit
    entry.state = 'exited'
    this.clearIdle(entry)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    this.resolveSignal(entry, { type: 'exit', exit })
  }

  private registerCancellation(entry: Entry): { promise: Promise<never>; unregister(): void } {
    const { promise, reject } = Promise.withResolvers<never>()
    const listener = (signal: PoolSignal) => {
      reject(signal.type === 'exit' ? this.exitError(entry, signal.exit) : this.stoppedError(entry))
    }
    if (entry.signal) listener(entry.signal)
    else entry.cancellationListeners.add(listener)
    return {
      promise,
      unregister: () => entry.cancellationListeners.delete(listener)
    }
  }

  private resolveSignal(entry: Entry, signal: PoolSignal): void {
    if (entry.signal) return
    entry.signal = signal
    for (const listener of entry.cancellationListeners) listener(signal)
    entry.cancellationListeners.clear()
  }

  private exitError(entry: Entry, exit: { exitCode: number | null; stderrTail: string }): Error {
    const code = exit.exitCode === null ? 'unknown' : String(exit.exitCode)
    const detail = exit.stderrTail ? `: ${exit.stderrTail}` : ''
    return new Error(`language server for worktree ${entry.worktree.path} exited with code ${code}${detail}`)
  }

  private stoppedError(entry: Entry): Error {
    return new Error(`language server for worktree ${entry.worktree.path} was stopped`)
  }

  private async withAdmission<T>(action: () => Promise<T> | T): Promise<T> {
    const next = Promise.withResolvers<void>()
    const previous = this.admission
    this.admission = next.promise
    await previous
    try {
      return await action()
    } finally {
      next.resolve()
    }
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
