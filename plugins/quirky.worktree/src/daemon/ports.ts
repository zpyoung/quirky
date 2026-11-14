import { createServer } from 'node:net'
import type { PluginStore } from '@quirky/protocol'
import { KeyedQueue } from './queue'

export type PortBlock = { base: number; count: number }
export type PortRange = { start: number; end: number; size: number }
export type PortProbe = (port: number) => Promise<boolean>

export const DEFAULT_PORT_RANGE: PortRange = { start: 41000, end: 48999, size: 10 }
export const PORT_LOOPBACK_HOSTS: readonly ['0.0.0.0', '127.0.0.1', '::', '::1'] = ['0.0.0.0', '127.0.0.1', '::', '::1']

/** Adds durable port allocations and releases them whenever their worktree row is deleted. */
export function migrateWorktreePorts(store: PluginStore): void {
  store.exec(`
    CREATE TABLE worktree_ports (
      worktree_id TEXT PRIMARY KEY,
      base INTEGER NOT NULL UNIQUE,
      count INTEGER NOT NULL CHECK (count >= 1),
      allocated_at INTEGER NOT NULL
    );
    CREATE TRIGGER worktree_ports_forget_worktree AFTER DELETE ON worktrees
    BEGIN
      DELETE FROM worktree_ports WHERE worktree_id = OLD.id;
    END;
  `)
}

function bindAddress(host: string, port: number): Promise<boolean> {
  const server = createServer()
  const { promise, resolve, reject } = Promise.withResolvers<boolean>()
  const isIpv6 = host === '::' || host === '::1'

  const onError = (error: Error) => {
    server.removeListener('listening', onListening)
    server.removeListener('error', onError)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      resolve(false)
    } else if (isIpv6) {
      resolve(true)
    } else {
      reject(error)
    }
  }

  const onListening = () => {
    server.removeListener('listening', onListening)
    server.close((error) => {
      server.removeListener('error', onError)
      if (error) reject(error)
      else resolve(true)
    })
  }

  server.once('error', onError)
  server.once('listening', onListening)
  try {
    server.listen({ host, port, exclusive: true })
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)))
  }
  return promise
}

/** Returns false when any of the four loopback/wildcard addresses is occupied. */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of PORT_LOOPBACK_HOSTS) {
    if (!await bindAddress(host, port)) return false
  }
  return true
}

export function storedPortBlock(store: PluginStore, worktreeId: string): PortBlock | null {
  const row = store.get<PortBlock>('SELECT base, count FROM worktree_ports WHERE worktree_id = ?', worktreeId)
  return row ? { base: row.base, count: row.count } : null
}

export function portBlocks(store: PluginStore): Array<PortBlock & { worktreeId: string }> {
  return store.all<{ worktree_id: string; base: number; count: number }>(
    'SELECT worktree_id, base, count FROM worktree_ports ORDER BY base'
  ).map((row) => ({ worktreeId: row.worktree_id, base: row.base, count: row.count }))
}

export function portEnvironment(block: PortBlock): { PORT: string; WORKTREE_PORT: string; WORKTREE_PORT_COUNT: string } {
  return {
    PORT: String(block.base),
    WORKTREE_PORT: String(block.base),
    WORKTREE_PORT_COUNT: String(block.count)
  }
}

function validateRange(range: PortRange): void {
  if (!Number.isInteger(range.start)) {
    throw new Error('port range is invalid: portRangeStart must be a whole number')
  }
  if (!Number.isInteger(range.end)) {
    throw new Error('port range is invalid: portRangeEnd must be a whole number')
  }
  if (!Number.isInteger(range.size)) {
    throw new Error('port range is invalid: portBlockSize must be a whole number')
  }
  if (range.start > range.end) {
    throw new Error(`port range is invalid: portRangeStart ${range.start} is above portRangeEnd ${range.end}`)
  }
  if (range.size < 1) {
    throw new Error('port range is invalid: portBlockSize must be at least 1')
  }
  if (range.size > range.end - range.start + 1) {
    throw new Error(`port range is invalid: a block of ${range.size} ports does not fit between ${range.start} and ${range.end}`)
  }
}

function worktreeExists(store: PluginStore, worktreeId: string): boolean {
  return store.get('SELECT id FROM worktrees WHERE id = ?', worktreeId) !== null
}

export class WorktreePorts {
  private readonly queue = new KeyedQueue()
  private readonly store: PluginStore
  private readonly range: () => PortRange
  private readonly probe: PortProbe
  private readonly now: () => number

  constructor(options: { store: PluginStore; range: () => PortRange; probe?: PortProbe; now?: () => number }) {
    this.store = options.store
    this.range = options.range
    this.probe = options.probe ?? isPortFree
    this.now = options.now ?? Date.now
  }

  /** The worktree's block, allocating the lowest free one on first use. Rejects when the row is gone, the range is invalid or full. */
  ensure(worktreeId: string): Promise<PortBlock> {
    return this.queue.run('ports', async () => {
      if (!worktreeExists(this.store, worktreeId)) {
        throw new Error(`worktree ${worktreeId} no longer exists`)
      }

      const stored = storedPortBlock(this.store, worktreeId)
      if (stored) return stored

      const range = this.range()
      validateRange(range)
      const heldBlocks = portBlocks(this.store)
      let candidate: PortBlock | null = null

      for (let base = range.start; base + range.size - 1 <= range.end; base += range.size) {
        const end = base + range.size - 1
        const overlaps = heldBlocks.some((held) => base <= held.base + held.count - 1 && end >= held.base)
        if (overlaps) continue

        let free = true
        for (let port = base; port <= end; port++) {
          if (!await this.probe(port)) {
            free = false
            break
          }
        }
        if (free) {
          candidate = { base, count: range.size }
          break
        }
      }

      if (!worktreeExists(this.store, worktreeId)) {
        throw new Error(`worktree ${worktreeId} no longer exists`)
      }
      if (!candidate) {
        throw new Error(`no free block of ${range.size} ports between ${range.start} and ${range.end}`)
      }

      const inserted = this.store.run(
        `INSERT INTO worktree_ports (worktree_id, base, count, allocated_at)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM worktrees WHERE id = ?)`,
        worktreeId,
        candidate.base,
        candidate.count,
        this.now(),
        worktreeId
      )
      if (inserted.changes === 0) {
        throw new Error(`worktree ${worktreeId} no longer exists`)
      }
      return candidate
    })
  }
}
