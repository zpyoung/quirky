import { chmodSync, rmSync } from 'node:fs'
import { nextConnId, type RpcHandler } from './rpc-handler'
import type { Core } from './service'
import type { ClientConn } from './types'

export type SocketServerOptions = {
  /** Where to listen; see `socketPath`. */
  path: string
  core: Core
  /** Handles one JSON-RPC line from a connection, including the token check on `client.hello`. */
  handle: RpcHandler
  log: (message: string) => void
}

export type SocketServer = { path: string; stop(): Promise<void> }

const MAX_LINE_BYTES = 16 * 1024 * 1024

type SocketState = {
  conn: ClientConn
  decoder: TextDecoder
  /** Bytes received since the last newline. */
  pending: string
  /** Bytes accepted by `sendText` but not yet taken by the kernel. */
  outbound: Uint8Array | null
  ending: boolean
  /** Set while lines must run in order, i.e. until `client.hello` has completed. */
  gate: Promise<unknown> | null
}

/**
 * Serves newline-delimited JSON-RPC on a unix socket (mode 0600) for the CLI. A stale file at
 * `path` is removed first. A connection that sends a line over 16 MiB, complete or not, is closed and the line is never dispatched.
 */
export function startSocketServer(options: SocketServerOptions): SocketServer {
  const { core, handle, log } = options
  rmSync(options.path, { force: true })

  const flush = (socket: Bun.Socket<SocketState>) => {
    const state = socket.data
    while (state.outbound && state.outbound.length > 0) {
      const written = socket.write(state.outbound)
      if (written <= 0) return
      state.outbound = written >= state.outbound.length ? null : state.outbound.subarray(written)
    }
    if (state.ending) socket.end()
  }

  const enqueue = (socket: Bun.Socket<SocketState>, text: string) => {
    const state = socket.data
    if (state.ending) return
    const bytes = new TextEncoder().encode(`${text}\n`)
    if (!state.outbound) state.outbound = bytes
    else {
      const joined = new Uint8Array(state.outbound.length + bytes.length)
      joined.set(state.outbound)
      joined.set(bytes, state.outbound.length)
      state.outbound = joined
    }
    flush(socket)
  }

  const dispatchLine = (socket: Bun.Socket<SocketState>, line: string) => {
    const state = socket.data
    const run = async () => {
      if (state.ending || state.conn.closed) return
      try {
        if ((await handle(state.conn, line)) === 'close') {
          state.ending = true
          flush(socket)
        }
      } catch (error) {
        log(`socket rpc failed: ${(error as Error)?.stack ?? error}`)
      }
    }
    // after hello, calls run concurrently as on the WebSocket; a blocking call must not hold up the rest
    if (state.conn.role !== null && state.gate === null) {
      void run()
      return
    }
    const task = (state.gate ?? Promise.resolve()).then(run)
    state.gate = task
    void task.then(() => {
      if (state.gate === task) state.gate = null
    })
  }

  const listener = Bun.listen<SocketState>({
    unix: options.path,
    socket: {
      open(socket) {
        const conn: ClientConn = {
          id: nextConnId(),
          role: null,
          subscribed: false,
          closed: false,
          transport: 'socket',
          streams: new Map(),
          streamClosers: new Map(),
          nextStreamId: 1,
          sendText: (text) => enqueue(socket, text),
          sendBinary: () => {
            throw new Error('this method needs the WebSocket transport')
          }
        }
        socket.data = { conn, decoder: new TextDecoder(), pending: '', outbound: null, ending: false, gate: null }
        core.addClient(conn)
      },
      data(socket, chunk) {
        const state = socket.data
        if (state.ending) return
        const rejectOversized = () => {
          log(`socket connection ${state.conn.id} sent a line over ${MAX_LINE_BYTES} bytes; closing`)
          state.pending = ''
          state.ending = true
          state.outbound = null
          socket.end()
        }
        state.pending += state.decoder.decode(chunk, { stream: true })
        let newline = state.pending.indexOf('\n')
        while (newline !== -1) {
          const line = state.pending.slice(0, newline)
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) return rejectOversized()
          state.pending = state.pending.slice(newline + 1)
          if (line.trim() !== '') dispatchLine(socket, line)
          newline = state.pending.indexOf('\n')
        }
        if (Buffer.byteLength(state.pending) > MAX_LINE_BYTES) rejectOversized()
      },
      drain: flush,
      close(socket) {
        core.removeClient(socket.data.conn)
      },
      error(socket, error) {
        log(`socket connection ${socket.data?.conn.id} error: ${error.message}`)
      }
    }
  })
  chmodSync(options.path, 0o600)
  log(`listening on unix socket ${options.path}`)

  return {
    path: options.path,
    async stop() {
      listener.stop(true)
      rmSync(options.path, { force: true })
    }
  }
}
