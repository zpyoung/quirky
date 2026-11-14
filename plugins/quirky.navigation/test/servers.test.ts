import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  findTsServer,
  ServerPoolError,
  ServerPool,
  tsRuntime,
  type Language,
  type NavigationServer,
  type ServerFactory
} from '../src/servers'

const pools: ServerPool[] = []
const roots: string[] = []

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

class FakeTimers {
  private time = 0
  private nextId = 0
  private readonly tasks = new Map<number, { due: number; callback: () => void }>()
  readonly setTimeout: typeof setTimeout
  readonly clearTimeout: typeof clearTimeout

  constructor() {
    this.setTimeout = ((callback: () => void, delay = 0) => {
      const id = ++this.nextId
      this.tasks.set(id, { due: this.time + delay, callback })
      return id
    }) as unknown as typeof setTimeout
    this.clearTimeout = ((handle: unknown) => {
      this.tasks.delete(Number(handle))
    }) as typeof clearTimeout
  }

  now = (): number => this.time

  async advanceBy(milliseconds: number): Promise<void> {
    const target = this.time + milliseconds
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
      if (!next) break
      const [id, task] = next
      this.tasks.delete(id)
      this.time = task.due
      task.callback()
      await flushPromises()
    }
    this.time = target
    await flushPromises()
  }
}

class FakeServer implements NavigationServer {
  readonly pid: number
  readonly runtime = 'node'
  readonly serverPath = '/fake/tsserver.js'
  readonly exited: Promise<{ exitCode: number | null; stderrTail: string }>
  private resolveExit!: (value: { exitCode: number | null; stderrTail: string }) => void
  stopCalls = 0

  constructor(pid: number) {
    this.pid = pid
    const exit = Promise.withResolvers<{ exitCode: number | null; stderrTail: string }>()
    this.exited = exit.promise
    this.resolveExit = exit.resolve
  }

  async definition(): Promise<[]> { return [] }
  async references(): Promise<[]> { return [] }
  async stop(): Promise<void> {
    this.stopCalls++
    this.exit(0)
  }

  exit(exitCode: number | null, stderrTail = ''): void {
    this.resolveExit({ exitCode, stderrTail })
  }
}

class DelayedStopServer extends FakeServer {
  readonly finishStop = deferred<void>()

  override async stop(): Promise<void> {
    this.stopCalls++
    await this.finishStop.promise
    this.exit(0)
  }
}

type PoolSetup = {
  pool: ServerPool
  clock: FakeTimers
  created: Array<{ worktree: { id: string; path: string }; server: NavigationServer }>
}

function createPool(options: {
  factory?: ServerFactory
  limits?: Partial<Record<Language, number>>
  idleMs?: number
  requestTimeoutMs?: number
} = {}): PoolSetup {
  const clock = new FakeTimers()
  const created: PoolSetup['created'] = []
  let pid = 100
  const factory = options.factory ?? (async (worktree) => {
    const server = new FakeServer(pid++)
    created.push({ worktree, server })
    return server
  })
  const pool = new ServerPool({
    factories: { typescript: factory, python: factory },
    limits: options.limits ?? { typescript: 2, python: 2 },
    idleMs: options.idleMs ?? 600_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    now: clock.now
  })
  pools.push(pool)
  return { pool, clock, created }
}

function worktree(id: string): { id: string; path: string } {
  return { id, path: `/worktrees/${id}` }
}

async function runOnce(pool: ServerPool, wt: { id: string; path: string }, language: Language = 'typescript'): Promise<void> {
  await pool.use(wt, language, async () => undefined)
}

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ServerPool', () => {
  test('coalesces concurrent first use into one server start', async () => {
    const start = deferred<NavigationServer>()
    let starts = 0
    const { pool } = createPool({ factory: async () => { starts++; return await start.promise } })
    const wt = worktree('same')
    const first = pool.use(wt, 'typescript', async () => 'first')
    const second = pool.use(wt, 'typescript', async () => 'second')

    await flushPromises()
    expect(starts).toBe(1)
    start.resolve(new FakeServer(101))
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
  })

  test('evicts the least-recently-used idle TypeScript server at the cap', async () => {
    const { pool, clock, created } = createPool({ limits: { typescript: 2 } })
    const a = worktree('a')
    const b = worktree('b')
    const c = worktree('c')
    await runOnce(pool, a)
    await clock.advanceBy(1)
    await runOnce(pool, b)
    await clock.advanceBy(1)

    await runOnce(pool, c)

    expect(created).toHaveLength(3)
    expect((created[0].server as FakeServer).stopCalls).toBe(1)
    expect(pool.status().map((server) => server.worktreeId).sort()).toEqual(['b', 'c'])
  })

  test('rejects a third worktree when every server is busy without stopping either', async () => {
    const { pool, created } = createPool({ limits: { typescript: 2 } })
    const a = worktree('busy-a')
    const b = worktree('busy-b')
    const heldA = deferred<void>()
    const heldB = deferred<void>()
    const requestA = pool.use(a, 'typescript', () => heldA.promise)
    const requestB = pool.use(b, 'typescript', () => heldB.promise)
    await flushPromises()

    const error = await pool.use(worktree('busy-c'), 'typescript', async () => undefined).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ServerPoolError)
    expect(error).toMatchObject({ kind: 'conflict' })
    expect((error as Error).message).toContain('busy')
    expect(created.map(({ server }) => (server as FakeServer).stopCalls)).toEqual([0, 0])
    heldA.resolve()
    heldB.resolve()
    await Promise.all([requestA, requestB])
  })

  test('waits for an idle server stop before admitting work at capacity', async () => {
    const servers: FakeServer[] = []
    const { pool, clock } = createPool({
      limits: { typescript: 1 },
      idleMs: 10,
      factory: async () => {
        const server = servers.length === 0 ? new DelayedStopServer(301) : new FakeServer(302)
        servers.push(server)
        return server
      }
    })
    await runOnce(pool, worktree('expiring'))
    const expiring = servers[0] as DelayedStopServer
    await clock.advanceBy(10)
    expect(expiring.stopCalls).toBe(1)

    const pending = pool.use(worktree('waiting'), 'typescript', async () => undefined)
    void pending.catch(() => {})
    try {
      await flushPromises()
      expect(servers).toHaveLength(1)
    } finally {
      expiring.finishStop.resolve()
    }

    await expect(pending).resolves.toBeUndefined()
    expect(servers).toHaveLength(2)
    expect(pool.status().map((server) => server.worktreeId)).toEqual(['waiting'])
  })

  test('stops a server after its idle timeout and resets the timeout on use', async () => {
    const { pool, clock, created } = createPool({ idleMs: 10 })
    await runOnce(pool, worktree('idle'))
    await clock.advanceBy(9)
    await runOnce(pool, worktree('idle'))
    await clock.advanceBy(9)
    expect(pool.status()).toHaveLength(1)
    await clock.advanceBy(1)
    await pool.stop()

    expect(pool.status()).toEqual([])
    expect((created[0].server as FakeServer).stopCalls).toBe(1)
  })

  test('rejects pending requests on process exit and starts a replacement next time', async () => {
    const { pool, created } = createPool()
    const wt = worktree('crashed')
    const pending = deferred<void>()
    const firstRequest = pool.use(wt, 'typescript', () => pending.promise)
    await flushPromises()
    const firstServer = created[0].server as FakeServer
    firstServer.exit(17)

    const error = await firstRequest.catch((caught: unknown) => caught)
    expect((error as Error).message).toContain(wt.path)
    expect((error as Error).message).toContain('17')
    expect(pool.status()).toEqual([])

    await runOnce(pool, wt)
    expect(created).toHaveLength(2)
    expect(pool.status()[0].pid).not.toBe(firstServer.pid)
  })

  test('preserves exit details when a server exits before startup resolves', async () => {
    const servers: FakeServer[] = []
    const { pool } = createPool({
      factory: async () => {
        const server = new FakeServer(401 + servers.length)
        if (servers.length === 0) server.exit(23, 'startup stderr')
        servers.push(server)
        return server
      }
    })
    const wt = worktree('startup-crash')

    const error = await pool.use(wt, 'typescript', async () => undefined).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(wt.path)
    expect((error as Error).message).toContain('23')
    expect((error as Error).message).toContain('startup stderr')
    await runOnce(pool, wt)
    expect(servers).toHaveLength(2)
    expect(pool.status().map((server) => server.pid)).toEqual([402])
  })

  test('stops matching worktrees and all remaining servers idempotently', async () => {
    const { pool } = createPool()
    const a = worktree('filter-a')
    const b = worktree('filter-b')
    await runOnce(pool, a)
    await runOnce(pool, a, 'python')
    await runOnce(pool, b)

    await expect(pool.stop({ worktreePath: a.path })).resolves.toBe(2)
    expect(pool.status().map((server) => server.worktreePath)).toEqual([b.path])
    await expect(pool.stop()).resolves.toBe(1)
    await expect(pool.stop()).resolves.toBe(0)
    expect(pool.status()).toEqual([])
  })

  test('stops a server that finishes starting after stop was requested', async () => {
    const start = deferred<NavigationServer>()
    const { pool } = createPool({ factory: async () => await start.promise })
    const wt = worktree('starting')
    const pending = pool.use(wt, 'typescript', async () => undefined)
    await flushPromises()
    const stopping = pool.stop({ worktreePath: wt.path })
    await flushPromises()
    start.resolve(new FakeServer(201))

    await expect(pending).rejects.toThrow(wt.path)
    await expect(stopping).resolves.toBe(1)
    expect(pool.status()).toEqual([])
  })

  test('times out an unanswered request and stops its server', async () => {
    const { pool, clock, created } = createPool({ requestTimeoutMs: 5 })
    const pending = deferred<void>()
    const request = pool.use(worktree('slow'), 'typescript', () => pending.promise)
    await flushPromises()
    await clock.advanceBy(5)

    await expect(request).rejects.toThrow('did not answer')
    await pool.stop()
    expect((created[0].server as FakeServer).stopCalls).toBe(1)
    expect(pool.status()).toEqual([])
  })
})

describe('TypeScript server locators', () => {
  test('prefers the worktree TypeScript installation over the plugin copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'quirky-navigation-'))
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    const pluginDir = join(root, 'plugin')
    const localServer = join(worktreePath, 'node_modules', 'typescript', 'lib', 'tsserver.js')
    mkdirSync(join(worktreePath, 'node_modules', 'typescript', 'lib'), { recursive: true })
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(localServer, '')

    const expectedServer = join(realpathSync(worktreePath), 'node_modules', 'typescript', 'lib', 'tsserver.js')
    expect(findTsServer(worktreePath, pluginDir, () => '/plugin/typescript/lib/tsserver.js')).toBe(expectedServer)
  })

  test('reports a not-found error when neither TypeScript resolver finds tsserver', () => {
    const error = (() => {
      try {
        findTsServer('/missing/worktree', '/missing/plugin', () => undefined)
      } catch (caught) {
        return caught
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(ServerPoolError)
    expect(error).toMatchObject({ kind: 'not-found' })
    expect((error as Error).message).toContain('typescript')
  })

  test('uses Node from PATH for TypeScript when available, otherwise Bun', () => {
    const node = Bun.which('node')
    expect(tsRuntime()).toEqual(node ? { runtime: 'node', executable: node } : { runtime: 'bun', executable: process.execPath })
  })
})
