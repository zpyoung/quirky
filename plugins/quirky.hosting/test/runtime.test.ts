import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, ProcessSpawner, SpawnExit, SpawnOptions, SpawnedProcess, StopOptions } from '@quirky/protocol'
import { ProcessStalledError, createProcessRunner } from '../../../packages/process/src/api'
import type { Scope } from '../src/env'
import { createRuntimeRunner, type RuntimeRunner } from '../src/runtime-runner'
import { bootHosting, type HostingTest } from './helpers'

const ghSource = String.raw`
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
const statePath = process.env.QUIRKY_TEST_FIXTURE_DIR + '/state.json'
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const saveState = () => {
  const temporaryStatePath = statePath + '.' + process.pid + '.tmp'
  writeFileSync(temporaryStatePath, JSON.stringify(state))
  renameSync(temporaryStatePath, statePath)
}
const args = process.argv.slice(2)
appendFileSync(process.env.QUIRKY_TEST_GH_ACTIVITY, JSON.stringify({ event: 'start', pid: process.pid }) + '\n')
const key = args[0] === 'auth' && args[1] === 'token' && args.includes('--help') ? 'auth_help'
  : args[0] === 'auth' && args[1] === 'status' ? 'auth_status'
  : args[0] === 'auth' && args[1] === 'token' ? 'auth_token'
  : args[0] === 'api' && args.includes('rate_limit') ? 'rate_limit'
  : args[0] === 'api' && args.includes('user') ? 'user'
  : args[0] === 'api' && args.includes('graphql') ? 'graphql'
  : args[0] ?? 'other'
const command = state.responses?.[key] ?? {}
const count = (state.counts?.[key] ?? 0) + 1
state.counts = { ...(state.counts ?? {}), [key]: count }
saveState()
const response = Array.isArray(command.attempts) ? (command.attempts[count - 1] ?? command.attempts.at(-1) ?? {}) : command
if (response.delayMs) await Bun.sleep(response.delayMs)
if (response.hang) await Bun.sleep(60_000)
if (response.repeatBytes) process.stdout.write('x'.repeat(response.repeatBytes))
else if (typeof response.stdout === 'string') process.stdout.write(response.stdout)
else if (response.stdout !== undefined) process.stdout.write(JSON.stringify(response.stdout))
else if (key === 'auth_status') process.stdout.write(state.authStatus ?? 'Logged in to github.com account fixture-user (keyring)\nActive account: true\nToken scopes: repo, read:org, project\n')
else if (key === 'auth_help') process.stdout.write('gh auth token [--user USER] [--hostname HOST]')
else if (key === 'auth_token') {
  const userAt = args.indexOf('--user')
  const user = userAt >= 0 ? args[userAt + 1] : 'fixture-user'
  process.stdout.write(state.tokens?.[user] ?? 'fixture-token-' + user)
}
else if (key === 'rate_limit') process.stdout.write(JSON.stringify(state.rateLimit ?? { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 }, search: { limit: 30, remaining: 29, reset: Math.floor(Date.now() / 1000) + 3600 }, graphql: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } }))
else if (key === 'user') process.stdout.write(JSON.stringify(state.viewer ?? { login: 'fixture-user', email: 'fixture@example.test' }))
else process.stdout.write('{}')
if (response.stderr) process.stderr.write(response.stderr)
appendFileSync(process.env.QUIRKY_TEST_GH_ACTIVITY, JSON.stringify({ event: 'end' }) + '\n')
process.exitCode = response.exitCode ?? 0
`

let running: HostingTest[] = []
afterEach(async () => {
  for (const host of running.splice(0).reverse()) await host.cleanup()
})

async function boot(options: Parameters<typeof bootHosting>[1] = {}): Promise<HostingTest> {
  const host = await bootHosting(ghSource, options)
  running.push(host)
  return host
}

type ScriptedStreamPlan = {
  chunks?: readonly Uint8Array[]
  end?: boolean
}

type ScriptedStream = {
  stream: ReadableStream<Uint8Array>
  push(chunk: Uint8Array): void
  close(): void
  fail(error: unknown): void
  wasCancelled(): boolean
}

function scriptedStream(plan: ScriptedStreamPlan = {}): ScriptedStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      for (const chunk of plan.chunks ?? []) controller.enqueue(chunk)
      if (plan.end !== false) {
        closed = true
        controller.close()
      }
    },
    cancel() {
      cancelled = true
      closed = true
    }
  })
  return {
    stream,
    push: (chunk) => controller.enqueue(chunk),
    close() {
      if (closed) return
      closed = true
      controller.close()
    },
    fail(error) {
      closed = true
      controller.error(error)
    },
    wasCancelled: () => cancelled
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

type ScriptedChild = SpawnedProcess & {
  stdoutControl: ScriptedStream
  stderrControl: ScriptedStream
  resolveExit(exit: SpawnExit): void
  stopCalls: StopOptions[]
  writes: Array<string | Uint8Array>
  closeInputCalls: number
}

type ScriptedChildPlan = {
  stdout?: ScriptedStreamPlan
  stderr?: ScriptedStreamPlan
  exit?: SpawnExit
  pendingExit?: boolean
  stopExit?: SpawnExit
  onStop?: (options: StopOptions, child: ScriptedChild) => Promise<SpawnExit>
  pendingWrite?: boolean
}

type ScriptedSpawnCall = { argv: string[]; options: SpawnOptions; child: ScriptedChild }
type ScriptedSpawner = {
  process: ProcessSpawner
  calls: ScriptedSpawnCall[]
  waitForCall(count?: number): Promise<void>
}

function makeScriptedSpawner(
  planFor: (argv: readonly string[], options: SpawnOptions, index: number) => ScriptedChildPlan = () => ({})
): ScriptedSpawner {
  const calls: ScriptedSpawnCall[] = []
  const spawnWaiters: Array<{ count: number; resolve(): void }> = []
  const waitForCall = (count = 1) => {
    if (calls.length >= count) return Promise.resolve()
    const waiting = Promise.withResolvers<void>()
    spawnWaiters.push({ count, resolve: waiting.resolve })
    return waiting.promise
  }
  const process: ProcessSpawner = {
    spawn(argv, options) {
      const plan = planFor(argv, options, calls.length)
      const exit = deferred<SpawnExit>()
      let exitResolved = false
      const resolveExit = (value: SpawnExit) => {
        if (exitResolved) return
        exitResolved = true
        exit.resolve(value)
      }
      if (!plan.pendingExit) {
        resolveExit(plan.exit ?? { exitCode: 0, signal: null, durationMs: 1 })
      }
      const stdoutControl = scriptedStream(plan.stdout)
      const stderrControl = scriptedStream(plan.stderr)
      const child: ScriptedChild = {
        pid: null,
        stdout: stdoutControl.stream,
        stderr: stderrControl.stream,
        stderrTail: () => '',
        exited: exit.promise,
        stdoutControl,
        stderrControl,
        resolveExit,
        stopCalls: [],
        writes: [],
        closeInputCalls: 0,
        write(data) {
          child.writes.push(data)
          return plan.pendingWrite ? Promise.withResolvers<boolean>().promise : Promise.resolve(true)
        },
        closeInput() {
          child.closeInputCalls += 1
          return plan.pendingWrite ? Promise.withResolvers<void>().promise : Promise.resolve()
        },
        async stop(stopOptions) {
          const recordedOptions = stopOptions ?? {}
          child.stopCalls.push(recordedOptions)
          if (plan.onStop) return plan.onStop(recordedOptions, child)
          if (!exitResolved) {
            resolveExit(plan.stopExit ?? {
              exitCode: null,
              signal: 'SIGTERM',
              stopped: 'stop',
              durationMs: 1
            })
          }
          return exit.promise
        }
      }
      calls.push({ argv: [...argv], options, child })
      for (let index = spawnWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = spawnWaiters[index]!
        if (calls.length >= waiter.count) {
          spawnWaiters.splice(index, 1)
          waiter.resolve()
        }
      }
      return child
    }
  }
  return { process, calls, waitForCall }
}

type RunnerFixture = {
  runner: RuntimeRunner
  scope: Scope
  fakebin: string
  cleanup(): Promise<void>
}

const runnerFixtureCleanups: Array<() => Promise<void>> = []

function makeRunnerFixture(spawner: ProcessSpawner, disposeSpawner?: () => Promise<unknown>): RunnerFixture {
  const fakebin = mkdtempSync(join(tmpdir(), 'quirky-hosting-fake-gh-'))
  const previousPath = process.env.PATH
  process.env.PATH = fakebin
  const identity = { host: 'github.com', owner: 'fixture-owner', repo: 'fixture-repo' }
  const scope = {
    worktree: { path: '/fixture/worktree' },
    origin: identity,
    repository: identity,
    candidates: [],
    issueRepository: identity,
    issueSourcePreference: 'auto',
    issueSourceFellBack: false
  } as unknown as Scope
  const context = {
    process: spawner,
    error: (code: string, message: string) => Object.assign(new Error(message), { code })
  } as unknown as PluginContext
  const runner = createRuntimeRunner(context, () => {})
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    try {
      await runner.dispose()
    } finally {
      try {
        await disposeSpawner?.()
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        rmSync(fakebin, { recursive: true, force: true })
      }
    }
  }
  runnerFixtureCleanups.push(cleanup)
  return { runner, scope, fakebin, cleanup }
}

async function waitForScriptedSpawn(spawner: ScriptedSpawner, run: Promise<unknown>, count = 1): Promise<void> {
  const finishedWithoutSpawn = run.then(
    () => {
      if (spawner.calls.length < count) throw new Error(`runner finished before scripted spawn ${count}`)
    },
    (error: unknown) => {
      if (spawner.calls.length < count) throw error
    }
  )
  await Promise.race([spawner.waitForCall(count), finishedWithoutSpawn])
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

afterEach(async () => {
  for (const cleanup of runnerFixtureCleanups.splice(0).reverse()) await cleanup()
})

function expectedSpawnEnvironment(options: { stripTokens?: boolean; host?: string; token?: string } = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value
  }
  delete env.GH_HOST
  delete env.GH_REPO
  if (options.stripTokens || options.token !== undefined) {
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
    delete env.GH_ENTERPRISE_TOKEN
    delete env.GITHUB_ENTERPRISE_TOKEN
  }
  env.GH_PROMPT_DISABLED ||= '1'
  if (options.host !== undefined) env.GH_HOST = options.host
  if (options.token !== undefined) env.GH_TOKEN = options.token
  return env
}

function expectSpawnCall(
  fixture: RunnerFixture,
  call: ScriptedSpawnCall,
  argv: string[],
  expected: { timeoutMs: number; stdin: 'ignore' | 'pipe'; env: Record<string, string>; signal?: AbortSignal }
): void {
  expect(call.argv).toEqual(argv)
  expect(call.options).toEqual({
    cwd: fixture.scope.worktree.path,
    env: expected.env,
    stdin: expected.stdin,
    stderr: 'pipe',
    timeoutMs: expected.timeoutMs,
    killGraceMs: 100,
    groupGrace: true,
    ...(expected.signal ? { signal: expected.signal } : {})
  })
}

describe('hosting runtime runner process-spawner migration', () => {
  test('routes run, bound-token resolution, and capability probes through exact process options', async () => {
    const spawner = makeScriptedSpawner((argv) => {
      const stdout = argv[1] === 'auth' && argv[2] === 'token'
        ? argv.includes('--help') ? 'gh auth token --user USER' : 'fixture-token'
        : argv[1] === 'auth' ? 'Logged in to github.com account fixture-user (keyring)\n' : '{"login":"octocat"}'
      return { stdout: { chunks: [utf8(stdout)] } }
    })
    const fixture = makeRunnerFixture(spawner.process)
    const signal = new AbortController().signal
    await fixture.runner.run(fixture.scope, ['auth', 'status'], { timeoutMs: 4_321, maxBytes: 512, signal })
    await fixture.runner.run(
      { ...fixture.scope, binding: { host: 'github.com', user: 'fixture-user' } },
      ['api', 'user'],
      { timeoutMs: 8_765, signal }
    )

    expect(spawner.calls).toHaveLength(4)
    expectSpawnCall(fixture, spawner.calls[0]!, ['gh', 'auth', 'status'], {
      timeoutMs: 4_321,
      stdin: 'ignore',
      env: expectedSpawnEnvironment(),
      signal
    })
    expectSpawnCall(fixture, spawner.calls[1]!, ['gh', 'auth', 'token', '--help'], {
      timeoutMs: 10_000,
      stdin: 'ignore',
      env: expectedSpawnEnvironment({ stripTokens: true })
    })
    expectSpawnCall(fixture, spawner.calls[2]!, ['gh', 'auth', 'token', '--hostname', 'github.com', '--user', 'fixture-user'], {
      timeoutMs: 10_000,
      stdin: 'ignore',
      env: expectedSpawnEnvironment({ stripTokens: true })
    })
    expectSpawnCall(fixture, spawner.calls[3]!, ['gh', 'api', '--hostname', 'github.com', 'user'], {
      timeoutMs: 8_765,
      stdin: 'ignore',
      env: expectedSpawnEnvironment({ host: 'github.com', token: 'fixture-token' }),
      signal
    })
  })

  test('classifies an ENOENT spawn result as gh unavailable', async () => {
    const spawner = makeScriptedSpawner(() => ({
      exit: {
        exitCode: null,
        signal: null,
        spawnError: { code: 'ENOENT', message: 'Executable not found in $PATH: "gh"' },
        durationMs: 1
      }
    }))
    const fixture = makeRunnerFixture(spawner.process)
    await expect(fixture.runner.run(fixture.scope, ['auth', 'status'])).rejects.toMatchObject({
      data: { reason: 'gh_unavailable' }
    })
    expect(spawner.calls).toHaveLength(1)
  })

  test('counts combined output caps by raw bytes across stdout and stderr', async () => {
    const cases = [
      {
        name: 'N-1 split across streams',
        stdout: { chunks: [utf8('ab')] },
        stderr: { chunks: [utf8('cd')] },
        expected: 'ab'
      },
      {
        name: 'N with a three-byte BOM and stderr remainder',
        stdout: { chunks: [Uint8Array.of(0xef, 0xbb, 0xbf)] },
        stderr: { chunks: [utf8('xy')] },
        expected: '\uFEFF'
      },
      {
        name: 'N with an invalid UTF-8 byte and stderr remainder',
        stdout: { chunks: [Uint8Array.of(0xff)] },
        stderr: { chunks: [utf8('1234')] },
        expected: '\uFFFD'
      },
      {
        name: 'N+1 raw bytes with a BOM and stderr remainder',
        stdout: { chunks: [Uint8Array.of(0xef, 0xbb, 0xbf)], end: false },
        stderr: { chunks: [utf8('abc')], end: false },
        expectedFailure: 'output_limit'
      }
    ] as const
    for (const scenario of cases) {
      const spawner = makeScriptedSpawner(() => ({ stdout: scenario.stdout, stderr: scenario.stderr }))
      const fixture = makeRunnerFixture(spawner.process)
      const run = fixture.runner.run(fixture.scope, ['auth', 'status'], { maxBytes: 5 })
      if ('expectedFailure' in scenario) {
        await expect(run).rejects.toMatchObject({ data: { reason: scenario.expectedFailure } })
        expect(spawner.calls[0]?.child.stopCalls).toEqual([{ graceMs: 100 }])
        expect(spawner.calls[0]?.child.stdoutControl.wasCancelled()).toBe(true)
        expect(spawner.calls[0]?.child.stderrControl.wasCancelled()).toBe(true)
      } else {
        await expect(run).resolves.toBe(scenario.expected)
        expect(spawner.calls[0]?.child.stopCalls).toEqual([])
      }
    }
  })

  test('large blocked stdin does not prevent deadline or abort cleanup', async () => {
    const input = 'x'.repeat(2 * 1024 * 1024)
    for (const mode of ['timeout', 'abort'] as const) {
      const controller = new AbortController()
      const spawner = makeScriptedSpawner(() => ({
        stdout: { end: false },
        stderr: { end: false },
        pendingExit: true,
        pendingWrite: true,
        stopExit: {
          exitCode: null,
          signal: 'SIGTERM',
          stopped: mode === 'timeout' ? 'timeout' : 'aborted',
          durationMs: 1
        }
      }))
      const fixture = makeRunnerFixture(spawner.process)
      const run = fixture.runner.run(fixture.scope, ['api', 'user'], {
        ambient: true,
        input,
        timeoutMs: mode === 'timeout' ? 25 : 5_000,
        ...(mode === 'abort' ? { signal: controller.signal } : {})
      })
      await waitForScriptedSpawn(spawner, run)
      const child = spawner.calls[0]!.child
      expect(child.writes).toEqual([input])
      expect(child.closeInputCalls).toBe(1)
      expectSpawnCall(fixture, spawner.calls[0]!, ['gh', 'api', '--hostname', 'github.com', 'user'], {
        timeoutMs: mode === 'timeout' ? 25 : 5_000,
        stdin: 'pipe',
        env: expectedSpawnEnvironment({ host: 'github.com' }),
        ...(mode === 'abort' ? { signal: controller.signal } : {})
      })
      if (mode === 'abort') controller.abort()
      await expect(run).rejects.toMatchObject({
        data: { reason: mode === 'timeout' ? 'timeout' : 'cancelled' }
      })
      expect(child.stopCalls).toEqual([{ graceMs: 100 }])
      expect(child.stdoutControl.wasCancelled()).toBe(true)
      expect(child.stderrControl.wasCancelled()).toBe(true)
    }
  })

  test('the real process runner reaps a SIGTERM-ignoring pipe holder after leader exit', async () => {
    const processRunner = createProcessRunner({ owner: 'quirky.hosting.g2-73-test' })
    const fixture = makeRunnerFixture(processRunner, () => processRunner.dispose())
    const fakeGh = join(fixture.fakebin, 'gh')
    writeFileSync(fakeGh, `#!${process.execPath}
import { spawn } from 'node:child_process'
const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'] })
descendant.unref()
process.stdout.write('{"login":"octocat"}', () => process.exit(0))
`)
    chmodSync(fakeGh, 0o755)

    const worktreeScope: Scope = { ...fixture.scope, worktree: { ...fixture.scope.worktree, path: fixture.fakebin } }
    const startedAt = Date.now()
    await expect(fixture.runner.run(worktreeScope, ['api', 'user'], { ambient: true, timeoutMs: 5_000 }))
      .resolves.toBe('{"login":"octocat"}')
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  })

  test('deadline, abort, and overflow win after a nonzero leader exits', async () => {
    const modes = [
      { mode: 'timeout', reason: 'timeout' },
      { mode: 'abort', reason: 'cancelled' },
      { mode: 'overflow', reason: 'output_limit' }
    ] as const
    for (const { mode, reason } of modes) {
      const controller = new AbortController()
      const spawner = makeScriptedSpawner(() => ({
        exit: { exitCode: 1, signal: null, durationMs: 1 },
        stdout: { end: false },
        stderr: { chunks: [utf8('HTTP 502')] }
      }))
      const fixture = makeRunnerFixture(spawner.process)
      const run = fixture.runner.run(fixture.scope, ['api', 'user'], {
        ambient: true,
        timeoutMs: mode === 'timeout' ? 25 : 5_000,
        ...(mode === 'abort' ? { signal: controller.signal } : {}),
        ...(mode === 'overflow' ? { maxBytes: 13 } : {})
      })
      await waitForScriptedSpawn(spawner, run)
      const child = spawner.calls[0]!.child
      if (mode === 'abort') controller.abort()
      if (mode === 'overflow') child.stdoutControl.push(utf8('abcdef'))
      await expect(run).rejects.toMatchObject({ data: { reason } })
      expect(spawner.calls).toHaveLength(1)
      expect(child.stopCalls).toEqual([{ graceMs: 100 }])
    }
  })

  test('preserves stream failures that happen before and after leader exit', async () => {
    const beforeExit = makeScriptedSpawner(() => ({
      stdout: { end: false },
      pendingExit: true,
      stopExit: { exitCode: 0, signal: 'SIGTERM', stopped: 'stop', durationMs: 1 }
    }))
    const beforeFixture = makeRunnerFixture(beforeExit.process)
    const beforeRun = beforeFixture.runner.run(beforeFixture.scope, ['api', 'user'], { ambient: true })
    await waitForScriptedSpawn(beforeExit, beforeRun)
    beforeExit.calls[0]!.child.stdoutControl.fail(new ProcessStalledError('gh', 1))
    await expect(beforeRun).rejects.toMatchObject({ data: { reason: 'upstream_error' } })
    expect(beforeExit.calls[0]?.child.stopCalls).toEqual([{ graceMs: 100 }])

    const afterExit = makeScriptedSpawner(() => ({
      stdout: { chunks: [utf8('{"login":"octocat"}')], end: false },
      stderr: { end: false },
      exit: { exitCode: 0, signal: null, durationMs: 1 }
    }))
    const afterFixture = makeRunnerFixture(afterExit.process)
    const afterRun = afterFixture.runner.run(afterFixture.scope, ['api', 'user'], { ambient: true })
    await waitForScriptedSpawn(afterExit, afterRun)
    afterExit.calls[0]!.child.stderrControl.fail(new ProcessStalledError('gh', 1))
    await expect(afterRun).rejects.toMatchObject({ data: { reason: 'upstream_error' } })
    expect(afterExit.calls).toHaveLength(1)
  })

  test('fails closed on successful leaders with stream errors or surviving groups', async () => {
    const cases = [
      { args: ['api', 'user'], output: '{"login":"octocat"}', failure: 'streamError' },
      { args: ['api', 'user'], output: '{"login":"octocat"}', failure: 'groupSurvived' },
      { args: ['auth', 'status'], output: 'Logged in to github.com account fixture-user (keyring)\n', failure: 'streamError' },
      { args: ['auth', 'status'], output: 'Logged in to github.com account fixture-user (keyring)\n', failure: 'groupSurvived' },
      { args: ['pr', 'checks'], output: 'no checks reported\n', failure: 'streamError' },
      { args: ['pr', 'checks'], output: 'no checks reported\n', failure: 'groupSurvived' }
    ] as const
    for (const scenario of cases) {
      const spawner = makeScriptedSpawner(() => ({
        stdout: { chunks: [utf8(scenario.output)] },
        ...(scenario.failure === 'streamError' ? { stderr: { end: false } } : {}),
        exit: { exitCode: 0, signal: null, durationMs: 1, ...(scenario.failure === 'groupSurvived' ? { groupSurvived: true } : {}) }
      }))
      const fixture = makeRunnerFixture(spawner.process)
      const run = fixture.runner.run(fixture.scope, [...scenario.args], { ambient: true })
      await waitForScriptedSpawn(spawner, run)
      if (scenario.failure === 'streamError') {
        spawner.calls[0]!.child.stderrControl.fail(new ProcessStalledError('gh', 1))
      }
      await expect(run).rejects.toMatchObject({ data: { reason: 'upstream_error' } })
      expect(spawner.calls).toHaveLength(1)
    }
  })

  test('does not retry HTTP 502 failures with a stream error or surviving process group', async () => {
    for (const failure of ['streamError', 'groupSurvived'] as const) {
      const spawner = makeScriptedSpawner(() => ({
        stdout: failure === 'streamError' ? { end: false } : {},
        stderr: { chunks: [utf8('HTTP 502: upstream unavailable')] },
        exit: {
          exitCode: 1,
          signal: null,
          durationMs: 1,
          ...(failure === 'groupSurvived' ? { groupSurvived: true } : {})
        }
      }))
      const fixture = makeRunnerFixture(spawner.process)
      const run = fixture.runner.run(fixture.scope, ['api', 'user'], { ambient: true })
      await waitForScriptedSpawn(spawner, run)
      if (failure === 'streamError') {
        spawner.calls[0]!.child.stdoutControl.fail(new ProcessStalledError('gh', 1))
      }
      await expect(run).rejects.toMatchObject({ data: { reason: 'server_error' } })
      expect(spawner.calls).toHaveLength(1)
    }
  })

  test('preserves nonzero authentication classification when the group survives', async () => {
    const spawner = makeScriptedSpawner(() => ({
      stderr: { chunks: [utf8('not logged into any GitHub hosts')] },
      exit: { exitCode: 1, signal: null, groupSurvived: true, durationMs: 1 }
    }))
    const fixture = makeRunnerFixture(spawner.process)
    await expect(fixture.runner.run(fixture.scope, ['api', 'user'], { ambient: true }))
      .rejects.toMatchObject({ data: { reason: 'not_authenticated' } })
    expect(spawner.calls).toHaveLength(1)
  })

  test('does not cache bound-token or capability failures from aborted, broken, or surviving processes', async () => {
    for (const stage of ['capability', 'token'] as const) {
      for (const failure of ['aborted', 'streamError', 'groupSurvived'] as const) {
        const spawner = makeScriptedSpawner((argv) => {
          const isCapability = argv[1] === 'auth' && argv[2] === 'token' && argv.includes('--help')
          const isToken = argv[1] === 'auth' && argv[2] === 'token' && !argv.includes('--help')
          const shouldFail = stage === 'capability' ? isCapability : isToken
          const output = isCapability ? 'gh auth token --user USER' : 'fixture-token'
          if (!shouldFail) return { stdout: { chunks: [utf8(output)] } }
          return {
            stdout: { chunks: [utf8(output)] },
            ...(failure === 'streamError' ? { stderr: { end: false } } : {}),
            exit: {
              exitCode: 0,
              signal: null,
              durationMs: 1,
              ...(failure === 'aborted' ? { stopped: 'aborted' } : {}),
              ...(failure === 'groupSurvived' ? { groupSurvived: true } : {})
            }
          }
        })
        const fixture = makeRunnerFixture(spawner.process)
        const boundScope = { ...fixture.scope, binding: { host: 'github.com', user: 'fixture-user' } }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const run = fixture.runner.run(boundScope, ['api', 'user'])
          const failingCallCount = stage === 'capability' ? attempt + 1 : attempt === 0 ? 2 : 3
          await waitForScriptedSpawn(spawner, run, failingCallCount)
          if (failure === 'streamError') {
            spawner.calls[failingCallCount - 1]!.child.stderrControl.fail(new ProcessStalledError('gh', 1))
          }
          await expect(run).rejects.toMatchObject({
            data: { reason: stage === 'capability' ? 'multi_account_capability_unknown' : 'bound_account_unavailable' }
          })
        }
        expect(spawner.calls.filter(({ argv }) => argv[1] === 'auth' && argv[2] === 'token' && argv.includes('--help')))
          .toHaveLength(stage === 'capability' ? 2 : 1)
        expect(spawner.calls.filter(({ argv }) => argv[1] === 'auth' && argv[2] === 'token' && !argv.includes('--help')))
          .toHaveLength(stage === 'capability' ? 0 : 2)
      }
    }
  })

  test('dispose shares its promise, waits for stop and drainage, then blocks new commands', async () => {
    const stopStarted = deferred<void>()
    const stopGate = deferred<SpawnExit>()
    const spawner = makeScriptedSpawner(() => ({
      stdout: { end: false },
      stderr: { end: false },
      pendingExit: true,
      pendingWrite: true,
      onStop: () => {
        stopStarted.resolve()
        return stopGate.promise
      }
    }))
    const fixture = makeRunnerFixture(spawner.process)
    const input = 'x'.repeat(2 * 1024 * 1024)
    const running = fixture.runner.run(fixture.scope, ['api', 'user'], { ambient: true, input, timeoutMs: 5_000 })
    await waitForScriptedSpawn(spawner, running)
    const child = spawner.calls[0]!.child
    try {
      expect(child.writes).toEqual([input])
      expect(child.closeInputCalls).toBe(1)
      expectSpawnCall(fixture, spawner.calls[0]!, ['gh', 'api', '--hostname', 'github.com', 'user'], {
        timeoutMs: 5_000,
        stdin: 'pipe',
        env: expectedSpawnEnvironment({ host: 'github.com' })
      })

      const firstDispose = fixture.runner.dispose()
      const secondDispose = fixture.runner.dispose()
      expect(secondDispose).toBe(firstDispose)
      await stopStarted.promise
      expect(child.stopCalls).toEqual([{ graceMs: 100 }])
      let disposed = false
      void firstDispose.then(() => { disposed = true })
      stopGate.resolve({ exitCode: 0, signal: null, durationMs: 1 })
      await Promise.resolve()
      expect(disposed).toBe(false)
      child.resolveExit({ exitCode: 0, signal: null, durationMs: 1 })
      child.stdoutControl.close()
      child.stderrControl.close()
      await expect(running).rejects.toMatchObject({ data: { reason: 'plugin_inactive' } })
      await firstDispose
      expect(disposed).toBe(true)

      const boundScope = { ...fixture.scope, binding: { host: 'github.com', user: 'fixture-user' } }
      await expect(fixture.runner.run(fixture.scope, ['auth', 'status'])).rejects.toMatchObject({
        data: { reason: 'plugin_inactive' }
      })
      await expect(fixture.runner.run(boundScope, ['api', 'user'])).rejects.toMatchObject({
        data: { reason: 'plugin_inactive' }
      })
      await expect(fixture.runner.validateBinding(fixture.scope, boundScope.binding)).rejects.toMatchObject({
        data: { reason: 'plugin_inactive' }
      })
      expect(spawner.calls).toHaveLength(1)
    } finally {
      const exit = { exitCode: 0, signal: null, durationMs: 1 } satisfies SpawnExit
      stopGate.resolve(exit)
      child.resolveExit(exit)
      child.stdoutControl.close()
      child.stderrControl.close()
    }
  })
})

describe('GH01-GH08: GitHub runtime boundary', () => {
  const githubUrls = [
    'https://github.com/test-owner/test-repo.git',
    'git@github.com:test-owner/test-repo.git',
    'ssh://git@github.com:2222/test-owner/test-repo.git',
    'git@github-work:test-owner/test-repo.git'
  ]
  for (const remote of githubUrls) {
    test(`GH01 resolves standard GitHub remote ${remote}`, async () => {
      const host = await boot({ remote })
      const result = await host.call('repository') as { origin: { host: string; owner: string; repo: string } }
      expect(result.origin).toEqual({ host: 'github.com', owner: 'test-owner', repo: 'test-repo' })
    })
  }

  test('GH01 resolves an authenticated enterprise host', async () => {
    const enterprise = await boot({ remote: 'https://github.enterprise.test/org/private.git' })
    enterprise.writeState({
      authStatus: 'Logged in to github.enterprise.test account fixture-user (keyring)\nActive account: true\nToken scopes: repo\n'
    })
    expect(await enterprise.call('repository')).toMatchObject({
      origin: { host: 'github.enterprise.test', owner: 'org', repo: 'private' }
    })
    expect(enterprise.invocations().some((item) => item.args.includes('github.enterprise.test'))).toBe(false)
  })

  test('diagnoseAuth keeps fresh results by default and can reuse the cached inventory', async () => {
    const host = await boot()
    await host.call('diagnoseAuth')
    const authStatuses = () => host.invocations().filter(({ args }) => args[0] === 'auth' && args[1] === 'status')
    const before = authStatuses().length
    expect(before).toBeGreaterThan(0)

    host.writeState({ authStatus: 'No authentication configured for github.com\n' })
    const cached = await host.call('diagnoseAuth', { force: false }) as { requiredHostAuthenticated: boolean }
    expect(cached.requiredHostAuthenticated).toBe(true)
    expect(authStatuses()).toHaveLength(before)

    const fresh = await host.call('diagnoseAuth') as { requiredHostAuthenticated: boolean }
    expect(fresh.requiredHostAuthenticated).toBe(false)
    expect(authStatuses()).toHaveLength(before + 1)
  })
  const standardEnterpriseAuthStatuses = [
    [
      'decorated standard output',
      `github.enterprise.test
  ✗ Logged in to github.enterprise.test account failed-user (keyring)
  ✓ Logged in to github.enterprise.test account env-user (GH_ENTERPRISE_TOKEN)
  - Active account: true
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.enterprise.test account keyring-user (keyring)
  - Active account: false
  - Token scopes: 'project', 'repo'
`
    ],
    [
      'ANSI-colored standard output',
      `\u001b[1;36mgithub.enterprise.test\u001b[0m
  \u001b[31m✗\u001b[0m Logged in to \u001b[1;36mgithub.enterprise.test\u001b[0m account failed-user (keyring)
  \u001b[32m✓\u001b[0m Logged in to \u001b[1;36mgithub.enterprise.test\u001b[0m account \u001b[1;33menv-user\u001b[0m (\u001b[1;35mGH_ENTERPRISE_TOKEN\u001b[0m)
  - \u001b[1mActive account:\u001b[0m true
  - \u001b[1mToken scopes:\u001b[0m 'gist', 'read:org', 'repo'

  \u001b[32m✓\u001b[0m Logged in to \u001b[1;36mgithub.enterprise.test\u001b[0m account \u001b[1;33mkeyring-user\u001b[0m (\u001b[1;35mkeyring\u001b[0m)
  - \u001b[1mActive account:\u001b[0m false
  - \u001b[1mToken scopes:\u001b[0m 'project', 'repo'
`
    ]
  ] as const
  for (const [format, authStatus] of standardEnterpriseAuthStatuses) {
    test(`GH01 resolves GHES identity and account fields from ${format}`, async () => {
      const enterprise = await boot({ remote: 'https://github.enterprise.test/org/private.git' })
      enterprise.writeState({ authStatus })

      expect(await enterprise.call('repository')).toMatchObject({
        origin: { host: 'github.enterprise.test', owner: 'org', repo: 'private' }
      })
      const inventory = await enterprise.call('accounts') as { requiredHost: string; accounts: unknown[] }
      expect(inventory).toMatchObject({
        requiredHost: 'github.enterprise.test',
        accounts: [
          {
            host: 'github.enterprise.test',
            user: 'env-user',
            source: 'env',
            active: true,
            scopes: ['gist', 'read:org', 'repo'],
            bindable: false
          },
          {
            host: 'github.enterprise.test',
            user: 'keyring-user',
            source: 'keyring',
            active: false,
            scopes: ['project', 'repo'],
            bindable: true
          }
        ]
      })
      expect(inventory.accounts).toHaveLength(2)
      await expect(enterprise.call('configure', { account: { host: 'github.enterprise.test', user: 'env-user' } })).rejects.toMatchObject({
        data: { reason: 'bound_account_not_keyring' }
      })
    })
  }


  test('GH01 preserves authenticated enterprise host ports', async () => {
    const enterprisePort = await boot({ remote: 'https://github.enterprise.test:8443/org/private.git' })
    enterprisePort.writeState({
      authStatus: 'Logged in to github.enterprise.test:8443 account fixture-user (keyring)\nActive account: true\nToken scopes: repo\n'
    })
    expect(await enterprisePort.call('repository')).toMatchObject({
      origin: { host: 'github.enterprise.test:8443', owner: 'org', repo: 'private' }
    })
    expect(enterprisePort.invocations().every((item) => !item.args.includes('github.enterprise.test:8443'))).toBe(true)
  })

  test('GH01 resolves an enterprise SSH host through its alias', async () => {
    const sshEnterprise = await boot({ remote: 'git@github.enterprise.test:org/private.git' })
    sshEnterprise.writeState({
      authStatus: 'Logged in to github.enterprise.test:8443 account fixture-user (keyring)\nActive account: true\nToken scopes: repo\n'
    })
    expect(await sshEnterprise.call('repository')).toMatchObject({
      origin: { host: 'github.enterprise.test:8443', owner: 'org', repo: 'private' }
    })
  })

  test('GH01 keeps origin as head, orders PR candidates upstream-first, and honors issue-source preference', async () => {
    const host = await boot({
      remote: 'https://github.com/fork-owner/fork-repo.git',
      upstream: 'https://github.com/upstream-owner/upstream-repo.git'
    })
    const automatic = await host.call('repository')
    expect(automatic).toMatchObject({
      head: { owner: 'fork-owner', repo: 'fork-repo' },
      candidates: [{ owner: 'upstream-owner', repo: 'upstream-repo' }, { owner: 'fork-owner', repo: 'fork-repo' }],
      issueRepository: { owner: 'upstream-owner', repo: 'upstream-repo' },
      issueSourcePreference: 'auto',
      issueSourceFellBack: false
    })

    await host.call('configure', { issueSourcePreference: 'origin' })
    expect(await host.call('repository')).toMatchObject({
      issueRepository: { owner: 'fork-owner', repo: 'fork-repo' },
      candidates: [{ owner: 'upstream-owner' }, { owner: 'fork-owner' }],
      issueSourceFellBack: false
    })
    await host.call('configure', { issueSourcePreference: 'upstream' })
    execFileSync('git', ['remote', 'remove', 'upstream'], { cwd: host.repoPath })
    expect(await host.call('repository')).toMatchObject({
      issueRepository: { owner: 'fork-owner', repo: 'fork-repo' },
      issueSourceFellBack: true
    })
  })

  test('GH02 rejects unregistered selectors and foreign identities before an authenticated gh request', async () => {
    const host = await boot()
    await expect(host.call('repository', { worktree: 'path:/etc' })).rejects.toMatchObject({ data: { reason: 'worktree_unavailable' } })
    await expect(host.call('forBranch', {
      branch: 'feature',
      prRepo: { host: 'attacker.example', owner: 'other', repo: 'private' }
    })).rejects.toMatchObject({ data: { reason: 'repository_mismatch' } })
    expect(host.invocations()).toEqual([])
  })

  const failures = [
    { response: { exitCode: 127, stderr: 'gh: command not found' }, reason: 'gh_unavailable' },
    { response: { exitCode: 1, stderr: 'HTTP 401: not logged in' }, reason: 'not_authenticated' },
    { response: { exitCode: 1, stderr: 'HTTP 404: Not Found' }, reason: 'repository_unavailable' },
    { response: { exitCode: 1, stderr: 'connection reset by peer' }, reason: 'network_error' },
    { response: { exitCode: 1, stderr: 'HTTP 403: Resource not accessible by integration (insufficient scope)' }, reason: 'scope_missing' },
    { response: { exitCode: 1, stderr: 'Field views not found on ProjectV2' }, reason: 'schema_drift' },
    { response: { exitCode: 1, stderr: 'HTTP 422: Body is too long (maximum is 65536 characters)' }, reason: 'body_too_long' },
    { response: { exitCode: 1, stderr: 'HTTP 422: A pull request already exists for this head and base' }, reason: 'already_exists' },
    { response: { exitCode: 1, stderr: 'HTTP 422: head sha does not match' }, reason: 'head_changed' }
  ]
  for (const scenario of failures) {
    test(`GH03 returns a safe ${scenario.reason} reason`, async () => {
      const host = await boot()
      host.writeState({ responses: { user: scenario.response } })
      const error = await host.call('viewer').catch((value: unknown) => value)
      expect(error).toMatchObject({ data: { reason: scenario.reason } })
      expect(JSON.stringify(error)).not.toContain(scenario.response.stderr)
    })
  }

  test('GH03 treats pull-request view and REST 404s as absence', async () => {
    const host = await boot()
    host.writeState({ responses: { pr: { exitCode: 1, stderr: 'HTTP 404: Not Found' } } })
    expect(await host.call('review', { number: 11 })).toMatchObject({ kind: 'no-review' })

    host.writeState({
      responses: {
        pr: { exitCode: 1, stderr: 'HTTP 403: Forbidden' },
        api: { exitCode: 1, stderr: 'HTTP 404: Not Found' }
      }
    })
    expect(await host.call('review', { number: 12 })).toMatchObject({ kind: 'no-review' })
    expect(host.invocations().some(({ args }) => args[0] === 'api' && args.some((arg) => arg.endsWith('/pulls/12')))).toBe(true)
  })

  test('GH04 binds only an existing keyring account, strips ambient tokens in the bound child, and persists no token', async () => {
    const host = await boot()
    host.writeState({
      authStatus: 'Logged in to github.com account alice (keyring)\nActive account: true\nToken scopes: repo\nLogged in to github.com account bob (keyring)\nActive account: false\nToken scopes: repo\n',
      tokens: { alice: 'fixture-alice-token' }
    })
    await host.call('configure', { account: { host: 'github.com', user: 'alice' } })
    expect(await host.call('viewer')).toMatchObject({ login: 'fixture-user' })
    const bound = host.invocations().find((item) => item.args.includes('api') && item.args.includes('user'))
    expect(bound?.args).toContain('--hostname')
    expect(bound?.args).toContain('github.com')
    expect(bound?.env).toMatchObject({ GH_TOKEN: 'fixture-alice-token' })
    expect(bound?.env.GITHUB_TOKEN).toBeUndefined()
    expect(JSON.stringify(await host.call('configuration'))).not.toContain('fixture-alice-token')
    const storedFiles = readdirSync(join(host.home, 'plugin-data', 'quirky.hosting'))
      .map((file) => readFileSync(join(host.home, 'plugin-data', 'quirky.hosting', file)).toString('utf8'))
    expect(storedFiles.join('')).not.toContain('fixture-alice-token')
    await expect(host.call('configure', { account: { host: 'github.com', user: 'missing-user' } })).rejects.toMatchObject({
      data: { reason: 'bound_account_unavailable' }
    })
  })

  test('GH05 coalesces concurrent reads and observes a repointed remote without reusing stale identity', async () => {
    const host = await boot()
    // Delay is inside a real fixture process so the daemon requests genuinely overlap.
    host.writeState({ responses: { user: { delayMs: 60, stdout: { login: 'one' } } } })
    const values = await Promise.all(Array.from({ length: 8 }, () => host.call('viewer')))
    expect(values).toHaveLength(8)
    expect(host.invocations().filter((item) => item.args.includes('user'))).toHaveLength(1)

    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/changed-owner/changed-repo.git'], { cwd: host.repoPath })
    expect(await host.call('repository')).toMatchObject({ origin: { owner: 'changed-owner', repo: 'changed-repo' } })
  })

  test('GH05 limits real concurrent gh processes to four', async () => {
    const host = await boot()
    // Hold real gh fixture processes long enough for the runner's admission queue to fill.
    host.writeState({ responses: { auth_status: { delayMs: 200 } } })
    const results = await Promise.all(Array.from({ length: 8 }, () => host.call('accounts')))
    expect(results).toHaveLength(8)
    const events = readFileSync(join(host.root, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { event: string })
    let active = 0
    let maximum = 0
    for (const event of events) {
      active += event.event === 'start' ? 1 : -1
      maximum = Math.max(maximum, active)
    }
    expect(maximum).toBeLessThanOrEqual(4)
    expect(maximum).toBeGreaterThan(1)
  })

  test('GH06 kills a hung descendant and permits a later request', async () => {
    const previous = process.env.ORCA_GH_EXEC_TIMEOUT_MS
    process.env.ORCA_GH_EXEC_TIMEOUT_MS = '1000'
    try {
      const host = await boot()
      host.writeState({ responses: { user: { hang: true } } })
      await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: 'timeout' } })
      const started = readFileSync(join(host.root, 'activity.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { event: string; pid?: number })
        .find((event) => event.event === 'start')
      const pid = started?.pid
      if (typeof pid !== 'number') throw new Error('fixture process ID was not recorded')
      expect(() => process.kill(pid, 0)).toThrow()
      host.writeState({ responses: { user: { stdout: { login: 'recovered' } } } })
      expect(await host.call('viewer')).toMatchObject({ login: 'recovered' })
    } finally {
      if (previous === undefined) delete process.env.ORCA_GH_EXEC_TIMEOUT_MS
      else process.env.ORCA_GH_EXEC_TIMEOUT_MS = previous
    }
  })

  test('GH06 rejects oversized output', async () => {
    const oversized = await boot()
    oversized.writeState({ responses: { user: { repeatBytes: 11 * 1024 * 1024 } } })
    await expect(oversized.call('viewer')).rejects.toMatchObject({ data: { reason: 'output_limit' } })
  })

  test('GH07 retries transient idempotent reads at most twice, without exposing fixture stderr', async () => {
    const host = await boot()
    host.writeState({
      responses: {
        user: {
          attempts: [
            { exitCode: 1, stderr: 'HTTP 502: transient upstream failure' },
            { exitCode: 1, stderr: 'HTTP 503: transient upstream failure' },
            { stdout: { login: 'recovered' } }
          ]
        }
      }
    })
    expect(await host.call('viewer')).toMatchObject({ login: 'recovered' })
    expect(host.invocations().filter((item) => item.args.includes('user'))).toHaveLength(3)
  })

  test('GH08 rate-limit snapshots and circuit gates remain scoped to host/account', async () => {
    const host = await boot()
    const reset = Math.floor(Date.now() / 1000) + 600
    host.writeState({
      rateLimit: { resources: { core: { limit: 5000, remaining: 1, reset }, search: { limit: 30, remaining: 20, reset }, graphql: { limit: 5000, remaining: 500, reset } } },
      responses: { user: { exitCode: 1, stderr: 'API rate limit exceeded for user; Retry-After: 4' } }
    })
    expect(await host.call('rateLimit')).toMatchObject({ core: { remaining: 1 } })
    await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: 'rate_limited' } })
    const countAtPause = host.invocations().length
    await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: 'rate_limited' } })
    expect(host.invocations()).toHaveLength(countAtPause)

    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.enterprise.test/org/private.git'], { cwd: host.repoPath })
    host.writeState({ authStatus: 'Logged in to github.enterprise.test account fixture-user (keyring)\nActive account: true\nToken scopes: repo\n' })
    expect(await host.call('viewer')).toMatchObject({ login: 'fixture-user' })
    expect(host.invocations().length).toBeGreaterThan(countAtPause)
  })
  test('GH08 charges reported GraphQL cost before another request can cross the safe floor', async () => {
    const host = await boot()
    const reset = Math.floor(Date.now() / 1000) + 600
    host.writeState({
      rateLimit: { resources: {
        core: { limit: 5000, remaining: 4999, reset },
        search: { limit: 30, remaining: 29, reset },
        graphql: { limit: 5000, remaining: 99, reset }
      } },
      responses: {
        graphql: { stdout: { data: {
          search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          rateLimit: { cost: 51 }
        } } },
        pr: { stdout: [] },
        api: { stdout: { total_count: 0, items: [] } }
      }
    })
    await host.call('rateLimit')
    expect(await host.call('listWorkItems', { query: 'first-cost-probe' })).toMatchObject({ partial: false, items: [] })
    const graphqlBefore = host.invocations().filter(({ args }) => args.includes('graphql')).length
    await host.call('listWorkItems', { query: 'second-cost-probe' })
    expect(host.invocations().filter(({ args }) => args.includes('graphql'))).toHaveLength(graphqlBefore)
    expect(await host.call('viewer')).toMatchObject({ login: 'fixture-user' })
  }, 20_000)

  test('GH08 cold PR lookups warm the quota snapshot before spending an exhausted bucket', async () => {
    const host = await boot()
    const reset = Math.floor(Date.now() / 1000) + 600
    host.writeState({ rateLimit: { resources: {
      core: { limit: 5000, remaining: 1, reset },
      search: { limit: 30, remaining: 1, reset },
      graphql: { limit: 5000, remaining: 1, reset }
    } } })
    expect(await host.call('review', { number: 11 })).toMatchObject({ kind: 'unavailable', reason: 'rate_limited' })
    expect(host.invocations().filter(({ args }) => args[0] !== 'auth' && !args.includes('rate_limit'))).toEqual([])
  }, 20_000)

  test('GH08 CLI PR reads cannot spend an exhausted GraphQL bucket while REST remains usable', async () => {
    const host = await boot()
    const reset = Math.floor(Date.now() / 1000) + 600
    host.writeState({
      rateLimit: { resources: {
        core: { limit: 5000, remaining: 4999, reset },
        search: { limit: 30, remaining: 29, reset },
        graphql: { limit: 5000, remaining: 1, reset }
      } },
      responses: { pr: { stdout: [] }, api: { stdout: { total_count: 0, items: [] } } }
    })
    await host.call('rateLimit')
    const result = await host.call('listWorkItems', { query: 'quota-probe' })
    expect(result).toMatchObject({ partial: true, errors: { prs: { reason: 'rate_limited' } } })
    expect(host.invocations().filter(({ args }) => args[0] === 'pr')).toEqual([])
    expect(await host.call('viewer')).toMatchObject({ login: 'fixture-user' })
  }, 20_000)

  test('GH08 cold work-item counts honor the search floor even when GraphQL has quota', async () => {
    const host = await boot()
    const reset = Math.floor(Date.now() / 1000) + 600
    host.writeState({ rateLimit: { resources: {
      core: { limit: 5000, remaining: 4999, reset },
      search: { limit: 30, remaining: 1, reset },
      graphql: { limit: 5000, remaining: 4999, reset }
    } } })
    expect(await host.call('countWorkItems')).toMatchObject({
      count: 0,
      partial: true,
      partialFailures: expect.arrayContaining([
        expect.objectContaining({ source: 'issues', reason: 'rate_limited' }),
        expect.objectContaining({ source: 'prs', reason: 'rate_limited' })
      ])
    })
    expect(host.invocations().filter(({ args }) => args[0] !== 'auth' && !args.includes('rate_limit'))).toEqual([])
  }, 20_000)

  test('GH08 honors Retry-After and isolates circuit gates between repository account bindings', async () => {
    const host = await boot()
    host.writeState({
      authStatus: 'Logged in to github.com account alice (keyring)\nActive account: true\nToken scopes: repo\nLogged in to github.com account bob (keyring)\nActive account: false\nToken scopes: repo\n',
      responses: {
        user: {
          attempts: [
            { exitCode: 1, stderr: 'API rate limit exceeded; Retry-After: 10' },
            { stdout: { login: 'bob' } }
          ]
        }
      }
    })
    await host.call('configure', { account: { host: 'github.com', user: 'alice' } })
    await expect(host.call('viewer')).rejects.toMatchObject({
      data: { reason: 'rate_limited', retryDisabledUntil: expect.any(Number) }
    })
    const pausedCount = host.invocations().length
    await expect(host.call('viewer')).rejects.toMatchObject({ data: { reason: 'rate_limited' } })
    expect(host.invocations()).toHaveLength(pausedCount)

    await host.call('configure', { account: { host: 'github.com', user: 'bob' } })
    expect(await host.call('viewer')).toMatchObject({ login: 'bob' })
  })

  test('GH08 caches failed rate-limit probes per account and force recovers', async () => {
    const host = await boot()
    host.writeState({
      authStatus: 'Logged in to github.com account alice (keyring)\nActive account: true\nToken scopes: repo\nLogged in to github.com account bob (keyring)\nActive account: false\nToken scopes: repo\n',
      responses: {
        rate_limit: {
          attempts: [
            { exitCode: 1, stderr: 'HTTP 401: bad credentials token=private-probe-secret' },
            { stdout: { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 600 }, search: { limit: 30, remaining: 29, reset: Math.floor(Date.now() / 1000) + 600 }, graphql: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 600 } } } },
            { stdout: { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 600 }, search: { limit: 30, remaining: 29, reset: Math.floor(Date.now() / 1000) + 600 }, graphql: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 600 } } } }
          ]
        }
      }
    })
    await host.call('configure', { account: { host: 'github.com', user: 'alice' } })
    const failure = await host.call('rateLimit').then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ data: { reason: 'not_authenticated' } })
    const failureMessage = failure instanceof Error ? failure.message : String(failure)
    expect(failureMessage).not.toContain('private-probe-secret')
    const rateLimitCalls = () => host.invocations().filter(({ args }) => args.includes('rate_limit'))
    await expect(host.call('rateLimit')).rejects.toMatchObject({ data: { reason: 'not_authenticated' } })
    expect(rateLimitCalls()).toHaveLength(1)

    await host.call('configure', { account: { host: 'github.com', user: 'bob' } })
    expect(await host.call('rateLimit')).toMatchObject({ core: { remaining: 4999 } })
    expect(rateLimitCalls()).toHaveLength(2)

    await host.call('configure', { account: { host: 'github.com', user: 'alice' } })
    await expect(host.call('rateLimit')).rejects.toMatchObject({ data: { reason: 'not_authenticated' } })
    expect(rateLimitCalls()).toHaveLength(2)
    expect(await host.call('rateLimit', { force: true })).toMatchObject({ core: { remaining: 4999 } })
    expect(rateLimitCalls()).toHaveLength(3)
  }, 20_000)

  test('GH08 PR lookup fails open when its rate-limit probe fails', async () => {
    const host = await boot()
    host.writeState({ responses: { rate_limit: { exitCode: 1, stderr: 'HTTP 401: bad credentials token=private-probe-secret' } } })
    const result = await host.call('review', { number: 11 })
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'upstream_unavailable' })
    expect(host.invocations().filter(({ args }) => args.includes('rate_limit'))).toHaveLength(1)
    expect(host.invocations().filter(({ args }) => args[0] === 'pr' && args[1] === 'view')).toHaveLength(1)
  }, 20_000)

})
