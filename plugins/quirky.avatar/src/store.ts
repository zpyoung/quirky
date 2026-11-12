import type { PluginStore, StoreValue } from '@quirky/protocol'
import type {
  Approval, AvatarStore, BrainSession, Finding, Guess, HandoffRow, JournalEntry, JournalKind, LateAnswer, Mandate,
  NeedsYouItem, OutboxRow, Receipt, RecordCursor, SharedGoal, StuckRow, TableAccess
} from './contracts'

type Kind = 'text' | 'int' | 'bool' | 'json'

type TableSpec<T> = { table: string; key: keyof T & string; columns: { [K in keyof T]-?: Kind } }

const snake = (field: string): string => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

function encode(kind: Kind, value: unknown): StoreValue {
  if (value === null || value === undefined) return null
  if (kind === 'json') return JSON.stringify(value)
  if (kind === 'bool') return value ? 1 : 0
  return value as StoreValue
}

function decode(kind: Kind, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (kind === 'json') return JSON.parse(value as string)
  if (kind === 'bool') return value === 1
  return value
}

function tableAccess<T extends Record<string, unknown>>(store: PluginStore, spec: TableSpec<T>): TableAccess<T> {
  const fields = Object.keys(spec.columns) as (keyof T & string)[]
  const names = fields.map(snake)
  const keyColumn = snake(spec.key)
  const toRow = (raw: Record<string, unknown>): T => {
    const row: Record<string, unknown> = {}
    for (const field of fields) row[field] = decode(spec.columns[field], raw[snake(field)])
    return row as T
  }
  const updates = names.filter((name) => name !== keyColumn).map((name) => `${name} = excluded.${name}`).join(', ')
  const upsert = `INSERT INTO ${spec.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT(${keyColumn}) DO UPDATE SET ${updates}`
  return {
    get: (key) => {
      const raw = store.get<Record<string, unknown>>(`SELECT * FROM ${spec.table} WHERE ${keyColumn} = ?`, key)
      return raw === null ? null : toRow(raw)
    },
    put: (row) => {
      store.run(upsert, ...fields.map((field) => encode(spec.columns[field], row[field])))
    },
    list: (where = {}) => {
      const clauses: string[] = []
      const params: StoreValue[] = []
      for (const field of fields) {
        const value = where[field]
        if (value === undefined) continue
        const column = snake(field)
        if (value === null) clauses.push(`${column} IS NULL`)
        else {
          clauses.push(`${column} = ?`)
          params.push(encode(spec.columns[field], value))
        }
      }
      const filter = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      return store.all<Record<string, unknown>>(`SELECT * FROM ${spec.table}${filter} ORDER BY rowid`, ...params).map(toRow)
    },
    delete: (key) => store.run(`DELETE FROM ${spec.table} WHERE ${keyColumn} = ?`, key).changes > 0
  }
}

type JournalRow = { seq: number; at: number; worktree_id: string | null; kind: string; data: string }

const journalEntry = (row: JournalRow): JournalEntry => ({
  seq: row.seq,
  at: row.at,
  worktreeId: row.worktree_id,
  kind: row.kind as JournalKind,
  data: JSON.parse(row.data) as Record<string, unknown>
})

/** Typed access over the plugin's SQLite store, which must already carry `avatarMigrations`. */
export function createAvatarStore(store: PluginStore): AvatarStore {
  return {
    mandates: tableAccess<Mandate>(store, {
      table: 'mandates',
      key: 'worktreeId',
      columns: { worktreeId: 'text', goal: 'text', doneWhen: 'text', doneWhenKind: 'text', guidelines: 'json', level: 'text', switches: 'json', agent: 'text', sharedGoalId: 'text', notes: 'text', allowSplit: 'bool', updatedAt: 'int' }
    }),
    handoffs: tableAccess<HandoffRow>(store, {
      table: 'handoffs',
      key: 'worktreeId',
      columns: { worktreeId: 'text', state: 'text', sessionId: 'text', active: 'bool', handedOffAt: 'int', takenBackAt: 'int' }
    }),
    recordCursors: tableAccess<RecordCursor>(store, {
      table: 'record_cursors',
      key: 'sessionId',
      columns: { sessionId: 'text', worktreeId: 'text', path: 'text', readOffset: 'int', pending: 'json', updatedAt: 'int' }
    }),
    sharedGoals: tableAccess<SharedGoal>(store, {
      table: 'shared_goals',
      key: 'id',
      columns: { id: 'text', goal: 'text', worktreeIds: 'json', mergeOrder: 'json' }
    }),
    receipts: tableAccess<Receipt>(store, {
      table: 'receipts',
      key: 'id',
      columns: { id: 'text', fingerprint: 'text', sessionId: 'text', toolName: 'text', at: 'int', outcome: 'text', step: 'text' }
    }),
    approvals: tableAccess<Approval>(store, {
      table: 'approvals',
      key: 'id',
      columns: { id: 'text', worktreeId: 'text', fingerprint: 'text', usedAt: 'int' }
    }),
    lateAnswers: tableAccess<LateAnswer>(store, {
      table: 'late_answers',
      key: 'fingerprint',
      columns: { fingerprint: 'text', worktreeId: 'text', decision: 'text', reason: 'text', createdAt: 'int', usedAt: 'int' }
    }),
    needs: tableAccess<NeedsYouItem>(store, {
      table: 'needs_you',
      key: 'id',
      columns: { id: 'text', worktreeId: 'text', kind: 'text', title: 'text', detail: 'json', actions: 'json', createdAt: 'int', resolvedAt: 'int', resolution: 'text' }
    }),
    guesses: tableAccess<Guess>(store, {
      table: 'guesses',
      key: 'id',
      columns: { id: 'text', worktreeId: 'text', question: 'text', choice: 'text', confirmedAt: 'int', redoneAt: 'int', commitsSince: 'json' }
    }),
    outbox: tableAccess<OutboxRow>(store, {
      table: 'outbox',
      key: 'id',
      columns: { id: 'text', worktreeId: 'text', kind: 'text', payload: 'json', idempotencyKey: 'text', state: 'text', result: 'json' }
    }),
    findings: tableAccess<Finding>(store, {
      table: 'findings',
      key: 'id',
      columns: { id: 'text', worktreeId: 'text', source: 'text', summary: 'text', detail: 'json', valid: 'bool', reason: 'text', threadId: 'text', commitSha: 'text', createdAt: 'int' }
    }),
    stuck: tableAccess<StuckRow>(store, {
      table: 'stuck',
      key: 'worktreeId',
      columns: { worktreeId: 'text', rung: 'int', counters: 'json', updatedAt: 'int' }
    }),
    brainSessions: tableAccess<BrainSession>(store, {
      table: 'brain_sessions',
      key: 'id',
      columns: { id: 'text', sessionId: 'text', startedAt: 'int', endedAt: 'int', endTokens: 'int' }
    }),
    appendJournal(entry) {
      const { lastInsertRowid } = store.run(
        'INSERT INTO journal (at, worktree_id, kind, data, delivered_to_brain) VALUES (?, ?, ?, ?, 0)',
        entry.at, entry.worktreeId, entry.kind, JSON.stringify(entry.data)
      )
      return { seq: lastInsertRowid, ...entry }
    },
    journalSince(seq, only) {
      if (only === undefined) return store.all<JournalRow>('SELECT seq, at, worktree_id, kind, data FROM journal WHERE seq > ? ORDER BY seq', seq).map(journalEntry)
      if (only.kinds.length === 0) return []
      const placeholders = only.kinds.map(() => '?').join(', ')
      return store.all<JournalRow>(
        `SELECT seq, at, worktree_id, kind, data FROM journal WHERE seq > ? AND at >= ? AND kind IN (${placeholders}) ORDER BY seq`,
        seq, only.since, ...only.kinds
      ).map(journalEntry)
    },
    journalPage(opts = {}) {
      const clauses: string[] = []
      const params: StoreValue[] = []
      if (opts.worktreeId !== undefined) {
        clauses.push('worktree_id = ?')
        params.push(opts.worktreeId)
      }
      if (opts.before !== undefined) {
        clauses.push('seq < ?')
        params.push(opts.before)
      }
      const filter = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      return store
        .all<JournalRow>(`SELECT seq, at, worktree_id, kind, data FROM journal${filter} ORDER BY seq DESC LIMIT ?`, ...params, opts.limit ?? 100)
        .map(journalEntry)
    },
    undeliveredJournal: () =>
      store.all<JournalRow>('SELECT seq, at, worktree_id, kind, data FROM journal WHERE delivered_to_brain = 0 ORDER BY seq').map(journalEntry),
    markDelivered(seq) {
      store.run('UPDATE journal SET delivered_to_brain = 1 WHERE seq = ?', seq)
    },
    transaction: (fn) => store.transaction(fn)
  }
}
