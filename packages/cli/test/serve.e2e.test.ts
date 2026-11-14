import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readRuntime } from '@quirky/protocol/node'
import { acquireDaemonLock } from '../../daemon/src/lock'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'

const CLI = join(import.meta.dir, '..', 'src', 'main.ts')
const DAEMON = join(import.meta.dir, '../../daemon/src/main.ts')
const FAKE_PTY_HOST = join(import.meta.dir, '../../daemon/test/fixtures/fake-pty-host.ts')
const scopes: ProcessScope[] = []

type Ready = {
  event: 'ready'
  pid: number
  servePid: number
  port: number
  ptyHostPid: number | null
}

type Stopped = {
  event: 'stopped'
  reason: string
  signal: string | null
  pid: number
  daemonExitCode: number | null
  daemonSignal: string | null
  killed: boolean
}

type LineOutput = {
  lines: string[]
  next(deadline: number, label: string): Promise<string | null>
  drain(timeoutMs: number, label: string): Promise<string[]>
}

type RunningProcess = {
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  stdout: LineOutput
  stderr: Promise<string>
}

function fixture() {
  const scope = createProcessScope()
  scopes.push(scope)
  const home = scope.home
  const env = {
    ...process.env,
    HOME: home,
    QUIRKY_HOME: home,
    QUIRKY_PORT: '0',
    QUIRKY_UI_DIR: join(home, 'no-ui'),
    QUIRKY_BUILTIN_PLUGINS_DIR: join(home, 'no-builtins'),
    QUIRKY_PTY_HOST_ENTRY: FAKE_PTY_HOST,
    QUIRKY_DAEMON_ENTRY: DAEMON
  } as Record<string, string>
  return { scope, home, env }
}

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await scope.cleanup()
})

// These real-process deadlines use the platform clock because fake timers cannot observe child I/O.
function lineReader(stream: ReadableStream<Uint8Array>): LineOutput {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const lines: string[] = []
  let buffered = ''
  let ended = false

  const next = async (deadline: number, label: string): Promise<string | null> => {
    while (true) {
      const newline = buffered.indexOf('\n')
      if (newline >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        lines.push(line)
        return line
      }
      if (ended) {
        if (!buffered) return null
        const line = buffered
        buffered = ''
        lines.push(line)
        return line
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`${label} did not write a line before its deadline`)
      const { promise: timeout, reject } = Promise.withResolvers<never>()
      const timer = setTimeout(() => reject(new Error(`${label} did not write a line before its deadline`)), remaining)
      try {
        const result = await Promise.race([reader.read(), timeout])
        if (result.done) {
          ended = true
          buffered += decoder.decode()
        } else {
          buffered += decoder.decode(result.value, { stream: true })
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }

  return {
    lines,
    next,
    async drain(timeoutMs: number, label: string): Promise<string[]> {
      const deadline = Date.now() + timeoutMs
      while (await next(deadline, label) !== null) {}
      return lines
    }
  }
}

function startEntry(scope: ProcessScope, env: Record<string, string>, entry: string, args: string[]): RunningProcess {
  const child = scope.spawn([process.execPath, entry, ...args], {
    cwd: scope.home,
    env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return {
    child,
    stdout: lineReader(child.stdout),
    stderr: new Response(child.stderr).text()
  }
}

function startProcess(scope: ProcessScope, env: Record<string, string>, args: string[]): RunningProcess {
  return startEntry(scope, env, CLI, args)
}


async function line(output: LineOutput, timeoutMs: number, label: string): Promise<string> {
  const value = await output.next(Date.now() + timeoutMs, label)
  if (value === null) throw new Error(`${label} exited before writing a line`)
  return value
}

async function exited(child: { exited: Promise<number> }, timeoutMs: number, label: string): Promise<number> {
  const { promise: timeout, reject } = Promise.withResolvers<never>()
  const timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMs} ms`)), timeoutMs)
  try {
    return await Promise.race([child.exited, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function parseLine(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  expect(value).not.toBeNull()
  expect(typeof value).toBe('object')
  expect(Array.isArray(value)).toBe(false)
  return value as Record<string, unknown>
}

function readyRecord(text: string): Ready {
  const value = parseLine(text)
  expect(value.event).toBe('ready')
  expect(typeof value.pid).toBe('number')
  expect(typeof value.servePid).toBe('number')
  expect(typeof value.port).toBe('number')
  return value as unknown as Ready
}

function stoppedRecord(text: string): Stopped {
  const value = parseLine(text)
  expect(value.event).toBe('stopped')
  return value as unknown as Stopped
}

function trackReady(scope: ProcessScope, ready: Ready): void {
  scope.track(ready.pid)
  if (typeof ready.ptyHostPid === 'number') scope.track(ready.ptyHostPid)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} was still alive after ${timeoutMs} ms`)
    await Bun.sleep(25)
  }
}

async function freePort(): Promise<number> {
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = listener.port!
  await listener.stop(true)
  return port
}

function assertAlreadyRunning(text: string, pid: number, home: string): void {
  const error = parseLine(text).error as Record<string, unknown>
  expect(error.code).toBe('conflict')
  expect(error.reason).toBe('already-running')
  expect(error.data).toMatchObject({ reason: 'already-running', pid, home })
}

async function stopCleanly(
  running: RunningProcess,
  ready: Ready,
  signal: 'SIGTERM' = 'SIGTERM'
): Promise<void> {
  running.child.kill(signal)
  const stopped = stoppedRecord(await line(running.stdout, 15_000, 'serve stop record'))
  expect(await exited(running.child, 15_000, 'serve')).toBe(0)
  await running.stdout.drain(1_000, 'serve stdout EOF')
  expect(stopped).toMatchObject({
    reason: 'signal', signal, pid: ready.pid, daemonExitCode: 0, daemonSignal: null, killed: false
  })
  expect(running.stdout.lines).toHaveLength(2)
}

test('serve owns the real daemon, applies --port, excludes credentials, and refuses a second owner', async () => {
  const { scope, home, env } = fixture()
  const port = await freePort()
  const running = startProcess(scope, env, ['serve', '--port', String(port), '--json'])
  const readyLine = await line(running.stdout, 15_000, 'serve readiness')
  const ready = readyRecord(readyLine)
  trackReady(scope, ready)
  const runtime = readRuntime(home)
  expect(runtime).toBeDefined()
  expect(ready).toMatchObject({ pid: runtime!.pid, servePid: running.child.pid, port, event: 'ready' })
  expect(ready.port).toBe(runtime!.port)
  expect(readyLine).not.toContain(runtime!.token)
  expect(readyLine).not.toContain(runtime!.hookToken)

  const status = startProcess(scope, env, ['status', '--json'])
  const statusLine = await line(status.stdout, 15_000, 'status response')
  expect(await exited(status.child, 15_000, 'status')).toBe(0)
  await status.stdout.drain(1_000, 'status stdout EOF')
  await status.stderr
  expect(status.stdout.lines).toHaveLength(1)
  expect(parseLine(statusLine)).toMatchObject({ pid: ready.pid, home })

  const refused = startProcess(scope, env, ['serve', '--json'])
  assertAlreadyRunning(await line(refused.stdout, 15_000, 'already-running refusal'), ready.pid, home)
  expect(await exited(refused.child, 15_000, 'second serve')).toBe(1)
  await refused.stdout.drain(1_000, 'refusal stdout EOF')
  await refused.stderr
  expect(refused.stdout.lines).toHaveLength(1)
  const statusAfterRefusal = startProcess(scope, env, ['status', '--json'])
  const statusAfterRefusalLine = await line(statusAfterRefusal.stdout, 15_000, 'status after refusal')
  expect(await exited(statusAfterRefusal.child, 15_000, 'status after refusal')).toBe(0)
  await statusAfterRefusal.stdout.drain(1_000, 'status after refusal stdout EOF')
  await statusAfterRefusal.stderr
  expect(statusAfterRefusal.stdout.lines).toHaveLength(1)
  expect(parseLine(statusAfterRefusalLine)).toMatchObject({ pid: ready.pid, home })
  expect(readRuntime(home)?.pid).toBe(ready.pid)

  await stopCleanly(running, ready)
  expect(readRuntime(home)).toBeFalsy()
  expect(existsSync(join(home, 'runtime.json'))).toBe(false)
  expect(existsSync(join(home, 'daemon.lock'))).toBe(false)
  await waitForProcessExit(ready.pid, 5_000)
  await running.stderr
}, 30_000)

test('simultaneous serve starts refuse the loser with the winner pid', async () => {
  const { scope, home, env } = fixture()
  const first = startProcess(scope, env, ['serve', '--json'])
  const second = startProcess(scope, env, ['serve', '--json'])
  const [firstLine, secondLine] = await Promise.all([
    line(first.stdout, 20_000, 'first concurrent serve'),
    line(second.stdout, 20_000, 'second concurrent serve')
  ])
  const records = [parseLine(firstLine), parseLine(secondLine)]
  const readyIndex = records.findIndex((record) => record.event === 'ready')
  expect(records.filter((record) => record.event === 'ready')).toHaveLength(1)
  expect(readyIndex).not.toBe(-1)
  const winner = readyIndex === 0 ? first : second
  const loser = readyIndex === 0 ? second : first
  const ready = readyRecord(readyIndex === 0 ? firstLine : secondLine)
  trackReady(scope, ready)
  const runtime = readRuntime(home)
  expect(runtime).toBeDefined()
  expect(ready).toMatchObject({ pid: runtime!.pid, servePid: winner.child.pid })
  expect(ready.port).toBeGreaterThan(0)
  expect(ready.port).toBe(runtime!.port)

  assertAlreadyRunning(readyIndex === 0 ? secondLine : firstLine, ready.pid, home)
  expect(await exited(loser.child, 20_000, 'losing serve')).toBe(1)
  await loser.stdout.drain(1_000, 'loser stdout EOF')
  await loser.stderr
  expect(loser.stdout.lines).toHaveLength(1)

  await stopCleanly(winner, ready)
  expect(readRuntime(home)).toBeFalsy()
  await waitForProcessExit(ready.pid, 5_000)
  await winner.stderr
}, 40_000)

test('serve SIGKILL makes its daemon exit, releases the lock, and permits restart', async () => {
  const { scope, home, env } = fixture()
  const first = startProcess(scope, env, ['serve', '--json'])
  const firstReady = readyRecord(await line(first.stdout, 15_000, 'first serve readiness'))
  trackReady(scope, firstReady)

  first.child.kill('SIGKILL')
  await exited(first.child, 5_000, 'SIGKILLed serve')
  await waitForProcessExit(firstReady.pid, 10_000)
  expect(readRuntime(home)).toBeFalsy()
  expect(existsSync(join(home, 'runtime.json'))).toBe(false)
  const lock = await acquireDaemonLock(home)
  expect(lock).not.toBeNull()
  lock?.release()

  const second = startProcess(scope, env, ['serve', '--json'])
  const secondReady = readyRecord(await line(second.stdout, 15_000, 'restarted serve readiness'))
  trackReady(scope, secondReady)
  expect(secondReady.pid).not.toBe(firstReady.pid)
  await stopCleanly(second, secondReady)
  expect(readRuntime(home)).toBeFalsy()
  await waitForProcessExit(secondReady.pid, 5_000)
  await first.stdout.drain(1_000, 'killed serve stdout EOF')
  await first.stderr
  await second.stderr
}, 40_000)

test('killing serve parent wrapper triggers graceful daemon shutdown', async () => {
  const { scope, home, env } = fixture()
  const wrapperScript = `
    const child = Bun.spawn([process.execPath, ${JSON.stringify(CLI)}, 'serve', '--json'], {
      cwd: ${JSON.stringify(home)}, env: process.env, stdout: 'inherit', stderr: 'inherit'
    })
    console.log(JSON.stringify({ servePid: child.pid }))
    await child.exited
  `
  const wrapper = scope.spawn([process.execPath, '-e', wrapperScript], {
    cwd: home,
    env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const output = lineReader(wrapper.stdout)
  const wrapperError = new Response(wrapper.stderr).text()
  const servePidLine = parseLine(await line(output, 15_000, 'wrapper serve pid'))
  const servePid = servePidLine.servePid as number
  expect(typeof servePid).toBe('number')
  scope.track(servePid)
  const readyLine = await line(output, 15_000, 'wrapped serve readiness')
  const ready = readyRecord(readyLine)
  trackReady(scope, ready)
  expect(ready.servePid).toBe(servePid)

  wrapper.kill('SIGKILL')
  await exited(wrapper, 5_000, 'SIGKILLed wrapper')
  const stopped = stoppedRecord(await line(output, 15_000, 'parent-exited stop record'))
  expect(stopped).toMatchObject({
    reason: 'parent-exited', signal: null, pid: ready.pid, daemonExitCode: 0, daemonSignal: null, killed: false
  })
  await waitForProcessExit(servePid, 15_000)
  await waitForProcessExit(ready.pid, 15_000)
  await output.drain(1_000, 'wrapped serve stdout EOF')
  await wrapperError
  expect(readRuntime(home)).toBeFalsy()
}, 40_000)

test('a malformed exit-with-parent flag fails startup without creating a runtime or lock', async () => {
  const { scope, home, env } = fixture()
  const daemon = startEntry(scope, env, DAEMON, ['--exit-with-parent=not-a-pid'])
  expect(await exited(daemon.child, 10_000, 'malformed-parent daemon')).toBe(1)
  await daemon.stdout.drain(1_000, 'malformed-parent stdout EOF')
  const output = `${daemon.stdout.lines.join('\n')}\n${await daemon.stderr}`
  expect(output).toContain('[quirkyd] startup failed:')
  expect(readRuntime(home)).toBeFalsy()
  expect(existsSync(join(home, 'runtime.json'))).toBe(false)
  expect(existsSync(join(home, 'daemon.lock'))).toBe(false)
}, 15_000)

test('an already-lost exit-with-parent pid exits before creating a runtime or lock', async () => {
  const { scope, home, env } = fixture()
  const daemon = startEntry(scope, env, DAEMON, ['--exit-with-parent=2147483647'])
  expect(await exited(daemon.child, 10_000, 'lost-parent daemon')).toBe(0)
  await daemon.stdout.drain(1_000, 'lost-parent stdout EOF')
  const output = `${daemon.stdout.lines.join('\n')}\n${await daemon.stderr}`
  expect(output).toContain('[quirkyd] the process that started this daemon has exited; exiting')
  expect(readRuntime(home)).toBeFalsy()
  expect(existsSync(join(home, 'runtime.json'))).toBe(false)
  expect(existsSync(join(home, 'daemon.lock'))).toBe(false)
}, 15_000)
