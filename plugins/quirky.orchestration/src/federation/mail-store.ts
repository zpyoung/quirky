import { createHash } from 'node:crypto'
import type { PluginStore, StoreMigration } from '@quirky/protocol'
import type { FederationRelayItem } from './contracts'
import type { JsonValue } from '../contracts'

export type MailDirection = FederationRelayItem['direction']
type RelayKind = FederationRelayItem['kind']

type StreamRow = {
  binding_id: string
  direction: MailDirection
  next_sequence: number
  acknowledged_through: number
  received_through: number
}
type OutboxRow = {
  binding_id: string
  direction: MailDirection
  sequence: number
  item_id: string
  kind: RelayKind
  payload_json: string
  payload_hash: string
  result_json?: string | null
}
type InboxRow = OutboxRow & { result_json: string }

export const federationMailMigrations: StoreMigration[] = [`
  CREATE TABLE IF NOT EXISTS federation_mail_streams (
    binding_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('to_home', 'to_worker')),
    next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
    acknowledged_through INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_through >= 0),
    received_through INTEGER NOT NULL DEFAULT 0 CHECK (received_through >= 0),
    PRIMARY KEY (binding_id, direction)
  );
  CREATE TABLE IF NOT EXISTS federation_mail_outbox (
    binding_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('to_home', 'to_worker')),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'question', 'reply', 'lifecycle')),
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (binding_id, direction, sequence),
    UNIQUE (binding_id, direction, item_id)
  );
  CREATE INDEX IF NOT EXISTS federation_mail_outbox_pending
    ON federation_mail_outbox(binding_id, direction, sequence);
  CREATE TABLE IF NOT EXISTS federation_mail_inbox (
    binding_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('to_home', 'to_worker')),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'question', 'reply', 'lifecycle')),
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (binding_id, direction, sequence),
    UNIQUE (binding_id, direction, item_id)
  );
  CREATE INDEX IF NOT EXISTS federation_mail_inbox_item
    ON federation_mail_inbox(item_id, binding_id, direction);
  CREATE TABLE IF NOT EXISTS federation_mail_question_bindings (
    binding_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('to_home', 'to_worker')),
    PRIMARY KEY (binding_id, question_id)
  );
  CREATE INDEX IF NOT EXISTS federation_mail_question_id
    ON federation_mail_question_bindings(question_id);
`]


function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Federation mail payload must be JSON serializable')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function relayItem(row: OutboxRow): FederationRelayItem {
  return {
    sequence: row.sequence,
    id: row.item_id,
    bindingId: row.binding_id,
    direction: row.direction,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, JsonValue>,
  }
}

function samePayload(row: Pick<OutboxRow, 'kind' | 'payload_hash'>, kind: RelayKind, payloadHash: string): boolean {
  return row.kind === kind && row.payload_hash === payloadHash
}

/** Durable, strictly ordered streams sharing the orchestration PluginStore. */
export class FederationMailStore {
  constructor(private readonly store: PluginStore) {
    if (store.readOnly) throw new Error('Federation mail requires a writable orchestration store')
  }

  enqueue(bindingId: string, direction: MailDirection, id: string, kind: RelayKind, payload: Record<string, JsonValue>): FederationRelayItem {
    if (!bindingId || !id) throw new Error('Federation mail item requires binding and item IDs')
    const payloadJson = canonical(payload)
    const payloadHash = digest(payloadJson)
    return this.store.transaction(() => {
      this.ensureStream(bindingId, direction)
      const existing = this.store.get<OutboxRow>(
        `SELECT binding_id, direction, sequence, item_id, kind, payload_json, payload_hash, result_json
         FROM federation_mail_outbox WHERE binding_id = ? AND direction = ? AND item_id = ?`,
        bindingId, direction, id,
      )
      if (existing) {
        if (!samePayload(existing, kind, payloadHash)) throw new Error(`Federation relay item ${id} was replayed with conflicting content`)
        return relayItem(existing)
      }
      const stream = this.requireStream(bindingId, direction)
      const sequence = stream.next_sequence
      this.store.run(
        `INSERT INTO federation_mail_outbox (binding_id, direction, sequence, item_id, kind, payload_json, payload_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        bindingId, direction, sequence, id, kind, payloadJson, payloadHash, new Date().toISOString(),
      )
      const update = this.store.run(
        `UPDATE federation_mail_streams SET next_sequence = ? WHERE binding_id = ? AND direction = ? AND next_sequence = ?`,
        sequence + 1, bindingId, direction, sequence,
      )
      if (update.changes !== 1) throw new Error(`Federation mail sequence changed while queuing ${id}`)
      return { sequence, id, bindingId, direction, kind, payload }
    })
  }

  cursor(bindingId: string, direction: MailDirection): number {
    this.ensureStream(bindingId, direction)
    return this.requireStream(bindingId, direction).received_through
  }

  outboxCursor(bindingId: string, direction: MailDirection): number {
    this.ensureStream(bindingId, direction)
    return this.requireStream(bindingId, direction).acknowledged_through
  }

  listOutbox(bindingId: string, direction: MailDirection, after: number, limit: number): FederationRelayItem[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Federation mail cursor must be a non-negative integer')
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Federation mail page size must be between 1 and 50')
    this.ensureStream(bindingId, direction)
    const highest = this.requireStream(bindingId, direction).next_sequence - 1
    if (after > highest) throw new Error(`Federation mail cursor ${after} is beyond sequence ${highest}`)
    return this.store.all<OutboxRow>(
      `SELECT binding_id, direction, sequence, item_id, kind, payload_json, payload_hash
       FROM federation_mail_outbox WHERE binding_id = ? AND direction = ? AND sequence > ?
       ORDER BY sequence LIMIT ?`,
      bindingId, direction, after, limit,
    ).map(relayItem)
  }

  acknowledge(bindingId: string, direction: MailDirection, through: number): number {
    if (!Number.isSafeInteger(through) || through < 0) throw new Error('Federation acknowledgement must be a non-negative integer')
    return this.store.transaction(() => {
      this.ensureStream(bindingId, direction)
      const stream = this.requireStream(bindingId, direction)
      const highest = stream.next_sequence - 1
      if (through > highest) throw new Error(`Federation acknowledgement ${through} exceeds queued sequence ${highest}`)
      if (through <= stream.acknowledged_through) return stream.acknowledged_through
      const queued = this.store.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM federation_mail_outbox WHERE binding_id = ? AND direction = ?
         AND sequence > ? AND sequence <= ?`,
        bindingId, direction, stream.acknowledged_through, through,
      )
      if (queued?.count !== through - stream.acknowledged_through) {
        throw new Error(`Federation acknowledgement ${through} would skip a queued item`)
      }
      this.store.run(
        `UPDATE federation_mail_streams SET acknowledged_through = ? WHERE binding_id = ? AND direction = ?`,
        through, bindingId, direction,
      )
      return through
    })
  }

  result(bindingId: string, direction: MailDirection, id: string): unknown | null {
    const row = this.store.get<{ result_json: string | null }>(
      `SELECT result_json FROM federation_mail_outbox WHERE binding_id = ? AND direction = ? AND item_id = ?`,
      bindingId, direction, id,
    )
    return row?.result_json == null ? null : JSON.parse(row.result_json) as unknown
  }

  complete(bindingId: string, direction: MailDirection, id: string, result: unknown): void {
    const resultJson = canonical(result)
    this.store.transaction(() => {
      const row = this.store.get<{ result_json: string | null }>(
        `SELECT result_json FROM federation_mail_outbox WHERE binding_id = ? AND direction = ? AND item_id = ?`,
        bindingId, direction, id,
      )
      if (!row) throw new Error(`Federation mail item ${id} is not queued`)
      if (row.result_json !== null && row.result_json !== undefined && row.result_json !== resultJson) {
        throw new Error(`Federation mail item ${id} received conflicting results`)
      }
      this.store.run(
        `UPDATE federation_mail_outbox SET result_json = ? WHERE binding_id = ? AND direction = ? AND item_id = ?`,
        resultJson, bindingId, direction, id,
      )
    })
  }

  bindQuestion(bindingId: string, questionId: string, direction: MailDirection): void {
    this.store.run(
      `INSERT OR IGNORE INTO federation_mail_question_bindings (binding_id, question_id, direction) VALUES (?, ?, ?)`,
      bindingId, questionId, direction,
    )
  }

  questionBinding(questionId: string): { binding_id: string; direction: MailDirection } | null {
    return this.store.get<{ binding_id: string; direction: MailDirection }>(
      `SELECT binding_id, direction FROM federation_mail_question_bindings WHERE question_id = ?`,
      questionId,
    )
  }

  importedBinding(itemId: string): { binding_id: string; direction: MailDirection } | null {
    return this.store.get<{ binding_id: string; direction: MailDirection }>(
      `SELECT binding_id, direction FROM federation_mail_inbox WHERE item_id = ? LIMIT 1`,
      itemId,
    )
  }

  prepareImport(item: FederationRelayItem): { duplicate: true; result: unknown } | { duplicate: false } {
    this.validateItem(item)
    this.ensureStream(item.bindingId, item.direction)
    const cursor = this.requireStream(item.bindingId, item.direction).received_through
    if (item.sequence > cursor + 1) throw new Error(`Federation mail sequence gap: expected ${cursor + 1}, received ${item.sequence}`)
    if (item.sequence === cursor + 1) return { duplicate: false }
    const row = this.store.get<InboxRow>(
      `SELECT binding_id, direction, sequence, item_id, kind, payload_json, payload_hash, result_json
       FROM federation_mail_inbox WHERE binding_id = ? AND direction = ? AND sequence = ?`,
      item.bindingId, item.direction, item.sequence,
    )
    if (!row || row.item_id !== item.id || !samePayload(row, item.kind, digest(canonical(item.payload)))) {
      throw new Error(`Federation mail replay conflicts at sequence ${item.sequence}`)
    }
    return { duplicate: true, result: JSON.parse(row.result_json) as unknown }
  }

  commitImport(item: FederationRelayItem, result: unknown, questionId?: string): void {
    this.validateItem(item)
    const payloadJson = canonical(item.payload)
    const payloadHash = digest(payloadJson)
    const resultJson = canonical(result)
    this.store.transaction(() => {
      this.ensureStream(item.bindingId, item.direction)
      const stream = this.requireStream(item.bindingId, item.direction)
      if (item.sequence !== stream.received_through + 1) {
        throw new Error(`Federation mail sequence changed before committing ${item.sequence}`)
      }
      this.store.run(
        `INSERT INTO federation_mail_inbox (binding_id, direction, sequence, item_id, kind, payload_json, payload_hash, result_json, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.bindingId, item.direction, item.sequence, item.id, item.kind, payloadJson, payloadHash, resultJson, new Date().toISOString(),
      )
      const update = this.store.run(
        `UPDATE federation_mail_streams SET received_through = ? WHERE binding_id = ? AND direction = ? AND received_through = ?`,
        item.sequence, item.bindingId, item.direction, item.sequence - 1,
      )
      if (update.changes !== 1) throw new Error(`Federation mail cursor changed while committing ${item.sequence}`)
      if (item.kind === 'question') {
        const linkedQuestionId = questionId ?? item.id
        if (linkedQuestionId !== item.id) throw new Error('Federation question ID does not match its relay item')
        this.store.run(
          `INSERT OR IGNORE INTO federation_mail_question_bindings (binding_id, question_id, direction)
           VALUES (?, ?, ?)`,
          item.bindingId, linkedQuestionId, item.direction,
        )
      }
    })
  }

  hasUnfinished(bindingId: string): boolean {
    const row = this.store.get<{ pending: number }>(
      `SELECT COUNT(*) AS pending FROM federation_mail_outbox o
       JOIN federation_mail_streams s ON s.binding_id = o.binding_id AND s.direction = o.direction
       WHERE o.binding_id = ? AND o.sequence > s.acknowledged_through`,
      bindingId,
    )
    return (row?.pending ?? 0) > 0
  }

  clearAll(): string[] {
    return this.store.transaction(() => {
      const bindingIds = this.store.all<{ binding_id: string }>(
        `SELECT DISTINCT binding_id FROM federation_mail_streams ORDER BY binding_id`,
      ).map((row) => row.binding_id)
      this.store.run(`DELETE FROM federation_mail_question_bindings`)
      this.store.run(`DELETE FROM federation_mail_inbox`)
      this.store.run(`DELETE FROM federation_mail_outbox`)
      this.store.run(`DELETE FROM federation_mail_streams`)
      return bindingIds
    })
  }

  private ensureStream(bindingId: string, direction: MailDirection): void {
    this.store.run(
      `INSERT OR IGNORE INTO federation_mail_streams (binding_id, direction, next_sequence, acknowledged_through, received_through)
       VALUES (?, ?, 1, 0, 0)`,
      bindingId, direction,
    )
  }

  private requireStream(bindingId: string, direction: MailDirection): StreamRow {
    const stream = this.store.get<StreamRow>(
      `SELECT binding_id, direction, next_sequence, acknowledged_through, received_through
       FROM federation_mail_streams WHERE binding_id = ? AND direction = ?`,
      bindingId, direction,
    )
    if (!stream) throw new Error(`Federation mail stream ${bindingId}/${direction} was not initialized`)
    return stream
  }

  private validateItem(item: FederationRelayItem): void {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Number.isSafeInteger(item.sequence) || item.sequence < 1 ||
      typeof item.id !== 'string' || item.id.length === 0 || typeof item.bindingId !== 'string' || item.bindingId.length === 0 ||
      (item.direction !== 'to_home' && item.direction !== 'to_worker') ||
      (item.kind !== 'message' && item.kind !== 'question' && item.kind !== 'reply' && item.kind !== 'lifecycle') ||
      !item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) {
      throw new Error('Invalid federation relay item')
    }
  }
}
