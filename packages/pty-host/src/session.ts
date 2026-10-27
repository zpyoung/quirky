import { rmSync, statSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import {
  bytesToBase64,
  type ExitCause,
  type PtyEvent,
  type PtyHistoryPage,
  type PtyRequest,
  type PtyResults,
  type PtySessionInfo,
  type PtySnapshot
} from '@quirky/protocol'
import { ShellReadyBarrier } from './barrier'
import { descendantsOf } from './descendants'
import { writeCheckpoint } from './history/checkpoint'
import { DEFAULT_SEGMENT_BYTES, HistoryLog } from './history/log'
import { type SessionMeta, writeMeta } from './history/meta'
import { composeReplay, pageBefore, parseCursor, textRowsAbove } from './history/reader'
import { CheckpointScheduler, GROUND, MODE_RESET, rebuildScreen, type RestoredScreen } from './history/restore'
import { spawnPty, type PtyProcess } from './pty-process'
import { OutputScanner, type ScanFact } from './scanner'
import { Screen } from './screen'
import { type StoredSession, StoredSessions } from './stored'
import { TailBuffer } from './tail'

export const DEFAULT_TAIL_BYTES = 256 * 1024
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 5000
export const DEFAULT_SHELL_READY_TIMEOUT_MS = 15000

const ERASE_SCREEN_AND_SCROLLBACK = new TextEncoder().encode('\x1b[H\x1b[2J\x1b[3J')

const DEFAULT_HISTORY_LINES = 2000
const MAX_HISTORY_LINES = 10000

/** Receives a session's output as it is produced. One sink stands for one subscribed connection. */
export type DataSink = (sessionId: string, bytes: Uint8Array) => void

export type SessionManagerOptions = {
  home: string
  /** Size at which a history segment rotates; the log keeps the newest one to two segments. */
  logMaxBytes?: number
  tailBytes?: number
  checkpointIntervalMs?: number
  /** Ready-marker timeout for sessions whose create request does not set one. */
  shellReadyTimeoutMs?: number
}

export type CreateParams = Omit<Extract<PtyRequest, { type: 'create' }>, 'id' | 'type'>

export type SubscribeOptions = { mode?: 'screen' | 'raw'; historyLines?: number }

export type HistoryOptions = { lines?: number; before?: string; format?: 'text' | 'ansi' }

type Held = { kind: 'output'; bytes: Uint8Array } | { kind: 'resize'; cols: number; rows: number }

type Listener = (event: PtyEvent) => void

type Session = {
  sessionId: string
  proc: PtyProcess
  argv: string[]
  startCwd: string
  /** The last directory the shell reported, else where it started. */
  cwd: string
  title: string | null
  cols: number
  rows: number
  createdAt: number
  dir: string
  log: HistoryLog
  tail: TailBuffer
  screen: Screen
  scanner: OutputScanner
  barrier: ShellReadyBarrier
  checkpointer: CheckpointScheduler
  subscribers: Set<DataSink>
  /** Screen subscriptions still settling; removing the sink cancels them so they never register it. */
  pendingSubs: Set<PendingSub>
  alive: boolean
  exitCode: number | null
  exitSignal: string | null
  exitCause: ExitCause | null
  endedAt: number | null
  killRequested: boolean
  forgotten: boolean
  /** Output and resizes waiting while a reader holds the screen still; null when nobody does. */
  held: Held[] | null
  holders: number
  onRelease: Array<() => void>
  metaTimer: ReturnType<typeof setTimeout> | null
  metaFailed: boolean
  finished: Promise<void>
  markFinished: () => void
}

type PendingSub = { sink: DataSink; cancelled: boolean }

/** The emulator is built before its session exists, so its replies find the session through this. */
type ReplyRoute = { session?: Session }

type StartInit = {
  sessionId: string
  argv: string[]
  env: Record<string, string>
  spawnCwd: string
  startCwd: string
  createdAt: number
  title: string | null
  cols: number
  rows: number
  dir: string
  log: HistoryLog
  tail: TailBuffer
  screen: Screen
  route: ReplyRoute
  shellReady: boolean
  shellReadyTimeoutMs: number
}

type Located = { live: Session; stored?: undefined } | { live?: undefined; stored: StoredSession }

/** The OSC 7501 capability reply a program gets when it asks `?`; no spaces, ST-terminated. */
const PROGRAM_STATUS_REPLY = new TextEncoder().encode(
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'
)
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PTY_CLOSE_GRACE_MS = 500
const META_WRITE_DELAY_MS = 250
const SHUTTING_DOWN = 'Terminal host is shutting down'

/**
 * Owns every PTY session: the process, its on-disk history, the hot tail and the screen emulator,
 * plus the sessions a previous host left on disk. Independent of the socket server so it can run
 * in-process.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly starting = new Set<string>()
  private readonly stored: StoredSessions
  private readonly exitListeners = new Set<Listener>()
  private readonly factListeners = new Set<Listener>()
  private readonly maxSegmentBytes: number
  private readonly tailBytes: number
  private readonly checkpointIntervalMs: number
  private readonly shellReadyTimeoutMs: number
  private readonly home: string
  private stopping = false

  constructor(options: SessionManagerOptions) {
    this.home = options.home
    this.maxSegmentBytes = options.logMaxBytes ?? DEFAULT_SEGMENT_BYTES
    this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS
    this.shellReadyTimeoutMs = options.shellReadyTimeoutMs ?? DEFAULT_SHELL_READY_TIMEOUT_MS
    this.stored = new StoredSessions(options.home)
  }

  /** Calls `listener` whenever a session has ended and its history is on disk. */
  onExit(listener: Listener): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Calls `listener` for each bell, finished command, title change and cwd change a session reports. */
  onFact(listener: Listener): () => void {
    this.factListeners.add(listener)
    return () => this.factListeners.delete(listener)
  }

  /**
   * Starts a session, or with `restore` starts a new shell in a stored `restorable` session's place,
   * under its old screen and history. A fresh create replaces any stored session with the same id.
   */
  async create(params: CreateParams): Promise<PtyResults['create']> {
    const { sessionId, argv, cols, rows } = params
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) throw new Error('argv must be a non-empty string array')
    assertSize(cols, rows)
    if (this.stopping) throw new Error(SHUTTING_DOWN)
    if (params.restore) return this.restore(params)
    if (this.sessions.has(sessionId) || this.starting.has(sessionId)) throw new Error(`session already exists: ${sessionId}`)
    return this.createFresh(params)
  }

  /**
   * Sends client input to the session's PTY, after the shell-ready barrier. Ignored for unknown,
   * stored and exited sessions.
   */
  write(sessionId: string, bytes: Uint8Array): void {
    const session = this.sessions.get(sessionId)
    if (session?.alive) session.barrier.input(bytes)
  }

  /** Resizes a live or exited session; a stored session has nothing to resize. */
  resize(sessionId: string, cols: number, rows: number): void {
    const { live } = this.locate(sessionId)
    assertSize(cols, rows)
    if (!live) return
    live.cols = cols
    live.rows = rows
    if (live.alive) live.proc.terminal.resize(cols, rows)
    if (live.held) live.held.push({ kind: 'resize', cols, rows })
    else this.applyResize(live, cols, rows)
    this.scheduleMeta(live)
  }

  /**
   * Signals the session's process group. With `reason: 'killed'` the signal defaults to SIGKILL, also
   * reaches every descendant (jobs run in their own groups), and the exit that follows is recorded
   * as requested, so it is not offered for restore.
   */
  kill(sessionId: string, signal?: string, reason?: 'killed'): void {
    const { live } = this.locate(sessionId)
    const name = normalizeSignal(signal ?? (reason ? 'SIGKILL' : 'SIGTERM'))
    if (!live?.alive) return
    if (reason) live.killRequested = true
    if (reason) signalTree(live.proc, name)
    else signalGroup(live.proc, name)
  }

  /** Drops a session's state and history, live or stored, killing its process first if it is running. */
  forget(sessionId: string): void {
    const { live, stored } = this.locate(sessionId)
    if (stored) {
      this.stored.forget(sessionId)
      return
    }
    live.forgotten = true
    for (const pending of live.pendingSubs) pending.cancelled = true
    if (live.alive) signalTree(live.proc, 'SIGKILL')
    this.sessions.delete(sessionId)
    this.teardown(live)
    rmSync(live.dir, { recursive: true, force: true })
  }

  list(): PtySessionInfo[] {
    return [...[...this.sessions.values()].map(infoOf), ...this.stored.list()]
  }

  /**
   * Registers `sink` for the session's output and returns the replay to paint first. The replay
   * ends exactly at `offset`, and the sink's first chunk starts there. Mode `screen` (default)
   * composes history and the screen; `raw` replays the hot tail. A stored session can only be
   * read, in `screen` mode, and gets no sink.
   */
  async subscribe(sessionId: string, sink: DataSink, options: SubscribeOptions = {}): Promise<PtyResults['subscribe']> {
    const { live, stored } = this.locate(sessionId)
    const mode = options.mode ?? 'screen'
    if (live) return mode === 'raw' ? this.subscribeRaw(live, sink) : this.subscribeScreen(live, sink, historyLinesOf(options.historyLines))
    if (mode === 'raw') throw new Error(`session ${sessionId} is not running`)
    return this.subscribeStored(stored, historyLinesOf(options.historyLines))
  }

  unsubscribe(sessionId: string, sink: DataSink): void {
    const live = this.locate(sessionId).live
    if (!live) return
    live.subscribers.delete(sink)
    cancelPending(live, sink)
  }

  /** Removes `sink` from every session; called when its connection goes away. */
  dropSink(sink: DataSink): void {
    for (const session of this.sessions.values()) {
      session.subscribers.delete(sink)
      cancelPending(session, sink)
    }
  }

  /**
   * The last `lines` rows of history above the screen, then the visible screen, with trailing
   * whitespace trimmed from each row and trailing blank rows dropped. A blank screen with no
   * history reads as `[]`; `rows` and `cols` report the screen size. With `unwrap`, every row the
   * terminal wrapped is joined onto the row before it, across the history/screen seam, keeping the
   * spaces at the wrap points; only the last row of each line is trimmed.
   */
  async read(sessionId: string, lines: number, unwrap = false): Promise<PtyResults['read']> {
    const { live, stored } = this.locate(sessionId)
    if (!Number.isInteger(lines) || lines < 0) throw new Error('lines must be a non-negative integer')
    if (live) {
      const grab = await this.atRest(live, () => {
        const visible = live.screen.lines()
        return { visible, above: textRowsAbove(live.dir, lines, visible.length), alt: live.screen.isAlternate }
      })
      return readResult(await grab.above, grab.visible, live.cols, grab.visible.length, grab.alt, unwrap)
    }
    return this.withRebuilt(stored, async (screen, rebuilt) => {
      const visible = screen.lines()
      return readResult(await textRowsAbove(stored.dir, lines, visible.length), visible, rebuilt.cols, rebuilt.rows, screen.isAlternate, unwrap)
    })
  }

  /** The visible screen as ANSI with the state a viewer needs to continue from it. */
  async snapshot(sessionId: string): Promise<PtySnapshot> {
    const { live, stored } = this.locate(sessionId)
    if (live) {
      return this.atRest(live, () => ({
        ...live.screen.snapshot(),
        cwd: live.cwd,
        title: live.title,
        shellState: live.barrier.state,
        offset: live.tail.total
      }))
    }
    return this.withRebuilt(stored, (screen, rebuilt) => ({
      ...screen.snapshot(),
      cwd: rebuilt.cwd,
      title: rebuilt.title,
      shellState: 'unsupported' as const,
      offset: rebuilt.offset
    }))
  }

  /**
   * A page of history ending just before the `before` cursor, or at the newest line when it is
   * absent. `lines` sizes the page rather than trimming it; see `pageBefore`.
   */
  async history(sessionId: string, options: HistoryOptions = {}): Promise<PtyHistoryPage> {
    const { live, stored } = this.locate(sessionId)
    const lines = options.lines ?? 200
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_HISTORY_LINES) throw new Error(`lines must be an integer from 1 to ${MAX_HISTORY_LINES}`)
    const format = options.format ?? 'text'
    if (format !== 'text' && format !== 'ansi') throw new Error(`invalid history format: ${format}`)
    const before = options.before === undefined ? undefined : parseCursor(options.before)
    const source = live ? { dir: live.dir, rows: live.rows } : { dir: stored.dir, rows: stored.meta.rows }
    return pageBefore(source.dir, { before, lines, format, screenRows: source.rows })
  }

  /**
   * Empties the scrollback and keeps only the cursor's line, as the first row, for the emulator,
   * the history, every attached viewer and a later cold restore. Subscribers are sent the erase
   * sequences and the serialized cleared screen as ordinary output, so offsets keep growing and
   * output that follows lands after it. Works on a session whose process has exited; a stored
   * session that is not in memory cannot be cleared.
   */
  async clear(sessionId: string): Promise<void> {
    const session = this.inMemory(sessionId)
    await this.atRest(session, () => {
      session.screen.clear()
      const screen = session.screen.snapshot()
      const bytes = concatBytes(ERASE_SCREEN_AND_SCROLLBACK, new TextEncoder().encode(screen.ansi))
      this.withLog(session, (log) => {
        log.appendClear()
        log.appendOutput(bytes)
      })
      session.tail.replaceWith(bytes)
      this.broadcast(session, bytes)
      this.checkpointNow(session, screen)
    })
  }

  /**
   * Turns off mouse tracking, bracketed paste and application cursor keys and shows the cursor, in
   * the emulator, the history and every attached viewer. Nothing is written to the process. Works
   * on a session whose process has exited.
   */
  async resetModes(sessionId: string): Promise<void> {
    const session = this.inMemory(sessionId)
    await this.atRest(session, () => {
      session.screen.write(MODE_RESET)
      this.withLog(session, (log) => log.appendOutput(MODE_RESET))
      session.tail.append(MODE_RESET)
      this.broadcast(session, MODE_RESET)
      session.checkpointer.noteOutput()
    })
  }

  subscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.subscribers.size ?? 0
  }

  isAlive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.alive ?? false
  }

  /**
   * Ends every running session as `host-restart`, so each can be restored by the next host:
   * SIGHUP first, SIGKILL for any that ignore it. Stored sessions are left as they are.
   */
  async shutdown(): Promise<void> {
    this.stopping = true
    const running = [...this.sessions.values()].filter((s) => s.alive)
    for (const session of running) signalGroup(session.proc, 'SIGHUP')
    await settle(running, 1000)
    const stubborn = running.filter((s) => s.alive)
    for (const session of stubborn) signalGroup(session.proc, 'SIGKILL')
    await settle(stubborn, 1000)
    await settle([...this.sessions.values()], 2000)
    for (const session of this.sessions.values()) this.teardown(session)
  }

  private locate(sessionId: string): Located {
    const live = this.sessions.get(sessionId)
    if (live) return { live }
    const stored = this.stored.get(sessionId)
    if (stored) return { stored }
    throw new Error(`unknown session: ${sessionId}`)
  }

  /** The session held in memory, running or exited; stored sessions have no emulator to change. */
  private inMemory(sessionId: string): Session {
    const { live } = this.locate(sessionId)
    if (this.stopping) throw new Error(SHUTTING_DOWN)
    if (!live) throw new Error(`session ${sessionId} is not running`)
    return live
  }

  /** Runs `write` against the session's history log, reopening it for append when the session has ended and closed it. */
  private withLog(session: Session, write: (log: HistoryLog) => void): void {
    if (session.log.isOpen || session.log.disabled) {
      write(session.log)
      return
    }
    const log = HistoryLog.openForAppend(session.dir, { cols: session.cols, rows: session.rows, maxSegmentBytes: this.maxSegmentBytes })
    try {
      write(log)
    } finally {
      log.close()
    }
  }

  /** Writes a checkpoint of `screen` at the current output position, unless the parser is mid-sequence there. */
  private checkpointNow(session: Session, screen: { ansi: string; cols: number; rows: number }): void {
    if (!session.scanner.atBoundary) return
    try {
      writeCheckpoint(session.dir, {
        version: 1,
        offset: session.tail.total,
        cols: screen.cols,
        rows: screen.rows,
        ansi: screen.ansi,
        cwd: session.cwd,
        title: session.title,
        savedAt: Date.now()
      })
      this.persistMeta(session)
    } catch (error) {
      console.error(`pty-host: checkpoint write failed for ${session.dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private broadcast(session: Session, bytes: Uint8Array): void {
    for (const sink of session.subscribers) {
      try {
        sink(session.sessionId, bytes)
      } catch (error) {
        console.error(`sink for ${session.sessionId} failed:`, error)
      }
    }
  }

  private createFresh(params: CreateParams): PtyResults['create'] {
    const { sessionId, cwd, argv, env, cols, rows } = params
    const dir = this.dirOf(sessionId)
    this.stored.forget(sessionId)
    rmSync(dir, { recursive: true, force: true })
    const route: ReplyRoute = {}
    const screen = this.openScreen(cols, rows, route)
    const log = HistoryLog.create(dir, { cols, rows, maxSegmentBytes: this.maxSegmentBytes })
    try {
      const session = this.start({
        sessionId,
        argv,
        env,
        spawnCwd: cwd,
        startCwd: cwd,
        createdAt: Date.now(),
        title: null,
        cols,
        rows,
        dir,
        log,
        tail: new TailBuffer(this.tailBytes),
        screen,
        route,
        shellReady: params.shellReady === true,
        shellReadyTimeoutMs: params.shellReadyTimeoutMs ?? this.shellReadyTimeoutMs
      })
      this.persistMeta(session)
      return { pid: session.proc.pid, restored: false, cwd, cols, rows }
    } catch (error) {
      log.close()
      screen.dispose()
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }

  private async restore(params: CreateParams): Promise<PtyResults['create']> {
    const { sessionId, argv, env } = params
    const stored = this.stored.get(sessionId)
    if (!stored || stored.state !== 'restorable' || this.sessions.has(sessionId) || this.starting.has(sessionId)) {
      throw new Error(`session ${sessionId} is not restorable`)
    }
    this.starting.add(sessionId)
    const route: ReplyRoute = {}
    const screen = this.openScreen(params.cols, params.rows, route)
    let log: HistoryLog | undefined
    try {
      const rebuilt = await rebuildScreen(stored.dir, screen, { cols: params.cols, rows: params.rows, cwd: params.cwd })
      if (this.stopping) throw new Error(SHUTTING_DOWN)
      if (this.stored.get(sessionId) !== stored) throw new Error(`session ${sessionId} is not restorable`)
      const cwd = isDirectory(rebuilt.cwd) ? rebuilt.cwd : params.cwd
      log = HistoryLog.openForAppend(stored.dir, { cols: rebuilt.cols, rows: rebuilt.rows, maxSegmentBytes: this.maxSegmentBytes })
      const session = this.start({
        sessionId,
        argv,
        env,
        spawnCwd: cwd,
        startCwd: stored.meta.startCwd,
        createdAt: stored.meta.createdAt,
        title: rebuilt.title,
        cols: rebuilt.cols,
        rows: rebuilt.rows,
        dir: stored.dir,
        log,
        tail: new TailBuffer(this.tailBytes, log.offset + GROUND.length),
        screen,
        route,
        shellReady: params.shellReady === true,
        shellReadyTimeoutMs: params.shellReadyTimeoutMs ?? this.shellReadyTimeoutMs
      })
      // spawning is synchronous and output arrives on a later turn, so nothing is logged between the two
      log.appendRestore()
      log.appendOutput(GROUND)
      screen.write(GROUND)
      this.stored.release(sessionId)
      this.persistMeta(session)
      this.reportRestore(sessionId, rebuilt)
      return { pid: session.proc.pid, restored: true, cwd, cols: rebuilt.cols, rows: rebuilt.rows }
    } catch (error) {
      log?.close()
      screen.dispose()
      throw error
    } finally {
      this.starting.delete(sessionId)
    }
  }

  /** Spawns the process and registers the running session; the caller owns `log` and `screen` if this throws. */
  private start(init: StartInit): Session {
    const { sessionId, argv, env, cols, rows } = init
    const scanner = new OutputScanner()
    let session: Session | undefined
    let processDone = false
    let ptyClosed = false
    let markFinished: () => void = () => {}
    const finished = new Promise<void>((resolve) => (markFinished = resolve))

    const barrier = new ShellReadyBarrier({
      enabled: init.shellReady,
      timeoutMs: init.shellReadyTimeoutMs,
      deliver: (bytes) => {
        if (session?.alive) session.proc.terminal.write(bytes)
      },
      log: (message) => console.error(`pty-host: ${sessionId}: ${message}`)
    })

    let proc: PtyProcess
    try {
      proc = spawnPty(argv, {
        cwd: init.spawnCwd,
        env,
        cols,
        rows,
        onData: (bytes) => {
          if (!session?.alive || session.forgotten) return
          if (session.held) session.held.push({ kind: 'output', bytes: bytes.slice() })
          else this.pump(session, bytes)
        },
        onClose: () => {
          ptyClosed = true
          if (processDone && session) void this.finalize(session)
        }
      })
    } catch (error) {
      barrier.dispose()
      throw error
    }

    const created: Session = {
      sessionId,
      proc,
      argv: [...argv],
      startCwd: init.startCwd,
      cwd: init.spawnCwd,
      title: init.title,
      cols,
      rows,
      createdAt: init.createdAt,
      dir: init.dir,
      log: init.log,
      tail: init.tail,
      screen: init.screen,
      scanner,
      barrier,
      checkpointer: new CheckpointScheduler({
        dir: init.dir,
        screen: init.screen,
        scanner,
        intervalMs: this.checkpointIntervalMs,
        cwd: () => created.cwd,
        title: () => created.title,
        offset: () => created.tail.total,
        log: (message) => console.error(message),
        writeCheckpoint: (dir, checkpoint) => {
          writeCheckpoint(dir, checkpoint)
          this.persistMeta(created)
        }
      }),
      subscribers: new Set(),
      pendingSubs: new Set(),
      alive: true,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      endedAt: null,
      killRequested: false,
      forgotten: false,
      held: null,
      holders: 0,
      onRelease: [],
      metaTimer: null,
      metaFailed: false,
      finished,
      markFinished
    }
    session = created
    init.route.session = created
    this.sessions.set(sessionId, created)

    void proc.exited.then(() => {
      processDone = true
      if (ptyClosed) void this.finalize(created)
      else setTimeout(() => void this.finalize(created), PTY_CLOSE_GRACE_MS)
    })
    return created
  }

  /** A screen whose emulator replies go to the shell only while no pane is attached to answer them. */
  private openScreen(cols: number, rows: number, route: ReplyRoute): Screen {
    return new Screen({
      cols,
      rows,
      scrollback: 0,
      onReply: (bytes) => {
        const session = route.session
        if (session?.alive && session.subscribers.size === 0) session.barrier.input(bytes)
      }
    })
  }

  /** Takes one chunk of PTY output through the scanner, history log, tail, screen and sinks. */
  private pump(session: Session, chunk: Uint8Array): void {
    const { bytes, facts } = session.scanner.push(chunk)
    if (bytes.length > 0) {
      session.log.appendOutput(bytes)
      session.tail.append(bytes)
      session.screen.write(bytes)
      this.broadcast(session, bytes)
      session.checkpointer.noteOutput()
    }
    for (const fact of facts) this.applyFact(session, fact)
  }

  private applyFact(session: Session, fact: ScanFact): void {
    switch (fact.kind) {
      case 'ready':
        session.barrier.ready()
        return
      case 'command-start':
        return
      case 'program-status':
        if (fact.body.trim() === '?' && session.alive) session.barrier.input(PROGRAM_STATUS_REPLY)
        break
      case 'title':
        session.title = fact.title
        break
      case 'cwd':
        session.cwd = fact.cwd
        break
    }
    this.emit(this.factListeners, { type: 'fact', sessionId: session.sessionId, fact })
  }

  private applyResize(session: Session, cols: number, rows: number): void {
    session.log.appendResize(cols, rows)
    session.screen.resize(cols, rows)
  }

  private apply(session: Session, op: Held): void {
    if (op.kind === 'output') this.pump(session, op.bytes)
    else this.applyResize(session, op.cols, op.rows)
  }

  /**
   * Runs `read` at an instant when the screen has parsed exactly the output the log and tail hold.
   * Output that arrives while waiting is kept aside and applied right after `read` returns, so a
   * busy session cannot starve the reader and the reader sees no half-applied state.
   */
  private async atRest<T>(session: Session, read: () => T): Promise<T> {
    session.holders++
    session.held ??= []
    try {
      let fed: number
      do {
        fed = session.tail.total
        await session.screen.settled()
      } while (session.tail.total !== fed)
      return read()
    } finally {
      this.release(session)
    }
  }

  private release(session: Session): void {
    if (--session.holders > 0) return
    const held = session.held ?? []
    session.held = null
    if (!session.forgotten) for (const op of held) this.apply(session, op)
    else session.screen.dispose()
    for (const resume of session.onRelease.splice(0)) resume()
  }

  private async subscribeScreen(session: Session, sink: DataSink, historyLines: number): Promise<PtyResults['subscribe']> {
    const wasSubscribed = session.subscribers.has(sink)
    const pending: PendingSub = { sink, cancelled: false }
    session.pendingSubs.add(pending)
    const taken = await this.atRest(session, () => {
      if (pending.cancelled) throw new Error(`subscription cancelled: ${session.sessionId}`)
      const offset = session.tail.total
      session.subscribers.add(sink)
      const live = session.screen.snapshot()
      // composeReplay reads the log window before it first awaits, so the window ends at `offset`
      return { offset, live, composed: composeReplay(session.dir, { historyLines, live }) }
    }).finally(() => session.pendingSubs.delete(pending))
    try {
      const { replay, historyCursor } = await taken.composed
      return {
        replay: bytesToBase64(replay),
        offset: taken.offset,
        historyCursor,
        cols: taken.live.cols,
        rows: taken.live.rows,
        shellState: session.barrier.state,
        live: session.alive
      }
    } catch (error) {
      if (!wasSubscribed) session.subscribers.delete(sink)
      throw error
    }
  }

  private subscribeRaw(session: Session, sink: DataSink): PtyResults['subscribe'] {
    session.subscribers.add(sink)
    return {
      replay: bytesToBase64(session.tail.replay()),
      offset: session.tail.total,
      historyCursor: null,
      cols: session.cols,
      rows: session.rows,
      shellState: session.barrier.state,
      live: session.alive
    }
  }

  private subscribeStored(stored: StoredSession, historyLines: number): Promise<PtyResults['subscribe']> {
    return this.withRebuilt(stored, async (screen, rebuilt) => {
      const live = screen.snapshot()
      const { replay, historyCursor } = await composeReplay(stored.dir, { historyLines, live })
      return {
        replay: bytesToBase64(replay),
        offset: rebuilt.offset,
        historyCursor,
        cols: live.cols,
        rows: live.rows,
        shellState: 'unsupported' as const,
        live: false
      }
    })
  }

  /** Runs `use` against a scratch screen rebuilt from a stored session's files, then discards it. */
  private async withRebuilt<T>(stored: StoredSession, use: (screen: Screen, rebuilt: RestoredScreen) => T | Promise<T>): Promise<T> {
    const { meta } = stored
    const screen = new Screen({ cols: meta.cols, rows: meta.rows })
    try {
      const rebuilt = await rebuildScreen(stored.dir, screen, { cols: meta.cols, rows: meta.rows, cwd: meta.cwd })
      return await use(screen, rebuilt)
    } finally {
      screen.dispose()
    }
  }

  /** Records how the process ended, writes the final checkpoint and meta, then announces the exit. */
  private async finalize(session: Session): Promise<void> {
    if (!session.alive) return
    session.alive = false
    try {
      this.recordExit(session)
      // EOF ends output delivery but Bun retains the native PTY until it is explicitly closed.
      session.proc.terminal.close()
      if (session.holders > 0) await new Promise<void>((resolve) => session.onRelease.push(resolve))
      session.barrier.dispose()
      if (session.metaTimer) clearTimeout(session.metaTimer)
      session.metaTimer = null
      if (!session.forgotten) await session.checkpointer.flushFinal()
      session.checkpointer.dispose()
      session.log.close()
      if (!session.forgotten && this.sessions.get(session.sessionId) === session) {
        this.persistMeta(session)
        this.emit(this.exitListeners, {
          type: 'exit',
          sessionId: session.sessionId,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
          exitCause: session.exitCause!
        })
      }
    } catch (error) {
      console.error(`pty-host: ending ${session.sessionId} failed:`, error)
    } finally {
      session.markFinished()
    }
  }

  private recordExit(session: Session): void {
    const { exitCode, signalCode } = session.proc
    session.exitSignal = signalCode ?? null
    session.exitCode =
      typeof exitCode === 'number' ? exitCode : signalCode ? 128 + (constants.signals[signalCode as keyof typeof constants.signals] ?? 0) : null
    session.exitCause = session.killRequested ? 'killed' : this.stopping ? 'host-restart' : 'exited'
    session.endedAt = Date.now()
  }

  private teardown(session: Session): void {
    session.barrier.dispose()
    session.checkpointer.dispose()
    if (session.metaTimer) clearTimeout(session.metaTimer)
    session.metaTimer = null
    session.log.close()
    session.subscribers.clear()
    // a reader waiting on the screen would never wake if it were disposed now; release() disposes it
    if (session.holders === 0) session.screen.dispose()
  }

  private emit(listeners: Set<Listener>, event: PtyEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('pty event listener failed:', error)
      }
    }
  }

  private dirOf(sessionId: string): string {
    return join(this.home, 'sessions', sessionId)
  }

  private metaOf(session: Session): SessionMeta {
    return {
      version: 1,
      sessionId: session.sessionId,
      argv: session.argv,
      startCwd: session.startCwd,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      endedAt: session.endedAt,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      exitCause: session.exitCause,
      restorable: session.exitCause === 'host-restart'
    }
  }

  /** Meta is best effort: a disk error is reported once and the terminal goes on. */
  private persistMeta(session: Session): void {
    if (session.forgotten) return
    try {
      writeMeta(session.dir, this.metaOf(session))
    } catch (error) {
      if (session.metaFailed) return
      session.metaFailed = true
      console.error(`pty-host: meta write failed for ${session.dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Resizes come in bursts while a window is dragged, so the size reaches disk once things settle. */
  private scheduleMeta(session: Session): void {
    if (!session.alive || session.metaTimer) return
    session.metaTimer = setTimeout(() => {
      session.metaTimer = null
      if (session.alive) this.persistMeta(session)
    }, META_WRITE_DELAY_MS)
    session.metaTimer.unref?.()
  }

  private reportRestore(sessionId: string, rebuilt: RestoredScreen): void {
    console.error(`pty-host: restored ${sessionId} from ${rebuilt.source} at ${rebuilt.cols}x${rebuilt.rows}`)
  }
}

function infoOf(session: Session): PtySessionInfo {
  return {
    sessionId: session.sessionId,
    state: session.alive ? 'running' : 'exited',
    pid: session.proc.pid,
    alive: session.alive,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    exitCause: session.exitCause,
    cols: session.cols,
    rows: session.rows,
    argv: session.argv,
    cwd: session.cwd,
    title: session.title,
    shellState: session.barrier.state,
    createdAt: session.createdAt,
    offset: session.tail.total
  }
}

function readResult(
  above: Array<{ text: string; wrapped: boolean }>,
  visible: Array<{ text: string; wrapped: boolean }>,
  cols: number,
  rows: number,
  alt: boolean,
  unwrap: boolean
): PtyResults['read'] {
  const lines: string[] = []
  let open: string | null = null
  for (const row of [...above, ...visible]) {
    if (unwrap && row.wrapped && open !== null) {
      open += row.text
      continue
    }
    if (open !== null) lines.push(open.trimEnd())
    open = row.text
  }
  if (open !== null) lines.push(open.trimEnd())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { lines, cols, rows, alt }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function historyLinesOf(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_HISTORY_LINES
  return Math.min(MAX_HISTORY_LINES, Math.max(0, Math.trunc(requested)))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
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

function signalTree(proc: PtyProcess, signal: string): void {
  const descendants = descendantsOf(proc.pid)
  signalGroup(proc, signal)
  for (const pid of descendants) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, signal)
      } catch {
        // gone, or not ours
      }
    }
  }
}

async function settle(sessions: Session[], timeoutMs: number): Promise<void> {
  if (sessions.length === 0) return
  await Promise.race([Promise.all(sessions.map((s) => s.finished)), Bun.sleep(timeoutMs)])
}

function cancelPending(session: Session, sink: DataSink): void {
  for (const pending of session.pendingSubs) if (pending.sink === sink) pending.cancelled = true
}
