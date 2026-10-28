import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, PluginStore, QuirkyEvent } from '@quirky/protocol'
import type { ClaudeUsageScanResult } from '../src/usage-scanner'

const scanDeferred = Promise.withResolvers<ClaudeUsageScanResult>()
const scanStartedDeferred = Promise.withResolvers<void>()
const directories: string[] = []
const REMOTE_ENV = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'WSL_DISTRO_NAME', 'WSL_INTEROP', 'QUIRKY_REMOTE_HOST'] as const
const savedRemoteEnv = new Map(REMOTE_ENV.map((name) => [name, process.env[name]]))

// Hold the imported scanner so session removal can be ordered before its completion deterministically.
mock.module('../src/usage-scanner', () => ({
  scanClaudeUsage: async () => {
    scanStartedDeferred.resolve()
    return scanDeferred.promise
  }
}))

// Import after the mock; a static import would evaluate the scanner before the deferred gate exists.
const { SessionInfoService } = await import('../src/service')

afterEach(() => {
  for (const name of REMOTE_ENV) {
    const previous = savedRemoteEnv.get(name)
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

afterAll(() => mock.restore())

test('SC-30: a scan finishing after session removal cannot resurrect its snapshot', async () => {
  for (const name of REMOTE_ENV) delete process.env[name]
  const directory = mkdtempSync(join(tmpdir(), 'quirky-session-info-race-'))
  directories.push(directory)
  const session = {
    id: 'session-race',
    kind: 'terminal',
    agent: 'claude',
    worktreeId: 'wt_race',
    cwd: directory,
    title: 'Race test',
    status: 'working',
    createdAt: 1,
    lastActivityAt: 1,
    providerSession: { id: 'provider-race', transcriptPath: join(directory, 'recorded.jsonl') }
  }
  const sessions = new Map([[session.id, session]])
  const workspace = { workspace: { id: 'wt_race', root: { kind: 'group', id: 'group', tabs: [], activeTab: null }, activeGroup: 'group' } }
  const context = {
    pluginId: 'quirky.session-info',
    dir: directory,
    dataDir: directory,
    home: directory,
    log() {},
    notify() {},
    provide() {},
    emit() { return true },
    subscribe() { return () => {} },
    openStore() { throw new Error('not used') },
    getSetting() { return undefined },
    error(_kind: string, message: string) { return new Error(message) },
    launch: {},
    pty: {},
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.session/get') return sessions.get(String(params.session))
      if (method === 'quirky.agent-status/get') return null
      if (method === 'quirky.terminal/workspace') return workspace
      throw new Error(`unexpected public API call: ${method}`)
    }
  } as unknown as PluginContext
  const store = {
    version: 1,
    run() { return { changes: 1, lastInsertRowid: 1 } },
    get() { return null },
    all() { return [] },
    exec() {},
    transaction<T>(work: () => T) { return work() }
  } as unknown as PluginStore
  const service = new SessionInfoService(context, store)

  service.onEvent({
    type: 'hook.received',
    agent: 'claude',
    sessionId: session.id,
    payload: { hook_event_name: 'Stop', session_id: 'provider-race' }
  } satisfies QuirkyEvent)
  await scanStartedDeferred.promise

  sessions.delete(session.id)
  service.onEvent({ type: 'quirky.session/removed', data: { sessionId: session.id } })
  scanDeferred.resolve({ turnCount: 1, input: 1, output: 1, total: 2 })
  await scanDeferred.promise

  // Inspect the internal cache because a removed public session is no longer queryable.
  const cache = service as unknown as { snapshots: Map<string, unknown> }
  expect(cache.snapshots.size).toBe(0)
  service.shutdown()
})
