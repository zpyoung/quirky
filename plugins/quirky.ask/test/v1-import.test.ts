import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AskEnvelope } from '@quirky/protocol'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { v1AsksMigration } from '../v1-import'
import { askHandoffMigration, askOwnershipMigration, askQueueMigration } from '../store-migrations'
import { cleanupAll, connectAs, memoryStore, spec, startAsk, stopKeepingHome } from './support'

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
      seq: 1,
      queued: false,
      envelope: { status: 'partial', answers: { env: { value: 'dev', source: 'option' } }, skipped: ['why'] }
    })
    expect(listed[1]).toMatchObject({ sessionId: 'sess_1', worktreeId: 'wt_1', seq: 2, queued: false, envelope: { status: 'pending' } })
    expect(((await client.callAny('quirky.ask/list', { pendingOnly: true })) as unknown[]).length).toBe(1)

    const answered = await client.callAny('quirky.ask/answer', { askId: 'ask_pending', answers: { env: { value: 'prod', source: 'option' }, why: { value: 'ship it', source: 'input' } } })
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

describe('migration 2', () => {
  test('numbers existing rows 1..n in creation order and starts the counter at n', () => {
    const home = makeTempHome('qa-')
    writeV1Home(home)
    const store = memoryStore()
    v1AsksMigration(home)(store)
    askQueueMigration(store)
    expect(store.all('SELECT id, seq, created_seq, partial, expires_at, summary FROM asks ORDER BY seq')).toEqual([
      { id: 'ask_done', seq: 1, created_seq: 1, partial: '{}', expires_at: null, summary: '' },
      { id: 'ask_pending', seq: 2, created_seq: 2, partial: '{}', expires_at: null, summary: '' }
    ])
    expect(store.all('SELECT id, value FROM ask_seq')).toEqual([{ id: 1, value: 2 }])
  })

  test('ties on created_at are ordered by id', () => {
    const store = memoryStore()
    v1AsksMigration(makeTempHome('qa-'))(store)
    for (const id of ['ask_b', 'ask_a']) {
      store.run('INSERT INTO asks VALUES (?, ?, NULL, NULL, 100, ?, ?, ?)', id, JSON.stringify(spec), 'pending', '{}', '[]')
    }
    askQueueMigration(store)
    expect(store.all('SELECT id, seq FROM asks ORDER BY seq')).toEqual([
      { id: 'ask_a', seq: 1 },
      { id: 'ask_b', seq: 2 }
    ])
  })

  test('an empty store gets a counter at 0', () => {
    const store = memoryStore()
    v1AsksMigration(makeTempHome('qa-'))(store)
    askQueueMigration(store)
    expect(store.all('SELECT id, value FROM ask_seq')).toEqual([{ id: 1, value: 0 }])
  })

  test('pending v1 asks of one session join its queue in creation order, and promotion takes the next counter value', async () => {
    const home = makeTempHome('qa-')
    const db = new Database(join(home, 'quirky.db'), { create: true })
    db.exec(V1_ASKS)
    const insert = db.query('INSERT INTO asks VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run('ask_old', JSON.stringify(spec), null, null, 50, 'declined', '{}', '[]')
    insert.run('ask_b', JSON.stringify(spec), 'sess_1', null, 200, 'pending', '{}', '[]')
    insert.run('ask_a', JSON.stringify(spec), 'sess_1', null, 100, 'pending', '{}', '[]')
    db.close()

    const h = await startAsk(home)
    const client = await connectAs(h)
    const queue = async () =>
      ((await client.callAny('quirky.ask/list', { pendingOnly: true })) as { id: string; seq: number; queued: boolean }[]).map((ask) => [ask.id, ask.seq, ask.queued])
    expect(await queue()).toEqual([
      ['ask_a', 2, false],
      ['ask_b', 3, true]
    ])

    await client.callAny('quirky.ask/answer', { askId: 'ask_a', answers: {}, skipped: ['env', 'why'] })
    expect(await queue()).toEqual([['ask_b', 5, false]])
  })
})

describe('migration 3', () => {
  test('adds nullable private plugin ownership without assigning owners to existing asks', () => {
    const home = makeTempHome('qa-')
    writeV1Home(home)
    const store = memoryStore()
    v1AsksMigration(home)(store)
    askQueueMigration(store)
    askOwnershipMigration(store)

    expect(store.all<{ id: string; owner_plugin_id: string | null }>('SELECT id, owner_plugin_id FROM asks ORDER BY id')).toEqual([
      { id: 'ask_done', owner_plugin_id: null },
      { id: 'ask_pending', owner_plugin_id: null }
    ])
    store.run('UPDATE asks SET owner_plugin_id = ? WHERE id = ?', 'quirky.ask-owner', 'ask_pending')
    expect(store.get<{ owner_plugin_id: string }>('SELECT owner_plugin_id FROM asks WHERE id = ?', 'ask_pending')).toEqual({ owner_plugin_id: 'quirky.ask-owner' })
  })
})

describe('migration 4', () => {
  test('adds nullable exact-owner and idempotency fields without changing imported Ask rows', () => {
    const home = makeTempHome('qa-')
    writeV1Home(home)
    const store = memoryStore()
    v1AsksMigration(home)(store)
    askQueueMigration(store)
    askOwnershipMigration(store)
    askHandoffMigration(store)

    expect(store.all<{ id: string; request_id: string | null; owner_identity: string | null }>(
      'SELECT id, request_id, owner_identity FROM asks ORDER BY id'
    )).toEqual([
      { id: 'ask_done', request_id: null, owner_identity: null },
      { id: 'ask_pending', request_id: null, owner_identity: null }
    ])
    store.run('UPDATE asks SET request_id = ? WHERE id = ?', 'request_1', 'ask_done')
    expect(() => store.run('UPDATE asks SET request_id = ? WHERE id = ?', 'request_1', 'ask_pending')).toThrow()
  })
})

