import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION, RpcError, RpcErrorCode, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { DaemonError } from '../src/errors'
import { createRpcHandler } from '../src/rpc-handler'
import type { ClientConn } from '../src/types'
import { makeTempHome, startHarness, waitFor, type Harness } from './helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin } from './plugins/fixtures'

let h: Harness | null = null
const extra: QuirkyClient[] = []
const scopes: ProcessScope[] = []
const scopedHomes: string[] = []
afterEach(async () => {
  let failed = false
  let firstError: unknown
  const attempt = async (action: () => void | Promise<void>) => {
    try {
      await action()
    } catch (error) {
      if (!failed) firstError = error
      failed = true
    }
  }
  for (const client of extra.splice(0)) await attempt(() => client.close())
  const harness = h
  h = null
  if (harness) await attempt(() => harness.cleanup())
  for (const scope of scopes.splice(0).reverse()) await attempt(() => scope.cleanup())
  for (const home of scopedHomes.splice(0).reverse()) {
    await attempt(() => rmSync(home, { recursive: true, force: true }))
  }
  await attempt(() => removeTempDirs())
  if (failed) throw firstError
})

const uid = process.getuid!()

async function viaSocket(harness: Harness, options: Parameters<typeof connectDaemon>[0] extends infer T ? Partial<T> : never = {}) {
  const client = await connectDaemon({
    role: 'cli',
    name: 'quirky',
    home: harness.home,
    autostart: false,
    transport: 'socket',
    ...options
  })
  extra.push(client)
  return client
}

/** Sends raw text on the daemon's socket and collects every reply line until the daemon closes it. */
async function rawExchange(path: string, lines: string[]) {
  const replies: any[] = []
  let buffer = ''
  let closed = false
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_s, chunk) {
        buffer += Buffer.from(chunk).toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          replies.push(JSON.parse(buffer.slice(0, newline)))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      },
      close() {
        closed = true
      }
    }
  })
  for (const line of lines) socket.write(`${line}\n`)
  return { replies, socket, isClosed: () => closed }
}

const hello = (token: string, id = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'client.hello', params: { role: 'cli', protocolVersion: PROTOCOL_VERSION, token } })

describe('unix socket transport', () => {
  test('SC-1: the CLI reaches the daemon over the socket named in runtime.json', async () => {
    h = await startHarness()
    expect(h.runtime.socket).toBe(join(h.home, 'quirkyd.sock'))
    expect(statSync(h.runtime.socket!).mode & 0o777).toBe(0o600)

    const client = await viaSocket(h, { identity: { cwd: '/work', sessionId: 's_1', worktreeId: 'wt_1' } })
    const status = await client.call('status.get', {})
    expect(status.clients).toContainEqual({ role: 'cli', name: 'quirky' })
    expect(status.socket).toBe(h.runtime.socket!)
    expect(await client.call('job.list', {})).toEqual([])
  })

  test('socket clients get subscribed events', async () => {
    h = await startHarness()
    const client = await viaSocket(h, { subscribe: true })
    const events: QuirkyEvent[] = []
    client.onEvent((event) => events.push(event))
    const other = await h.connect()
    await other.call('ui.sidebar.set', { visible: false })
    await waitFor(() => events.find((event) => event.type === 'ui.state.changed'))
  })

  test('the connection is removed from status when the socket closes', async () => {
    h = await startHarness()
    const watcher = await h.connect('ui', 'watcher')
    const client = await viaSocket(h, { name: 'short-lived' })
    expect((await watcher.call('status.get', {})).clients.some((c) => c.name === 'short-lived')).toBe(true)
    client.close()
    let names: (string | undefined)[] = ['short-lived']
    for (let i = 0; i < 100 && names.includes('short-lived'); i++) {
      names = (await watcher.call('status.get', {})).clients.map((c) => c.name)
      await Bun.sleep(10)
    }
    expect(names).not.toContain('short-lived')
  })

  test('SC-2: a wrong token is answered Unauthorized and the connection closes', async () => {
    h = await startHarness()
    const exchange = await rawExchange(h.runtime.socket!, [hello('wrong-token')])
    await waitFor(() => exchange.isClosed())
    expect(exchange.replies).toHaveLength(1)
    expect(exchange.replies[0]).toMatchObject({ id: 1, error: { code: RpcErrorCode.Unauthorized } })
    expect((await (await viaSocket(h)).call('status.get', {})).clients.filter((c) => c.role === 'cli')).toHaveLength(1)
  })

  test('SC-2: a missing token and a non-hello first message are refused and close', async () => {
    h = await startHarness()
    const noToken = await rawExchange(h.runtime.socket!, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'client.hello', params: { role: 'cli', protocolVersion: PROTOCOL_VERSION } })
    ])
    await waitFor(() => noToken.isClosed())
    expect(noToken.replies[0].error.code).toBe(RpcErrorCode.Unauthorized)

    const wrongMethod = await rawExchange(h.runtime.socket!, [
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'daemon.stop', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'status.get', params: {} })
    ])
    await waitFor(() => wrongMethod.isClosed())
    expect(wrongMethod.replies[0]).toMatchObject({ id: 7, error: { code: RpcErrorCode.Unauthorized } })
    expect(wrongMethod.replies.find((reply) => 'result' in reply)).toBeUndefined()
    expect(existsSync(h.runtime.socket!)).toBe(true)

    const garbage = await rawExchange(h.runtime.socket!, ['not json at all'])
    await waitFor(() => garbage.isClosed())
    expect(garbage.replies[0].error.code).toBe(RpcErrorCode.ParseError)
  })

  test('a correct hello followed immediately by calls in the same write works', async () => {
    h = await startHarness()
    const exchange = await rawExchange(h.runtime.socket!, [
      hello(h.runtime.token),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'status.get', params: {} })
    ])
    await waitFor(() => exchange.replies.length === 2)
    expect(exchange.replies[1].result.daemonVersion).toBeString()
    exchange.socket.end()
  })

  test('a line over 16 MiB closes the connection', async () => {
    h = await startHarness()
    let closed = false
    let remaining = 24 * 1024 * 1024
    const filler = Buffer.alloc(64 * 1024, 'a')
    const pump = (socket: Bun.Socket) => {
      while (remaining > 0) {
        const written = socket.write(filler.subarray(0, Math.min(filler.length, remaining)))
        if (written <= 0) return
        remaining -= written
      }
    }
    await Bun.connect({
      unix: h.runtime.socket!,
      socket: {
        open: pump,
        drain: pump,
        close() {
          closed = true
        },
        data() {}
      }
    })
    await waitFor(() => closed, 10_000)
    expect(remaining).toBeGreaterThan(0)
  })

  test('a complete line over 16 MiB is rejected even when its newline arrives in the crossing chunk', async () => {
    h = await startHarness()
    const prefix = '{"jsonrpc":"2.0","id":9,"method":"status.get","params":{"pad":"'
    const suffix = '"}}'
    const limit = 16 * 1024 * 1024
    const payload = Buffer.concat([
      Buffer.from(prefix),
      Buffer.alloc(limit + 1 - prefix.length - suffix.length, 'a'),
      Buffer.from(`${suffix}\n`)
    ])
    let offset = 0
    let closed = false
    let received = ''
    const pump = (socket: Bun.Socket) => {
      while (offset < payload.length) {
        const written = socket.write(payload.subarray(offset))
        if (written <= 0) return
        offset += written
      }
    }
    await Bun.connect({
      unix: h.runtime.socket!,
      socket: {
        open: pump,
        drain: pump,
        data(_s, chunk) {
          received += Buffer.from(chunk).toString('utf8')
        },
        close() {
          closed = true
        }
      }
    })
    await waitFor(() => closed, 10_000)
    expect(received).toBe('')
  })

  test('SC-3: a long home puts both sockets in a short private directory, and two homes differ', async () => {
    const short = makeTempHome()
    const first = join(short, 'a'.repeat(90))
    const second = join(short, 'b'.repeat(90))
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    h = await startHarness({ home: first })
    const other = await startHarness({ home: second })
    try {
      const dir = `/tmp/quirky-${uid}`
      expect(h.runtime.socket).toStartWith(`${dir}/`)
      expect(h.pty.socketPath).toStartWith(`${dir}/`)
      expect(Buffer.byteLength(h.runtime.socket!)).toBeLessThan(104)
      expect(other.runtime.socket).not.toBe(h.runtime.socket)
      expect(other.pty.socketPath).not.toBe(h.pty.socketPath)
      const stats = statSync(dir)
      expect(stats.uid).toBe(uid)
      expect(stats.mode & 0o777).toBe(0o700)

      const client = await viaSocket(h)
      expect((await client.call('status.get', {})).socket).toBe(h.runtime.socket!)
    } finally {
      await other.cleanup()
    }
  })

  test('SC-4: a stale socket file left by a killed daemon is replaced', async () => {
    const home = makeTempHome()
    const scope = createProcessScope(home)
    scopes.push(scope)
    scopedHomes.push(home)
    const path = join(home, 'quirkyd.sock')
    const orphan = scope.spawn(
      [process.execPath, '-e', 'Bun.listen({unix: process.argv[1], socket:{data(){}}}); console.log("ready"); setInterval(() => {}, 1000)', path],
      { stdout: 'pipe', stderr: 'inherit' }
    )
    await orphan.stdout.getReader().read()
    orphan.kill('SIGKILL')
    await orphan.exited
    expect(existsSync(path)).toBe(true)

    h = await startHarness({ home })
    expect(h.runtime.socket).toBe(path)
    const client = await viaSocket(h)
    expect((await client.call('status.get', {})).socket).toBe(path)
  })

  test('SC-5: a plugin stream method over the socket is refused', async () => {
    const home = makeTempHome()
    writeModulePlugin(
      join(home, 'plugins'),
      join(makeTempDir(), 'marker.log'),
      { id: 'acme.stream', contributes: { method: [{ id: 'open', connection: true, params: { type: 'object' } }] } },
      { activate: "context.provide('method:acme.stream/open', async (_params, caller) => { caller.connection.openStream(); return {} })" }
    )
    h = await startHarness({ home })
    const client = await viaSocket(h)
    const error = (await client.callAny('acme.stream/open', {}).catch((e) => e)) as RpcError
    expect(error).toBeInstanceOf(RpcError)
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toBe('this method needs the WebSocket transport')
  })

  test('stopping the daemon removes the socket file', async () => {
    h = await startHarness()
    const path = h.runtime.socket!
    await h.daemon.stop()
    expect(existsSync(path)).toBe(false)
  })
})

describe('request ids', () => {
  test('a bad requestId is InvalidRequest on both transports; a good one runs', async () => {
    h = await startHarness()
    const clients = [await viaSocket(h), await h.connect()]
    for (const client of clients) {
      for (const requestId of ['', 'r'.repeat(129)]) {
        const error = (await client.call('status.get', {}, { requestId }).catch((e) => e)) as RpcError
        expect(error).toBeInstanceOf(RpcError)
        expect(error.code).toBe(RpcErrorCode.InvalidRequest)
      }
      expect((await client.call('status.get', {}, { requestId: 'r'.repeat(128) })).pid).toBe(process.pid)
    }
  })

  test('a non-string requestId is InvalidRequest', async () => {
    h = await startHarness()
    const exchange = await rawExchange(h.runtime.socket!, [
      hello(h.runtime.token),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'status.get', params: {}, requestId: 5 })
    ])
    await waitFor(() => exchange.replies.length === 2)
    expect(exchange.replies[1].error.code).toBe(RpcErrorCode.InvalidRequest)
    exchange.socket.end()
  })
})

describe('rpc handler', () => {
  function stubConn(transport: ClientConn['transport'] = 'websocket') {
    const sent: any[] = []
    const conn: ClientConn = {
      id: 1,
      role: 'cli',
      subscribed: false,
      closed: false,
      transport,
      streams: new Map(),
      streamClosers: new Map(),
      nextStreamId: 1,
      sendText: (text) => sent.push(JSON.parse(text)),
      sendBinary: () => {}
    }
    return { conn, sent }
  }

  test('passes requestId to the dispatcher and sends error data', async () => {
    const calls: unknown[][] = []
    const handler = createRpcHandler({
      rpcToken: 'tok',
      log: () => {},
      dispatcher: {
        async dispatch(...args) {
          calls.push(args.slice(0, 2).concat(args[3]))
          throw new DaemonError(RpcErrorCode.ConfirmationRequired, 'confirmation required: x', { askId: 'a1' })
        }
      }
    })
    const { conn, sent } = stubConn()
    await handler(conn, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'x/y', params: { a: 1 }, requestId: 'req-1' }))
    expect(calls).toEqual([['x/y', { a: 1 }, { requestId: 'req-1' }]])
    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: RpcErrorCode.ConfirmationRequired, message: 'confirmation required: x', data: { askId: 'a1' } }
    })
  })

  test('a request without a requestId reaches the dispatcher with no options', async () => {
    let received: unknown = 'unset'
    const handler = createRpcHandler({
      rpcToken: 'tok',
      log: () => {},
      dispatcher: {
        async dispatch(_m, _p, _f, options) {
          received = options
          return null
        }
      }
    })
    const { conn, sent } = stubConn()
    await handler(conn, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status.get' }))
    expect(received).toBeUndefined()
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, result: null })
  })
})
