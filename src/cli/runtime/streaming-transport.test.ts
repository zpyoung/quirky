import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { sendStreamingRequest } from './streaming-transport'

const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

type Request = { id: string; method: string; params: unknown } & Record<string, unknown>

type FakeRuntime = {
  metadata: RuntimeMetadata
  requests: Request[]
  closed: Promise<void>
}

/** A unix-socket runtime that hands each connection's request and socket to `onRequest`. */
async function startRuntime(
  onRequest: (request: Request, socket: Socket) => void
): Promise<FakeRuntime> {
  const endpoint = join(mkdtempSync(join(tmpdir(), 'quirky-streaming-transport-')), 'runtime.sock')
  const requests: Request[] = []
  let markClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve
  })
  const server = createServer((socket) => {
    sockets.add(socket)
    // a client that hangs up mid-write must not surface as an unhandled socket error
    socket.on('error', () => {})
    socket.once('close', () => {
      sockets.delete(socket)
      markClosed()
    })
    socket.once('data', (data) => {
      const request = JSON.parse(String(data).trim()) as Request
      requests.push(request)
      onRequest(request, socket)
    })
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  return {
    metadata: {
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    },
    requests,
    closed
  }
}

function frame(id: string, result: unknown, streaming = true): string {
  return `${JSON.stringify({ id, ok: true, result, streaming, _meta: { runtimeId: 'runtime-1' } })}\n`
}

describe('sendStreamingRequest', () => {
  it('delivers every streaming frame in order and resolves on the end frame', async () => {
    const runtime = await startRuntime((request, socket) => {
      socket.write(frame(request.id, { type: 'ready', cursor: 1 }))
      socket.write(frame(request.id, { seq: 2, type: 'turn.started' }))
      socket.write(frame(request.id, { seq: 3, type: 'turn.finished' }))
      socket.write(frame(request.id, { type: 'end' }))
    })
    const received: unknown[] = []

    await sendStreamingRequest(
      runtime.metadata,
      'events.subscribe',
      { topics: ['chat'] },
      (result) => received.push(result)
    )

    expect(received).toEqual([
      { type: 'ready', cursor: 1 },
      { seq: 2, type: 'turn.started' },
      { seq: 3, type: 'turn.finished' }
    ])
  })

  it('reassembles a frame split across socket writes and several frames in one write', async () => {
    const runtime = await startRuntime((request, socket) => {
      const first = frame(request.id, { n: 1 })
      socket.write(first.slice(0, 15))
      setTimeout(() => {
        socket.write(
          first.slice(15) + frame(request.id, { n: 2 }) + frame(request.id, { type: 'end' })
        )
      }, 20)
    })
    const received: unknown[] = []
    await sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, (result) =>
      received.push(result)
    )
    expect(received).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('sends the request with the public-contract fields and the auth token', async () => {
    const runtime = await startRuntime((request, socket) => {
      socket.write(frame(request.id, { type: 'end' }))
    })
    await sendStreamingRequest(runtime.metadata, 'events.subscribe', { after: 4 }, () => {}, {
      publicRequest: { publicContract: 1, caller: { agentSessionId: 'session-1' } }
    })
    expect(runtime.requests[0]).toMatchObject({
      method: 'events.subscribe',
      params: { after: 4 },
      authToken: 'token',
      publicContract: 1,
      caller: { agentSessionId: 'session-1' }
    })
  })

  it('ignores keepalive frames and applies no per-request timeout', async () => {
    const runtime = await startRuntime((request, socket) => {
      socket.write('{"_keepalive":true}\n')
      setTimeout(() => socket.write('{"_keepalive":true}\n'), 40)
      setTimeout(() => {
        socket.write(frame(request.id, { seq: 5, type: 'turn.finished' }))
        socket.write(frame(request.id, { type: 'end' }))
      }, 120)
    })
    const received: unknown[] = []
    await sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, (result) =>
      received.push(result)
    )
    expect(received).toEqual([{ seq: 5, type: 'turn.finished' }])
  })

  it('rejects with the runtime failure envelope', async () => {
    const runtime = await startRuntime((request, socket) => {
      socket.write(frame(request.id, { type: 'ready' }))
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: 'method_not_found', message: 'no such method' },
          _meta: { runtimeId: 'runtime-1' }
        })}\n`
      )
    })
    const received: unknown[] = []
    await expect(
      sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, (result) =>
        received.push(result)
      )
    ).rejects.toMatchObject({ code: 'method_not_found', message: 'no such method' })
    expect(received).toEqual([{ type: 'ready' }])
  })

  it('rejects when the runtime closes the socket before the end frame', async () => {
    const runtime = await startRuntime((request, socket) => {
      socket.write(frame(request.id, { n: 1 }))
      socket.end()
    })
    await expect(
      sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, () => {})
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })

  it('rejects a frame answering a different request id', async () => {
    const runtime = await startRuntime((_request, socket) => {
      socket.write(frame('someone-else', { n: 1 }))
    })
    await expect(
      sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, () => {})
    ).rejects.toMatchObject({ code: 'invalid_runtime_response' })
  })

  it('rejects a frame that is not valid json', async () => {
    const runtime = await startRuntime((_request, socket) => {
      socket.write('not json\n')
    })
    await expect(
      sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, () => {})
    ).rejects.toMatchObject({ code: 'invalid_runtime_response' })
  })

  it('rejects with what onFrame throws and closes the connection', async () => {
    const runtime = await startRuntime((request, socket) => {
      socket.write(frame(request.id, { n: 1 }))
    })
    await expect(
      sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, () => {
        throw new Error('consumer failed')
      })
    ).rejects.toThrow('consumer failed')
    await runtime.closed
  })

  it('resolves when the signal aborts and closes the connection', async () => {
    const stop = new AbortController()
    const runtime = await startRuntime((request, socket) => {
      socket.write(frame(request.id, { n: 1 }))
    })
    const received: unknown[] = []
    const done = sendStreamingRequest(
      runtime.metadata,
      'events.subscribe',
      {},
      (result) => {
        received.push(result)
        stop.abort()
      },
      { signal: stop.signal }
    )
    await expect(done).resolves.toBeUndefined()
    await runtime.closed
    expect(received).toEqual([{ n: 1 }])
  })

  it('does not connect when the signal is already aborted', async () => {
    const stop = new AbortController()
    stop.abort()
    const runtime = await startRuntime(() => {})
    await sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, () => {}, {
      signal: stop.signal
    })
    expect(runtime.requests).toEqual([])
  })

  it('rejects with timeout once timeoutMs elapses, even while keepalives continue', async () => {
    const runtime = await startRuntime((_request, socket) => {
      const keepalive = setInterval(() => socket.write('{"_keepalive":true}\n'), 10)
      socket.once('close', () => clearInterval(keepalive))
    })
    await expect(
      sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, () => {}, { timeoutMs: 80 })
    ).rejects.toMatchObject({ code: 'timeout' })
    await runtime.closed
  })

  it('rejects an invalid timeoutMs before connecting', async () => {
    const runtime = await startRuntime(() => {})
    await expect(
      sendStreamingRequest(runtime.metadata, 'events.subscribe', {}, () => {}, { timeoutMs: -1 })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(runtime.requests).toEqual([])
  })

  it('rejects as unavailable when nothing is listening', async () => {
    const endpoint = join(mkdtempSync(join(tmpdir(), 'quirky-streaming-transport-')), 'none.sock')
    const metadata: RuntimeMetadata = {
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    }
    await expect(
      sendStreamingRequest(metadata, 'events.subscribe', {}, () => {})
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })
})
