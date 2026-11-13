import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PtySessionInfo } from '@quirky/protocol'
import { readCheckpoint } from './history/checkpoint'
import { loadStoredLogIndex, type StoredIndexOptions, type StoredLogIndex } from './history/log'
import { readMeta, type SessionMeta } from './history/meta'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A session that exists only on disk: its process is gone and the host holds nothing in memory for it. */
export type StoredSession = {
  sessionId: string
  dir: string
  meta: SessionMeta
  /** `restorable` when the process was stopped with recoverable history or its host went away. */
  state: 'restorable' | 'exited'
  /** Output position after the newest retained byte; unknown until indexed or seeded by reload. */
  offset: number | null
  title: string | null | undefined
}

function stateOf(meta: SessionMeta): StoredSession['state'] {
  return meta.endedAt === null || meta.restorable ? 'restorable' : 'exited'
}

const MAX_CONCURRENT_INDEX_LOADS = 4

const INDEX_STATE: unique symbol = Symbol('stored index state')

type IndexState = { promise: Promise<StoredLogIndex>; index?: StoredLogIndex }
type IndexedStoredSession = StoredSession & { [INDEX_STATE]?: IndexState }

/**
 * The sessions a previous host left in `<home>/sessions`, loaded once when the host starts. A
 * directory without a readable `meta.json` is not a session and is never touched. Entries leave
 * this set when they are restored into memory or forgotten.
 */
export class StoredSessions {
  private readonly entries = new Map<string, StoredSession>()
  private activeIndexLoads = 0
  private readonly indexLoadQueue: Array<() => void> = []

  constructor(private readonly home: string, private readonly indexOptions: StoredIndexOptions = {}) {
    let names: string[]
    try {
      names = readdirSync(join(this.home, 'sessions'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (!SESSION_ID.test(name)) continue
      const dir = join(this.home, 'sessions', name)
      const meta = readMeta(dir)
      if (!meta || meta.sessionId !== name) continue
      this.entries.set(name, { sessionId: name, dir, meta, state: stateOf(meta), offset: null, title: undefined })
    }
  }

  /** Re-reads a session's durable metadata after a reversible stop has finalized in this host. */
  reload(sessionId: string, offset?: number): void {
    const dir = join(this.home, 'sessions', sessionId)
    const meta = readMeta(dir)
    if (!meta || meta.sessionId !== sessionId) {
      this.entries.delete(sessionId)
      return
    }
    this.entries.set(sessionId, { sessionId, dir, meta, state: stateOf(meta), offset: offset ?? null, title: undefined })
  }

  /** The entry's index: loaded once, shared by concurrent callers, and refreshed when stale. */
  index(entry: StoredSession): Promise<StoredLogIndex> {
    const indexed = entry as IndexedStoredSession
    const cached = indexed[INDEX_STATE]
    if (cached && (!cached.index || (cached.index.retain && !cached.index.stale))) return cached.promise

    let state!: IndexState
    const promise = Promise.resolve()
      .then(() => this.loadIndex(entry.dir))
      .then(
        (index) => {
          entry.offset = index.endOffset
          if (index.retain) state.index = index
          else if (indexed[INDEX_STATE] === state) delete indexed[INDEX_STATE]
          return index
        },
        (error: unknown) => {
          if (indexed[INDEX_STATE] === state) delete indexed[INDEX_STATE]
          throw error
        }
      )
    state = { promise }
    indexed[INDEX_STATE] = state
    return promise
  }

  /** Resolves once every entry present at the call has a known end offset. */
  async offsetsKnown(): Promise<void> {
    const unknown = [...this.entries.values()].filter((entry) => entry.offset === null)
    await Promise.all(unknown.map((entry) => this.index(entry)))
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

  private async loadIndex(dir: string): Promise<StoredLogIndex> {
    await this.acquireIndexSlot()
    try {
      return await loadStoredLogIndex(dir, this.indexOptions)
    } finally {
      this.releaseIndexSlot()
    }
  }

  private acquireIndexSlot(): Promise<void> {
    if (this.activeIndexLoads < MAX_CONCURRENT_INDEX_LOADS) {
      this.activeIndexLoads++
      return Promise.resolve()
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    this.indexLoadQueue.push(() => resolve())
    return promise
  }

  private releaseIndexSlot(): void {
    const next = this.indexLoadQueue.shift()
    if (next) next()
    else this.activeIndexLoads--
  }

  private info(entry: StoredSession): PtySessionInfo {
    const { meta } = entry
    if (entry.title === undefined) entry.title = readCheckpoint(entry.dir)?.title ?? null
    const restorable = entry.state === 'restorable'
    return {
      sessionId: entry.sessionId,
      state: entry.state,
      pid: 0,
      alive: false,
      exitCode: restorable ? null : meta.exitCode,
      exitSignal: restorable ? null : meta.exitSignal,
      exitCause: restorable
        ? meta.exitCause === 'stopped'
          ? 'stopped'
          : meta.endedAt === null
            ? 'host-lost'
            : 'host-restart'
        : (meta.exitCause ?? 'exited'),
      cols: meta.cols,
      rows: meta.rows,
      argv: meta.argv,
      cwd: meta.cwd,
      title: entry.title,
      shellState: 'unsupported',
      createdAt: meta.createdAt,
      offset: entry.offset ?? 0
    }
  }
}
