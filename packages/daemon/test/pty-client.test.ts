import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ExitCause, PtyFact } from '@quirky/protocol'
import { createPtyApi } from '../src/plugins/pty-api'
import { PtyClient } from '../src/pty-client'
import { startFakePtyHost, type FakePtyHost } from './fixtures/fake-pty-host'
import { makeTempHome, waitFor } from './helpers'

const FAKE_HOST_MAIN = join(import.meta.dir, 'fixtures', 'fake-pty-host.ts')

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** An in-process fake host that stops itself when told to shut down, as the real host exits. */
function startStoppableHost(home: string, version?: number): FakePtyHost {
  const host: FakePtyHost = startFakePtyHost(home, { version, onShutdown: () => setTimeout(() => host.stop(), 0) })
  cleanups.push(() => host.stop())
  return host
}

function newClient(home: string, extra: { connectTimeoutMs?: number } = {}): PtyClient {
  const client = new PtyClient({ home, hostEntry: FAKE_HOST_MAIN, log: () => {}, ...extra })
  cleanups.push(() => {
    client.close()
    const pidFile = join(home, 'pty.pid')
    if (!existsSync(pidFile)) return
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')))
    } catch {
      return
    }
  })
  return client
}

function home(): string {
  const dir = makeTempHome('qp-')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('protocol version handling', () => {
  test('an older host is shut down and replaced by a current one', async () => {
    const dir = home()
    const old = startStoppableHost(dir, 1)
    const client = newClient(dir)
    await client.connect()

    expect(old.requests.map((r) => r.type)).toEqual(['hello', 'hello', 'shutdown'])
    expect(old.requests[1]).toMatchObject({ type: 'hello', version: 1 })
    expect(client.connected).toBe(true)
    expect(client.hostPid).not.toBe(process.pid)
    expect(client.hostPid).toBe(Number(readFileSync(join(dir, 'pty.pid'), 'utf8')))
  })

  test('a newer host is refused without starting another one', async () => {
    const dir = home()
    const newer = startFakePtyHost(dir, { version: 3 })
    cleanups.push(() => newer.stop())
    const client = newClient(dir, { connectTimeoutMs: 5000 })

    const started = Date.now()
    await expect(client.connect()).rejects.toThrow(
      'quirky-pty speaks protocol 3; this quirkyd speaks 2. Stop it or upgrade Quirky.'
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(existsSync(join(dir, 'pty.pid'))).toBe(false)
    expect(newer.requests.some((r) => r.type === 'shutdown')).toBe(false)
  })
})

describe('restartHost', () => {
  test('replaces the host, returns the new pid and announces the reconnect once', async () => {
    const dir = home()
    const first = startStoppableHost(dir)
    const client = newClient(dir)
    await client.connect()
    expect(client.hostPid).toBe(process.pid)
    let reconnects = 0
    client.onReconnect(() => reconnects++)

    const [a, b] = await Promise.all([client.restartHost(), client.restartHost()])

    expect(first.requests.filter((r) => r.type === 'shutdown')).toHaveLength(1)
    expect(a.pid).not.toBe(process.pid)
    expect(b).toEqual(a)
    expect(client.hostPid).toBe(a.pid)
    expect(client.connected).toBe(true)
    await Bun.sleep(300)
    expect(reconnects).toBe(1)
  })
})

describe('events through createPtyApi', () => {
  test('facts and exits reach each plugin until it is revoked', async () => {
    const dir = home()
    const host = startFakePtyHost(dir)
    cleanups.push(() => host.stop())
    const client = newClient(dir)
    await client.connect()
    const keep = createPtyApi(client, 'acme.keep')
    const drop = createPtyApi(client, 'acme.drop')

    const kept: unknown[] = []
    const dropped: unknown[] = []
    keep.api.onFact((sessionId, fact) => kept.push({ sessionId, fact }))
    keep.api.onExit((sessionId, exitCode, exit) => kept.push({ sessionId, exitCode, exit }))
    drop.api.onFact((sessionId, fact) => dropped.push({ sessionId, fact }))
    drop.api.onExit((sessionId, exitCode, exit) => dropped.push({ sessionId, exitCode, exit }))

    const bell: PtyFact = { kind: 'bell' }
    host.fact('s1', bell)
    host.exit('s1', 143, { exitSignal: 'SIGTERM', exitCause: 'killed' satisfies ExitCause })
    await waitFor(() => kept.length === 2 && dropped.length === 2)
    expect(kept).toEqual([
      { sessionId: 's1', fact: bell },
      { sessionId: 's1', exitCode: 143, exit: { exitSignal: 'SIGTERM', exitCause: 'killed' } }
    ])

    drop.revoke()
    host.fact('s2', { kind: 'cwd', cwd: '/tmp' })
    host.exit('s2', 0)
    await waitFor(() => kept.length === 4)
    expect(kept[3]).toEqual({ sessionId: 's2', exitCode: 0, exit: { exitSignal: null, exitCause: 'exited' } })
    expect(dropped).toHaveLength(2)
  })

  test('requests carry the new options and return the host results', async () => {
    const dir = home()
    const host = startFakePtyHost(dir)
    cleanups.push(() => host.stop())
    const client = newClient(dir)
    const { api } = createPtyApi(client, 'acme.opts')

    const created = await api.spawn('s1', {
      argv: ['sh'],
      cwd: '/tmp',
      env: {},
      cols: 90,
      rows: 20,
      shellReady: true,
      restore: true
    })
    expect(created).toMatchObject({ restored: false, cwd: '/tmp', cols: 90, rows: 20 })
    const subscription = await api.subscribe('s1', { mode: 'raw', historyLines: 50 })
    expect(subscription).toMatchObject({ live: true, shellState: 'pending', cols: 90, rows: 20 })
    host.setHistoryResult({ lines: ['a', 'b'], cursor: 'c1' })
    expect(await api.history('s1', { lines: 2, before: 'c0', format: 'ansi' })).toEqual({ lines: ['a', 'b'], cursor: 'c1' })
    expect((await api.snapshot('s1')).cwd).toBe('/fake/alpha')
    await api.kill('s1', 'SIGTERM', { reason: 'killed' })

    const sent = host.requests.filter((r) => r.type !== 'hello')
    expect(sent.map((r) => r.type)).toEqual(['create', 'subscribe', 'history', 'snapshot', 'kill'])
    expect(sent[0]).toMatchObject({ shellReady: true, restore: true })
    expect(sent[1]).toMatchObject({ mode: 'raw', historyLines: 50 })
    expect(sent[2]).toMatchObject({ lines: 2, before: 'c0', format: 'ansi' })
    expect(sent[4]).toMatchObject({ signal: 'SIGTERM', reason: 'killed' })
  })
})
