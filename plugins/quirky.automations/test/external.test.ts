import { afterEach, describe, expect, jest, test } from 'bun:test'
import { RpcErrorCode, type ProcessSpawner, type SpawnExit, type SpawnOptions, type SpawnedProcess, type StopOptions } from '@quirky/protocol'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { fakeAsks } from '../../quirky.repo/test/fakes/quirky.ask/main'
import type { ExternalAction, ExternalListResult, ExternalManager } from '../src/ui-contracts'
import { OpenClawCommandError, runOpenClawCommand } from '../src/external/command'

const fixtures: PluginHarness[] = []
const roots: string[] = []
const savedEnv = new Map<string, string | undefined>()

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

type ExternalFixture = {
  start(): Promise<PluginHarness>
  jobs(value: unknown): void
  installCli(): void
  log(): string[][]
  descendantPid(): number | null
}

function fixture(): ExternalFixture {
  const root = mkdtempSync(join(tmpdir(), 'quirky-external-test-'))
  roots.push(root)
  const home = join(root, 'home')
  const quirkyHome = join(root, 'quirky')
  const bin = join(root, 'bin')
  const cronDir = join(home, '.openclaw', 'cron')
  const jobsFile = join(cronDir, 'jobs.json')
  const logFile = join(root, 'openclaw-argv.jsonl')
  mkdirSync(cronDir, { recursive: true })
  mkdirSync(bin, { recursive: true })
  setEnv('HOME', home)
  setEnv('QUIRKY_HOME', quirkyHome)
  setEnv('PATH', bin)
  setEnv('OPENCLAW_JOBS_FILE', jobsFile)
  setEnv('OPENCLAW_LOG', logFile)
  setEnv('OPENCLAW_FAIL', undefined)
  setEnv('OPENCLAW_STALL', undefined)
  setEnv('OPENCLAW_LARGE_OUTPUT', undefined)
  setEnv('OPENCLAW_DESCENDANT_HOLD', undefined)
  const descendantPidFile = join(root, 'openclaw-descendant.pid')
  setEnv('OPENCLAW_DESCENDANT_PID_FILE', descendantPidFile)

  const envFixture: ExternalFixture = {
    async start() {
      const plugin = await startPluginHarness({ plugins: ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.checks', 'quirky.structured', 'quirky.session', 'quirky.automations'], fakeSession: false, fakeAsk: true, home: quirkyHome })
      fixtures.push(plugin)
      return plugin
    },
    jobs(value) {
      writeFileSync(jobsFile, typeof value === 'string' ? value : JSON.stringify(value))
    },
    installCli() {
      const binary = join(bin, 'openclaw')
      const source = `#!${process.execPath}\nconst fs = require('node:fs')\nconst args = process.argv.slice(2)\nfs.appendFileSync(process.env.OPENCLAW_LOG, JSON.stringify(args) + '\\n')\nif (process.env.OPENCLAW_LARGE_OUTPUT === '1') process.stdout.write('x'.repeat(100_000))\nif (process.env.OPENCLAW_STALL === '1') setInterval(() => {}, 1000)\nif (process.env.OPENCLAW_FAIL === '1') { process.stderr.write('fixture command failed'); process.exit(23) }\nconst file = process.env.OPENCLAW_JOBS_FILE\nconst root = JSON.parse(fs.readFileSync(file, 'utf8'))\nconst job = root.jobs.find((entry) => entry.id === args[2])\nif (!job) process.exit(3)\njob.state ??= {}\nif (args[1] === 'disable') job.enabled = false\nif (args[1] === 'enable') job.enabled = true\nif (args[1] === 'run') { job.state.lastStatus = 'ok'; job.state.lastRunAtMs = 1_800_000_000_000; job.state.runCount = (job.state.runCount ?? 0) + 1 }\nif (args[1] === 'rm') root.jobs = root.jobs.filter((entry) => entry.id !== args[2])\nfs.writeFileSync(file, JSON.stringify(root))\nif (process.env.OPENCLAW_DESCENDANT_HOLD === '1') {\n  const { spawn } = require('node:child_process')\n  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] })\n  fs.writeFileSync(process.env.OPENCLAW_DESCENDANT_PID_FILE, String(descendant.pid))\n  descendant.unref()\n}\n`
      writeFileSync(binary, source, { mode: 0o700 })
      chmodSync(binary, 0o700)
    },
    log() {
      try {
        return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
      } catch {
        return []
      }
    },
    descendantPid() {
      try {
        const pid = Number(readFileSync(descendantPidFile, 'utf8'))
        return Number.isInteger(pid) && pid > 0 ? pid : null
      } catch {
        return null
      }
    },
  }
  return envFixture
}

const clock = jest as typeof jest & { advanceTimersByTime(milliseconds: number): void }
const successfulExit: SpawnExit = { exitCode: 0, signal: null, durationMs: 1 }

type SpawnCall = { argv: readonly string[]; options: SpawnOptions }

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    }
  })
}

function controlledStream(): {
  stream: ReadableStream<Uint8Array>
  enqueue(chunk: Uint8Array): void
  close(): void
  fail(error: Error): void
  readonly cancelled: boolean
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancelled = false
  return {
    stream: new ReadableStream({
      start(value) { controller = value },
      cancel() { cancelled = true }
    }),
    enqueue(chunk) { controller?.enqueue(chunk) },
    close() { try { controller?.close() } catch {} },
    fail(error) { controller?.error(error) },
    get cancelled() { return cancelled }
  }
}

function makeScriptedSpawner(plan: {
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  exit?: SpawnExit
  exited?: Promise<SpawnExit>
  deferExit?: boolean
  throwOnSpawn?: Error
} = {}): {
  spawner: ProcessSpawner
  calls: SpawnCall[]
  stopCalls: StopOptions[]
  resolveExit(exit: SpawnExit): void
} {
  const calls: SpawnCall[] = []
  const stopCalls: StopOptions[] = []
  const deferredExit = Promise.withResolvers<SpawnExit>()
  const exited = plan.exited ?? (plan.deferExit ? deferredExit.promise : Promise.resolve(plan.exit ?? successfulExit))
  const spawner: ProcessSpawner = {
    spawn(argv, options) {
      calls.push({ argv: [...argv], options })
      if (plan.throwOnSpawn) throw plan.throwOnSpawn
      const child: SpawnedProcess = {
        pid: null,
        stdout: plan.stdout ?? byteStream(),
        stderr: plan.stderr ?? byteStream(),
        stderrTail: () => '',
        write: async () => true,
        closeInput: async () => {},
        exited,
        stop: async (options) => {
          stopCalls.push(options ?? {})
          return await exited
        }
      }
      return child
    }
  }
  return { spawner, calls, stopCalls, resolveExit: (exit) => deferredExit.resolve(exit) }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

const call = (harness: PluginHarness, method: string, params: Record<string, unknown> = {}) =>
  harness.client.callAny(method, params)

const managerOf = (result: ExternalListResult): ExternalManager => {
  const manager = result.managers[0]
  if (!manager) throw new Error('Expected a local OpenClaw manager')
  return manager
}

const oneJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  name: 'Daily review',
  enabled: true,
  schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'America/New_York' },
  payload: { kind: 'agentTurn', message: 'Review the repository.' },
  state: { nextRunAtMs: 1_800_000_000_000, lastRunAtMs: 1_799_000_000_000, lastStatus: 'ok', runCount: 4 },
  ...overrides
})

afterEach(async () => {
  for (const plugin of fixtures.splice(0)) await plugin.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
})

describe('external OpenClaw automation API', () => {
  test('maps bounded OpenClaw schedule, state, timestamps, preview, and newest-first runs', async () => {
    const env = fixture()
    const longPrompt = 'p'.repeat(140)
    env.jobs({ jobs: [
      oneJob({ id: 'once', name: '', schedule: { kind: 'at', at: '2026-10-28T12:00:00.000Z' }, payload: { message: longPrompt }, state: { nextRunAtMs: 1_800_000_000_000, lastRunAtMs: 1_799_000_000_000, lastStatus: 'failed', lastError: 'network', runCount: 9, runs: [{ startedAtMs: 1_799_000_000_000 }, { startedAtMs: 1_798_000_000_000 }] } }),
      oneJob({ id: 'every', schedule: { kind: 'every', everyMs: 90_000 }, enabled: false }),
      oneJob({ id: 'running', runningAtMs: 1_800_000_000_000, schedule: { kind: 'cron', expr: '15 8 * * 1', tz: 'UTC' } })
    ] })
    env.installCli()
    const plugin = await env.start()

    const result = await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult
    const manager = managerOf(result)

    expect(manager).toMatchObject({ id: 'openclaw:local', provider: 'openclaw', hostId: 'local', status: 'ready', canManage: true, error: null })
    expect(manager.jobs[0]).toMatchObject({
      id: 'once', name: `${'p'.repeat(117)}...`, schedule: 'at 2026-10-28T12:00:00.000Z', enabled: true,
      state: 'failed', promptPreview: `${'p'.repeat(117)}...`, nextRunAt: new Date(1_800_000_000_000).toISOString(),
      lastRunAt: new Date(1_799_000_000_000).toISOString(), lastStatus: 'failed', lastError: 'network', runCount: 9
    })
    expect(manager.jobs[0]?.runs.map((run) => run.startedAtMs)).toEqual([1_799_000_000_000, 1_798_000_000_000])
    expect(manager.jobs[1]).toMatchObject({ id: 'every', schedule: 'every 90s', enabled: false, state: 'disabled' })
    expect(manager.jobs[2]).toMatchObject({ id: 'running', schedule: 'cron 15 8 * * 1 @ UTC', state: 'running' })
  })

  test('returns no manager when neither the CLI nor jobs file exists', async () => {
    const env = fixture()
    const plugin = await env.start()

    expect(await call(plugin, 'quirky.automations/externalList', { noCache: true })).toEqual({ managers: [] })
  })

  test('reports jobs without a CLI as unavailable and read errors even without a CLI', async () => {
    const env = fixture()
    env.jobs({ jobs: [oneJob()] })
    const plugin = await env.start()

    const unavailable = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)
    expect(unavailable).toMatchObject({ status: 'unavailable', canManage: false, error: expect.stringContaining('not on PATH') })
    expect(unavailable.jobs).toHaveLength(1)

    env.jobs('{malformed')
    const readError = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)
    expect(readError).toMatchObject({ status: 'unavailable', canManage: false, error: expect.stringContaining('JSON') })
  })

  test('shows malformed, oversized, over-deep, over-token, and over-limit files as unavailable', async () => {
    const env = fixture()
    const plugin = await env.start()
    const malformedCases = [
      ['malformed JSON', '{bad', 'JSON'],
      ['oversized file', ' '.repeat(8 * 1024 * 1024 + 1), '8 MiB'],
      ['excess nesting', `{"jobs":[],"nested":${'['.repeat(129)}0${']'.repeat(129)}}`, 'depth 128'],
      ['token budget', `{"jobs":[${'null,'.repeat(500_000)}null]}`, '1,000,000'],
      ['job limit', JSON.stringify({ jobs: Array.from({ length: 10_001 }, (_, index) => ({ id: `task-${index}` })) }), '10,000']
    ] as const

    for (const [name, content, expected] of malformedCases) {
      env.jobs(content)
      const manager = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)
      expect(manager.status, name).toBe('unavailable')
      expect(manager.canManage, name).toBe(false)
      expect(manager.error, name).toContain(expected)
    }
  })

  test('uses captured local owners, fixed argv, cache invalidation, and readback after every action', async () => {
    const env = fixture()
    env.jobs({ jobs: [oneJob()] })
    env.installCli()
    const plugin = await env.start()
    let manager = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)

    expect(await call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1', action: 'pause' })).toEqual({ ok: true })
    manager = managerOf(await call(plugin, 'quirky.automations/externalList') as ExternalListResult)
    expect(manager.jobs[0]?.state).toBe('disabled')
    await call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1', action: 'resume' })
    manager = managerOf(await call(plugin, 'quirky.automations/externalList') as ExternalListResult)
    await call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1', action: 'run' })
    manager = managerOf(await call(plugin, 'quirky.automations/externalList') as ExternalListResult)
    expect(manager.jobs[0]).toMatchObject({ state: 'ok', runCount: 5 })

    const confirmationError = await call(plugin, 'quirky.automations/externalAction', {
      owner: manager.owner, jobId: 'task-1', action: 'delete'
    }).then(() => null, (error: unknown) => error as { code?: unknown; data?: { askId?: unknown } })
    expect(confirmationError).toMatchObject({ code: RpcErrorCode.ConfirmationRequired })
    const askId = confirmationError?.data?.askId
    if (typeof askId !== 'string') throw new Error('Delete confirmation did not create an ask')
    const ask = fakeAsks().get(askId)
    if (!ask) throw new Error('Delete confirmation ask was not recorded')
    ask.status = 'answered'
    ask.value = true
    await call(plugin, 'quirky.automations/externalAction', {
      owner: manager.owner, jobId: 'task-1', action: 'delete', confirmation: askId
    })

    expect(managerOf(await call(plugin, 'quirky.automations/externalList') as ExternalListResult).jobs).toEqual([])
    expect(env.log()).toEqual([
      ['cron', 'disable', 'task-1'], ['cron', 'enable', 'task-1'], ['cron', 'run', 'task-1'], ['cron', 'rm', 'task-1']
    ])
  })

  test('rejects unsafe IDs, unsupported providers or hosts, unknown actions, and stale owners before spawning', async () => {
    const env = fixture()
    env.jobs({ jobs: [oneJob({ id: 'bad/../../id' }), oneJob({ id: 'task-1' })] })
    env.installCli()
    const plugin = await env.start()
    const manager = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)

    await expect(call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'bad/../../id', action: 'run' })).rejects.toThrow(/safe|invalid|identifier/i)
    await expect(call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1\n', action: 'run' })).rejects.toThrow(/safe|invalid|identifier/i)
    await expect(call(plugin, 'quirky.automations/externalAction', { owner: { ...manager.owner, provider: 'other' }, jobId: 'task-1', action: 'run' })).rejects.toThrow(/provider|unsupported/i)
    await expect(call(plugin, 'quirky.automations/externalAction', { owner: { ...manager.owner, hostId: 'ssh:remote' }, jobId: 'task-1', action: 'run' })).rejects.toThrow(/local|remote|unsupported/i)
    await expect(call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1', action: 'shell' })).rejects.toThrow()
    env.jobs({ jobs: [oneJob({ name: 'Replaced' })] })
    await expect(call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1', action: 'run' })).rejects.toThrow(/changed|stale|refresh/i)
    const currentOwner = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult).owner
    const executable = join(process.env.PATH ?? '', 'openclaw')
    rmSync(executable)
    env.installCli()
    await expect(call(plugin, 'quirky.automations/externalAction', { owner: currentOwner, jobId: 'task-1', action: 'run' })).rejects.toThrow(/changed|stale|refresh/i)
    expect(env.log()).toEqual([])
    await expect(call(plugin, 'quirky.automations/externalList', { hostId: 'ssh:remote', noCache: true })).rejects.toThrow(/local|remote|unsupported/i)
  })

  test('returns a delete confirmation description and does not execute a process while describing', async () => {
    const env = fixture()
    env.jobs({ jobs: [oneJob()] })
    env.installCli()
    const plugin = await env.start()
    const manager = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)

    const description = await call(plugin, 'quirky.automations/externalActionDescribe', {
      owner: manager.owner, jobId: 'task-1', action: 'delete'
    })
    const reversible = await call(plugin, 'quirky.automations/externalActionDescribe', {
      owner: manager.owner, jobId: 'task-1', action: 'pause'
    })

    expect(description).toContain('Daily review')
    expect(reversible).toBeNull()
    expect(env.log()).toEqual([])
  })

  test('surfaces command failures and bounded-output failures without optimistic success', async () => {
    const env = fixture()
    env.jobs({ jobs: [oneJob()] })
    env.installCli()
    const plugin = await env.start()
    const manager = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)

    setEnv('OPENCLAW_FAIL', '1')
    await expect(call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1', action: 'pause' })).rejects.toThrow('fixture command failed')
    setEnv('OPENCLAW_FAIL', undefined)
    setEnv('OPENCLAW_LARGE_OUTPUT', '1')
    await expect(call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1', action: 'pause' })).rejects.toThrow(/output.*limit|limit.*output/i)
    expect(env.log()).toEqual([['cron', 'disable', 'task-1'], ['cron', 'disable', 'task-1']])
  })

  // This integration test exercises the real subprocess deadline; fake timers cannot advance the child process lifetime.
  test('times out a stalled OpenClaw command at the fixed action deadline', async () => {
    const env = fixture()
    env.jobs({ jobs: [oneJob()] })
    env.installCli()
    const plugin = await env.start()
    const manager = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)
    setEnv('OPENCLAW_STALL', '1')

    await expect(call(plugin, 'quirky.automations/externalAction', { owner: manager.owner, jobId: 'task-1', action: 'run' })).rejects.toThrow(/timed out|timeout/i)
    expect(env.log()).toEqual([['cron', 'run', 'task-1']])
  }, 45_000)
  test('spawns each action with exact OpenClaw argv and process options', async () => {
    const cases: Array<{ action: ExternalAction; command: string }> = [
      { action: 'pause', command: 'disable' },
      { action: 'resume', command: 'enable' },
      { action: 'run', command: 'run' },
      { action: 'delete', command: 'rm' }
    ]
    for (const { action, command } of cases) {
      const { spawner, calls } = makeScriptedSpawner()
      await runOpenClawCommand(spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', action)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        argv: ['/opt/openclaw', 'cron', command, 'job_123'],
        options: {
          cwd: '/Users/test/.openclaw',
          env: process.env,
          timeoutMs: 30_000,
          killGraceMs: 0,
          stderr: 'pipe'
        }
      })
      expect(calls[0]?.options.env).toBe(process.env)
      expect(Object.keys(calls[0]!.options).sort()).toEqual(['cwd', 'env', 'killGraceMs', 'stderr', 'timeoutMs'])
    }
  })

  test('rejects unsafe IDs asynchronously and throws for unsupported actions synchronously before spawning', async () => {
    const { spawner, calls } = makeScriptedSpawner()
    for (const jobId of ['bad/../../id', 'task-1\n']) {
      const pending = runOpenClawCommand(spawner, '/opt/openclaw', '/Users/test/.openclaw', jobId, 'run')
      const error = await pending.catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(OpenClawCommandError)
      expect(error).toMatchObject({
        message: 'OpenClaw job ID must use only letters, numbers, dot, underscore, colon, or hyphen'
      })
    }
    expect(() => runOpenClawCommand(spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'shell' as ExternalAction))
      .toThrow('Unsupported OpenClaw action')
    expect(calls).toEqual([])
  })

  test('counts raw bytes across both streams at N-1 and N, including BOM and invalid UTF-8', async () => {
    const ascii = (length: number) => new Uint8Array(length).fill(0x61)
    const cases = [
      { stdout: [ascii(32_768)], stderr: [ascii(32_767)] },
      { stdout: [Uint8Array.of(0xef), Uint8Array.of(0xbb, 0xbf)], stderr: [ascii(65_533)] },
      { stdout: [Uint8Array.of(0xff)], stderr: [ascii(65_535)] }
    ]
    for (const { stdout, stderr } of cases) {
      const scripted = makeScriptedSpawner({
        stdout: byteStream(...stdout),
        stderr: byteStream(...stderr)
      })
      await runOpenClawCommand(scripted.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run')
      expect(scripted.stopCalls).toEqual([])
    }
  })

  test('stops both streams on N+1 raw bytes across stream chunks and BOM output', async () => {
    const ascii = (length: number) => new Uint8Array(length).fill(0x61)
    const cases = [
      {
        stdout: [ascii(16_384), ascii(16_384)],
        stderr: [ascii(32_768), ascii(1)]
      },
      {
        stdout: [Uint8Array.of(0xef, 0xbb, 0xbf)],
        stderr: [ascii(65_534)]
      }
    ]
    for (const { stdout: stdoutChunks, stderr: stderrChunks } of cases) {
      const stdout = controlledStream()
      const stderr = controlledStream()
      const scripted = makeScriptedSpawner({ stdout: stdout.stream, stderr: stderr.stream })
      const pending = runOpenClawCommand(scripted.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run')
      await flushMicrotasks()
      for (const chunk of stdoutChunks) stdout.enqueue(chunk)
      for (const chunk of stderrChunks) stderr.enqueue(chunk)
      await expect(pending).rejects.toThrow('OpenClaw output exceeded the 65536-byte limit')
      expect(scripted.stopCalls).toEqual([{ signal: 'SIGKILL' }])
      expect(stdout.cancelled).toBe(true)
      expect(stderr.cancelled).toBe(true)
    }
  })

  test('reports synchronous runner errors and spawnError exits as start failures', async () => {
    const synchronous = makeScriptedSpawner({ throwOnSpawn: new Error('Process runner is disposed') })
    await expect(runOpenClawCommand(synchronous.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run'))
      .rejects.toThrow('Could not start OpenClaw: Process runner is disposed')

    const spawnError = makeScriptedSpawner({
      exit: {
        exitCode: null,
        signal: null,
        durationMs: 1,
        spawnError: {
          code: 'ENOENT',
          message: "ENOENT: no such file or directory, posix_spawn '/nonexistent/openclaw'"
        }
      }
    })
    await expect(runOpenClawCommand(spawnError.spawner, '/nonexistent/openclaw', '/Users/test/.openclaw', 'job_123', 'run'))
      .rejects.toThrow("Could not start OpenClaw: ENOENT: no such file or directory, posix_spawn '/nonexistent/openclaw'")
  })

  test('prefers trimmed stderr diagnostics and falls back to stdout', async () => {
    const cases = [
      {
        exit: { exitCode: 2, signal: null, durationMs: 1 },
        stdout: 'other output',
        stderr: '  bad flag \n',
        expected: 'OpenClaw cron run job_123 exited with status 2: bad flag'
      },
      {
        exit: { exitCode: null, signal: 'SIGTERM', durationMs: 1 },
        stdout: ' fallback detail \n',
        stderr: ' \n\t ',
        expected: 'OpenClaw cron run job_123 terminated by SIGTERM: fallback detail'
      }
    ] satisfies Array<{ exit: SpawnExit; stdout: string; stderr: string; expected: string }>
    for (const { exit, stdout, stderr, expected } of cases) {
      const scripted = makeScriptedSpawner({
        exit,
        stdout: byteStream(new TextEncoder().encode(stdout)),
        stderr: byteStream(new TextEncoder().encode(stderr))
      })
      await expect(runOpenClawCommand(scripted.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run'))
        .rejects.toThrow(expected)
    }
  })

  test('handles a runner timeout after leader exit while stream drains remain open', async () => {
    jest.useFakeTimers()
    const stdout = controlledStream()
    const stderr = controlledStream()
    const scripted = makeScriptedSpawner({
      exit: { exitCode: null, signal: 'SIGTERM', stopped: 'timeout', durationMs: 1 },
      stdout: stdout.stream,
      stderr: stderr.stream
    })
    try {
      const pending = runOpenClawCommand(scripted.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run')
      const rejection = expect(pending).rejects.toThrow('OpenClaw command timed out after 30 seconds')
      await flushMicrotasks()
      expect(scripted.stopCalls).toEqual([{ signal: 'SIGKILL' }])
      expect(stdout.cancelled).toBe(true)
      expect(stderr.cancelled).toBe(true)
      await rejection
    } finally {
      clock.advanceTimersByTime(30_000)
      jest.useRealTimers()
    }
  })

  test('enforces its call-local deadline after the leader exits while output drains remain open', async () => {
    jest.useFakeTimers()
    try {
      const stdout = controlledStream()
      const stderr = controlledStream()
      const scripted = makeScriptedSpawner({ stdout: stdout.stream, stderr: stderr.stream })
      const pending = runOpenClawCommand(scripted.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run')
      await flushMicrotasks()
      clock.advanceTimersByTime(30_000)
      await expect(pending).rejects.toThrow('OpenClaw command timed out after 30 seconds')
      expect(scripted.stopCalls).toEqual([{ signal: 'SIGKILL' }])
      expect(stdout.cancelled).toBe(true)
      expect(stderr.cancelled).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  test('fails closed when a stream rejects before leader exit', async () => {
    const stdout = controlledStream()
    const stderr = controlledStream()
    const scripted = makeScriptedSpawner({ stdout: stdout.stream, stderr: stderr.stream, deferExit: true })
    const pending = runOpenClawCommand(scripted.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run')
    const outcome = pending.then(() => null, (error: unknown) => error)
    try {
      stdout.fail(new Error('pipe broke'))
      await flushMicrotasks()
      expect(scripted.stopCalls).toEqual([{ signal: 'SIGKILL' }])
      expect(stderr.cancelled).toBe(true)
    } finally {
      stderr.close()
      scripted.resolveExit(successfulExit)
    }
    const error = await outcome
    expect(error).toBeInstanceOf(OpenClawCommandError)
    expect(error).toMatchObject({ message: 'OpenClaw cron run job_123 output stream failed: pipe broke' })
  })
  test('fails closed when a stream rejects after leader exit while the other drain is pending', async () => {
    const stdout = controlledStream()
    const stderr = controlledStream()
    const scripted = makeScriptedSpawner({ stdout: stdout.stream, stderr: stderr.stream })
    const pending = runOpenClawCommand(scripted.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run')
    const outcome = pending.then(() => null, (error: unknown) => error)
    try {
      await flushMicrotasks()
      stderr.fail(new Error('pipe broke'))
      await flushMicrotasks()
      expect(scripted.stopCalls).toEqual([{ signal: 'SIGKILL' }])
      expect(stdout.cancelled).toBe(true)
    } finally {
      stdout.close()
    }
    const error = await outcome
    expect(error).toBeInstanceOf(OpenClawCommandError)
    expect(error).toMatchObject({ message: 'OpenClaw cron run job_123 output stream failed: pipe broke' })
  })


  test('fails closed when a successful leader leaves the process group alive', async () => {
    const scripted = makeScriptedSpawner({
      exit: { ...successfulExit, groupSurvived: true },
      stdout: byteStream(),
      stderr: byteStream()
    })
    await expect(runOpenClawCommand(scripted.spawner, '/opt/openclaw', '/Users/test/.openclaw', 'job_123', 'run'))
      .rejects.toThrow('OpenClaw cron run job_123 process group could not be stopped')
  })

  test('kills a pipe-holding OpenClaw descendant immediately after leader success', async () => {
    const env = fixture()
    env.jobs({ jobs: [oneJob()] })
    env.installCli()
    const plugin = await env.start()
    const manager = managerOf(await call(plugin, 'quirky.automations/externalList', { noCache: true }) as ExternalListResult)
    setEnv('OPENCLAW_DESCENDANT_HOLD', '1')
    const startedAt = performance.now()
    const action = call(plugin, 'quirky.automations/externalAction', {
      owner: manager.owner, jobId: 'task-1', action: 'run'
    })
    void action.catch(() => {})
    const deadlineResult = Promise.withResolvers<never>()
    const deadline = setTimeout(() => deadlineResult.reject(new Error('OpenClaw action did not reap its descendant within 2 seconds')), 2_000)
    try {
      // This real subprocess integration needs a wall-clock guard; fake timers cannot drive OS pipe closure.
      const result = await Promise.race([action, deadlineResult.promise])
      expect(result).toEqual({ ok: true })
      expect(performance.now() - startedAt).toBeLessThan(2_000)
      expect(env.log()).toEqual([['cron', 'run', 'task-1']])
    } finally {
      clearTimeout(deadline)
      const pid = env.descendantPid()
      if (pid !== null) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
      await action.catch(() => undefined)
    }
  }, 5_000)

})
