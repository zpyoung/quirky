import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { PluginCaller, PluginContext, PluginStore, Repo } from '@quirky/protocol'
import { LedgerEngine } from '../src/daemon/engine'
import type { OwnerCatalog } from '../src/daemon/owners'
import { migrations } from '../src/daemon/store'

type Counters = { transactions: number; writes: number }
type RpcCounts = Record<string, number>
type Deferred = { promise: Promise<void>; resolve(): void }
type CatalogResponse = { owners: { id: string }[] }
type RpcFailure = Error & { data?: { kind?: string } }

function deferred(): Deferred {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

class ReadBarrier {
  private readonly completion = deferred()
  private readonly released = deferred()
  private assigned = 0
  readonly entered = this.completion.promise

  claim(): boolean {
    if (this.assigned === 3) return false
    this.assigned += 1
    if (this.assigned === 3) this.completion.resolve()
    return true
  }

  async wait(): Promise<void> {
    await this.released.promise
  }

  release(): void {
    this.released.resolve()
  }
}

const repo = (id: string): Repo => ({
  id,
  kind: 'git',
  name: id,
  displayName: id,
  path: `/tmp/quirky-ledger-catalog-freshness/${id}`
} as Repo)

function cloneCatalog(catalog: OwnerCatalog): OwnerCatalog {
  return { repos: [...catalog.repos], groups: [...catalog.groups], worktrees: [...catalog.worktrees] }
}

type CatalogFixture = {
  engine: LedgerEngine
  counters: Counters
  rpcCounts: RpcCounts
  initialRepo: Repo
  start(): Promise<void>
  request(): Promise<CatalogResponse>
  gateNextRead(): ReadBarrier
  failNextRead(error: Error): void
  removeRepo(id: string): Promise<void>
  callSnapshot(): RpcCounts
  dispose(): Promise<void>
}

function createFixture(): CatalogFixture {
  const counters: Counters = { transactions: 0, writes: 0 }
  const rpcCounts: RpcCounts = {}
  const listeners = new Set<(event: never) => void | Promise<void>>()
  const initialRepo = repo('repo-alpha')
  let catalog: OwnerCatalog = { repos: [initialRepo], groups: [], worktrees: [] }
  let database: Database | undefined
  let schemaVersion = 0
  let nextBarrier: ReadBarrier | undefined
  let nextFailure: { method: string; error: Error } | undefined

  const context = {
    pluginId: 'quirky.ledger',
    dir: '/tmp',
    dataDir: '/tmp',
    home: '/tmp',
    log() {},
    provide() {},
    emit() { return true },
    subscribe(listener: (event: never) => void | Promise<void>) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async call(method: string): Promise<unknown> {
      rpcCounts[method] = (rpcCounts[method] ?? 0) + 1
      // snapshot before the barrier so mutation while held cannot rewrite an old read's result.
      const snapshot = cloneCatalog(catalog)
      const barrier = nextBarrier?.claim() ? nextBarrier : undefined
      if (nextBarrier && method === 'quirky.worktree/list') nextBarrier = undefined
      const failure = nextFailure?.method === method ? nextFailure : undefined
      if (failure) nextFailure = undefined
      await barrier?.wait()
      if (failure) throw failure.error
      if (method === 'quirky.repo/list') return snapshot.repos
      if (method === 'quirky.repo/groupList') return snapshot.groups
      if (method === 'quirky.worktree/list') return snapshot.worktrees
      throw new Error(`unexpected catalog RPC ${method}`)
    },
    openStore(steps: typeof migrations): PluginStore {
      database = new Database(':memory:')
      const db = database
      const created: PluginStore = {
        get version() { return schemaVersion },
        run(sql, ...params) {
          counters.writes += 1
          const result = db.query(sql).run(...params)
          return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) }
        },
        get<T>(sql: string, ...params: (string | number | bigint | boolean | null | Uint8Array)[]): T | null {
          return (db.query(sql).get(...params) as T | undefined) ?? null
        },
        all<T>(sql: string, ...params: (string | number | bigint | boolean | null | Uint8Array)[]): T[] {
          return db.query(sql).all(...params) as T[]
        },
        exec(sql) { db.exec(sql) },
        transaction<T>(work: () => T): T {
          counters.transactions += 1
          return db.transaction(work)()
        }
      }
      for (const step of steps) {
        if (typeof step === 'string') created.exec(step)
        else step(created)
        schemaVersion += 1
      }
      return created
    },
    error(_kind: string, message: string) { return new Error(message) }
  } as unknown as PluginContext

  const engine = new LedgerEngine(context)
  const caller = { role: 'cli' } as PluginCaller
  const pendingRequests = new Set<Promise<CatalogResponse>>()
  return {
    engine,
    counters,
    rpcCounts,
    initialRepo,
    async start() { await engine.start() },
    request() {
      const pending = engine.request({ operation: 'catalog' }, caller) as Promise<CatalogResponse>
      pendingRequests.add(pending)
      void pending.then(() => pendingRequests.delete(pending), () => pendingRequests.delete(pending))
      return pending
    },
    gateNextRead() {
      if (nextBarrier) throw new Error('a catalog read barrier is already armed')
      const barrier = new ReadBarrier()
      nextBarrier = barrier
      return barrier
    },
    failNextRead(error: Error) { nextFailure = { method: 'quirky.repo/list', error } },
    async removeRepo(id: string) {
      catalog = { ...catalog, repos: catalog.repos.filter((item) => item.id !== id) }
      // the authoritative state has changed; its repo/changed notification is deliberately held.
    },
    callSnapshot() {
      return Object.fromEntries([
        'quirky.repo/list',
        'quirky.repo/groupList',
        'quirky.worktree/list'
      ].map((method) => [method, rpcCounts[method] ?? 0]))
    },
    async dispose() {
      nextBarrier?.release()
      nextBarrier = undefined
      await Promise.allSettled([...pendingRequests])
      listeners.clear()
      database?.close()
    }
  }
}

async function withFixture(run: (fixture: CatalogFixture) => Promise<void>): Promise<void> {
  const fixture = createFixture()
  try {
    await fixture.start()
    await run(fixture)
  } finally {
    await fixture.dispose()
  }
}

function callDelta(before: RpcCounts, after: RpcCounts): RpcCounts {
  return Object.fromEntries(Object.keys(before).map((method) => [method, after[method]! - before[method]!]))
}

function expectInventoryReads(counts: RpcCounts, reads: number): void {
  expect(counts).toEqual({
    'quirky.repo/list': reads,
    'quirky.repo/groupList': reads,
    'quirky.worktree/list': reads
  })
}

test('unchanged catalog reads do not reconcile or write the store', async () => {
  await withFixture(async (fixture) => {
    const before = { ...fixture.counters }
    const callsBefore = fixture.callSnapshot()
    for (let index = 0; index < 4; index++) await fixture.request()
    expect(fixture.counters).toEqual(before)
    expectInventoryReads(callDelta(callsBefore, fixture.callSnapshot()), 4)
  })
})

test('requests arriving during one read share a single fresh follow-up inventory read', async () => {
  await withFixture(async (fixture) => {
    const before = fixture.callSnapshot()
    const barrier = fixture.gateNextRead()
    try {
      const first = fixture.request()
      await barrier.entered
      const waiting = [fixture.request(), fixture.request()]
      const whileGated = callDelta(before, fixture.callSnapshot())
      barrier.release()
      const responses = await Promise.all([first, ...waiting])
      expectInventoryReads(whileGated, 1)
      expect(responses.every((response) => response.owners.some((owner) => owner.id === fixture.initialRepo.id))).toBe(true)
      expectInventoryReads(callDelta(before, fixture.callSnapshot()), 2)
    } finally {
      barrier.release()
    }
  })
})

test('a request after authoritative repo removal does not join an older inventory read', async () => {
  await withFixture(async (fixture) => {
    const before = fixture.callSnapshot()
    const barrier = fixture.gateNextRead()
    try {
      const earlierRequest = fixture.request()
      await barrier.entered
      await fixture.removeRepo(fixture.initialRepo.id)
      const requestAfterRemoval = fixture.request()
      barrier.release()
      const [earlier, afterRemoval] = await Promise.all([earlierRequest, requestAfterRemoval])
      expect(earlier.owners.map((owner) => owner.id)).toContain(fixture.initialRepo.id)
      expect(afterRemoval.owners.map((owner) => owner.id)).not.toContain(fixture.initialRepo.id)
      expectInventoryReads(callDelta(before, fixture.callSnapshot()), 2)
    } finally {
      barrier.release()
    }
  })
})

test('a failed inventory read reports catalog-unavailable and the next request recovers', async () => {
  await withFixture(async (fixture) => {
    const before = fixture.callSnapshot()
    fixture.failNextRead(new Error('inventory offline'))
    let failure: RpcFailure
    try {
      await fixture.request()
      throw new Error('expected catalog request to fail')
    } catch (error) {
      failure = error as RpcFailure
    }
    expect(failure.data?.kind).toBe('catalog-unavailable')
    const response = await fixture.request()
    expect(response.owners.map((owner) => owner.id)).toContain(fixture.initialRepo.id)
    expectInventoryReads(callDelta(before, fixture.callSnapshot()), 2)
  })
})

test('a queued request recovers after the failing read settles without leaving catalog unavailable', async () => {
  await withFixture(async (fixture) => {
    const before = fixture.callSnapshot()
    const barrier = fixture.gateNextRead()
    fixture.failNextRead(new Error('inventory offline'))
    try {
      const failingRequest = fixture.request()
      await barrier.entered
      const queuedRequests = [fixture.request(), fixture.request()]
      barrier.release()
      const [failed, ...recovered] = await Promise.allSettled([failingRequest, ...queuedRequests])
      expect(failed?.status).toBe('rejected')
      if (failed?.status !== 'rejected') throw new Error('expected the first request to reject')
      expect((failed.reason as RpcFailure).data?.kind).toBe('catalog-unavailable')
      expect(recovered.map((item) => item.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(recovered.every((item) => item.status === 'fulfilled' && item.value.owners.some((owner) => owner.id === fixture.initialRepo.id))).toBe(true)
      expectInventoryReads(callDelta(before, fixture.callSnapshot()), 2)
    } finally {
      barrier.release()
    }
  })
})
