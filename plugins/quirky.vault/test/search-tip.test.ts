import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, QuirkyEvent } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import type { HostOutcome, SearchResponse, SearchStatus, SearchTipState } from '../src/types'
import { createVaultHostForwarder, removeVaultHostForwarder } from './support/host-forwarder'
import { VaultRig } from './support/harness'

type PublicStatus = { status: SearchStatus; hosts: HostOutcome[] }
type JsonRecord = Record<string, unknown>

const rigs: VaultRig[] = []
const pluginRoots: string[] = []

afterEach(async () => {
  for (const root of pluginRoots.splice(0).reverse()) removeVaultHostForwarder(root)
  for (const rig of rigs.splice(0).reverse()) await rig.cleanup()
})

async function start(): Promise<VaultRig> {
  const rig = await VaultRig.start()
  rigs.push(rig)
  return rig
}

function recordOf(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null
}

function waitForEvent(client: QuirkyClient, predicate: (event: QuirkyEvent) => boolean): Promise<QuirkyEvent> {
  const { promise, resolve } = Promise.withResolvers<QuirkyEvent>()
  let unsubscribe = () => {}
  unsubscribe = client.onEvent((event) => {
    if (!predicate(event)) return
    unsubscribe()
    resolve(event)
  })
  return promise
}

function searchTipEvent(event: QuirkyEvent): boolean {
  return event.type === 'quirky.vault/searchTipChanged'
}

function searchResults(response: SearchResponse) {
  if (response.kind !== 'results') throw new Error(`expected search results, got ${response.kind}`)
  return response
}

const getTip = (vault: VaultRig) => vault.call<SearchTipState>('getSearchTip')

const transcriptQuery = {
  query: 'vault-fixture-claude-marker',
  freshness: 'wait-until-current',
  filters: { agents: ['claude'] }
}

test('search tip API and CLI report unseen without opening the search database', async () => {
  const vault = await start()

  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })
  const json = await runCli(['vault', 'search-tip', '--json'], { home: vault.home })
  expect(json.code).toBe(0)
  expect(json.stderr).toBe('')
  expect(JSON.parse(json.stdout)).toEqual({ id: 'agent-session-search', seen: false })

  const text = await runCli(['vault', 'search-tip'], { home: vault.home })
  expect(text.code).toBe(0)
  expect(text.stderr).toBe('')
  expect(text.stdout).toContain('agent-session-search')
  expect(text.stdout).toContain('false')
  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(false)
  expect(vault.searchDatabaseExists()).toBe(false)

  expect(await vault.call<SearchResponse>('search', transcriptQuery)).toMatchObject({ kind: 'unavailable', reason: 'disabled' })
  expect(vault.searchDatabaseExists()).toBe(false)
})

test('malformed persisted search-tip JSON remains unseen without starting local search', async () => {
  const vault = await start()
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })

  const store = new Database(join(vault.home, 'plugin-data', 'quirky.vault', 'store.db'))
  try {
    store.prepare('INSERT INTO vault_state (name, value) VALUES (?, ?)').run('searchTip:agent-session-search', 'not-json')
  } finally {
    store.close()
  }

  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })
  expect(vault.searchDatabaseExists()).toBe(false)
})

test('successful local opt-in commits one seen transition, unlocks transcript search, and survives restart', async () => {
  const vault = await start()
  const changed = waitForEvent(vault.client, searchTipEvent)

  await vault.call('setSearchEnabled', { enabled: true })

  const event = await changed
  expect(event.type).toBe('quirky.vault/searchTipChanged')
  expect('data' in event ? event.data : undefined).toEqual({ id: 'agent-session-search', seen: true })
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: true })
  expect(vault.searchDatabaseExists()).toBe(true)

  const hits = searchResults(await vault.call<SearchResponse>('search', transcriptQuery))
  expect(hits.hits.some((hit) => hit.sessionId === vault.expected.claude?.sessionId)).toBe(true)

  await vault.restart()
  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(true)
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: true })
})

test('repeated enable, disable, and clear retain seen while explicit re-enable remains available', async () => {
  const vault = await start()
  await vault.call('setSearchEnabled', { enabled: true })
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: true })

  const laterTipEvents: QuirkyEvent[] = []
  const unsubscribe = vault.client.onEvent((event) => {
    if (searchTipEvent(event)) laterTipEvents.push(event)
  })
  await vault.call('setSearchEnabled', { enabled: true })
  await vault.call('setSearchEnabled', { enabled: false })
  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(false)
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: true })

  const clear = await vault.call<{ cleared: boolean; status: SearchStatus }>('clearSearchIndex', { yes: true })
  expect(clear.cleared).toBe(true)
  expect(clear.status.enabled).toBe(false)
  expect(vault.searchDatabaseExists()).toBe(false)
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: true })

  await vault.call('setSearchEnabled', { enabled: true })
  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(true)
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: true })
  unsubscribe()
  expect(laterTipEvents).toHaveLength(0)
})

test('invalid enable parameters leave local search off and the tip unseen', async () => {
  const vault = await start()
  await expect(vault.call('setSearchEnabled', { enabled: true, historyDays: 0 })).rejects.toThrow()

  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(false)
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })
  expect(await vault.call<SearchResponse>('search', transcriptQuery)).toMatchObject({ kind: 'unavailable', reason: 'disabled' })
  expect(vault.searchDatabaseExists()).toBe(false)
})

test('real worker policy failure leaves search off and unseen, then permits a genuine successful enable', async () => {
  const vault = await start()
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })
  const databasePath = join(vault.home, 'plugin-data', 'quirky.vault', 'session-search.sqlite')
  expect(vault.searchDatabaseExists()).toBe(false)
  mkdirSync(databasePath, { recursive: true })

  const failure = await vault.call('setSearchEnabled', { enabled: true }).then(
    () => null,
    (error: unknown) => error
  )
  expect(failure).not.toBeNull()

  // The serialized getter drains policy notifications captured during the failed enable.
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })
  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(false)
  expect(await vault.call<SearchResponse>('search', transcriptQuery)).toMatchObject({ kind: 'unavailable', reason: 'disabled' })

  rmSync(databasePath, { recursive: true, force: true })
  expect(vault.searchDatabaseExists()).toBe(false)
  await vault.call('setSearchEnabled', { enabled: true })
  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(true)
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: true })
  expect(searchResults(await vault.call<SearchResponse>('search', transcriptQuery)).hits.some((hit) => hit.sessionId === vault.expected.claude?.sessionId)).toBe(true)
})

test('tip-store write failure rejects opt-in and rolls an already enabled local policy back off', async () => {
  const vault = await start()
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })
  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(false)
  const indexed = waitForEvent(vault.client, (event) => {
    if (event.type !== 'quirky.vault/searchStatus') return false
    const status = recordOf(event.data)
    return status?.enabled === true && status.phase !== 'closed'
  })
  await vault.client.callAny('setting.set', { id: 'setting:quirky.vault/search-enabled', value: true })
  await indexed
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })

  const store = new Database(join(vault.home, 'plugin-data', 'quirky.vault', 'store.db'))
  try {
    store.exec(`
      CREATE TRIGGER fail_vault_state_insert BEFORE INSERT ON vault_state
      BEGIN SELECT RAISE(ABORT, 'forced whole-store vault_state persistence failure'); END;
      CREATE TRIGGER fail_vault_state_update BEFORE UPDATE ON vault_state
      BEGIN SELECT RAISE(ABORT, 'forced whole-store vault_state persistence failure'); END;
    `)
  } finally {
    store.close()
  }

  const failure = await vault.call('setSearchEnabled', { enabled: true }).then(
    () => null,
    (error: unknown) => error
  )
  expect(failure).not.toBeNull()
  expect(failure instanceof Error ? failure.message : JSON.stringify(failure)).toContain('forced whole-store vault_state persistence failure')

  // Read through the serialized owner before checking that the failed opt-in left policy off.
  expect(await getTip(vault)).toEqual({ id: 'agent-session-search', seen: false })
  expect((await vault.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(false)
  expect(await vault.call<SearchResponse>('search', transcriptQuery)).toMatchObject({ kind: 'unavailable', reason: 'disabled' })
})

test('remote-only enable does not consume local tip, while all-host enable includes local consent', async () => {
  const remote = await start()
  await remote.call('setSearchEnabled', { enabled: true })

  const local = await start()
  const forwarder = createVaultHostForwarder(rpcUrl(remote.h.runtime))
  pluginRoots.push(forwarder.root)
  await local.client.callAny('plugin.install', { path: forwarder.directory, yes: true })
  const contributions = await local.client.callAny('plugin.contributions', { kind: 'vault-host' }) as {
    id: string
    plugin: string
  }[]
  const contribution = contributions.find((item) => item.plugin === 'test.vault-forwarder')
  if (!contribution) throw new Error('installed public host contribution was not effective')

  await local.call('setSearchEnabled', { enabled: true, host: contribution.id })
  expect(await getTip(local)).toEqual({ id: 'agent-session-search', seen: false })
  expect((await local.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(false)
  expect(local.searchDatabaseExists()).toBe(false)

  await local.call('setSearchEnabled', { enabled: true, host: 'all' })
  expect((await local.call<PublicStatus>('searchStatus', { host: 'local' })).status.enabled).toBe(true)
  expect(await getTip(local)).toEqual({ id: 'agent-session-search', seen: true })
})
