import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginStore, StoreMigration, StoreValue } from '@quirky/protocol'

/** Where a plugin keeps its private files, including its SQLite store. Pure path math; creates nothing. */
export function pluginDataDir(home: string, pluginId: string): string {
  return join(home, 'plugin-data', pluginId)
}

export interface OpenPluginStoreOptions {
  home: string
  pluginId: string
  migrations: StoreMigration[]
  /** Consulted on every handle call; a false return makes the handle throw as if closed. */
  isActive: () => boolean
  /** Opt in to read-only access to a schema newer than the supplied migration list. */
  newerVersion?: 'read-only'
}

function isThenable(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function'
}

function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

/**
 * Opens `<home>/plugin-data/<pluginId>/store.db` and brings it to `migrations.length` by running each
 * pending migration in its own transaction. A failed migration is rolled back and the database closed;
 * earlier steps stay committed. A newer schema is refused, or reopened read-only when explicitly requested.
 * `close()` is idempotent and turns every handle method into a throw.
 */
export function openPluginStore(options: OpenPluginStoreOptions): { store: PluginStore; close(): void } {
  const { home, pluginId, migrations, isActive } = options
  if (!Array.isArray(migrations) || !migrations.every((m) => typeof m === 'string' || typeof m === 'function')) {
    throw new Error(`${pluginId} migrations must be an array of SQL strings or functions`)
  }

  const dir = pluginDataDir(home, pluginId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'store.db')
  let db = new Database(file)
  let readOnly = false
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    db.close()
  }
  const live = () => {
    if (closed || !isActive()) throw new Error(`${pluginId} is no longer active`)
  }
  const writable = () => {
    live()
    if (readOnly) throw new Error(`${pluginId} store is read-only because its schema is newer than this build`)
  }

  let savepointCounter = 0
  const store: PluginStore = {
    get version() {
      live()
      return userVersion(db)
    },
    get readOnly() {
      live()
      return readOnly
    },
    run(sql, ...params: StoreValue[]) {
      writable()
      const result = db.query(sql).run(...(params as never[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get<T>(sql: string, ...params: StoreValue[]) {
      live()
      return (db.query(sql).get(...(params as never[])) as T | null) ?? null
    },
    all<T>(sql: string, ...params: StoreValue[]) {
      live()
      return db.query(sql).all(...(params as never[])) as T[]
    },
    exec(sql) {
      writable()
      db.exec(sql)
    },
    transaction<T>(work: () => T): T {
      writable()
      // inside a migration's transaction a plain BEGIN would fail, so nest with a savepoint
      const nested = db.inTransaction
      const savepoint = `quirky_tx_${++savepointCounter}`
      db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN')
      try {
        const value = work()
        db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
        return value
      } catch (err) {
        if (!closed) db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
        throw err
      }
    }
  }

  try {
    const version = userVersion(db)
    if (version > migrations.length) {
      if (options.newerVersion !== 'read-only') {
        throw new Error(`${pluginId} store is at version ${version}, but the plugin knows ${migrations.length} migrations`)
      }
      db.close()
      db = new Database(file, { readonly: true })
      readOnly = true
      return { store, close }
    }
    db.exec('PRAGMA journal_mode = WAL')
    for (let i = version; i < migrations.length; i++) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const migration = migrations[i]!
        if (typeof migration === 'string') {
          db.exec(migration)
        } else {
          const returned = migration(store)
          if (isThenable(returned)) {
            // the failure is reported below, so a later rejection must not surface as unhandled
            Promise.resolve(returned).catch(() => {})
            throw new Error('migrations must be synchronous')
          }
        }
        db.exec(`PRAGMA user_version = ${i + 1}`)
        db.exec('COMMIT')
      } catch (err) {
        if (db.inTransaction) db.exec('ROLLBACK')
        throw new Error(`${pluginId} store migration ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    close()
    throw err
  }

  return { store, close }
}
