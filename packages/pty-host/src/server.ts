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
import { socketPath as resolveSocketPath } from '@quirky/protocol/node'
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
  /** Output of sessions whose subscribe response has not been sent yet; it follows the response. */
  holding: Map<string, Uint8Array[]>
  authenticated: boolean
  closed: boolean
}

/**
 * Serves the PTY host protocol on `socketPath(home, 'pty.sock')`. Writes a fresh token to `pty.token` and
 * the pid to `pty.pid`; the caller is responsible for ensuring no other host owns the home.
 */
export function startPtyServer(options: PtyServerOptions): PtyServer {
  const { home } = options
  const socketPath = resolveSocketPath(home, 'pty.sock')
  mkdirSync(home, { recursive: true, mode: 0o700 })

  const token = randomBytes(32).toString('hex')
  writePrivate(join(home, 'pty.token'), token)
  writePrivate(join(home, 'pty.pid'), String(process.pid))
  rmSync(socketPath, { force: true })

  const manager = new SessionManager({
    home,
    logMaxBytes: options.logMaxBytes,
    tailBytes: options.tailBytes,
    checkpointIntervalMs: options.checkpointIntervalMs,
    shellReadyTimeoutMs: options.shellReadyTimeoutMs
  })
  const connections = new Set<Connection>()

  const send = (conn: Connection, message: unknown) => {
    if (conn.closed) return
    if (!conn.writer.send(encodePtyJson(message))) conn.socket.end()
  }

  const broadcast = (event: PtyEvent) => {
    for (const conn of connections) if (conn.authenticated) send(conn, event)
  }
  const stopExitEvents = manager.onExit(broadcast)
  const stopFactEvents = manager.onFact(broadcast)

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
          holding: new Map(),
          sink: (sessionId, bytes) => {
            const held = conn.holding.get(sessionId)
            if (held) held.push(bytes.slice())
            else if (!conn.writer.send(encodePtyData(sessionId, bytes))) conn.socket.end()
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
        manager.kill(request.sessionId, request.signal, request.reason)
        return {}
      case 'forget':
        manager.forget(request.sessionId)
        return {}
      case 'list':
        return manager.list()
      case 'subscribe':
        return subscribe(conn, request)
      case 'unsubscribe':
        manager.unsubscribe(request.sessionId, conn.sink)
        return {}
      case 'read':
        return manager.read(request.sessionId, request.lines)
      case 'snapshot':
        return manager.snapshot(request.sessionId)
      case 'history':
        return manager.history(request.sessionId, { lines: request.lines, before: request.before, format: request.format })
      case 'clear':
        return manager.clear(request.sessionId).then(() => ({}))
      case 'resetModes':
        return manager.resetModes(request.sessionId).then(() => ({}))
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

  /**
   * Output can start flowing as soon as the manager registers the sink, which is before the response
   * is built. It is held back here so the first DATA frame follows the response.
   */
  function subscribe(conn: Connection, request: Extract<PtyRequest, { type: 'subscribe' }>): Promise<unknown> {
    const { sessionId } = request
    const held: Uint8Array[] = []
    conn.holding.set(sessionId, held)
    return manager.subscribe(sessionId, conn.sink, { mode: request.mode, historyLines: request.historyLines }).then(
      (result) => {
        // the reply is sent in a microtask after this returns; a timer runs after it
        setTimeout(() => {
          conn.holding.delete(sessionId)
          for (const bytes of held) conn.sink(sessionId, bytes)
        }, 0)
        return result
      },
      (error) => {
        conn.holding.delete(sessionId)
        throw error
      }
    )
  }

  let stopping: Promise<void> | null = null
  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopExitEvents()
      stopFactEvents()
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
