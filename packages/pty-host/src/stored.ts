import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PtySessionInfo } from '@quirky/protocol'
import { readCheckpoint } from './history/checkpoint'
import { LogReader } from './history/log'
import { readMeta, type SessionMeta } from './history/meta'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A session that exists only on disk: its process is gone and the host holds nothing in memory for it. */
export type StoredSession = {
  sessionId: string
  dir: string
  meta: SessionMeta
  /** `restorable` when the host that ran it went away; `exited` when it ended for good. */
  state: 'restorable' | 'exited'
  /** Output position after the newest retained byte; read from disk on first use. */
  offset: number | null
  title: string | null | undefined
}

function stateOf(meta: SessionMeta): StoredSession['state'] {
  return meta.endedAt === null || meta.restorable ? 'restorable' : 'exited'
}

/** Newest output position in the log, found without reading the output itself. */
function newestOffset(dir: string): number {
  const reader = LogReader.open(dir)
  try {
    return reader.segments[reader.segments.length - 1]?.endOffset ?? 0
  } finally {
    reader.close()
  }
}

/**
 * The sessions a previous host left in `<home>/sessions`, loaded once when the host starts. A
 * directory without a readable `meta.json` is not a session and is never touched. Entries leave
 * this set when they are restored into memory or forgotten.
 */
export class StoredSessions {
  private readonly entries = new Map<string, StoredSession>()

  constructor(home: string) {
    let names: string[]
    try {
      names = readdirSync(join(home, 'sessions'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (!SESSION_ID.test(name)) continue
      const dir = join(home, 'sessions', name)
      const meta = readMeta(dir)
      if (!meta || meta.sessionId !== name) continue
      this.entries.set(name, { sessionId: name, dir, meta, state: stateOf(meta), offset: null, title: undefined })
    }
  }

  get(sessionId: string): StoredSession | undefined {
    return this.entries.get(sessionId)
  }

  /** Stops tracking the session without touching its files; its directory now belongs to a live session. */
  release(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** Stops tracking the session and deletes its directory. */
  forget(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId)
    rmSync(entry.dir, { recursive: true, force: true })
  }

  list(): PtySessionInfo[] {
    return [...this.entries.values()].map((entry) => this.info(entry))
  }

  private info(entry: StoredSession): PtySessionInfo {
    const { meta } = entry
    entry.offset ??= newestOffset(entry.dir)
    if (entry.title === undefined) entry.title = readCheckpoint(entry.dir)?.title ?? null
    const restorable = entry.state === 'restorable'
    return {
      sessionId: entry.sessionId,
      state: entry.state,
      pid: 0,
      alive: false,
      exitCode: restorable ? null : meta.exitCode,
      exitSignal: restorable ? null : meta.exitSignal,
      exitCause: restorable ? (meta.endedAt === null ? 'host-lost' : 'host-restart') : (meta.exitCause ?? 'exited'),
      cols: meta.cols,
      rows: meta.rows,
      argv: meta.argv,
      cwd: meta.cwd,
      title: entry.title,
      shellState: 'unsupported',
      createdAt: meta.createdAt,
      offset: entry.offset
    }
  }
}
