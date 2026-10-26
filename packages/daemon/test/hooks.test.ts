import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { HOOK_TOKEN_HEADER, type QuirkyClient, type QuirkyEvent, type Session } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness, waitForAsync } from './helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin } from './plugins/fixtures'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]
let session: Session

async function setup(options: Parameters<typeof startHarness>[0] = {}) {
  h = await startHarness(options)
  h.git.addRepo('/fake/alpha')
  ;({ client, events } = await h.connectWithEvents('cli'))
  const repo = await client.call('repo.add', { path: '/fake/alpha' })
  const [worktree] = await client.call('worktree.list', { repoId: repo.id })
  session = await client.call('session.create', { worktreeId: worktree.id, agent: 'claude' })
}

afterEach(async () => {
  await h.cleanup()
  removeTempDirs()
})

function post(agent: string, payload: unknown, sessionId = session.id) {
  return fetch(`http://127.0.0.1:${h.runtime.port}/hook/${agent}?session=${sessionId}`, {
    method: 'POST',
    headers: { [HOOK_TOKEN_HEADER]: h.runtime.hookToken },
    body: JSON.stringify(payload)
  })
}

const statusOf = async () => (await client.call('session.list', {}))[0].status

describe('claude hooks', () => {
  beforeEach(() => setup())

  test('events map to working, waiting and done', async () => {
    expect((await post('claude', { hook_event_name: 'UserPromptSubmit' })).status).toBe(200)
    expect(await statusOf()).toBe('working')
    await post('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    expect(await statusOf()).toBe('working')
    await post('claude', { hook_event_name: 'Notification' })
    expect(await statusOf()).toBe('waiting')
    await post('claude', { hook_event_name: 'Stop' })
    expect(await statusOf()).toBe('done')
    const changes = events.filter((e) => e.type === 'session.changed')
    expect(changes.map((e) => (e as any).session.status)).toEqual([
      'running',
      'working',
      'waiting',
      'done'
    ])
  })

  test('done and waiting emit notify and invoke the notifier without a desktop client', async () => {
    await post('claude', { hook_event_name: 'Notification' })
    await post('claude', { hook_event_name: 'Stop' })
    const notifies = events.filter((e) => e.type === 'notify')
    expect(notifies).toEqual([
      { type: 'notify', title: 'main', body: 'Claude needs input', sessionId: session.id, worktreeId: session.worktreeId },
      { type: 'notify', title: 'main', body: 'Claude finished', sessionId: session.id, worktreeId: session.worktreeId }
    ])
    expect(h.notifications).toEqual([
      { title: 'main', body: 'Claude needs input' },
      { title: 'main', body: 'Claude finished' }
    ])
  })

  test('working does not notify, and repeated done notifies once', async () => {
    await post('claude', { hook_event_name: 'UserPromptSubmit' })
    await post('claude', { hook_event_name: 'Stop' })
    await post('claude', { hook_event_name: 'Stop' })
    expect(events.filter((e) => e.type === 'notify')).toHaveLength(1)
  })

  test('updates lastActivityAt and ignores unknown events', async () => {
    const before = (await client.call('session.list', {}))[0].lastActivityAt
    await Bun.sleep(5)
    await post('claude', { hook_event_name: 'SomethingElse' })
    expect((await client.call('session.list', {}))[0]).toMatchObject({ status: 'running', lastActivityAt: before })
    await post('claude', { hook_event_name: 'PreToolUse' })
    expect((await client.call('session.list', {}))[0].lastActivityAt).toBeGreaterThan(before)
  })

  test('an idle reminder after done changes nothing and does not notify', async () => {
    await post('claude', { hook_event_name: 'Stop' })
    const before = (await client.call('session.list', {}))[0]
    const notifies = events.filter((e) => e.type === 'notify').length
    await Bun.sleep(5)
    await post('claude', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input'
    })
    await post('claude', { hook_event_name: 'Notification', message: 'Claude is waiting for your input' })
    expect((await client.call('session.list', {}))[0]).toEqual(before)
    expect(events.filter((e) => e.type === 'notify')).toHaveLength(notifies)
  })

  test('a permission notification still sets waiting after done', async () => {
    await post('claude', { hook_event_name: 'Stop' })
    await post('claude', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash'
    })
    expect(await statusOf()).toBe('waiting')
  })

  test('an idle reminder while working still sets waiting', async () => {
    await post('claude', { hook_event_name: 'UserPromptSubmit' })
    await post('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    expect(await statusOf()).toBe('waiting')
  })

  test('accepts hooks for unknown sessions, rejects bad bodies; exited sessions ignore hooks', async () => {
    const unknown = await post('claude', { hook_event_name: 'Stop' }, 's_missing')
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ ok: true })
    const bad = await fetch(`http://127.0.0.1:${h.runtime.port}/hook/claude?session=${session.id}`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: h.runtime.hookToken },
      body: 'not json'
    })
    expect(bad.status).toBe(400)
    h.pty.exit(session.id, 0)
    await waitForAsync(async () => (await statusOf()) === 'exited')
    await post('claude', { hook_event_name: 'Stop' })
    expect(await statusOf()).toBe('exited')
  })

  test('notifications setting off suppresses the system notification only', async () => {
    await client.call('settings.set', { notifications: false })
    await post('claude', { hook_event_name: 'Stop' })
    expect(events.filter((e) => e.type === 'notify')).toHaveLength(1)
    expect(h.notifications).toEqual([])
  })

  test('a connected desktop client suppresses the system notification', async () => {
    await h.connect('desktop')
    await post('claude', { hook_event_name: 'Stop' })
    expect(events.filter((e) => e.type === 'notify')).toHaveLength(1)
    expect(h.notifications).toEqual([])
  })
})

describe('codex hooks', () => {
  beforeEach(() => setup())

  test('a notify payload marks the turn done', async () => {
    await post('codex', { type: 'agent-turn-complete', 'turn-id': '1' })
    expect(await statusOf()).toBe('done')
    expect(h.notifications).toEqual([{ title: 'main', body: 'Claude finished' }])
  })
})

describe('hook.received', () => {
  test('is delivered to plugin listeners with the hook payload, never to clients, for known and unknown sessions', async () => {
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      { id: 'acme.hear', activation: 'startup' },
      { activate: "context.subscribe((event) => { if (event.type === 'hook.received') record(JSON.stringify(event)) })" }
    )
    await setup({ home, builtinPluginsDir: null })

    expect((await post('claude', { hook_event_name: 'Stop' })).status).toBe(200)
    expect((await post('codex', { type: 'x' }, 's_missing')).status).toBe(200)

    const heard = await waitFor(() => {
      const lines = readMarker(marker).filter((line) => line.startsWith('{'))
      return lines.length === 2 ? lines.map((line) => JSON.parse(line)) : undefined
    })
    expect(heard).toEqual([
      { type: 'hook.received', agent: 'claude', sessionId: session.id, payload: { hook_event_name: 'Stop' } },
      { type: 'hook.received', agent: 'codex', sessionId: 's_missing', payload: { type: 'x' } }
    ])
    expect(events.some((event) => event.type === 'hook.received')).toBe(false)
  })

  test('is not delivered when the hook token is wrong', async () => {
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      { id: 'acme.hear', activation: 'startup' },
      { activate: "context.subscribe((event) => { if (event.type === 'hook.received') record('heard') })" }
    )
    await setup({ home, builtinPluginsDir: null })
    const response = await fetch(`http://127.0.0.1:${h.runtime.port}/hook/claude?session=${session.id}`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: 'wrong' },
      body: '{}'
    })
    expect(response.status).toBe(401)
    await Bun.sleep(50)
    expect(readMarker(marker)).not.toContain('heard')
  })
})
