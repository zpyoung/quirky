import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessRunnerDisposedError, liveProcesses, stopAllProcesses } from '@quirky/process'
import { GitError } from '../src/index'
import { statusV2 } from '../src/status'
import { worktreeChangeList } from '../src/compare'
import { git, gitScheduler, runGit, streamNullRecords } from '../src/run'

import * as runApi from '../src/run'
const gitBinary = Bun.which('git') ?? '/usr/bin/git'
const encoder = new TextEncoder()

const roots = new Set<string>()
const pidFiles = new Set<string>()

afterEach(() => {
  for (const file of pidFiles) {
    for (const pid of readPids(file)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  pidFiles.clear()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-git-process-'))
  roots.add(root)
  return root
}

function gitSync(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync([gitBinary, '-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

function makeRepo(files: Record<string, string> = {}): { root: string; repo: string } {
  const root = tempRoot()
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const init = Bun.spawnSync([gitBinary, '-C', repo, '-c', 'init.defaultBranch=main', 'init', '-q'], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`)
  gitSync(repo, 'config', 'user.name', 'Process Test')
  gitSync(repo, 'config', 'user.email', 'process-test@example.invalid')
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(repo, path), contents)
  if (Object.keys(files).length > 0) {
    gitSync(repo, 'add', '.')
    gitSync(repo, 'commit', '-q', '-m', 'initial')
  }
  return { root, repo }
}

function fakeGit(root: string, script: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'git')
  writeFileSync(path, `#!/bin/sh\nif [ "\${QUIRKY_GIT_TEST_WARMUP:-}" = 1 ]; then exit 0; fi\nset -eu\n${script}\n`, 'utf8')
  chmodSync(path, 0o755)
  const warmup = Bun.spawnSync([path], { cwd: root, env: { ...process.env, QUIRKY_GIT_TEST_WARMUP: '1' } })
  if (warmup.exitCode !== 0) throw new Error(warmup.stderr.toString())
  return bin
}

async function withEnvironment<T>(overrides: Record<string, string>, work: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await work()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function testEnv(bin: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: bin, ...extra }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function readPids(file: string): number[] {
  try {
    return readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger)
  } catch {
    return []
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function expectDead(pid: number): Promise<void> {
  await waitUntil(() => !isAlive(pid), 2_000)
}

async function expectGitError(promise: Promise<unknown>, exitCode: number, message?: RegExp): Promise<GitError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(GitError)
  expect((caught as GitError).exitCode).toBe(exitCode)
  if (message) expect((caught as Error).message).toMatch(message)
  return caught as GitError
}

function signalScript(): string {
  return `case "\${SIGNAL:-TERM}" in TERM) kill -TERM "$$" ;; KILL) kill -KILL "$$" ;; esac\nexit 99`
}

function detachedStallScript(): string {
  return [
    `printf 'start\\n' >> "$CALLS"`,
    `"$BUN_BIN" -e 'const child = Bun.spawn(["/bin/sleep", "4"], { detached: true, stdout: "inherit", stderr: "inherit" }); require("node:fs").appendFileSync(process.env.PIDS, String(child.pid) + "\\n"); child.unref();'`,
    `printf 'HEAD\\n'`,
    'exit 0'
  ].join('\n')
}

describe('git process runner', () => {
  test('tracks git children and kills same-group helpers on leader exit', async () => {
    const root = tempRoot()
    const ready = join(root, 'ready')
    const release = join(root, 'release')
    const pids = join(root, 'pids')
    pidFiles.add(pids)
    const bin = fakeGit(root, `/bin/sleep 10 &\nprintf '%s\\n' "$!" >> "$PIDS"\nprintf ready > "$READY"\nwhile [ ! -f "$RELEASE" ]; do /bin/sleep 0.005; done\nprintf 'ok\\n'`)
    const call = runGit(root, ['status'], { readOnly: true, timeoutMs: 2_000, env: testEnv(bin, { READY: ready, PIDS: pids, RELEASE: release }) })
    await waitUntil(() => existsSync(ready))
    expect(liveProcesses().some((p) => p.owner === 'git' && p.command === 'git')).toBe(true)
    writeFileSync(release, '')
    expect((await call).exitCode).toBe(0)
    expect(liveProcesses().filter((p) => p.owner === 'git')).toEqual([])
    const [pid] = readPids(pids)
    expect(pid).toBeDefined()
    await expectDead(pid!)
  })

  test('stops streaming children in finally on an early record and a callback error', async () => {
    for (const throws of [false, true]) {
      const root = tempRoot()
      const ready = join(root, 'ready')
      const pids = join(root, 'pids')
      pidFiles.add(pids)
      const bin = fakeGit(root, `/bin/sleep 10 &\nprintf '%s\\n' "$!" >> "$PIDS"\nprintf ready > "$READY"\nprintf 'one\\000'\nwait`)
      const release = Promise.withResolvers<void>()
      const boom = new Error('boom')
      const options = { timeoutMs: 2_000, stallMs: 100 }
      await withEnvironment({ PATH: `${bin}:${process.env.PATH ?? ''}`, READY: ready, PIDS: pids }, async () => {
        const call = streamNullRecords(root, ['status', '-z'], async () => {
          await release.promise
          if (throws) throw boom
          return true
        }, options).catch((error: unknown) => error)
        await waitUntil(() => existsSync(ready))
        expect(liveProcesses().some((p) => p.owner === 'git' && p.command === 'git')).toBe(true)
        release.resolve()
        expect(await call).toBe(throws ? boom : undefined)
      })
      expect(liveProcesses().filter((p) => p.owner === 'git')).toEqual([])
      const [pid] = readPids(pids)
      expect(pid).toBeDefined()
      await expectDead(pid!)
    }
  })

  test('appends daemon overrides without replacing caller GIT_CONFIG entries', async () => {
    const { repo } = makeRepo({ 'a.txt': 'a\n' })
    gitSync(repo, 'config', 'core.fsmonitor', 'true')
    gitSync(repo, 'config', 'gc.autoDetach', 'true')
    const caller = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'quirky.custom',
      GIT_CONFIG_VALUE_0: 'kept'
    }
    const env = await runApi.gitEnv(repo, { readOnly: true, env: caller })
    expect(env.GIT_CONFIG_COUNT).toBe('4')
    expect(env.GIT_CONFIG_KEY_0).toBe('quirky.custom')
    expect(env.GIT_CONFIG_VALUE_0).toBe('kept')
    expect(env.GIT_CONFIG_KEY_1).toBe('core.fsmonitor')
    expect(env.GIT_CONFIG_VALUE_1).toBe('false')
    expect(env.GIT_CONFIG_KEY_2).toBe('gc.autoDetach')
    expect(env.GIT_CONFIG_VALUE_2).toBe('false')
    expect(env.GIT_CONFIG_KEY_3).toBe('maintenance.autoDetach')
    expect(env.GIT_CONFIG_VALUE_3).toBe('false')
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true)

    for (const [key, expected] of [['core.fsmonitor', 'false'], ['gc.autoDetach', 'false'], ['maintenance.autoDetach', 'false'], ['quirky.custom', 'kept']]) {
      const result = await runGit(repo, ['config', '--get', key!], { readOnly: true, env: caller })
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout).trim()).toBe(expected)
    }
    await statusV2(repo)
    expect(existsSync(join(repo, '.git', 'fsmonitor--daemon.ipc'))).toBe(false)
  })

  test('forwards bounded default timeouts to read run, streaming spawn, and write run', async () => {
    const { repo } = makeRepo({ 'a.txt': 'a\n' })
    const readRunner = runApi.readRunner
    const writeRunner = runApi.writeRunner
    expect(readRunner.owner).toBe('git')
    expect(writeRunner.owner).toBe('git')
    expect(runApi.DEFAULT_GIT_READ_TIMEOUT_MS).toBe(30_000)
    expect(runApi.DEFAULT_GIT_WRITE_TIMEOUT_MS).toBe(120_000)
    expect(runApi.DEFAULT_GIT_MAX_OUTPUT_BYTES).toBe(16 * 1024 * 1024)
    const readRun = spyOn(readRunner, 'run')
    const readSpawn = spyOn(readRunner, 'spawn')
    const writeRun = spyOn(writeRunner, 'run')
    try {
      expect((await runGit(repo, ['status'], { readOnly: true })).exitCode).toBe(0)
      expect((await runGit(repo, ['config', '--local', 'process-runner.test', 'yes'])).exitCode).toBe(0)
      await streamNullRecords(repo, ['status', '--porcelain=v2', '-z'], () => false)
      const readRunTimeout = readRun.mock.calls[0]?.[1]?.timeoutMs
      const writeRunTimeout = writeRun.mock.calls[0]?.[1]?.timeoutMs
      const streamTimeout = readSpawn.mock.calls[0]?.[1]?.timeoutMs
      expect(readRunTimeout).toBeGreaterThan(29_000)
      expect(readRunTimeout).toBeLessThanOrEqual(30_000)
      expect(writeRunTimeout).toBeGreaterThan(119_000)
      expect(writeRunTimeout).toBeLessThanOrEqual(120_000)
      expect(streamTimeout).toBeGreaterThan(29_000)
      expect(streamTimeout).toBeLessThanOrEqual(30_000)
    } finally {
      readRun.mockRestore()
      readSpawn.mockRestore()
      writeRun.mockRestore()
    }
  })

  test('times out hung hooks with partial stderr and succeeds inside a longer deadline', async () => {
    const root = tempRoot()
    const pids = join(root, 'pids')
    pidFiles.add(pids)
    const bin = fakeGit(root, [
      `case "$*" in`,
      `  *long-hook*) /bin/sleep 0.25; printf 'done\\n'; exit 0 ;;`,
      `  *) printf 'pre-commit hook hung\\n' >&2; /bin/sleep 30 & printf '%s\\n' "$!" >> "$PIDS"; wait ;;`,
      'esac'
    ].join('\n'))
    const started = Date.now()
    const result = await runGit(root, ['commit', '-m', 'hung-hook'], { timeoutMs: 150, env: testEnv(bin, { PIDS: pids }) })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(result).toMatchObject({ exitCode: 143, timedOut: true, stderr: 'pre-commit hook hung\n' })
    const firstPid = readPids(pids)[0]!
    await expectDead(firstPid)

    const failed = await expectGitError(git(root, ['commit', '-m', 'hung-hook'], { timeoutMs: 150, env: testEnv(bin, { PIDS: pids }) }), 143, /git commit timed out/)
    expect(failed.stderr).toBe('pre-commit hook hung\n')
    await expectDead(readPids(pids)[1]!)
    expect((await runGit(root, ['commit', '-m', 'long-hook'], { timeoutMs: 600, env: testEnv(bin, { PIDS: pids }) })).exitCode).toBe(0)
  })

  test('a shared read waits for timeout cleanup and retains stderr', async () => {
    const root = tempRoot()
    const pids = join(root, 'pids')
    pidFiles.add(pids)
    const bin = fakeGit(root, `printf 'read started\\n' >&2\ntrap '' TERM\n/bin/sleep 30 &\nprintf '%s\\n' "$!" >> "$PIDS"\nwait`)
    const result = await runGit(root, ['status'], { readOnly: true, timeoutMs: 150, env: testEnv(bin, { PIDS: pids }) })
    expect(result).toMatchObject({ exitCode: 143, timedOut: true, stderr: 'read started\n' })
    expect(liveProcesses().filter((p) => p.owner === 'git')).toEqual([])
    for (const pid of readPids(pids)) await expectDead(pid)
  }, 5_000)

  test('retries a stalled read at most three times within one call deadline', async () => {
    const root = tempRoot()
    const pids = join(root, 'pids')
    const calls = join(root, 'calls')
    pidFiles.add(pids)
    const bin = fakeGit(root, detachedStallScript())
    const env = testEnv(bin, { BUN_BIN: process.execPath, PIDS: pids, CALLS: calls })

    const firstError = await expectGitError(
      runGit(root, ['rev-parse', 'HEAD'], { readOnly: true, timeoutMs: 2_000, stallMs: 60, share: false, env }),
      -1,
      /did not end after 3 attempts/
    )
    expect(firstError.message).toBe('git exited but its output did not end after 3 attempts')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(3)
    for (const pid of readPids(pids)) expect(isAlive(pid)).toBe(true)

    writeFileSync(calls, '')
    const deadlineError = await expectGitError(
      runGit(root, ['rev-parse', 'HEAD'], { readOnly: true, timeoutMs: 180, stallMs: 100, share: false, env }),
      -1
    )
    expect(deadlineError.exitCode).toBe(-1)
    expect(readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length).toBeLessThanOrEqual(2)
  })

  test('charges queue wait to both read deadlines without starting a child', async () => {
    const root = tempRoot()
    const calls = join(root, 'calls')
    const bin = fakeGit(root, `printf 'spawn\\n' >> "$CALLS"\nprintf 'ok\\n'`)
    const oldPath = process.env.PATH ?? ''
    const releaseGate = Promise.withResolvers<void>()
    let entered = 0
    const holds = Array.from({ length: 8 }, () => gitScheduler.withSlot('read', undefined, async () => {
      entered++
      await releaseGate.promise
    }))
    try {
      await waitUntil(() => entered === 8)
      await withEnvironment({ PATH: `${bin}:${oldPath}`, CALLS: calls }, async () => {
        const started = Date.now()
        const [read, stream] = await Promise.all([
          runGit(root, ['status'], { readOnly: true, timeoutMs: 80, share: false, env: { CALLS: calls } }),
          expectGitError(streamNullRecords(root, ['status', '-z'], () => false, { timeoutMs: 80 }), 143, /git status timed out/)
        ])
        expect(Date.now() - started).toBeLessThan(250)
        expect(read).toMatchObject({ stdout: new Uint8Array(0), stderr: '', exitCode: 143, timedOut: true })
        expect(stream.exitCode).toBe(143)
      })
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('')
    } finally {
      releaseGate.resolve()
      await Promise.all(holds)
    }
  })

  test('isolates output caps in read cohorts and maps overflow to GitError', async () => {
    const { repo } = makeRepo({ 'a.txt': 'hello world\n' })
    expect(runApi.DEFAULT_GIT_MAX_OUTPUT_BYTES).toBe(16 * 1024 * 1024)
    const [smallShared, largeShared, smallUnshared] = await Promise.all([
      runGit(repo, ['show', 'HEAD:a.txt'], { readOnly: true, maxOutputBytes: 4 }),
      runGit(repo, ['show', 'HEAD:a.txt'], { readOnly: true, maxOutputBytes: 25 * 1024 * 1024 }),
      runGit(repo, ['show', 'HEAD:a.txt'], { readOnly: true, maxOutputBytes: 4, share: false })
    ])
    expect(smallShared).toMatchObject({ exitCode: 137, overflow: true, stdout: encoder.encode('hell') })
    expect(smallUnshared).toMatchObject({ exitCode: 137, overflow: true, stdout: encoder.encode('hell') })
    expect(largeShared).toMatchObject({ exitCode: 0, stdout: encoder.encode('hello world\n') })
    expect(largeShared.overflow).toBeUndefined()
    const error = await expectGitError(git(repo, ['show', 'HEAD:a.txt'], { readOnly: true, maxOutputBytes: 4 }), 137, /output exceeded 4 bytes/)
    expect(error.stderr).toBe('')
  })

  test('rejects launch failures once, preserves abort errors, and normalizes signals', async () => {
    const root = tempRoot()
    const pids = join(root, 'pids')
    const ready = join(root, 'ready')
    const bin = fakeGit(root, [
      `case "\${MODE:-signal}" in`,
      `  abort) /bin/sleep 30 ;;`,
      `  *) ${signalScript()} ;;`,
      'esac'
    ].join('\n'))

    expect(runApi.normalizeExitCode(0, 'SIGKILL')).toBe(0)
    expect(runApi.normalizeExitCode(null, 'SIGTERM')).toBe(143)
    expect(runApi.normalizeExitCode(null, 'SIGKILL')).toBe(137)
    expect(() => runApi.normalizeExitCode(null, null)).toThrow(
      new GitError('failed to run git: process exited without status or signal', '', -1)
    )
    expect(typeof runApi.normalizeExitCode).toBe('function')

    const runSpy = spyOn(runApi.readRunner, 'run')
    try {
      await expectGitError(runGit(root, ['status'], { readOnly: true, env: testEnv(root, { PATH: '/nonexistent-bin' }) }), -1, /^failed to run git:/)
      expect(runSpy).toHaveBeenCalledTimes(1)
      runSpy.mockClear()
      await expectGitError(git(root, ['status'], { readOnly: true, env: { PATH: '/nonexistent-bin' } }), -1, /^failed to run git:/)
      expect(runSpy).toHaveBeenCalledTimes(1)
      runSpy.mockClear()
      await expectGitError(runGit('/nonexistent-quirky-g2-36-cwd', ['status'], { readOnly: true }), -1, /^failed to run git:/)
      expect(runSpy).toHaveBeenCalledTimes(1)
      runSpy.mockClear()
      await expectGitError(git('/nonexistent-quirky-g2-36-cwd', ['status'], { readOnly: true }), -1, /^failed to run git:/)
      expect(runSpy).toHaveBeenCalledTimes(1)
    } finally {
      runSpy.mockRestore()
    }

    const spawnSpy = spyOn(runApi.readRunner, 'spawn')
    try {
      await withEnvironment({ PATH: '/nonexistent-bin' }, async () => {
        await expectGitError(streamNullRecords(root, ['status', '-z'], () => false), -1, /^failed to run git:/)
      })
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      spawnSpy.mockClear()
      await expectGitError(streamNullRecords('/nonexistent-quirky-g2-36-cwd', ['status', '-z'], () => false), -1, /^failed to run git:/)
      expect(spawnSpy).toHaveBeenCalledTimes(1)
    } finally {
      spawnSpy.mockRestore()
    }

    for (const [signal, code] of [['TERM', 143], ['KILL', 137]] as const) {
      const result = await runGit(root, ['status'], { readOnly: true, env: testEnv(bin, { SIGNAL: signal }) })
      expect(result.exitCode).toBe(code)
      await withEnvironment({ PATH: `${bin}:${process.env.PATH ?? ''}`, SIGNAL: signal }, async () => {
        await expectGitError(streamNullRecords(root, ['status', '-z'], () => false, { stallMs: 100 }), code)
        if (signal === 'TERM') await expectGitError(git(root, ['status'], { readOnly: true }), code)
      })
    }

    pidFiles.add(pids)
    const sleepBin = fakeGit(root, `printf ready > "$READY"\n/bin/sleep 30`)
    const inFlight = runGit(root, ['status'], { readOnly: true, env: testEnv(sleepBin, { READY: ready, PIDS: pids, MODE: 'abort' }) })
    await waitUntil(() => existsSync(ready))
    await stopAllProcesses()
    await expectGitError(inFlight, -1, /aborted/)
    rmSync(ready)
    await withEnvironment({ PATH: `${sleepBin}:${process.env.PATH ?? ''}`, READY: ready }, async () => {
      const streamInFlight = streamNullRecords(root, ['status', '-z'], () => false)
      await waitUntil(() => existsSync(ready))
      await stopAllProcesses()
      await expectGitError(streamInFlight, -1, /aborted/)
    })
  })


  test('statusV2 rejects invalid cwd, aborts, and signalled git; daemon override avoids socket', async () => {
    await expectGitError(statusV2('/nonexistent-quirky-g2-36-cwd'), -1, /^failed to run git:/)

    const root = tempRoot()
    const ready = join(root, 'ready')
    const sleepBin = fakeGit(root, `printf ready > "$READY"\n/bin/sleep 30`)
    await withEnvironment({ PATH: `${sleepBin}:${process.env.PATH ?? ''}`, READY: ready }, async () => {
      const inFlight = statusV2(root)
      await waitUntil(() => existsSync(ready))
      await stopAllProcesses()
      await expectGitError(inFlight, -1, /aborted/)
    })

    const signalRoot = tempRoot()
    const signalBin = fakeGit(signalRoot, signalScript())
    for (const [signal, code] of [['TERM', 143], ['KILL', 137]] as const) {
      await withEnvironment({ PATH: `${signalBin}:${process.env.PATH ?? ''}`, SIGNAL: signal }, async () => {
        await expectGitError(statusV2(signalRoot), code)
      })
    }

    const { repo } = makeRepo({ 'a.txt': 'a\n' })
    gitSync(repo, 'config', 'core.fsmonitor', 'true')
    gitSync(repo, 'config', 'gc.autoDetach', 'true')
    await statusV2(repo)
    expect(existsSync(join(repo, '.git', 'fsmonitor--daemon.ipc'))).toBe(false)
  })

  test('worktreeChangeList rejects signalled listing and recreated-file diff children', async () => {
    const signalRoot = tempRoot()
    const signalBin = fakeGit(signalRoot, signalScript())
    for (const [signal, code] of [['TERM', 143], ['KILL', 137]] as const) {
      await withEnvironment({ PATH: `${signalBin}:${process.env.PATH ?? ''}`, SIGNAL: signal }, async () => {
        await expectGitError(worktreeChangeList(signalRoot, 'base'), code)
      })
    }

    const root = tempRoot()
    writeFileSync(join(root, 'a.txt'), 'new\n')
    const scripted = [
      'case "$1:$2" in',
      `  diff:--raw) printf ':100644 000000 1111111 0000000 D\\0a.txt\\0' ;;`,
      `  diff:--numstat) printf '0\\t1\\ta.txt\\0' ;;`,
      `  ls-files:--others) printf 'a.txt\\0' ;;`,
      `  cat-file:-s) printf '4\\n' ;;`,
      `  cat-file:blob) printf 'old\\n' ;;`,
      `  diff:--no-index) kill -TERM "$$" ;;`,
      '  *) exit 0 ;;',
      'esac'
    ].join('\n')
    const recreatedBin = fakeGit(root, scripted)
    await withEnvironment({ PATH: `${recreatedBin}:${process.env.PATH ?? ''}` }, async () => {
      await expectGitError(worktreeChangeList(root, 'base'), 143)
    })
  })

  test('converts a disposed shared runner into one launch GitError', async () => {
    const root = tempRoot()
    const disposed = () => { throw new ProcessRunnerDisposedError('git') }
    const run = spyOn(runApi.readRunner, 'run').mockImplementation(disposed)
    const spawn = spyOn(runApi.readRunner, 'spawn').mockImplementation(disposed)
    try {
      await expectGitError(runGit(root, ['status'], { readOnly: true }), -1, /^failed to run git: process runner "git" is disposed/)
      expect(run).toHaveBeenCalledTimes(1)
      await expectGitError(streamNullRecords(root, ['status', '-z'], () => false), -1, /^failed to run git: process runner "git" is disposed/)
      expect(spawn).toHaveBeenCalledTimes(1)
      await expectGitError(statusV2(root), -1, /^failed to run git: process runner "git" is disposed/)
      expect(spawn).toHaveBeenCalledTimes(2)
    } finally {
      run.mockRestore()
      spawn.mockRestore()
    }
  })
})
