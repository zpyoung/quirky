import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { writeStatuslineRunner } from '../src/statusline-runner'

type HookCall = { path: string; token: string | null; body: Buffer }
type StubServer = { port: number | undefined; stop(force?: boolean): void }

type Fixture = {
  root: string
  home: string
  dataDir: string
  token: string
  calls: HookCall[]
  env: NodeJS.ProcessEnv
}

const fixtures: Fixture[] = []
const servers = new Set<StubServer>()
const runningGroups = new Set<number>()
const childPids = new Set<number>()

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function startServer(calls: HookCall[]): StubServer {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      calls.push({
        path: new URL(request.url).pathname + new URL(request.url).search,
        token: request.headers.get('x-quirky-hook-token'),
        body: Buffer.from(await request.arrayBuffer())
      })
      return Response.json({ ok: true })
    }
  })
  servers.add(server)
  return server
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "quirky'statusline-"))
  const home = join(root, 'isolated-home')
  const dataDir = join(root, 'plugin data')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const calls: HookCall[] = []
  const server = startServer(calls)
  const token = 'local-hook-token-for-statusline'
  const port = server.port
  if (port === undefined) throw new Error('statusline test server did not bind to a port')
  const hookUrl = `http://127.0.0.1:${port}/hook`
  writeRuntime(home, port)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    QUIRKY_HOME: home,
    QUIRKY_HOOK_URL: hookUrl,
    QUIRKY_HOOK_TOKEN: token,
    QUIRKY_SESSION_ID: 'quirky-session-1'
  }
  delete env.CLAUDE_JOB_DIR
  delete env.QUIRKY_SESSION_INFO_STATUSLINE_RECURSION
  const fixture = { root, home, dataDir, token, calls, env }
  fixtures.push(fixture)
  return fixture
}

function writeRuntime(home: string, port: number): void {
  writeFileSync(join(home, 'runtime.json'), JSON.stringify({ pid: process.pid, port }), { mode: 0o600 })
  chmodSync(join(home, 'runtime.json'), 0o600)
}

async function invoke(command: string, input: Buffer | string, env: NodeJS.ProcessEnv): Promise<{
  code: number | null
  stdout: Buffer
  stderr: Buffer
}> {
  const child = spawn('/bin/sh', ['-c', command], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  if (child.pid !== undefined) runningGroups.add(child.pid)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)))
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stderr: Buffer }>()
  const timeout = setTimeout(() => {
    if (child.pid !== undefined) killGroup(child.pid)
    reject(new Error('statusline runner process did not exit'))
  }, 10_000)
  child.once('error', (error) => {
    clearTimeout(timeout)
    reject(error)
  })
  child.once('close', (code) => {
    clearTimeout(timeout)
    if (child.pid !== undefined) runningGroups.delete(child.pid)
    resolve({ code, stderr: Buffer.concat(stderr) })
  })
  child.stdin?.end(input)
  const result = await promise
  return { code: result.code, stdout: Buffer.concat(stdout), stderr: result.stderr }
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The group has already exited.
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitUntilGone(pid: number): Promise<boolean> {
  // This integration check waits for the OS to reap the real child killed by the watchdog.
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await Bun.sleep(25)
  }
  return !processExists(pid)
}

afterEach(() => {
  for (const fixture of fixtures) {
    const pidFile = join(fixture.root, 'child.pids')
    if (!existsSync(pidFile)) continue
    const [groupText, childText] = readFileSync(pidFile, 'utf8').trim().split(/\s+/)
    const group = Number(groupText)
    const child = Number(childText)
    if (Number.isInteger(group) && group > 0) runningGroups.add(group)
    if (Number.isInteger(child) && child > 0) childPids.add(child)
  }
  for (const pid of childPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The child has already exited.
    }
  }
  childPids.clear()
  for (const pid of runningGroups) killGroup(pid)
  runningGroups.clear()
  for (const server of servers) server.stop(true)
  servers.clear()
  for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true })
})

test('creates absolute runner and config assets with private permissions', () => {
  const fixture = makeFixture()
  const command = writeStatuslineRunner(fixture.dataDir, null)
  const assetDir = join(fixture.dataDir, 'statusline-runner')
  const runner = join(assetDir, 'runner.cjs')
  const configName = readdirSync(assetDir).find((name) => name.startsWith('config-')) ?? 'missing-config.json'
  const config = join(assetDir, configName)

  expect(command).toContain(shellQuote(runner))
  expect(command).toContain(shellQuote(config))
  expect(isAbsolute(runner)).toBe(true)
  expect(statSync(assetDir).mode & 0o777).toBe(0o700)
  expect(statSync(runner).mode & 0o777).toBe(0o700)
  expect(statSync(config).mode & 0o777).toBe(0o600)
})

test('forwards byte-identical stdin once and only successful custom stdout', async () => {
  const fixture = makeFixture()
  const captured = join(fixture.root, 'stdin.bin')
  const invoked = join(fixture.root, 'invoked.txt')
  const input = Buffer.from('{"session_id":"provider-1","context_window":{"used_percentage":31}}  \n')
  const customCommand = `printf x >> ${shellQuote(invoked)}; cat > ${shellQuote(captured)}; printf 'visible status\\n'; printf 'diagnostic\\n' >&2`
  const chained = writeStatuslineRunner(fixture.dataDir, customCommand)

  const result = await invoke(chained, input, fixture.env)

  expect(result.code).toBe(0)
  expect(readFileSync(captured)).toEqual(input)
  expect(readFileSync(invoked, 'utf8')).toBe('x')
  expect(result.stdout).toEqual(Buffer.from('visible status\n'))
  expect(result.stderr).toEqual(Buffer.alloc(0))
  expect(fixture.calls).toHaveLength(1)
  expect(fixture.calls[0]?.body).toEqual(input)
})

test('suppresses all custom output when the consented command fails', async () => {
  const fixture = makeFixture()
  const command = writeStatuslineRunner(fixture.dataDir, "printf 'stdout leak'; printf 'stderr leak' >&2; exit 7")
  const result = await invoke(command, '{"session_id":"provider-1"}', fixture.env)

  expect(result.code).toBe(0)
  expect(result.stdout).toEqual(Buffer.alloc(0))
  expect(result.stderr).toEqual(Buffer.alloc(0))
})

test('runs the custom statusline but skips telemetry for Claude job sessions', async () => {
  const fixture = makeFixture()
  const captured = join(fixture.root, 'job-input.json')
  const command = writeStatuslineRunner(fixture.dataDir, `cat > ${shellQuote(captured)}; printf 'job display'`)
  fixture.env.CLAUDE_JOB_DIR = join(fixture.root, 'job')
  const input = Buffer.from('{"session_id":"provider-job","context_window":{"used_percentage":52}}\n')

  const result = await invoke(command, input, fixture.env)

  expect(result.stdout).toEqual(Buffer.from('job display'))
  expect(readFileSync(captured)).toEqual(input)
  expect(fixture.calls).toHaveLength(0)
})

test('posts context-only statusline payloads without telemetry stdout', async () => {
  const fixture = makeFixture()
  const command = writeStatuslineRunner(fixture.dataDir, null)
  const input = Buffer.from('{"session_id":"provider-context","context_window":{"used_percentage":81,"remaining_percentage":19,"context_window_size":200000}}\n')

  const result = await invoke(command, input, fixture.env)

  expect(result.code).toBe(0)
  expect(result.stdout).toEqual(Buffer.alloc(0))
  expect(result.stderr).toEqual(Buffer.alloc(0))
  expect(fixture.calls).toHaveLength(1)
  expect(fixture.calls[0]).toEqual({
    path: '/hook/session-info-claude?session=quirky-session-1',
    token: fixture.token,
    body: input
  })
})

test('throttles a session for 15 elapsed seconds and posts again afterward', async () => {
  const fixture = makeFixture()
  const command = writeStatuslineRunner(fixture.dataDir, null)
  const first = Buffer.from('{"session_id":"provider-1","context_window":{"used_percentage":40}}')

  await invoke(command, first, fixture.env)
  await invoke(command, Buffer.from('{"session_id":"provider-1","context_window":{"used_percentage":41}}'), fixture.env)
  expect(fixture.calls).toHaveLength(1)

  // The runner is a subprocess, so fake timers cannot advance its shared filesystem timestamp.
  await Bun.sleep(14_000)
  await invoke(command, Buffer.from('{"session_id":"provider-1","context_window":{"used_percentage":42}}'), fixture.env)
  expect(fixture.calls).toHaveLength(1)

  await Bun.sleep(1_050)
  await invoke(command, Buffer.from('{"session_id":"provider-1","context_window":{"used_percentage":43}}'), fixture.env)
  expect(fixture.calls).toHaveLength(2)
}, 20_000)

test('re-reads runtime.json after a daemon restart instead of using the old hook port', async () => {
  const fixture = makeFixture()
  const restartedCalls: HookCall[] = []
  const restartedServer = startServer(restartedCalls)
  const command = writeStatuslineRunner(fixture.dataDir, null)
  const input = Buffer.from('{"session_id":"provider-1","context_window":{"used_percentage":25}}')

  await invoke(command, input, fixture.env)
  const restartedPort = restartedServer.port
  if (restartedPort === undefined) throw new Error('restarted statusline test server did not bind to a port')
  writeRuntime(fixture.home, restartedPort)
  fixture.env.QUIRKY_SESSION_ID = 'quirky-session-after-restart'
  await invoke(command, input, fixture.env)

  expect(fixture.calls).toHaveLength(1)
  expect(restartedCalls).toHaveLength(1)
  expect(restartedCalls[0]?.path).toBe('/hook/session-info-claude?session=quirky-session-after-restart')
})

test('prevents a consented command from recursively invoking itself', async () => {
  const fixture = makeFixture()
  const recursiveCommand = writeStatuslineRunner(fixture.dataDir, null)
  const marker = join(fixture.root, 'recursive-command.txt')
  const command = writeStatuslineRunner(fixture.dataDir, `printf x >> ${shellQuote(marker)}; ${recursiveCommand}`)

  const result = await invoke(command, '{"session_id":"provider-1"}', fixture.env)

  expect(result.code).toBe(0)
  expect(result.stdout).toEqual(Buffer.alloc(0))
  expect(readFileSync(marker, 'utf8')).toBe('x')
  expect(fixture.calls).toHaveLength(1)
})

test('watchdog kills the custom command process group and its background child', async () => {
  const fixture = makeFixture()
  const pidFile = join(fixture.root, 'child.pids')
  const customCommand = `echo $$ > ${shellQuote(pidFile)}; (trap '' TERM; sleep 30) >/dev/null 2>&1 & echo $! >> ${shellQuote(pidFile)}; wait`
  const command = writeStatuslineRunner(fixture.dataDir, customCommand, { watchdogMs: 150 })

  const result = await invoke(command, '{"session_id":"provider-1"}', fixture.env)
  const [groupText, childText] = readFileSync(pidFile, 'utf8').trim().split(/\s+/)
  const groupPid = Number(groupText)
  const childPid = Number(childText)

  expect(result.code).toBe(0)
  expect(result.stdout).toEqual(Buffer.alloc(0))
  expect(Number.isInteger(groupPid)).toBe(true)
  expect(Number.isInteger(childPid)).toBe(true)
  expect(await waitUntilGone(childPid)).toBe(true)
  expect(await waitUntilGone(groupPid)).toBe(true)

})
