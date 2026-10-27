import { Database } from 'bun:sqlite'
import type { PluginStore, StoreValue } from '@quirky/protocol'
import { sessionMigrations } from '../src/records'

/** An in-memory plugin store with the first `migrations` session migrations applied (all by default). */
export function memoryStore(migrations = Infinity): PluginStore {
  const db = new Database(':memory:')
  const store: PluginStore = {
    version: 1,
    run: (sql, ...params: StoreValue[]) => {
      const result = db.query(sql).run(...(params as never[]))
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: <T,>(sql: string, ...params: StoreValue[]) => (db.query(sql).get(...(params as never[])) as T | null) ?? null,
    all: <T,>(sql: string, ...params: StoreValue[]) => db.query(sql).all(...(params as never[])) as T[],
    exec: (sql) => db.exec(sql),
    transaction: (work) => work()
  }
  sessionMigrations('/nonexistent').slice(0, migrations).forEach((migration) => {
    if (typeof migration === 'string') store.exec(migration)
    else migration(store)
  })
  return store
}

/** Applies the session migrations after the first `applied` ones to a store from `memoryStore(applied)`. */
export function migrateStore(store: PluginStore, applied: number): void {
  sessionMigrations('/nonexistent').slice(applied).forEach((migration) => {
    if (typeof migration === 'string') store.exec(migration)
    else migration(store)
  })
}
