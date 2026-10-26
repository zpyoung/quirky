import { rmSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { bytesToBase64, type PtyEvent, type PtyRequest, type PtyResults, type PtySessionInfo } from '@quirky/protocol'
import { DEFAULT_LOG_MAX_BYTES, RotatingLog } from './log'
import { spawnPty, type PtyProcess } from './pty-process'
import { TailBuffer } from './tail'

export const DEFAULT_TAIL_BYTES = 1024 * 1024
export const EMULATOR_SCROLLBACK = 200

/** Receives a session's output as it is produced. One sink stands for one subscribed connection. */
export type DataSink = (sessionId: string, bytes: Uint8Array) => void

export type SessionManagerOptions = {
  home: string
  logMaxBytes?: number
  tailBytes?: number
}

export type CreateParams = Omit<Extract<PtyRequest, { type: 'create' }>, 'id' | 'type'>

type Session = {
  sessionId: string
  proc: PtyProcess
  argv: string[]
  cwd: string
  cols: number
  rows: number
  createdAt: number
  dir: string
  log: RotatingLog
  tail: TailBuffer
  term: Terminal
  subscribers: Set<DataSink>
  alive: boolean
  exitCode: number | null
  finished: Promise<void>
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PTY_CLOSE_GRACE_MS = 500

/**
 * Owns every PTY session: the process, its on-disk log, the in-memory tail and the screen
 * emulator. Independent of the socket server so it can run in-process.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly exitListeners = new Set<(event: PtyEvent) => void>()
  private readonly logMaxBytes: number
  private readonly tailBytes: number
  private readonly home: string

  constructor(options: SessionManagerOptions) {
    this.home = options.home
    this.logMaxBytes = options.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES
    this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES
  }

  /** Calls `listener` whenever a session's process has exited and its output is fully captured. */
  onExit(listener: (event: PtyEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  create(params: CreateParams): PtyResults['create'] {
    const { sessionId, cwd, argv, env, cols, rows } = params
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
    if (this.sessions.has(sessionId)) throw new Error(`session already exists: ${sessionId}`)
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) throw new Error('argv must be a non-empty string array')
    assertSize(cols, rows)

    const dir = join(this.home, 'sessions', sessionId)
    const log = new RotatingLog(dir, this.logMaxBytes)
    const tail = new TailBuffer(this.tailBytes)
    const term = new Terminal({ cols, rows, scrollback: EMULATOR_SCROLLBACK, allowProposedApi: true })
    const subscribers = new Set<DataSink>()
    let session: Session | undefined
    let processDone = false
    let ptyClosed = false
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => (finish = resolve))

    const finalize = () => {
      if (!session || !session.alive) return
      session.alive = false
      session.exitCode = session.proc.exitCode
      log.close()
      finish()
      if (this.sessions.get(sessionId) === session) {
        const event: PtyEvent = { type: 'exit', sessionId, exitCode: session.exitCode, exitSignal: null, exitCause: 'exited' }
        for (const listener of this.exitListeners) listener(event)
      }
    }

    let proc: PtyProcess
    try {
      proc = spawnPty(argv, {
        cwd,
        env,
        cols,
        rows,
        onData: (bytes) => {
          if (!session?.alive) return
          const chunk = bytes.slice()
          log.append(chunk)
          tail.append(chunk)
          term.write(chunk)
          for (const sink of subscribers) {
            try {
              sink(sessionId, chunk)
            } catch (error) {
              console.error(`sink for ${sessionId} failed:`, error)
            }
          }
        },
        onClose: () => {
          ptyClosed = true
          if (processDone) finalize()
        }
      })
    } catch (error) {
      log.close()
      term.dispose()
      rmSync(dir, { recursive: true, force: true })
      throw error
    }

    session = {
      sessionId,
      proc,
      argv: [...argv],
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      dir,
      log,
      tail,
      term,
      subscribers,
      alive: true,
      exitCode: null,
      finished
    }
    this.sessions.set(sessionId, session)

    term.onData((reply) => {
      if (session!.alive && subscribers.size === 0) proc.terminal.write(reply)
    })
    void proc.exited.then(() => {
      processDone = true
      if (ptyClosed) finalize()
      else setTimeout(finalize, PTY_CLOSE_GRACE_MS)
    })
    return { pid: proc.pid, restored: false, cwd, cols, rows }
  }

  /** Sends client input to the session's PTY. Ignored for unknown or exited sessions. */
  write(sessionId: string, bytes: Uint8Array): void {
    const session = this.sessions.get(sessionId)
    if (session?.alive) session.proc.terminal.write(bytes)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.require(sessionId)
    assertSize(cols, rows)
    session.cols = cols
    session.rows = rows
    session.term.resize(cols, rows)
    if (session.alive) session.proc.terminal.resize(cols, rows)
  }

  kill(sessionId: string, signal = 'SIGTERM'): void {
    const session = this.require(sessionId)
    const name = normalizeSignal(signal)
    if (session.alive) signalGroup(session.proc, name)
  }

  /** Drops the session's state and log, killing the process first if it is still running. */
  forget(sessionId: string): void {
    const session = this.require(sessionId)
    if (session.alive) signalGroup(session.proc, 'SIGKILL')
    this.sessions.delete(sessionId)
    session.log.close()
    session.subscribers.clear()
    session.term.dispose()
    rmSync(session.dir, { recursive: true, force: true })
  }

  list(): PtySessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      state: s.alive ? ('running' as const) : ('exited' as const),
      pid: s.proc.pid,
      alive: s.alive,
      exitCode: s.exitCode,
      exitSignal: null,
      exitCause: s.alive ? null : ('exited' as const),
      cols: s.cols,
      rows: s.rows,
      argv: s.argv,
      cwd: s.cwd,
      title: null,
      shellState: 'unsupported' as const,
      createdAt: s.createdAt,
      offset: s.tail.total
    }))
  }

  /**
   * Registers `sink` for the session's output. The returned replay ends exactly at `offset`, and
   * the sink's first chunk starts there. Subscribing the same sink again just refreshes the replay.
   */
  subscribe(sessionId: string, sink: DataSink): PtyResults['subscribe'] {
    const session = this.require(sessionId)
    session.subscribers.add(sink)
    return {
      replay: bytesToBase64(session.tail.replay()),
      offset: session.tail.total,
      historyCursor: null,
      cols: session.cols,
      rows: session.rows,
      shellState: 'unsupported',
      live: session.alive
    }
  }

  unsubscribe(sessionId: string, sink: DataSink): void {
    this.require(sessionId).subscribers.delete(sink)
  }

  /** Removes `sink` from every session; called when its connection goes away. */
  dropSink(sink: DataSink): void {
    for (const session of this.sessions.values()) session.subscribers.delete(sink)
  }

  /**
   * The visible screen plus up to `lines` rows of scrollback, with trailing whitespace trimmed from
   * each row and trailing blank rows dropped. A blank screen reads as `[]`; `rows` and `cols` always
   * report the emulator size.
   */
  async read(sessionId: string, lines: number): Promise<PtyResults['read']> {
    const session = this.require(sessionId)
    if (!Number.isInteger(lines) || lines < 0) throw new Error('lines must be a non-negative integer')
    const { term } = session
    await new Promise<void>((resolve) => term.write('', resolve))
    if (!this.sessions.has(sessionId)) throw new Error(`unknown session: ${sessionId}`)
    const buffer = term.buffer.active
    const out: string[] = []
    for (let y = Math.max(0, buffer.baseY - lines); y < buffer.baseY + term.rows; y++) {
      out.push(buffer.getLine(y)?.translateToString(true).trimEnd() ?? '')
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return { lines: out, cols: term.cols, rows: term.rows, alt: buffer.type === 'alternate' }
  }

  subscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.subscribers.size ?? 0
  }

  isAlive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.alive ?? false
  }

  /** Stops every running session, escalating to SIGKILL for any that ignore SIGHUP. */
  async shutdown(): Promise<void> {
    const running = [...this.sessions.values()].filter((s) => s.alive)
    for (const session of running) signalGroup(session.proc, 'SIGHUP')
    await settle(running, 1000)
    const stubborn = running.filter((s) => s.alive)
    for (const session of stubborn) signalGroup(session.proc, 'SIGKILL')
    await settle(stubborn, 1000)
    for (const session of this.sessions.values()) {
      session.log.close()
      session.term.dispose()
    }
  }

  private require(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    return session
  }
}

function assertSize(cols: number, rows: number): void {
  const valid = (n: number) => Number.isInteger(n) && n > 0 && n <= 10000
  if (!valid(cols) || !valid(rows)) throw new Error(`invalid terminal size: ${cols}x${rows}`)
}

function normalizeSignal(signal: string): string {
  const name = signal.startsWith('SIG') ? signal : `SIG${signal}`
  if (!(name in constants.signals)) throw new Error(`invalid signal: ${signal}`)
  return name
}

function signalGroup(proc: PtyProcess, signal: string): void {
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      process.kill(proc.pid, signal)
    } catch {
      // already gone
    }
  }
}

async function settle(sessions: Session[], timeoutMs: number): Promise<void> {
  if (sessions.length === 0) return
  await Promise.race([Promise.all(sessions.map((s) => s.finished)), Bun.sleep(timeoutMs)])
}
