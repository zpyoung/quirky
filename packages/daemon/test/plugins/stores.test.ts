import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginStore, StoreMigration } from '@quirky/protocol'
import { openPluginStore, pluginDataDir } from '../../src/plugins/stores'
import { makeTempDir, removeTempDirs } from './fixtures'

afterEach(removeTempDirs)

const ID = 'acme.tools'

function open(home: string, migrations: unknown, isActive: () => boolean = () => true, pluginId = ID) {
  return openPluginStore({ home, pluginId, migrations: migrations as StoreMigration[], isActive })
}

function inspect(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name
    )
    return { version, tables }
  } finally {
    db.close()
  }
}

describe('pluginDataDir', () => {
  test('is <home>/plugin-data/<pluginId>', () => {
    expect(pluginDataDir('/h', 'acme.tools')).toBe(join('/h', 'plugin-data', 'acme.tools'))
  })
})

describe('openPluginStore setup', () => {
  test('creates the data dir with mode 0700 and store.db inside', () => {
    const home = makeTempDir()
    const { close } = open(home, [])
    const dir = pluginDataDir(home, ID)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'store.db')).isFile()).toBe(true)
    close()
  })

  test('uses WAL journal mode', () => {
    const home = makeTempDir()
    const { store, close } = open(home, [])
    expect(store.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal')
    close()
  })

  test('different plugin ids get separate files', () => {
    const home = makeTempDir()
    const a = open(home, ['CREATE TABLE only_a (id INTEGER)'], () => true, 'acme.a')
    const b = open(home, ['CREATE TABLE only_b (id INTEGER)'], () => true, 'acme.b')
    expect(a.store.get("SELECT name FROM sqlite_master WHERE name = 'only_b'")).toBeNull()
    expect(b.store.get("SELECT name FROM sqlite_master WHERE name = 'only_a'")).toBeNull()
    expect(pluginDataDir(home, 'acme.a')).not.toBe(pluginDataDir(home, 'acme.b'))
    a.close()
    b.close()
  })
})

describe('migrations', () => {
  test('first open runs all in order and version equals the count', () => {
    const home = makeTempDir()
    const { store, close } = open(home, [
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO items (name) VALUES ('first')",
      "INSERT INTO items (name) VALUES ('second')"
    ])
    expect(store.version).toBe(3)
    expect(store.all<{ name: string }>('SELECT name FROM items ORDER BY id').map((r) => r.name)).toEqual(['first', 'second'])
    close()
  })

  test('reopen runs only the new migration', () => {
    const home = makeTempDir()
    const first: StoreMigration[] = ['CREATE TABLE items (id INTEGER PRIMARY KEY)']
    open(home, first).close()
    const { store, close } = open(home, [...first, 'CREATE TABLE extras (id INTEGER PRIMARY KEY)'])
    expect(store.version).toBe(2)
    expect(store.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('items', 'extras')")).toHaveLength(2)
    close()
  })

  test('reopen with the same list is a no-op', () => {
    const home = makeTempDir()
    const list: StoreMigration[] = ['CREATE TABLE items (id INTEGER PRIMARY KEY)']
    open(home, list).close()
    const { store, close } = open(home, list)
    expect(store.version).toBe(1)
    close()
  })

  test('a function migration can backfill data', () => {
    const home = makeTempDir()
    const { store, close } = open(home, [
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, slug TEXT)',
      "INSERT INTO items (name) VALUES ('Alpha'), ('Beta')",
      (s: PluginStore) => {
        for (const row of s.all<{ id: number; name: string }>('SELECT id, name FROM items')) {
          s.run('UPDATE items SET slug = ? WHERE id = ?', row.name.toLowerCase(), row.id)
        }
      }
    ])
    expect(store.version).toBe(3)
    expect(store.all<{ slug: string }>('SELECT slug FROM items ORDER BY id').map((r) => r.slug)).toEqual(['alpha', 'beta'])
    close()
  })

  test('a function migration may use transaction', () => {
    const home = makeTempDir()
    const { store, close } = open(home, [
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)',
      (s: PluginStore) => s.transaction(() => s.run("INSERT INTO items (name) VALUES ('x')"))
    ])
    expect(store.get<{ name: string }>('SELECT name FROM items')).toEqual({ name: 'x' })
    close()
  })

  test('a failing migration keeps earlier steps, throws the exact message, and a fixed list reaches the end', () => {
    const home = makeTempDir()
    const m1 = 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)'
    const m1Rows = (s: PluginStore) => s.run("INSERT INTO items (name) VALUES ('kept')")
    let message = ''
    try {
      open(home, [m1, 'CREATE TABLE broken (', 'CREATE TABLE never (id INTEGER)'])
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toStartWith(`${ID} store migration 2 failed: `)
    expect(message.length).toBeGreaterThan(`${ID} store migration 2 failed: `.length)
    const file = join(pluginDataDir(home, ID), 'store.db')
    expect(inspect(file)).toEqual({ version: 1, tables: ['items'] })

    const { store, close } = open(home, [m1, m1Rows, 'CREATE TABLE later (id INTEGER)'])
    expect(store.version).toBe(3)
    expect(store.get<{ name: string }>('SELECT name FROM items')).toEqual({ name: 'kept' })
    close()
  })

  test('a failing migration rolls back its own partial writes', () => {
    const home = makeTempDir()
    expect(() =>
      open(home, [
        'CREATE TABLE items (id INTEGER PRIMARY KEY)',
        (s: PluginStore) => {
          s.exec('CREATE TABLE partial (id INTEGER)')
          throw new Error('boom')
        }
      ])
    ).toThrow(`${ID} store migration 2 failed: boom`)
    expect(inspect(join(pluginDataDir(home, ID), 'store.db'))).toEqual({ version: 1, tables: ['items'] })
  })

  test('an async function migration fails as not synchronous and rolls back', () => {
    const home = makeTempDir()
    let message = ''
    try {
      open(home, [
        'CREATE TABLE items (id INTEGER PRIMARY KEY)',
        (async (s: PluginStore) => {
          s.exec('CREATE TABLE late (id INTEGER)')
        }) as unknown as StoreMigration
      ])
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toStartWith(`${ID} store migration 2 failed: `)
    expect(message).toContain('migrations must be synchronous')
    expect(inspect(join(pluginDataDir(home, ID), 'store.db'))).toEqual({ version: 1, tables: ['items'] })
  })

  test('an async migration that rejects does not leave an unhandled rejection', async () => {
    const home = makeTempDir()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      expect(() =>
        open(home, [(async () => Promise.reject(new Error('late failure'))) as unknown as StoreMigration])
      ).toThrow('migrations must be synchronous')
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  test('a downgrade is refused unless explicitly opened read-only, preserving newer data', () => {
    const home = makeTempDir()
    const migrations: StoreMigration[] = [
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO items (name) VALUES ('newer data')"
    ]
    open(home, migrations).close()
    const file = join(pluginDataDir(home, ID), 'store.db')
    const before = { bytes: readFileSync(file), state: inspect(file) }
    expect(() => open(home, migrations.slice(0, 1))).toThrow()
    const { store, close } = openPluginStore({
      home, pluginId: ID, migrations: migrations.slice(0, 1), isActive: () => true, newerVersion: 'read-only'
    })
    try {
      expect(store.readOnly).toBe(true)
      expect(store.version).toBe(2)
      expect(store.get<{ name: string }>('SELECT name FROM items')).toEqual({ name: 'newer data' })
      expect(() => store.run("DELETE FROM items")).toThrow()
      expect(() => store.exec("DELETE FROM items")).toThrow()
      expect(() => store.get("DELETE FROM items RETURNING id")).toThrow()
      expect(() => store.all("DELETE FROM items RETURNING id")).toThrow()
      let ran = false
      expect(() => store.transaction(() => { ran = true })).toThrow()
      expect(ran).toBe(false)
    } finally {
      close()
    }
    expect(inspect(file)).toEqual(before.state)
    expect(readFileSync(file).equals(before.bytes)).toBe(true)
  })

  test.each([[undefined], ['CREATE TABLE a (id INTEGER)'], [{ 0: 'x', length: 1 }], [[1]], [[null]], [['CREATE TABLE a (id INTEGER)', {}]]])(
    'invalid migrations %p throw',
    (migrations) => {
      const home = makeTempDir()
      expect(() => open(home, migrations)).toThrow(`${ID} migrations must be an array of SQL strings or functions`)
    }
  )
})

describe('PluginStore methods', () => {
  function ready() {
    const home = makeTempDir()
    const opened = open(home, ['CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)'])
    return { home, ...opened }
  }

  test('run returns numeric changes and lastInsertRowid', () => {
    const { store, close } = ready()
    const first = store.run('INSERT INTO items (name, qty) VALUES (?, ?)', 'a', 1)
    expect(first).toEqual({ changes: 1, lastInsertRowid: 1 })
    expect(typeof first.changes).toBe('number')
    expect(typeof first.lastInsertRowid).toBe('number')
    store.run('INSERT INTO items (name, qty) VALUES (?, ?)', 'b', 1)
    expect(store.run('UPDATE items SET qty = ? WHERE qty = ?', 5, 1).changes).toBe(2)
    close()
  })

  test('get returns the first row or null', () => {
    const { store, close } = ready()
    store.run('INSERT INTO items (name, qty) VALUES (?, ?)', 'a', 1)
    store.run('INSERT INTO items (name, qty) VALUES (?, ?)', 'b', 2)
    expect(store.get<{ name: string }>('SELECT name FROM items ORDER BY id')).toEqual({ name: 'a' })
    expect(store.get('SELECT name FROM items WHERE id = ?', 99)).toBeNull()
    close()
  })

  test('all returns every row, or an empty array', () => {
    const { store, close } = ready()
    expect(store.all('SELECT * FROM items')).toEqual([])
    store.run('INSERT INTO items (name, qty) VALUES (?, ?)', 'a', 1)
    store.run('INSERT INTO items (name, qty) VALUES (?, ?)', 'b', 2)
    expect(store.all<{ name: string }>('SELECT name FROM items WHERE qty >= ? ORDER BY id', 1)).toEqual([{ name: 'a' }, { name: 'b' }])
    close()
  })

  test('exec runs several statements', () => {
    const { store, close } = ready()
    store.exec("INSERT INTO items (name) VALUES ('a'); INSERT INTO items (name) VALUES ('b');")
    expect(store.all('SELECT id FROM items')).toHaveLength(2)
    close()
  })

  test('transaction returns the work value and commits', () => {
    const { store, close } = ready()
    const value = store.transaction(() => {
      store.run("INSERT INTO items (name) VALUES ('a')")
      return 42
    })
    expect(value).toBe(42)
    expect(store.all('SELECT id FROM items')).toHaveLength(1)
    close()
  })

  test('transaction rolls back and rethrows when work throws', () => {
    const { store, close } = ready()
    const failure = new Error('nope')
    expect(() =>
      store.transaction(() => {
        store.run("INSERT INTO items (name) VALUES ('a')")
        throw failure
      })
    ).toThrow(failure)
    expect(store.all('SELECT id FROM items')).toHaveLength(0)
    store.run("INSERT INTO items (name) VALUES ('after')")
    expect(store.all('SELECT id FROM items')).toHaveLength(1)
    close()
  })

  test('version reflects user_version', () => {
    const { store, close } = ready()
    expect(store.version).toBe(1)
    close()
  })
})

describe('lifecycle', () => {
  function everyMethod(store: PluginStore): Array<() => unknown> {
    return [
      () => store.version,
      () => store.run('SELECT 1'),
      () => store.get('SELECT 1'),
      () => store.all('SELECT 1'),
      () => store.exec('SELECT 1'),
      () => store.transaction(() => 1)
    ]
  }

  test('every method throws after close, and close is idempotent', () => {
    const home = makeTempDir()
    const { store, close } = open(home, [])
    close()
    close()
    for (const call of everyMethod(store)) expect(call).toThrow(`${ID} is no longer active`)
  })

  test('every method throws once isActive turns false', () => {
    const home = makeTempDir()
    let active = true
    const { store, close } = open(home, [], () => active)
    expect(store.get<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 })
    active = false
    for (const call of everyMethod(store)) expect(call).toThrow(`${ID} is no longer active`)
    close()
  })

  test('the file can be reopened after close', () => {
    const home = makeTempDir()
    const list: StoreMigration[] = ['CREATE TABLE items (id INTEGER PRIMARY KEY)']
    const first = open(home, list)
    first.store.run('INSERT INTO items DEFAULT VALUES')
    first.close()
    const second = open(home, list)
    expect(second.store.all('SELECT id FROM items')).toHaveLength(1)
    second.close()
  })
})
