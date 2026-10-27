import type { PluginContext, PluginStore, StoreMigration } from '@quirky/protocol'
import { isRecord } from './content'

export type LedgerRow = {
  ledger_id: string
  tier: 'project' | 'group'
  owner_id: string | null
  former_tier: 'project' | 'group' | null
  former_id: string | null
  name: string
  owner_path: string | null
  repo_id: string | null
  identity_key: string | null
  revision: number
  next_sequence: number
  stale_after_days: number
  source_equivalences: string
  metadata_history: string
  created_at: string
  updated_at: string
}

export type EntryRow = {
  ledger_id: string
  id: string
  type: string
  sequence: number
  revision: number
  content: string
  state: string
  reviewed: number
  origin: string
  created_at: string
  updated_at: string
  latest_content_actor: string
}

export type HistoryRow = {
  ledger_id: string
  entry_id: string
  revision: number
  at: string
  actor: string
  before: string
  after: string
  changed_fields: string
}

export type AnchorRow = {
  ledger_id: string
  anchor: string
  entry_id: string
  baseline: string | null
  source_path: string
  source_base: string
  legacy_id: string
  deleted: number
}

export const migrations: StoreMigration[] = [
  (store) => {
    store.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE ledgers (
        ledger_id TEXT PRIMARY KEY,
        tier TEXT NOT NULL CHECK (tier IN ('project', 'group')),
        owner_id TEXT,
        former_tier TEXT CHECK (former_tier IN ('project', 'group') OR former_tier IS NULL),
        former_id TEXT,
        name TEXT NOT NULL,
        owner_path TEXT,
        repo_id TEXT,
        identity_key TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
        stale_after_days INTEGER NOT NULL CHECK (stale_after_days BETWEEN 0 AND 3650),
        source_equivalences TEXT NOT NULL,
        metadata_history TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX ledger_live_owner ON ledgers(tier, owner_id) WHERE owner_id IS NOT NULL;
      CREATE INDEX ledger_identity_key ON ledgers(tier, identity_key) WHERE identity_key IS NOT NULL;
      CREATE TABLE entries (
        ledger_id TEXT NOT NULL,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        content TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'archived')),
        reviewed INTEGER NOT NULL CHECK (reviewed IN (0, 1)),
        origin TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        latest_content_actor TEXT NOT NULL,
        PRIMARY KEY (ledger_id, id),
        UNIQUE (ledger_id, sequence)
      );
      CREATE INDEX entries_activity ON entries(ledger_id, updated_at);
      CREATE TABLE history (
        ledger_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        before TEXT NOT NULL,
        after TEXT NOT NULL,
        changed_fields TEXT NOT NULL,
        PRIMARY KEY (ledger_id, entry_id, revision)
      );
      CREATE TABLE anchors (
        ledger_id TEXT NOT NULL,
        anchor TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        baseline TEXT,
        source_path TEXT NOT NULL,
        source_base TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        PRIMARY KEY (ledger_id, anchor)
      );
      CREATE INDEX anchors_entry ON anchors(ledger_id, entry_id);
      CREATE TABLE repo_identities (
        repo_id TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL
      );
    `)
  }
]

export function openStore(context: PluginContext): PluginStore {
  return context.openStore(migrations)
}

export function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch (error) {
    throw new Error(`invalid persisted ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function stringify(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

export function validateStore(store: PluginStore): void {
  const ledgers = store.all<LedgerRow>('SELECT * FROM ledgers')
  const ledgerIds = new Set<string>()
  const liveOwners = new Set<string>()
  const entries = store.all<EntryRow>('SELECT * FROM entries')
  const entryKeys = new Set<string>()
  const validIso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  const validActor = (value: unknown): boolean => {
    if (!isRecord(value) || !['human', 'agent', 'import', 'unknown'].includes(String(value.kind))) return false
    if (value.tool !== undefined && typeof value.tool !== 'string') return false
    if (value.model !== undefined && value.model !== null && typeof value.model !== 'string') return false
    if (value.providerSessionId !== undefined && value.providerSessionId !== null && typeof value.providerSessionId !== 'string') return false
    return value.kind !== 'import' || validActor(value.initiator)
  }
  const validSnapshot = (value: unknown): boolean =>
    isRecord(value) && isRecord(value.content) && ['open', 'resolved', 'archived'].includes(String(value.state)) && typeof value.reviewed === 'boolean'
  const requiredByType: Record<string, string[]> = {
    bug: ['title', 'file', 'description', 'severity'],
    deferred: ['title', 'why_deferred', 'priority'],
    'test-gap': ['title', 'file_under_test', 'reason_skipped'],
    proposal: ['title', 'context', 'recommendation'],
    decision: ['title', 'context', 'decision', 'consequences', 'status']
  }
  const locationByType: Record<string, string> = { bug: 'file', 'test-gap': 'file_under_test' }
  const enumByType: Record<string, Record<string, string[]>> = {
    bug: { severity: ['critical', 'high', 'medium', 'low'] },
    deferred: { priority: ['high', 'medium', 'low'] },
    decision: { status: ['proposed', 'accepted', 'superseded'] }
  }
  for (const ledger of ledgers) {
    if (!ledger.ledger_id || !['project', 'group'].includes(ledger.tier) || !Number.isSafeInteger(ledger.revision) || ledger.revision < 0 || !Number.isSafeInteger(ledger.next_sequence) || ledger.next_sequence < 1 || !Number.isSafeInteger(ledger.stale_after_days) || ledger.stale_after_days < 0 || ledger.stale_after_days > 3650 || typeof ledger.name !== 'string' || !ledger.name || !validIso(ledger.created_at) || !validIso(ledger.updated_at)) {
      throw new Error(`invalid ledger record ${ledger.ledger_id || '<unknown>'}`)
    }
    if ((ledger.former_tier === null) !== (ledger.former_id === null) || (ledger.former_tier !== null && ledger.former_tier !== ledger.tier) || (ledger.owner_id === null && ledger.former_id === null)) {
      throw new Error(`invalid owner record for ledger ${ledger.ledger_id}`)
    }
    if (ledger.owner_id !== null) {
      const key = `${ledger.tier}:${ledger.owner_id}`
      if (liveOwners.has(key)) throw new Error(`duplicate live owner ${key}`)
      liveOwners.add(key)
    }
    if (ledgerIds.has(ledger.ledger_id)) throw new Error(`duplicate ledger ${ledger.ledger_id}`)
    ledgerIds.add(ledger.ledger_id)
    const equivalences = parseJson<unknown>(ledger.source_equivalences, `source equivalences for ${ledger.ledger_id}`)
    if (!Array.isArray(equivalences) || equivalences.some((group) => !Array.isArray(group) || group.some((id) => typeof id !== 'string' || !id))) throw new Error(`invalid source equivalences for ${ledger.ledger_id}`)
    const metadata = parseJson<unknown>(ledger.metadata_history, `metadata history for ${ledger.ledger_id}`)
    if (!Array.isArray(metadata)) throw new Error(`invalid metadata history for ${ledger.ledger_id}`)
    let previousMetadataRevision = 0
    for (const item of metadata) {
      if (!isRecord(item) || !Number.isSafeInteger(item.revision) || (item.revision as number) <= previousMetadataRevision || (item.revision as number) > ledger.revision || !validIso(item.at) || !validActor(item.actor) || !isRecord(item.before) || !isRecord(item.after) || !['detached', 'reattached', 'attached', 'settings'].includes(String(item.action)) || !Array.isArray(item.changedFields) || item.changedFields.some((field) => typeof field !== 'string')) {
        throw new Error(`invalid metadata history for ${ledger.ledger_id}`)
      }
      previousMetadataRevision = item.revision as number
    }
  }

  for (const entry of entries) {
    if (!ledgerIds.has(entry.ledger_id) || !entry.id || !['bug', 'deferred', 'test-gap', 'proposal', 'decision'].includes(entry.type) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !['open', 'resolved', 'archived'].includes(entry.state) || (entry.reviewed !== 0 && entry.reviewed !== 1) || !validIso(entry.created_at) || !validIso(entry.updated_at)) {
      throw new Error(`invalid entry record ${entry.ledger_id}/${entry.id}`)
    }
    entryKeys.add(`${entry.ledger_id}\\0${entry.id}`)
    const content = parseJson<unknown>(entry.content, `entry content for ${entry.ledger_id}/${entry.id}`)
    const origin = parseJson<unknown>(entry.origin, `entry origin for ${entry.ledger_id}/${entry.id}`)
    const actor = parseJson<unknown>(entry.latest_content_actor, `entry actor for ${entry.ledger_id}/${entry.id}`)
    if (!isRecord(content) || !isRecord(origin) || !validActor(actor)) throw new Error(`invalid entry payload ${entry.ledger_id}/${entry.id}`)
    for (const field of requiredByType[entry.type]!) {
      const value = content[field]
      if (field === locationByType[entry.type]) {
        if (!isRecord(value) || typeof value.path !== 'string' || !value.path.trim() || !isRecord(value.base) || (value.base.kind !== 'project' && value.base.kind !== 'workspace') || typeof value.base.id !== 'string' || !value.base.id || (value.line !== undefined && (typeof value.line !== 'number' || !Number.isSafeInteger(value.line) || value.line <= 0)) || (value.external !== undefined && typeof value.external !== 'boolean') || (value.external === true && (typeof value.host !== 'string' || !value.host.trim()))) {
          throw new Error(`invalid location content for ${entry.ledger_id}/${entry.id}`)
        }
      } else if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`invalid required content for ${entry.ledger_id}/${entry.id}`)
      }
    }
    for (const [field, allowed] of Object.entries(enumByType[entry.type] ?? {})) if (!allowed.includes(String(content[field]))) throw new Error(`invalid enum content for ${entry.ledger_id}/${entry.id}`)
    for (const key of ['workspaceId', 'branch', 'host', 'revision'] as const) if (origin[key] !== undefined && typeof origin[key] !== 'string') throw new Error(`invalid origin for ${entry.ledger_id}/${entry.id}`)
    if (origin.observedAt !== undefined && !validIso(origin.observedAt)) throw new Error(`invalid origin timestamp for ${entry.ledger_id}/${entry.id}`)
    if (origin.owner !== undefined && (!isRecord(origin.owner) || (origin.owner.tier !== 'project' && origin.owner.tier !== 'group') || typeof origin.owner.id !== 'string' || !origin.owner.id)) throw new Error(`invalid origin owner for ${entry.ledger_id}/${entry.id}`)
    const ledger = ledgers.find((item) => item.ledger_id === entry.ledger_id)!
    if (entry.sequence >= ledger.next_sequence) throw new Error(`invalid sequence counter for ${entry.ledger_id}/${entry.id}`)
    const history = store.all<HistoryRow>('SELECT * FROM history WHERE ledger_id = ? AND entry_id = ? ORDER BY revision', entry.ledger_id, entry.id)
    if (history.length !== entry.revision || history.some((item, index) => item.revision !== index + 1)) throw new Error(`invalid history revisions for ${entry.ledger_id}/${entry.id}`)
    for (const item of history) {
      const historyActor = parseJson<unknown>(item.actor, `history actor for ${entry.ledger_id}/${entry.id}`)
      const before = parseJson<unknown>(item.before, `history before snapshot for ${entry.ledger_id}/${entry.id}`)
      const after = parseJson<unknown>(item.after, `history after snapshot for ${entry.ledger_id}/${entry.id}`)
      const fields = parseJson<unknown>(item.changed_fields, `history fields for ${entry.ledger_id}/${entry.id}`)
      if (!validIso(item.at) || !validActor(historyActor) || !validSnapshot(before) || !validSnapshot(after) || !Array.isArray(fields) || fields.some((field) => typeof field !== 'string')) {
        throw new Error(`invalid history payload for ${entry.ledger_id}/${entry.id}`)
      }
    }
  }

  for (const history of store.all<HistoryRow>('SELECT * FROM history')) {
    if (!entryKeys.has(`${history.ledger_id}\\0${history.entry_id}`)) throw new Error(`orphan history for ${history.ledger_id}/${history.entry_id}`)
  }
  for (const anchor of store.all<AnchorRow>('SELECT * FROM anchors')) {
    if (!ledgerIds.has(anchor.ledger_id) || !anchor.anchor || !anchor.entry_id || !anchor.source_path || !anchor.legacy_id || (anchor.deleted !== 0 && anchor.deleted !== 1)) throw new Error(`invalid import anchor in ${anchor.ledger_id}`)
    const base = parseJson<unknown>(anchor.source_base, `import anchor base in ${anchor.ledger_id}`)
    if (!isRecord(base) || (base.kind !== 'project' && base.kind !== 'workspace') || typeof base.id !== 'string' || !base.id) throw new Error(`invalid import anchor base in ${anchor.ledger_id}`)
    if (anchor.deleted === 1) {
      if (anchor.baseline !== null) throw new Error(`deleted import anchor has a baseline in ${anchor.ledger_id}`)
    } else {
      if (anchor.baseline === null || !entryKeys.has(`${anchor.ledger_id}\\0${anchor.entry_id}`)) throw new Error(`unresolved import anchor in ${anchor.ledger_id}`)
      const baseline = parseJson<unknown>(anchor.baseline, `import baseline in ${anchor.ledger_id}`)
      if (!isRecord(baseline)) throw new Error(`invalid import baseline in ${anchor.ledger_id}`)
    }
  }
  for (const identity of store.all<{ repo_id: string; identity_key: string }>('SELECT * FROM repo_identities')) {
    if (!identity.repo_id || !identity.identity_key) throw new Error('invalid repository identity mapping')
  }
}
