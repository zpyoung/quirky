import type { StoreMigration } from '@quirky/protocol'

/** Appended after the core and worker migrations in the same PluginStore. */
export const serviceMigrations: StoreMigration[] = [
  `ALTER TABLE runs ADD COLUMN service_owner_plugin_id TEXT;
  ALTER TABLE runs ADD COLUMN service_owner_key TEXT;
  CREATE UNIQUE INDEX runs_service_owner_key
    ON runs(service_owner_plugin_id, service_owner_key)
    WHERE service_owner_plugin_id IS NOT NULL AND service_owner_key IS NOT NULL;

  ALTER TABLE tasks RENAME TO tasks_before_service_provenance;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    parent_task_id TEXT,
    dependency_task_ids_json TEXT NOT NULL DEFAULT '[]',
    created_by_session_id TEXT,
    created_by_plugin_id TEXT,
    created_by_kind TEXT NOT NULL DEFAULT 'session' CHECK (created_by_kind IN ('session', 'service')),
    task_title TEXT NOT NULL,
    display_name TEXT NOT NULL,
    spec TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked')),
    result_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (
      (created_by_kind = 'session' AND created_by_session_id IS NOT NULL AND created_by_plugin_id IS NULL)
      OR (created_by_kind = 'service' AND created_by_session_id IS NULL AND created_by_plugin_id IS NOT NULL)
    )
  );
  INSERT INTO tasks (
    id, run_id, parent_task_id, dependency_task_ids_json, created_by_session_id, created_by_plugin_id,
    created_by_kind, task_title, display_name, spec, status, result_json, created_at, completed_at
  )
  SELECT id, run_id, parent_task_id, dependency_task_ids_json, created_by_session_id, NULL,
    'session', task_title, display_name, spec, status, result_json, created_at, completed_at
  FROM tasks_before_service_provenance;
  DROP TABLE tasks_before_service_provenance;
  CREATE INDEX tasks_run_created ON tasks(run_id, created_at, id);
  CREATE INDEX tasks_run_status_created ON tasks(run_id, status, created_at, id);
  CREATE INDEX tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
  CREATE INDEX tasks_creator_plugin ON tasks(created_by_plugin_id) WHERE created_by_plugin_id IS NOT NULL;

  ALTER TABLE dispatches ADD COLUMN creator_plugin_id TEXT;
  ALTER TABLE dispatches ADD COLUMN creator_kind TEXT NOT NULL DEFAULT 'session' CHECK (creator_kind IN ('session', 'service'));
  CREATE INDEX dispatches_creator_plugin ON dispatches(creator_plugin_id) WHERE creator_plugin_id IS NOT NULL;

  CREATE TEMP TABLE service_message_sequence AS
    SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='messages'),0) AS seq;
  ALTER TABLE messages RENAME TO messages_before_service_provenance;
  CREATE TABLE messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    from_session_id TEXT,
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
  INSERT INTO messages (
    sequence, id, run_id, from_session_id, sender_kind, sender_id, mailbox_kind, mailbox_id,
    subject, body, type, priority, thread_id, payload_json, read, created_at, delivered_at
  )
  SELECT sequence, id, run_id, from_session_id, sender_kind, sender_id, mailbox_kind, mailbox_id,
    subject, body, type, priority, thread_id, payload_json, read, created_at, delivered_at
  FROM messages_before_service_provenance;
  DROP TABLE messages_before_service_provenance;
  INSERT INTO sqlite_sequence(name,seq)
    SELECT 'messages',seq FROM service_message_sequence
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='messages');
  UPDATE sqlite_sequence SET seq=MAX(seq,(SELECT seq FROM service_message_sequence)) WHERE name='messages';
  DROP TABLE service_message_sequence;
  CREATE INDEX messages_mailbox_fifo ON messages(mailbox_kind, mailbox_id, sequence) WHERE read = 0;
  CREATE INDEX messages_run_history ON messages(run_id, sequence DESC);
  CREATE INDEX messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL;
  CREATE INDEX messages_dispatch_reports ON messages(run_id, type, sequence) WHERE type IN ('worker_done', 'heartbeat');`,
  `CREATE TABLE service_submission_preflights (
     run_id TEXT PRIMARY KEY NOT NULL,
     owner_plugin_id TEXT NOT NULL,
     method TEXT NOT NULL,
     created_at TEXT NOT NULL
   );

   CREATE TABLE orchestration_peers (
     peer_id TEXT PRIMARY KEY NOT NULL,
     label TEXT NOT NULL,
     endpoint TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     pairing_revision INTEGER NOT NULL CHECK (pairing_revision > 0),
     auth_token TEXT NOT NULL UNIQUE,
     last_incarnation TEXT,
     last_capabilities_json TEXT NOT NULL DEFAULT '[]'
   );

   CREATE TABLE orchestration_peer_listener (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     host TEXT NOT NULL,
     port INTEGER NOT NULL CHECK (port >= 0 AND port <= 65535),
     auth_token TEXT NOT NULL,
     certificate_file TEXT,
     private_key_file TEXT,
     fingerprint TEXT NOT NULL,
     identity_secret TEXT NOT NULL,
     active INTEGER NOT NULL CHECK (active IN (0, 1))
   );

  `
]
