import type { StoreMigration } from '@quirky/protocol'

/** The core's private database. Worker-owned migrations append after this v1 step. */
export const migrations: StoreMigration[] = [
  `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      coordinator_session_id TEXT,
      coordinator_history_json TEXT NOT NULL DEFAULT '[]',
      consumer_generation INTEGER NOT NULL DEFAULT 0 CHECK (consumer_generation >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX runs_created_desc ON runs(created_at DESC, id DESC);
    CREATE INDEX runs_coordinator ON runs(coordinator_session_id) WHERE coordinator_session_id IS NOT NULL;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_task_id TEXT,
      dependency_task_ids_json TEXT NOT NULL DEFAULT '[]',
      created_by_session_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      display_name TEXT NOT NULL,
      spec TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX tasks_run_created ON tasks(run_id, created_at, id);
    CREATE INDEX tasks_run_status_created ON tasks(run_id, status, created_at, id);
    CREATE INDEX tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

    CREATE TABLE dispatches (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version = 1),
      status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
      assignee_session_id TEXT,
      creator_session_id TEXT,
      creator_dispatch_id TEXT,
      retry_of_dispatch_id TEXT,
      depth INTEGER NOT NULL CHECK (depth >= 1),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      last_failure TEXT,
      termination_reason TEXT CHECK (termination_reason IS NULL OR termination_reason IN ('operator_close', 'signaled', 'exited', 'unknown')),
      consumer_generation INTEGER NOT NULL DEFAULT 0 CHECK (consumer_generation >= 0),
      supervised INTEGER NOT NULL DEFAULT 0 CHECK (supervised IN (0, 1)),
      runtime_epoch TEXT,
      process_incarnation TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      completed_at TEXT,
      last_heartbeat_at TEXT,
      CHECK (
        (assignee_session_id IS NULL AND runtime_epoch IS NULL AND process_incarnation IS NULL)
        OR (assignee_session_id IS NOT NULL AND runtime_epoch IS NOT NULL AND process_incarnation IS NOT NULL)
      ),
      CHECK (assignee_session_id IS NOT NULL OR (supervised = 1 AND status != 'dispatched'))
    );
    CREATE UNIQUE INDEX dispatches_one_active_task ON dispatches(task_id) WHERE status IN ('pending', 'dispatched');
    CREATE UNIQUE INDEX dispatches_one_active_assignee ON dispatches(assignee_session_id) WHERE assignee_session_id IS NOT NULL AND status IN ('pending', 'dispatched');
    CREATE INDEX dispatches_run_task_created ON dispatches(run_id, task_id, created_at DESC, id DESC);
    CREATE INDEX dispatches_creator ON dispatches(creator_session_id) WHERE creator_session_id IS NOT NULL;
    CREATE INDEX dispatches_retry_lineage ON dispatches(retry_of_dispatch_id) WHERE retry_of_dispatch_id IS NOT NULL;

    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      from_session_id TEXT NOT NULL,
      sender_kind TEXT NOT NULL CHECK (sender_kind IN ('run', 'dispatch', 'session')),
      sender_id TEXT NOT NULL,
      mailbox_kind TEXT NOT NULL CHECK (mailbox_kind IN ('run', 'dispatch', 'session')),
      mailbox_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('status', 'dispatch', 'worker_done', 'merge_ready', 'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat')),
      priority TEXT NOT NULL CHECK (priority IN ('normal', 'high', 'urgent')),
      thread_id TEXT,
      payload_json TEXT,
      read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX messages_mailbox_fifo ON messages(mailbox_kind, mailbox_id, sequence) WHERE read = 0;
    CREATE INDEX messages_run_history ON messages(run_id, sequence DESC);
    CREATE INDEX messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL;
    CREATE INDEX messages_dispatch_reports ON messages(run_id, type, sequence) WHERE type IN ('worker_done', 'heartbeat');

    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      mailbox_kind TEXT NOT NULL CHECK (mailbox_kind IN ('run', 'dispatch', 'session')),
      mailbox_id TEXT NOT NULL,
      consumer_generation INTEGER NOT NULL CHECK (consumer_generation >= 0),
      message_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('outstanding', 'acknowledged', 'fenced')),
      created_at TEXT NOT NULL,
      acknowledged_at TEXT
    );
    CREATE UNIQUE INDEX deliveries_one_outstanding ON deliveries(mailbox_kind, mailbox_id, consumer_generation) WHERE status = 'outstanding';
    CREATE INDEX deliveries_owner_status ON deliveries(mailbox_kind, mailbox_id, status, created_at DESC);

    CREATE TABLE question_threads (
      message_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      asker_session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'closed')),
      answer_message_id TEXT,
      answer_body TEXT,
      answered_by_generation INTEGER,
      created_at TEXT NOT NULL,
      answered_at TEXT,
      closed_at TEXT
    );
    CREATE INDEX question_threads_dispatch_status ON question_threads(dispatch_id, status, created_at);
    CREATE INDEX question_threads_run_status ON question_threads(run_id, status, created_at);

    CREATE TABLE gates (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'timeout')),
      resolution TEXT,
      created_by_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX gates_run_status_created ON gates(run_id, status, created_at, id);
    CREATE INDEX gates_task_status_created ON gates(task_id, status, created_at, id);

    CREATE TABLE mutation_receipts (
      caller_fingerprint TEXT NOT NULL,
      request_id TEXT NOT NULL,
      method TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
      checkpoint_json TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (caller_fingerprint, request_id)
    );
    CREATE INDEX mutation_receipts_created ON mutation_receipts(created_at);
    CREATE INDEX mutation_receipts_state_created ON mutation_receipts(state, created_at);

    CREATE TABLE pointer_operations (
      mailbox_kind TEXT NOT NULL CHECK (mailbox_kind IN ('run', 'dispatch')),
      mailbox_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expected_incarnation TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      batch_fingerprint TEXT NOT NULL,
      message_ids_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('reserved', 'write_attempted', 'enter_attempted', 'settled')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mailbox_kind, mailbox_id, operation_id)
    );
    CREATE UNIQUE INDEX pointer_operations_one_flight ON pointer_operations(mailbox_kind, mailbox_id) WHERE phase != 'settled';
    CREATE INDEX pointer_operations_phase ON pointer_operations(phase, updated_at);
  `
]

export const policyMigration: StoreMigration = `
  CREATE TABLE orchestration_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    nested_worker_max_depth INTEGER NOT NULL
  );
  INSERT INTO orchestration_policy (id, nested_worker_max_depth) VALUES (1, 1);
`
export function readNestedWorkerMaxDepth(store: PluginStore): number {
  const row = store.get<{ nested_worker_max_depth: unknown }>(
    'SELECT nested_worker_max_depth FROM orchestration_policy WHERE id = 1'
  )
  const value = row?.nested_worker_max_depth
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value
  if (!store.readOnly) {
    if (row) {
      store.run('UPDATE orchestration_policy SET nested_worker_max_depth = 1 WHERE id = 1')
    } else {
      store.run('INSERT OR IGNORE INTO orchestration_policy (id, nested_worker_max_depth) VALUES (1, 1)')
    }
  }
  return 1
}

export function saveNestedWorkerMaxDepth(store: PluginStore, value: number): void {
  store.run(
    `INSERT INTO orchestration_policy (id, nested_worker_max_depth) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET nested_worker_max_depth = excluded.nested_worker_max_depth`,
    value
  )
}
