import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_TOKEN_HEADER, type QuirkyClient, type QuirkyEvent, type Session } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'

const PLUGIN_DIR = join(import.meta.dir, '..')
const FAKES_DIR = join(import.meta.dir, 'fakes')
const NOTIFICATIONS = 'setting:quirky.agent-status/notifications'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

afterEach(async () => {
  await h?.cleanup()
  removeTempDirs()
})

const claudeSession: Session = {
  id: 's1',
  kind: 'terminal',
  agent: 'claude',
  worktreeId: 'wt1',
  cwd: '/fake/alpha/main',
  title: 'Claude',
  status: 'running',
  createdAt: 1,
  lastActivityAt: 1,
  exitCode: null
}

/** A directory of built-ins holding the real plugin and fakes of its dependencies. */
function builtinDir(): string {
  const dir = makeTempDir('qas-')
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.agent-status'))
  symlinkSync(join(FAKES_DIR, 'quirky.session'), join(dir, 'quirky.session'))
  symlinkSync(join(FAKES_DIR, 'quirky.worktree'), join(dir, 'quirky.worktree'))
  return dir
}

async function setup(options: { home?: string; sessions?: Partial<Session>[] } = {}) {
  h = await startHarness({ home: options.home ?? makeTempHome('qas-h-'), builtinPluginsDir: builtinDir() })
  ;({ client, events } = await h.connectWithEvents('cli'))
  for (const session of options.sessions ?? [{}]) await seed(session)
}

const seed = (session: Partial<Session>) => client.callAny('quirky.session/seed', { ...claudeSession, ...session })

function post(agent: string, payload: unknown, sessionId = 's1') {
  return fetch(`http://127.0.0.1:${h.runtime.port}/hook/${agent}?session=${sessionId}`, {
    method: 'POST',
    headers: { [HOOK_TOKEN_HEADER]: h.runtime.hookToken },
    body: JSON.stringify(payload)
  })
}

/** Posts a hook and waits until the plugin has recorded and handled it. */
async function hook(agent: string, payload: unknown, sessionId = 's1') {
  const sentAt = Date.now()
  expect((await post(agent, payload, sessionId)).status).toBe(200)
  await waitForAsync(async () => (await listed()).some((row) => row.sessionId === sessionId && row.lastHookAt >= sentAt))
  await settle()
}

const listed = async () => (await client.callAny('quirky.agent-status/list', {})) as { sessionId: string; lastHookAt: number }[]

/** Gives the plugin's hook queue time to drain when a hook is expected to change nothing. */
async function settle() {
  await Bun.sleep(30)
}

const statusOf = async (id = 's1') => ((await client.callAny('quirky.session/get', { session: id })) as Session).status
const calls = async () => (await client.callAny('quirky.session/calls', {})) as { session: string; status: string }[]
const changes = () =>
  events
    .filter((e) => e.type === 'quirky.session/changed')
    .map((e) => (e as { data: { session: Session } }).data.session.status)
const notifies = () => events.filter((e) => e.type === 'notify')

describe('claude hooks', () => {
  test('SC-23: events map to working, waiting and done', async () => {
    await setup()
    for (const [payload, status] of [
      [{ hook_event_name: 'UserPromptSubmit' }, 'working'],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 'working'],
      [{ hook_event_name: 'Notification' }, 'waiting'],
      [{ hook_event_name: 'Stop' }, 'done']
    ] as const) {
      expect((await post('claude', payload)).status).toBe(200)
      await waitForAsync(async () => (await statusOf()) === status)
    }
    expect(changes()).toEqual(['working', 'waiting', 'done'])
  })

  test('SC-23: waiting and done emit notify for the worktree and open the session, and run the OS notifier without a desktop client', async () => {
    await setup()
    await post('claude', { hook_event_name: 'Notification' })
    await waitFor(() => notifies().length === 1)
    await post('claude', { hook_event_name: 'Stop' })
    await waitFor(() => notifies().length === 2)
    const open = { view: 'view:quirky.session/worktree', input: { worktree: 'wt1', session: 's1' } }
    expect(notifies()).toEqual([
      { type: 'notify', title: 'main', body: 'Claude needs input', sessionId: 's1', worktreeId: 'wt1', open, desktop: true },
      { type: 'notify', title: 'main', body: 'Claude finished', sessionId: 's1', worktreeId: 'wt1', open, desktop: true }
    ])
    expect(h.notifications).toEqual([
      { title: 'main', body: 'Claude needs input' },
      { title: 'main', body: 'Claude finished' }
    ])
  })

  test('the notify title is the name of the session worktree and the body uses the session title', async () => {
    await setup({ sessions: [{ worktreeId: 'wt2', title: 'Claude 2' }] })
    await post('claude', { hook_event_name: 'Stop' })
    await waitFor(() => notifies().length === 1)
    expect(notifies()[0]).toMatchObject({ title: 'feature', body: 'Claude 2 finished', worktreeId: 'wt2' })
  })

  test('working does not notify, and repeated done notifies once', async () => {
    await setup()
    await post('claude', { hook_event_name: 'UserPromptSubmit' })
    await post('claude', { hook_event_name: 'Stop' })
    await post('claude', { hook_event_name: 'Stop' })
    await waitForAsync(async () => (await calls()).length === 3)
    expect(notifies()).toHaveLength(1)
  })

  test('an event that implies no status leaves the session alone, and a same-status hook still reaches setStatus', async () => {
    await setup()
    await post('claude', { hook_event_name: 'SomethingElse' })
    await hook('claude', { hook_event_name: 'UserPromptSubmit' })
    expect(await calls()).toEqual([{ session: 's1', status: 'working' }])
    await hook('claude', { hook_event_name: 'PreToolUse' })
    expect(await calls()).toHaveLength(2)
    expect(changes()).toEqual(['working'])
  })

  test('an idle reminder after done changes nothing and does not notify', async () => {
    await setup({ sessions: [{ status: 'done' }] })
    await post('claude', {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input'
    })
    await post('claude', { hook_event_name: 'Notification', message: 'Claude is waiting for your input' })
    await settle()
    expect(await calls()).toEqual([])
    expect(notifies()).toHaveLength(0)
  })

  test('a permission notification still sets waiting after done', async () => {
    await setup({ sessions: [{ status: 'done' }] })
    await post('claude', {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash'
    })
    await waitForAsync(async () => (await statusOf()) === 'waiting')
  })

  test('an idle reminder while working still sets waiting', async () => {
    await setup({ sessions: [{ status: 'working' }] })
    await post('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    await waitForAsync(async () => (await statusOf()) === 'waiting')
  })

  test('hooks for unknown sessions are accepted and change nothing; bad bodies are rejected', async () => {
    await setup()
    const unknown = await post('claude', { hook_event_name: 'Stop' }, 's_missing')
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ ok: true })
    const bad = await fetch(`http://127.0.0.1:${h.runtime.port}/hook/claude?session=s1`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: h.runtime.hookToken },
      body: 'not json'
    })
    expect(bad.status).toBe(400)
    await settle()
    expect(await calls()).toEqual([])
    expect(await listed()).toEqual([])
  })

  test('exited and structured sessions ignore hooks', async () => {
    await setup({ sessions: [{ status: 'exited' }, { id: 's2', kind: 'structured' }] })
    await post('claude', { hook_event_name: 'Stop' })
    await post('claude', { hook_event_name: 'Stop' }, 's2')
    await settle()
    expect(await calls()).toEqual([])
    expect(notifies()).toHaveLength(0)
  })
})

describe('notifications setting', () => {
  test('SC-25: it is a boolean setting that defaults to true', async () => {
    await setup()
    const info = (await client.callAny('setting.get', { id: NOTIFICATIONS })) as Record<string, unknown>
    expect(info).toMatchObject({ type: 'boolean', title: 'Notify when agents finish', default: true, value: true })
  })

  test('SC-23: off keeps the toast but suppresses the OS notification', async () => {
    await setup()
    await client.callAny('setting.set', { id: NOTIFICATIONS, value: false })
    await post('claude', { hook_event_name: 'Stop' })
    await waitFor(() => notifies().length === 1)
    expect(notifies()[0]).toMatchObject({ desktop: false })
    await settle()
    expect(h.notifications).toEqual([])
  })

  test('a connected desktop client suppresses the daemon notifier', async () => {
    await setup()
    await h.connect('desktop')
    await post('claude', { hook_event_name: 'Stop' })
    await waitFor(() => notifies().length === 1)
    expect(notifies()[0]).toMatchObject({ desktop: true })
    await settle()
    expect(h.notifications).toEqual([])
  })

  test("a v1 home's notifications value carries over once", async () => {
    const home = makeTempHome('qas-h-')
    const v1 = new Database(join(home, 'quirky.db'))
    v1.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    v1.query('INSERT INTO settings (key, value) VALUES (?, ?)').run('notifications', 'false')
    v1.close()
    await setup({ home })
    expect(((await client.callAny('setting.get', { id: NOTIFICATIONS })) as { value: unknown }).value).toBe(false)

    await client.callAny('setting.set', { id: NOTIFICATIONS, value: true })
    await h.daemon.stop()
    h.pty.stop()
    const second = await startHarness({ home, builtinPluginsDir: builtinDir() })
    const again = await second.connect()
    expect(((await again.callAny('setting.get', { id: NOTIFICATIONS })) as { value: unknown }).value).toBe(true)
    await second.cleanup()
  })
})

describe('codex hooks', () => {
  test('a notify payload marks the turn done and notifies', async () => {
    await setup({ sessions: [{ agent: 'codex', title: 'Codex' }] })
    await post('codex', { type: 'agent-turn-complete', 'turn-id': '1' })
    await waitForAsync(async () => (await statusOf()) === 'done')
    await waitFor(() => notifies().length === 1)
    expect(notifies()[0]).toMatchObject({ title: 'main', body: 'Codex finished' })
    expect(h.notifications).toEqual([{ title: 'main', body: 'Codex finished' }])
  })
})

describe('hook endpoint', () => {
  test('SC-23: a wrong hook token is refused with 401 and changes nothing', async () => {
    await setup()
    const response = await fetch(`http://127.0.0.1:${h.runtime.port}/hook/claude?session=s1`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: 'wrong' },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })
    expect(response.status).toBe(401)
    await settle()
    expect(await calls()).toEqual([])
    expect(notifies()).toHaveLength(0)
  })
})

describe('launch hook', () => {
  test('SC-22: Claude gets --settings with the settings file the plugin wrote on activation', async () => {
    await setup()
    const { args, env } = (await client.callAny('quirky.session/create', { worktree: 'wt1', agent: 'claude', prompt: 'hi' })) as {
      args: string[]
      env: Record<string, string | null>
    }
    const settingsFile = join(h.home, 'plugin-data', 'quirky.agent-status', 'claude-settings.json')
    expect(args).toEqual(['--settings', settingsFile])
    expect(env).toEqual({})

    const command = `'${join(h.home, 'bin', 'quirky-hook')}' claude`
    const entry = (matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] })
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      hooks: {
        UserPromptSubmit: [entry()],
        PreToolUse: [entry('*')],
        Notification: [entry()],
        Stop: [entry()]
      }
    })
  })

  test('SC-22: Codex gets a notify config naming the hook script', async () => {
    await setup()
    const { args } = (await client.callAny('quirky.session/create', { worktree: 'wt1', agent: 'codex' })) as { args: string[] }
    expect(args).toEqual(['-c', `notify=["${join(h.home, 'bin', 'quirky-hook')}","codex"]`])
  })

  test('other agents get no arguments from this hook', async () => {
    await setup()
    const { args } = (await client.callAny('quirky.session/create', { worktree: 'wt1', agent: 'gemini' })) as { args: string[] }
    expect(args).toEqual([])
  })
})

describe('list', () => {
  test('SC-34: lists the sessions that received a hook with their status and time of last hook', async () => {
    await setup({ sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3', worktreeId: 'wt2' }] })
    await hook('claude', { hook_event_name: 'UserPromptSubmit' }, 's1')
    await hook('claude', { hook_event_name: 'Stop' }, 's2')
    await settle()

    const run = (...args: string[]) => runCli(args, { home: h.home })
    const result = await run('agent-status', 'list', '--json')
    expect(result.code).toBe(0)
    const rows = JSON.parse(result.stdout) as { sessionId: string; agent: string; status: string; lastHookAt: number }[]
    expect(rows.map(({ sessionId, agent, status }) => ({ sessionId, agent, status }))).toEqual([
      { sessionId: 's1', agent: 'claude', status: 'working' },
      { sessionId: 's2', agent: 'claude', status: 'done' }
    ])
    for (const row of rows) expect(row.lastHookAt).toBeGreaterThan(0)
  })

  test('narrows to one worktree', async () => {
    await setup({ sessions: [{ id: 's1' }, { id: 's3', worktreeId: 'wt2' }] })
    await hook('claude', { hook_event_name: 'UserPromptSubmit' }, 's1')
    await hook('claude', { hook_event_name: 'UserPromptSubmit' }, 's3')
    const rows = (await client.callAny('quirky.agent-status/list', { worktree: 'wt2' })) as { sessionId: string }[]
    expect(rows.map((row) => row.sessionId)).toEqual(['s3'])
  })

  test('a removed session leaves the list', async () => {
    await setup()
    await hook('claude', { hook_event_name: 'UserPromptSubmit' })
    await client.callAny('quirky.session/remove', { session: 's1' })
    await settle()
    expect(await listed()).toEqual([])
  })

  test('the time of last hook survives a restart', async () => {
    const home = makeTempHome('qas-h-')
    await setup({ home })
    await hook('claude', { hook_event_name: 'UserPromptSubmit' })
    const [first] = await listed()
    await h.daemon.stop()
    h.pty.stop()
    const second = await startHarness({ home, builtinPluginsDir: builtinDir() })
    const again = await second.connect()
    await again.callAny('quirky.session/seed', { ...claudeSession, status: 'working' })
    expect(await again.callAny('quirky.agent-status/list', {})).toEqual([
      { sessionId: 's1', agent: 'claude', status: 'working', lastHookAt: first!.lastHookAt }
    ])
    await second.cleanup()
  })
})
