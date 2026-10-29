import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { openPluginStore, pluginDataDir } from '../../../packages/daemon/src/plugins/stores'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { serviceMigrations } from '../src/services/migrations'
import { migrations } from '../src/store'
import { workerMigrations } from '../src/workers/store'

const PLUGIN_ID = 'quirky.orchestration'
const SERVICE_PLUGIN_ID = 'quirky.heimdall'
const RUN_ID = 'run_heimdall_preserved'
const TASK_ID = 'task_heimdall_preserved'
const SERVICE_OWNER_KEY = 'enrollment:preserved-migration'
const OBJECTIVE = 'Continue the existing Heimdall enrollment'
const TASK_TITLE = 'Resume the pending enrollment'
const DISPLAY_NAME = 'Existing enrollment work'
const TASK_SPEC = 'Continue this enrollment run without creating duplicate work.'
const CREATED_AT = '2026-10-28T00:00:00.000Z'
const PLUGIN_ROOT = resolve(import.meta.dir, '..')
const TESTED_BUILTINS = [
  'quirky.orchestration',
  'quirky.session',
  'quirky.terminal',
  'quirky.agents',
  'quirky.worktree',
  'quirky.repo',
  'quirky.cli',
  'quirky.agent-status',
  'quirky.structured',
  'quirky.ask'
] as const
const ISOLATED_ENV_KEYS = [
  'HOME',
  'QUIRKY_HOME',
  'PATH',
  'ZDOTDIR',
  'ENV',
  'BASH_ENV',
  'QUIRKY_TEST_ENTER_DELAY_MS',
  'QUIRKY_TEST_AGENT_STATUS_TIME_SCALE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GROK_HOME',
  'GROK_CLI_CHAT_PROXY_BASE_URL',
  'KIMI_CODE_HOME',
  'KIMI_CODE_BASE_URL',
  'OPENCODE_API_KEY',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_DB',
  'OPENCODE_CONFIG_DIR'
] as const

type Policy = { nestedWorkerMaxDepth: number; canChange: boolean }

type CanonicalServiceData = {
  run: {
    id: string
    objective: string
    coordinator_session_id: string | null
    service_owner_plugin_id: string | null
    service_owner_key: string | null
    created_at: string
    updated_at: string
  }
  task: {
    id: string
    run_id: string
    created_by_session_id: string | null
    created_by_plugin_id: string | null
    created_by_kind: 'session' | 'service'
    task_title: string
    display_name: string
    spec: string
    status: string
    created_at: string
  }
}

function createBuiltinPluginsDir(root: string): string {
  const builtinPluginsDir = join(root, 'builtins')
  mkdirSync(builtinPluginsDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(builtinPluginsDir, '.test-local-builtins'), '')
  for (const id of TESTED_BUILTINS) {
    symlinkSync(resolve(PLUGIN_ROOT, '..', id), join(builtinPluginsDir, id))
  }
  return builtinPluginsDir
}

function isolateEnvironment(root: string, home: string, userHome: string): () => void {
  const previousEnv: Record<string, string | undefined> = {}
  for (const key of ISOLATED_ENV_KEYS) previousEnv[key] = process.env[key]
  const privateBin = join(root, 'fake-bin')
  mkdirSync(privateBin, { recursive: true, mode: 0o700 })
  process.env.HOME = userHome
  process.env.QUIRKY_HOME = home
  process.env.PATH = `${privateBin}:/usr/bin:/bin`
  process.env.XDG_CONFIG_HOME = join(root, 'xdg-config')
  process.env.XDG_DATA_HOME = join(root, 'xdg-data')
  process.env.XDG_CACHE_HOME = join(root, 'xdg-cache')
  const retained: Record<string, true> = {
    HOME: true,
    QUIRKY_HOME: true,
    PATH: true,
    XDG_CONFIG_HOME: true,
    XDG_DATA_HOME: true,
    XDG_CACHE_HOME: true
  }
  for (const key of ISOLATED_ENV_KEYS) {
    if (!(key in retained)) delete process.env[key]
  }
  return () => {
    for (const key of ISOLATED_ENV_KEYS) {
      const value = previousEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}


function seedPriorCanonicalStore(home: string): void {
  const opened = openPluginStore({
    home,
    pluginId: PLUGIN_ID,
    migrations: [...migrations, ...workerMigrations, ...serviceMigrations],
    isActive: () => true
  })
  try {
    opened.store.run(
      `INSERT INTO runs (
        id, objective, service_owner_plugin_id, service_owner_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      RUN_ID,
      OBJECTIVE,
      SERVICE_PLUGIN_ID,
      SERVICE_OWNER_KEY,
      CREATED_AT,
      CREATED_AT
    )
    opened.store.run(
      `INSERT INTO tasks (
        id, run_id, created_by_session_id, created_by_plugin_id, created_by_kind,
        task_title, display_name, spec, status, created_at
      ) VALUES (?, ?, NULL, ?, 'service', ?, ?, ?, 'ready', ?)`,
      TASK_ID,
      RUN_ID,
      SERVICE_PLUGIN_ID,
      TASK_TITLE,
      DISPLAY_NAME,
      TASK_SPEC,
      CREATED_AT
    )
  } finally {
    opened.close()
  }
}


function readPolicyDepth(storePath: string): number {
  const database = new Database(storePath)
  try {
    const row = database.query('SELECT nested_worker_max_depth FROM orchestration_policy WHERE id = 1').get()
    if (row === null || row === undefined || typeof row !== 'object' ||
      !('nested_worker_max_depth' in row) || typeof row.nested_worker_max_depth !== 'number') {
      throw new Error('orchestration policy row is missing or malformed')
    }
    return row.nested_worker_max_depth
  } finally {
    database.close()
  }
}

function readCanonicalServiceData(storePath: string): CanonicalServiceData {
  const database = new Database(storePath)
  try {
    // These assertions describe the exact selected SQLite columns in this test fixture.
    const run = database.query(`
      SELECT id, objective, coordinator_session_id, service_owner_plugin_id, service_owner_key, created_at, updated_at
      FROM runs WHERE id = ?
    `).get(RUN_ID) as CanonicalServiceData['run'] | null
    const task = database.query(`
      SELECT id, run_id, created_by_session_id, created_by_plugin_id, created_by_kind,
        task_title, display_name, spec, status, created_at
      FROM tasks WHERE id = ?
    `).get(TASK_ID) as CanonicalServiceData['task'] | null
    if (run === null || run === undefined || task === null || task === undefined) {
      throw new Error('seeded Heimdall service data is missing')
    }
    return { run, task }
  } finally {
    database.close()
  }
}


function corruptPersistedPolicyDepth(storePath: string): void {
  const database = new Database(storePath)
  try {
    const result = database.query('UPDATE orchestration_policy SET nested_worker_max_depth = ? WHERE id = 1').run(0)
    expect(result.changes).toBe(1)
  } finally {
    database.close()
  }
}


async function expectPublicServiceData(client: QuirkyClient): Promise<void> {
  expect(await client.callAny('quirky.orchestration/runShow', { runId: RUN_ID })).toEqual({
    run: {
      id: RUN_ID,
      objective: OBJECTIVE,
      coordinatorSessionId: null,
      coordinatorHistory: [],
      consumerGeneration: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    }
  })
  expect(await client.callAny('quirky.orchestration/taskList', { runId: RUN_ID })).toEqual({
    runId: RUN_ID,
    tasks: [{
      id: TASK_ID,
      runId: RUN_ID,
      parentTaskId: null,
      dependencyTaskIds: [],
      createdBySessionId: null,
      taskTitle: TASK_TITLE,
      displayName: DISPLAY_NAME,
      spec: TASK_SPEC,
      status: 'ready',
      result: null,
      createdAt: CREATED_AT,
      completedAt: null
    }],
    count: 1
  })
}

async function expectPolicy(client: QuirkyClient, expectedDepth: number): Promise<void> {
  const policy = await client.callAny('quirky.orchestration/policyShow', {}) as Policy
  expect(policy).toEqual({ nestedWorkerMaxDepth: expectedDepth, canChange: true })
}

async function stopPreservingHome(harness: Harness): Promise<void> {
  await Promise.all(harness.clients.map((client) => client.close()))
  harness.clients.length = 0
  await harness.daemon.stop()
  harness.pty.stop()
}

test('daemon activation upgrades the prior canonical service store once and preserves its data and policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-setup-migration-'))
  const home = join(root, 'quirky-home')
  const userHome = join(root, 'user-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(userHome, { recursive: true, mode: 0o700 })
  const restoreEnvironment = isolateEnvironment(root, home, userHome)

  const storePath = join(pluginDataDir(home, PLUGIN_ID), 'store.db')

  let activeHarness: Harness | undefined

  try {
    const builtinPluginsDir = createBuiltinPluginsDir(root)

    seedPriorCanonicalStore(home)
    const seededServiceData = readCanonicalServiceData(storePath)

    activeHarness = await startHarness({ home, builtinPluginsDir })
    const firstClient = await activeHarness.connect('cli', 'orchestration-migration-first-open')
    await expectPolicy(firstClient, 1)
    await expectPublicServiceData(firstClient)
    expect(await firstClient.callAny('quirky.orchestration/policySet', { nestedWorkerMaxDepth: 2 })).toEqual({
      nestedWorkerMaxDepth: 2,
      canChange: true
    })
    await expectPublicServiceData(firstClient)
    await stopPreservingHome(activeHarness)
    activeHarness = undefined

    expect(readPolicyDepth(storePath)).toBe(2)

    activeHarness = await startHarness({ home, builtinPluginsDir })
    const secondClient = await activeHarness.connect('cli', 'orchestration-migration-reopen')
    await expectPolicy(secondClient, 2)
    await expectPublicServiceData(secondClient)
    await stopPreservingHome(activeHarness)
    activeHarness = undefined

    expect(readCanonicalServiceData(storePath)).toEqual(seededServiceData)

    corruptPersistedPolicyDepth(storePath)
    activeHarness = await startHarness({ home, builtinPluginsDir })
    const thirdClient = await activeHarness.connect('cli', 'orchestration-migration-corruption')
    await expectPolicy(thirdClient, 1)
    await expectPublicServiceData(thirdClient)
    await stopPreservingHome(activeHarness)
    activeHarness = undefined

    expect(readPolicyDepth(storePath)).toBe(1)
    expect(readCanonicalServiceData(storePath)).toEqual(seededServiceData)
  } finally {
    try {
      if (activeHarness !== undefined) await activeHarness.cleanup()
    } finally {
      restoreEnvironment()
      rmSync(root, { recursive: true, force: true })
    }
  }
})
