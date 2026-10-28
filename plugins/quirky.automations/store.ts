import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { PluginStore, StoreMigration } from '@quirky/protocol'
import type {
  AutomationDefinition,
  AutomationRun,
  AutomationRunInput,
  AutomationRunPatch,
  AutomationRunsPage,
  AutomationRunStatus,
  AutomationStore
} from './types'

export type AutomationStoreErrorCode = 'not-found' | 'conflict' | 'invalid-params'

export class AutomationStoreError extends Error {
  readonly code: AutomationStoreErrorCode

  constructor(code: AutomationStoreErrorCode, message: string) {
    super(message)
    this.name = 'AutomationStoreError'
    this.code = code
  }
}

export class PrunedAutomationOccurrenceError extends AutomationStoreError {
  constructor() {
    super('conflict', 'This scheduled occurrence has already been processed and is no longer retained.')
    this.name = 'PrunedAutomationOccurrenceError'
  }
}

export const migrations: StoreMigration[] = [
  `CREATE TABLE automation_definitions (
    id TEXT PRIMARY KEY NOT NULL,
    creation_key TEXT UNIQUE,
    name TEXT NOT NULL,
    next_run_number INTEGER NOT NULL DEFAULT 1,
    pruned_scheduled_through INTEGER,
    data TEXT NOT NULL
  );
  CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY NOT NULL,
    automation_id TEXT NOT NULL REFERENCES automation_definitions(id) ON DELETE CASCADE,
    run_number INTEGER NOT NULL,
    scheduled_for INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (automation_id, run_number)
  );
  CREATE INDEX automation_runs_history ON automation_runs (automation_id, created_at DESC, id ASC);
  CREATE UNIQUE INDEX automation_runs_scheduled ON automation_runs (automation_id, scheduled_for) WHERE trigger = 'scheduled';
  CREATE TABLE automation_occurrences (
    automation_id TEXT NOT NULL REFERENCES automation_definitions(id) ON DELETE CASCADE,
    scheduled_for INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    PRIMARY KEY (automation_id, scheduled_for)
  );
  CREATE INDEX automation_occurrences_run ON automation_occurrences (run_id);`
]

const MAX_FINAL_RUNS = 100
const MAX_OUTPUT_BYTES = 256 * 1024
const FINAL_STATUSES: readonly AutomationRunStatus[] = [
  'completed',
  'skipped_precheck',
  'skipped_missed',
  'skipped_unavailable',
  'skipped_needs_interactive_auth',
  'dispatch_failed'
]
const RUN_STATUSES = new Set<AutomationRunStatus>(['pending', 'dispatching', 'dispatched', ...FINAL_STATUSES])

function encode(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Automation store values must be JSON serializable')
  return serialized
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T
}

function isFinalStatus(status: AutomationRunStatus): boolean {
  return FINAL_STATUSES.includes(status)
}

function isRefusalStatus(status: AutomationRunStatus): boolean {
  return status !== 'completed' && isFinalStatus(status)
}

function canTransition(from: AutomationRunStatus, to: AutomationRunStatus): boolean {
  if (from === to) return true
  if (isFinalStatus(from)) return false
  if (from === 'pending') return to === 'dispatching' || isRefusalStatus(to)
  if (from === 'dispatching') return to === 'dispatched' || isFinalStatus(to)
  if (from === 'dispatched') return isFinalStatus(to)
  return false
}

function isRunStatus(value: unknown): value is AutomationRunStatus {
  return typeof value === 'string' && RUN_STATUSES.has(value as AutomationRunStatus)
}

function capOutputSnapshot(run: AutomationRun): AutomationRun {
  const snapshot = run.outputSnapshot
  if (!snapshot || Buffer.byteLength(snapshot.content, 'utf8') <= MAX_OUTPUT_BYTES) return run

  let byteLength = 0
  let end = 0
  for (let index = 0; index < snapshot.content.length;) {
    const first = snapshot.content.charCodeAt(index)
    let codePoint = first
    let units = 1
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < snapshot.content.length) {
      const second = snapshot.content.charCodeAt(index + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = ((first - 0xd800) << 10) + second - 0xdc00 + 0x10000
        units = 2
      }
    }
    const bytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (byteLength + bytes > MAX_OUTPUT_BYTES) break
    byteLength += bytes
    index += units
    end = index
  }

  return {
    ...run,
    outputSnapshot: { ...snapshot, content: snapshot.content.slice(0, end), truncated: true }
  }
}


function normalizeWorkspacePolicy(definition: AutomationDefinition): AutomationDefinition {
  const normalized = { ...definition }
  if (normalized.workspaceMode === 'existing') {
    normalized.baseBranch = null
    delete normalized.setupDecision
  } else {
    normalized.workspaceId = null
    normalized.reuseSession = false
  }
  return normalized
}

type DefinitionRow = { id: string; creation_key: string | null; name: string; next_run_number: number; pruned_scheduled_through: number | null; data: string }
type RunRow = { id: string; automation_id: string; run_number: number; scheduled_for: number; created_at: number; trigger: string; status: string; data: string }
type OccurrenceRow = { run_id: string }

type ParsedCursor = { kind: 'offset'; offset: number } | { kind: 'key'; createdAt: number; id: string }

function parseCursor(cursor: string | undefined): ParsedCursor | null {
  if (cursor === undefined) return null
  if (/^\d+$/.test(cursor)) {
    const offset = Number(cursor)
    if (Number.isSafeInteger(offset)) return { kind: 'offset', offset }
    throw new AutomationStoreError('invalid-params', 'Invalid run cursor')
  }

  const separator = cursor.indexOf(':')
  if (separator <= 0 || separator === cursor.length - 1 || cursor.indexOf(':', separator + 1) !== -1) {
    throw new AutomationStoreError('invalid-params', 'Invalid run cursor')
  }
  const timestamp = cursor.slice(0, separator)
  const id = cursor.slice(separator + 1)
  if (!/^-?\d+$/.test(timestamp)) throw new AutomationStoreError('invalid-params', 'Invalid run cursor')
  const createdAt = Number(timestamp)
  if (!Number.isSafeInteger(createdAt) || id.trim().length === 0) {
    throw new AutomationStoreError('invalid-params', 'Invalid run cursor')
  }
  return { kind: 'key', createdAt, id }
}

export function createAutomationStore(database: PluginStore): AutomationStore {
  database.exec('PRAGMA foreign_keys = ON')

  const transaction = <T>(work: () => T): T => {
    try {
      return database.transaction(work)
    } catch (error) {
      if (error instanceof AutomationStoreError) throw error
      if (error instanceof Error && /constraint|unique/i.test(error.message)) {
        throw new AutomationStoreError('conflict', error.message)
      }
      throw error
    }
  }

  const definitionFromRow = (row: Pick<DefinitionRow, 'data'>): AutomationDefinition => decode<AutomationDefinition>(row.data)
  const runFromRow = (row: Pick<RunRow, 'data'>): AutomationRun => decode<AutomationRun>(row.data)

  const definitionRow = (id: string): DefinitionRow | null =>
    database.get<DefinitionRow>('SELECT id, creation_key, name, next_run_number, pruned_scheduled_through, data FROM automation_definitions WHERE id = ?', id)

  const runRow = (id: string): RunRow | null =>
    database.get<RunRow>(
      'SELECT id, automation_id, run_number, scheduled_for, created_at, trigger, status, data FROM automation_runs WHERE id = ?',
      id
    )

  const runByOccurrence = (automationId: string, scheduledFor: number): AutomationRun | null => {
    const occurrence = database.get<OccurrenceRow>(
      'SELECT run_id FROM automation_occurrences WHERE automation_id = ? AND scheduled_for = ?',
      automationId,
      scheduledFor
    )
    const retained = occurrence ? runRow(occurrence.run_id) : database.get<RunRow>(
      'SELECT * FROM automation_runs WHERE automation_id = ? AND trigger = ? AND scheduled_for = ?',
      automationId, 'scheduled', scheduledFor
    )
    return retained ? runFromRow(retained) : null
  }

  const assertUnprocessedOccurrence = (automationId: string, scheduledFor: number): void => {
    const definition = definitionRow(automationId)
    if (!definition) throw new AutomationStoreError('not-found', `Automation ${automationId} was not found`)
    if (definition.pruned_scheduled_through !== null && scheduledFor <= definition.pruned_scheduled_through) {
      throw new PrunedAutomationOccurrenceError()
    }
  }


  const saveRun = (run: AutomationRun): void => {
    const data = encode(run)
    database.run(
      `UPDATE automation_runs
       SET scheduled_for = ?, created_at = ?, trigger = ?, status = ?, data = ?
       WHERE id = ?`,
      run.scheduledFor,
      run.createdAt,
      run.trigger,
      run.status,
      data,
      run.id
    )
  }

  const touchDefinition = (automationId: string, now: number): void => {
    const row = definitionRow(automationId)
    if (!row) throw new AutomationStoreError('not-found', `Automation ${automationId} was not found`)
    const current = definitionFromRow(row)
    const updated: AutomationDefinition = { ...current, lastRunAt: now, updatedAt: now }
    database.run(
      'UPDATE automation_definitions SET name = ?, data = ? WHERE id = ?',
      updated.name,
      encode(updated),
      automationId
    )
  }

  const pruneWithinTransaction = (): void => {
    const finalStatuses = FINAL_STATUSES.map((status) => `'${status}'`).join(', ')
    database.run(
      `DELETE FROM automation_runs
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY automation_id ORDER BY created_at DESC, scheduled_for DESC, id ASC
           ) AS final_position
           FROM automation_runs
           WHERE status IN (${finalStatuses})
         )
         WHERE final_position > ${MAX_FINAL_RUNS}
       )`
    )
    const pruned = database.all<{ automation_id: string; scheduled_for: number }>(
      `DELETE FROM automation_occurrences
       WHERE run_id NOT IN (SELECT id FROM automation_runs) OR rowid IN (
         SELECT occurrence_rowid FROM (
           SELECT occurrence.rowid AS occurrence_rowid,
             ROW_NUMBER() OVER (PARTITION BY occurrence.automation_id ORDER BY occurrence.scheduled_for DESC) AS position
           FROM automation_occurrences AS occurrence
           JOIN automation_runs AS run ON run.id = occurrence.run_id
           WHERE run.status IN (${finalStatuses})
         ) WHERE position > ${MAX_FINAL_RUNS}
       ) RETURNING automation_id, scheduled_for`
    )
    for (const occurrence of pruned) {
      database.run(
        `UPDATE automation_definitions
         SET pruned_scheduled_through = MAX(COALESCE(pruned_scheduled_through, ?), ?)
         WHERE id = ?`,
        occurrence.scheduled_for, occurrence.scheduled_for, occurrence.automation_id
      )
    }
  }

  const updateRunWithinTransaction = (id: string, patch: AutomationRunPatch, now: number): AutomationRun => {
    const row = runRow(id)
    if (!row) throw new AutomationStoreError('not-found', `Automation run ${id} was not found`)
    if (!definitionRow(row.automation_id)) throw new AutomationStoreError('not-found', `Automation ${row.automation_id} was not found`)

    const current = runFromRow(row)
    const requestedStatus: unknown = patch.status === undefined ? current.status : patch.status
    if (!isRunStatus(requestedStatus)) throw new AutomationStoreError('invalid-params', 'Invalid automation run status')
    if (!canTransition(current.status, requestedStatus)) {
      throw new AutomationStoreError('conflict', `Cannot transition run from ${current.status} to ${requestedStatus}`)
    }

    const merged = { ...current } as AutomationRun & Record<string, unknown>
    for (const key of Object.keys(patch) as (keyof AutomationRunPatch)[]) {
      const value = patch[key]
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value
    }
    merged.status = requestedStatus
    if (requestedStatus === 'dispatching' && current.startedAt === undefined) merged.startedAt = now
    if (requestedStatus === 'dispatched' && current.dispatchedAt === undefined) merged.dispatchedAt = now
    if (isFinalStatus(requestedStatus) && current.completedAt === undefined) merged.completedAt = now

    const updated = capOutputSnapshot(merged)
    saveRun(updated)
    touchDefinition(updated.automationId, now)
    if (isFinalStatus(requestedStatus)) pruneWithinTransaction()
    return updated
  }

  const createRunWithinTransaction = (automationId: string, input: AutomationRunInput): AutomationRun => {
    const definitionRecord = definitionRow(automationId)
    if (!definitionRecord) throw new AutomationStoreError('not-found', `Automation ${automationId} was not found`)

    if (input.trigger === 'scheduled') {
      const existing = runByOccurrence(automationId, input.scheduledFor)
      if (existing) return existing
      assertUnprocessedOccurrence(automationId, input.scheduledFor)
    }
    const status = input.status ?? 'pending'
    if (!isRunStatus(status)) throw new AutomationStoreError('invalid-params', 'Invalid automation run status')
    if (status === 'dispatching' || status === 'dispatched') {
      throw new AutomationStoreError('conflict', `A run cannot be created in ${status} status`)
    }

    const automation = definitionFromRow(definitionRecord)
    const runNumber = definitionRecord.next_run_number
    database.run(
      'UPDATE automation_definitions SET next_run_number = ? WHERE id = ?',
      runNumber + 1,
      automationId
    )

    const run: AutomationRun = {
      id: randomUUID(),
      automationId,
      title: `${automation.name} run ${runNumber}`,
      runNumber,
      scheduledFor: input.scheduledFor,
      trigger: input.trigger,
      status,
      createdAt: input.now,
      ...(isFinalStatus(status) ? { completedAt: input.now } : {}),
      occurrenceCount: 1,
      ...(input.trigger === 'scheduled' ? { lastOccurrenceAt: input.scheduledFor } : {}),
      runContext: automation.runContext,
      sourceContext: automation.sourceContext,
      workspaceId: automation.workspaceMode === 'new_per_run' ? null : automation.workspaceId,
      sessionKind: 'structured',
      sessionId: null,
      launchSettings: null,
      error: input.error === undefined ? null : input.error
    }
    const cappedRun = capOutputSnapshot(run)
    const data = encode(cappedRun)
    database.run(
      `INSERT INTO automation_runs
       (id, automation_id, run_number, scheduled_for, created_at, trigger, status, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      cappedRun.id,
      automationId,
      runNumber,
      cappedRun.scheduledFor,
      cappedRun.createdAt,
      cappedRun.trigger,
      cappedRun.status,
      data
    )
    if (cappedRun.trigger === 'scheduled') {
      database.run(
        `INSERT INTO automation_occurrences (automation_id, scheduled_for, run_id)
         VALUES (?, ?, ?)`,
        automationId,
        cappedRun.scheduledFor,
        cappedRun.id
      )
    }
    touchDefinition(automationId, input.now)
    pruneWithinTransaction()
    return cappedRun
  }

  const store: AutomationStore = {
    list() {
      return database.all<Pick<DefinitionRow, 'data'>>(
        'SELECT data FROM automation_definitions ORDER BY name COLLATE NOCASE ASC, id ASC'
      ).map(definitionFromRow)
    },

    get(id) {
      const row = definitionRow(id)
      return row ? definitionFromRow(row) : null
    },

    findByCreationKey(key) {
      const row = database.get<DefinitionRow>(
        'SELECT id, creation_key, name, next_run_number, pruned_scheduled_through, data FROM automation_definitions WHERE creation_key = ?',
        key
      )
      return row ? definitionFromRow(row) : null
    },

    insert(definition) {
      return transaction(() => {
        if (definition.creationKey !== undefined) {
          const existing = store.findByCreationKey(definition.creationKey)
          if (existing) return existing
        }
        const normalized = normalizeWorkspacePolicy(definition)
        const data = encode(normalized)
        database.run(
          `INSERT INTO automation_definitions (id, creation_key, name, next_run_number, data)
           VALUES (?, ?, ?, 1, ?)`,
          normalized.id,
          normalized.creationKey ?? null,
          normalized.name,
          data
        )
        return decode<AutomationDefinition>(data)
      })
    },

    update(id, patch) {
      return transaction(() => {
        const row = definitionRow(id)
        if (!row) throw new AutomationStoreError('not-found', `Automation ${id} was not found`)
        const current = definitionFromRow(row)
        const updated = { ...current } as AutomationDefinition & Record<string, unknown>
        for (const key of Object.keys(patch) as (keyof AutomationDefinition)[]) {
          const value = patch[key]
          if (key !== 'id' && value !== undefined) (updated as Record<string, unknown>)[key] = value
        }
        updated.id = id
        const normalized = normalizeWorkspacePolicy(updated)
        const data = encode(normalized)
        database.run(
          'UPDATE automation_definitions SET creation_key = ?, name = ?, data = ? WHERE id = ?',
          normalized.creationKey ?? null,
          normalized.name,
          data,
          id
        )
        return decode<AutomationDefinition>(data)
      })
    },

    remove(id) {
      return transaction(() => {
        if (!definitionRow(id)) return false
        database.run('DELETE FROM automation_occurrences WHERE automation_id = ?', id)
        database.run('DELETE FROM automation_runs WHERE automation_id = ?', id)
        database.run('DELETE FROM automation_definitions WHERE id = ?', id)
        return true
      })
    },

    runs(automationId, limit = 100, cursor) {
      const parsedCursor = parseCursor(cursor)
      const pageSize = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 100
      const where: string[] = []
      const parameters: (number | string)[] = []
      if (automationId !== undefined) {
        where.push('automation_id = ?')
        parameters.push(automationId)
      }
      if (parsedCursor?.kind === 'key') {
        where.push('(created_at < ? OR (created_at = ? AND id > ?))')
        parameters.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id)
      }
      const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      let rows: RunRow[]
      if (parsedCursor?.kind === 'offset') {
        rows = database.all<RunRow>(
          `SELECT id, automation_id, run_number, scheduled_for, created_at, trigger, status, data
           FROM automation_runs ${whereClause}
           ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
          ...parameters,
          pageSize + 1,
          parsedCursor.offset
        )
      } else {
        rows = database.all<RunRow>(
          `SELECT id, automation_id, run_number, scheduled_for, created_at, trigger, status, data
           FROM automation_runs ${whereClause}
           ORDER BY created_at DESC, id ASC LIMIT ?`,
          ...parameters,
          pageSize + 1
        )
      }
      const hasMore = rows.length > pageSize
      const pageRuns = rows.slice(0, pageSize).map(runFromRow)
      const last = pageRuns[pageRuns.length - 1]
      return {
        runs: pageRuns,
        nextCursor: hasMore && last ? `${last.createdAt}:${last.id}` : null
      } satisfies AutomationRunsPage
    },

    getRun(id) {
      const row = runRow(id)
      return row ? runFromRow(row) : null
    },

    createRun(automationId, input) {
      return transaction(() => createRunWithinTransaction(automationId, input))
    },

    updateRun(id, patch, now) {
      return transaction(() => updateRunWithinTransaction(id, patch, now))
    },

    claimRun(id, now) {
      return transaction(() => {
        const row = runRow(id)
        if (!row) throw new AutomationStoreError('not-found', `Automation run ${id} was not found`)
        const current = runFromRow(row)
        if (current.status !== 'pending') {
          throw new AutomationStoreError('conflict', `Cannot claim run in ${current.status} status`)
        }
        return updateRunWithinTransaction(id, { status: 'dispatching' }, now)
      })
    },

    foldUnavailable(automationId, scheduledFor, error, now) {
      return transaction(() => {
        if (!definitionRow(automationId)) throw new AutomationStoreError('not-found', `Automation ${automationId} was not found`)
        const duplicate = runByOccurrence(automationId, scheduledFor)
        if (duplicate) return duplicate
        assertUnprocessedOccurrence(automationId, scheduledFor)

        const newest = database.get<RunRow>(
          `SELECT id, automation_id, run_number, scheduled_for, created_at, trigger, status, data
           FROM automation_runs WHERE automation_id = ?
           ORDER BY created_at DESC, id ASC LIMIT 1`,
          automationId
        )
        if (newest) {
          const current = runFromRow(newest)
          if (current.trigger === 'scheduled' && current.status === 'skipped_unavailable' && current.error === error) {
            const folded: AutomationRun = {
              ...current,
              occurrenceCount: current.occurrenceCount + 1,
              lastOccurrenceAt: Math.max(current.lastOccurrenceAt ?? current.scheduledFor, scheduledFor)
            }
            saveRun(folded)
            database.run(
              `INSERT INTO automation_occurrences (automation_id, scheduled_for, run_id)
               VALUES (?, ?, ?)`,
              automationId,
              scheduledFor,
              folded.id
            )
            touchDefinition(automationId, now)
            pruneWithinTransaction()
            return folded
          }
        }
        return createRunWithinTransaction(automationId, {
          trigger: 'scheduled',
          scheduledFor,
          status: 'skipped_unavailable',
          error,
          now
        })
      })
    },

    prune() {
      transaction(pruneWithinTransaction)
    }
  }

  store.prune()
  return store
}
