import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AskEnvelope, PluginStore } from '@quirky/protocol'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { v1AsksMigration } from '../v1-import'
import { cleanupAll, connectAs, spec, startAsk, stopKeepingHome } from './support'

afterEach(cleanupAll)

const V1_ASKS = `CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY, spec TEXT NOT NULL, session_id TEXT, worktree_id TEXT,
  created_at INTEGER NOT NULL, status TEXT NOT NULL, answers TEXT NOT NULL, skipped TEXT NOT NULL
)`

function writeV1Home(home: string): void {
  const db = new Database(join(home, 'quirky.db'), { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(V1_ASKS)
  const insert = db.query('INSERT INTO asks VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  insert.run('ask_pending', JSON.stringify(spec), 'sess_1', 'wt_1', 1000, 'pending', '{}', '[]')
  insert.run(
    'ask_done',
    JSON.stringify(spec),
    null,
    null,
    500,
    'partial',
    JSON.stringify({ env: { value: 'dev', source: 'option' } }),
    JSON.stringify(['why'])
  )
  db.close()
}

/** A `PluginStore` over an in-memory database, enough to run a migration function. */
function memoryStore(): PluginStore & { db: Database } {
  const db = new Database(':memory:')
  return {
    db,
    version: 0,
    run: (sql, ...params) => {
      const result = db.query(sql).run(...(params as never[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: (sql, ...params) => (db.query(sql).get(...(params as never[])) as never) ?? null,
    all: (sql, ...params) => db.query(sql).all(...(params as never[])) as never,
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(work)()
  }
}

describe('v1 asks import', () => {
  test('SC-26: pending and resolved asks are listed, the pending one is answerable, and a second start copies nothing', async () => {
    const home = makeTempHome('qa-')
    writeV1Home(home)
    let h = await startAsk(home)
    let client = await connectAs(h)
    const listed = (await client.callAny('quirky.ask/list', {})) as { id: string; sessionId: string | null; worktreeId: string | null; envelope: AskEnvelope }[]
    expect(listed.map((ask) => ask.id)).toEqual(['ask_done', 'ask_pending'])
    expect(listed[0]).toMatchObject({
      sessionId: null,
      envelope: { status: 'partial', answers: { env: { value: 'dev', source: 'option' } }, skipped: ['why'] }
    })
    expect(listed[1]).toMatchObject({ sessionId: 'sess_1', worktreeId: 'wt_1', envelope: { status: 'pending' } })
    expect(((await client.callAny('quirky.ask/list', { pendingOnly: true })) as unknown[]).length).toBe(1)

    const answered = await client.callAny('quirky.ask/answer', { askId: 'ask_pending', answers: { env: { value: 'prod', source: 'option' } } })
    expect(answered).toMatchObject({ status: 'answered' })

    await stopKeepingHome(h)
    h = await startAsk(home)
    client = await connectAs(h)
    const again = (await client.callAny('quirky.ask/list', {})) as { id: string; envelope: AskEnvelope }[]
    expect(again.map((ask) => [ask.id, ask.envelope.status])).toEqual([
      ['ask_done', 'partial'],
      ['ask_pending', 'answered']
    ])
  })

  test('a fresh home imports nothing', async () => {
    const h = await startAsk()
    const client = await connectAs(h)
    expect(await client.callAny('quirky.ask/list', {})).toEqual([])
  })
})

describe('the import migration', () => {
  test('creates the asks table and copies nothing when there is no v1 database', () => {
    const store = memoryStore()
    v1AsksMigration(makeTempHome('qa-'))(store)
    expect(store.all('SELECT * FROM asks')).toEqual([])
  })

  test('copies nothing when the v1 database has no asks table', () => {
    const home = makeTempHome('qa-')
    new Database(join(home, 'quirky.db'), { create: true }).exec('CREATE TABLE repos (id TEXT)')
    const store = memoryStore()
    v1AsksMigration(home)(store)
    expect(store.all('SELECT * FROM asks')).toEqual([])
  })

  test('copies every v1 row with its columns intact', () => {
    const home = makeTempHome('qa-')
    writeV1Home(home)
    const store = memoryStore()
    v1AsksMigration(home)(store)
    expect(store.all<{ id: string; status: string }>('SELECT id, status FROM asks ORDER BY created_at')).toEqual([
      { id: 'ask_done', status: 'partial' },
      { id: 'ask_pending', status: 'pending' }
    ])
  })
})
