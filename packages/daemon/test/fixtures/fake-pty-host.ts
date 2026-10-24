/**
 * An in-process stand-in for quirky-pty that speaks the control protocol over `<home>/pty.sock`.
 * Tests drive it with `emit`, `exit` and `dropConnections`, and inspect what the daemon sent.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Socket } from 'bun'
import {
  PtyFrameDecoder,
  base64ToBytes,
  bytesToBase64,
  encodePtyData,
  encodePtyJson,
  type PtyRequest,
  type PtySessionInfo
} from '@quirky/protocol'

type ConnState = { decoder: PtyFrameDecoder; authed: boolean }

export type FakeSession = {
  info: PtySessionInfo
  env: Record<string, string>
  buffer: number[]
  subscribers: Set<Socket<ConnState>>
}

export type FakePtyHost = {
  socketPath: string
  token: string
  sessions: Map<string, FakeSession>
  requests: PtyRequest[]
  inputs: { sessionId: string; text: string }[]
  emit(sessionId: string, data: string | Uint8Array): void
  exit(sessionId: string, exitCode: number | null): void
  dropConnections(): void
  setReadResult(result: { lines: string[]; cols: number; rows: number; alt: boolean }): void
  /** Makes every request of `type` fail with `error`; `null` clears it. */
  failRequests(type: PtyRequest['type'], error: string | null): void
  stop(): void
}

export function startFakePtyHost(home: string, options: { onShutdown?: () => void } = {}): FakePtyHost {
  mkdirSync(home, { recursive: true })
  const socketPath = join(home, 'pty.sock')
  const token = crypto.randomUUID()
  rmSync(socketPath, { force: true })
  writeFileSync(join(home, 'pty.token'), token, { mode: 0o600 })

  const sessions = new Map<string, FakeSession>()
  const requests: PtyRequest[] = []
  const inputs: { sessionId: string; text: string }[] = []
  const connections = new Set<Socket<ConnState>>()
  let readResult = { lines: ['hello from the screen'], cols: 80, rows: 24, alt: false }
  let nextPid = 4000
  const failures = new Map<PtyRequest['type'], string>()

  function reply(socket: Socket<ConnState>, id: number, result: unknown) {
    socket.write(encodePtyJson({ id, ok: true, result }))
  }
  function fail(socket: Socket<ConnState>, id: number, error: string) {
    socket.write(encodePtyJson({ id, ok: false, error }))
  }

  function handle(socket: Socket<ConnState>, request: PtyRequest) {
    requests.push(request)
    if (!socket.data.authed) {
      if (request.type !== 'hello' || request.token !== token) {
        socket.end()
        return
      }
      socket.data.authed = true
      reply(socket, request.id, { version: 1, pid: process.pid })
      return
    }
    const injected = failures.get(request.type)
    if (injected !== undefined) return fail(socket, request.id, injected)
    switch (request.type) {
      case 'hello':
        reply(socket, request.id, { version: 1, pid: process.pid })
        return
      case 'create': {
        const info: PtySessionInfo = {
          sessionId: request.sessionId,
          pid: nextPid++,
          alive: true,
          exitCode: null,
          cols: request.cols,
          rows: request.rows,
          argv: request.argv,
          cwd: request.cwd,
          createdAt: Date.now(),
          offset: 0
        }
        sessions.set(request.sessionId, {
          info,
          env: request.env,
          buffer: [],
          subscribers: new Set()
        })
        reply(socket, request.id, { pid: info.pid })
        return
      }
      case 'resize': {
        const session = sessions.get(request.sessionId)
        if (!session) return fail(socket, request.id, 'no such session')
        session.info.cols = request.cols
        session.info.rows = request.rows
        reply(socket, request.id, {})
        return
      }
      case 'kill': {
        if (!sessions.has(request.sessionId)) return fail(socket, request.id, 'no such session')
        reply(socket, request.id, {})
        return
      }
      case 'forget':
        if (!sessions.delete(request.sessionId)) return fail(socket, request.id, `unknown session: ${request.sessionId}`)
        reply(socket, request.id, {})
        return
      case 'list':
        reply(
          socket,
          request.id,
          [...sessions.values()].map((s) => ({ ...s.info, offset: s.buffer.length }))
        )
        return
      case 'subscribe': {
        const session = sessions.get(request.sessionId)
        if (!session) return fail(socket, request.id, 'no such session')
        session.subscribers.add(socket)
        reply(socket, request.id, {
          replay: bytesToBase64(Uint8Array.from(session.buffer)),
          offset: session.buffer.length
        })
        return
      }
      case 'unsubscribe':
        sessions.get(request.sessionId)?.subscribers.delete(socket)
        reply(socket, request.id, {})
        return
      case 'read':
        reply(socket, request.id, readResult)
        return
      case 'shutdown':
        reply(socket, request.id, {})
        options.onShutdown?.()
        return
    }
  }

  const listener = Bun.listen<ConnState>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { decoder: new PtyFrameDecoder(), authed: false }
        connections.add(socket)
      },
      data(socket, chunk) {
        for (const frame of socket.data.decoder.push(new Uint8Array(chunk))) {
          if (frame.kind === 'json') {
            handle(socket, frame.message as PtyRequest)
          } else {
            inputs.push({ sessionId: frame.sessionId, text: new TextDecoder().decode(frame.bytes) })
          }
        }
      },
      close(socket) {
        connections.delete(socket)
        for (const session of sessions.values()) session.subscribers.delete(socket)
      }
    }
  })

  return {
    socketPath,
    token,
    sessions,
    requests,
    inputs,
    emit(sessionId, data) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`fake pty: no session ${sessionId}`)
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
      for (const byte of bytes) session.buffer.push(byte)
      for (const subscriber of session.subscribers) subscriber.write(encodePtyData(sessionId, bytes))
    },
    exit(sessionId, exitCode) {
      const session = sessions.get(sessionId)
      if (session) {
        session.info.alive = false
        session.info.exitCode = exitCode
      }
      for (const socket of connections) {
        socket.write(encodePtyJson({ type: 'exit', sessionId, exitCode }))
      }
    },
    dropConnections() {
      for (const socket of [...connections]) socket.end()
    },
    setReadResult(result) {
      readResult = result
    },
    failRequests(type, error) {
      if (error === null) failures.delete(type)
      else failures.set(type, error)
    },
    stop() {
      for (const socket of [...connections]) socket.end()
      listener.stop(true)
      rmSync(socketPath, { force: true })
    }
  }
}

export { base64ToBytes }

if (import.meta.main) {
  const home = process.env.QUIRKY_HOME
  if (!home) throw new Error('QUIRKY_HOME is required')
  writeFileSync(join(home, 'pty.pid'), String(process.pid))
  startFakePtyHost(home, { onShutdown: () => process.exit(0) })
}
