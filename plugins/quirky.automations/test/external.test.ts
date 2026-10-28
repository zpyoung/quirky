import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { fakeAsks } from '../../quirky.repo/test/fakes/quirky.ask/main'
import type { ExternalListResult, ExternalManager } from '../src/ui-contracts'

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
      const source = `#!${process.execPath}\nconst fs = require('node:fs')\nconst args = process.argv.slice(2)\nfs.appendFileSync(process.env.OPENCLAW_LOG, JSON.stringify(args) + '\\n')\nif (process.env.OPENCLAW_LARGE_OUTPUT === '1') process.stdout.write('x'.repeat(100_000))\nif (process.env.OPENCLAW_STALL === '1') setInterval(() => {}, 1000)\nif (process.env.OPENCLAW_FAIL === '1') { process.stderr.write('fixture command failed'); process.exit(23) }\nconst file = process.env.OPENCLAW_JOBS_FILE\nconst root = JSON.parse(fs.readFileSync(file, 'utf8'))\nconst job = root.jobs.find((entry) => entry.id === args[2])\nif (!job) process.exit(3)\njob.state ??= {}\nif (args[1] === 'disable') job.enabled = false\nif (args[1] === 'enable') job.enabled = true\nif (args[1] === 'run') { job.state.lastStatus = 'ok'; job.state.lastRunAtMs = 1_800_000_000_000; job.state.runCount = (job.state.runCount ?? 0) + 1 }\nif (args[1] === 'rm') root.jobs = root.jobs.filter((entry) => entry.id !== args[2])\nfs.writeFileSync(file, JSON.stringify(root))\n`
      writeFileSync(binary, source, { mode: 0o700 })
      chmodSync(binary, 0o700)
    },
    log() {
      try {
        return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
      } catch {
        return []
      }
    }
  }
  return envFixture
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
})
