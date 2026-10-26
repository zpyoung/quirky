import { describe, expect, test } from 'bun:test'
import { decodeTerminalOutput, RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import { Core, type CoreOptions } from '../../src/service'
import { Store } from '../../src/store'
import { openStream } from '../../src/plugins/streams'
import type { ClientConn } from '../../src/types'

function fakeConn(transport: 'websocket' | 'socket' = 'websocket'): ClientConn & { binary: Uint8Array[]; text: string[] } {
  const binary: Uint8Array[] = []
  const text: string[] = []
  return {
    id: 1,
    role: 'ui',
    subscribed: true,
    closed: false,
    transport,
    streams: new Map(),
    nextStreamId: 1,
    streamClosers: new Map(),
    sendText: (value) => void text.push(value),
    sendBinary: (bytes) => {
      if (transport === 'socket') throw new Error('socket connections carry no binary frames')
      binary.push(bytes)
    },
    binary,
    text
  }
}

function makeCore(onEvent?: (event: QuirkyEvent) => void): Core {
  const pty = { onData() {}, onExit() {}, onReconnect() {}, connected: true }
  return new Core({
    home: '/tmp/qd-streams',
    store: new Store(':memory:'),
    pty,
    notifier: () => {},
    runnerFactory: () => ({}),
    hookToken: 'token',
    hookUrl: () => 'http://127.0.0.1:1/hook',
    onEvent
  } as unknown as CoreOptions)
}

describe('openStream', () => {
  test('a socket connection is refused with InvalidParams', () => {
    const conn = fakeConn('socket')
    try {
      openStream(conn)
      throw new Error('expected openStream to throw')
    } catch (error) {
      expect((error as { code: number }).code).toBe(RpcErrorCode.InvalidParams)
      expect((error as Error).message).toBe('this method needs the WebSocket transport')
    }
    expect(conn.streamClosers.size).toBe(0)
  })

  test('allocates stream ids from the connection and frames sends as terminal output', () => {
    const conn = fakeConn()
    const first = openStream(conn)
    const second = openStream(conn)
    expect([first.streamId, second.streamId]).toEqual([1, 2])
    expect(conn.nextStreamId).toBe(3)
    expect([...conn.streamClosers.keys()]).toEqual([1, 2])

    second.send(new Uint8Array([104, 105]))
    expect(decodeTerminalOutput(conn.binary[0])).toEqual({ streamId: 2, bytes: new Uint8Array([104, 105]) })
  })

  test('close runs every onClose callback once, unregisters the closer and stops sends', () => {
    const conn = fakeConn()
    const stream = openStream(conn)
    const calls: string[] = []
    stream.onClose(() => calls.push('a'))
    stream.onClose(() => calls.push('b'))

    stream.close()
    stream.close()

    expect(calls).toEqual(['a', 'b'])
    expect(conn.streamClosers.size).toBe(0)
    stream.send(new Uint8Array([1]))
    expect(conn.binary).toEqual([])
  })

  test('onClose on a closed stream runs the callback at once', () => {
    const stream = openStream(fakeConn())
    stream.close()
    let ran = 0
    stream.onClose(() => ran++)
    expect(ran).toBe(1)
  })

  test('a stream opened on an already closed connection starts closed and registers no closer', () => {
    const conn = fakeConn()
    conn.closed = true
    const stream = openStream(conn)
    let ran = 0
    stream.onClose(() => ran++)
    expect(ran).toBe(1)
    expect(conn.streamClosers.size).toBe(0)

    stream.send(new Uint8Array([1]))
    stream.close()
    expect(ran).toBe(1)
    expect(conn.binary).toEqual([])
  })

  test('a throwing onClose callback does not stop the others', () => {
    const stream = openStream(fakeConn())
    const calls: string[] = []
    stream.onClose(() => {
      throw new Error('boom')
    })
    stream.onClose(() => calls.push('after'))
    stream.close()
    expect(calls).toEqual(['after'])
  })

  test('Core.removeClient closes every open stream once', () => {
    const core = makeCore()
    const conn = fakeConn()
    core.addClient(conn)
    const stream = openStream(conn)
    const other = openStream(conn)
    let closed = 0
    stream.onClose(() => closed++)
    other.onClose(() => closed++)

    core.removeClient(conn)
    core.removeClient(conn)

    expect(closed).toBe(2)
    expect(conn.streamClosers.size).toBe(0)
  })
})

describe('hook.received delivery', () => {
  const hook: QuirkyEvent = { type: 'hook.received', agent: 'claude', sessionId: 's_1', payload: { a: 1 } }

  test('deliverToPlugins reaches plugin listeners and no subscribed client', () => {
    const seen: QuirkyEvent[] = []
    const core = makeCore((event) => seen.push(event))
    const conn = fakeConn()
    core.addClient(conn)

    core.deliverToPlugins(hook)

    expect(seen).toEqual([hook])
    expect(conn.text).toEqual([])
  })

  test('broadcasting hook.received still never reaches a client', () => {
    const seen: QuirkyEvent[] = []
    const core = makeCore((event) => seen.push(event))
    const conn = fakeConn()
    core.addClient(conn)

    core.broadcast(hook)

    expect(seen).toEqual([hook])
    expect(conn.text).toEqual([])
  })
})
