import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionLost, QuirkyClient, RpcError } from '../src'

type Handler = (request: any, reply: (message: unknown) => void, socket: Bun.Socket<{ buffer: string }>) => void

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

/** A newline-delimited JSON-RPC server on a temp unix socket; `seen` records every request. */
function fakeDaemon(handler: Handler) {
  const dir = mkdtempSync(join(tmpdir(), 'qsc-'))
  const path = join(dir, 'd.sock')
  const seen: any[] = []
  const sockets = new Set<Bun.Socket<{ buffer: string }>>()
  const listener = Bun.listen<{ buffer: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buffer: '' }
        sockets.add(socket)
      },
      data(socket, chunk) {
        socket.data.buffer += Buffer.from(chunk).toString('utf8')
        let newline = socket.data.buffer.indexOf('\n')
        while (newline !== -1) {
          const line = socket.data.buffer.slice(0, newline)
          socket.data.buffer = socket.data.buffer.slice(newline + 1)
          const request = JSON.parse(line)
          seen.push(request)
          handler(request, (message) => socket.write(`${JSON.stringify(message)}\n`), socket)
          newline = socket.data.buffer.indexOf('\n')
        }
      },
      close(socket) {
        sockets.delete(socket)
      }
    }
  })
  cleanups.push(() => {
    listener.stop(true)
    for (const socket of sockets) socket.end()
    rmSync(dir, { recursive: true, force: true })
  })
  return { path, seen, sockets }
}

/** A Unix peer that records accepted clients but deliberately never answers hello. */
function silentDaemon() {
  const dir = mkdtempSync(join(tmpdir(), 'qsc-silent-'))
  const path = join(dir, 'd.sock')
  const sockets = new Set<Bun.Socket<{ buffer: string }>>()
  const helloSeen = Promise.withResolvers<void>()
  let accepted = 0
  let closed = 0
  const closeWaiters = new Map<number, () => void>()
  const listener = Bun.listen<{ buffer: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buffer: '' }
        sockets.add(socket)
        accepted++
      },
      data(socket, chunk) {
        socket.data.buffer += Buffer.from(chunk).toString('utf8')
        let newline = socket.data.buffer.indexOf('\n')
        while (newline !== -1) {
          const line = socket.data.buffer.slice(0, newline)
          socket.data.buffer = socket.data.buffer.slice(newline + 1)
          if (JSON.parse(line).method === 'client.hello') helloSeen.resolve()
          newline = socket.data.buffer.indexOf('\n')
        }
      },
      close(socket) {
        sockets.delete(socket)
        closed++
        closeWaiters.get(closed)?.()
      }
    }
  })
  cleanups.push(() => {
    listener.stop(true)
    for (const socket of sockets) socket.terminate()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    path,
    sockets,
    helloSeen: helloSeen.promise,
    accepted: () => accepted,
    waitForCloses(count: number): Promise<void> {
      if (closed >= count) return Promise.resolve()
      return new Promise((resolve) => closeWaiters.set(count, resolve))
    }
  }
}

async function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}


const ok = (id: number, result: unknown) => ({ jsonrpc: '2.0', id, result })

const helloOk: Handler = (request, reply) => {
  if (request.method === 'client.hello') reply(ok(request.id, { protocolVersion: 2, daemonVersion: 't' }))
}

describe('QuirkyClient.connectSocket', () => {
  test('SC-1: hello carries the token and identity before anything else', async () => {
    const daemon = fakeDaemon(helloOk)
    const client = await QuirkyClient.connectSocket(daemon.path, {
      role: 'cli',
      name: 'quirky',
      token: 'tok',
      sessionToken: 'session-secret',
      cwd: '/work',
      sessionId: 's_1',
      worktreeId: 'w_1'
    })
    expect(daemon.seen).toHaveLength(1)
    expect(daemon.seen[0]).toMatchObject({
      method: 'client.hello',
      params: { role: 'cli', name: 'quirky', token: 'tok', sessionToken: 'session-secret', cwd: '/work', sessionId: 's_1', worktreeId: 'w_1' }
    })
    client.close()
  })

  test('calls round-trip and a requestId is placed top-level on the request', async () => {
    const daemon = fakeDaemon((request, reply, socket) => {
      helloOk(request, reply, socket)
      if (request.method === 'echo') reply(ok(request.id, request.params))
    })
    const client = await QuirkyClient.connectSocket(daemon.path, { role: 'cli', token: 't' })
    expect(await client.callAny('echo', { a: 1 }, { requestId: 'r-1' })).toEqual({ a: 1 })
    await client.callAny('echo', {})
    const withId = daemon.seen.find((r) => r.method === 'echo' && r.requestId)
    expect(withId.requestId).toBe('r-1')
    expect(withId.params).toEqual({ a: 1 })
    expect('requestId' in daemon.seen[daemon.seen.length - 1]).toBe(false)
    client.close()
  })

  test('an error reply rejects with RpcError carrying code and data', async () => {
    const daemon = fakeDaemon((request, reply, socket) => {
      helloOk(request, reply, socket)
      if (request.method === 'boom') {
        reply({ jsonrpc: '2.0', id: request.id, error: { code: -32010, message: 'confirm', data: { askId: 'a1' } } })
      }
    })
    const client = await QuirkyClient.connectSocket(daemon.path, { role: 'cli', token: 't' })
    const error = (await client.callAny('boom', {}).catch((e) => e)) as RpcError
    expect(error).toBeInstanceOf(RpcError)
    expect(error).not.toBeInstanceOf(ConnectionLost)
    expect(error.code).toBe(-32010)
    expect(error.data).toEqual({ askId: 'a1' })
    client.close()
  })

  test('events reach onEvent and subscribe sends events.subscribe after hello', async () => {
    const daemon = fakeDaemon((request, reply, socket) => {
      helloOk(request, reply, socket)
      if (request.method === 'events.subscribe') {
        reply(ok(request.id, { ok: true }))
        const event = { jsonrpc: '2.0', method: 'event', params: { type: 'plugin.changed', pluginId: 'p' } }
        setTimeout(() => socket.write(`${JSON.stringify(event)}\n`), 20)
      }
    })
    const received: unknown[] = []
    const client = await QuirkyClient.connectSocket(daemon.path, { role: 'cli', token: 't', subscribe: true })
    client.onEvent((event) => received.push(event))
    expect(daemon.seen.map((r) => r.method)).toEqual(['client.hello', 'events.subscribe'])
    await Bun.sleep(80)
    expect(received).toEqual([{ type: 'plugin.changed', pluginId: 'p' }])
    client.close()
  })

  test('a reply split across chunks is reassembled', async () => {
    const daemon = fakeDaemon((request, reply, socket) => {
      helloOk(request, reply, socket)
      if (request.method === 'big') {
        const text = JSON.stringify(ok(request.id, { data: 'x'.repeat(4_000) }))
        socket.write(`${text.slice(0, 1000)}`)
        setTimeout(() => socket.write(`${text.slice(1000)}\n`), 10)
      }
    })
    const client = await QuirkyClient.connectSocket(daemon.path, { role: 'cli', token: 't' })
    const result = (await client.callAny('big', {})) as { data: string }
    expect(result.data.length).toBe(4_000)
    client.close()
  })

  test('a request larger than the socket buffer is written in full', async () => {
    const daemon = fakeDaemon((request, reply, socket) => {
      helloOk(request, reply, socket)
      if (request.method === 'size') reply(ok(request.id, { length: request.params.data.length }))
    })
    const client = await QuirkyClient.connectSocket(daemon.path, { role: 'cli', token: 't' })
    expect(await client.callAny('size', { data: 'y'.repeat(5_000_000) })).toEqual({ length: 5_000_000 })
    client.close()
  })

  test('a dropped connection rejects pending calls with ConnectionLost and fires onClose', async () => {
    const daemon = fakeDaemon((request, reply, socket) => {
      helloOk(request, reply, socket)
      if (request.method === 'hang') socket.end()
    })
    const client = await QuirkyClient.connectSocket(daemon.path, { role: 'cli', token: 't' })
    let closed = 0
    client.onClose(() => closed++)
    const error = await client.callAny('hang', {}).catch((e) => e)
    expect(error).toBeInstanceOf(ConnectionLost)
    expect(error).not.toBeInstanceOf(RpcError)
    expect(closed).toBe(1)
    expect(client.isClosed).toBe(true)
    expect(await client.callAny('later', {}).catch((e) => e)).toBeInstanceOf(ConnectionLost)
  })

  test('a refused hello rejects with the daemon error and closes', async () => {
    const daemon = fakeDaemon((request, reply, socket) => {
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'bad token' } })
      socket.end()
    })
    const error = await QuirkyClient.connectSocket(daemon.path, { role: 'cli', token: 'wrong' }).catch((e) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error.message).toBe('bad token')
  })
  test('a timed-out call releases its pending slot and ignores the late reply', async () => {
    // Real socket I/O cannot be driven by fake timers; this verifies deadline ordering against the platform clock.
    const daemon = fakeDaemon((request, reply, socket) => {
      helloOk(request, reply, socket)
      if (request.method === 'slow') setTimeout(() => reply(ok(request.id, { late: true })), 30)
      if (request.method === 'fast') reply(ok(request.id, { fast: true }))
    })
    const client = await QuirkyClient.connectSocket(daemon.path, { role: 'cli', token: 't' })
    await expect(client.callAny('slow', {}, { timeoutMs: 5 })).rejects.toThrow('RPC call timed out after 5 ms')
    await Bun.sleep(40)
    expect(await client.callAny('fast', {})).toEqual({ fast: true })
    client.close()
  })


  test('an already-aborted signal rejects without opening a Unix socket', async () => {
    const daemon = silentDaemon()
    const controller = new AbortController()
    controller.abort()
    const connecting = QuirkyClient.connectSocket(daemon.path, { role: 'cli' }, { signal: controller.signal })
    const outcome = await Promise.race([
      connecting.then((client) => { client.close(); return 'resolved' as const }, () => 'rejected' as const),
      Bun.sleep(250).then(() => 'pending' as const)
    ])
    expect(outcome).toBe('rejected')
    expect(daemon.accepted()).toBe(0)
  })

  test('aborting during hello closes the raw socket while the silent peer stays alive', async () => {
    const daemon = silentDaemon()
    const controller = new AbortController()
    const connecting = QuirkyClient.connectSocket(daemon.path, { role: 'cli' }, { signal: controller.signal })
    await waitWithin(daemon.helloSeen, 1_000)
    controller.abort()
    const outcome = await Promise.race([
      connecting.then((client) => { client.close(); return 'resolved' as const }, () => 'rejected' as const),
      Bun.sleep(250).then(() => 'pending' as const)
    ])
    expect(outcome).toBe('rejected')
    await waitWithin(daemon.waitForCloses(1), 1_000)
    expect(daemon.sockets.size).toBe(0)

    const probe = await Bun.connect<undefined>({ unix: daemon.path, socket: { data() {} } })
    probe.end()
    await waitWithin(daemon.waitForCloses(2), 1_000)
    expect(daemon.accepted()).toBe(2)
    expect(daemon.sockets.size).toBe(0)
  })

  test('aborting after hello completion does not close the established client', async () => {
    const daemon = fakeDaemon((request, reply, socket) => {
      helloOk(request, reply, socket)
      if (request.method === 'echo') reply(ok(request.id, request.params))
    })
    const controller = new AbortController()
    const client = await QuirkyClient.connectSocket(daemon.path, { role: 'cli' }, { signal: controller.signal })
    controller.abort()
    expect(await client.callAny('echo', { alive: true })).toEqual({ alive: true })
    client.close()
  })

  test('connecting to a path with no listener fails with a message naming the path', async () => {
    const error = await QuirkyClient.connectSocket('/tmp/qsc-nonexistent.sock', { role: 'cli' }).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('/tmp/qsc-nonexistent.sock')
  })
})
