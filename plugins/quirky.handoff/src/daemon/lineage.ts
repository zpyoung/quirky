import type { PluginStore } from '@quirky/protocol'
import type { LineageEnd, LineageRecord, Relationship } from './types'

/** The most records kept; older ones are dropped after each insert. */
export const MAX_LINEAGE = 500

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RELATIONSHIPS: readonly string[] = ['continues', 'reviews', 'branches-from']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function endOf(value: unknown): LineageEnd | null {
  if (!isRecord(value)) return null
  const { agent } = value
  if (agent !== null && typeof agent !== 'string') return null
  return {
    session: textOrNull(value.session),
    agent: agent ?? null,
    providerSessionId: textOrNull(value.providerSessionId),
    transcriptPath: textOrNull(value.transcriptPath),
    worktreeId: textOrNull(value.worktreeId),
    title: textOrNull(value.title)
  }
}

/** A stored row as a record, or null when it fails validation. */
function parseRecord(text: string): LineageRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const { id, createdAt, relationship } = value
  if (typeof id !== 'string' || !UUID.test(id)) return null
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) return null
  if (typeof relationship !== 'string' || !RELATIONSHIPS.includes(relationship)) return null
  const parent = endOf(value.parent)
  const child = endOf(value.child)
  if (parent === null || child === null) return null
  return {
    id,
    createdAt,
    relationship: relationship as Relationship,
    parent,
    child: { ...child, tab: textOrNull((value.child as Record<string, unknown>).tab) }
  }
}

const names = (record: LineageRecord, session: string) => record.parent.session === session || record.child.session === session

/**
 * The handoff records in the plugin's store: one per handoff, both ends in one row, the newest
 * 500 kept. Reads skip rows that fail validation.
 */
export class LineageStore {
  constructor(private readonly store: PluginStore) {}

  /** Writes a record and drops what falls beyond the newest 500 valid ones; throws when the store refuses. */
  add(record: LineageRecord): void {
    this.store.transaction(() => {
      this.store.run('INSERT INTO lineage (id, created_at, record) VALUES (?, ?, ?)', record.id, record.createdAt, JSON.stringify(record))
      this.prune()
    })
  }

  private prune(): void {
    let kept = 0
    for (const row of this.store.all<{ id: string; record: string }>('SELECT id, record FROM lineage ORDER BY created_at DESC, rowid DESC')) {
      const valid = parseRecord(row.record) !== null
      if (kept >= MAX_LINEAGE) this.store.run('DELETE FROM lineage WHERE id = ?', row.id)
      else if (valid) kept++
    }
  }

  /** Every valid record, newest first; with `session`, only those naming it as parent or child. */
  list(session?: string): LineageRecord[] {
    const records: LineageRecord[] = []
    for (const row of this.store.all<{ record: string }>('SELECT record FROM lineage ORDER BY created_at DESC, rowid DESC')) {
      const record = parseRecord(row.record)
      if (record !== null && (session === undefined || names(record, session))) records.push(record)
    }
    return records
  }

  get(id: string): LineageRecord | null {
    const row = this.store.get<{ record: string }>('SELECT record FROM lineage WHERE id = ?', id)
    return row === null ? null : parseRecord(row.record)
  }

  /** Child sessions whose provider session id is still unknown. */
  awaitingProvider(): string[] {
    return this.list().flatMap((record) => (record.child.session !== null && record.child.providerSessionId === null ? [record.child.session] : []))
  }

  /** Sets the child's provider session id on every record that names it, only where none is set yet; true when one changed. */
  fillChildProvider(session: string, providerSessionId: string): boolean {
    let changed = false
    for (const record of this.list(session)) {
      if (record.child.session !== session || record.child.providerSessionId !== null) continue
      const next: LineageRecord = { ...record, child: { ...record.child, providerSessionId } }
      this.store.run('UPDATE lineage SET record = ? WHERE id = ?', JSON.stringify(next), record.id)
      changed = true
    }
    return changed
  }
}
