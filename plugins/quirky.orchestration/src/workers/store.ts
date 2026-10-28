import type { PluginStore, StoreMigration } from '@quirky/protocol'
import type { DispatchId } from '../contracts'
import type { TerminalResource, WorkerArchive, WorkerRecord, WorkerRepository } from '../worker-contracts'

export const workerMigrations: StoreMigration[] = [
  `CREATE TABLE worker_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('starting', 'ready', 'start_unknown', 'failed', 'succeeded', 'stopping', 'stop_unknown', 'stopped', 'abandoned')),
    runtime_epoch TEXT NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE INDEX worker_dispatches_state ON worker_dispatches(state, dispatch_id);

  CREATE TABLE worker_terminal_resources (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    owner_dispatch_id TEXT NOT NULL,
    resource_json TEXT NOT NULL
  );
  CREATE INDEX worker_terminal_resources_owner ON worker_terminal_resources(owner_dispatch_id);

  CREATE TABLE worker_terminal_archives (
    dispatch_id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL,
    archive_json TEXT NOT NULL
  );

  CREATE TABLE worker_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_id TEXT NOT NULL,
    facet TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX worker_observations_dispatch_facet ON worker_observations(dispatch_id, facet, id);`
]

type WorkerDbRow = { dispatch_id: string; state: WorkerRecord['state']; runtime_epoch: string; record_json: string }
type ResourceDbRow = { id: string; session_id: string; owner_dispatch_id: string; resource_json: string }
type ArchiveDbRow = { dispatch_id: string; resource_id: string; archive_json: string }

const parse = <T>(value: string): T => JSON.parse(value) as T
const serialized = (value: unknown): string => {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('Worker repository values must be JSON serializable')
  return json
}
const now = (): string => new Date().toISOString()

export function createWorkerStore(store: PluginStore): WorkerRepository {
  const readWorker = (dispatchId: DispatchId): WorkerRecord | null => {
    const row = store.get<WorkerDbRow>(
      'SELECT dispatch_id, state, runtime_epoch, record_json FROM worker_dispatches WHERE dispatch_id = ?', dispatchId
    )
    return row ? parse<WorkerRecord>(row.record_json) : null
  }


  const repository: WorkerRepository = {
    store,

    get(dispatchId) {
      return readWorker(dispatchId)
    },

    insert(record) {
      store.run(
        'INSERT INTO worker_dispatches(dispatch_id, state, runtime_epoch, record_json) VALUES (?, ?, ?, ?)',
        record.dispatchId, record.state, record.runtimeEpoch, serialized(record)
      )
    },

    update(dispatchId, patch, expectedState) {
      return store.transaction(() => {
        const current = readWorker(dispatchId)
        if (!current) throw new Error(`Unknown worker dispatch ${dispatchId}`)
        if (expectedState !== undefined && current.state !== expectedState) {
          throw new Error(`Worker ${dispatchId} state changed: expected ${expectedState}, found ${current.state}`)
        }
        const next = { ...current, ...patch, dispatchId } as WorkerRecord
        const result = expectedState === undefined
          ? store.run(
              'UPDATE worker_dispatches SET state = ?, runtime_epoch = ?, record_json = ? WHERE dispatch_id = ?',
              next.state, next.runtimeEpoch, serialized(next), dispatchId
            )
          : store.run(
              'UPDATE worker_dispatches SET state = ?, runtime_epoch = ?, record_json = ? WHERE dispatch_id = ? AND state = ?',
              next.state, next.runtimeEpoch, serialized(next), dispatchId, expectedState
            )
        if (result.changes !== 1) throw new Error(`Worker ${dispatchId} state compare-and-set failed`)
        return next
      })
    },

    list() {
      return store
        .all<WorkerDbRow>('SELECT dispatch_id, state, runtime_epoch, record_json FROM worker_dispatches ORDER BY dispatch_id')
        .map((row) => parse<WorkerRecord>(row.record_json))
    },

    resource(dispatchId) {
      const owned = store.get<ResourceDbRow>(
        'SELECT id, session_id, owner_dispatch_id, resource_json FROM worker_terminal_resources WHERE owner_dispatch_id = ?',
        dispatchId
      )
      if (owned) return parse<TerminalResource>(owned.resource_json)
      const prior = store.get<ResourceDbRow>(
        `SELECT id, session_id, owner_dispatch_id, resource_json
         FROM worker_terminal_resources
         WHERE owner_dispatch_id <> ? AND (
           json_extract(resource_json, '$.originDispatchId') = ? OR
           EXISTS (
             SELECT 1 FROM json_each(resource_json, '$.priorOwnerDispatchIds') AS lineage
             WHERE lineage.value = ?
           )
         )
         ORDER BY id
         LIMIT 1`,
        dispatchId, dispatchId, dispatchId
      )
      if (!prior) return null
      return { ...parse<TerminalResource>(prior.resource_json), ownershipState: 'transferred' }
    },

    resourceBySession(sessionId) {
      const row = store.get<ResourceDbRow>(
        'SELECT id, session_id, owner_dispatch_id, resource_json FROM worker_terminal_resources WHERE session_id = ?', sessionId
      )
      return row ? parse<TerminalResource>(row.resource_json) : null
    },

    putResource(resource) {
      store.run(
        `INSERT INTO worker_terminal_resources(id, session_id, owner_dispatch_id, resource_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           owner_dispatch_id = excluded.owner_dispatch_id,
           resource_json = excluded.resource_json`,
        resource.id, resource.sessionId, resource.ownerDispatchId, serialized(resource)
      )
    },

    archive(dispatchId) {
      const row = store.get<ArchiveDbRow>(
        'SELECT dispatch_id, resource_id, archive_json FROM worker_terminal_archives WHERE dispatch_id = ?', dispatchId
      )
      return row ? parse<WorkerArchive>(row.archive_json) : null
    },

    putArchive(archive) {
      store.transaction(() => {
        const current = repository.archive(archive.dispatchId)
        if (current) {
          const identical = current.resourceId === archive.resourceId && current.kind === archive.kind &&
            current.content === archive.content && current.sourceIdentity === archive.sourceIdentity &&
            current.status === archive.status && current.createdAt === archive.createdAt
          if (!identical) throw new Error(`Worker archive ${archive.dispatchId} is immutable`)
          return
        }
        store.run(
          'INSERT INTO worker_terminal_archives(dispatch_id, resource_id, archive_json) VALUES (?, ?, ?)',
          archive.dispatchId, archive.resourceId, serialized(archive)
        )
      })
    },

    deleteArchive(dispatchId) {
      store.run('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?', dispatchId)
    },

    addObservation(dispatchId, facet, payload) {
      store.run(
        'INSERT INTO worker_observations(dispatch_id, facet, payload_json, created_at) VALUES (?, ?, ?, ?)',
        dispatchId, facet, serialized(payload), now()
      )
    },

  }

  return repository
}
