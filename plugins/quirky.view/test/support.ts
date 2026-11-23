import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RpcError,
  RpcErrorCode,
  type PluginCaller,
  type PluginContext,
  type PluginErrorKind,
  type PluginStore,
  type StoreMigration
} from '@quirky/protocol'
import { activate, deactivate } from '../main'
import type { ViewSpec } from '../src/core/catalog'

export const spec = (title = 'Bundle size', text = 'hello'): ViewSpec => ({ title, root: { type: 'markdown', props: { text } } })

const ERROR_CODES: Record<PluginErrorKind, number> = {
  'invalid-params': RpcErrorCode.InvalidParams,
  'not-found': RpcErrorCode.NotFound,
  conflict: RpcErrorCode.Conflict
}

/** The caller of an agent running `quirky view` inside the session. */
export function agent(sessionId = 's1'): PluginCaller {
  return {
    role: 'cli',
    sessionId,
    sessionAuthority: { sessionId, runtimeEpoch: 'epoch', processIncarnation: 'proc', source: 'structured_lease', live: true }
  }
}

/** The caller of the desktop window. */
export const windowCaller: PluginCaller = { role: 'ui' }

/** A CLI caller with no session identity, as outside an agent session. */
export const strangerCaller: PluginCaller = { role: 'cli' }

/** A `PluginStore` over a SQLite database that applies migrations once, tracking them in `user_version`. */
export function sqliteStore(db: Database, migrations: StoreMigration[]): PluginStore {
  const store: PluginStore = {
    get version() {
      return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    },
    run: (sql, ...params) => {
      const result = db.query(sql).run(...(params as never[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: (sql, ...params) => (db.query(sql).get(...(params as never[])) as never) ?? null,
    all: (sql, ...params) => db.query(sql).all(...(params as never[])) as never,
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(work)()
  }
  const applied = store.version
  migrations.slice(applied).forEach((migration, index) => {
    if (typeof migration === 'string') db.exec(migration)
    else migration(store)
    db.exec(`PRAGMA user_version = ${applied + index + 1}`)
  })
  return store
}

type Handler = (params: Record<string, unknown>, caller: PluginCaller) => unknown

export type ViewHarness = {
  /** Events the plugin emitted, as `{event, data}`. */
  events: { event: string; data: any }[]
  /** Messages sent through `quirky.structured/send`. */
  sends: { session: string; text: string; when: string }[]
  /** Makes the next `quirky.structured/send` calls fail or refuse. */
  sendResult: { value: unknown | (() => unknown) }
  call(method: string, params?: Record<string, unknown>, caller?: PluginCaller): Promise<any>
  /** Stops the plugin, keeping its database. */
  stop(): void
}

const dirs: string[] = []

/** A database file that outlives `stop` and a second `startView`, and is removed by `cleanupViews`. */
export function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qv-'))
  dirs.push(dir)
  return join(dir, 'views.db')
}

export function cleanupViews(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Activates the plugin over a fake context whose store is the SQLite file at `databasePath`. */
export function startView(databasePath = tempDatabasePath()): ViewHarness {
  const handlers = new Map<string, Handler>()
  const events: ViewHarness['events'] = []
  const sends: ViewHarness['sends'] = []
  const sendResult: ViewHarness['sendResult'] = { value: { ok: true } }
  const db = new Database(databasePath)
  const context = {
    pluginId: 'quirky.view',
    log() {},
    openStore: (migrations: StoreMigration[]) => sqliteStore(db, migrations),
    provide: (id: string, implementation: unknown) => void handlers.set(id, implementation as Handler),
    emit(event: string, data: unknown) {
      events.push({ event, data })
      return true
    },
    subscribe: () => () => {},
    error: (kind: PluginErrorKind, message: string) => new RpcError(ERROR_CODES[kind], message),
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method !== 'quirky.structured/send') throw new Error(`unexpected method ${method}`)
      sends.push(params as never)
      const value = sendResult.value
      return typeof value === 'function' ? value() : value
    }
  } as unknown as PluginContext
  activate(context)
  return {
    events,
    sends,
    sendResult,
    async call(method, params = {}, caller = agent()) {
      const handler = handlers.get(`method:quirky.view/${method}`)
      if (!handler) throw new Error(`no method ${method}`)
      return handler(params, caller)
    },
    stop() {
      deactivate()
      db.close()
    }
  }
}
