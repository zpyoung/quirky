import { describe, expect, test } from 'bun:test'
import { encodePtyData, encodePtyJson, PtyFrameDecoder } from '@quirky/protocol'
import { SocketWriter } from '../src/writer'

class TestSocket {
  writeLimit = Number.POSITIVE_INFINITY
  endCalls = 0
  private chunks: Uint8Array[] = []

  write(bytes: Uint8Array): number {
    const written = Math.min(bytes.length, this.writeLimit)
    if (written > 0) this.chunks.push(bytes.subarray(0, written))
    return written
  }

  end(): void {
    this.endCalls++
  }

  writtenBytes(): Uint8Array {
    const length = this.chunks.reduce((total, chunk) => total + chunk.length, 0)
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }
}

const text = (value: string) => new TextEncoder().encode(value)

describe('SocketWriter', () => {
  test('refuses an oversized first write without queuing it', () => {
    const socket = new TestSocket()
    socket.writeLimit = 0
    const writer = new SocketWriter(socket, 4)

    expect(writer.send(new Uint8Array(5), 'A')).toBe(false)
    expect(writer.queuedBytes).toBe(0)
    expect(writer.queuedForTag('A')).toBe(0)
  })

  test('refuses an overflowing append without changing the existing queue', () => {
    const socket = new TestSocket()
    socket.writeLimit = 0
    const writer = new SocketWriter(socket, 5)

    expect(writer.send(new Uint8Array(4), 'A')).toBe(true)
    expect(writer.send(new Uint8Array(2), 'B')).toBe(false)
    expect(writer.queuedBytes).toBe(4)
    expect(writer.queuedForTag('A')).toBe(4)
    expect(writer.queuedForTag('B')).toBe(0)
  })

  test('accepts an append that exactly fills the cap and rejects the next byte', () => {
    const socket = new TestSocket()
    socket.writeLimit = 0
    const writer = new SocketWriter(socket, 5)
    const first = text('abcd')
    const second = text('e')

    expect(writer.send(first)).toBe(true)
    expect(writer.send(second)).toBe(true)
    expect(writer.queuedBytes).toBe(5)

    expect(writer.send(text('f'))).toBe(false)
    expect(writer.queuedBytes).toBe(5)

    socket.writeLimit = Number.POSITIVE_INFINITY
    writer.drain()
    expect(writer.queuedBytes).toBe(0)
    expect(socket.writtenBytes()).toEqual(new Uint8Array([...first, ...second]))
  })

  test('drops only unstarted tagged bytes and preserves a started frame stream', () => {
    const socket = new TestSocket()
    socket.writeLimit = 0
    const writer = new SocketWriter(socket, 1024)
    const started = encodePtyData('A', text('started'))
    const dropped = encodePtyData('A', text('unstarted'))
    const kept = encodePtyData('B', text('kept'))
    const reply = encodePtyJson({ requestId: 1, ok: true })

    expect(writer.send(started, 'A')).toBe(true)
    expect(writer.queuedForTag('A')).toBe(started.length)

    socket.writeLimit = 3
    writer.drain()
    expect(writer.queuedBytes).toBe(started.length - 3)
    expect(writer.queuedForTag('A')).toBe(0)

    expect(writer.send(dropped, 'A')).toBe(true)
    expect(writer.send(kept, 'B')).toBe(true)
    expect(writer.send(reply)).toBe(true)
    expect(writer.queuedForTag('A')).toBe(dropped.length)
    expect(writer.queuedForTag('B')).toBe(kept.length)

    expect(writer.dropTag('A')).toBe(dropped.length)
    expect(writer.queuedForTag('A')).toBe(0)
    expect(writer.queuedBytes).toBe(started.length - 3 + kept.length + reply.length)

    socket.writeLimit = Number.POSITIVE_INFINITY
    writer.drain()
    expect(writer.queuedBytes).toBe(0)
    expect(new PtyFrameDecoder().push(socket.writtenBytes())).toEqual([
      { kind: 'data', sessionId: 'A', bytes: text('started') },
      { kind: 'data', sessionId: 'B', bytes: text('kept') },
      { kind: 'json', message: { requestId: 1, ok: true } }
    ])
  })

  test('dropTag resolves flush waiters when it removes the last queued bytes', async () => {
    const socket = new TestSocket()
    socket.writeLimit = 0
    const writer = new SocketWriter(socket, 64)
    const queued = encodePtyData('A', text('pending'))

    writer.send(queued, 'A')
    const flushed = writer.flushed()
    expect(writer.dropTag('A')).toBe(queued.length)
    await flushed
    expect(writer.queuedBytes).toBe(0)
  })

  test('clear resolves flush waiters without ending the socket', async () => {
    const socket = new TestSocket()
    socket.writeLimit = 0
    const writer = new SocketWriter(socket, 64)

    writer.send(encodePtyData('A', text('pending')), 'A')
    const flushed = writer.flushed()
    writer.endAfterFlush()
    writer.clear()

    await flushed
    expect(writer.queuedBytes).toBe(0)
    expect(writer.queuedForTag('A')).toBe(0)
    expect(socket.endCalls).toBe(0)
  })

  test('keeps 512 frames flowing below the cap while queued bytes stay non-zero', () => {
    const socket = new TestSocket()
    socket.writeLimit = 32_768
    const writer = new SocketWriter(socket, 256 * 1024)
    const payloadSize = 65_536
    const sessionId = 's'
    const frameFor = (index: number) => {
      const payload = new Uint8Array(payloadSize)
      payload.fill(index & 0xff)
      return encodePtyData(sessionId, payload)
    }

    expect(writer.send(frameFor(0), sessionId)).toBe(true)
    let maxQueuedBytes = writer.queuedBytes

    for (let index = 1; index < 512; index++) {
      expect(writer.queuedBytes).toBeGreaterThanOrEqual(32_768)
      expect(writer.queuedBytes).toBeLessThanOrEqual(96 * 1024)
      expect(writer.send(frameFor(index), sessionId)).toBe(true)
      maxQueuedBytes = Math.max(maxQueuedBytes, writer.queuedBytes)
      expect(writer.queuedBytes).toBeLessThanOrEqual(128 * 1024)

      writer.drain()
      writer.drain()
      expect(writer.queuedBytes).toBeGreaterThan(0)
      expect(writer.queuedBytes).toBeLessThanOrEqual(96 * 1024)
    }

    socket.writeLimit = Number.POSITIVE_INFINITY
    writer.drain()
    expect(writer.queuedBytes).toBe(0)
    expect(maxQueuedBytes).toBeLessThanOrEqual(128 * 1024)

    const frames = new PtyFrameDecoder().push(socket.writtenBytes())
    expect(frames).toHaveLength(512)
    const expectedPayload = new Uint8Array(payloadSize)
    frames.forEach((frame, index) => {
      expectedPayload.fill(index & 0xff)
      expect(frame).toEqual({ kind: 'data', sessionId, bytes: expectedPayload })
    })
  })
})
