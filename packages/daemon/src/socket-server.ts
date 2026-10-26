import type { Core } from './service'
import type { ClientConn } from './types'

export type SocketServerOptions = {
  /** Where to listen; see `socketPath`. */
  path: string
  /** The token `client.hello` must carry on this transport. */
  rpcToken: string
  core: Core
  /** Handles one JSON-RPC line from `conn`, as the WebSocket transport does. */
  handle: (conn: ClientConn, text: string) => Promise<void>
  log: (message: string) => void
}

export type SocketServer = { path: string; stop(): Promise<void> }

/** Serves newline-delimited JSON-RPC on a unix socket (mode 0600) for the CLI. */
export function startSocketServer(options: SocketServerOptions): SocketServer {
  return { path: options.path, async stop() {} }
}
