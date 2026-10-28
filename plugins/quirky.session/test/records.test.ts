import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import type { AgentStatusSummary, PluginStore, Session } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { SessionRecords, sessionMigrations } from '../src/records'
import { memoryStore, migrateStore } from './memory-store'

const session: Session = {
  id: 's_new',
  kind: 'terminal',
  agent: 'claude',
  worktreeId: 'wt',
  cwd: '/work',
  title: 'Claude',
  status: 'running',
  createdAt: 2,
  lastActivityAt: 2,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false,
  launch: { command: 'claude', args: '--model haiku', env: { A: '1' } },
  providerSession: { id: 'abc', transcriptPath: '/t.jsonl' },
  promptDelivery: 'pending',
  launchSettings: {
    agent: 'claude',
    options: { model: { value: 'haiku', source: 'explicit' }, effort: { source: 'extra-args' } },
    args: { value: '--verbose', source: 'explicit' },
    summary: 'Claude · Haiku'
  },
  resumedFrom: 's_old',
  agentStatus: null,
  name: null,
  unread: null
}

const summary: AgentStatusSummary = {
  state: 'working',
  display: 'working',
  label: 'Working',
  detail: 'Editing',
  progress: 60,
  stateStartedAt: 5,
  evidenceAt: 6,
  restoredUnconfirmed: false
}

describe('session store migration from version 8', () => {
  test('preserves badges and stores pointer operations for an existing private database', () => {
    const home = makeTempHome('quirky-session-migration-')
    let closeStore: (() => void) | undefined
    const badges = { 'acme/review': { label: 'Review' } }
    try {
      const legacyMigrations = sessionMigrations(home).slice(0, 7)
      legacyMigrations.push((store: PluginStore) => {
        store.exec('ALTER TABLE sessions ADD COLUMN badges TEXT')
      })
      const legacy = openPluginStore({
        home,
        pluginId: 'quirky.session',
        migrations: legacyMigrations,
        isActive: () => true
      })
      closeStore = legacy.close
      legacy.store.run(
        `INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id, badges)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        session.id,
        session.kind,
        session.agent,
        session.worktreeId,
        session.cwd,
        session.title,
        session.status,
        session.createdAt,
        session.lastActivityAt,
        session.exitCode,
        'repo',
        JSON.stringify(badges)
      )
      legacy.close()
      closeStore = undefined

      const current = openPluginStore({
        home,
        pluginId: 'quirky.session',
        migrations: sessionMigrations(home),
        isActive: () => true
      })
      closeStore = current.close
      const records = new SessionRecords(current.store)
      expect(records.get(session.id)?.badges).toEqual(badges)
      expect(records.get(session.id)?.background).toBeUndefined()

      const backgroundSession = { ...session, id: 's_background_after_v8', background: true }
      records.insert(backgroundSession, 'repo')
      expect(records.get(backgroundSession.id)?.background).toBe(true)

      const reserved = records.reservePointerOperation(
        {
          operationId: 'pointer-after-v8',
          sessionId: session.id,
          expectedIncarnation: 'incarnation-v1',
          payloadHash: 'payload-v1'
        },
        10
      )
      expect(reserved).toMatchObject({
        operationId: 'pointer-after-v8',
        sessionId: session.id,
        expectedIncarnation: 'incarnation-v1',
        phase: 'reserved',
        result: null
      })

      records.updatePointerOperation(
        'pointer-after-v8',
        'settled',
        { status: 'submitted', transport: 'terminal_enter' },
        11
      )
      expect(records.pointerOperation('pointer-after-v8')).toMatchObject({
        phase: 'settled',
        result: { status: 'submitted', transport: 'terminal_enter' }
      })
    } finally {
      closeStore?.()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('keeps pointer operation records from the alternate version-8 schema', () => {
    const home = makeTempHome('quirky-session-pointer-migration-')
    let closeStore: (() => void) | undefined
    try {
      const legacyMigrations = sessionMigrations(home).slice(0, 7)
      legacyMigrations.push((store: PluginStore) => {
        store.exec(`
          CREATE TABLE session_pointer_operations (
            operation_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            expected_incarnation TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            phase TEXT NOT NULL CHECK (phase IN ('reserved', 'write_attempted', 'enter_attempted', 'settled')),
            result_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX session_pointer_operations_updated_at ON session_pointer_operations(updated_at)
        `)
      })
      const legacy = openPluginStore({
        home,
        pluginId: 'quirky.session',
        migrations: legacyMigrations,
        isActive: () => true
      })
      closeStore = legacy.close
      legacy.store.run(
        `INSERT INTO session_pointer_operations
          (operation_id, session_id, expected_incarnation, payload_hash, phase, result_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        'pointer-before-v8-upgrade',
        session.id,
        'incarnation-v1',
        'payload-v1',
        'reserved',
        null,
        10,
        10
      )
      legacy.close()
      closeStore = undefined

      const current = openPluginStore({
        home,
        pluginId: 'quirky.session',
        migrations: sessionMigrations(home),
        isActive: () => true
      })
      closeStore = current.close
      expect(new SessionRecords(current.store).pointerOperation('pointer-before-v8-upgrade')).toMatchObject({
        operationId: 'pointer-before-v8-upgrade',
        sessionId: session.id,
        phase: 'reserved',
        result: null
      })
    } finally {
      closeStore?.()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('session store migration from version 9', () => {
  test('preserves badges and background while adding pointer operations', () => {
    const home = makeTempHome('quirky-session-background-migration-')
    let closeStore: (() => void) | undefined
    const badges = { 'acme/review': { label: 'Review' } }
    try {
      const legacyMigrations = sessionMigrations(home).slice(0, 8)
      legacyMigrations.push((store: PluginStore) => {
        store.exec('ALTER TABLE sessions ADD COLUMN background INTEGER NOT NULL DEFAULT 0')
      })
      const legacy = openPluginStore({
        home,
        pluginId: 'quirky.session',
        migrations: legacyMigrations,
        isActive: () => true
      })
      closeStore = legacy.close
      const legacyRecords = new SessionRecords(legacy.store)
      legacyRecords.insert({ ...session, background: true }, 'repo')
      legacyRecords.update(session.id, { badges })
      legacy.close()
      closeStore = undefined

      const current = openPluginStore({
        home,
        pluginId: 'quirky.session',
        migrations: sessionMigrations(home),
        isActive: () => true
      })
      closeStore = current.close
      const records = new SessionRecords(current.store)
      expect(records.get(session.id)).toMatchObject({ badges, background: true })

      expect(
        records.reservePointerOperation(
          {
            operationId: 'pointer-after-v9',
            sessionId: session.id,
            expectedIncarnation: 'incarnation-v1',
            payloadHash: 'payload-v1'
          },
          12
        )
      ).toMatchObject({
        operationId: 'pointer-after-v9',
        sessionId: session.id,
        phase: 'reserved',
        result: null
      })
    } finally {
      closeStore?.()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('session store migration 7', () => {
  test('a row written before it reads with a null name', () => {
    const store = memoryStore(6)
    store.run(
      "INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id) VALUES ('s_old', 'terminal', 'claude', 'wt', '/work', 'Claude', 'running', 1, 1, NULL, 'repo')"
    )
    migrateStore(store, 6)
    expect(new SessionRecords(store).get('s_old')?.name).toBeNull()
  })

  test('the name round-trips through insert and update, and null clears it', () => {
    const records = new SessionRecords(memoryStore())
    records.insert({ ...session, name: 'builder' }, 'repo')
    expect(records.get('s_new')?.name).toBe('builder')

    records.update('s_new', { status: 'working' })
    expect(records.get('s_new')?.name).toBe('builder')

    expect(records.update('s_new', { name: 'reviewer' })?.name).toBe('reviewer')
    expect(records.update('s_new', { name: null })?.name).toBeNull()
  })

  test('byName finds every record holding the name, in any status', () => {
    const records = new SessionRecords(memoryStore())
    records.insert({ ...session, id: 's_a', createdAt: 1, status: 'exited', name: 'reviewer' }, 'repo')
    records.insert({ ...session, id: 's_b', createdAt: 2, name: 'reviewer' }, 'repo')
    records.insert({ ...session, id: 's_c', createdAt: 3, name: 'other' }, 'repo')
    expect(records.byName('reviewer').map((s) => s.id)).toEqual(['s_a', 's_b'])
    expect(records.byName('nobody')).toEqual([])
  })
})

describe('session store migration 5', () => {
  test('a row written before it reads with a null agent status', () => {
    const store = memoryStore(4)
    store.run(
      "INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id) VALUES ('s_old', 'terminal', 'claude', 'wt', '/work', 'Claude', 'running', 1, 1, NULL, 'repo')"
    )
    migrateStore(store, 4)
    expect(new SessionRecords(store).get('s_old')?.agentStatus).toBeNull()
  })

  test('the summary round-trips through insert and update, and null clears it', () => {
    const records = new SessionRecords(memoryStore())
    records.insert({ ...session, agentStatus: summary }, 'repo')
    expect(records.get('s_new')?.agentStatus).toEqual(summary)

    records.update('s_new', { status: 'working' })
    expect(records.get('s_new')?.agentStatus).toEqual(summary)

    const next = { ...summary, display: 'monitoring' as const, label: 'Monitoring background tasks' }
    expect(records.update('s_new', { agentStatus: next })?.agentStatus).toEqual(next)
    expect(records.update('s_new', { agentStatus: null })?.agentStatus).toBeNull()
  })

  test('a damaged summary reads as null', () => {
    const store = memoryStore()
    const records = new SessionRecords(store)
    records.insert({ ...session, agentStatus: summary }, 'repo')
    store.run("UPDATE sessions SET agent_status = '{broken' WHERE id = 's_new'")
    expect(records.get('s_new')?.agentStatus).toBeNull()
  })
})

describe('session store migration 4', () => {
  test('a row written before it reads as not restorable, with no signal or cause', () => {
    const store = memoryStore(3)
    store.run(
      "INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id) VALUES ('s_old', 'terminal', 'shell', 'wt', '/work', 'Shell', 'exited', 1, 1, 0, 'repo')"
    )
    migrateStore(store, 3)
    const records = new SessionRecords(store)

    expect(records.get('s_old')).toMatchObject({ exitCode: 0, exitSignal: null, exitCause: null, restorable: false, launch: null })
  })

  test('the exit columns round-trip through update, and agent can change', () => {
    const records = new SessionRecords(memoryStore())
    records.insert(session, 'repo')
    records.update('s_new', { status: 'exited', exitCode: 137, exitSignal: 'SIGKILL', exitCause: 'killed', restorable: true })
    expect(records.get('s_new')).toMatchObject({ exitCode: 137, exitSignal: 'SIGKILL', exitCause: 'killed', restorable: true })
    records.update('s_new', { agent: 'shell', restorable: false })
    expect(records.get('s_new')).toMatchObject({ agent: 'shell', restorable: false, exitCause: 'killed', promptDelivery: 'pending' })
  })
})

describe('session store migration 2', () => {
  test('SC-38: a row written before it reads with null launch fields, and keeps working', () => {
    const store = memoryStore(1)
    store.run(
      "INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id) VALUES ('s_old', 'terminal', 'claude', 'wt', '/work', 'Claude', 'running', 1, 1, NULL, 'repo')"
    )
    migrateStore(store, 1)
    const records = new SessionRecords(store)

    expect(records.get('s_old')).toMatchObject({
      id: 's_old',
      status: 'running',
      worktreeId: 'wt',
      cwd: '/work',
      launch: null,
      providerSession: null,
      promptDelivery: null
    })
    expect(records.update('s_old', { status: 'exited', exitCode: 0 })).toMatchObject({ status: 'exited', launch: null })
    expect(records.repoIdOf('s_old')).toBe('repo')
  })

  test('the new columns round-trip through insert and update', () => {
    const records = new SessionRecords(memoryStore())
    records.insert(session, 'repo')
    expect(records.get('s_new')).toMatchObject({
      launch: session.launch,
      providerSession: session.providerSession,
      promptDelivery: session.promptDelivery
    })

    const updatedProviderSession = { id: 'xyz', transcriptPath: null }
    records.update('s_new', { promptDelivery: 'pasted', providerSession: updatedProviderSession })
    expect(records.get('s_new')).toMatchObject({
      launch: session.launch,
      providerSession: updatedProviderSession,
      promptDelivery: 'pasted'
    })
  })

  test('a session recorded without the new fields stores them as null', () => {
    const records = new SessionRecords(memoryStore())
    const { launch, providerSession, promptDelivery, launchSettings, resumedFrom, agentStatus, name, ...bare } = session
    records.insert(bare, 'repo')
    expect(records.get('s_new')).toMatchObject({
      launch: null,
      providerSession: null,
      promptDelivery: null,
      launchSettings: null,
      resumedFrom: null
    })
  })

  test('a row whose JSON column is damaged reads as null instead of failing the listing', () => {
    const store = memoryStore()
    const records = new SessionRecords(store)
    records.insert(session, 'repo')
    store.run("UPDATE sessions SET launch = '{broken', provider_session = '[' WHERE id = 's_new'")
    const listed = records.list()
    expect(listed.map(({ id }) => id)).toEqual(['s_new'])
    expect(listed[0]).toMatchObject({
      id: 's_new',
      status: 'running',
      launch: null,
      providerSession: null,
      promptDelivery: 'pending'
    })
  })

  test('pending deliveries can be swept to not-delivered', () => {
    const records = new SessionRecords(memoryStore())
    records.insert(session, 'repo')
    records.insert({ ...session, id: 's_done', promptDelivery: 'pasted' }, 'repo')
    expect(records.sweepPendingDeliveries()).toEqual(['s_new'])
    expect(records.get('s_new')?.promptDelivery).toBe('not-delivered')
    expect(records.get('s_done')?.promptDelivery).toBe('pasted')
    expect(records.sweepPendingDeliveries()).toEqual([])
  })
})

describe('session store migration 3', () => {
  test('a row written at migration 2 migrates and reads null launchSettings', () => {
    const store = memoryStore(2)
    store.run(
      "INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id, launch) VALUES ('s_v2', 'terminal', 'claude', 'wt', '/work', 'Claude', 'running', 1, 1, NULL, 'repo', '{\"command\":\"claude\",\"args\":\"\",\"env\":{}}')"
    )
    migrateStore(store, 2)
    const records = new SessionRecords(store)

    expect(records.get('s_v2')).toMatchObject({ launch: { command: 'claude', args: '', env: {} }, launchSettings: null })
    const settings = session.launchSettings!
    expect(records.update('s_v2', { launchSettings: settings })?.launchSettings).toEqual(settings)
  })

  test('launchSettings round-trips through insert and update', () => {
    const records = new SessionRecords(memoryStore())
    records.insert(session, 'repo')
    expect(records.get('s_new')?.launchSettings).toEqual(session.launchSettings)

    const next = { agent: 'claude', options: {}, summary: 'Claude' }
    records.update('s_new', { launchSettings: next })
    expect(records.get('s_new')?.launchSettings).toEqual(next)

    records.update('s_new', { launchSettings: null })
    expect(records.get('s_new')?.launchSettings).toBeNull()
  })

  test('an update that omits launchSettings leaves it alone', () => {
    const records = new SessionRecords(memoryStore())
    records.insert(session, 'repo')
    records.update('s_new', { status: 'exited' })
    expect(records.get('s_new')?.launchSettings).toEqual(session.launchSettings)
  })
})

describe('SessionRecords.update', () => {
  test('writes only the fields it is given', () => {
    const records = new SessionRecords(memoryStore())
    records.insert({ ...session, id: 's_cols', providerSession: { id: 'p1', transcriptPath: null } }, 'repo')

    records.update('s_cols', { status: 'running', providerSession: undefined, launch: undefined })

    expect(records.get('s_cols')).toMatchObject({ status: 'running', providerSession: { id: 'p1', transcriptPath: null } })
  })
})

describe('session store migration 6', () => {
  test('a row written before it reads with no unread reason', () => {
    const store = memoryStore(5)
    store.run(
      "INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id) VALUES ('s_old', 'terminal', 'claude', 'wt', '/work', 'Claude', 'running', 1, 1, NULL, 'repo')"
    )
    migrateStore(store, 5)
    expect(new SessionRecords(store).get('s_old')?.unread ?? null).toBeNull()
  })

  test('the reason round-trips through update, other updates leave it, and null clears it', () => {
    const records = new SessionRecords(memoryStore())
    records.insert(session, 'repo')
    expect(records.get('s_new')?.unread ?? null).toBeNull()
    expect(records.update('s_new', { unread: 'bell' })?.unread).toBe('bell')
    expect(records.update('s_new', { status: 'working' })?.unread).toBe('bell')
    expect(records.update('s_new', { unread: null })?.unread ?? null).toBeNull()
  })
})
