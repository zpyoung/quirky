import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { PluginCaller, PluginContext, PluginStore, Session, StoreValue } from '@quirky/protocol'
import { SessionRecords, sessionMigrations } from '../src/records'
import { SessionService } from '../src/sessions'

function memoryStore(): PluginStore {
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
  for (const migration of sessionMigrations('/nonexistent')) {
    if (typeof migration === 'string') store.exec(migration)
    else migration(store)
  }
  return store
}

const worktree = { id: 'wt', repoId: 'repo', path: '/work', branch: 'main', head: 'abc', isMain: true, name: 'main' }
const caller = { role: 'cli' } as PluginCaller

describe('SessionService.create', () => {
  test('a process that exits before the spawn call returns leaves the session exited', async () => {
    const emitted: { event: string; status?: string; exitCode?: number | null }[] = []
    let service!: SessionService
    let sessionId = ''
    const context = {
      log() {},
      emit: (event: string, data?: { session?: Session }) => {
        emitted.push({ event, status: data?.session?.status, exitCode: data?.session?.exitCode })
        return true
      },
      error: (kind: string, message: string) => new Error(`${kind}: ${message}`),
      call: async () => worktree,
      launch: {
        hooks: async (request: { sessionId: string }) => {
          sessionId = request.sessionId
          return { env: {}, args: [] }
        },
        shellArgv: () => ['/bin/sh'],
        commandArgv: () => ['/bin/sh'],
        env: () => ({})
      },
      pty: {
        spawn: async () => {
          service.finish(sessionId, 127)
        },
        forget: async () => {}
      }
    } as unknown as PluginContext
    const records = new SessionRecords(memoryStore())
    service = new SessionService(context, records)

    const result = await service.create({ agent: 'shell' }, caller)

    expect(result).toMatchObject({ status: 'exited', exitCode: 127 })
    expect(records.get(result.id)).toMatchObject({ status: 'exited', exitCode: 127 })
    expect(emitted.filter((e) => e.event === 'changed').map((e) => e.status)).toEqual(['exited'])
  })
})
