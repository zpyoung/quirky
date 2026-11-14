import { afterEach, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient, RpcErrorCode } from '@quirky/protocol'
import { daemonEntryHash, isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { startDaemon, type DaemonHandle } from '../src/daemon'
import { startFakePtyHost } from './fixtures/fake-pty-host'
import { makeTempHome, waitFor, writeUiFixture } from './helpers'
import { makeTempDir, readMarker, removeTempDirs, waitForFile, writeModulePlugin } from './plugins/fixtures'
import { createStartupGate, STARTUP_HOOK_BYTES } from '../src/startup-gate'
import type { ClientConn } from '../src/types'

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const FAKE_HOST_MAIN = join(import.meta.dir, 'fixtures', 'fake-pty-host.ts')

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  let failed = false
  let firstError: unknown
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      if (!failed) firstError = error
      failed = true
    }
  }
  try {
    removeTempDirs()
  } catch (error) {
    if (!failed) firstError = error
    failed = true
  }
  if (failed) throw firstError
})

function scopedHome() {
  const home = makeTempHome()
  const scope = createProcessScope(home)
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  cleanups.push(() => scope.cleanup())
  return { home, scope }
}
async function withScopeToken<T>(scope: ProcessScope, action: () => Promise<T>): Promise<T> {
  const previous = process.env.QUIRKY_TEST_SCOPE
  process.env.QUIRKY_TEST_SCOPE = scope.env.QUIRKY_TEST_SCOPE
  try {
    return await action()
  } finally {
    if (previous === undefined) delete process.env.QUIRKY_TEST_SCOPE
    else process.env.QUIRKY_TEST_SCOPE = previous
  }
}

describe('pty host startup', () => {
  test('spawns the host when nothing answers and works through it', async () => {
    const { home, scope } = scopedHome()
    writeModulePlugin(
      join(home, 'plugins'),
      join(makeTempDir(), 'marker.log'),
      {
        id: 'acme.pty',
        contributes: { method: [{ id: 'spawnAndList', params: { type: 'object' } }] }
      },
      {
        activate: `context.provide('method:acme.pty/spawnAndList', async () => {
          await context.pty.spawn('s_probe', { argv: ['sh'], cwd: '/tmp', env: {}, cols: 80, rows: 24 })
          return context.pty.list()
        })`
      }
    )
    const daemon = await withScopeToken(scope, () => startDaemon({
      home,
      port: 0,
      builtinPluginsDir: null,
      shell: '/bin/zsh',
      notifier: () => {},
      uiDir: '/none',
      ptyHostEntry: FAKE_HOST_MAIN
    }))
    cleanups.push(() => daemon.stop())
    const client = await QuirkyClient.connect(rpcUrl(daemon.runtime), { role: 'cli' })
    cleanups.push(() => client.close())
    const status = await client.call('status.get', {})
    expect(status.ptyHost.alive).toBe(true)
    const hostPid = status.ptyHost.pid as number
    scope.track(hostPid)
    expect(hostPid).toBeGreaterThan(0)
    expect(hostPid).not.toBe(process.pid)
    expect(existsSync(join(home, 'logs', 'pty-host.log'))).toBe(true)
    expect(statSync(join(home, 'logs', 'pty-host.log')).mode & 0o777).toBe(0o600)

    const listed = (await client.callAny('acme.pty/spawnAndList', {})) as { sessionId: string; alive: boolean }[]
    expect(listed).toEqual([expect.objectContaining({ sessionId: 's_probe', alive: true })])
    client.close()
  })

  test('still starts when the host cannot be started', async () => {
    const { home } = scopedHome()
    const daemon = await startDaemon({
      home,
      port: 0,
      builtinPluginsDir: null,
      notifier: () => {},
      uiDir: '/none',
      ptyHostEntry: join(home, 'missing.ts'),
      ptyConnectTimeoutMs: 300,
      log: () => {}
    })
    cleanups.push(() => daemon.stop())
    const client = await QuirkyClient.connect(rpcUrl(daemon.runtime), { role: 'cli' })
    cleanups.push(() => client.close())
    expect((await client.call('status.get', {})).ptyHost.alive).toBe(false)
    client.close()
  })

  test('still starts when the host accepts but never answers hello', async () => {
    const { home, scope } = scopedHome()
    const host = startFakePtyHost(home, { silentHello: true })
    cleanups.push(() => host.stop())
    const hostEntry = join(home, 'exit-pty-host.ts')
    writeFileSync(hostEntry, 'process.exit(0)\n')
    const logs: string[] = []
    const started = Date.now()
    const daemon = await withScopeToken(scope, () =>
      startDaemon({
        home,
        port: 0,
        builtinPluginsDir: null,
        notifier: () => {},
        uiDir: '/none',
        ptyHostEntry: hostEntry,
        ptyConnectTimeoutMs: 300,
        log: (message) => logs.push(message)
      })
    )
    cleanups.push(() => daemon.stop())

    expect(Date.now() - started).toBeLessThan(5000)
    const response = await fetch(`http://127.0.0.1:${daemon.port}/health`)
    expect(response.status).toBe(200)
    expect(
      logs.some((message) =>
        message.startsWith('pty host unavailable at startup: quirky-pty did not answer within 300ms')
      )
    ).toBe(true)
  })

})

describe('single instance per home', () => {
  test('a second daemon on the same home exits 0 and leaves the first running', async () => {
    const { home, scope } = scopedHome()
    const env = {
      ...process.env,
      QUIRKY_HOME: home,
      QUIRKY_PORT: '0',
      QUIRKY_UI_DIR: join(home, 'none'),
      QUIRKY_PTY_HOST_ENTRY: FAKE_HOST_MAIN
    }
    const first = scope.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: 'ignore' })
    const info = await waitFor(() => readRuntime(home), 10000)
    expect(info.pid).toBe(first.pid)
    expect(await isDaemonAlive(info)).toBe(true)
    expect(info.entryHash).toBe(daemonEntryHash(MAIN))
    const hostPid = await waitFor(
      () => (existsSync(join(home, 'pty.pid')) ? Number(readFileSync(join(home, 'pty.pid'), 'utf8')) : undefined),
      10000
    )
    scope.track(hostPid)

    const second = scope.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: 'ignore' })
    expect(await second.exited).toBe(0)
    expect(readRuntime(home)?.pid).toBe(first.pid)
    expect(await isDaemonAlive(readRuntime(home))).toBe(true)

    first.kill('SIGTERM')
    await first.exited
    expect(existsSync(join(home, 'runtime.json'))).toBe(false)
    expect(readFileSync(join(home, 'quirky.db')).length).toBeGreaterThan(0)
  })

  test('does not print the rpc token and points at runtime.json', async () => {
    const { home, scope } = scopedHome()
    const proc = scope.spawn([process.execPath, MAIN], {
      env: {
        ...process.env,
        QUIRKY_HOME: home,
        QUIRKY_PORT: '0',
        QUIRKY_UI_DIR: join(home, 'none'),
        QUIRKY_PTY_HOST_ENTRY: FAKE_HOST_MAIN
      },
      stdout: 'pipe',
      stderr: 'ignore'
    })
    const info = await waitFor(() => readRuntime(home), 10000)
    const hostPid = await waitFor(
      () => (existsSync(join(home, 'pty.pid')) ? Number(readFileSync(join(home, 'pty.pid'), 'utf8')) : undefined),
      10000
    )
    scope.track(hostPid)
    proc.kill('SIGTERM')
    await proc.exited
    const output = await new Response(proc.stdout).text()
    expect(output).toContain(`http://127.0.0.1:${info.port}`)
    expect(output).toContain(join(home, 'runtime.json'))
    expect(output).not.toContain(info.token)
    expect(output).not.toContain(info.hookToken)
  })
})

function blockedStartup(options: { failing?: boolean; hooks?: boolean; job?: boolean; stopTimeoutMs?: number; probeAfterRelease?: boolean } = {}) {
  const { home } = scopedHome()
  const host = startFakePtyHost(home)
  cleanups.push(() => host.stop())
  const scratch = makeTempDir()
  const marker = join(scratch, 'activation.log')
  const release = join(scratch, 'release')
  const hooks = join(scratch, 'hooks.log')
  const uiDir = join(scratch, 'ui')
  writeUiFixture(uiDir)
  writeModulePlugin(join(home, 'plugins'), marker, {
    id: 'acme.slow',
    activation: 'startup',
    contributes: {
      method: [{ id: 'ping', params: { type: 'object' } }],
      ...(options.job ? { job: [{ id: 'tick', interval: '1m' }] } : {})
    }
  }, {
    activate: `${waitForFile(release)};
      ${options.probeAfterRelease ? `try {
        context.storedSettingValue('setting:acme.slow/probe')
        record('context remained usable')
      } catch (error) { record('context rejected: ' + error.message) }` : ''}
      context.provide('method:acme.slow/ping', () => 'pong');
      ${options.job ? "context.provide('job:acme.slow/tick', () => record('job ran'))" : ''}`
  })
  if (options.failing) {
    writeModulePlugin(join(home, 'plugins'), marker, {
      id: 'acme.failing', activation: 'startup',
      contributes: { method: [{ id: 'run', params: { type: 'object' } }] }
    }, { activate: "throw new Error('boom')" })
  }
  if (options.hooks) {
    writeModulePlugin(join(home, 'plugins'), marker, { id: 'acme.hooks', activation: 'startup' }, {
      activate: `context.subscribe((event) => {
        if (event.type === 'hook.received') appendFileSync(${JSON.stringify(hooks)}, JSON.stringify(event.payload) + '\\n')
      })`
    })
  }
  const logs: string[] = []
  let listening: DaemonHandle | undefined
  let settled = false
  const starting = startDaemon({
    home, port: 0, builtinPluginsDir: null, uiDir, notifier: () => {},
    pluginActivationTimeoutMs: 15_000,
    pluginStopTimeoutMs: options.stopTimeoutMs,
    onListening: (handle) => { listening = handle },
    log: (message) => logs.push(message)
  }).then((handle) => { settled = true; return handle })
  const unblock = () => writeFileSync(release, '')
  cleanups.push(async () => {
    unblock()
    await (await starting).stop()
  })
  return {
    home, logs, marker, hooks, starting, unblock,
    get settled() { return settled },
    get listening() { return listening },
    async blocked() {
      await waitFor(() => readMarker(marker).includes('activate acme.slow'))
    },
    async ready() {
      await waitFor(() => readRuntime(home))
      return listening!
    },
    received() {
      return existsSync(hooks) ? readFileSync(hooks, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
    },
    async post(payload: unknown) {
      const runtime = readRuntime(home)!
      return fetch(`http://127.0.0.1:${runtime.port}/hook/claude?session=s_1`, {
        method: 'POST', headers: { 'x-quirky-hook-token': runtime.hookToken },
        body: JSON.stringify(payload)
      })
    }
  }
}

describe('early listening during startup activation', () => {
  test('serves health and static UI before settling, and gates websocket and socket RPC', async () => {
    const t = blockedStartup()
    await t.blocked()
    // real startup and transports must stay blocked across the specified observation window
    await Bun.sleep(1000)
    const runtime = readRuntime(t.home)
    expect(runtime?.pid).toBe(process.pid)
    expect(t.settled).toBe(false)
    const origin = `http://127.0.0.1:${runtime!.port}`
    expect((await fetch(`${origin}/health`)).status).toBe(200)
    expect(await (await fetch(`${origin}/health`)).json()).toMatchObject({ ok: true })
    expect(await (await fetch(origin)).text()).toContain('<title>quirky</title>')
    const connected: string[] = []
    const connects = [
      QuirkyClient.connect(rpcUrl(runtime!), { role: 'cli' }),
      QuirkyClient.connectSocket(runtime!.socket!, { role: 'cli', token: runtime!.token })
    ].map((connecting, i) => connecting.then((client) => {
      cleanups.push(() => client.close())
      connected.push(String(i))
      return client
    }))
    const pings = connects.map(async (client) => (await client).callAny('acme.slow/ping', {}))
    await Bun.sleep(500)
    expect(connected).toEqual([])
    t.unblock()
    expect(await Promise.all(pings)).toEqual(['pong', 'pong'])
    expect(await t.starting).toBe(t.listening!)
    expect(t.logs.some((line) => line.includes('did not answer within'))).toBe(false)
    const timing = t.logs.filter((line) => /^listening after \d+ ms; startup plugins settled after \d+ ms$/.test(line))
    expect(timing).toHaveLength(1)
    const times = timing[0]!.match(/\d+/g)!.map(Number)
    expect(times[0]!).toBeLessThanOrEqual(times[1]!)
  })

  test('a failed startup plugin keeps its conflict error for a waiting caller', async () => {
    const t = blockedStartup({ failing: true })
    await t.blocked()
    const handle = await t.ready()
    const connecting = QuirkyClient.connect(rpcUrl(handle.runtime), { role: 'cli' })
    const call = connecting.then((client) => {
      cleanups.push(() => client.close())
      return client.callAny('acme.failing/run', {})
    })
    const outcome = call.then(() => null, (error: unknown) => error)
    t.unblock()
    expect(await outcome).toMatchObject({
      code: RpcErrorCode.Conflict, message: expect.stringContaining('acme.failing failed to activate: boom')
    })
    await t.starting
  })

  test('acknowledges hooks immediately but delivers them only after startup, in order', async () => {
    const t = blockedStartup({ hooks: true })
    await t.blocked()
    await t.ready()
    expect((await t.post({ n: 1 })).status).toBe(200)
    expect((await t.post({ n: 2 })).status).toBe(200)
    expect(t.received()).toEqual([])
    t.unblock()
    await t.starting
    await waitFor(() => t.received().length === 2)
    expect(t.received()).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('retains the first 1000 startup hooks and logs overflow once', async () => {
    const t = blockedStartup({ hooks: true })
    await t.blocked()
    await t.ready()
    for (let n = 0; n < 1001; n++) expect((await t.post({ n })).status).toBe(200)
    expect(t.received()).toEqual([])
    t.unblock()
    await t.starting
    await waitFor(() => t.received().length === 1000)
    expect(t.received()).toEqual(Array.from({ length: 1000 }, (_, n) => ({ n })))
    expect(t.logs.filter((line) => line.includes('agent hook that arrived during startup'))).toEqual([
      'dropped 1 agent hook that arrived during startup'
    ])
  }, 15_000)

  test('a stop during activation removes runtime and never restarts the scheduler', async () => {
    const t = blockedStartup({ job: true })
    await t.blocked()
    const handle = await t.ready()
    const stopping = handle.stop()
    t.unblock()
    await stopping
    expect(await t.starting).toBe(handle)
    expect(readRuntime(t.home)).toBeNull()
    await expect(fetch(`http://127.0.0.1:${handle.port}/health`)).rejects.toThrow()
    expect(readMarker(t.marker)).not.toContain('job ran')
    expect(t.logs.some((line) => line.includes('startup failed'))).toBe(false)
  })
})

test('startup gate bounds hook bytes by UTF-8 body size', () => {
  const delivered: number[] = []
  const logs: string[] = []
  const gate = createStartupGate((line) => logs.push(line))
  const firstPayload = { n: 1, text: '💩'.repeat(STARTUP_HOOK_BYTES / 4 - 5) + 'a' }
  const secondPayload = { n: 2 }
  const firstBytes = Buffer.byteLength(JSON.stringify(firstPayload))
  const secondBytes = Buffer.byteLength(JSON.stringify(secondPayload))
  expect(firstBytes).toBeLessThanOrEqual(STARTUP_HOOK_BYTES)
  expect(firstBytes + secondBytes).toBeGreaterThan(STARTUP_HOOK_BYTES)
  gate.hook({
    type: 'hook.received', agent: 'claude', sessionId: 's_1', payload: firstPayload
  }, firstBytes, () => delivered.push(1))
  gate.hook({
    type: 'hook.received', agent: 'claude', sessionId: 's_1', payload: secondPayload
  }, secondBytes, () => delivered.push(2))
  gate.open()
  expect(delivered).toEqual([1])
  expect(logs).toEqual(['dropped 1 agent hook that arrived during startup'])
})

test('startup gate opens hooks before FIFO RPC and skips closed connections', async () => {
  const delivered: string[] = []
  const gate = createStartupGate(() => {})
  const conn = { closed: false } as ClientConn
  const closed = { closed: false } as ClientConn
  const rpc = gate.rpc(async (_conn, text) => { delivered.push(text) })
  const first = rpc(conn, 'first')
  const gone = rpc(closed, 'closed')
  const second = rpc(conn, 'second')
  closed.closed = true
  for (const n of [1, 2]) gate.hook({
    type: 'hook.received', agent: 'claude', sessionId: 's_1', payload: { n }
  }, 1, () => delivered.push(`hook ${n}`))
  expect(delivered).toEqual([])
  gate.open()
  gate.open()
  await Promise.all([first, gone, second])
  expect(delivered).toEqual(['hook 1', 'hook 2', 'first', 'second'])
  expect(gate.isOpen).toBe(true)
  gate.hook({
    type: 'hook.received', agent: 'claude', sessionId: 's_1', payload: { n: 3 }
  }, 1, () => delivered.push('hook 3'))
  await rpc(conn, 'after')
  expect(delivered.slice(-2)).toEqual(['hook 3', 'after'])
})

test('SIGTERM during startup exits cleanly and removes the published runtime', async () => {
  const { home, scope } = scopedHome()
  const builtinDir = join(home, 'empty-builtins')
  mkdirSync(builtinDir)
  const marker = join(home, 'activation.log')
  const release = join(home, 'release')
  writeModulePlugin(join(home, 'plugins'), marker, { id: 'acme.slow', activation: 'startup' }, {
    activate: waitForFile(release)
  })
  const proc = scope.spawn([process.execPath, MAIN], {
    env: {
      ...process.env, HOME: home, QUIRKY_HOME: home, QUIRKY_PORT: '0',
      QUIRKY_BUILTIN_PLUGINS_DIR: builtinDir, QUIRKY_UI_DIR: join(home, 'no-ui'),
      QUIRKY_PTY_HOST_ENTRY: FAKE_HOST_MAIN, SHELL: '/bin/sh'
    },
    stdout: 'ignore', stderr: 'pipe'
  })
  cleanups.push(() => writeFileSync(release, ''))
  await waitFor(() => readMarker(marker).includes('activate acme.slow'), 5000)
  expect(readRuntime(home)?.pid).toBe(proc.pid)
  const signaledAt = performance.now()
  proc.kill('SIGTERM')
  writeFileSync(release, '')
  expect(await proc.exited).toBe(0)
  expect(performance.now() - signaledAt).toBeLessThan(8000)
  expect(readRuntime(home)).toBeNull()
}, 10_000)

test('a timed-out startup shutdown revokes contexts before their store closes', async () => {
  const t = blockedStartup({ stopTimeoutMs: 10, probeAfterRelease: true })
  await t.blocked()
  const handle = await t.ready()
  await handle.stop()
  expect(readRuntime(t.home)).toBeNull()
  expect(t.logs).toContain('plugins did not stop within 10 ms; continuing shutdown')
  t.unblock()
  await t.starting
  expect(readMarker(t.marker)).toContain('context rejected: acme.slow is no longer active')
  expect(readMarker(t.marker)).not.toContain('context remained usable')
})
