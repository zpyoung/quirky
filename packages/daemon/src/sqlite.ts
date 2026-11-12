import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'

export const DEFAULT_BUSY_TIMEOUT_MS = 5000

export interface OpenSqliteOptions {
  /** Lock wait in milliseconds, from 0 to 2147483647; defaults to 5000. */
  busyTimeoutMs?: number
  /** Opens an existing database without write access. */
  readonly?: boolean
}

/** Opens a SQLite handle with its busy timeout configured before callers perform other database work. */
export function openSqlite(path: string, options?: OpenSqliteOptions): Database {
  const busyTimeoutMs = options?.busyTimeoutMs === undefined ? DEFAULT_BUSY_TIMEOUT_MS : options.busyTimeoutMs
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 2147483647) {
    throw new RangeError('busyTimeoutMs must be an integer between 0 and 2147483647')
  }

  const db = new Database(path, options?.readonly ? { readonly: true } : { create: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    return db
  } catch (error) {
    try {
      db.close()
    } catch {}
    throw error
  }
}

export const DEFAULT_FULL_CHECK_MAX_BYTES = 33554432

export interface SqliteRecovery {
  outcome: 'repaired' | 'quarantined'
  /** The database path that was opened. */
  path: string
  /** Where the corrupt main file now is. */
  quarantinedPath: string
  /** Why the file was judged corrupt: one line, at most 300 characters. */
  reason: string
}

export interface OpenSqliteOrRecoverOptions {
  /** Lock wait in milliseconds, from 0 to 2147483647; defaults to 5000. */
  busyTimeoutMs?: number
  /** Main file plus -wal size up to which the full integrity check runs; larger files get the quick check. */
  fullCheckMaxBytes?: number
  /** File-system calls used for the quarantine; tests replace `renameSync`. */
  fs?: { renameSync(from: string, to: string): void }
}

/** True for a SQLite error that says the file is damaged or isn't a database. */
export function isSqliteCorruption(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = error.code
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
}

/** Formats the one line that reports a recovered store. */
export function describeSqliteRecovery(recovery: SqliteRecovery): string {
  if (recovery.outcome === 'repaired') {
    return `repaired corrupt store ${recovery.path}; the original is at ${recovery.quarantinedPath}: ${recovery.reason}`
  }
  return `quarantined corrupt store ${recovery.path} to ${recovery.quarantinedPath} and started an empty one: ${recovery.reason}`
}

function validateBusyTimeout(busyTimeoutMs: number | undefined): number {
  const value = busyTimeoutMs === undefined ? DEFAULT_BUSY_TIMEOUT_MS : busyTimeoutMs
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
    throw new RangeError('busyTimeoutMs must be an integer between 0 and 2147483647')
  }
  return value
}

function closeRecoveryHandle(db: Database | undefined): void {
  if (!db) return
  try {
    db.close(true)
  } catch {}
}

function normalizedReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function corruptionErrorReason(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'SQLITE_CORRUPT'
  const message = error instanceof Error ? error.message : String(error)
  return normalizedReason(`${code}: ${message}`)
}

function checkDatabase(db: Database, check: 'integrity_check' | 'quick_check'): string[] {
  const query = db.query(`PRAGMA ${check}(1)`)
  try {
    const rows = query.all() as Record<string, unknown>[]
    return rows.map((row) => String(Object.values(row)[0]))
  } finally {
    query.finalize()
  }
}

function walSize(path: string): number {
  try {
    const stats = statSync(`${path}-wal`)
    return stats.isFile() ? stats.size : 0
  } catch {
    return 0
  }
}

function vacuumInto(db: Database, path: string): void {
  const query = db.query('VACUUM INTO ?')
  try {
    query.run(path)
  } finally {
    query.finalize()
  }
}

function tryRepairCopy(path: string, copyPath: string, busyTimeoutMs: number): boolean {
  let source: Database | undefined
  let copy: Database | undefined
  try {
    source = openSqlite(path, { readonly: true, busyTimeoutMs })
    vacuumInto(source, copyPath)
    source.close(true)
    source = undefined

    copy = openSqlite(copyPath, { busyTimeoutMs })
    let rows: string[]
    try {
      rows = checkDatabase(copy, 'integrity_check')
    } catch {
      rows = []
    }
    if (rows.length !== 1 || rows[0] !== 'ok') {
      copy.exec('REINDEX')
      rows = checkDatabase(copy, 'integrity_check')
    }
    if (rows.length !== 1 || rows[0] !== 'ok') return false
    copy.close(true)
    copy = undefined
    return true
  } catch {
    return false
  } finally {
    closeRecoveryHandle(source)
    closeRecoveryHandle(copy)
  }
}

/** Opens a writable handle like `openSqlite`; only corruption triggers recovery, while other errors pass through. */
export function openSqliteOrRecover(
  path: string,
  options?: OpenSqliteOrRecoverOptions
): { db: Database; recovery: SqliteRecovery | null } {
  const busyTimeoutMs = validateBusyTimeout(options?.busyTimeoutMs)
  if (path === ':memory:') return { db: openSqlite(path, { busyTimeoutMs }), recovery: null }

  let stats: Stats | undefined
  try {
    stats = statSync(path)
  } catch {
    return { db: openSqlite(path, { busyTimeoutMs }), recovery: null }
  }
  if (!stats.isFile() || stats.size === 0) {
    return { db: openSqlite(path, { busyTimeoutMs }), recovery: null }
  }

  let db: Database | undefined
  let reason: string
  try {
    db = openSqlite(path, { busyTimeoutMs })
    const check = stats.size + walSize(path) <= (options?.fullCheckMaxBytes ?? DEFAULT_FULL_CHECK_MAX_BYTES)
      ? 'integrity_check'
      : 'quick_check'
    const rows = checkDatabase(db, check)
    if (rows.length === 1 && rows[0] === 'ok') return { db, recovery: null }
    reason = normalizedReason(rows[0] ?? 'integrity check failed')
  } catch (error) {
    closeRecoveryHandle(db)
    db = undefined
    if (!isSqliteCorruption(error)) throw error
    reason = corruptionErrorReason(error)
  }
  closeRecoveryHandle(db)

  let repairDirectory: string | undefined
  let copyPath: string | undefined
  try {
    repairDirectory = mkdtempSync(join(dirname(path), `.${basename(path)}.repair-`))
    const candidatePath = join(repairDirectory, 'copy.db')
    if (tryRepairCopy(path, candidatePath, busyTimeoutMs)) {
      chmodSync(candidatePath, stats.mode & 0o777)
      copyPath = candidatePath
    }
  } catch {
    copyPath = undefined
  }

  const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`
  const quarantinedPath = `${path}.corrupt-${suffix}`
  const rename = options?.fs?.renameSync ?? renameSync
  try {
    for (const sidecarSuffix of ['-wal', '-shm']) {
      const sidecar = `${path}${sidecarSuffix}`
      if (existsSync(sidecar)) rename(sidecar, `${sidecar}.corrupt-${suffix}`)
    }
    rename(path, quarantinedPath)
    if (copyPath) {
      renameSync(copyPath, path)
      return {
        db: openSqlite(path, { busyTimeoutMs }),
        recovery: { outcome: 'repaired', path, quarantinedPath, reason }
      }
    }
    return {
      db: openSqlite(path, { busyTimeoutMs }),
      recovery: { outcome: 'quarantined', path, quarantinedPath, reason }
    }
  } finally {
    if (repairDirectory) rmSync(repairDirectory, { recursive: true, force: true })
  }
}
