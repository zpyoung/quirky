import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[], env: Record<string, string> = {}) => runCli(args, { home: daemon.home, env })

const LOS_ANGELES = { TZ: 'America/Los_Angeles' }

describe('job list', () => {
  test('renders ID PLUGIN INTERVAL STATE NEXT LAST', async () => {
    daemon.addJob('job:acme.poll/tick', { intervalMs: 300_000, nextRunAt: 1_700_000_000_000 })
    daemon.addJob('job:acme.poll/sweep', {
      intervalMs: 90_000,
      state: 'running',
      lastRun: { startedAt: 1_699_000_000_000, finishedAt: 1_699_000_005_000, status: 'failed', error: 'boom' }
    })
    daemon.addJob('job:acme.poll/ok', {
      intervalMs: 3_600_000,
      nextRunAt: 1_700_000_100_000,
      lastRun: { startedAt: 1_699_000_000_000, finishedAt: 1_699_000_001_000, status: 'ok' }
    })
    const result = await run(['job', 'list'], LOS_ANGELES)
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('job.list')).toEqual([{}])
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0].split(/\s+/)).toEqual(['ID', 'PLUGIN', 'INTERVAL', 'STATE', 'NEXT', 'LAST'])
    expect(lines[1].split(/\s+/)).toEqual(['job:acme.poll/tick', 'acme.poll', '5m', 'idle', '2023-11-14T14:13:20-08:00', '-'])
    expect(lines[2].split(/\s+/)).toEqual([
      'job:acme.poll/sweep',
      'acme.poll',
      '90s',
      'running',
      '-',
      'failed',
      '2023-11-03T01:26:45-07:00' + ':',
      'boom'
    ])
    expect(lines[3].split(/\s+/)).toEqual([
      'job:acme.poll/ok',
      'acme.poll',
      '1h',
      'idle',
      '2023-11-14T14:15:00-08:00',
      'ok',
      '2023-11-03T01:26:41-07:00'
    ])
  })

  test.each([
    ['America/Los_Angeles', '2023-11-14T14:13:20-08:00', '2023-11-03T01:26:45-07:00'],
    ['Asia/Kolkata', '2023-11-15T03:43:20+05:30', '2023-11-03T13:56:45+05:30'],
    ['UTC', '2023-11-14T22:13:20+00:00', '2023-11-03T08:26:45+00:00']
  ])('prints local ISO times with the UTC offset in %s', async (tz, next, last) => {
    daemon.addJob('job:acme.poll/tick', {
      nextRunAt: 1_700_000_000_000,
      lastRun: { startedAt: 1_699_000_000_000, finishedAt: 1_699_000_005_000, status: 'ok' }
    })
    const row = (await run(['job', 'list'], { TZ: tz })).stdout.trimEnd().split('\n')[1].split(/\s+/)
    expect(row.slice(4)).toEqual([next, 'ok', last])
  })

  test('says so when there are no jobs', async () => {
    expect((await run(['job', 'list'])).stdout).toBe('no jobs\n')
  })

  test('--json prints the raw result', async () => {
    const job = daemon.addJob('job:acme.poll/tick', { nextRunAt: 5 })
    const result = await run(['job', 'list', '--json'])
    expect(JSON.parse(result.stdout)).toEqual([job])
  })
})

describe('job run', () => {
  test('sends the id and prints status and duration, exiting 0 for an ok run', async () => {
    daemon.addJob('job:acme.poll/tick')
    const result = await run(['job', 'run', 'job:acme.poll/tick'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('job.run')).toEqual([{ id: 'job:acme.poll/tick' }])
    expect(result.stdout).toBe('job:acme.poll/tick ok in 42 ms\n')
  })

  test('exits 1 and prints the error for a failed run', async () => {
    daemon.addJob('job:acme.poll/tick')
    daemon.jobRuns.set('job:acme.poll/tick', { startedAt: 10, finishedAt: 25, status: 'failed', error: 'boom' })
    const result = await run(['job', 'run', 'job:acme.poll/tick'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('job:acme.poll/tick failed in 15 ms: boom\n')
  })

  test('exits 1 for a timed-out run', async () => {
    daemon.addJob('job:acme.poll/tick')
    daemon.jobRuns.set('job:acme.poll/tick', { startedAt: 0, finishedAt: 1000, status: 'timed-out', error: 'timed out' })
    expect((await run(['job', 'run', 'job:acme.poll/tick'])).code).toBe(1)
  })

  test('--json prints the run unchanged, still exiting 1 when it failed', async () => {
    daemon.addJob('job:acme.poll/tick')
    const failed = { startedAt: 10, finishedAt: 25, status: 'failed' as const, error: 'boom' }
    daemon.jobRuns.set('job:acme.poll/tick', failed)
    const result = await run(['job', 'run', 'job:acme.poll/tick', '--json'])
    expect(JSON.parse(result.stdout)).toEqual(failed)
    expect(result.code).toBe(1)
  })

  test('an unknown job is a runtime error', async () => {
    const result = await run(['job', 'run', 'job:acme.poll/missing'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unknown job job:acme.poll/missing')
  })

  test('requires an id', async () => {
    const result = await run(['job', 'run'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing <id>')
  })
})
