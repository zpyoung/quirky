import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuirkyClient, RpcErrorCode } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { runCommand } from '../executor'
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
    if (harness) {
      if (daemonStopped) {
        for (const client of harness.clients) client.close()
        harness.pty.stop()
      } else {
        await harness.cleanup()
      }
    }
  } finally {
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

  test('a cancellation racing a successful shell exit cannot return pass true', async () => {
    const { client, home } = await start()
    const shellPidFile = join(home, 'exit-race-shell-pid')
    const pidFile = join(home, 'exit-race-pid')
    // Its real timer keeps stdout open after the direct shell exits, leaving a cancellable drain window.
    const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>process.stdout.write('late'),5000)`
    const running = call<CheckResult>(client, 'quirky.checks/run', {
      command: `echo $$ > ${quoteShell(shellPidFile)}; ${nodeCommand(source)} & exit 0`,
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

  test('times out when the shell exits but a descendant keeps its pipes open', async () => {
    const { client, home } = await start()
    const pidFile = join(home, 'held-pipe-pid')
    // A real child timer keeps inherited output pipes open after the direct shell exits.
    const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},10000)`
    const result = await call<CheckResult>(client, 'quirky.checks/run', {
      command: `${nodeCommand(source)} & exit 0`,
      cwd: home,
      timeoutSeconds: 1
    })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    trackedPids.add(pid)
    expect(result).toMatchObject({ ran: true, pass: false, timedOut: true, aborted: false })
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

describe('internal checks process executor', () => {
  test('an already-aborted signal never spawns the command', async () => {
    const { home } = await start()
    const marker = join(home, 'pre-aborted-ran')
    const controller = new AbortController()
    controller.abort()
    const result = await runCommand({ command: `touch ${quoteShell(marker)}`, cwd: home, timeoutSeconds: 1, signal: controller.signal })
    expect(result).toMatchObject({ ran: false, pass: false, exitCode: null, aborted: true })
    expect(existsSync(marker)).toBe(false)
  })

  test('a subprocess spawn failure is reported as a failed result, not an exit code', async () => {
    const { home } = await start()
    const result = await runCommand({
      command: 'true',
      cwd: home,
      timeoutSeconds: 1,
      shell: join(home, 'missing-shell')
    })
    expect(result.ran).toBe(false)
    expect(result.pass).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.error).toContain('ENOENT')
  })
})
