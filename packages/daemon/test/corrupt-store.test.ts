import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/store'
import { makeTempHome, startHarness, type Harness } from './helpers'
import { writePlugin } from './plugins/fixtures'

let harness: Harness | null = null
const homes: string[] = []
afterEach(async () => {
  await harness?.cleanup()
  harness = null
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function home(): string {
  const path = makeTempHome('qd-corrupt-')
  homes.push(path)
  return path
}

function quarantines(path: string): string[] {
  const slash = path.lastIndexOf('/')
  const dir = path.slice(0, slash)
  const name = path.slice(slash + 1)
  return readdirSync(dir).filter((entry) => entry.startsWith(`${name}.corrupt-`)).map((entry) => join(dir, entry))
}

function startupPlugin(root: string, failMigration = false): string {
  const id = 'acme.notes'
  writePlugin(join(root, 'plugins'), {
    id, name: id, version: '1.0.0', main: 'main.ts', activation: 'startup',
    contributes: { method: [{ id: 'add', params: { type: 'object', additionalProperties: true } }, { id: 'list' }] }
  }, {
    'main.ts': `
import type { PluginContext } from '@quirky/protocol'
export function activate(context: PluginContext) {
  const store = context.openStore([${failMigration ? "() => { throw new Error('migration rejected') }" : JSON.stringify('CREATE TABLE notes (text TEXT NOT NULL)')}])
  context.provide('method:acme.notes/add', (params: unknown) => {
    if (!params || typeof params !== 'object' || !('text' in params) || typeof params.text !== 'string') throw new Error('text required')
    store.run('INSERT INTO notes VALUES (?)', params.text)
    return true
  })
  context.provide('method:acme.notes/list', () => store.all<{ text: string }>('SELECT text FROM notes').map((row) => row.text))
}
`
  })
  const dir = join(root, 'plugin-data', id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'store.db')
  writeFileSync(path, Buffer.alloc(8192, 0x41))
  return path
}

function corruptFreelist(path: string) {
  const db = new Database(path)
  try {
    db.exec('CREATE TABLE discarded (payload BLOB); INSERT INTO discarded VALUES (zeroblob(262144)); DELETE FROM discarded; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE')
  } finally {
    db.close(true)
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
  const bytes = readFileSync(path)
  const pageSize = bytes.readUInt16BE(16) || 65536
  const trunk = bytes.readUInt32BE(32)
  expect(trunk).toBeGreaterThan(0)
  bytes.writeUInt32BE(0x7fffffff, (trunk - 1) * pageSize + 4)
  writeFileSync(path, bytes)
  const check = new Database(path, { readonly: true })
  try {
    expect(check.query('PRAGMA integrity_check(1)').values()).not.toEqual([['ok']])
  } finally {
    check.close(true)
  }
  return bytes
}

test('starts with corrupt kernel and startup plugin stores, warns once, and serves a fresh writable store', async () => {
  const root = home()
  const kernel = join(root, 'quirky.db')
  const bytes = Buffer.alloc(8192, 0x41)
  writeFileSync(kernel, bytes)
  const plugin = startupPlugin(root)
  const logs: string[] = []
  harness = await startHarness({ home: root, log: (message) => logs.push(message) })
  const client = await harness.connect()
  expect(await client.call('status.get', {})).toBeTruthy()
  const info = (await client.call('plugin.list', {})).find((entry) => entry.id === 'acme.notes')!
  expect(info.state).toBe('active')
  const warnings = info.diagnostics.filter((entry) => entry.level === 'warning')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]!.message).toStartWith(`quarantined corrupt store ${plugin} to `)
  expect(logs.filter((line) => line === `acme.notes: ${warnings[0]!.message}`)).toHaveLength(1)
  for (const file of [kernel, plugin]) {
    const originals = quarantines(file)
    expect(originals).toHaveLength(1)
    expect(originals[0]).toMatch(/\.corrupt-\d+-[0-9a-f]{8}$/)
    expect(readFileSync(originals[0]!)).toEqual(bytes)
  }
  expect(logs.filter((line) => line.startsWith(`quarantined corrupt store ${kernel} to `))).toHaveLength(1)
  expect(await client.callAny('acme.notes/add', { text: 'recovered' })).toBe(true)
  expect(await client.callAny('acme.notes/list', {})).toEqual(['recovered'])
})

test('repairs the kernel freelist, preserves settings, and logs the recovery once', async () => {
  const root = home()
  const path = join(root, 'quirky.db')
  const store = new Store(path)
  store.setSettingValue('acme.notes/color', 'graphite')
  store.close()
  const original = corruptFreelist(path)
  const logs: string[] = []
  harness = await startHarness({ home: root, log: (message) => logs.push(message) })
  const client = await harness.connect()
  expect(await client.call('status.get', {})).toBeTruthy()
  const preserved = new Database(path, { readonly: true })
  try {
    expect(preserved.query('SELECT value FROM setting_values WHERE id = ?').get('acme.notes/color')).toEqual({ value: JSON.stringify('graphite') })
    expect(preserved.query('PRAGMA integrity_check(1)').values()).toEqual([['ok']])
  } finally {
    preserved.close(true)
  }
  const originals = quarantines(path)
  expect(originals).toHaveLength(1)
  expect(readFileSync(originals[0]!)).toEqual(original)
  const messages = logs.filter((line) => line.startsWith(`repaired corrupt store ${path}; the original is at ${originals[0]}: `))
  expect(messages).toHaveLength(1)
})

test('retains the recovery warning when the startup plugin migration subsequently fails', async () => {
  const root = home()
  const path = startupPlugin(root, true)
  const logs: string[] = []
  harness = await startHarness({ home: root, log: (message) => logs.push(message) })
  const client = await harness.connect()
  const info = (await client.call('plugin.list', {})).find((entry) => entry.id === 'acme.notes')!
  expect(info.state).toBe('failed')
  const warnings = info.diagnostics.filter((entry) => entry.level === 'warning')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]!.message).toStartWith(`quarantined corrupt store ${path} to `)
  expect(logs).toContain(`acme.notes: ${warnings[0]!.message}`)
  expect(info.diagnostics.some((entry) => entry.message.includes('migration rejected'))).toBe(true)
})
