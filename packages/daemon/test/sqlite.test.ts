import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BUSY_TIMEOUT_MS, openSqlite } from '../src/sqlite'
import { Store } from '../src/store'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-sqlite-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const lockWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads')
const { Database } = require('bun:sqlite')
const db = new Database(workerData.file)
try {
  db.exec(workerData.begin)
  parentPort.postMessage('locked')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs)
  db.exec('ROLLBACK')
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
} finally {
  db.close()
}
`

async function holdLock(file: string, begin: string, holdMs: number): Promise<{ exit: Promise<void> }> {
  const worker = new Worker(lockWorkerSource, { eval: true, workerData: { file, begin, holdMs } })
  const exitResolvers = Promise.withResolvers<void>()
  worker.once('error', (error) => exitResolvers.reject(error))
  worker.once('exit', (code) => code === 0 ? exitResolvers.resolve() : exitResolvers.reject(new Error(`lock worker exited ${code}`)))
  void exitResolvers.promise.catch(() => {})
  const readyResolvers = Promise.withResolvers<void>()
  worker.once('message', (message) => {
    if (message === 'locked') readyResolvers.resolve()
    else readyResolvers.reject(new Error(`lock worker failed: ${JSON.stringify(message)}`))
  })
  worker.once('error', (error) => readyResolvers.reject(error))
  worker.once('exit', (code) => readyResolvers.reject(new Error(`lock worker exited before locking: ${code}`)))
  await readyResolvers.promise
  return { exit: exitResolvers.promise }
}

function storeDatabase(store: Store): Database {
  const internals = store as unknown as { db: Database }
  return internals.db
}

type MutableDatabasePrototype = {
  exec(this: Database, query: string): void
  close(this: Database): void
}

const databasePrototype = Database.prototype as unknown as MutableDatabasePrototype

describe('openSqlite', () => {
  test('defaults to a 5000 ms busy timeout', () => {
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(5000)
    const db = openSqlite(join(makeTempDir(), 'store.db'))
    try {
      expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    } finally {
      db.close()
    }
  })

  test('sets a requested busy timeout on a read-only handle', () => {
    const file = join(makeTempDir(), 'store.db')
    const created = new Database(file, { create: true })
    created.close()
    const db = openSqlite(file, { readonly: true, busyTimeoutMs: 31 })
    try {
      expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 31 })
    } finally {
      db.close()
    }
  })

  test.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'rejects invalid busy timeout %p before creating a database',
    (busyTimeoutMs) => {
      const file = join(makeTempDir(), 'invalid.db')
      expect(() => openSqlite(file, { busyTimeoutMs })).toThrow()
      expect(existsSync(file)).toBe(false)
    }
  )

  test('closes the handle and rethrows when setting busy_timeout fails', () => {
    const originalExec = databasePrototype.exec
    const originalClose = databasePrototype.close
    let closeCalls = 0
    databasePrototype.exec = function (query) {
      if (query === 'PRAGMA busy_timeout = 5000') throw new Error('pragma failed')
      return originalExec.call(this, query)
    }
    databasePrototype.close = function () {
      closeCalls += 1
      return originalClose.call(this)
    }
    try {
      expect(() => openSqlite(join(makeTempDir(), 'store.db'))).toThrow('pragma failed')
    } finally {
      databasePrototype.exec = originalExec
      databasePrototype.close = originalClose
    }
    expect(closeCalls).toBe(1)
  })
})

describe('Store SQLite setup', () => {
  test('sets the default busy timeout, WAL mode, and NORMAL synchronous mode', () => {
    const store = new Store(join(makeTempDir(), 'quirky.db'))
    const db = storeDatabase(store)
    try {
      expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
      expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(db.query('PRAGMA synchronous').get()).toEqual({ synchronous: 1 })
    } finally {
      store.close()
    }
  })

  test('applies a caller-supplied busy timeout', () => {
    const store = new Store(join(makeTempDir(), 'quirky.db'), { busyTimeoutMs: 17 })
    try {
      expect(storeDatabase(store).query('PRAGMA busy_timeout').get()).toEqual({ timeout: 17 })
    } finally {
      store.close()
    }
  })

  test('closes the handle when WAL setup fails', () => {
    const originalExec = databasePrototype.exec
    const originalClose = databasePrototype.close
    let closeCalls = 0
    databasePrototype.exec = function (query) {
      if (query === 'PRAGMA journal_mode = WAL') throw new Error('wal setup failed')
      return originalExec.call(this, query)
    }
    databasePrototype.close = function () {
      closeCalls += 1
      return originalClose.call(this)
    }
    try {
      expect(() => new Store(join(makeTempDir(), 'quirky.db'))).toThrow('wal setup failed')
    } finally {
      databasePrototype.exec = originalExec
      databasePrototype.close = originalClose
    }
    expect(closeCalls).toBe(1)
  })

  test('waits for a rollback-journal exclusive lock to clear before entering WAL mode', async () => {
    const file = join(makeTempDir(), 'quirky.db')
    const seed = new Database(file, { create: true })
    seed.exec('CREATE TABLE seed (id INT)')
    seed.close()
    const lock = await holdLock(file, 'BEGIN EXCLUSIVE', 150)
    let store: Store | undefined
    try {
      store = new Store(file)
      expect(storeDatabase(store).query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(storeDatabase(store).query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()).toEqual({ name: 'sessions' })
    } finally {
      store?.close()
      await lock.exit
    }
  })

  test('waits for the busy timeout then throws SQLITE_BUSY without changing the rollback schema', async () => {
    const file = join(makeTempDir(), 'quirky.db')
    const seed = new Database(file, { create: true })
    seed.exec('CREATE TABLE seed (id INT)')
    seed.close()
    const lock = await holdLock(file, 'BEGIN EXCLUSIVE', 400)
    let error: unknown
    let elapsed = 0
    try {
      const started = performance.now()
      try {
        new Store(file, { busyTimeoutMs: 100 })
      } catch (caught) {
        error = caught
      }
      elapsed = performance.now() - started
    } finally {
      await lock.exit
    }
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(error).toBeInstanceOf(Error)
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    expect(code).toBe('SQLITE_BUSY')
    const db = new Database(file, { readonly: true })
    try {
      expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: 'seed' }])
    } finally {
      db.close()
    }
  })
})
