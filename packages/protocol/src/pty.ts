/**
 * The PTY host's control protocol, carried as PTY_JSON frames (./frames.ts) over the unix socket
 * at `<QUIRKY_HOME>/pty.sock`. The daemon is normally its only client.
 *
 * Every request carries a numeric `id` and gets exactly one response with the same id. Messages
 * without an id are events. The first request on a connection must be `hello` with the token from
 * `<QUIRKY_HOME>/pty.token`; anything else closes the connection.
 */

export const PTY_PROTOCOL_VERSION = 1

export type PtySessionInfo = {
  sessionId: string
  pid: number
  alive: boolean
  exitCode: number | null
  cols: number
  rows: number
  argv: string[]
  cwd: string
  createdAt: number
  /** Total bytes of output produced so far. */
  offset: number
}

export type PtyRequest =
  | { id: number; type: 'hello'; token: string; version: number }
  | {
      id: number
      type: 'create'
      sessionId: string
      cwd: string
      argv: string[]
      env: Record<string, string>
      cols: number
      rows: number
    }
  | { id: number; type: 'resize'; sessionId: string; cols: number; rows: number }
  | { id: number; type: 'kill'; sessionId: string; signal?: string }
  /** Drops an exited session's state and log; kills it first if still alive. */
  | { id: number; type: 'forget'; sessionId: string }
  | { id: number; type: 'list' }
  /**
   * Starts sending this session's output to this connection as PTY_DATA frames. The response's
   * `replay` (base64, up to 1 MiB, starting on a line boundary) ends exactly at `offset`, and
   * the first DATA frame after the response starts there.
   */
  | { id: number; type: 'subscribe'; sessionId: string }
  | { id: number; type: 'unsubscribe'; sessionId: string }
  /** The visible screen plus up to `lines` of scrollback from the host's emulator, as text. */
  | { id: number; type: 'read'; sessionId: string; lines: number }
  /** Kills every session and exits; for tests and uninstall. */
  | { id: number; type: 'shutdown' }

export type PtyResults = {
  hello: { version: number; pid: number }
  create: { pid: number }
  resize: Record<string, never>
  kill: Record<string, never>
  forget: Record<string, never>
  list: PtySessionInfo[]
  subscribe: { replay: string; offset: number }
  unsubscribe: Record<string, never>
  read: { lines: string[]; cols: number; rows: number; alt: boolean }
  shutdown: Record<string, never>
}

export type PtyResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export type PtyEvent = { type: 'exit'; sessionId: string; exitCode: number | null }
