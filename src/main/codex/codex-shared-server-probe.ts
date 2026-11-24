import { createConnection } from 'node:net'
import { codexDaemonSocketPath } from './codex-daemon-socket-path-guard'

/** `absent` only on proof; anything the probe cannot settle is `unknown`. */
export type CodexSharedServerState = 'live' | 'absent' | 'unknown'

const CONNECT_TIMEOUT_MS = 1_000

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

// Why connect, not stat: a server that crashed leaves its socket file behind.
function probeSocket(socketPath: string): Promise<CodexSharedServerState> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath })
    const settle = (state: CodexSharedServerState): void => {
      socket.destroy()
      resolve(state)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle('unknown'))
    socket.once('connect', () => settle('live'))
    socket.once('error', (error) => {
      const code = errorCode(error)
      settle(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'absent' : 'unknown')
    })
  })
}

/** Whether Codex's shared server for this CODEX_HOME is accepting clients right now. */
export function probeCodexSharedServer(codexHome: string): Promise<CodexSharedServerState> {
  return probeSocket(codexDaemonSocketPath(codexHome))
}
