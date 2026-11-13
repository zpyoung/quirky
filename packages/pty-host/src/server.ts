import { Buffer } from 'node:buffer'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { inspect } from 'node:util'
import {
  base64ToBytes,
  encodePtyData,
  encodePtyJson,
  negotiatePtyVersion,
  ptyVersionRejection,
  PTY_PROTOCOL_MIN_VERSION,
  PTY_PROTOCOL_VERSION,
  PtyFrameDecoder,
  type PtyEvent,
  type PtyRequest,
  type PtyResults,
} from '@quirky/protocol'
import { socketPath as resolveSocketPath } from '@quirky/protocol/node'
import { SessionManager, type DataSink, type SessionManagerOptions } from './session'
import { SocketWriter } from './writer'

export type PtyServerOptions = Partial<Omit<SessionManagerOptions, 'home'>> & {
  home: string
  /** Called after a `shutdown` request has been answered and `stop()` has settled; defined on rejection. */
  onShutdown?: (error?: unknown) => void
  /** Bounds encoded output queued or held for each session; defaults to 4 MiB. */
  maxSessionQueuedBytes?: number
  /** Bounds all encoded output queued or held for each connection; defaults to 32 MiB. */
  maxConnectionQueuedBytes?: number
}

export type PtyServer = {
  readonly manager: SessionManager
  readonly socketPath: string
  readonly token: string
  /** Kills every session, closes all connections and removes `pty.sock` and `pty.pid`. */
  stop(): Promise<void>
}

type HeldOutput = { frames: Uint8Array[]; bytes: number; lagged: boolean; cancelled: boolean }

type Connection = {
  socket: Bun.Socket<Connection>
  writer: SocketWriter
  decoder: PtyFrameDecoder
  sink: DataSink
  /** Output held until the matching subscribe response has been sent. */
  holding: Map<string, HeldOutput>
  pendingHolds: Map<string, Set<HeldOutput>>
  heldBytes: number
  subscribed: Set<string>
  protocolVersion: number | null
  authenticated: boolean
  sessionLagged: boolean
  closed: boolean
}

/**
 * Serves the PTY host protocol on `socketPath(home, 'pty.sock')`. Writes a fresh token to `pty.token` and
 * the pid to `pty.pid`; the caller is responsible for ensuring no other host owns the home.
 */
export function startPtyServer(options: PtyServerOptions): PtyServer {
  const { home, maxSessionQueuedBytes = 4_194_304, maxConnectionQueuedBytes = 33_554_432 } = options
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
    shellReadyTimeoutMs: options.shellReadyTimeoutMs,
    processRunner: options.processRunner,
    shutdownDrainMs: options.shutdownDrainMs,
    storedIndex: options.storedIndex
  })
  const connections = new Set<Connection>()

  const sendFrame = (conn: Connection, frame: Uint8Array, tag?: string) => {
    if (conn.closed) return
    if (conn.heldBytes + conn.writer.queuedBytes + frame.byteLength > maxConnectionQueuedBytes ||
        !conn.writer.send(frame, tag)) severConnection(conn)
  }

  const send = (conn: Connection, message: unknown) => {
    if (!conn.closed) sendFrame(conn, encodePtyJson(message))
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
          writer: new SocketWriter(socket, maxConnectionQueuedBytes),
          decoder: new PtyFrameDecoder(),
          protocolVersion: null,
          authenticated: false,
          sessionLagged: false,
          closed: false,
          holding: new Map(),
          pendingHolds: new Map(),
          heldBytes: 0,
          subscribed: new Set(),
          sink: (sessionId, bytes) => {
            if (conn.closed || !conn.subscribed.has(sessionId)) return
            const frameLength = 6 + Buffer.byteLength(sessionId, 'utf8') + bytes.byteLength
            if (conn.heldBytes + conn.writer.queuedBytes + frameLength > maxConnectionQueuedBytes) {
              severConnection(conn)
              return
            }

            const held = conn.holding.get(sessionId)
            const sessionQueuedBytes = (held?.bytes ?? 0) + conn.writer.remainingForTag(sessionId)
            if (sessionQueuedBytes + frameLength > maxSessionQueuedBytes) {
              lagSession(conn, sessionId)
              return
            }

            const frame = encodePtyData(sessionId, bytes)
            if (!held) {
              sendFrame(conn, frame, sessionId)
            } else {
              held.frames.push(frame)
              held.bytes += frame.byteLength
              conn.heldBytes += frame.byteLength
            }
          }
        }
        socket.data = conn
        connections.add(conn)
      },
      data(socket, chunk) {
        const conn = socket.data
        try {
          for (const frame of conn.decoder.push(chunk)) {
            if (conn.closed) break
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
    for (const holds of conn.pendingHolds.values()) {
      for (const held of holds) {
        held.cancelled = true
        held.frames.length = 0
        held.bytes = 0
      }
    }
    conn.pendingHolds.clear()
    conn.holding.clear()
    conn.subscribed.clear()
    conn.heldBytes = 0
    conn.writer.clear()
  }

  function severConnection(conn: Connection) {
    if (conn.closed) return
    dropConnection(conn)
    conn.socket.end()
  }

  function clearHolding(conn: Connection, sessionId: string, cancelled = true) {
    const held = conn.holding.get(sessionId)
    if (!held) return
    if (cancelled) held.cancelled = true
    conn.holding.delete(sessionId)
    conn.heldBytes -= held.bytes
    held.frames.length = 0
    held.bytes = 0
  }
  function cancelSubscribeAttempts(conn: Connection, sessionId: string) {
    const attempts = conn.pendingHolds.get(sessionId)
    if (!attempts) return
    for (const held of attempts) {
      held.cancelled = true
      held.frames.length = 0
      held.bytes = 0
    }
    conn.pendingHolds.delete(sessionId)
  }

  function forgetSubscribeAttempt(conn: Connection, sessionId: string, held: HeldOutput) {
    const attempts = conn.pendingHolds.get(sessionId)
    if (!attempts) return
    attempts.delete(held)
    if (attempts.size === 0) conn.pendingHolds.delete(sessionId)
  }

  function purgeSessionFrames(conn: Connection, sessionId: string) {
    clearHolding(conn, sessionId)
    cancelSubscribeAttempts(conn, sessionId)
    conn.subscribed.delete(sessionId)
    conn.writer.dropTag(sessionId)
  }

  function purgeSession(sessionId: string, unsubscribe = true) {
    for (const conn of connections) {
      if (unsubscribe) manager.unsubscribe(sessionId, conn.sink)
      purgeSessionFrames(conn, sessionId)
    }
  }

  function lagSession(conn: Connection, sessionId: string) {
    if (conn.closed) return
    if (!conn.sessionLagged) {
      severConnection(conn)
      return
    }

    conn.subscribed.delete(sessionId)
    manager.unsubscribe(sessionId, conn.sink)
    const held = conn.holding.get(sessionId)
    if (held) {
      conn.heldBytes -= held.bytes
      held.frames.length = 0
      held.bytes = 0
      held.lagged = true
    }
    conn.writer.dropTag(sessionId)
    if (!held) send(conn, { type: 'lagged', sessionId })
  }

  function handleMessage(conn: Connection, message: unknown) {
    const request = message as PtyRequest
    if (typeof request !== 'object' || request === null || typeof request.id !== 'number') {
      throw new Error('malformed request')
    }
    const { id } = request
    const reply = (result: unknown) => send(conn, { id, ok: true, result })
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (request.type !== 'writeAccepted') {
        send(conn, { id, ok: false, error: message })
        return
      }
      if (error instanceof Error && 'code' in error && 'acceptedBytes' in error) {
        const code = error.code
        const acceptedBytes = error.acceptedBytes
        if (
          (code === 'PTY_WRITE_REJECTED' || code === 'PTY_WRITE_UNCERTAIN') &&
          (acceptedBytes === null || (typeof acceptedBytes === 'number' && Number.isSafeInteger(acceptedBytes) && acceptedBytes >= 0))
        ) {
          send(conn, { id, ok: false, error: message, code, acceptedBytes })
          return
        }
      }
      send(conn, { id, ok: false, error: message, code: 'PTY_WRITE_REJECTED', acceptedBytes: 0 })
    }

    if (!conn.authenticated) {
      const rejection = authenticate(conn, request)
      if (rejection) {
        fail(new Error(rejection))
        conn.writer.endAfterFlush()
        return
      }
      conn.authenticated = true
      reply({ version: conn.protocolVersion!, pid: process.pid } satisfies PtyResults['hello'])
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

  function authenticate(conn: Connection, request: PtyRequest): string | null {
    if (request.type !== 'hello') return 'hello required before any other request'
    if (request.token !== token) return 'invalid token'
    const version = negotiatePtyVersion(request, {
      min: PTY_PROTOCOL_MIN_VERSION,
      max: PTY_PROTOCOL_VERSION
    })
    if (version === null) return ptyVersionRejection(request.version, PTY_PROTOCOL_VERSION)
    conn.protocolVersion = version
    conn.sessionLagged = request.sessionLagged === true
    return null
  }

  function dispatch(conn: Connection, request: PtyRequest): unknown {
    switch (request.type) {
      case 'hello':
        return { version: conn.protocolVersion!, pid: process.pid }
      case 'create':
        return manager.create(request)
      case 'writeAccepted':
        return manager.writeAccepted(request.sessionId, base64ToBytes(request.bytes)).then(() => ({}))
      case 'resize':
        manager.resize(request.sessionId, request.cols, request.rows)
        return {}
      case 'kill':
        return manager.kill(request.sessionId, request.signal, request.reason).then(() => {
          if (!request.signal || request.signal === 'SIGTERM' || request.signal === 'TERM' ||
              request.signal === 'SIGKILL' || request.signal === 'KILL' || request.reason === 'killed') {
            purgeSession(request.sessionId)
          }
          return {}
        })
      case 'stopWithHistory':
        purgeSession(request.sessionId)
        return manager.stopWithHistory(request.sessionId).then(() => ({}))
      case 'forget':
        return manager.forget(request.sessionId).then(() => {
          purgeSession(request.sessionId, false)
          return {}
        })
      case 'list':
        return manager.list()
      case 'subscribe':
        return subscribe(conn, request)
      case 'unsubscribe':
        manager.unsubscribe(request.sessionId, conn.sink)
        purgeSessionFrames(conn, request.sessionId)
        return {}
      case 'read':
        return manager.read(request.sessionId, request.lines, request.unwrap === true)
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
            try {
              await stop()
              options.onShutdown?.()
            } catch (error) {
              const shutdownError = error ?? new Error('unknown shutdown error')
              if (options.onShutdown) options.onShutdown(shutdownError)
              else process.stderr.write(`[quirky-pty] shutdown failed: ${inspect(shutdownError)}\n`)
            }
          })
          return {}
        })
      default:
        throw new Error(`unknown request type: ${(request as { type: string }).type}`)
    }
  }

  function finishSubscribe(conn: Connection, sessionId: string, held: HeldOutput) {
    forgetSubscribeAttempt(conn, sessionId, held)
    if (conn.closed || held.cancelled) {
      if (!conn.subscribed.has(sessionId)) {
        try {
          manager.unsubscribe(sessionId, conn.sink)
        } catch {}
      }
      return
    }
    const isCurrent = conn.holding.get(sessionId) === held
    if (!isCurrent) return
    if (held.lagged) {
      conn.holding.delete(sessionId)
      send(conn, { type: 'lagged', sessionId })
      return
    }
    conn.holding.delete(sessionId)
    for (const frame of held.frames) {
      if (conn.closed) break
      held.bytes -= frame.byteLength
      conn.heldBytes -= frame.byteLength
      sendFrame(conn, frame, sessionId)
    }
    held.frames.length = 0
    held.bytes = 0
  }

  /**
   * Output can start flowing as soon as the manager registers the sink, which is before the response
   * is built. It is held back here so the first DATA frame follows the response.
   */
  function subscribe(conn: Connection, request: Extract<PtyRequest, { type: 'subscribe' }>): Promise<unknown> {
    const { sessionId } = request
    const wasSubscribed = conn.subscribed.has(sessionId)
    clearHolding(conn, sessionId, false)
    const held: HeldOutput = { frames: [], bytes: 0, lagged: false, cancelled: false }
    conn.holding.set(sessionId, held)
    const attempts = conn.pendingHolds.get(sessionId) ?? new Set<HeldOutput>()
    attempts.add(held)
    conn.pendingHolds.set(sessionId, attempts)
    conn.subscribed.add(sessionId)
    return manager.subscribe(sessionId, conn.sink, { mode: request.mode, historyLines: request.historyLines }).then(
      (result) => {
        // The reply is sent in a microtask before this timer runs.
        setTimeout(() => finishSubscribe(conn, sessionId, held), 0)
        return result
      },
      (error) => {
        if (held.lagged && !held.cancelled && conn.holding.get(sessionId) === held) {
          setTimeout(() => finishSubscribe(conn, sessionId, held), 0)
        } else {
          if (conn.holding.get(sessionId) === held) {
            clearHolding(conn, sessionId)
            if (!wasSubscribed) conn.subscribed.delete(sessionId)
          }
          forgetSubscribeAttempt(conn, sessionId, held)
        }
        throw error
      }
    )
  }

  let stopping: Promise<void> | null = null
  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopExitEvents()
      stopFactEvents()
      try {
        await manager.shutdown()
      } finally {
        try {
          listener.stop(true)
        } finally {
          try {
            if (readPid(join(home, 'pty.pid')) === process.pid) rmSync(join(home, 'pty.pid'), { force: true })
          } finally {
            rmSync(socketPath, { force: true })
          }
        }
      }
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
