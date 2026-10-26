import { statSync } from 'node:fs'
import { OutputScanner } from '../scanner'
import type { Screen } from '../screen'
import { type Checkpoint, readCheckpoint, writeCheckpoint as writeCheckpointFile } from './checkpoint'
import { readSegments } from './log'

const HISTORY_NOTE = '[history could not be read]\r\n'
const MAX_CWD_CANDIDATES = 256

const encoder = new TextEncoder()

/**
 * Bytes that bring a screen rebuilt from a dead process's history back to a usable state: abort
 * any dangling sequence, leave the alternate screen, turn off mouse reporting, bracketed paste and
 * application cursor keys, show the cursor, reset attributes, then start a new line.
 */
export const GROUND: Uint8Array = encoder.encode(
  '\x18\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b[?25h\x1b[0m\r\n'
)

export type RestoreSource = 'checkpoint+log' | 'log' | 'checkpoint' | 'none'

export type RestoredScreen = {
  source: RestoreSource
  cols: number
  rows: number
  cwd: string
  title: string | null
  /** The log's newest output position; 0 when no log could be read. */
  offset: number
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Rebuilds a session's last screen into a fresh `screen` from `<dir>`: the checkpoint's screen
 * plus the log after it, else the whole readable log, else a note. Terminal queries inside the
 * history are answered by nobody: `screen.seeding` is true while the bytes are parsed, and the
 * promise resolves only once the screen has parsed all of them, so the caller can append the
 * ground and spawn the shell straight after. `screen.seeding` is put back to its prior value.
 */
export async function rebuildScreen(
  dir: string,
  screen: Screen,
  fallback: { cols: number; rows: number; cwd: string }
): Promise<RestoredScreen> {
  const checkpoint = readCheckpoint(dir)
  const { segments } = readSegments(dir)
  const wasSeeding = screen.seeding
  screen.seeding = true

  let cols = Math.max(1, checkpoint?.cols ?? fallback.cols)
  let rows = Math.max(1, checkpoint?.rows ?? fallback.rows)
  let title = checkpoint?.title ?? null
  const scanner = new OutputScanner()
  // newest last; a repeated directory moves to the end
  const cwds = new Map<string, true>()
  // newest directory that existed when the candidate cap pushed it out of `cwds`
  let evictedExisting: string | null = null

  const resize = (c: number, r: number): void => {
    cols = Math.max(1, c)
    rows = Math.max(1, r)
    screen.resize(cols, rows)
  }
  const replay = (bytes: Uint8Array): void => {
    for (const fact of scanner.push(bytes).facts) {
      if (fact.kind === 'title') title = fact.title
      else if (fact.kind === 'cwd') {
        cwds.delete(fact.cwd)
        cwds.set(fact.cwd, true)
        if (cwds.size > MAX_CWD_CANDIDATES) {
          const oldest = cwds.keys().next().value!
          cwds.delete(oldest)
          if (isDirectory(oldest)) evictedExisting = oldest
        }
      }
    }
    screen.write(bytes)
  }

  try {
    resize(cols, rows)
    if (checkpoint) screen.write(checkpoint.ansi)
    const from = checkpoint?.offset ?? 0

    for (const segment of segments) {
      for (const record of segment.records) {
        if (record.kind === 'resize') {
          if (checkpoint === null || record.offset >= from) {
            await screen.settled()
            resize(record.cols!, record.rows!)
          }
        } else if (record.kind === 'output') {
          const bytes = record.bytes!
          const end = record.offset + bytes.length
          if (checkpoint === null || record.offset >= from) replay(bytes)
          else if (end > from) replay(bytes.subarray(from - record.offset))
        }
      }
    }

    if (checkpoint === null && segments.length === 0) screen.write(HISTORY_NOTE)
    await screen.settled()
  } finally {
    screen.seeding = wasSeeding
  }

  const cwd =
    [...cwds.keys()].reverse().find(isDirectory) ?? evictedExisting ?? checkpoint?.cwd ?? fallback.cwd
  const source: RestoreSource =
    checkpoint && segments.length > 0 ? 'checkpoint+log' : checkpoint ? 'checkpoint' : segments.length > 0 ? 'log' : 'none'
  return { source, cols, rows, cwd, title, offset: segments[segments.length - 1]?.endOffset ?? 0 }
}

const MAX_CONCURRENT_WRITES = 4
let activeWrites = 0
const writeQueue: Array<() => void> = []

/** Runs `task` once fewer than four checkpoint writes are in progress anywhere in the process. */
async function withWriteSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeWrites >= MAX_CONCURRENT_WRITES) await new Promise<void>((resolve) => writeQueue.push(resolve))
  else activeWrites++
  try {
    return await task()
  } finally {
    const next = writeQueue.shift()
    if (next) next()
    else activeWrites--
  }
}

export type CheckpointSchedulerOptions = {
  dir: string
  screen: Screen
  scanner: { readonly atBoundary: boolean }
  intervalMs?: number
  maxWaitMs?: number
  cwd(): string
  title(): string | null
  /** Output bytes fed to the screen so far. */
  offset(): number
  log?(message: string): void
  /** Replaces the checkpoint file writer; a slow or async one still counts against the write limit. */
  writeCheckpoint?(dir: string, checkpoint: Checkpoint): void | Promise<void>
}

type Capture = { kind: 'ok'; checkpoint: Checkpoint } | { kind: 'unsafe' } | { kind: 'moved' }

/**
 * Keeps one session's `checkpoint.json` fresh while it produces output, and only ever records a
 * screen taken at a parser-safe offset: the scanner is between sequences, so replaying the log
 * from that offset onto the checkpoint's screen reproduces the live one. An idle session writes
 * nothing. The caller reports each chunk with `noteOutput` after feeding it to the screen and the
 * scanner.
 */
export class CheckpointScheduler {
  private readonly intervalMs: number
  private readonly maxWaitMs: number
  private readonly write: (dir: string, checkpoint: Checkpoint) => void | Promise<void>
  private timer: ReturnType<typeof setTimeout> | null = null
  private giveUpTimer: ReturnType<typeof setTimeout> | null = null
  private waiting = false
  private pendingOutput = false
  private inflight: Promise<void> | null = null
  private disposed = false
  private failureLogged = false

  constructor(private readonly options: CheckpointSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? 5000
    this.maxWaitMs = options.maxWaitMs ?? 1000
    this.write = options.writeCheckpoint ?? writeCheckpointFile
  }

  /** Arms the interval after the first output past a checkpoint, and retries a deferred checkpoint. */
  noteOutput(): void {
    if (this.disposed) return
    this.pendingOutput = true
    if (this.inflight) return
    if (this.waiting) this.start()
    else if (this.timer === null) this.arm()
  }

  /**
   * Writes a checkpoint now if the screen is between sequences once it has parsed everything fed
   * to it. Resolves false, writing nothing, when it is not or when the write fails.
   */
  async flushFinal(): Promise<boolean> {
    this.clearTimers()
    this.waiting = false
    await this.inflight
    if (this.disposed) return false
    for (let tries = 0; tries < 3; tries++) {
      const captured = await this.capture()
      if (captured.kind === 'unsafe') return false
      if (captured.kind === 'ok') return this.persist(captured.checkpoint)
    }
    return false
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.start()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer)
    this.timer = null
    this.giveUpTimer = null
  }

  private start(): void {
    const run = this.attempt().finally(() => {
      this.inflight = null
      if (!this.disposed && this.pendingOutput && !this.waiting && this.timer === null) this.arm()
    })
    this.inflight = run
  }

  private async attempt(): Promise<void> {
    let waitBegun = this.waiting
    for (;;) {
      const captured = await this.capture()
      if (this.disposed) return
      if (captured.kind === 'ok') {
        this.endWait()
        await this.persist(captured.checkpoint)
        return
      }
      if (!waitBegun) {
        waitBegun = true
        this.beginWait()
      } else if (!this.waiting) {
        return
      }
      if (captured.kind === 'unsafe') return
    }
  }

  private beginWait(): void {
    this.waiting = true
    this.giveUpTimer = setTimeout(() => {
      this.giveUpTimer = null
      this.waiting = false
      if (!this.inflight && !this.disposed && this.pendingOutput && this.timer === null) this.arm()
    }, this.maxWaitMs)
    this.giveUpTimer.unref?.()
  }

  private endWait(): void {
    this.waiting = false
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer)
    this.giveUpTimer = null
  }

  /**
   * Snapshots the screen once it has parsed exactly the bytes fed so far. Output that arrives
   * while the screen settles leaves the parsed position unknown, so that attempt is `moved`.
   */
  private async capture(): Promise<Capture> {
    const { screen, scanner } = this.options
    const offset = this.options.offset()
    await screen.settled()
    if (this.disposed || this.options.offset() !== offset) return { kind: 'moved' }
    if (!scanner.atBoundary) return { kind: 'unsafe' }
    const snapshot = screen.snapshot()
    this.pendingOutput = false
    return {
      kind: 'ok',
      checkpoint: {
        version: 1,
        offset,
        cols: snapshot.cols,
        rows: snapshot.rows,
        ansi: snapshot.ansi,
        cwd: this.options.cwd(),
        title: this.options.title(),
        savedAt: Date.now()
      }
    }
  }

  /** Writes `checkpoint` under the process-wide limit; a failure is logged once and history goes on. */
  private async persist(checkpoint: Checkpoint): Promise<boolean> {
    try {
      await withWriteSlot(async () => this.write(this.options.dir, checkpoint))
      return true
    } catch (err) {
      if (!this.failureLogged) {
        this.failureLogged = true
        const reason = err instanceof Error ? err.message : String(err)
        this.options.log?.(`pty-host: checkpoint write failed for ${this.options.dir}: ${reason}`)
      }
      return false
    }
  }
}
