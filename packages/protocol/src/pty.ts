/**
 * The PTY host's control protocol, carried as PTY_JSON frames (./frames.ts) over the unix socket
 * at `<QUIRKY_HOME>/pty.sock`. The daemon is normally its only client.
 *
 * Every request carries a numeric `id` and gets exactly one response with the same id. Messages
 * without an id are events. The first request on a connection must be `hello` with the token from
 * `<QUIRKY_HOME>/pty.token`; anything else closes the connection.
 */

export const PTY_PROTOCOL_VERSION = 2

/** Whether the shell has printed Quirky's ready marker; `unsupported` when the shell gets no wrapper. */
export type ShellState = 'pending' | 'ready' | 'timed_out' | 'unsupported'

/** Why a session ended: the process left on its own, was killed on request, or the host went away. */
export type ExitCause = 'exited' | 'killed' | 'host-restart' | 'host-lost'

/**
 * Something the terminal reported out of band: a bell, a finished command, a new title or cwd, a
 * prompt mark, the body of an OSC 7501 program-status report, or a program's own notification
 * (OSC 9, 99 or 777) with its text already cleaned.
 */
export type PtyFact =
  | { kind: 'bell' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'title'; title: string }
  | { kind: 'cwd'; cwd: string }
  | { kind: 'prompt' }
  | { kind: 'program-status'; body: string }
  | { kind: 'notification'; title: string | null; body: string; occasion: 'always' | 'unfocused' | 'invisible' }

export type PtySessionInfo = {
  sessionId: string
  /** `running` has a live process, `exited` finished for good, `restorable` is stored and can be restarted. */
  state: 'running' | 'exited' | 'restorable'
  /** 0 for a stored session. */
  pid: number
  alive: boolean
  exitCode: number | null
  exitSignal: string | null
  exitCause: ExitCause | null
  cols: number
  rows: number
  argv: string[]
  /** The last cwd the shell reported, else the start cwd. */
  cwd: string
  title: string | null
  shellState: ShellState
  createdAt: number
  /** Total bytes of output produced so far. */
  offset: number
}

/** What `subscribe` returns: the replay to paint before live output, and where live output resumes. */
export type PtySubscription = {
  /** Base64 bytes that rebuild the screen; the first DATA frame after the response starts at `offset`. */
  replay: string
  offset: number
  /** Pass to `history` as `before` to page further back; null when there is nothing older. */
  historyCursor: string | null
  cols: number
  rows: number
  shellState: ShellState
  /** False for a session that has exited or is stored: no DATA frames will follow. */
  live: boolean
}

/** The visible screen as ANSI plus the emulator state a viewer needs to continue from it. */
export type PtySnapshot = {
  ansi: string
  cols: number
  rows: number
  cursor: { x: number; y: number }
  modes: { alternateScreen: boolean; bracketedPaste: boolean; mouseTracking: boolean; applicationCursor: boolean }
  cwd: string
  title: string | null
  shellState: ShellState
  offset: number
}

/** One page of scrollback, oldest line first. */
export type PtyHistoryPage = {
  lines: string[]
  /** Pass as `before` for the next older page; null when this page reaches the start. */
  cursor: string | null
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
      /** Wrap the shell so it announces readiness; reflected in the session's `shellState`. */
      shellReady?: boolean
      /** How long to wait for the ready marker before `shellState` becomes `timed_out`; default 15000. */
      shellReadyTimeoutMs?: number
      /** Restart a stored `restorable` session of this id instead of creating a fresh one. */
      restore?: boolean
    }
  | { id: number; type: 'resize'; sessionId: string; cols: number; rows: number }
  /** A `reason` marks the exit as requested and defaults the signal to SIGKILL. */
  | { id: number; type: 'kill'; sessionId: string; signal?: string; reason?: 'killed' }
  /** Drops a session's state and log, in memory or stored; kills it first if still alive. */
  | { id: number; type: 'forget'; sessionId: string }
  | { id: number; type: 'list' }
  /**
   * Starts sending this session's output to this connection as PTY_DATA frames. The response's
   * `replay` ends exactly at `offset`, and the first DATA frame after the response starts there.
   * Mode `screen` (default) composes `historyLines` of scrollback with the screen; `raw` replays the
   * hot output tail from a line boundary.
   */
  | { id: number; type: 'subscribe'; sessionId: string; mode?: 'screen' | 'raw'; historyLines?: number }
  | { id: number; type: 'unsubscribe'; sessionId: string }
  /** The visible screen plus up to `lines` of scrollback from the host's emulator, as text. */
  | { id: number; type: 'read'; sessionId: string; lines: number }
  | { id: number; type: 'snapshot'; sessionId: string }
  /** A page of scrollback ending just before the `before` cursor, or at the newest line when absent. */
  | { id: number; type: 'history'; sessionId: string; lines?: number; before?: string; format?: 'text' | 'ansi' }
  /** Kills every session and exits; for tests and uninstall. */
  | { id: number; type: 'shutdown' }

export type PtyResults = {
  hello: { version: number; pid: number }
  create: { pid: number; restored: boolean; cwd: string; cols: number; rows: number }
  resize: Record<string, never>
  kill: Record<string, never>
  forget: Record<string, never>
  list: PtySessionInfo[]
  subscribe: PtySubscription
  unsubscribe: Record<string, never>
  read: { lines: string[]; cols: number; rows: number; alt: boolean }
  snapshot: PtySnapshot
  history: PtyHistoryPage
  shutdown: Record<string, never>
}

export type PtyResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export type PtyEvent =
  | { type: 'exit'; sessionId: string; exitCode: number | null; exitSignal: string | null; exitCause: ExitCause }
  | { type: 'fact'; sessionId: string; fact: PtyFact }
