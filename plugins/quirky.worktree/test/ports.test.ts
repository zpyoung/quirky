import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { failure } from '../../quirky.repo/test/git-fixtures'
import type { PluginStore } from '@quirky/protocol'
import { WorktreePorts, DEFAULT_PORT_RANGE, PORT_LOOPBACK_HOSTS, isPortFree, migrateWorktreePorts, portBlocks, portEnvironment, storedPortBlock } from '../src/daemon/ports'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qw-ports-'))
  const open = () => openPluginStore({
    home,
    pluginId: 'quirky.worktree',
    isActive: () => true,
    migrations: [
      (store) => store.exec('CREATE TABLE worktrees (id TEXT PRIMARY KEY)'),
      migrateWorktreePorts
    ]
  })
  let opened = open()
  cleanups.push(() => { opened.close(); rmSync(home, { recursive: true, force: true }) })
  return {
    get store() { return opened.store },
    reopen() {
      opened.close()
      opened = open()
      return opened.store
    }
  }
}

function addWorktrees(store: PluginStore, ...ids: string[]) {
  for (const id of ids) store.run('INSERT INTO worktrees VALUES (?)', id)
}

function range(start = 42000, end = 42029, size = 10) {
  return { start, end, size }
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected promise to reject')
}

function listen(host: string, port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer()
  const { promise, resolve, reject } = Promise.withResolvers<{ server: Server; port: number }>()
  const onError = (error: Error) => reject(error)
  server.once('error', onError)
  server.listen({ host, port, exclusive: true }, () => {
    server.off('error', onError)
    const address = server.address()
    if (!address || typeof address === 'string') {
      reject(new Error(`server on ${host} did not expose an IP address`))
      return
    }
    resolve({ server, port: address.port })
  })
  return promise
}

function close(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.close((error) => error ? reject(error) : resolve())
  return promise
}

async function unusedPort() {
  const holder = await listen('127.0.0.1')
  await close(holder.server)
  return holder.port
}

test('allocates the lowest free block, stores it, and reuses it after deletion', async () => {
  const { store } = fixture()
  addWorktrees(store, 'a', 'b', 'c')
  const ports = new WorktreePorts({ store, range: () => range(), probe: async () => true, now: () => 123 })

  expect(DEFAULT_PORT_RANGE).toEqual({ start: 41000, end: 48999, size: 10 })
  expect(PORT_LOOPBACK_HOSTS).toEqual(['0.0.0.0', '127.0.0.1', '::', '::1'])
  expect(await ports.ensure('a')).toEqual({ base: 42000, count: 10 })
  expect(await ports.ensure('b')).toEqual({ base: 42010, count: 10 })
  expect(storedPortBlock(store, 'a')).toEqual({ base: 42000, count: 10 })
  expect(portBlocks(store)).toEqual([
    { worktreeId: 'a', base: 42000, count: 10 },
    { worktreeId: 'b', base: 42010, count: 10 }
  ])
  expect(portEnvironment({ base: 42000, count: 10 })).toEqual({
    PORT: '42000',
    WORKTREE_PORT: '42000',
    WORKTREE_PORT_COUNT: '10'
  })
  expect(store.get<{ allocated_at: number }>('SELECT allocated_at FROM worktree_ports WHERE worktree_id = ?', 'a')).toEqual({ allocated_at: 123 })

  store.run('DELETE FROM worktrees WHERE id = ?', 'a')
  expect(await ports.ensure('c')).toEqual({ base: 42000, count: 10 })
  expect(portBlocks(store)).toEqual([
    { worktreeId: 'c', base: 42000, count: 10 },
    { worktreeId: 'b', base: 42010, count: 10 }
  ])
})

test('skips a block at its first busy port without probing the rest', async () => {
  const { store } = fixture()
  addWorktrees(store, 'a')
  const probes: number[] = []
  const ports = new WorktreePorts({
    store,
    range: () => range(),
    probe: async (port) => { probes.push(port); return port !== 42003 }
  })

  expect(await ports.ensure('a')).toEqual({ base: 42010, count: 10 })
  expect(probes).toEqual([42000, 42001, 42002, 42003, 42010, 42011, 42012, 42013, 42014, 42015, 42016, 42017, 42018, 42019])
})

for (const host of PORT_LOOPBACK_HOSTS) {
  test(`real port probe detects a listener on ${host}`, async () => {
    let holder: { server: Server; port: number }
    try {
      holder = await listen(host)
    } catch (error) {
      if (host !== '::' && host !== '::1') throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === undefined) throw error
      expect(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT']).toContain(code)
      expect(await isPortFree(await unusedPort())).toBe(true)
      return
    }

    try {
      expect(await isPortFree(holder.port)).toBe(false)
    } finally {
      await close(holder.server)
    }
    expect(await isPortFree(holder.port)).toBe(true)
  })
}

test('real port probe rejects unknown IPv4 bind errors', async () => {
  const error = await rejected(isPortFree(65536))
  expect(error).toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' })
})

test('worktree-port rows are removed by the worktrees delete trigger', () => {
  const { store } = fixture()
  addWorktrees(store, 'removed')
  store.run('INSERT INTO worktree_ports (worktree_id, base, count, allocated_at) VALUES (?, ?, ?, ?)', 'removed', 42000, 10, 123)

  store.run('DELETE FROM worktrees WHERE id = ?', 'removed')
  expect(store.get('SELECT worktree_id FROM worktree_ports WHERE worktree_id = ?', 'removed')).toBeNull()

  store.run('INSERT INTO worktrees VALUES (?)', 'removed')
  expect(store.get('SELECT worktree_id FROM worktree_ports WHERE worktree_id = ?', 'removed')).toBeNull()
})

test('rejects invalid ranges only when a block must be allocated', async () => {
  const { store } = fixture()
  addWorktrees(store, 'held', 'bad-start', 'bad-end', 'bad-size', 'reversed', 'too-large')

  let configured = range()
  let probes = 0
  const ports = new WorktreePorts({
    store,
    range: () => configured,
    probe: async () => { probes++; return true }
  })
  const held = await ports.ensure('held')

  configured = range(42008, 42017, 2.5)
  expect(await ports.ensure('held')).toEqual(held)
  expect(probes).toBe(10)

  const invalid = [
    { id: 'bad-start', value: range(42000.5, 42009, 10), message: 'port range is invalid: portRangeStart must be a whole number' },
    { id: 'bad-end', value: range(42000, 42009.5, 10), message: 'port range is invalid: portRangeEnd must be a whole number' },
    { id: 'bad-size', value: range(42000, 42009, 2.5), message: 'port range is invalid: portBlockSize must be a whole number' },
    { id: 'reversed', value: range(42100, 42000, 10), message: 'port range is invalid: portRangeStart 42100 is above portRangeEnd 42000' },
    { id: 'too-large', value: range(42000, 42001, 3), message: 'port range is invalid: a block of 3 ports does not fit between 42000 and 42001' }
  ]
  for (const item of invalid) {
    configured = item.value
    expect((await failure(ports.ensure(item.id))).message).toBe(item.message)
  }
})

test('rejects when no block is free', async () => {
  const { store } = fixture()
  addWorktrees(store, 'a')
  const ports = new WorktreePorts({ store, range: () => range(42000, 42009, 10), probe: async () => false })

  expect((await failure(ports.ensure('a'))).message).toBe('no free block of 10 ports between 42000 and 42009')
})

test('keeps held intervals when settings change and skips overlapping candidates', async () => {
  const { store } = fixture()
  addWorktrees(store, 'a', 'b')
  let configured = range()
  const probes: number[] = []
  const ports = new WorktreePorts({
    store,
    range: () => configured,
    probe: async (port) => { probes.push(port); return true }
  })

  expect(await ports.ensure('a')).toEqual({ base: 42000, count: 10 })
  configured = range(42008, 42047, 4)
  expect(await ports.ensure('a')).toEqual({ base: 42000, count: 10 })
  const probesBeforeB = probes.length
  expect(await ports.ensure('b')).toEqual({ base: 42012, count: 4 })
  expect(probes.slice(probesBeforeB)).toEqual([42012, 42013, 42014, 42015])
})

test('serializes concurrent allocations for one or different worktrees', async () => {
  const { store } = fixture()
  addWorktrees(store, 'a', 'b')
  const probeGate = Promise.withResolvers<void>()
  let probeCalls = 0
  const ports = new WorktreePorts({
    store,
    range: () => range(42000, 42019, 10),
    probe: async () => {
      if (probeCalls++ === 0) queueMicrotask(() => probeGate.resolve())
      await probeGate.promise
      return true
    }
  })

  const sameWorktree = await Promise.all(Array.from({ length: 10 }, () => ports.ensure('a')))
  expect(sameWorktree).toEqual(Array.from({ length: 10 }, () => ({ base: 42000, count: 10 })))
  expect(store.all('SELECT worktree_id FROM worktree_ports')).toHaveLength(1)

  const differentWorktrees = await Promise.all([ports.ensure('a'), ports.ensure('b')])
  expect(differentWorktrees).toEqual([{ base: 42000, count: 10 }, { base: 42010, count: 10 }])
  expect(store.all('SELECT worktree_id FROM worktree_ports')).toHaveLength(2)
})

test('does not allocate after a worktree is deleted while probing', async () => {
  const { store } = fixture()
  addWorktrees(store, 'a')
  const probing = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const ports = new WorktreePorts({
    store,
    range: () => range(42000, 42009, 10),
    probe: async () => { probing.resolve(); await gate.promise; return true }
  })

  const pending = ports.ensure('a')
  await probing.promise
  store.run('DELETE FROM worktrees WHERE id = ?', 'a')
  gate.resolve()

  expect((await failure(pending)).message).toBe('worktree a no longer exists')
  expect(store.get('SELECT worktree_id FROM worktree_ports WHERE worktree_id = ?', 'a')).toBeNull()
})

test('persists an allocation and does not probe it again after reopening the store', async () => {
  const item = fixture()
  addWorktrees(item.store, 'a')
  const first = new WorktreePorts({ store: item.store, range: () => range(), probe: async () => true, now: () => 456 })
  expect(await first.ensure('a')).toEqual({ base: 42000, count: 10 })

  const store = item.reopen()
  let probes = 0
  const restarted = new WorktreePorts({
    store,
    range: () => range(43000, 43009, 10),
    probe: async () => { probes++; return false }
  })
  expect(await restarted.ensure('a')).toEqual({ base: 42000, count: 10 })
  expect(probes).toBe(0)
  expect(storedPortBlock(store, 'a')).toEqual({ base: 42000, count: 10 })
})
