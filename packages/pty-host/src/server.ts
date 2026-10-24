import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  encodePtyData,
  encodePtyJson,
  PTY_PROTOCOL_VERSION,
  PtyFrameDecoder,
  type PtyEvent,
  type PtyRequest,
  type PtyResults
} from '@quirky/protocol'
import { SessionManager, type DataSink, type SessionManagerOptions } from './session'
import { SocketWriter } from './writer'

export type PtyServerOptions = Partial<Omit<SessionManagerOptions, 'home'>> & {
  home: string
  /** Called after a `shutdown` request has been answered and the server has stopped. */
  onShutdown?: () => void
}

export type PtyServer = {
  readonly manager: SessionManager
  readonly socketPath: string
  readonly token: string
  /** Kills every session, closes all connections and removes `pty.sock` and `pty.pid`. */
  stop(): Promise<void>
}

type Connection = {
  socket: Bun.Socket<Connection>
  writer: SocketWriter
  decoder: PtyFrameDecoder
  sink: DataSink
  authenticated: boolean
  closed: boolean
}

const MAX_UNIX_PATH_BYTES = 103

/**
 * Serves the PTY host protocol on `<home>/pty.sock`. Writes a fresh token to `pty.token` and
 * the pid to `pty.pid`; the caller is responsible for ensuring no other host owns the home.
 */
export function startPtyServer(options: PtyServerOptions): PtyServer {
  const { home } = options
  const socketPath = join(home, 'pty.sock')
  if (Buffer.byteLength(socketPath) > MAX_UNIX_PATH_BYTES) throw new Error(`socket path too long: ${socketPath}`)
  mkdirSync(home, { recursive: true, mode: 0o700 })

  const token = randomBytes(32).toString('hex')
  writePrivate(join(home, 'pty.token'), token)
  writePrivate(join(home, 'pty.pid'), String(process.pid))
  rmSync(socketPath, { force: true })

  const manager = new SessionManager({ home, logMaxBytes: options.logMaxBytes, tailBytes: options.tailBytes })
  const connections = new Set<Connection>()

  const send = (conn: Connection, message: unknown) => {
    if (conn.closed) return
    if (!conn.writer.send(encodePtyJson(message))) conn.socket.end()
  }

  const stopSession = manager.onExit((event: PtyEvent) => {
    for (const conn of connections) if (conn.authenticated) send(conn, event)
  })

  const listener = Bun.listen<Connection>({
    unix: socketPath,
    socket: {
      open(socket) {
        const conn: Connection = {
          socket,
          writer: new SocketWriter(socket),
          decoder: new PtyFrameDecoder(),
          authenticated: false,
          closed: false,
          sink: (sessionId, bytes) => {
            if (!conn.writer.send(encodePtyData(sessionId, bytes))) conn.socket.end()
          }
        }
        socket.data = conn
        connections.add(conn)
      },
      data(socket, chunk) {
        const conn = socket.data
        try {
          for (const frame of conn.decoder.push(chunk)) {
            if (frame.kind === 'data') {
              if (!conn.authenticated) throw new Error('hello required')
              manager.write(frame.sessionId, frame.bytes)
            } else {
              handleMessage(conn, frame.message)
            }
          }
        } catch (error) {
          console.error('closing connection:', error instanceof Error ? error.message : error)
          conn.writer.endAfterFlush()
        }
      },
      drain(socket) {
        socket.data.writer.drain()
      },
      close(socket) {
        dropConnection(socket.data)
      },
      error(socket, error) {
        console.error('socket error:', error.message)
        dropConnection(socket.data)
      }
    }
  })
  chmodSync(socketPath, 0o600)

  function dropConnection(conn: Connection | undefined) {
    if (!conn || conn.closed) return
    conn.closed = true
    connections.delete(conn)
    manager.dropSink(conn.sink)
  }

  function handleMessage(conn: Connection, message: unknown) {
    const request = message as PtyRequest
    if (typeof request !== 'object' || request === null || typeof request.id !== 'number') {
      throw new Error('malformed request')
    }
    const { id } = request
    const reply = (result: unknown) => send(conn, { id, ok: true, result })
    const fail = (error: unknown) => send(conn, { id, ok: false, error: error instanceof Error ? error.message : String(error) })

    if (!conn.authenticated) {
      const rejection = authenticate(request)
      if (rejection) {
        fail(new Error(rejection))
        conn.writer.endAfterFlush()
        return
      }
      conn.authenticated = true
      reply({ version: PTY_PROTOCOL_VERSION, pid: process.pid } satisfies PtyResults['hello'])
      return
    }

    try {
      const result = dispatch(conn, request)
      if (result instanceof Promise) result.then(reply, fail)
      else reply(result)
    } catch (error) {
      fail(error)
    }
  }

  function authenticate(request: PtyRequest): string | null {
    if (request.type !== 'hello') return 'hello required before any other request'
    if (request.token !== token) return 'invalid token'
    if (request.version !== PTY_PROTOCOL_VERSION) {
      return `unsupported protocol version ${request.version}, host speaks ${PTY_PROTOCOL_VERSION}`
    }
    return null
  }

  function dispatch(conn: Connection, request: PtyRequest): unknown {
    switch (request.type) {
      case 'hello':
        return { version: PTY_PROTOCOL_VERSION, pid: process.pid }
      case 'create':
        return manager.create(request)
      case 'resize':
        manager.resize(request.sessionId, request.cols, request.rows)
        return {}
      case 'kill':
        manager.kill(request.sessionId, request.signal)
        return {}
      case 'forget':
        manager.forget(request.sessionId)
        return {}
      case 'list':
        return manager.list()
      case 'subscribe':
        return manager.subscribe(request.sessionId, conn.sink)
      case 'unsubscribe':
        manager.unsubscribe(request.sessionId, conn.sink)
        return {}
      case 'read':
        return manager.read(request.sessionId, request.lines)
      case 'shutdown':
        return manager.shutdown().then(() => {
          void conn.writer.flushed().then(async () => {
            await stop()
            options.onShutdown?.()
          })
          return {}
        })
      default:
        throw new Error(`unknown request type: ${(request as { type: string }).type}`)
    }
  }

  let stopping: Promise<void> | null = null
  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopSession()
      await manager.shutdown()
      listener.stop(true)
      rmSync(socketPath, { force: true })
      if (readPid(join(home, 'pty.pid')) === process.pid) rmSync(join(home, 'pty.pid'), { force: true })
    })()
    return stopping
  }

  console.log(`quirky-pty ${process.pid} listening on ${socketPath}`)
  return { manager, socketPath, token, stop }
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function readPid(path: string): number {
  try {
    return Number(readFileSync(path, 'utf8'))
  } catch {
    return NaN
  }
}
