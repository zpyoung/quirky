import { describe, expect, test } from 'bun:test'
import {
  WsFrameKind,
  decodeTerminalOutput,
  encodeTerminalLagged,
  encodeTerminalOutput,
  RpcErrorCode,
  type QuirkyEvent
} from '@quirky/protocol'
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

  test('lag sends one frame, notifies once and rejects later sends', () => {
    const conn = fakeConn()
    const stream = openStream(conn)
    const first = new Uint8Array([0x61])
    const calls: string[] = []

    expect(stream.lagged).toBe(false)
    expect(stream.send(first)).toBe(true)
    stream.onLag?.(() => calls.push('first'))
    stream.lag?.()
    stream.lag?.()
    expect(stream.lagged).toBe(true)
    expect(calls).toEqual(['first'])

    stream.onLag?.(() => calls.push('late'))
    expect(calls).toEqual(['first', 'late'])
    expect(stream.send(new Uint8Array([0x62]))).toBe(false)
    expect(conn.binary).toEqual([encodeTerminalOutput(1, first), encodeTerminalLagged(1)])
  })

  test('a rejected output send lags once and reports failure while void transports stay accepted', () => {
    const conn = fakeConn()
    const attempts: Uint8Array[] = []
    let rejectOutput = true
    conn.sendBinary = (bytes) => {
      attempts.push(bytes)
      if (bytes[0] === WsFrameKind.TerminalOutput && rejectOutput) {
        rejectOutput = false
        return false
      }
      return undefined
    }
    const stream = openStream(conn)
    const lagged: number[] = []
    stream.onLag?.(() => lagged.push(stream.streamId))

    expect(stream.send(new Uint8Array([1]))).toBe(false)
    expect(stream.lagged).toBe(true)
    expect(stream.send(new Uint8Array([2]))).toBe(false)
    expect(lagged).toEqual([stream.streamId])
    expect(attempts).toEqual([encodeTerminalOutput(stream.streamId, new Uint8Array([1])), encodeTerminalLagged(stream.streamId)])

    const legacy = openStream(fakeConn())
    expect(legacy.send(new Uint8Array([3]))).toBe(true)
  })

  test('closing a stream releases its output controller marker', () => {
    const conn = fakeConn()
    const closedOutput: number[] = []
    conn.closeStreamOutput = (streamId) => closedOutput.push(streamId)
    const stream = openStream(conn)

    stream.close()
    stream.close()

    expect(closedOutput).toEqual([stream.streamId])
  })

  test('close runs every onClose callback once, unregisters the closer and stops sends', () => {
    const conn = fakeConn()
    const stream = openStream(conn)
    const calls: string[] = []
    stream.onClose(() => calls.push('a'))
    stream.onClose(() => calls.push('b'))

    let lagCalls = 0
    stream.onLag?.(() => lagCalls++)
    stream.close()
    stream.close()

    expect(calls).toEqual(['a', 'b'])
    expect(conn.streamClosers.size).toBe(0)
    expect(stream.send(new Uint8Array([1]))).toBe(false)
    stream.lag?.()
    expect(stream.lagged).toBe(false)
    expect(conn.binary).toEqual([])
    expect(lagCalls).toBe(0)

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

    expect(stream.send(new Uint8Array([1]))).toBe(false)
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

  test('a throwing onLag callback does not stop the others', () => {
    const stream = openStream(fakeConn())
    const calls: string[] = []
    stream.onLag?.(() => {
      throw new Error('boom')
    })
    stream.onLag?.(() => calls.push('after'))
    stream.lag?.()
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
