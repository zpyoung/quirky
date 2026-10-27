import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PTY_PROTOCOL_VERSION, PtyFrameDecoder, encodePtyJson, type ExitCause, type PtyFact, type PtyRequest } from '@quirky/protocol'
import { socketPath } from '@quirky/protocol/node'
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

function newClient(home: string, extra: { connectTimeoutMs?: number; shutdownWaitMs?: number } = {}): PtyClient {
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

/** A host that answers hello at `version`, then accepts shutdown without ever replying or closing. */
function startSilentHost(dir: string, version: number): { shutdowns: () => number } {
  mkdirSync(dir, { recursive: true })
  const path = socketPath(dir, 'pty.sock')
  rmSync(path, { force: true })
  writeFileSync(join(dir, 'pty.token'), 'tok', { mode: 0o600 })
  let shutdowns = 0
  const decoders = new WeakMap<object, PtyFrameDecoder>()
  const listener = Bun.listen<undefined>({
    unix: path,
    socket: {
      data(socket, chunk) {
        const decoder = decoders.get(socket) ?? new PtyFrameDecoder()
        decoders.set(socket, decoder)
        for (const frame of decoder.push(new Uint8Array(chunk))) {
          if (frame.kind !== 'json') continue
          const request = frame.message as PtyRequest
          if (request.type === 'hello') {
            const body =
              request.version === version
                ? { id: request.id, ok: true, result: { version, pid: process.pid } }
                : { id: request.id, ok: false, error: `unsupported protocol version ${request.version}, host speaks ${version}` }
            socket.write(encodePtyJson(body))
          } else if (request.type === 'shutdown') {
            shutdowns++
          }
        }
      }
    }
  })
  cleanups.push(() => {
    listener.stop(true)
    rmSync(path, { force: true })
  })
  return { shutdowns: () => shutdowns }
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

  test('a protocol 2 host is retired and replaced by a protocol 3 one', async () => {
    const dir = home()
    const old = startStoppableHost(dir, 2)
    const client = newClient(dir)
    await client.connect()

    expect(PTY_PROTOCOL_VERSION).toBe(3)
    expect(old.requests.map((r) => r.type)).toEqual(['hello', 'hello', 'shutdown'])
    expect(old.requests[1]).toMatchObject({ type: 'hello', version: 2 })
    expect(client.connected).toBe(true)
    expect(client.hostPid).not.toBe(process.pid)
  })

  test('a newer host is refused without starting another one', async () => {
    const dir = home()
    const newer = startFakePtyHost(dir, { version: 4 })
    cleanups.push(() => newer.stop())
    const client = newClient(dir, { connectTimeoutMs: 5000 })

    const started = Date.now()
    await expect(client.connect()).rejects.toThrow(
      'quirky-pty speaks protocol 4; this quirkyd speaks 3. Stop it or upgrade Quirky.'
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

describe('a host that accepts shutdown but never replies or closes', () => {
  test('restartHost gives up within the wait and drops the connection', async () => {
    const dir = home()
    const silent = startSilentHost(dir, PTY_PROTOCOL_VERSION)
    const client = newClient(dir, { shutdownWaitMs: 100 })
    await client.connect()

    const started = Date.now()
    await expect(client.restartHost()).rejects.toThrow('quirky-pty did not stop after shutdown')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(silent.shutdowns()).toBe(1)
    expect(client.connected).toBe(false)
  })

  test('retiring an older host gives up within the wait so a current host can take over', async () => {
    const dir = home()
    const silent = startSilentHost(dir, 1)
    const client = newClient(dir, { shutdownWaitMs: 100 })

    const started = Date.now()
    await client.connect()

    expect(Date.now() - started).toBeLessThan(5000)
    expect(silent.shutdowns()).toBe(1)
    expect(client.connected).toBe(true)
    expect(client.hostPid).not.toBe(process.pid)
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

  test('read forwards unwrap to the host only when it is true', async () => {
    const dir = home()
    const host = startFakePtyHost(dir)
    cleanups.push(() => host.stop())
    const client = newClient(dir)
    const { api } = createPtyApi(client, 'acme.unwrap')
    await api.spawn('s1', { argv: ['sh'], cwd: '/tmp', env: {}, cols: 80, rows: 24 })

    await api.read('s1', 5)
    await api.read('s1', 6, { unwrap: false })
    await api.read('s1', 7, { unwrap: true })

    const reads = host.requests.filter((r) => r.type === 'read')
    expect(reads).toEqual([
      { id: expect.any(Number), type: 'read', sessionId: 's1', lines: 5 },
      { id: expect.any(Number), type: 'read', sessionId: 's1', lines: 6 },
      { id: expect.any(Number), type: 'read', sessionId: 's1', lines: 7, unwrap: true }
    ])
  })

  test('SC-34: clear and resetModes go to the host by session id and reject for an unknown one', async () => {
    const dir = home()
    const host = startFakePtyHost(dir)
    cleanups.push(() => host.stop())
    const client = newClient(dir)
    const { api, revoke } = createPtyApi(client, 'acme.clear')
    await api.spawn('s1', { argv: ['sh'], cwd: '/tmp', env: {}, cols: 80, rows: 24 })

    await expect(api.clear('s1')).resolves.toBeUndefined()
    await expect(api.resetModes('s1')).resolves.toBeUndefined()
    await expect(api.clear('ghost')).rejects.toThrow('unknown session: ghost')
    await expect(api.resetModes('ghost')).rejects.toThrow('unknown session: ghost')

    expect(host.requests.filter((r) => r.type === 'clear' || r.type === 'resetModes')).toEqual([
      { id: expect.any(Number), type: 'clear', sessionId: 's1' },
      { id: expect.any(Number), type: 'resetModes', sessionId: 's1' },
      { id: expect.any(Number), type: 'clear', sessionId: 'ghost' },
      { id: expect.any(Number), type: 'resetModes', sessionId: 'ghost' }
    ])
    revoke()
    await expect(api.clear('s1')).rejects.toThrow()
  })
})
