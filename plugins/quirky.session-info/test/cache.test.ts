import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, PluginStore } from '@quirky/protocol'
import { SessionInfoService } from '../src/service'

const REMOTE_ENV = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'WSL_DISTRO_NAME', 'WSL_INTEROP', 'QUIRKY_REMOTE_HOST'] as const
const savedRemoteEnv = new Map(REMOTE_ENV.map((name) => [name, process.env[name]]))
const tempDirectories: string[] = []

afterEach(() => {
  for (const name of REMOTE_ENV) {
    const previous = savedRemoteEnv.get(name)
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('SC-30: the oldest of more than 256 session snapshots is evicted without crossing providers', async () => {
  for (const name of REMOTE_ENV) delete process.env[name]
  const directory = mkdtempSync(join(tmpdir(), 'quirky-session-info-cache-'))
  tempDirectories.push(directory)
  const sessions = new Map<string, {
    id: string
    kind: 'terminal'
    agent: string
    worktreeId: string
    cwd: string
    title: string
    status: string
    createdAt: number
    lastActivityAt: number
    providerSession: { id: string; transcriptPath: null }
  }>()
  const emptyWorkspace = { id: 'wt_test', root: { kind: 'group' as const, id: 'group', tabs: [], activeTab: null }, activeGroup: 'group' }
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
      if (method === 'quirky.terminal/workspace') return { workspace: emptyWorkspace }
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

  for (let index = 0; index <= 256; index += 1) {
    const id = `session-${index}`
    const providerId = `provider-${index}`
    sessions.set(id, {
      id,
      kind: 'terminal',
      agent: 'claude',
      worktreeId: 'wt_test',
      cwd: directory,
      title: id,
      status: 'running',
      createdAt: index,
      lastActivityAt: index,
      providerSession: { id: providerId, transcriptPath: null }
    })
    const result = await service.telemetry({
      session: id,
      payload: { session_id: providerId, context_window: { used_percentage: index % 100 } }
    })
    expect(result.accepted).toBe(true)
  }

  const evicted = await service.get({ session: 'session-0' })
  expect(evicted.info?.context).toEqual({ status: 'waiting' })
  const newest = await service.get({ session: 'session-256' })
  expect(newest.info?.context).toMatchObject({ status: 'ready', usedPercentage: 56 })

  const replacement = sessions.get('session-256')!
  replacement.providerSession = { id: 'provider-replacement', transcriptPath: null }
  expect((await service.telemetry({ session: replacement.id, payload: { session_id: 'provider-256', context_window: { used_percentage: 90 } } })).accepted).toBe(false)
  expect((await service.telemetry({ session: replacement.id, payload: { session_id: 'provider-replacement', context_window: { used_percentage: 10 } } })).accepted).toBe(true)
  expect((await service.get({ session: replacement.id })).info?.context).toMatchObject({ status: 'ready', usedPercentage: 10 })
  service.shutdown()
})
