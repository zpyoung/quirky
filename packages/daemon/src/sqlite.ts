import { Database } from 'bun:sqlite'

export const DEFAULT_BUSY_TIMEOUT_MS = 5000

export interface OpenSqliteOptions {
  /** Lock wait in milliseconds before SQLite reports `SQLITE_BUSY`; defaults to 5000. */
  busyTimeoutMs?: number
  /** Opens an existing database without write access. */
  readonly?: boolean
}

/** Opens a SQLite handle with its busy timeout configured before callers perform other database work. */
export function openSqlite(path: string, options?: OpenSqliteOptions): Database {
  const busyTimeoutMs = options?.busyTimeoutMs === undefined ? DEFAULT_BUSY_TIMEOUT_MS : options.busyTimeoutMs
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError('busyTimeoutMs must be a non-negative integer')
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
