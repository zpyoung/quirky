import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient, RpcErrorCode } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { startDaemon, type DaemonHandle } from '../../src/daemon'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writePlugin } from './fixtures'

let h: Harness | null = null
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await h?.cleanup()
  h = null
  removeTempDirs()
})

const METHODS = ['add', 'list', 'version', 'open-error', 'probe']

/** A migration written as source: a SQL string, or a function that records that it ran. */
const sql = (statement: string) => JSON.stringify(statement)
const recorded = (marker: string, n: number, statement: string) =>
  `(store: any) => { appendFileSync(${JSON.stringify(marker)}, 'migration ${n}\\n'); store.exec(${JSON.stringify(statement)}) }`

const CREATE_ITEMS = 'CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL)'
const ADD_DONE = 'ALTER TABLE items ADD COLUMN done INTEGER'
const BACKFILL_DONE = 'UPDATE items SET done = 0'

/**
 * Writes `<home>/plugins/<id>` whose manifest points at `main-<tag>.ts`. A different tag per version
 * keeps the process-wide module cache from handing back a previous version's code.
 */
function writeStorePlugin(
  home: string,
  id: string,
  tag: string,
  migrations: string[],
  options: { catchOpenError?: boolean } = {}
): void {
  const open = `context.openStore([${migrations.join(', ')}])`
  const source = `
import { appendFileSync } from 'node:fs'
let kept: any
let openError: string | null = null
export function activate(context: any) {
  let store: any = null
  ${options.catchOpenError ? `try { store = ${open} } catch (error: any) { openError = error.message }` : `store = ${open}`}
  if (store) kept ??= store
  context.provide('method:${id}/add', (params: any) => { store.run('INSERT INTO items (text) VALUES (?)', params.text); return true })
  context.provide('method:${id}/list', () => store.all('SELECT text FROM items ORDER BY id').map((row: any) => row.text))
  context.provide('method:${id}/version', () => store.version)
  context.provide('method:${id}/open-error', () => openError)
  context.provide('method:${id}/probe', () => { try { kept.version; return null } catch (error: any) { return error.message } })
}
`
  writePlugin(
    join(home, 'plugins'),
    { id, name: id, version: tag, main: `main-${tag}.ts`, contributes: { method: METHODS.map((name) => ({ id: name, params: { type: 'object', additionalProperties: true } })) } },
    { [`main-${tag}.ts`]: source }
  )
}

type Session = { harness: Harness; home: string; marker: string; client: QuirkyClient; daemon: DaemonHandle }

/** Starts a daemon with no built-in plugins over `home`, which the caller has already filled. */
async function boot(home = makeTempHome()): Promise<Session> {
  const marker = join(makeTempDir(), 'marker.log')
  return { ...(await start(home, marker)), marker }
}

async function start(home: string, marker: string) {
  const harness = await startHarness({ home, builtinPluginsDir: null })
  h = harness
  return { harness, home, marker, client: await harness.connect(), daemon: harness.daemon }
}

/** Stops the running daemon; the home stays, so files can be swapped before `restart`. */
async function stop(s: Session): Promise<void> {
  await s.daemon.stop()
}

/** Starts a new daemon on the same home. The harness's own stopped daemon is left for its cleanup. */
async function restart(s: Session): Promise<void> {
  s.daemon = await startDaemon({
    home: s.home,
    port: 0,
    git: s.harness.git,
    shell: '/bin/zsh',
    notifier: () => {},
    uiDir: '/none',
    builtinPluginsDir: null
  })
  cleanups.push(() => s.daemon.stop())
  s.client = await QuirkyClient.connect(rpcUrl(s.daemon.runtime), { role: 'cli' })
  cleanups.push(() => s.client.close())
}

const call = (s: Session, method: string, params: Record<string, unknown> = {}) => s.client.callAny(method, params)

const storePath = (home: string, id: string) => join(home, 'plugin-data', id, 'store.db')

/** Reads a plugin's store file directly; the daemon must not hold it open for writing. */
function inspect<T>(home: string, id: string, read: (db: Database) => T): T {
  const db = new Database(storePath(home, id), { readonly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

const versionOf = (home: string, id: string) =>
  inspect(home, id, (db) => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version)

const columnsOf = (home: string, id: string) =>
  inspect(home, id, (db) => (db.query('PRAGMA table_info(items)').all() as { name: string }[]).map((column) => column.name))

describe('plugin stores over RPC', () => {
  test('SC-11: a plugin\'s store persists and is its own', async () => {
    const home = makeTempHome()
    for (const id of ['acme.notes', 'acme.todo']) writeStorePlugin(home, id, '1', [sql(CREATE_ITEMS)])
    const s = await boot(home)
    expect(existsSync(join(home, 'plugin-data'))).toBe(false)

    expect(await call(s, 'acme.notes/add', { text: 'milk' })).toBe(true)
    expect(await call(s, 'acme.notes/list')).toEqual(['milk'])

    await stop(s)
    await restart(s)

    expect(await call(s, 'acme.notes/list')).toEqual(['milk'])
    expect(await call(s, 'acme.todo/list')).toEqual([])

    expect(existsSync(storePath(home, 'acme.notes'))).toBe(true)
    expect(existsSync(storePath(home, 'acme.todo'))).toBe(true)
    expect(statSync(join(home, 'plugin-data', 'acme.notes')).mode & 0o777).toBe(0o700)

    await stop(s)
    expect(inspect(home, 'acme.notes', (db) => db.query('SELECT text FROM items').all())).toEqual([{ text: 'milk' }])
    expect(inspect(home, 'acme.todo', (db) => db.query('SELECT text FROM items').all())).toEqual([])
  })

  test('SC-12: migrations run once each, in order, and new ones run on upgrade', async () => {
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    writeStorePlugin(home, 'acme.notes', '1', [recorded(marker, 1, CREATE_ITEMS)])
    const s: Session = { ...(await start(home, marker)), marker }
    expect(await call(s, 'acme.notes/add', { text: 'milk' })).toBe(true)
    expect(readMarker(marker)).toEqual(['migration 1'])

    await stop(s)
    expect(versionOf(home, 'acme.notes')).toBe(1)
    expect(inspect(home, 'acme.notes', (db) => db.query('SELECT text FROM items').all())).toEqual([{ text: 'milk' }])

    writeStorePlugin(home, 'acme.notes', '2', [
      recorded(marker, 1, CREATE_ITEMS),
      recorded(marker, 2, ADD_DONE),
      recorded(marker, 3, BACKFILL_DONE)
    ])
    await restart(s)
    expect(await call(s, 'acme.notes/version')).toBe(3)
    expect(await call(s, 'acme.notes/list')).toEqual(['milk'])
    expect(readMarker(marker)).toEqual(['migration 1', 'migration 2', 'migration 3'])

    await stop(s)
    expect(versionOf(home, 'acme.notes')).toBe(3)
    expect(inspect(home, 'acme.notes', (db) => db.query('SELECT text, done FROM items').all())).toEqual([{ text: 'milk', done: 0 }])
  })

  test('SC-13: a failing migration rolls back its step and stops activation', async () => {
    const home = makeTempHome()
    writeStorePlugin(home, 'acme.notes', '1', [sql(CREATE_ITEMS)])
    const s = await boot(home)
    await call(s, 'acme.notes/add', { text: 'milk' })
    await stop(s)
    expect(versionOf(home, 'acme.notes')).toBe(1)

    // the first statement of the broken step succeeds, so only a rollback keeps `done` out of the table
    writeStorePlugin(home, 'acme.notes', '2', [
      sql(CREATE_ITEMS),
      sql(`${ADD_DONE}; SELECT * FROM no_such_table`),
      sql(BACKFILL_DONE)
    ])
    await restart(s)
    const failure = await s.client.call('plugin.activate', { pluginId: 'acme.notes' }).then(
      () => {
        throw new Error('expected the activation to reject')
      },
      (error: { code: number; message: string }) => error
    )
    expect(failure.code).toBe(RpcErrorCode.Conflict)
    expect(failure.message).toMatch(/acme\.notes store migration 2 failed: .+/)
    const info = (await s.client.call('plugin.list', {})).find((plugin) => plugin.id === 'acme.notes')!
    expect(info.state).toBe('failed')
    expect(info.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toMatch(/acme\.notes store migration 2 failed: .+/)

    await stop(s)
    expect(versionOf(home, 'acme.notes')).toBe(1)
    expect(columnsOf(home, 'acme.notes')).toEqual(['id', 'text'])
    expect(inspect(home, 'acme.notes', (db) => db.query('SELECT text FROM items').all())).toEqual([{ text: 'milk' }])

    writeStorePlugin(home, 'acme.notes', '3', [sql(CREATE_ITEMS), sql(ADD_DONE), sql(BACKFILL_DONE)])
    await restart(s)
    expect(await s.client.call('plugin.activate', { pluginId: 'acme.notes' })).toMatchObject({ state: 'active' })
    expect(await call(s, 'acme.notes/version')).toBe(3)

    await stop(s)
    expect(versionOf(home, 'acme.notes')).toBe(3)
    expect(inspect(home, 'acme.notes', (db) => db.query('SELECT text, done FROM items').all())).toEqual([{ text: 'milk', done: 0 }])
  })

  test('SC-14: a downgraded plugin can\'t open a newer store', async () => {
    const home = makeTempHome()
    writeStorePlugin(home, 'acme.notes', '3', [sql(CREATE_ITEMS), sql(ADD_DONE), sql(BACKFILL_DONE)])
    const s = await boot(home)
    await call(s, 'acme.notes/add', { text: 'milk' })
    await stop(s)
    expect(versionOf(home, 'acme.notes')).toBe(3)
    const before = readFileSync(storePath(home, 'acme.notes'))

    writeStorePlugin(home, 'acme.notes', '1', [sql(CREATE_ITEMS)], { catchOpenError: true })
    await restart(s)
    expect(await call(s, 'acme.notes/open-error')).toBe('acme.notes store is at version 3, but the plugin knows 1 migrations')

    await stop(s)
    expect(versionOf(home, 'acme.notes')).toBe(3)
    expect(readFileSync(storePath(home, 'acme.notes')).equals(before)).toBe(true)
    expect(inspect(home, 'acme.notes', (db) => db.query('SELECT text FROM items').all())).toEqual([{ text: 'milk' }])
  })

  test('SC-15: a deactivated plugin\'s store is closed but kept', async () => {
    const home = makeTempHome()
    writeStorePlugin(home, 'acme.notes', '1', [sql(CREATE_ITEMS)])
    const s = await boot(home)
    await call(s, 'acme.notes/add', { text: 'milk' })
    expect(await call(s, 'acme.notes/probe')).toBeNull()

    await s.client.call('plugin.disable', { id: 'acme.notes' })
    const disabled = (await s.client.call('plugin.list', {})).find((plugin) => plugin.id === 'acme.notes')!
    expect(disabled.state).toBe('disabled')
    expect(inspect(home, 'acme.notes', (db) => db.query('SELECT text FROM items').all())).toEqual([{ text: 'milk' }])

    await s.client.call('plugin.enable', { id: 'acme.notes' })
    expect(await call(s, 'acme.notes/list')).toEqual(['milk'])
    // the module is cached, so `kept` is still the handle from the first activation
    expect(await call(s, 'acme.notes/probe')).toBe('acme.notes is no longer active')
  })
})
