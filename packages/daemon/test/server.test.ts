import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeTerminalLagged, encodeTerminalOutput, HOOK_TOKEN_HEADER, PROTOCOL_VERSION, RPC_PATH, RpcError, RpcErrorCode } from '@quirky/protocol'
import { readRuntime } from '@quirky/protocol/node'
import { openStream } from '../src/plugins/streams'
import type { FileResourceRegistry } from '../src/file-resources'
import { startServer } from '../src/server'
import type { Core } from '../src/service'
import { WebSocketOutput, type WebSocketOutputSocket } from '../src/websocket-output'
import type { ClientConn } from '../src/types'
import { makeTempHome, startHarness, writeUiFixture, type Harness } from './helpers'
import { writeModulePlugin } from './plugins/fixtures'
import type { ServerOptions } from '../src/server'

let harness: Harness
beforeAll(async () => {
  harness = await startHarness()
})
afterAll(async () => {
  await harness.cleanup()
})

function url(h: Harness, path: string) {
  return `http://127.0.0.1:${h.runtime.port}${path}`
}
const STREAM_LIMIT = 4 * 1024 * 1024
const BINARY_LIMIT = 8 * 1024 * 1024
const CONTROL_LIMIT = 16 * 1024 * 1024

type OutputCall =
  | { kind: 'text'; value: string; compress?: boolean }
  | { kind: 'binary'; value: Uint8Array; compress?: boolean }

function wireBytes(payloadBytes: number): number {
  return payloadBytes + (payloadBytes < 126 ? 2 : payloadBytes < 65_536 ? 4 : 10)
}
function controlQueueStorageSlots(output: WebSocketOutput): number {
  const controls: unknown = Reflect.get(output, 'controls')
  if (Array.isArray(controls)) return controls.length
  let current: unknown = Reflect.get(output, 'firstControl')
  let slots = 0
  while (current !== null && typeof current === 'object') {
    if (!('next' in current)) throw new Error('invalid pending control queue node')
    slots++
    current = current.next
  }
  if (current !== null) throw new Error('invalid pending control queue head')
  return slots
}

function deferredControlBytes(output: WebSocketOutput): number {
  const bytes: unknown = Reflect.get(output, 'pendingControlBytes')
  if (typeof bytes !== 'number') throw new Error('invalid pending control byte count')
  return bytes
}

class FakeOutputSocket implements WebSocketOutputSocket {
  readyState = 1
  bufferedAmount = 0
  readonly calls: OutputCall[] = []
  readonly accepted: OutputCall[] = []
  readonly wireFifo: number[] = []
  readonly results: number[] = []
  autoDrainTo: number | undefined
  throwOnSend = false

  getBufferedAmount(): number {
    return this.bufferedAmount
  }

  send(text: string, compress?: boolean): number {
    const call: OutputCall = { kind: 'text', value: text, compress }
    this.calls.push(call)
    return this.accept(call, wireBytes(Buffer.byteLength(text, 'utf8')))
  }

  sendBinary(bytes: Uint8Array, compress?: boolean): number {
    const call: OutputCall = { kind: 'binary', value: bytes, compress }
    this.calls.push(call)
    return this.accept(call, wireBytes(bytes.byteLength))
  }

  drain(bytes = this.bufferedAmount): void {
    let remaining = Math.min(bytes, this.bufferedAmount)
    const drained = remaining
    while (remaining > 0) {
      const head = this.wireFifo[0]
      if (head <= remaining) {
        remaining -= head
        this.wireFifo.shift()
      } else {
        this.wireFifo[0] = head - remaining
        remaining = 0
      }
    }
    this.bufferedAmount -= drained
  }

  private accept(call: OutputCall, wireLength: number): number {
    if (this.throwOnSend) throw new Error('send failed')
    const result = this.results.shift() ?? 1
    if (result !== 0) {
      this.accepted.push(call)
      this.wireFifo.push(wireLength)
      this.bufferedAmount += wireLength
      if (this.autoDrainTo !== undefined && this.bufferedAmount > this.autoDrainTo) {
        this.drain(this.bufferedAmount - this.autoDrainTo)
      }
    }
    return result
  }
}

type FakeNativeSocket = FakeOutputSocket & { data: unknown; close(code: number, reason?: string): void }
type CapturedStartServerOptions = {
  fetch(
    request: Request,
    server: { upgrade(request: Request, options: { data: unknown }): boolean }
  ): Promise<Response | undefined>
  websocket: {
    backpressureLimit?: number
    closeOnBackpressureLimit?: boolean
    perMessageDeflate?: boolean
    open(socket: FakeNativeSocket): void
    message(socket: FakeNativeSocket, message: string): void
    drain(socket: FakeNativeSocket): void
    close(socket: FakeNativeSocket, code: number, reason: string): void
  }
}

test('startServer wires native WebSocket sends, budgets, drain, and once-only cleanup', async () => {
  let captured: CapturedStartServerOptions | undefined
  const mutableBun = Bun as unknown as { serve: typeof Bun.serve }
  const originalServe = mutableBun.serve
  mutableBun.serve = ((serveOptions: unknown) => {
    captured = serveOptions as CapturedStartServerOptions
    return {} as never
  }) as typeof Bun.serve

  let connection: ClientConn | undefined
  let socketData: unknown
  let removed = 0
  const handled: string[] = []
  const core = {
    addClient(conn: ClientConn) {
      connection = conn
    },
    removeClient(conn: ClientConn) {
      removed++
      conn.closed = true
      for (const close of [...conn.streamClosers.values()]) close()
    }
  } as unknown as Core

  try {
    startServer({
      core,
      handle: async (_conn, message) => { handled.push(message) },
      port: 0,
      rpcToken: 'token',
      daemonVersion: 'test',
      uiDir: '/no-ui',
      pluginFile: () => null,
      fileResources: { serve: () => new Response(null, { status: 404 }) } as unknown as FileResourceRegistry,
      log: () => {}
    })
    if (!captured) throw new Error('startServer did not configure Bun.serve')

    const dataOptions = await captured.fetch(
      new Request('http://127.0.0.1/rpc?token=token'),
      {
        upgrade(_request: Request, upgradeOptions: { data: unknown }) {
          socketData = upgradeOptions.data
          return true
        }
      }
    )
    expect(dataOptions).toBeUndefined()
    expect(captured.websocket.backpressureLimit).toBe(CONTROL_LIMIT)
    expect(captured.websocket.closeOnBackpressureLimit).toBe(false)
    expect(captured.websocket.perMessageDeflate).toBe(false)

    const socket = new FakeOutputSocket()
    const closed: number[] = []
    const ws: FakeNativeSocket = Object.assign(socket, {
      data: socketData,
      close(code: number) {
        closed.push(code)
        socket.readyState = 3
      }
    })
    captured.websocket.open(ws)
    if (!connection) throw new Error('startServer did not attach the upgraded connection')
    const stream = openStream(connection)
    let streamLags = 0
    stream.onLag?.(() => streamLags++)
    expect(stream.send(new Uint8Array(STREAM_LIMIT - 15))).toBe(true)
    expect(stream.send(new Uint8Array([1]))).toBe(false)
    expect(stream.lagged).toBe(true)
    expect(streamLags).toBe(1)
    connection.sendText('hello')
    expect(socket.calls.every((call) => call.compress === false)).toBe(true)
    expect(typeof connection.closeStreamOutput).toBe('function')

    socket.results.push(0)
    connection.sendText('deferred control')
    const callsBeforeDrain = socket.calls.length
    captured.websocket.drain(ws)
    captured.websocket.message(ws, 'late RPC')
    socket.readyState = 3
    connection.sendText('closed peer')
    captured.websocket.close(ws, 1013, 'failed')
    captured.websocket.close(ws, 1000, 'closed again')
    await Promise.resolve()

    expect(socket.calls).toHaveLength(callsBeforeDrain)
    expect(handled).toEqual([])
    expect(removed).toBe(1)
    expect(closed).toEqual([1013])
    expect(stream.send(new Uint8Array([2]))).toBe(false)
  } finally {
    mutableBun.serve = originalServe
  }
})

describe('WebSocketOutput', () => {
  test('reconciles continuous progress before admission and maintains a wire-byte FIFO', () => {
    const socket = new FakeOutputSocket()
    socket.autoDrainTo = 65_541
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })
    const payload = new Uint8Array(65_536)

    for (let i = 0; i < 128; i++) {
      expect(output.sendBinary(encodeTerminalOutput(1, payload))).toBe(true)
    }

    expect(socket.calls).toHaveLength(128)
    expect(socket.bufferedAmount).toBe(65_541)
    expect(socket.wireFifo).toEqual([65_541])

    socket.autoDrainTo = undefined
    const remaining = STREAM_LIMIT - socket.bufferedAmount
    expect(output.sendBinary(encodeTerminalOutput(1, new Uint8Array(remaining - 15)))).toBe(true)
    expect(socket.bufferedAmount).toBe(STREAM_LIMIT)
    const before = socket.calls.length
    expect(output.sendBinary(encodeTerminalOutput(1, new Uint8Array(1)))).toBe(false)
    expect(socket.calls).toHaveLength(before)
    expect(socket.wireFifo.reduce((total, bytes) => total + bytes, 0)).toBe(socket.bufferedAmount)
  })

  test('admits exact stream and connection limits but keeps accepted bytes after stream close', () => {
    const socket = new FakeOutputSocket()
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })
    const fullStream = (streamId: number) => encodeTerminalOutput(streamId, new Uint8Array(STREAM_LIMIT - 15))

    expect(output.sendBinary(fullStream(1))).toBe(true)
    expect(socket.bufferedAmount).toBe(STREAM_LIMIT)
    const submitted = socket.calls.length
    expect(output.sendBinary(encodeTerminalOutput(1, new Uint8Array(1)))).toBe(false)
    expect(socket.calls).toHaveLength(submitted)

    output.closeStream(1)
    expect(socket.bufferedAmount).toBe(STREAM_LIMIT)
    expect(output.sendBinary(fullStream(2))).toBe(true)
    expect(socket.bufferedAmount).toBe(BINARY_LIMIT)
    const atConnectionLimit = socket.calls.length
    expect(output.sendBinary(encodeTerminalOutput(3, new Uint8Array(1)))).toBe(false)
    expect(socket.calls).toHaveLength(atConnectionLimit)
    expect(socket.wireFifo.reduce((total, bytes) => total + bytes, 0)).toBe(BINARY_LIMIT)
  })
  test('rejects a single frame that exceeds the per-stream wire budget before sending', () => {
    const socket = new FakeOutputSocket()
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })

    expect(output.sendBinary(encodeTerminalOutput(9, new Uint8Array(STREAM_LIMIT - 14)))).toBe(false)
    expect(socket.calls).toHaveLength(0)
  })


  test('reconciles partial drainage across UTF-8 text and alternating binary streams', () => {
    const socket = new FakeOutputSocket()
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })
    const json = JSON.stringify({ output: 'é🚀' })
    const textWire = wireBytes(Buffer.byteLength(json, 'utf8'))

    expect(output.sendBinary(encodeTerminalOutput(11, new Uint8Array(STREAM_LIMIT - 19)))).toBe(true)
    output.sendText(json)
    expect(socket.bufferedAmount).toBe(STREAM_LIMIT - 4 + textWire)
    expect(socket.wireFifo).toEqual([STREAM_LIMIT - 4, textWire])
    expect(output.sendBinary(encodeTerminalOutput(11, new Uint8Array(1)))).toBe(false)

    socket.drain(STREAM_LIMIT - 4)
    output.drain()
    expect(socket.bufferedAmount).toBe(textWire)
    expect(socket.wireFifo).toEqual([textWire])
    expect(output.sendBinary(encodeTerminalOutput(11, new Uint8Array(STREAM_LIMIT - 15)))).toBe(true)
    expect(socket.bufferedAmount).toBe(STREAM_LIMIT + textWire)
    expect(socket.wireFifo.at(-1)).toBe(STREAM_LIMIT)
    expect(output.sendBinary(encodeTerminalOutput(12, new Uint8Array(1)))).toBe(true)
    expect(socket.wireFifo.at(-1)).toBe(8)
  })

  test('treats positive and -1 as accepted exactly once and zero as rejected output', () => {
    const socket = new FakeOutputSocket()
    socket.results.push(15, -1, 0)
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })
    const frame = encodeTerminalOutput(1, new Uint8Array([1]))

    expect(output.sendBinary(frame)).toBe(true)
    expect(output.sendBinary(frame)).toBe(true)
    expect(output.sendBinary(frame)).toBe(false)
    expect(socket.calls).toHaveLength(3)
    expect(socket.accepted).toHaveLength(2)
    expect(socket.wireFifo).toEqual([wireBytes(frame.byteLength), wireBytes(frame.byteLength)])
    output.drain()
    expect(socket.calls).toHaveLength(3)
  })

  test('defers text and lag markers in FIFO order and rejects output behind them', () => {
    const socket = new FakeOutputSocket()
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })
    output.sendBinary(encodeTerminalOutput(1, new Uint8Array([1])))
    socket.results.push(0)
    output.sendText('first')
    expect(output.sendBinary(encodeTerminalLagged(1))).toBe(true)
    output.sendText('second')
    const callsBeforeReject = socket.calls.length
    expect(output.sendBinary(encodeTerminalOutput(2, new Uint8Array([2])))).toBe(false)
    expect(socket.calls).toHaveLength(callsBeforeReject)

    socket.results.push(31, -1, 41)
    output.drain()

    expect(socket.accepted.map((call) => call.kind === 'text' ? call.value : call.value[0])).toEqual([
      1,
      'first',
      2,
      'second'
    ])
    expect(socket.accepted[1]).toMatchObject({ kind: 'text', value: 'first', compress: false })
    expect(socket.accepted[2]).toMatchObject({ kind: 'binary', compress: false })
    expect(socket.accepted[3]).toMatchObject({ kind: 'text', value: 'second', compress: false })
  })

  test('rejects controls beyond an exactly full deferred-control cap', () => {
    const socket = new FakeOutputSocket()
    let failures = 0
    const output = new WebSocketOutput(socket, () => failures++)
    output.sendBinary(encodeTerminalOutput(1, new Uint8Array([1])))
    socket.results.push(0)
    output.sendText('x'.repeat(CONTROL_LIMIT - 10))
    expect(failures).toBe(0)
    const callsAtCap = socket.calls.length

    output.sendText('x')

    expect(failures).toBe(1)
    expect(socket.calls).toHaveLength(callsAtCap)
  })
  test('counts deferred lag markers toward the control cap', () => {
    const socket = new FakeOutputSocket()
    let failures = 0
    const output = new WebSocketOutput(socket, () => failures++)
    output.sendBinary(encodeTerminalOutput(1, new Uint8Array([1])))
    socket.results.push(0)
    output.sendText('x'.repeat(CONTROL_LIMIT - 16))

    expect(output.sendBinary(encodeTerminalLagged(7))).toBe(false)
    expect(failures).toBe(1)
    expect(socket.calls).toHaveLength(2)
  })

  test('closes when a control frame can never fit or a zero send has no drain path', () => {
    const impossibleSocket = new FakeOutputSocket()
    let impossibleFailures = 0
    const impossible = new WebSocketOutput(impossibleSocket, () => impossibleFailures++)
    impossible.sendText('x'.repeat(CONTROL_LIMIT))
    expect(impossibleSocket.calls).toHaveLength(0)
    expect(impossibleFailures).toBe(1)

    const stalledSocket = new FakeOutputSocket()
    stalledSocket.results.push(0)
    let stalledFailures = 0
    const stalled = new WebSocketOutput(stalledSocket, () => stalledFailures++)
    stalled.sendText('control')
    expect(stalledFailures).toBe(1)
    expect(stalledSocket.calls).toHaveLength(1)
  })

  test('cancels a deferred lag marker without removing already accepted stream bytes', () => {
    const socket = new FakeOutputSocket()
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })
    const frame = encodeTerminalOutput(7, new Uint8Array([1]))
    output.sendBinary(frame)
    socket.results.push(0)
    output.sendBinary(encodeTerminalLagged(7))
    const acceptedBytes = socket.bufferedAmount
    output.closeStream(7)
    socket.results.push(2)
    output.drain()

    expect(socket.bufferedAmount).toBe(acceptedBytes)
    expect(socket.accepted).toHaveLength(1)
    expect(socket.calls.filter((call) => call.kind === 'binary')).toHaveLength(2)
  })
  test('bounds storage while drain alternates one accepted and one deferred control', () => {
    const socket = new FakeOutputSocket()
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })
    output.sendBinary(encodeTerminalOutput(1, new Uint8Array([1])))
    socket.results.push(0)
    output.sendText('control-0')

    for (let index = 0; index < 2_000; index++) {
      output.sendText(`control-${index + 1}`)
      socket.results.push(1, 0)
      output.drain()
    }

    const acceptedTexts = socket.accepted.filter(
      (call): call is Extract<OutputCall, { kind: 'text' }> => call.kind === 'text'
    )
    expect(acceptedTexts).toHaveLength(2_000)
    expect(acceptedTexts[0]?.value).toBe('control-0')
    expect(acceptedTexts.at(-1)?.value).toBe('control-1999')
    expect(deferredControlBytes(output)).toBe(wireBytes(Buffer.byteLength('control-2000', 'utf8')))
    expect(controlQueueStorageSlots(output)).toBeLessThanOrEqual(65)
  })

  test('reclaims canceled marker slots behind a blocked control without reordering survivors', () => {
    const socket = new FakeOutputSocket()
    const output = new WebSocketOutput(socket, () => {
      throw new Error('unexpected output failure')
    })
    output.sendBinary(encodeTerminalOutput(1, new Uint8Array([1])))
    socket.results.push(0)
    output.sendText('first')

    for (let streamId = 1; streamId <= 2_000; streamId++) {
      output.sendBinary(encodeTerminalLagged(streamId))
      output.closeStream(streamId)
    }

    expect(deferredControlBytes(output)).toBe(wireBytes(Buffer.byteLength('first', 'utf8')))
    expect(controlQueueStorageSlots(output)).toBeLessThanOrEqual(65)

    output.sendBinary(encodeTerminalLagged(2_001))
    output.sendText('second')
    socket.results.push(1, 1, 1)
    output.drain()

    expect(socket.accepted.map((call) => call.kind === 'text' ? call.value : call.value[0])).toEqual([
      1,
      'first',
      2,
      'second'
    ])
    expect(deferredControlBytes(output)).toBe(0)
    expect(controlQueueStorageSlots(output)).toBe(0)
  })

  test('fails once on thrown sends and non-open peers', () => {
    const throwingSocket = new FakeOutputSocket()
    throwingSocket.throwOnSend = true
    let throwingFailures = 0
    const throwing = new WebSocketOutput(throwingSocket, () => throwingFailures++)
    throwing.sendText('first')
    throwing.sendText('second')
    expect(throwingFailures).toBe(1)
    expect(throwingSocket.calls).toHaveLength(1)

    const closedSocket = new FakeOutputSocket()
    closedSocket.readyState = 3
    let closedFailures = 0
    const closed = new WebSocketOutput(closedSocket, () => closedFailures++)
    expect(closed.sendBinary(encodeTerminalOutput(1, new Uint8Array([1])))).toBe(false)
    expect(closedFailures).toBe(1)
    expect(closedSocket.calls).toHaveLength(0)
  })
})


describe('runtime and health', () => {
  test('writes a private runtime.json and answers /health', async () => {
    const info = readRuntime(harness.home)
    expect(info).toMatchObject({
      pid: process.pid,
      port: harness.daemon.port,
      protocolVersion: PROTOCOL_VERSION
    })
    expect(info?.token.length).toBeGreaterThan(16)
    expect(info?.hookToken).not.toBe(info?.token)
    expect(statSync(join(harness.home, 'runtime.json')).mode & 0o777).toBe(0o600)

    const health = await (await fetch(url(harness, '/health'))).json()
    expect(health).toMatchObject({ ok: true, pid: process.pid })
    expect(typeof health.daemonVersion).toBe('string')
  })

  test('stop removes runtime.json', async () => {
    const isolated = await startHarness()
    try {
      await isolated.daemon.stop()
      expect(existsSync(join(isolated.home, 'runtime.json'))).toBe(false)
    } finally {
      await isolated.cleanup()
    }
  })
})
describe('rpc auth', () => {
  test('rejects a websocket with a wrong token', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${harness.runtime.port}${RPC_PATH}?token=nope`)
    try {
      const outcome = await new Promise<string>((resolve) => {
        socket.addEventListener('open', () => resolve('open'))
        socket.addEventListener('error', () => resolve('error'))
        socket.addEventListener('close', () => resolve('close'))
      })
      expect(outcome).not.toBe('open')
      const plain = await fetch(url(harness, `${RPC_PATH}?token=nope`))
      expect(plain.status).toBe(401)
    } finally {
      socket.close()
    }
  })

  test('requires client.hello first', async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${harness.runtime.port}${RPC_PATH}?token=${harness.runtime.token}`
    )
    try {
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
      const reply = new Promise<any>((resolve) =>
        socket.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)), { once: true })
      )
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status.get', params: {} }))
      const message = await reply
      expect(message.id).toBe(1)
      expect(message.error.code).toBe(RpcErrorCode.Unauthorized)
    } finally {
      socket.close()
    }
  })

  test('hello records role and name, status.get lists clients', async () => {
    const desktop = await harness.connect('desktop', 'shell')
    const cli = await harness.connect('cli', 'tester')
    try {
      const status = await cli.call('status.get', {})
      expect(status.pid).toBe(process.pid)
      expect(status.home).toBe(harness.home)
      expect(status.ptyHost.alive).toBe(true)
      expect(status.clients).toEqual(
        expect.arrayContaining([
          { role: 'desktop', name: 'shell' },
          { role: 'cli', name: 'tester' }
        ])
      )
    } finally {
      desktop.close()
      cli.close()
    }
  })

  test('maps malformed input to protocol errors', async () => {
    const client = await harness.connect()
    try {
      const code = async (method: string, params: unknown) => {
        try {
          await (client as any).call(method, params)
          return null
        } catch (error) {
          return (error as RpcError).code
        }
      }
      expect(await code('nope.nothing', {})).toBe(RpcErrorCode.MethodNotFound)
      expect(await code('plugin.enable', {})).toBe(RpcErrorCode.InvalidParams)
      expect(await code('plugin.enable', { id: 5 })).toBe(RpcErrorCode.InvalidParams)
      expect(await code('plugin.activate', { pluginId: 'acme.missing' })).toBe(RpcErrorCode.NotFound)
      expect(await code('setting.get', { id: 'setting:acme.none/x' })).toBe(RpcErrorCode.NotFound)
    } finally {
      client.close()
    }
  })
})
describe('hook endpoint auth', () => {
  test('requires the hook token header', async () => {
    const target = url(harness, '/hook/claude?session=s_x')
    const none = await fetch(target, { method: 'POST', body: '{}' })
    expect(none.status).toBe(401)
    const wrong = await fetch(target, {
      method: 'POST',
      body: '{}',
      headers: { [HOOK_TOKEN_HEADER]: harness.runtime.token }
    })
    expect(wrong.status).toBe(401)
    const right = await fetch(target, {
      method: 'POST',
      body: '{}',
      headers: { [HOOK_TOKEN_HEADER]: harness.runtime.hookToken }
    })
    expect(right.status).toBe(200)
  })
})

describe('server hook delivery override', () => {
  test('passes the authenticated request body UTF-8 byte length to deliverHook', async () => {
    const received: { event: unknown; bodyBytes: number }[] = []
    const defaultDelivery: unknown[] = []
    const core = {
      hookToken: 'hook-token',
      deliverToPlugins(event: unknown) {
        defaultDelivery.push(event)
      }
    } as unknown as Core
    const server = startServer({
      core,
      handle: async () => {},
      port: 0,
      rpcToken: 'rpc-token',
      daemonVersion: 'test',
      uiDir: '/nonexistent',
      pluginFile: () => null,
      fileResources: { serve: () => new Response(null, { status: 404 }) } as unknown as FileResourceRegistry,
      log: () => {},
      deliverHook: (event, bodyBytes) => received.push({ event, bodyBytes })
    })
    const body = JSON.stringify({ text: 'é🪶' })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/hook/claude?session=s_1`, {
        method: 'POST',
        headers: { [HOOK_TOKEN_HEADER]: 'hook-token' },
        body
      })
      expect(response.status).toBe(200)
      expect(received).toEqual([{
        event: { type: 'hook.received', agent: 'claude', sessionId: 's_1', payload: { text: 'é🪶' } },
        bodyBytes: new TextEncoder().encode(body).byteLength
      }])
      expect(defaultDelivery).toEqual([])
    } finally {
      await server.stop(true)
    }
  })
  test('uses core delivery when no hook override is configured', async () => {
    const delivered: unknown[] = []
    const core = {
      hookToken: 'hook-token',
      deliverToPlugins(event: unknown) {
        delivered.push(event)
      }
    } as unknown as Core
    const server = startServer({
      core,
      handle: async () => {},
      port: 0,
      rpcToken: 'rpc-token',
      daemonVersion: 'test',
      uiDir: '/nonexistent',
      pluginFile: () => null,
      fileResources: { serve: () => new Response(null, { status: 404 }) } as unknown as FileResourceRegistry,
      log: () => {}
    } satisfies ServerOptions)
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/hook/claude?session=s_1`, {
        method: 'POST',
        headers: { [HOOK_TOKEN_HEADER]: 'hook-token' },
        body: '{"n":1}'
      })
      expect(response.status).toBe(200)
      expect(delivered).toEqual([{
        type: 'hook.received',
        agent: 'claude',
        sessionId: 's_1',
        payload: { n: 1 }
      }])
    } finally {
      await server.stop(true)
    }
  })

})

describe('index module preloads', () => {
  async function startPreloadHarness() {
    const home = makeTempHome('qd-preload-')
    const uiDir = join(home, 'ui')
    writeUiFixture(uiDir)
    writeFileSync(join(uiDir, 'index.html'),
      '<!doctype html><body><script type="importmap">{"imports":{}}</script><script type="module" src="./main.js"></script></body>')
    writeFileSync(join(uiDir, 'gallery.html'), '<!doctype html><script type="importmap">{}</script><body>gallery</body>')
    mkdirSync(join(uiDir, 'katex', 'fonts'), { recursive: true })
    writeFileSync(join(uiDir, 'katex', 'fonts', 'KaTeX_Main-Regular.ttf'), 'font')
    const marker = join(home, 'plugin.log')
    writeModulePlugin(join(home, 'plugins'), marker, {
      id: 'acme.ui',
      ui: 'dist/ui.js',
      contributes: { view: [{ id: 'panel', title: 'Panel' }] }
    })
    writeModulePlugin(join(home, 'plugins'), marker, {
      id: 'acme.escaped',
      ui: 'dist/a "<&>.js',
      contributes: { view: [{ id: 'escaped', title: 'Escaped' }] }
    })
    return startHarness({ home, uiDir, builtinPluginsDir: null })
  }

  test('injects encoded plugin preloads in index and SPA fallback, and leaves other files alone', async () => {
    const isolated = await startPreloadHarness()
    try {
      for (const path of ['/', '/worktrees/abc']) {
        const response = await fetch(url(isolated, path))
        const html = await response.text()
        const importMapEnd = html.indexOf('</script>')
        const mainScriptEnd = html.indexOf('<script type="module" src="./main.js"></script>') +
          '<script type="module" src="./main.js"></script>'.length
        const preloadStart = html.indexOf('<link rel="modulepreload" href="/plugins/acme.ui/dist/ui.js">')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(importMapEnd).toBeGreaterThanOrEqual(0)
        expect(preloadStart).toBeGreaterThan(importMapEnd)
        expect(preloadStart).toBeGreaterThan(mainScriptEnd)
        expect(html.indexOf('</body>')).toBeGreaterThan(preloadStart)

        const escaped = html.match(/<link rel="modulepreload" href="([^"]*acme\.escaped[^"]*)">/)
        expect(escaped?.[1]).toBe('/plugins/acme.escaped/dist/a%20%22%3C%26%3E.js')
        expect(escaped?.[1]).not.toMatch(/["<>]/)
      }

      const head = await fetch(url(isolated, '/'), { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-type')).toContain('text/html')
      expect(await head.text()).toBe('')

      const gallery = await fetch(url(isolated, '/gallery.html'))
      expect(await gallery.text()).toBe(readFileSync(join(isolated.home, 'ui', 'gallery.html'), 'utf8'))

      const font = await fetch(url(isolated, '/katex/fonts/KaTeX_Main-Regular.ttf'))
      expect(font.headers.get('content-type')).toBe('font/ttf')
    } finally {
      await isolated.cleanup()
    }
  })

  test('serves index unchanged when module preload computation throws', async () => {
    const home = makeTempHome('qd-preload-failure-')
    const uiDir = join(home, 'ui')
    writeUiFixture(uiDir)
    const html = '<!doctype html><body><script type="importmap">{}</script></body>'
    writeFileSync(join(uiDir, 'index.html'), html)
    let computations = 0
    const core = { hookToken: 'hook-token' } as unknown as Core
    const server = startServer({
      core,
      handle: async () => {},
      port: 0,
      rpcToken: 'rpc-token',
      daemonVersion: 'test',
      uiDir,
      pluginFile: () => null,
      fileResources: { serve: () => new Response(null, { status: 404 }) } as unknown as FileResourceRegistry,
      log: () => {},
      modulePreloads: () => {
        computations++
        throw new Error('plugin model unavailable')
      }
    } satisfies ServerOptions)
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(await response.text()).toBe(html)
      expect(computations).toBe(1)
    } finally {
      await server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  })
  test('preserves the original index bytes when preload injection is inapplicable', async () => {
    const home = makeTempHome('qd-preload-bytes-')
    const uiDir = join(home, 'ui')
    mkdirSync(uiDir, { recursive: true })
    const fixture = Uint8Array.from([
      ...new TextEncoder().encode('<!doctype html><body><!--'),
      0xff,
      ...new TextEncoder().encode('--></body>')
    ])
    writeFileSync(join(uiDir, 'index.html'), fixture)
    const core = { hookToken: 'hook-token' } as unknown as Core
    const server = startServer({
      core,
      handle: async () => {},
      port: 0,
      rpcToken: 'rpc-token',
      daemonVersion: 'test',
      uiDir,
      pluginFile: () => null,
      fileResources: { serve: () => new Response(null, { status: 404 }) } as unknown as FileResourceRegistry,
      log: () => {},
      modulePreloads: () => ['/plugins/acme.ui/dist/ui.js']
    } satisfies ServerOptions)
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`)
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...fixture])
      expect(response.headers.get('cache-control')).toBeNull()
    } finally {
      await server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  })

})
describe('static ui', () => {
  test('serves files with content types and falls back to index.html', async () => {
    const home = (await import('./helpers')).makeTempHome()
    const uiDir = join(home, 'ui')
    writeUiFixture(uiDir)
    const isolated = await startHarness({ home, uiDir })
    try {
      const index = await fetch(url(isolated, '/'))
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')

      const js = await fetch(url(isolated, '/assets/app.js'))
      expect(js.headers.get('content-type')).toContain('javascript')
      expect(await js.text()).toContain('console.log')

      const css = await fetch(url(isolated, '/assets/app.css'))
      expect(css.headers.get('content-type')).toContain('text/css')

      const spa = await fetch(url(isolated, '/worktrees/abc'))
      expect(spa.status).toBe(200)
      expect(await spa.text()).toBe(readFileSync(join(uiDir, 'index.html'), 'utf8'))

      expect((await fetch(url(isolated, '/assets/missing.js'))).status).toBe(404)
      expect((await fetch(url(isolated, '/../../etc/passwd'))).status).not.toBe(500)
    } finally {
      await isolated.cleanup()
    }
  })

  test('answers /favicon.ico with 204', async () => {
    const response = await fetch(url(harness, '/favicon.ico'))
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  test('returns 404 when the ui dir is missing', async () => {
    expect((await fetch(url(harness, '/'))).status).toBe(404)
  })
})

