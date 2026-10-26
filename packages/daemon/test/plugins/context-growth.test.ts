import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { base64ToBytes, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { PluginEvents } from '../../src/plugins/events'
import { PluginHost } from '../../src/plugins/host'
import { Core, type CoreOptions } from '../../src/service'
import { Store } from '../../src/store'
import type { ClientConn } from '../../src/types'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  delete (globalThis as Record<string, unknown>).__cg
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>
type Fixture = { manifest: Manifest; behavior?: ModuleBehavior }
type Seen = Record<string, { data: [string, string][]; exit: [string, number | null][]; reconnect: number }>

const seen = () => (globalThis as { __cg?: Seen }).__cg ?? {}

const methodNames = [
  'spawn',
  'write',
  'resize',
  'read',
  'kill',
  'forget',
  'list',
  'subscribe',
  'unsubscribe',
  'listen',
  'connected',
  'notify',
  'launchEnv',
  'launchInfo',
  'launchHooks',
  'home'
]

/** A plugin that exposes each new context member as a method; `listen` records what its listeners receive. */
function contextPlugin(id: string): Fixture {
  const impl = (name: string, body: string) => `context.provide('method:${id}/${name}', async (p) => { ${body} })`
  return {
    manifest: { id, contributes: { method: methodNames.map((name) => ({ id: name, params: { type: 'object', additionalProperties: true } })) } },
    behavior: {
      activate: [
        `const cg = ((globalThis as any).__cg ??= {}); const mine = (cg[${JSON.stringify(id)}] = { data: [], exit: [], reconnect: 0 })`,
        impl('spawn', 'return context.pty.spawn(p.sessionId, { argv: ["sh"], cwd: "/tmp", env: { A: "1" }, cols: 80, rows: 24 })'),
        impl('write', 'context.pty.write(p.sessionId, p.bytes ? new Uint8Array(p.bytes) : p.data); return true'),
        impl('resize', 'await context.pty.resize(p.sessionId, p.cols, p.rows); return true'),
        impl('read', 'return context.pty.read(p.sessionId, p.lines)'),
        impl('kill', 'await context.pty.kill(p.sessionId, p.signal); return true'),
        impl('forget', 'await context.pty.forget(p.sessionId); return true'),
        impl('list', 'return context.pty.list()'),
        impl('subscribe', 'return context.pty.subscribe(p.sessionId)'),
        impl('unsubscribe', 'await context.pty.unsubscribe(p.sessionId); return true'),
        impl(
          'listen',
          `context.pty.onData((sessionId, bytes) => mine.data.push([sessionId, new TextDecoder().decode(bytes)]))
           context.pty.onExit((sessionId, code) => mine.exit.push([sessionId, code]))
           context.pty.onReconnect(() => { mine.reconnect++ })
           return true`
        ),
        impl('connected', 'return context.pty.connected'),
        impl('notify', 'context.notify(p.n); return true'),
        impl('launchEnv', 'return context.launch.env(p.input)'),
        impl(
          'launchInfo',
          'return { shell: context.launch.shell, binDir: context.launch.binDir, shellArgv: context.launch.shellArgv(), commandArgv: context.launch.commandArgv(p.command) }'
        ),
        impl('launchHooks', 'return context.launch.hooks(p.input)'),
        impl('home', 'return context.home')
      ].join('\n')
    }
  }
}

const launchHook: Fixture = {
  manifest: { id: 'acme.env', contributes: { 'launch-hook': [{ id: 'vars', agents: ['claude'] }] } },
  behavior: { activate: "context.provide('launch-hook:acme.env/vars', () => ({ env: { FOO: '1' }, args: ['--model', 'opus'] }))" }
}

async function boot(plugins: Fixture[]) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const { manifest, behavior } of plugins) writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  const harness = await startHarness({ home, builtinPluginsDir: null })
  h = harness
  const client = await harness.connect()
  const call = (method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)
  return { harness, client, home, call }
}

const spawnArgs = (sessionId: string) => ({ sessionId })

describe('context.pty', () => {
  test('spawn, list, write, resize, read and kill go through the PTY host', async () => {
    const s = await boot([contextPlugin('acme.ctx')])
    const { pty } = s.harness

    expect(await s.call('acme.ctx/connected')).toBe(true)
    expect(await s.call('acme.ctx/spawn', spawnArgs('p1'))).toEqual({ pid: expect.any(Number) })
    const created = pty.requests.find((request) => request.type === 'create')
    expect(created).toMatchObject({ sessionId: 'p1', argv: ['sh'], cwd: '/tmp', env: { A: '1' }, cols: 80, rows: 24 })

    expect(await s.call('acme.ctx/list')).toEqual([expect.objectContaining({ sessionId: 'p1', alive: true, cwd: '/tmp' })])

    await s.call('acme.ctx/write', { sessionId: 'p1', data: 'echo hi\n' })
    await s.call('acme.ctx/write', { sessionId: 'p1', bytes: [0x03] })
    await waitFor(() => pty.inputs.length === 2)
    expect(pty.inputs).toEqual([
      { sessionId: 'p1', text: 'echo hi\n' },
      { sessionId: 'p1', text: '\u0003' }
    ])

    await s.call('acme.ctx/resize', { sessionId: 'p1', cols: 100, rows: 40 })
    expect(pty.sessions.get('p1')?.info).toMatchObject({ cols: 100, rows: 40 })

    expect(await s.call('acme.ctx/read', { sessionId: 'p1', lines: 5 })).toEqual({
      lines: ['hello from the screen'],
      cols: 80,
      rows: 24,
      alt: false
    })
    expect(pty.requests.find((request) => request.type === 'read')).toMatchObject({ sessionId: 'p1', lines: 5 })

    await s.call('acme.ctx/kill', { sessionId: 'p1', signal: 'SIGTERM' })
    expect(pty.requests.find((request) => request.type === 'kill')).toMatchObject({ sessionId: 'p1', signal: 'SIGTERM' })
    await s.call('acme.ctx/forget', { sessionId: 'p1' })
    expect(pty.sessions.has('p1')).toBe(false)
  })

  test('subscribe replays output so far and then streams to onData', async () => {
    const s = await boot([contextPlugin('acme.ctx')])
    const { pty } = s.harness
    await s.call('acme.ctx/spawn', spawnArgs('p1'))
    await s.call('acme.ctx/listen')
    pty.emit('p1', 'before')

    const subscribed = (await s.call('acme.ctx/subscribe', spawnArgs('p1'))) as { replay: string; offset: number }
    expect(new TextDecoder().decode(base64ToBytes(subscribed.replay))).toBe('before')
    expect(subscribed.offset).toBe(6)

    pty.emit('p1', 'after')
    await waitFor(() => seen()['acme.ctx']?.data.length)
    expect(seen()['acme.ctx']?.data).toEqual([['p1', 'after']])

    await s.call('acme.ctx/unsubscribe', spawnArgs('p1'))
    pty.emit('p1', 'ignored')
    await Bun.sleep(50)
    expect(seen()['acme.ctx']?.data).toEqual([['p1', 'after']])
  })

  test('onExit and onReconnect reach the plugin', async () => {
    const s = await boot([contextPlugin('acme.ctx')])
    const { pty } = s.harness
    await s.call('acme.ctx/spawn', spawnArgs('p1'))
    await s.call('acme.ctx/listen')

    pty.exit('p1', 7)
    await waitFor(() => seen()['acme.ctx']?.exit.length)
    expect(seen()['acme.ctx']?.exit).toEqual([['p1', 7]])

    pty.dropConnections()
    await waitFor(() => seen()['acme.ctx']?.reconnect === 1)
  })

  test('revoking a plugin removes its listeners and leaves other plugins untouched', async () => {
    const s = await boot([contextPlugin('acme.a'), contextPlugin('acme.b')])
    const { pty } = s.harness
    await s.call('acme.a/spawn', spawnArgs('p1'))
    await s.call('acme.a/listen')
    await s.call('acme.b/listen')
    await s.call('acme.a/subscribe', spawnArgs('p1'))
    await s.call('acme.b/subscribe', spawnArgs('p1'))

    pty.emit('p1', 'one')
    await waitFor(() => seen()['acme.a']?.data.length === 1 && seen()['acme.b']?.data.length === 1)

    await s.client.call('plugin.disable', { id: 'acme.a' })
    pty.emit('p1', 'two')
    pty.exit('p1', 0)
    await waitFor(() => seen()['acme.b']?.data.length === 2 && seen()['acme.b']?.exit.length === 1)

    expect(seen()['acme.a']?.data).toEqual([['p1', 'one']])
    expect(seen()['acme.a']?.exit).toEqual([])
  })

  test('a listener that throws does not stop the other plugins', async () => {
    const thrower = contextPlugin('acme.a')
    thrower.behavior!.activate += "\ncontext.provide('method:acme.a/boom', async () => { context.pty.onData(() => { throw new Error('boom') }); return true })"
    thrower.manifest.contributes = { method: [...(thrower.manifest.contributes as { method: object[] }).method, { id: 'boom' }] }
    const s = await boot([thrower, contextPlugin('acme.b')])
    await s.call('acme.a/spawn', spawnArgs('p1'))
    await s.call('acme.a/boom')
    await s.call('acme.b/listen')
    await s.call('acme.b/subscribe', spawnArgs('p1'))

    s.harness.pty.emit('p1', 'x')
    await waitFor(() => seen()['acme.b']?.data.length === 1)
  })
})

describe('context.notify', () => {
  async function bootNotify() {
    const s = await boot([contextPlugin('acme.ctx')])
    const { events } = await s.harness.connectWithEvents('ui')
    const notifies = () => events.filter((event) => event.type === 'notify')
    return { ...s, notifies }
  }

  test('SC-23: broadcasts notify with desktop true and shows an OS notification when no desktop client is connected', async () => {
    const s = await bootNotify()
    await s.call('acme.ctx/notify', {
      n: { title: 'main', body: 'Claude finished', sessionId: 's_1', worktreeId: 'wt_1', open: { view: 'acme/session', input: { id: 's_1' } } }
    })
    await waitFor(() => s.notifies().length === 1)
    expect(s.notifies()[0]).toEqual({
      type: 'notify',
      title: 'main',
      body: 'Claude finished',
      sessionId: 's_1',
      worktreeId: 'wt_1',
      open: { view: 'acme/session', input: { id: 's_1' } },
      desktop: true
    })
    expect(s.harness.notifications).toEqual([{ title: 'main', body: 'Claude finished' }])
  })

  test('desktop false broadcasts desktop false and shows no OS notification', async () => {
    const s = await bootNotify()
    await s.call('acme.ctx/notify', { n: { title: 't', body: 'b', desktop: false } })
    await waitFor(() => s.notifies().length === 1)
    expect(s.notifies()[0]).toEqual({ type: 'notify', title: 't', body: 'b', desktop: false })
    expect(s.harness.notifications).toEqual([])
  })

  test('a connected desktop client receives the event and the daemon stays silent', async () => {
    const s = await bootNotify()
    const desktop = await s.harness.connectWithEvents('desktop')
    await s.call('acme.ctx/notify', { n: { title: 't', body: 'b' } })
    await waitFor(() => desktop.events.some((event) => event.type === 'notify'))
    expect(desktop.events.find((event) => event.type === 'notify')).toMatchObject({ desktop: true })
    expect(s.harness.notifications).toEqual([])
  })

  test('the OS notification returns when the desktop client disconnects', async () => {
    const s = await bootNotify()
    const desktop = await s.harness.connectWithEvents('desktop')
    desktop.client.close()
    await waitForAsync(async () => (await s.client.call('status.get', {})).clients.every((client) => client.role !== 'desktop'))
    await s.call('acme.ctx/notify', { n: { title: 't', body: 'b' } })
    await waitFor(() => s.harness.notifications.length === 1)
  })
})

describe('context.launch and context.home', () => {
  test('home is the daemon home', async () => {
    const s = await boot([contextPlugin('acme.ctx')])
    expect(await s.call('acme.ctx/home')).toBe(s.home)
  })

  test('SC-22: env carries the QUIRKY_* variables, the bin dir first on PATH and unreserved patches', async () => {
    const s = await boot([contextPlugin('acme.ctx')])
    const identity = JSON.parse(readFileSync(join(s.home, 'daemon-identity.json'), 'utf8')) as { hookToken: string }

    const env = (await s.call('acme.ctx/launchEnv', {
      input: {
        sessionId: 's_1',
        worktreeId: 'wt_1',
        agent: 'claude',
        envPatch: { FOO: '1', QUIRKY_HOME: '/evil', PATH: '/evil', ZDOTDIR: '/evil' }
      }
    })) as Record<string, string>

    expect(env.QUIRKY_HOME).toBe(s.home)
    expect(env.QUIRKY_SESSION_ID).toBe('s_1')
    expect(env.QUIRKY_WORKTREE_ID).toBe('wt_1')
    expect(env.QUIRKY_HOOK_URL).toBe(`http://127.0.0.1:${s.harness.daemon.port}/hook`)
    expect(env.QUIRKY_HOOK_TOKEN).toBe(identity.hookToken)
    expect(env.PATH.startsWith(`${s.home}/bin:`)).toBe(true)
    expect(env.FOO).toBe('1')
    expect(env.ZDOTDIR).not.toBe('/evil')
    expect(env.TERM).toBe('xterm-256color')
  })

  test('a shell agent gets the zsh wrapper directory', async () => {
    const s = await boot([contextPlugin('acme.ctx')])
    const env = (await s.call('acme.ctx/launchEnv', { input: { sessionId: 's_1', worktreeId: 'wt_1', agent: 'shell' } })) as Record<string, string>
    expect(env.ZDOTDIR).toBe(join(s.home, 'shell', 'zsh'))
  })

  test('shell, binDir and the argv builders match the login-shell launch', async () => {
    const s = await boot([contextPlugin('acme.ctx')])
    const info = await s.call('acme.ctx/launchInfo', { command: 'claude hi' })
    expect(info).toEqual({
      shell: '/bin/zsh',
      binDir: join(s.home, 'bin'),
      shellArgv: ['/bin/zsh', '-l'],
      commandArgv: ['/bin/zsh', '-l', '-c', `export PATH="${s.home}/bin:$PATH"; exec claude hi`]
    })
  })

  test('hooks runs the launch-hook pipeline', async () => {
    const s = await boot([contextPlugin('acme.ctx'), launchHook])
    const input = { sessionId: 's_1', worktreeId: 'wt_1', repoId: 'repo_1', cwd: '/tmp' }
    expect(await s.call('acme.ctx/launchHooks', { input: { ...input, agent: 'claude' } })).toEqual({
      env: { FOO: '1' },
      args: ['--model', 'opus']
    })
    expect(await s.call('acme.ctx/launchHooks', { input: { ...input, agent: 'shell' } })).toEqual({ env: {}, args: [] })
  })
})

describe('plugin-only event delivery', () => {
  function setup() {
    const root = makeTempDir()
    const installedDir = join(root, 'installed')
    mkdirSync(installedDir)
    const host = new PluginHost({
      builtinDir: null,
      installedDir,
      store: { listDisabledIds: () => [], setDisabledId: () => {} },
      emit: () => {},
      log: () => {}
    })
    const events = new PluginEvents(host, () => {}, () => {})
    const core = new Core({
      home: root,
      store: new Store(':memory:'),
      pty: { onData() {}, onExit() {}, onReconnect() {}, connected: true },
      notifier: () => {},
      runnerFactory: () => ({}),
      hookToken: 'token',
      hookUrl: () => 'http://127.0.0.1:1/hook',
      onEvent: (event: QuirkyEvent) => events.deliver(event)
    } as unknown as CoreOptions)
    const text: string[] = []
    const client = {
      id: 1,
      role: 'ui',
      subscribed: true,
      closed: false,
      transport: 'websocket',
      streams: new Map(),
      nextStreamId: 1,
      streamClosers: new Map(),
      sendText: (value: string) => void text.push(value),
      sendBinary: () => {}
    } as ClientConn
    core.addClient(client)
    return { core, events, text }
  }

  test('SC-23: hook.received reaches a plugin listener and no subscribed client', async () => {
    const t = setup()
    const received: QuirkyEvent[] = []
    t.events.subscribe('acme.tools', (event) => void received.push(event))
    const hook: QuirkyEvent = { type: 'hook.received', agent: 'claude', sessionId: 's_1', payload: { hook_event_name: 'Stop' } }

    t.core.deliverToPlugins(hook)
    t.core.broadcast(hook)
    await waitFor(() => received.length === 2)

    expect(received).toEqual([hook, hook])
    expect(t.text).toEqual([])
  })
})
