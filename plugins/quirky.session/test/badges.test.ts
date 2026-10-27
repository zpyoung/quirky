import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent, type Session } from '@quirky/protocol'
import { makeTempHome, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { SessionRecords } from '../src/records'
import { resetFakeAgents } from './fakes/quirky.agents/main'
import { memoryStore, migrateStore } from './memory-store'
import { call, code, createSession, restartDaemon, SESSION_PLUGINS, startPluginHarness } from './support'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  resetFakeAgents()
  h = await startPluginHarness(SESSION_PLUGINS)
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(async () => {
  await h.cleanup()
  removeTempDirs()
})

const changes = () => events.filter((e) => e.type === 'quirky.session/changed')
const setBadge = (session: string, key: string, badge: unknown) => call<{ session: Session }>(client, 'quirky.session/setBadge', { session, key, badge }).then((result) => result.session)

describe('quirky.session/setBadge', () => {
  test('stores the badge under the caller-qualified key, returns the session and emits changed', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    expect(session.badges ?? {}).toEqual({})
    await waitFor(() => changes().length > 0 || undefined)
    const before = changes().length

    const badge = { label: 'from Claude', tooltip: 'Jump back', command: 'command:acme.go', args: { session: 's_x' } }
    const updated = await setBadge(session.id, 'lineage:1', badge)
    expect(updated.badges).toEqual({ 'cli/lineage:1': badge })
    await waitFor(() => changes().length === before + 1 || undefined)
    expect((changes().at(-1) as unknown as { data: { session: Session } }).data.session.badges).toEqual({ 'cli/lineage:1': badge })
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ badges: { 'cli/lineage:1': badge } })
  })

  test('answers with a { session } envelope', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    const result = await call<Record<string, unknown>>(client, 'quirky.session/setBadge', { session: session.id, key: 'a', badge: { label: 'A' } })
    expect(Object.keys(result)).toEqual(['session'])
    expect(result.session).toMatchObject({ id: session.id, badges: { 'cli/a': { label: 'A' } } })
  })

  test('null removes the badge and leaves the others', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    await setBadge(session.id, 'a', { label: 'A' })
    await setBadge(session.id, 'b', { label: 'B' })
    const removed = await setBadge(session.id, 'a', null)
    expect(removed.badges).toEqual({ 'cli/b': { label: 'B' } })
    const cleared = await setBadge(session.id, 'b', null)
    expect(cleared.badges ?? {}).toEqual({})
  })

  test('an unknown session is NotFound and a badge without a label is InvalidParams', async () => {
    expect(await code(setBadge('s_nope', 'a', { label: 'A' }))).toBe(RpcErrorCode.NotFound)
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    expect(await code(setBadge(session.id, 'a', { tooltip: 'no label' }))).toBe(RpcErrorCode.InvalidParams)
    expect(await code(setBadge(session.id, 'a', 'text'))).toBe(RpcErrorCode.InvalidParams)
  })

  test('badges survive a status update and a daemon restart', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    await setBadge(session.id, 'a', { label: 'A' })
    const after = await call<Session>(client, 'quirky.session/setStatus', { session: session.id, status: 'working' })
    expect(after.badges).toEqual({ 'cli/a': { label: 'A' } })

    const again = await restartDaemon(h)
    try {
      expect(await call(again.client, 'quirky.session/get', { session: session.id })).toMatchObject({ badges: { 'cli/a': { label: 'A' } } })
    } finally {
      await again.stop()
    }
  })

  test('plugins cannot overwrite or remove each other badges', async () => {
    await h.cleanup()
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    for (const id of ['acme.one', 'acme.two']) {
      writeModulePlugin(
        join(home, 'plugins'),
        marker,
        { id, contributes: { method: [{ id: 'badge', params: { type: 'object', additionalProperties: true } }] } },
        { activate: `context.provide('method:${id}/badge', (params) => context.call('quirky.session/setBadge', params))` }
      )
    }
    h = await startPluginHarness(SESSION_PLUGINS, { home })
    client = await h.connect('cli')
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })

    await call(client, 'acme.one/badge', { session: session.id, key: 'k', badge: { label: 'one' } })
    await call(client, 'acme.two/badge', { session: session.id, key: 'k', badge: { label: 'two' } })
    expect((await call<Session>(client, 'quirky.session/get', { session: session.id })).badges).toEqual({
      'acme.one/k': { label: 'one' },
      'acme.two/k': { label: 'two' }
    })

    await call(client, 'acme.one/badge', { session: session.id, key: 'k', badge: null })
    expect((await call<Session>(client, 'quirky.session/get', { session: session.id })).badges).toEqual({ 'acme.two/k': { label: 'two' } })
  })
})

describe('session store badges column', () => {
  const insert = (store: ReturnType<typeof memoryStore>) =>
    store.run(
      "INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id) VALUES ('s_old', 'terminal', 'claude', 'wt', '/work', 'Claude', 'running', 1, 1, NULL, 'repo')"
    )

  test('a named session from the shipped schema upgrades without losing its name or badge writes', () => {
    const store = memoryStore(6)
    store.exec('ALTER TABLE sessions ADD COLUMN name TEXT')
    insert(store)
    store.run("UPDATE sessions SET name = 'reviewer' WHERE id = 's_old'")
    migrateStore(store, 7)
    const records = new SessionRecords(store)
    expect(records.get('s_old')).toMatchObject({ name: 'reviewer' })
    expect(records.get('s_old')?.badges ?? {}).toEqual({})
    expect(records.update('s_old', { badges: { 'a/k': { label: 'A' } } })).toMatchObject({
      name: 'reviewer',
      badges: { 'a/k': { label: 'A' } }
    })
  })

  test('badges round-trip through update and other updates leave them', () => {
    const store = memoryStore()
    insert(store)
    const records = new SessionRecords(store)
    expect(records.update('s_old', { badges: { 'a/k': { label: 'A' } } })?.badges).toEqual({ 'a/k': { label: 'A' } })
    expect(records.update('s_old', { status: 'working' })?.badges).toEqual({ 'a/k': { label: 'A' } })
    expect(records.update('s_old', { badges: {} })?.badges ?? {}).toEqual({})
  })
})
