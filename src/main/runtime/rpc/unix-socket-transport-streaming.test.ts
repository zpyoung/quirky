import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnixSocketTransport, type UnixSocketMessageContext } from './unix-socket-transport'

const KEEPALIVE_MS = 1000
const KEEPALIVE_FRAME = '{"_keepalive":true}\n'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  writableLength = 0
  readonly writes: string[] = []

  setEncoding(): void {}
  setNoDelay(): void {}
  setTimeout(): this {
    return this
  }
  end(): void {}

  write(data: string): boolean {
    this.writes.push(data)
    return true
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.writable = false
      this.emit('close')
    }
    return this
  }
}

type Handler = (
  message: string,
  reply: (response: string) => void,
  context: UnixSocketMessageContext
) => void

function connect(handler: Handler) {
  const transport = new UnixSocketTransport({
    endpoint: 'test-pipe',
    kind: 'named-pipe',
    keepaliveIntervalMs: KEEPALIVE_MS
  })
  transport.onMessage((message, reply, context) => {
    if (!context) {
      throw new Error('the transport always supplies a message context')
    }
    handler(message, reply, context)
  })
  const socket = new FakeSocket()
  // SAFETY: handleConnection is private; a fake socket keeps the test off the network.
  ;(transport as unknown as { handleConnection(socket: Socket): void }).handleConnection(
    socket as unknown as Socket
  )
  const send = (message: string): boolean => socket.emit('data', `${message}\n`)
  return { socket, send }
}

function beginStream(context: UnixSocketMessageContext): (frame: string) => void {
  if (!context.beginStream) {
    throw new Error('the transport offers a stream')
  }
  return context.beginStream()
}

describe('UnixSocketTransport streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes each frame as its own NDJSON line without ending the request', () => {
    const { socket, send } = connect((_message, _reply, context) => {
      const write = beginStream(context)
      write('{"n":1}')
      write('{"n":2}')
    })

    send('{"id":"1"}')
    expect(socket.writes).toEqual(['{"n":1}\n', '{"n":2}\n'])
  })

  it('keeps writing frames that arrive after the handler returned', () => {
    let write: (frame: string) => void = () => {}
    const { socket, send } = connect((_message, _reply, context) => {
      write = beginStream(context)
    })

    send('{"id":"1"}')
    write('{"n":1}')
    vi.advanceTimersByTime(5000)
    write('{"n":2}')

    expect(socket.writes.filter((line) => line !== KEEPALIVE_FRAME)).toEqual([
      '{"n":1}\n',
      '{"n":2}\n'
    ])
  })

  it('keeps sending keepalives for as long as the stream is open', () => {
    const { socket, send } = connect((_message, _reply, context) => {
      beginStream(context)
    })

    send('{"id":"1"}')
    expect(socket.writes).toEqual([])
    vi.advanceTimersByTime(KEEPALIVE_MS * 3)

    expect(socket.writes).toEqual([KEEPALIVE_FRAME, KEEPALIVE_FRAME, KEEPALIVE_FRAME])
  })

  it('interleaves keepalives with frames', () => {
    let write: (frame: string) => void = () => {}
    const { socket, send } = connect((_message, _reply, context) => {
      write = beginStream(context)
    })

    send('{"id":"1"}')
    write('{"n":1}')
    vi.advanceTimersByTime(KEEPALIVE_MS)
    write('{"n":2}')

    expect(socket.writes).toEqual(['{"n":1}\n', KEEPALIVE_FRAME, '{"n":2}\n'])
  })

  it('writes nothing for the final reply of a stream and stops its keepalives', () => {
    let write: (frame: string) => void = () => {}
    let reply: (response: string) => void = () => {}
    const { socket, send } = connect((_message, replyFn, context) => {
      reply = replyFn
      write = beginStream(context)
    })

    send('{"id":"1"}')
    write('{"type":"end"}')
    reply('{"id":"1","ok":true}')
    write('{"late":true}')
    vi.advanceTimersByTime(KEEPALIVE_MS * 3)

    expect(socket.writes).toEqual(['{"type":"end"}\n'])
  })

  it('aborts the request signal and stops keepalives when the socket closes', () => {
    let signal: AbortSignal | undefined
    const { socket, send } = connect((_message, _reply, context) => {
      signal = context.signal
      beginStream(context)
    })

    send('{"id":"1"}')
    expect(signal?.aborted).toBe(false)
    socket.destroy()
    vi.advanceTimersByTime(KEEPALIVE_MS * 3)

    expect(signal?.aborted).toBe(true)
    expect(socket.writes).toEqual([])
  })

  it('runs the subscriber cleanup registered on the signal when the socket closes', () => {
    const cleanup = vi.fn()
    const { socket, send } = connect((_message, _reply, context) => {
      context.signal.addEventListener('abort', cleanup, { once: true })
      beginStream(context)
    })

    send('{"id":"1"}')
    socket.destroy()

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('drops frames written after the socket closed', () => {
    let write: (frame: string) => void = () => {}
    const { socket, send } = connect((_message, _reply, context) => {
      write = beginStream(context)
    })

    send('{"id":"1"}')
    socket.destroy()
    write('{"n":1}')

    expect(socket.writes).toEqual([])
  })

  it('closes a subscriber that stops reading instead of buffering its stream', () => {
    let write: (frame: string) => void = () => {}
    const { socket, send } = connect((_message, _reply, context) => {
      write = beginStream(context)
    })

    send('{"id":"1"}')
    write('{"n":1}')
    socket.writableLength = 9 * 1024 * 1024
    write('{"n":2}')

    expect(socket.destroyed).toBe(true)
    expect(socket.writes).toEqual(['{"n":1}\n'])
  })

  describe('a unary request', () => {
    it('still gets exactly one reply line and no keepalives', () => {
      const { socket, send } = connect((_message, reply) => {
        reply('{"id":"1","ok":true}')
        reply('{"id":"1","ok":"again"}')
      })

      send('{"id":"1"}')
      vi.advanceTimersByTime(KEEPALIVE_MS * 3)

      expect(socket.writes).toEqual(['{"id":"1","ok":true}\n'])
    })

    it('does not abort its signal when it finished before the socket closed', () => {
      let signal: AbortSignal | undefined
      const { socket, send } = connect((_message, reply, context) => {
        signal = context.signal
        reply('{"id":"1","ok":true}')
      })

      send('{"id":"1"}')
      socket.destroy()

      expect(signal?.aborted).toBe(false)
    })

    it('keeps a stream on one request from touching a unary reply on the same socket', () => {
      let write: (frame: string) => void = () => {}
      const { socket, send } = connect((message, reply, context) => {
        if (message.includes('stream')) {
          write = beginStream(context)
        } else {
          reply('{"id":"unary"}')
        }
      })

      send('{"id":"stream"}')
      send('{"id":"other"}')
      write('{"n":1}')

      expect(socket.writes).toEqual(['{"id":"unary"}\n', '{"n":1}\n'])
    })
  })
})
