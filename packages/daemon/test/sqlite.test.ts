import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_FULL_CHECK_MAX_BYTES,
  describeSqliteRecovery,
  isSqliteCorruption,
  openSqlite,
  openSqliteOrRecover,
  type SqliteRecovery
} from '../src/sqlite'
import { Store } from '../src/store'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quirky-sqlite-'))
  tempDirs.push(dir)
  return dir
}
function queryRows(db: Database, sql: string): Record<string, unknown>[] {
  const query = db.query(sql)
  try {
    return query.all() as Record<string, unknown>[]
  } finally {
    query.finalize()
  }
}

function queryFirst(db: Database, sql: string): Record<string, unknown> | undefined {
  const query = db.query(sql)
  try {
    return query.get() as Record<string, unknown> | undefined
  } finally {
    query.finalize()
  }
}

function queryRun(db: Database, sql: string): void {
  const query = db.query(sql)
  try {
    query.run()
  } finally {
    query.finalize()
  }
}

type CorruptionFixture = {
  pageSize: number
  tableRootPage: number
  indexRootPage: number
}

function removeSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${file}${suffix}`
    if (existsSync(sidecar)) unlinkSync(sidecar)
  }
}

function seedCorruptibleDatabase(file: string): CorruptionFixture {
  const db = new Database(file, { create: true })
  try {
    db.exec('PRAGMA page_size = 65536')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, key TEXT NOT NULL)')
    db.exec('CREATE INDEX records_key ON records(key)')
    const insertRecord = db.query('INSERT INTO records (id, key) VALUES (?, ?)')
    try {
      for (let id = 0; id < 2000; id += 1) {
        insertRecord.run(id, `key-${String(id).padStart(4, '0')}`)
      }
    } finally {
      insertRecord.finalize()
    }
    db.exec('CREATE TABLE disposable (value TEXT)')
    const insertDisposable = db.query('INSERT INTO disposable (value) VALUES (?)')
    try {
      const value = 'x'.repeat(8000)
      for (let index = 0; index < 128; index += 1) insertDisposable.run(value)
    } finally {
      insertDisposable.finalize()
    }
    db.exec('DROP TABLE disposable')
    db.exec('PRAGMA user_version = 7')

    const pageSize = Number(queryFirst(db, 'PRAGMA page_size')?.page_size)
    const tableRootPage = Number(queryFirst(db, "SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'records'")?.rootpage)
    const indexRootPage = Number(queryFirst(db, "SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = 'records_key'")?.rootpage)
    if (Number(queryFirst(db, 'PRAGMA freelist_count')?.freelist_count) === 0) {
      throw new Error('fixture database must contain freelist pages')
    }

    queryFirst(db, 'PRAGMA wal_checkpoint(TRUNCATE)')
    if (queryFirst(db, 'PRAGMA journal_mode = DELETE')?.journal_mode !== 'delete') {
      throw new Error('fixture database must use the delete journal')
    }
    db.close(true)
    removeSidecars(file)
    return { pageSize, tableRootPage, indexRootPage }
  } catch (error) {
    try {
      db.close(true)
    } catch {}
    throw error
  }
}

function corruptDatabase(file: string, kind: 'freelist' | 'index' | 'table'): Buffer {
  const fixture = seedCorruptibleDatabase(file)
  const bytes = readFileSync(file)
  if (kind === 'freelist') {
    const trunkPage = bytes.readUInt32BE(32)
    if (trunkPage === 0) throw new Error('fixture database has no freelist trunk')
    bytes.writeUInt32BE(0x7fffffff, (trunkPage - 1) * fixture.pageSize + 4)
  } else if (kind === 'index') {
    const pageOffset = (fixture.indexRootPage - 1) * fixture.pageSize
    if (bytes[pageOffset] !== 0x0a) throw new Error('fixture index root is not a leaf page')
    const keyOffset = bytes.indexOf(Buffer.from('key-0247'), pageOffset)
    if (keyOffset < pageOffset || keyOffset >= pageOffset + fixture.pageSize) {
      throw new Error('fixture index leaf does not contain the expected key')
    }
    bytes.write('bad-0247', keyOffset, 'ascii')
  } else {
    const pageOffset = (fixture.tableRootPage - 1) * fixture.pageSize
    if (bytes[pageOffset] !== 0x0d) throw new Error('fixture table root is not a leaf page')
    bytes.fill(0xff, pageOffset, pageOffset + 200)
  }
  writeFileSync(file, bytes)
  assertReadOnlyCorrupt(file)
  return readFileSync(file)
}

function assertReadOnlyCorrupt(file: string): void {
  let db: Database | undefined
  let rows: Record<string, unknown>[] | undefined
  let failure: unknown
  try {
    db = new Database(file, { readonly: true })
    rows = queryRows(db, 'PRAGMA integrity_check(1)')
  } catch (error) {
    failure = error
  } finally {
    db?.close(true)
  }
  if (failure !== undefined) {
    expect(isSqliteCorruption(failure)).toBe(true)
    return
  }
  expect(rows?.map((row) => Object.values(row)[0])).not.toEqual(['ok'])
}

function assertNoRepairDirectories(file: string): void {
  const prefix = `.${basename(file)}.repair-`
  expect(readdirSync(dirname(file)).filter((name) => name.startsWith(prefix))).toEqual([])
}

function recoverySuffix(recovery: SqliteRecovery, file: string): string {
  expect(recovery.path).toBe(file)
  const expectedPrefix = `${basename(file)}.corrupt-`
  expect(basename(recovery.quarantinedPath).startsWith(expectedPrefix)).toBe(true)
  const suffix = basename(recovery.quarantinedPath).slice(expectedPrefix.length)
  expect(suffix).toMatch(/^\d+-[0-9a-f]{8}$/)
  return suffix
}

function expectReasonLine(reason: string): void {
  expect(reason.length).toBeGreaterThan(0)
  expect(reason.length).toBeLessThanOrEqual(300)
  expect(reason).not.toMatch(/[\r\n]/)
}

function sqliteError(code: string, message = 'database failure'): Error {
  return Object.assign(new Error(message), { code })
}

function sqliteCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function openGarbageDatabase(file: string): Buffer {
  const bytes = Buffer.alloc(8192, 0x41)
  writeFileSync(file, bytes)
  assertReadOnlyCorrupt(file)
  return bytes
}



function createHealthyDatabase(file: string): Buffer {
  const db = new Database(file, { create: true })
  db.exec('CREATE TABLE seed (value TEXT)')
  queryRun(db, "INSERT INTO seed (value) VALUES ('kept')")
  db.exec('PRAGMA user_version = 11')
  db.close(true)
  return readFileSync(file)
}

function cleanupRecoveryDb(db: Database): void {
  db.close(true)
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
  query: Database['query']
  close(this: Database, force?: boolean): void
}

const databasePrototype = Database.prototype as unknown as MutableDatabasePrototype

describe('openSqliteOrRecover', () => {
  test('uses the full-check size default and classifies only corruption errors', () => {
    expect(DEFAULT_FULL_CHECK_MAX_BYTES).toBe(33554432)
    expect(isSqliteCorruption(sqliteError('SQLITE_CORRUPT'))).toBe(true)
    expect(isSqliteCorruption(sqliteError('SQLITE_CORRUPT_INDEX'))).toBe(true)
    expect(isSqliteCorruption(sqliteError('SQLITE_NOTADB'))).toBe(true)
    expect(isSqliteCorruption(sqliteError('SQLITE_BUSY'))).toBe(false)
    expect(isSqliteCorruption(sqliteError('SQLITE_CANTOPEN'))).toBe(false)
    expect(isSqliteCorruption(new Error('SQLITE_CORRUPT'))).toBe(false)
    expect(isSqliteCorruption(null)).toBe(false)
  })

  test('formats repaired and quarantined notices exactly', () => {
    expect(describeSqliteRecovery({
      outcome: 'repaired',
      path: '/home/quirky.db',
      quarantinedPath: '/home/quirky.db.corrupt-1234-abcdef01',
      reason: 'freelist corrupt'
    })).toBe('repaired corrupt store /home/quirky.db; the original is at /home/quirky.db.corrupt-1234-abcdef01: freelist corrupt')
    expect(describeSqliteRecovery({
      outcome: 'quarantined',
      path: '/home/plugin.db',
      quarantinedPath: '/home/plugin.db.corrupt-1234-abcdef01',
      reason: 'not a database'
    })).toBe('quarantined corrupt store /home/plugin.db to /home/plugin.db.corrupt-1234-abcdef01 and started an empty one: not a database')
  })

  test('skips checks for missing, empty, and in-memory databases', () => {
    const dir = makeTempDir()
    const empty = join(dir, 'empty.db')
    writeFileSync(empty, Buffer.alloc(0))
    const originalQuery = databasePrototype.query
    let checkQueries = 0
    databasePrototype.query = function (this: Database, sql: string) {
      if (sql === 'PRAGMA integrity_check(1)' || sql === 'PRAGMA quick_check(1)') checkQueries += 1
      return originalQuery.call(this, sql)
    } as Database['query']
    try {
      for (const path of [join(dir, 'missing.db'), empty, ':memory:']) {
        const opened = openSqliteOrRecover(path)
        try {
          expect(opened.recovery).toBeNull()
        } finally {
          cleanupRecoveryDb(opened.db)
        }
      }
    } finally {
      databasePrototype.query = originalQuery
    }
    expect(checkQueries).toBe(0)
  })

  test('opens a healthy file without changing its bytes or schema version', () => {
    const file = join(makeTempDir(), 'healthy.db')
    const originalBytes = createHealthyDatabase(file)
    const opened = openSqliteOrRecover(file)
    try {
      expect(opened.recovery).toBeNull()
      expect(queryFirst(opened.db, 'SELECT value FROM seed')).toEqual({ value: 'kept' })
      expect(queryFirst(opened.db, 'PRAGMA user_version')).toEqual({ user_version: 11 })
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    expect(readFileSync(file).equals(originalBytes)).toBe(true)
    expect(readdirSync(dirname(file)).some((name) => name.startsWith(`${basename(file)}.corrupt-`))).toBe(false)
    assertNoRepairDirectories(file)
  })

  test('inspects a healthy WAL database after its sidecars were removed', () => {
    const file = join(makeTempDir(), 'healthy-wal.db')
    const seed = new Database(file, { create: true })
    try {
      seed.exec('PRAGMA journal_mode = WAL')
      seed.exec('CREATE TABLE seed (value TEXT)')
      seed.exec("INSERT INTO seed (value) VALUES ('kept')")
      seed.exec('PRAGMA user_version = 11')
      queryFirst(seed, 'PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      seed.close(true)
    }
    removeSidecars(file)

    const originalBytes = readFileSync(file)
    expect(originalBytes[18]).toBe(2)
    expect(originalBytes[19]).toBe(2)
    const opened = openSqliteOrRecover(file)
    try {
      expect(opened.recovery).toBeNull()
      expect(queryRows(opened.db, 'SELECT value FROM seed')).toEqual([{ value: 'kept' }])
      expect(queryFirst(opened.db, 'PRAGMA user_version')).toEqual({ user_version: 11 })
      opened.db.exec('BEGIN IMMEDIATE')
      opened.db.exec('ROLLBACK')
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    expect(readFileSync(file).equals(originalBytes)).toBe(true)
    expect(readdirSync(dirname(file)).some((name) => name.startsWith(`${basename(file)}.corrupt-`))).toBe(false)
    assertNoRepairDirectories(file)
  })

  test('repairs committed WAL freelist corruption without changing the original main bytes', () => {
    const dir = makeTempDir()
    const sourceFile = join(dir, 'wal-seed.db')
    const file = join(dir, 'wal-freelist.db')
    const source = new Database(sourceFile, { create: true })
    try {
      source.exec('PRAGMA journal_mode = WAL')
      source.exec('PRAGMA wal_autocheckpoint = 0')
      source.exec('CREATE TABLE kept (id INTEGER PRIMARY KEY, value TEXT)')
      source.exec("INSERT INTO kept VALUES (1, 'before')")
      source.exec('CREATE TABLE disposable (value BLOB)')
      source.exec('INSERT INTO disposable VALUES (zeroblob(100000))')
      source.exec('DROP TABLE disposable')
      source.exec('PRAGMA user_version = 13')
      queryFirst(source, 'PRAGMA wal_checkpoint(TRUNCATE)')
      source.exec("UPDATE kept SET value = 'latest' WHERE id = 1")
      for (const suffix of ['', '-wal', '-shm']) {
        copyFileSync(`${sourceFile}${suffix}`, `${file}${suffix}`)
      }
    } finally {
      source.close(true)
    }

    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0)
    expect(statSync(`${file}-shm`).size).toBeGreaterThan(0)
    const originalMainBytes = readFileSync(file)
    const pageSizeHeader = originalMainBytes.readUInt16BE(16)
    const pageSize = pageSizeHeader === 1 ? 65536 : pageSizeHeader
    const trunkPage = originalMainBytes.readUInt32BE(32)
    expect(trunkPage).toBeGreaterThan(0)
    originalMainBytes.writeUInt32BE(0x7fffffff, (trunkPage - 1) * pageSize + 4)
    writeFileSync(file, originalMainBytes)
    assertReadOnlyCorrupt(file)
    const readonly = new Database(file, { readonly: true })
    try {
      expect(queryFirst(readonly, 'SELECT value FROM kept WHERE id = 1')).toEqual({ value: 'latest' })
    } finally {
      readonly.close(true)
    }
    expect(readFileSync(file).equals(originalMainBytes)).toBe(true)

    const opened = openSqliteOrRecover(file)
    try {
      expect(opened.recovery?.outcome).toBe('repaired')
      const recovery = opened.recovery!
      const suffix = recoverySuffix(recovery, file)
      expect(readFileSync(recovery.quarantinedPath).equals(originalMainBytes)).toBe(true)
      expect(existsSync(`${file}-wal.corrupt-${suffix}`)).toBe(true)
      expect(existsSync(`${file}-shm.corrupt-${suffix}`)).toBe(true)
      expect(queryRows(opened.db, 'PRAGMA integrity_check(1)').map((row) => Object.values(row)[0])).toEqual(['ok'])
      expect(queryFirst(opened.db, 'SELECT value FROM kept WHERE id = 1')).toEqual({ value: 'latest' })
      expect(queryFirst(opened.db, 'PRAGMA user_version')).toEqual({ user_version: 13 })
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    assertNoRepairDirectories(file)
  })

  test('repairs freelist corruption while preserving rows, version, bytes, and mode', () => {
    const file = join(makeTempDir(), 'freelist.db')
    const originalBytes = corruptDatabase(file, 'freelist')
    chmodSync(file, 0o600)
    const opened = openSqliteOrRecover(file)
    try {
      expect(opened.recovery?.outcome).toBe('repaired')
      const recovery = opened.recovery!
      recoverySuffix(recovery, file)
      expectReasonLine(recovery.reason)
      expect(readFileSync(recovery.quarantinedPath).equals(originalBytes)).toBe(true)
      expect(queryRows(opened.db, 'PRAGMA integrity_check(1)').map((row) => Object.values(row)[0])).toEqual(['ok'])
      expect(queryFirst(opened.db, 'SELECT COUNT(*) AS count FROM records')).toEqual({ count: 2000 })
      expect(queryFirst(opened.db, 'PRAGMA user_version')).toEqual({ user_version: 7 })
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    assertNoRepairDirectories(file)
  })

  test('uses the full check at the byte limit and REINDEX repairs damaged index entries', () => {
    const file = join(makeTempDir(), 'index.db')
    const originalBytes = corruptDatabase(file, 'index')
    const opened = openSqliteOrRecover(file, { fullCheckMaxBytes: statSync(file).size })
    try {
      expect(opened.recovery?.outcome).toBe('repaired')
      const recovery = opened.recovery!
      recoverySuffix(recovery, file)
      expect(readFileSync(recovery.quarantinedPath).equals(originalBytes)).toBe(true)
      expect(queryRows(opened.db, 'PRAGMA integrity_check(1)').map((row) => Object.values(row)[0])).toEqual(['ok'])
      expect(queryFirst(opened.db, 'SELECT COUNT(*) AS count FROM records')).toEqual({ count: 2000 })
      expect(queryFirst(opened.db, 'PRAGMA user_version')).toEqual({ user_version: 7 })
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    assertNoRepairDirectories(file)
  })

  test('uses quick_check above the configured limit and leaves index-only damage alone', () => {
    const file = join(makeTempDir(), 'quick.db')
    const originalBytes = corruptDatabase(file, 'index')
    const opened = openSqliteOrRecover(file, { fullCheckMaxBytes: 0 })
    try {
      expect(opened.recovery).toBeNull()
      expect(queryRows(opened.db, 'PRAGMA quick_check(1)').map((row) => Object.values(row)[0])).toEqual(['ok'])
      expect(queryRows(opened.db, 'PRAGMA integrity_check(1)').map((row) => Object.values(row)[0])).not.toEqual(['ok'])
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    expect(readFileSync(file).equals(originalBytes)).toBe(true)
    expect(readdirSync(dirname(file)).some((name) => name.startsWith(`${basename(file)}.corrupt-`))).toBe(false)
    assertNoRepairDirectories(file)
  })

  test('quarantines CHECK violations that remain after REINDEX', () => {
    const dir = makeTempDir()
    const file = join(dir, 'check-violation.db')
    const copyFile = join(dir, 'check-copy.db')
    const seed = new Database(file, { create: true })
    try {
      seed.exec('PRAGMA ignore_check_constraints = ON')
      seed.exec('CREATE TABLE kept (value INTEGER CHECK (value > 0))')
      seed.exec('INSERT INTO kept VALUES (-1)')
    } finally {
      seed.close(true)
    }
    const originalBytes = readFileSync(file)

    const source = new Database(file, { readonly: true })
    try {
      const vacuum = source.query('VACUUM INTO ?')
      try {
        vacuum.run(copyFile)
      } finally {
        vacuum.finalize()
      }
    } finally {
      source.close(true)
    }

    const copy = new Database(copyFile)
    try {
      const checkBeforeReindex = queryRows(copy, 'PRAGMA integrity_check(1)')
        .map((row) => String(Object.values(row)[0]))
      expect(queryFirst(copy, 'PRAGMA ignore_check_constraints')).toEqual({ ignore_check_constraints: 0 })
      expect(checkBeforeReindex).not.toEqual(['ok'])
      expect(() => copy.exec('REINDEX')).not.toThrow()
      const checkAfterReindex = queryRows(copy, 'PRAGMA integrity_check(1)')
        .map((row) => String(Object.values(row)[0]))
      expect(checkAfterReindex).not.toEqual(['ok'])
    } finally {
      copy.close(true)
    }

    const opened = openSqliteOrRecover(file)
    try {
      expect(opened.recovery?.outcome).toBe('quarantined')
      const recovery = opened.recovery!
      recoverySuffix(recovery, file)
      expect(readFileSync(recovery.quarantinedPath).equals(originalBytes)).toBe(true)
      expect(queryRows(opened.db, 'PRAGMA integrity_check(1)').map((row) => String(Object.values(row)[0]))).toEqual(['ok'])
      expect(queryRows(opened.db, "SELECT name FROM sqlite_schema WHERE name = 'kept'")).toEqual([])
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    assertNoRepairDirectories(file)
  })

  test('repairs a freelist-corrupt file whose path contains an apostrophe', () => {
    const file = join(makeTempDir(), "o'brien.db")
    const originalBytes = corruptDatabase(file, 'freelist')
    const opened = openSqliteOrRecover(file)
    try {
      expect(opened.recovery?.outcome).toBe('repaired')
      const recovery = opened.recovery!
      recoverySuffix(recovery, file)
      expect(readFileSync(recovery.quarantinedPath).equals(originalBytes)).toBe(true)
      expect(queryRows(opened.db, 'PRAGMA integrity_check(1)').map((row) => Object.values(row)[0])).toEqual(['ok'])
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    assertNoRepairDirectories(file)
  })
  test('quarantines non-database bytes and sidecars under one shared suffix', () => {
    const file = join(makeTempDir(), 'garbage.db')
    const originalBytes = openGarbageDatabase(file)
    writeFileSync(`${file}-wal`, Buffer.alloc(128, 0x57))
    writeFileSync(`${file}-shm`, Buffer.alloc(128, 0x53))
    const renameCalls: string[] = []
    const opened = openSqliteOrRecover(file, {
      fs: {
        renameSync(from, to) {
          renameCalls.push(from)
          renameSync(from, to)
        }
      }
    })
    try {
      expect(opened.recovery?.outcome).toBe('quarantined')
      const recovery = opened.recovery!
      const suffix = recoverySuffix(recovery, file)
      expectReasonLine(recovery.reason)
      expect(readFileSync(recovery.quarantinedPath).equals(originalBytes)).toBe(true)
      expect(existsSync(`${file}-wal.corrupt-${suffix}`)).toBe(true)
      expect(existsSync(`${file}-shm.corrupt-${suffix}`)).toBe(true)
      expect(renameCalls).toEqual([`${file}-wal`, `${file}-shm`, file])
      expect(queryRows(opened.db, "SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([])
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    assertNoRepairDirectories(file)
  })

  test('quarantines unreadable table pages and discards the partial VACUUM copy', () => {
    const file = join(makeTempDir(), 'unreadable.db')
    const originalBytes = corruptDatabase(file, 'table')
    const opened = openSqliteOrRecover(file)
    try {
      expect(opened.recovery?.outcome).toBe('quarantined')
      const recovery = opened.recovery!
      recoverySuffix(recovery, file)
      expect(readFileSync(recovery.quarantinedPath).equals(originalBytes)).toBe(true)
      expect(queryRows(opened.db, 'PRAGMA integrity_check(1)').map((row) => Object.values(row)[0])).toEqual(['ok'])
      expect(queryRows(opened.db, "SELECT name FROM sqlite_schema WHERE name = 'records'")).toEqual([])
    } finally {
      cleanupRecoveryDb(opened.db)
    }
    assertNoRepairDirectories(file)
  })

  test('quarantines when REINDEX fails after the copied database fails its full check', () => {
    const file = join(makeTempDir(), 'reindex-failure.db')
    const originalBytes = corruptDatabase(file, 'index')
    const originalExec = databasePrototype.exec
    let reindexCalls = 0
    databasePrototype.exec = function (sql) {
      if (sql.trim().toUpperCase() === 'REINDEX') {
        reindexCalls += 1
        throw new Error('forced reindex failure')
      }
      return originalExec.call(this, sql)
    }
    let opened: { db: Database; recovery: SqliteRecovery | null } | undefined
    try {
      opened = openSqliteOrRecover(file)
    } finally {
      databasePrototype.exec = originalExec
    }
    try {
      expect(reindexCalls).toBe(1)
      expect(opened?.recovery?.outcome).toBe('quarantined')
      expect(readFileSync(opened!.recovery!.quarantinedPath).equals(originalBytes)).toBe(true)
      expect(queryRows(opened!.db, "SELECT name FROM sqlite_schema WHERE name = 'records'")).toEqual([])
    } finally {
      if (opened) cleanupRecoveryDb(opened.db)
    }
    assertNoRepairDirectories(file)
  })

  test('reports directories and unreadable files as CANTOPEN without renaming them', () => {
    const directory = makeTempDir()
    let directoryError: unknown
    try {
      const opened = openSqliteOrRecover(directory)
      cleanupRecoveryDb(opened.db)
      directoryError = new Error('expected opening a directory to fail')
    } catch (error) {
      directoryError = error
    }
    expect(sqliteCode(directoryError)).toBe('SQLITE_CANTOPEN')
    expect(readdirSync(directory).some((name) => name.includes('.corrupt-'))).toBe(false)
    expect(readdirSync(directory).some((name) => name.includes('.repair-'))).toBe(false)

    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const file = join(makeTempDir(), 'unreadable.db')
    createHealthyDatabase(file)
    chmodSync(file, 0)
    let permissionError: unknown
    try {
      const opened = openSqliteOrRecover(file)
      cleanupRecoveryDb(opened.db)
      permissionError = new Error('expected opening an unreadable database to fail')
    } catch (error) {
      permissionError = error
    } finally {
      chmodSync(file, 0o600)
    }
    expect(sqliteCode(permissionError)).toBe('SQLITE_CANTOPEN')
    expect(readdirSync(dirname(file)).some((name) => name.startsWith(`${basename(file)}.corrupt-`))).toBe(false)
    assertNoRepairDirectories(file)
  })

  test('passes through a failed quarantine rename and closes recovery handles first', () => {
    const file = join(makeTempDir(), 'rename-failure.db')
    const originalBytes = openGarbageDatabase(file)
    const originalClose = databasePrototype.close
    const closedWithForce: boolean[] = []
    const renameError = new Error('rename denied')
    databasePrototype.close = function (force) {
      closedWithForce.push(force === true)
      return originalClose.call(this, force)
    }
    let thrown: unknown
    try {
      openSqliteOrRecover(file, {
        fs: {
          renameSync(from, to) {
            expect(from).toBe(file)
            expect(to).toContain(`${basename(file)}.corrupt-`)
            expect(closedWithForce.length).toBeGreaterThan(0)
            expect(closedWithForce.every(Boolean)).toBe(true)
            throw renameError
          }
        }
      })
    } catch (error) {
      thrown = error
    } finally {
      databasePrototype.close = originalClose
    }
    expect(thrown).toBe(renameError)
    expect(closedWithForce.length).toBeGreaterThanOrEqual(2)
    expect(closedWithForce.every(Boolean)).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file).equals(originalBytes)).toBe(true)
    assertReadOnlyCorrupt(file)
    expect(readdirSync(dirname(file)).some((name) => name.startsWith(`${basename(file)}.corrupt-`))).toBe(false)
    assertNoRepairDirectories(file)
    expect(isSqliteCorruption(sqliteError('SQLITE_BUSY'))).toBe(false)
  })

  test('validates the busy timeout before opening a new path', () => {
    const file = join(makeTempDir(), 'invalid-timeout.db')
    expect(() => openSqliteOrRecover(file, { busyTimeoutMs: -1 })).toThrow(RangeError)
    expect(existsSync(file)).toBe(false)
  })
})

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

  test.each([[0], [2147483647]])('accepts supported busy timeout %p', (busyTimeoutMs) => {
    const db = openSqlite(':memory:', { busyTimeoutMs })
    try {
      expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: busyTimeoutMs })
    } finally {
      db.close()
    }
  })

  test.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [2147483648]])(
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

  test('repairs a freelist-corrupt kernel store and calls onRecover once after setup', () => {
    const file = join(makeTempDir(), 'quirky.db')
    const originalBytes = corruptDatabase(file, 'freelist')
    chmodSync(file, 0o600)
    const recoveries: SqliteRecovery[] = []
    const store = new Store(file, {
      onRecover(recovery) {
        recoveries.push(recovery)
        const observer = new Database(file, { readonly: true })
        try {
          expect(queryFirst(observer, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'")).toEqual({ name: 'sessions' })
        } finally {
          observer.close(true)
        }
      }
    })
    try {
      expect(recoveries).toHaveLength(1)
      expect(recoveries[0]?.outcome).toBe('repaired')
      expect(recoveries[0] && readFileSync(recoveries[0].quarantinedPath).equals(originalBytes)).toBe(true)
      expect(queryRows(storeDatabase(store), 'PRAGMA integrity_check(1)').map((row) => Object.values(row)[0])).toEqual(['ok'])
      expect(queryFirst(storeDatabase(store), 'SELECT COUNT(*) AS count FROM records')).toEqual({ count: 2000 })
      expect(queryFirst(storeDatabase(store), 'PRAGMA user_version')).toEqual({ user_version: 7 })
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      store.close()
    }
    assertNoRepairDirectories(file)
  })

  test('quarantines a garbage kernel store, creates kernel tables, and calls onRecover once', () => {
    const file = join(makeTempDir(), 'quirky.db')
    const originalBytes = openGarbageDatabase(file)
    writeFileSync(`${file}-wal`, Buffer.alloc(128, 0x57))
    writeFileSync(`${file}-shm`, Buffer.alloc(128, 0x53))
    const recoveries: SqliteRecovery[] = []
    const store = new Store(file, { onRecover: (recovery) => recoveries.push(recovery) })
    try {
      expect(recoveries).toHaveLength(1)
      const recovery = recoveries[0]!
      expect(recovery.outcome).toBe('quarantined')
      const suffix = recoverySuffix(recovery, file)
      expect(readFileSync(recovery.quarantinedPath).equals(originalBytes)).toBe(true)
      expect(existsSync(`${file}-wal.corrupt-${suffix}`)).toBe(true)
      expect(existsSync(`${file}-shm.corrupt-${suffix}`)).toBe(true)
      expect(queryFirst(storeDatabase(store), "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'")).toEqual({ name: 'sessions' })
    } finally {
      store.close()
    }
    assertNoRepairDirectories(file)
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
    expect(readdirSync(dirname(file)).some((name) => name.startsWith(`${basename(file)}.corrupt-`))).toBe(false)
    const db = new Database(file, { readonly: true })
    try {
      expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: 'seed' }])
    } finally {
      db.close()
    }
  })
})
