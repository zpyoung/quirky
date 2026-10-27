import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { QuirkyClient, RpcErrorCode, type JobInfo, type PluginInfo } from '@quirky/protocol'
import { Store } from '../../src/store'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, waitForFile, writeModulePlugin, type ModuleBehavior } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>
type Plugin = { manifest: Manifest; behavior?: ModuleBehavior }

const jobId = (name: string) => `job:acme.poll/${name}`
const SECOND = 1000
const HOUR = 3_600_000

/** Starts a daemon that rechecks its job timers every 50 ms, over plugins installed under its home. */
async function boot(plugins: Plugin[] | ((marker: string) => Plugin[]), options: { home?: string } = {}) {
  const home = options.home ?? makeTempHome()
  const scratch = makeTempDir()
  const marker = join(scratch, 'marker.log')
  for (const { manifest, behavior } of typeof plugins === 'function' ? plugins(marker) : plugins) {
    writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  }
  const harness = await startHarness({ home, builtinPluginsDir: null, schedulerRecheckMs: 50 })
  h = harness
  const client = await harness.connect()
  const lines = () => readMarker(marker)
  return {
    harness,
    client,
    scratch,
    marker,
    lines,
    count: (prefix: string) => lines().filter((line) => line === prefix).length,
    jobs: () => client.call('job.list', {}) as Promise<JobInfo[]>,
    job: async (name: string) => (await (client.call('job.list', {}) as Promise<JobInfo[]>)).find((job) => job.id === jobId(name)),
    plugin: async (id: string) => ((await client.call('plugin.list', {})) as PluginInfo[]).find((plugin) => plugin.id === id)
  }
}

async function rejection(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

const run = (client: QuirkyClient, id: string) => client.call('job.run', { id })

describe('jobs', () => {
  test('SC-16: a job runs on its interval, and its lazy plugin loads only when it first runs', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.poll', contributes: { job: [{ id: 'tick', interval: '1s' }] } },
        behavior: { activate: `context.provide('job:acme.poll/tick', () => record('tick'))` }
      }
    ])
    expect(s.lines()).toEqual([])
    expect((await s.plugin('acme.poll'))?.state).not.toBe('active')
    const [listed] = await s.jobs()
    expect(listed).toMatchObject({ id: jobId('tick'), plugin: 'acme.poll', intervalMs: SECOND, state: 'idle', lastRun: null })

    const job = await waitForAsync(async () => {
      const found = await s.job('tick')
      return found?.lastRun?.status === 'ok' && found
    })
    const lines = s.lines()
    expect(lines.slice(0, 3)).toEqual(['import acme.poll', 'activate acme.poll', 'tick'])
    expect(lines.filter((line) => line === 'tick').length).toBeGreaterThanOrEqual(1)
    expect((await s.plugin('acme.poll'))?.state).toBe('active')
    expect(job.lastRun).toMatchObject({ status: 'ok' })
    expect(job.lastRun?.finishedAt).not.toBeNull()
  })

  test('SC-17: a job’s runs never overlap', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.poll', contributes: { job: [{ id: 'slow', interval: '1s' }] } },
        behavior: {
          activate: `context.provide('job:acme.poll/slow', async () => {
            record('start ' + Date.now())
            await Bun.sleep(3000)
            record('end ' + Date.now())
          })`
        }
      }
    ])
    // first run starts at 1s and ends at 4s, the second may start from 5s
    await waitFor(() => s.lines().filter((line) => line.startsWith('start ')).length >= 2, 7000)
    const events = s.lines().flatMap((line) => {
      const [kind, at] = line.split(' ')
      return kind === 'start' || kind === 'end' ? [{ kind, at: Number(at) }] : []
    })
    let inProgress = 0
    let lastEnd: number | null = null
    for (const event of events) {
      if (event.kind === 'start') {
        inProgress += 1
        expect(inProgress).toBe(1)
        if (lastEnd !== null) expect(event.at - lastEnd).toBeGreaterThanOrEqual(SECOND - 10)
      } else {
        inProgress -= 1
        lastEnd = event.at
      }
    }
    expect(events.filter((event) => event.kind === 'start').length).toBe(2)
    expect(events.filter((event) => event.kind === 'end').length).toBe(1)
    expect(await s.job('slow')).toMatchObject({ state: 'running', nextRunAt: null })
  }, 15_000)

  test('SC-18: a job can be run now, and failures are recorded without stopping the schedule', async () => {
    const s = await boot((marker) => {
      const gate = join(dirname(marker), 'gate')
      return [
        {
          manifest: { id: 'acme.poll', contributes: { job: [{ id: 'flaky', interval: '1h' }] } },
          behavior: {
            activate: `
              let n = 0
              context.provide('job:acme.poll/flaky', async () => {
                n += 1
                if (n === 1) throw new Error('upstream down')
                if (n === 3) {
                  record('blocked')
                  ${waitForFile(gate)}
                }
              })`
          }
        }
      ]
    })
    const id = jobId('flaky')

    const first = await run(s.client, id)
    expect(first).toMatchObject({ status: 'failed', error: 'upstream down' })
    expect(await s.job('flaky')).toMatchObject({ state: 'idle', lastRun: { status: 'failed', error: 'upstream down' } })

    const second = await run(s.client, id)
    expect(second).toMatchObject({ status: 'ok' })
    expect(second.error).toBeUndefined()
    expect(await s.job('flaky')).toMatchObject({ state: 'idle', lastRun: { status: 'ok' } })

    const third = run(s.client, id)
    await waitFor(() => s.lines().includes('blocked'))
    expect(await s.job('flaky')).toMatchObject({ state: 'running' })
    expect(await rejection(run(s.client, id))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'job:acme.poll/flaky is already running'
    })
    writeFileSync(join(s.scratch, 'gate'), '')
    expect(await third).toMatchObject({ status: 'ok' })
    expect(await s.job('flaky')).toMatchObject({ state: 'idle', lastRun: { status: 'ok' } })
  })

  test('SC-19: a job that overruns its timeout is told to stop', async () => {
    const s = await boot([
      {
        manifest: {
          id: 'acme.poll',
          contributes: {
            job: [
              { id: 'hang', interval: '2s', timeout: '1s' },
              { id: 'stubborn', interval: '1s', timeout: '1s' }
            ]
          }
        },
        behavior: {
          activate: `
            context.provide('job:acme.poll/hang', async ({ signal }: { signal: AbortSignal }) => {
              record('start hang')
              await new Promise((resolve) => signal.addEventListener('abort', resolve))
              record('aborted hang')
            })
            context.provide('job:acme.poll/stubborn', async () => {
              record('start stubborn')
              await Bun.sleep(3000)
              record('end stubborn')
            })`
        }
      }
    ])
    const startedAt = Date.now()
    const [hang, stubborn] = await Promise.all([run(s.client, jobId('hang')), run(s.client, jobId('stubborn'))])
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
    expect(hang).toMatchObject({ status: 'timed-out', error: 'timed out after 1000 ms' })
    expect(stubborn).toMatchObject({ status: 'timed-out', error: 'timed out after 1000 ms' })

    // hang honoured its signal: its run settles at once and the job is armed one interval later
    await waitFor(() => s.lines().includes('aborted hang'))
    const hangJob = await waitForAsync(async () => {
      const found = await s.job('hang')
      return found?.state === 'idle' && found
    })
    expect(hangJob.lastRun?.status).toBe('timed-out')
    expect(hangJob.nextRunAt).toBe(hangJob.lastRun!.finishedAt! + 2 * SECOND)
    expect(hangJob.lastRun!.finishedAt!).toBeGreaterThanOrEqual(hang.finishedAt!)

    // stubborn ignores its signal: it stays running, and no second run starts, until it returns
    expect(await s.job('stubborn')).toMatchObject({ state: 'running', nextRunAt: null, lastRun: { status: 'timed-out' } })
    await Bun.sleep(1500)
    expect(await s.job('stubborn')).toMatchObject({ state: 'running', nextRunAt: null })
    expect(s.count('start stubborn')).toBe(1)
    expect(await rejection(run(s.client, jobId('stubborn')))).toMatchObject({ code: RpcErrorCode.Conflict })

    await waitFor(() => s.lines().includes('end stubborn'), 4000)
    const stubbornJob = await waitForAsync(async () => {
      const found = await s.job('stubborn')
      return found?.state === 'idle' && found
    })
    expect(stubbornJob.lastRun?.status).toBe('timed-out')
    expect(stubbornJob.lastRun!.finishedAt!).toBeGreaterThan(stubborn.finishedAt! + 1500)
    expect(stubbornJob.nextRunAt).toBe(stubbornJob.lastRun!.finishedAt! + SECOND)
    expect(s.count('start stubborn')).toBe(1)
  }, 15_000)

  test('SC-20: disabling a job or its plugin stops it, and enabling resumes it', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.poll', contributes: { job: [{ id: 'tick', interval: '1s' }, { id: 'hold', interval: '1s' }] } },
        behavior: {
          activate: `
            context.provide('job:acme.poll/tick', () => record('tick'))
            context.provide('job:acme.poll/hold', async ({ signal }: { signal: AbortSignal }) => {
              record('start hold')
              await new Promise((resolve) => signal.addEventListener('abort', resolve))
              record('aborted hold')
            })`
        }
      }
    ])
    await waitFor(() => s.count('tick') >= 1 && s.count('start hold') >= 1, 4000)
    expect((await s.jobs()).map((job) => job.id)).toEqual([jobId('hold'), jobId('tick')])

    // a job-level disable stops that job alone
    await s.client.call('plugin.disable', { id: jobId('tick') })
    const ticksWhenDisabled = s.count('tick')
    await Bun.sleep(2000)
    expect(s.count('tick')).toBe(ticksWhenDisabled)
    expect((await s.jobs()).map((job) => job.id)).toEqual([jobId('hold')])
    expect(s.count('aborted hold')).toBe(0)

    await s.client.call('plugin.enable', { id: jobId('tick') })
    await waitFor(() => s.count('tick') > ticksWhenDisabled, 3000)
    expect((await s.jobs()).map((job) => job.id)).toEqual([jobId('hold'), jobId('tick')])

    // a plugin-level disable aborts the run in progress and stops every job
    expect(await s.job('hold')).toMatchObject({ state: 'running' })
    await s.client.call('plugin.disable', { id: 'acme.poll' })
    await waitFor(() => s.lines().includes('aborted hold'))
    expect(await s.jobs()).toEqual([])
    const ticksWhenPluginDisabled = s.count('tick')
    await Bun.sleep(1500)
    expect(s.count('tick')).toBe(ticksWhenPluginDisabled)
    expect(s.count('start hold')).toBe(1)
    expect(await s.jobs()).toEqual([])
    expect(await rejection(run(s.client, jobId('tick')))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: `no job ${jobId('tick')} is in effect`
    })
  }, 20_000)

  test('SC-21: an overdue job runs once after a restart, and a job not yet due waits', async () => {
    const home = makeTempHome()
    const seededAt = Date.now()
    const store = new Store(join(home, 'quirky.db'))
    store.recordJobStart(jobId('daily'), seededAt - 25 * HOUR - 1000)
    store.recordJobFinish(jobId('daily'), seededAt - 25 * HOUR, 'ok')
    store.recordJobStart(jobId('hourly'), seededAt - 10 * 60_000 - 1000)
    store.recordJobFinish(jobId('hourly'), seededAt - 10 * 60_000, 'ok')
    store.close()

    const s = await boot(
      [
        {
          manifest: { id: 'acme.poll', contributes: { job: [{ id: 'daily', interval: '24h' }, { id: 'hourly', interval: '1h' }] } },
          behavior: {
            activate: `
              context.provide('job:acme.poll/daily', () => record('daily'))
              context.provide('job:acme.poll/hourly', () => record('hourly'))`
          }
        }
      ],
      { home }
    )
    const daily = await waitForAsync(async () => {
      const found = await s.job('daily')
      return found?.state === 'idle' && found.lastRun?.status === 'ok' && found.lastRun.startedAt >= seededAt && found
    })
    // Observe real post-restart timers through the daemon API; job.list cannot advance its clock.
    await Bun.sleep(500)
    expect(s.count('daily')).toBe(1)
    expect(s.count('hourly')).toBe(0)

    const hourly = (await s.job('hourly'))!
    expect(hourly.state).toBe('idle')
    expect(hourly.lastRun).toMatchObject({ status: 'ok', finishedAt: seededAt - 10 * 60_000 })
    expect(Math.abs(hourly.nextRunAt! - (seededAt + 50 * 60_000))).toBeLessThan(5000)
    expect(Math.abs(hourly.nextRunAt! - (Date.now() + 50 * 60_000))).toBeLessThan(10_000)

    expect(daily.lastRun).toMatchObject({ status: 'ok' })
    expect(daily.lastRun!.startedAt).toBeGreaterThanOrEqual(seededAt)
    expect(Math.abs(daily.lastRun!.startedAt - seededAt)).toBeLessThan(5000)
    expect(daily.nextRunAt).toBeGreaterThan(Date.now() + 23 * HOUR)
  })
})
