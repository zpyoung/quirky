import type { PluginStore, StoreMigration } from '@quirky/protocol'
import type { DockAttachment, DockRecord, DockRecovery } from './types'
import {
  DEFAULT_GUTTER_ROWS,
  MAX_ATTACHMENTS,
  MAX_GUTTER_ROWS,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_ENTRIES,
  MAX_PERSISTED_PANES,
  MAX_PANES_PER_TAB,
  MAX_RECOVERABLE_CHARS,
  MIN_GUTTER_ROWS
} from './types'

export const migrations: StoreMigration[] = ['CREATE TABLE dock_records (pane TEXT PRIMARY KEY, record TEXT NOT NULL, updated_at INTEGER NOT NULL)']

const MAX_RECOVERY_PER_PANE = MAX_PANES_PER_TAB
const MAX_SEND_IDS = 200
const RECORD_KEYS: Record<string, true> = {
  pane: true,
  session: true,
  tab: true,
  revision: true,
  docked: true,
  userUndocked: true,
  autoOpenEvaluated: true,
  gutterRows: true,
  draft: true,
  attachments: true,
  draftAttachments: true,
  ownedAttachmentIds: true,
  providerPromptCount: true,
  agent: true,
  history: true,
  recovery: true,
  recentSendIds: true,
  nextSequence: true,
  notice: true,
  updatedAt: true
}
const ATTACHMENT_KEYS: Record<string, true> = { id: true, name: true, path: true, mime: true, image: true }
const RECOVERY_KEYS: Record<string, true> = {
  id: true,
  sequence: true,
  text: true,
  attachments: true,
  mayHaveWritten: true,
  createdAt: true
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function hasOnlyKeys(value: Record<string, unknown>, keys: Record<string, true>): boolean {
  return Object.keys(value).every((key) => key !== '__proto__' && key !== 'prototype' && key !== 'constructor' && Object.hasOwn(keys, key))
}

function validAttachment(value: unknown): value is DockAttachment {
  if (!isObject(value) || !hasOnlyKeys(value, ATTACHMENT_KEYS)) return false
  return (
    typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 160 &&
    typeof value.name === 'string' && value.name.length <= 512 &&
    typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096 &&
    typeof value.mime === 'string' && value.mime.length <= 256 &&
    typeof value.image === 'boolean'
  )
}

function validRecovery(value: unknown): value is DockRecovery {
  if (!isObject(value) || !hasOnlyKeys(value, RECOVERY_KEYS)) return false
  return (
    typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 160 &&
    Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 &&
    typeof value.text === 'string' && value.text.length <= MAX_RECOVERABLE_CHARS &&
    Array.isArray(value.attachments) && value.attachments.length <= MAX_ATTACHMENTS &&
    value.attachments.every((id) => typeof id === 'string' && id.length <= 160) &&
    typeof value.mayHaveWritten === 'boolean' &&
    Number.isFinite(value.createdAt)
  )
}

/** Independently rejects malformed or prototype-shaped persisted rows before using any values. */
export function validateDockRecord(value: unknown): DockRecord | null {
  if (!isObject(value) || !hasOnlyKeys(value, RECORD_KEYS)) return null
  if (
    typeof value.pane !== 'string' || value.pane.length === 0 || value.pane.length > 256 ||
    typeof value.session !== 'string' || value.session.length === 0 || value.session.length > 256 ||
    typeof value.tab !== 'string' || value.tab.length === 0 || value.tab.length > 256 ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    typeof value.docked !== 'boolean' ||
    typeof value.userUndocked !== 'boolean' ||
    typeof value.autoOpenEvaluated !== 'boolean' ||
    !Number.isInteger(value.gutterRows) || (value.gutterRows as number) < MIN_GUTTER_ROWS || (value.gutterRows as number) > MAX_GUTTER_ROWS ||
    typeof value.draft !== 'string' || value.draft.length > MAX_RECOVERABLE_CHARS ||
    !Array.isArray(value.attachments) || value.attachments.length > MAX_ATTACHMENTS || !value.attachments.every(validAttachment) ||
    !Array.isArray(value.draftAttachments) || value.draftAttachments.length > MAX_ATTACHMENTS || !value.draftAttachments.every((id) => typeof id === 'string' && id.length <= 160) ||
    !Array.isArray(value.ownedAttachmentIds) || value.ownedAttachmentIds.length > MAX_ATTACHMENTS || !value.ownedAttachmentIds.every((id) => typeof id === 'string' && id.length <= 160) ||
    !(value.agent === null || (typeof value.agent === 'string' && value.agent.length <= 128)) ||
    !Number.isSafeInteger(value.providerPromptCount) || (value.providerPromptCount as number) < 0 ||
    !Array.isArray(value.history) || value.history.length > MAX_HISTORY_ENTRIES || !value.history.every((entry) => typeof entry === 'string') ||
    !Array.isArray(value.recovery) || value.recovery.length > MAX_RECOVERY_PER_PANE || !value.recovery.every(validRecovery) ||
    !Array.isArray(value.recentSendIds) || value.recentSendIds.length > MAX_SEND_IDS || !value.recentSendIds.every((id) => typeof id === 'string' && id.length <= 160) ||
    !Number.isSafeInteger(value.nextSequence) || (value.nextSequence as number) < 1 ||
    !(value.notice === null || (typeof value.notice === 'string' && value.notice.length <= 1024)) ||
    !Number.isFinite(value.updatedAt)
  ) return null
  const historyChars = (value.history as string[]).reduce((total, entry) => total + entry.length, 0)
  if (historyChars > MAX_HISTORY_CHARS) return null
  if (recoverableTextLength(value.draft as string, value.recovery as DockRecovery[]) > MAX_RECOVERABLE_CHARS) return null
  if (recoverableAttachmentCount(value.draftAttachments as string[], value.recovery as DockRecovery[]) > MAX_ATTACHMENTS) return null
  const metadataIds = new Set((value.attachments as DockAttachment[]).map((attachment) => attachment.id))
  const attachmentRows = value.attachments as DockAttachment[]
  const draftAttachmentIds = value.draftAttachments as string[]
  const recoveryRows = value.recovery as DockRecovery[]
  if (metadataIds.size !== attachmentRows.length || new Set(draftAttachmentIds).size !== draftAttachmentIds.length) return null
  if (new Set(value.ownedAttachmentIds as string[]).size !== (value.ownedAttachmentIds as string[]).length) return null
  if (new Set(value.recentSendIds as string[]).size !== (value.recentSendIds as string[]).length) return null
  if (new Set(recoveryRows.map((item) => item.id)).size !== recoveryRows.length) return null
  if (new Set(recoveryRows.map((item) => item.sequence)).size !== recoveryRows.length) return null
  if (recoveryRows.some((item) => new Set(item.attachments).size !== item.attachments.length)) return null
  if ((value.draftAttachments as string[]).some((id) => !metadataIds.has(id))) return null
  if ((value.recovery as DockRecovery[]).some((item) => item.attachments.some((id) => !metadataIds.has(id)))) return null
  if ((value.ownedAttachmentIds as string[]).some((id) => !metadataIds.has(id))) return null
  return value as unknown as DockRecord
}

/** The budget reserves exactly two separator characters per nonempty restoration boundary. */
export function recoverableTextLength(draft: string, recovery: DockRecovery[]): number {
  let characters = draft.length
  let count = draft.length > 0 ? 1 : 0
  for (const item of recovery) {
    if (item.text.length === 0) continue
    characters += item.text.length
    count++
  }
  return characters + Math.max(0, count - 1) * 2
}

export function recoverableAttachmentCount(draftAttachmentIds: string[], recovery: DockRecovery[]): number {
  return draftAttachmentIds.length + recovery.reduce((total, item) => total + item.attachments.length, 0)
}

/** Applies the independent history entry/character caps, retaining newest prompts and collapsing duplicates. */
export function boundedHistory(entries: string[]): string[] {
  const unique: string[] = []
  for (const entry of entries) {
    if (entry.length === 0 || unique.at(-1) === entry) continue
    unique.push(entry)
  }
  while (unique.length > MAX_HISTORY_ENTRIES) unique.shift()
  let characters = unique.reduce((total, entry) => total + entry.length, 0)
  while (characters > MAX_HISTORY_CHARS && unique.length > 0) characters -= unique.shift()!.length
  return unique
}

export function defaultDockRecord(pane: string, session: string, tab: string, now = Date.now()): DockRecord {
  return {
    pane,
    session,
    tab,
    revision: 0,
    docked: false,
    userUndocked: false,
    autoOpenEvaluated: false,
    gutterRows: DEFAULT_GUTTER_ROWS,
    draft: '',
    attachments: [],
    draftAttachments: [],
    ownedAttachmentIds: [],
    agent: null,
    history: [],
    providerPromptCount: 0,
    recovery: [],
    recentSendIds: [],
    nextSequence: 1,
    notice: null,
    updatedAt: now
  }
}

/** Durable records are one JSON row apiece so every draft/recovery change is a single SQL statement. */
export class DockStore {
  constructor(private readonly store: PluginStore) {}

  get(pane: string): DockRecord | null {
    const row = this.store.get<{ record: string }>('SELECT record FROM dock_records WHERE pane = ?', pane)
    if (!row) return null
    try {
      return validateDockRecord(JSON.parse(row.record))
    } catch {
      return null
    }
  }

  all(): DockRecord[] {
    const records: DockRecord[] = []
    for (const row of this.store.all<{ record: string }>('SELECT record FROM dock_records ORDER BY updated_at DESC')) {
      try {
        const record = validateDockRecord(JSON.parse(row.record))
        if (record) records.push(record)
      } catch {
        // A bad row is isolated; remaining panes stay available.
      }
    }
    return records
  }

  put(record: DockRecord): void {
    this.store.run(
      'INSERT INTO dock_records (pane, record, updated_at) VALUES (?, ?, ?) ON CONFLICT(pane) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at',
      record.pane,
      JSON.stringify(record),
      record.updatedAt
    )
  }

  delete(pane: string): void {
    this.store.run('DELETE FROM dock_records WHERE pane = ?', pane)
  }

  transaction<T>(work: () => T): T {
    return this.store.transaction(work)
  }

  /** Drops oldest unpinned records after current workspace identity has been resolved by the service. */
  prune(retainedPanes: Set<string>, mountedPanes: Set<string>, tabByPane: Map<string, string>): void {
    this.store.transaction(() => {
      for (const row of this.store.all<{ pane: string; record: string }>('SELECT pane, record FROM dock_records')) {
        try {
          const record = validateDockRecord(JSON.parse(row.record))
          if (!record || record.pane !== row.pane) this.delete(row.pane)
        } catch {
          this.delete(row.pane)
        }
      }
      const live = this.all()
      for (const record of live) if (!retainedPanes.has(record.pane)) this.delete(record.pane)
      const byTab = new Map<string, DockRecord[]>()
      for (const record of this.all()) {
        const tab = tabByPane.get(record.pane) ?? record.tab
        const records = byTab.get(tab) ?? []
        records.push(record)
        byTab.set(tab, records)
      }
      const remove = new Set<string>()
      for (const records of byTab.values()) {
        const keep = [...records].sort((a, b) => Number(mountedPanes.has(b.pane)) - Number(mountedPanes.has(a.pane)) || b.updatedAt - a.updatedAt)
        for (const record of keep.slice(MAX_PANES_PER_TAB)) if (!mountedPanes.has(record.pane)) remove.add(record.pane)
      }
      const afterTabs = this.all().filter((record) => !remove.has(record.pane))
      const inactive = afterTabs.filter((record) => !mountedPanes.has(record.pane)).sort((a, b) => b.updatedAt - a.updatedAt)
      for (const record of inactive.slice(MAX_PERSISTED_PANES)) remove.add(record.pane)
      for (const pane of remove) this.delete(pane)
    })
  }
}
