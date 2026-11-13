import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuirkyClient, RpcErrorCode } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { runCommand } from '../executor'
import { createProcessRunner, type OwnedProcessRunner, type ProcessSpawner } from '../../../packages/process/src/api'
import { builtinsDir, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'

type CheckResult = {
  checkId: string
  ran: boolean
  pass: boolean
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdoutTail: string
  stderrTail: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
  error?: string
}

type RpcError = Error & { code?: number; data?: unknown }

let harness: Harness | undefined
let tempRoot: string | undefined
let savedEnv: Map<string, string | undefined> | undefined
let daemonStopped = false
let checkRunner: OwnedProcessRunner | undefined
const trackedPids = new Set<number>()
const ISOLATED_ENV_KEYS = ['HOME', 'QUIRKY_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_HOME', 'OPENAI_HOME']

function isolateEnvironment(): void {
  savedEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]))
  tempRoot = join(tmpdir(), `quirky-checks-${process.pid}-${randomUUID()}`)
  mkdirSync(tempRoot, { recursive: true })
  process.env.HOME = tempRoot
  process.env.QUIRKY_HOME = join(tempRoot, '.quirky')
  for (const key of ISOLATED_ENV_KEYS.slice(2)) delete process.env[key]
}

async function start(): Promise<{ h: Harness; client: QuirkyClient; home: string }> {
  isolateEnvironment()
  const home = process.env.QUIRKY_HOME!
  harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  daemonStopped = false
  return { h: harness, client: await harness.connect(), home: tempRoot! }
}

async function clientAs(identity: { cwd?: string; worktreeId?: string }): Promise<QuirkyClient> {
  if (!harness) throw new Error('checks harness is not running')
  const client = await QuirkyClient.connect(rpcUrl(harness.runtime), { role: 'cli', ...identity })
  harness.clients.push(client)
  return client
}

function call<T = unknown>(client: QuirkyClient, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return client.callAny(method, params) as Promise<T>
}

async function rejected<T>(promise: Promise<T>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected RPC call to fail')
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function nodeCommand(source: string): string {
  return `${quoteShell(process.execPath)} -e ${quoteShell(source)}`
}

async function pidAt(path: string): Promise<number> {
  const pid = await waitFor(() => {
    if (!existsSync(path)) return undefined
    const value = Number(readFileSync(path, 'utf8'))
    return Number.isInteger(value) && value > 0 ? value : undefined
  }, 5000)
  trackedPids.add(pid)
  return pid
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  await waitFor(() => processExists(pid) ? undefined : true, 3000)
}

function cleanupEnvironment(): void {
  for (const [key, value] of savedEnv ?? []) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv = undefined
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = undefined
}

afterEach(async () => {
  try {
    await checkRunner?.dispose()
    if (harness) {
      if (daemonStopped) {
        for (const client of harness.clients) client.close()
        harness.pty.stop()
      } else {
        await harness.cleanup()
      }
    }
  } finally {
    checkRunner = undefined
    harness = undefined
    for (const pid of trackedPids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* the process has already exited */ }
    }
    trackedPids.clear()
    cleanupEnvironment()
  }
})

describe('quirky.checks daemon API', () => {
  test('runs in an explicit cwd and captures stdout and stderr', async () => {
    const { client, home } = await start()
    const workspace = join(home, 'explicit-workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'marker'), 'workspace-A\n')

    const result = await call<CheckResult>(client, 'quirky.checks/run', {
      command: 'printf "out:"; cat marker; printf "err:" >&2; cat marker >&2',
      cwd: workspace
    })
    expect(result).toMatchObject({
      ran: true,
      pass: true,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdoutTail: 'out:workspace-A\n',
      stderrTail: 'err:workspace-A\n',
      stdoutTruncated: false,
      stderrTruncated: false
    })
    expect(result.checkId).toBeTruthy()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(await call<unknown[]>(client, 'quirky.session/list', {})).toEqual([])
  })

  test('preserves exact short output for a nonzero exit', async () => {
    const { client, home } = await start()
    const result = await call<CheckResult>(client, 'quirky.checks/run', {
      command: 'printf "exact stdout\\n"; printf "exact stderr\\n" >&2; exit 7',
      cwd: home
    })
    expect(result).toMatchObject({
      ran: true,
      pass: false,
      exitCode: 7,
      stdoutTail: 'exact stdout\n',
      stderrTail: 'exact stderr\n',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false
    })
  })

  test('resolves explicit worktree selectors and the caller current worktree', async () => {
    const { client, home } = await start()
    const workspace = join(home, 'folder-worktree')
    mkdirSync(workspace)
    await call(client, 'quirky.repo/add', { path: workspace, folder: true })
    const worktree = await call<{ id: string; path: string }>(client, 'quirky.worktree/resolve', {
      selector: 'current',
      cwd: workspace
    })
    const caller = await clientAs({ cwd: workspace, worktreeId: worktree.id })

    const current = await call<CheckResult>(caller, 'quirky.checks/run', { command: 'pwd' })
    const selected = await call<CheckResult>(caller, 'quirky.checks/run', {
      command: 'pwd',
      worktree: `id:${worktree.id}`
    })
    expect(current.stdoutTail.trim()).toBe(worktree.path)
    expect(selected.stdoutTail.trim()).toBe(worktree.path)

    const badSelector = await rejected(call(caller, 'quirky.checks/run', {
      command: 'pwd',
      cwd: workspace,
      worktree: `id:${worktree.id}`
    }))
    expect(badSelector.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('rejects missing, relative, and non-directory cwd values before command execution', async () => {
    const { client, home } = await start()
    const marker = join(home, 'should-not-run')
    const command = `touch ${quoteShell(marker)}`
    const file = join(home, 'not-a-directory')
    writeFileSync(file, 'file')

    for (const cwd of [join(home, 'missing'), file, 'relative/path']) {
      const error = await rejected(call(client, 'quirky.checks/run', { command, cwd }))
      expect(error.code === RpcErrorCode.InvalidParams || error.code === RpcErrorCode.NotFound).toBe(true)
    }
    expect(existsSync(marker)).toBe(false)
  })

  test('rejects invalid timeout values without running the command', async () => {
    const { client, home } = await start()
    const marker = join(home, 'invalid-timeout-ran')
    const error = await rejected(call(client, 'quirky.checks/run', {
      command: `touch ${quoteShell(marker)}`,
      cwd: home,
      timeoutSeconds: 0
    }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(existsSync(marker)).toBe(false)
  })

  test('rejects a blank command before spawning it', async () => {
    const { client, home } = await start()
    const error = await rejected(call(client, 'quirky.checks/run', { command: ' \t ', cwd: home }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('decodes UTF-8 split across byte writes without corrupting either stream', async () => {
    const { client, home } = await start()
    const source = [
      `const out=Buffer.from('A😀B'); const err=Buffer.from('X☃Y'); let i=0;`,
      `const timer=setInterval(()=>{process.stdout.write(out.subarray(i,i+1));process.stderr.write(err.subarray(i,i+1));if(++i>=Math.max(out.length,err.length))clearInterval(timer)},10);`
    ].join('')
    const result = await call<CheckResult>(client, 'quirky.checks/run', {
      command: nodeCommand(source),
      cwd: home
    })
    expect(result).toMatchObject({
      pass: true,
      stdoutTail: 'A😀B',
      stderrTail: 'X☃Y',
      stdoutTruncated: false,
      stderrTruncated: false
    })
  })

  test('retains the last 4000 Unicode characters with independent truncation flags', async () => {
    const { client, home } = await start()
    const result = await call<CheckResult>(client, 'quirky.checks/run', {
      command: nodeCommand("process.stdout.write('🙂'.repeat(4001)+'尾');process.stderr.write('e'.repeat(4002))"),
      cwd: home
    })
    expect(result.stdoutTail).toBe('🙂'.repeat(3999) + '尾')
    expect(result.stderrTail).toBe('e'.repeat(4000))
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.pass).toBe(true)
  })

  test('returns false for unknown and completed IDs and permits completed-ID reuse', async () => {
    const { client, home } = await start()
    expect(await call<{ cancelled: boolean }>(client, 'quirky.checks/cancel', { checkId: 'unknown-check' })).toEqual({ cancelled: false })
    const first = await call<CheckResult>(client, 'quirky.checks/run', { command: 'true', cwd: home, checkId: 'reuse-me' })
    expect(first).toMatchObject({ pass: true, stdoutTail: '', stderrTail: '', stdoutTruncated: false, stderrTruncated: false })
    expect(await call<{ cancelled: boolean }>(client, 'quirky.checks/cancel', { checkId: 'reuse-me' })).toEqual({ cancelled: false })
    const second = await call<CheckResult>(client, 'quirky.checks/run', { command: 'true', cwd: home, checkId: 'reuse-me' })
    expect(second.pass).toBe(true)
  })

  test('refuses duplicate active IDs and cancels the active process group', async () => {
    const { client, home } = await start()
    const pidFile = join(home, 'cancelled-pid')
    const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const running = call<CheckResult>(client, 'quirky.checks/run', {
      command: nodeCommand(source),
      cwd: home,
      checkId: 'one-active-check'
    })
    const pid = await pidAt(pidFile)
    const duplicate = await rejected(call(client, 'quirky.checks/run', {
      command: 'true',
      cwd: home,
      checkId: 'one-active-check'
    }))
    expect(duplicate.code).toBe(RpcErrorCode.Conflict)

    expect(await call<{ cancelled: boolean }>(client, 'quirky.checks/cancel', { checkId: 'one-active-check' })).toEqual({ cancelled: true })
    const result = await running
    expect(result).toMatchObject({ ran: true, pass: false, aborted: true, timedOut: false })
    await expectProcessGone(pid)
  })

  test('cancels a descendant after the shell exits and kills its process group', async () => {
    const { client, home } = await start()
    const shellPidFile = join(home, 'exit-race-shell-pid')
    const pidFile = join(home, 'exit-race-pid')
    const source = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const running = call<CheckResult>(client, 'quirky.checks/run', {
      command: `echo $$ > ${quoteShell(shellPidFile)}; ${nodeCommand(source)} & while [ ! -e ${quoteShell(pidFile)} ]; do sleep 0.05; done; exit 0`,
      cwd: home,
      checkId: 'exit-race-check'
    })
    const shellPid = await pidAt(shellPidFile)
    const pid = await pidAt(pidFile)
    await expectProcessGone(shellPid)
    expect(await call<{ cancelled: boolean }>(client, 'quirky.checks/cancel', { checkId: 'exit-race-check' })).toEqual({ cancelled: true })
    const result = await running
    expect(result).toMatchObject({ ran: true, pass: false, aborted: true })
    await expectProcessGone(pid)
  })

  test('times out through pipe drainage and kills a TERM-ignoring descendant after two seconds', async () => {
    const { client, home } = await start()
    const pidFile = join(home, 'term-ignoring-pid')
    // The descendant must ignore a real SIGTERM and remain alive until the process-group KILL.
    const source = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const command = `${nodeCommand(source)} >/dev/null 2>&1 & wait`
    const result = await call<CheckResult>(client, 'quirky.checks/run', {
      command,
      cwd: home,
      timeoutSeconds: 1
    })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    trackedPids.add(pid)
    expect(result).toMatchObject({ ran: true, pass: false, timedOut: true, aborted: false })
    // Measure the platform-clock delay because fake timers cannot signal a real subprocess.
    expect(result.durationMs).toBeGreaterThanOrEqual(2700)
    await expectProcessGone(pid)
  })

  test('returns success when the shell exits and a descendant holds its pipes', async () => {
    const { client, home } = await start()
    const pidFile = join(home, 'held-pipe-pid')
    const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},10000)`
    const result = await call<CheckResult>(client, 'quirky.checks/run', {
      command: `${nodeCommand(source)} & while [ ! -e ${quoteShell(pidFile)} ]; do sleep 0.05; done; echo early; exit 0`,
      cwd: home,
      timeoutSeconds: 10
    })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    trackedPids.add(pid)
    expect(result).toMatchObject({
      ran: true,
      pass: true,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdoutTail: 'early\n'
    })
    expect(result.durationMs).toBeLessThan(5000)
    await expectProcessGone(pid)
  })

  test('shutdown aborts active checks and waits until their process groups are gone', async () => {
    const { client, home, h } = await start()
    const pidFile = join(home, 'shutdown-pid')
    const source = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    const runOutcome = call<CheckResult>(client, 'quirky.checks/run', {
      command: nodeCommand(source),
      cwd: home,
      checkId: 'shutdown-check'
    }).then((result) => ({ result }), (error: RpcError) => ({ error }))
    const pid = await pidAt(pidFile)

    const startedAt = Date.now()
    await h.daemon.stop()
    daemonStopped = true
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1800)
    await expectProcessGone(pid)
    const outcome = await runOutcome
    if ('result' in outcome) expect(outcome.result.aborted).toBe(true)
  })
})

type RecordedExit = {
  exitCode: number | null
  signal?: string | null
  stopped?: 'stop' | 'timeout' | 'aborted'
  spawnError?: { code: string; message: string }
  durationMs?: number
  groupSurvived?: true
}

type SpawnCall = { argv: readonly string[]; options: Record<string, unknown> }

type RecorderOptions = {
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  exit?: RecordedExit
  throwOnSpawn?: Error
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

function errorStream(chunk: Uint8Array, error: Error): ReadableStream<Uint8Array> {
  let delivered = false
  return new ReadableStream({
    pull(controller) {
      if (delivered) controller.error(error)
      else {
        delivered = true
        controller.enqueue(chunk)
      }
    }
  })
}

function createRecorder(config: RecorderOptions = {}): { spawner: ProcessSpawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const exit = config.exit ?? { exitCode: 0, signal: null, durationMs: 0 }
  const spawner = {
    spawn(argv: readonly string[], options: object) {
      calls.push({ argv, options: options as Record<string, unknown> })
      if (config.throwOnSpawn) throw config.throwOnSpawn
      return {
        pid: exit.spawnError ? null : 123,
        stdout: config.stdout ?? byteStream(),
        stderr: config.stderr ?? byteStream(),
        stderrTail: () => 'unused tail',
        exited: Promise.resolve(exit),
        stop: async () => exit
      }
    }
  } as unknown as ProcessSpawner
  return { spawner, calls }
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

describe('internal checks process executor', () => {
  test('starts the shell through the shared runner with bounded checks options', async () => {
    const signal = new AbortController().signal
    const recorder = createRecorder({ exit: { exitCode: 0, signal: null, durationMs: 12345 } })
    const result = await runCommand(recorder.spawner, {
      command: 'echo hi',
      cwd: '/w',
      timeoutSeconds: 7,
      signal
    })

    expect(recorder.calls).toEqual([{
      argv: ['/bin/sh', '-c', 'echo hi'],
      options: {
        cwd: '/w',
        timeoutMs: 7000,
        killGraceMs: 2000,
        stderr: 'pipe',
        groupGrace: true,
        signal
      }
    }])
    expect(result).toMatchObject({ ran: true, pass: true, exitCode: 0 })
    expect(result.durationMs).not.toBe(12345)
  })

  test('maps timeout, abort, and spawn error into failed check results', async () => {
    const timeout = createRecorder({ exit: { exitCode: null, signal: 'SIGKILL', stopped: 'timeout', durationMs: 42 } })
    expect(await runCommand(timeout.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })).toMatchObject({
      ran: true, pass: false, timedOut: true, aborted: false, exitCode: null
    })

    const aborted = createRecorder({ exit: { exitCode: 0, signal: null, stopped: 'aborted', durationMs: 42 } })
    expect(await runCommand(aborted.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })).toMatchObject({
      ran: true, pass: false, timedOut: false, aborted: true, exitCode: 0
    })

    const failedStart = createRecorder({ exit: { exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'missing' } } })
    expect(await runCommand(failedStart.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })).toMatchObject({
      ran: false, pass: false, exitCode: null, error: 'missing'
    })
  })

  test('retains only the last 4000 decoded Unicode code points from each stream', async () => {
    const recorder = createRecorder({
      stdout: byteStream(encoded('🙂'.repeat(4001) + '尾')),
      stderr: byteStream(encoded('e'.repeat(4002)))
    })
    const result = await runCommand(recorder.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })
    expect(result.stdoutTail).toBe('🙂'.repeat(3999) + '尾')
    expect(result.stderrTail).toBe('e'.repeat(4000))
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })

  test('decodes BOM and malformed UTF-8 from the raw streams with StringDecoder behavior', async () => {
    const recorder = createRecorder({
      stdout: byteStream(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62])),
      stderr: byteStream(Uint8Array.from([0xef, 0xbb, 0xbf, 0x65, 0xff]))
    })
    const result = await runCommand(recorder.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })
    expect(result).toMatchObject({ stdoutTail: '\ufeffa�b', stderrTail: '\ufeffe�', pass: true })
  })

  for (const streamName of ['stdout', 'stderr'] as const) {
    for (const failure of [
      Object.assign(new Error(`${streamName} stalled`), { name: 'ProcessStalledError' }),
      new Error('boom')
    ]) {
      test(`fails incomplete ${streamName} capture when it errors with ${failure.message}`, async () => {
        const captured = errorStream(encoded('early\n'), failure)
        const recorder = createRecorder({ [streamName]: captured })
        const result = await runCommand(recorder.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })
        expect(result[streamName === 'stdout' ? 'stdoutTail' : 'stderrTail']).toBe('early\n')
        expect(result).toMatchObject({ error: failure.message, pass: false })
      })
    }
  }

  test('fails a check if the runner reports a surviving process group', async () => {
    const recorder = createRecorder({ exit: { exitCode: 0, signal: null, groupSurvived: true } })
    expect(await runCommand(recorder.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })).toMatchObject({
      ran: true, exitCode: 0, error: 'process group could not be stopped', pass: false
    })
  })

  test('maps a recorder exit after the leader exits as an abort without main.ts', async () => {
    const recorder = createRecorder({ exit: { exitCode: 0, signal: null, stopped: 'aborted' } })
    expect(await runCommand(recorder.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })).toMatchObject({
      ran: true, pass: false, aborted: true, timedOut: false
    })
  })

  test('an already-aborted signal does not call the recorder', async () => {
    const controller = new AbortController()
    controller.abort()
    const recorder = createRecorder()
    const result = await runCommand(recorder.spawner, {
      command: 's',
      cwd: '/w',
      timeoutSeconds: 1,
      signal: controller.signal
    })
    expect(recorder.calls).toHaveLength(0)
    expect(result).toMatchObject({ ran: false, pass: false, exitCode: null, aborted: true })
  })

  test('converts a thrown runner start failure into a failed result', async () => {
    const recorder = createRecorder({ throwOnSpawn: new Error('runner is disposed') })
    await expect(runCommand(recorder.spawner, { command: 's', cwd: '/w', timeoutSeconds: 1 })).resolves.toMatchObject({
      ran: false, pass: false, exitCode: null, error: 'runner is disposed'
    })
  })

  test('runs an already-aborted command through a real process runner without spawning', async () => {
    const { home } = await start()
    checkRunner = createProcessRunner({ owner: 'quirky.checks.test' })
    const controller = new AbortController()
    controller.abort()
    const aborted = await runCommand(checkRunner, {
      command: `touch ${quoteShell(join(home, 'pre-aborted-ran'))}`,
      cwd: home,
      timeoutSeconds: 1,
      signal: controller.signal
    })
    expect(aborted).toMatchObject({ ran: false, pass: false, exitCode: null, aborted: true })
    expect(existsSync(join(home, 'pre-aborted-ran'))).toBe(false)
  })

  test('reports a missing shell through a real process runner', async () => {
    const { home } = await start()
    checkRunner = createProcessRunner({ owner: 'quirky.checks.test' })
    const result = await runCommand(checkRunner, {
      command: 'true',
      cwd: home,
      timeoutSeconds: 1,
      shell: join(home, 'missing-shell')
    })
    expect(result).toMatchObject({ ran: false, pass: false, exitCode: null })
    expect(result.error).toContain('ENOENT')
  })
})

