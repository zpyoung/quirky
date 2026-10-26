import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { PluginHost } from '../../src/plugins/host'
import { Scheduler } from '../../src/plugins/scheduler'
import { Store } from '../../src/store'
import { makeTempDir, readMarker, removeTempDirs, waitForFile, writeModulePlugin } from './fixtures'

type JobSpec = { name: string; interval?: string; initialDelay?: string; timeout?: string; body?: string }

const id = (name: string) => `job:acme.poll/${name}`
const TICK = id('tick')
const HOUR = 3_600_000

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  removeTempDirs()
})

/**
 * A real host over a fixture plugin `acme.poll` whose handlers append `start|end|aborted <name>`
 * lines to the marker, a real store, and a clock the test advances by hand unless `realClock`.
 */
function setup(options: { realClock?: boolean } = {}) {
  const root = makeTempDir()
  const installedDir = join(root, 'installed')
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const gate = join(root, 'gate')
  const store = new Store(join(root, 'quirky.db'))
  const logs: string[] = []
  const writes: string[] = []
  const recordingStore = {
    listJobRuns: () => store.listJobRuns(),
    recordJobStart: (jobId: string, at: number) => {
      writes.push('start')
      store.recordJobStart(jobId, at)
    },
    recordJobFinish: (jobId: string, at: number, status: 'ok' | 'failed' | 'timed-out', error?: string) => {
      writes.push(status)
      store.recordJobFinish(jobId, at, status, error)
    },
    recordJobSettled: (jobId: string, at: number) => {
      writes.push('settled')
      store.recordJobSettled(jobId, at)
    }
  }
  const clock = { t: 1_700_000_000_000 }
  const host = new PluginHost({
    builtinDir: null,
    installedDir,
    store,
    emit: () => {},
    log: (message) => logs.push(message)
  })
  let scheduler!: Scheduler

  const release = () => writeFileSync(gate, '')
  const begin = (jobs: JobSpec[], recheckMs = 50) => {
    const provides = jobs.map(
      (job) => `context.provide(${JSON.stringify(id(job.name))}, async ({ signal }: any) => {
      record('start ${job.name} ' + Date.now())
      ${job.body ?? ''}
      record('end ${job.name} ' + Date.now())
    })`
    )
    writeModulePlugin(
      installedDir,
      marker,
      {
        id: 'acme.poll',
        contributes: {
          job: jobs.map(({ name, interval, initialDelay, timeout }) => ({
            id: name,
            interval: interval ?? '1s',
            ...(initialDelay === undefined ? {} : { initialDelay }),
            ...(timeout === undefined ? {} : { timeout })
          }))
        }
      },
      { activate: provides.join('\n') }
    )
    host.load()
    scheduler = new Scheduler({
      plugins: host,
      store: recordingStore,
      log: (message) => logs.push(message),
      recheckMs,
      ...(options.realClock ? {} : { now: () => clock.t })
    })
    return scheduler
  }

  cleanups.push(async () => {
    scheduler?.stop()
    release()
    await Bun.sleep(30)
    await host.stop()
    store.close()
  })

  const lines = () => readMarker(marker)
  const starts = (name = 'tick') => lines().filter((line) => line.startsWith(`start ${name} `))
  const has = (prefix: string) => lines().some((line) => line.startsWith(prefix))
  const stateOf = () => host.list().find((plugin) => plugin.id === 'acme.poll')?.state
  const row = (jobId = TICK) => store.listJobRuns().get(jobId)
  return {
    host,
    store,
    clock,
    logs,
    writes,
    gate,
    release,
    begin,
    lines,
    starts,
    has,
    stateOf,
    row,
    get scheduler() {
      return scheduler
    }
  }
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('until timed out')
    await Bun.sleep(10)
  }
}

const WAIT_FOR_ABORT = "await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())); record('aborted tick')"

describe('lazy activation', () => {
  test('imports the plugin only when the first run is due', async () => {
    const t = setup({ realClock: true })
    const scheduler = t.begin([{ name: 'tick', initialDelay: '600ms' }])
    scheduler.start()
    await Bun.sleep(100)
    expect(t.lines()).toEqual([])
    expect(t.stateOf()).toBe('inactive')

    await until(() => t.has('end tick'))
    expect(t.stateOf()).toBe('active')
    expect(t.row()?.status).toBe('ok')
  })
})

describe('scheduling', () => {
  test('each run starts a full interval after the previous one finished', async () => {
    const t = setup({ realClock: true })
    t.begin([{ name: 'tick', initialDelay: '0s', body: 'await Bun.sleep(300)' }]).start()
    await until(() => t.starts().length >= 2, 4000)

    const time = (prefix: string) => Number(t.lines().find((line) => line.startsWith(prefix))!.split(' ')[2])
    const firstEnd = time('end tick')
    const secondStart = Number(t.starts()[1]!.split(' ')[2])
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd + 1000 - 30)
  })

  test('start twice and sync before start arm each job once', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s', interval: '1h' }])
    scheduler.sync()
    expect(scheduler.list()).toEqual([])
    scheduler.start()
    scheduler.start()
    scheduler.sync()
    await until(() => t.has('end tick'))
    await Bun.sleep(150)
    expect(t.starts()).toHaveLength(1)
  })

  test('never overlaps runs of a slow job', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s', body: waitForFile(join(t.gate)) }])
    scheduler.start()
    await until(() => t.starts().length === 1)
    t.clock.t += 5000
    await Bun.sleep(200)
    expect(t.starts()).toHaveLength(1)
    expect(scheduler.list()[0]).toMatchObject({ state: 'running', nextRunAt: null })

    t.release()
    await until(() => t.has('end tick'))
    await until(() => scheduler.list()[0]?.state === 'idle')
    t.clock.t += 1000
    await until(() => t.starts().length === 2)
  })

  test('records a throwing job as failed, logs it and runs it again next interval', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s', body: "throw new Error('boom')" }])
    scheduler.start()
    await until(() => t.row()?.status === 'failed')
    expect(t.row()).toMatchObject({ status: 'failed', error: 'boom', finishedAt: t.clock.t })
    expect(t.logs).toContain(`acme.poll: job ${TICK} failed: boom`)

    t.clock.t += 1000
    await until(() => t.starts().length === 2)
  })

  test('skips a job whose interval does not parse, once, and still arms the others', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', interval: 'soon' }, { name: 'other', interval: '1h' }])
    scheduler.start()
    scheduler.sync()
    expect(scheduler.list().map((job) => job.id)).toEqual([id('other')])
    expect(t.logs.filter((line) => line.includes(TICK))).toHaveLength(1)
  })
})

describe('due time', () => {
  test('a job that never ran waits initialDelay, defaulting to its interval', () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', interval: '1h' }, { name: 'late', interval: '1h', initialDelay: '30m' }])
    scheduler.start()
    const [late, tick] = scheduler.list()
    expect(tick).toMatchObject({ id: TICK, intervalMs: HOUR, timeoutMs: 300_000, state: 'idle', nextRunAt: t.clock.t + HOUR, lastRun: null })
    expect(late).toMatchObject({ id: id('late'), nextRunAt: t.clock.t + 30 * 60_000 })
    expect(tick!.plugin).toBe('acme.poll')
  })

  test('initialDelay 0s runs promptly on first start', async () => {
    const t = setup()
    t.begin([{ name: 'tick', interval: '1h', initialDelay: '0s' }]).start()
    await until(() => t.has('end tick'))
    expect(t.row()).toMatchObject({ status: 'ok', startedAt: t.clock.t })
  })

  test('an overdue job runs promptly', async () => {
    const t = setup()
    t.store.recordJobStart(TICK, t.clock.t - 2 * HOUR)
    t.store.recordJobFinish(TICK, t.clock.t - 2 * HOUR + 1000, 'ok')
    t.begin([{ name: 'tick', interval: '1h' }]).start()
    await until(() => t.has('end tick'))
  })

  test('a job that finished 10 minutes ago is due one interval after that finish', async () => {
    const t = setup()
    const finishedAt = t.clock.t - 600_000
    t.store.recordJobStart(TICK, finishedAt - 500)
    t.store.recordJobFinish(TICK, finishedAt, 'failed', 'earlier')
    const scheduler = t.begin([{ name: 'tick', interval: '1h' }])
    scheduler.start()
    expect(scheduler.list()[0]).toMatchObject({
      nextRunAt: finishedAt + HOUR,
      lastRun: { startedAt: finishedAt - 500, finishedAt, status: 'failed', error: 'earlier' }
    })
    await Bun.sleep(150)
    expect(t.starts()).toHaveLength(0)

    t.clock.t = finishedAt + HOUR
    await until(() => t.has('end tick'))
  })

  test('a run the daemon never saw finish is due immediately', async () => {
    const t = setup()
    t.store.recordJobStart(TICK, t.clock.t - 1000)
    t.begin([{ name: 'tick', interval: '1h' }]).start()
    await until(() => t.has('end tick'))
    expect(t.row()).toMatchObject({ status: 'ok' })
  })
})

describe('timeout', () => {
  test('aborts the signal, records timed-out at once, and keeps a stubborn job running until it settles', async () => {
    const t = setup()
    const body = `${WAIT_FOR_ABORT}; ${waitForFile(t.gate)}`
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s', timeout: '200ms', body }])
    // the timeout clock starts with the run, so a cold first import must not eat into it
    await t.host.resolveImplementation(TICK)
    scheduler.start()
    await until(() => t.has('aborted tick'))
    const timedOutAt = t.clock.t
    expect(t.row()).toMatchObject({ status: 'timed-out', error: 'timed out after 200 ms', finishedAt: timedOutAt })
    expect(scheduler.list()[0]).toMatchObject({ state: 'running', nextRunAt: null, lastRun: { status: 'timed-out' } })

    t.clock.t += 5000
    await Bun.sleep(200)
    expect(t.starts()).toHaveLength(1)

    const settledAt = t.clock.t
    t.release()
    await until(() => scheduler.list()[0]?.state === 'idle')
    expect(t.row()).toMatchObject({ status: 'timed-out', error: 'timed out after 200 ms', finishedAt: settledAt })
    expect(scheduler.list()[0]).toMatchObject({ nextRunAt: settledAt + 1000, lastRun: { finishedAt: settledAt } })

    t.clock.t += 1000
    await until(() => t.starts().length === 2)
  })
})

describe('run', () => {
  test('rejects NotFound for a job that is not in effect', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick' }])
    scheduler.start()
    await expect(scheduler.run(id('nope'))).rejects.toMatchObject({
      code: RpcErrorCode.NotFound,
      message: `no job ${id('nope')} is in effect`
    })
  })

  test('runs the job now and resolves with the finished run', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', interval: '1h', initialDelay: '30m' }])
    scheduler.start()
    const run = await scheduler.run(TICK)
    expect(run).toEqual({ startedAt: t.clock.t, finishedAt: t.clock.t, status: 'ok' })
    expect(t.row()).toMatchObject({ status: 'ok' })
    expect(scheduler.list()[0]).toMatchObject({ nextRunAt: t.clock.t + HOUR, lastRun: run })
    await Bun.sleep(100)
    expect(t.starts()).toHaveLength(1)
  })

  test('resolves a failed run instead of rejecting', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'bad', interval: '1h', body: "throw new Error('nope')" }])
    scheduler.start()
    expect(await scheduler.run(id('bad'))).toMatchObject({ status: 'failed', error: 'nope' })
  })

  test('rejects Conflict while the job is running', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', interval: '1h', body: waitForFile(t.gate) }])
    scheduler.start()
    const first = scheduler.run(TICK)
    await until(() => t.starts().length === 1)
    await expect(scheduler.run(TICK)).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: `${TICK} is already running`
    })
    t.release()
    expect((await first).status).toBe('ok')
  })

  test('resolves a timed-out run when the timeout fires, not when the handler settles', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', interval: '1h', timeout: '150ms', body: waitForFile(t.gate) }])
    scheduler.start()
    const run = await scheduler.run(TICK)
    expect(run).toMatchObject({ status: 'timed-out', error: 'timed out after 150 ms' })
    expect(scheduler.list()[0]?.state).toBe('running')
  })
})

describe('sync', () => {
  test('stops runs for a disabled job and resumes when it is enabled again', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s' }])
    scheduler.start()
    await until(() => t.starts().length === 1)
    t.clock.t += 1000
    await until(() => t.starts().length === 2)
    await until(() => scheduler.list()[0]?.state === 'idle')

    await t.host.setEnabled(TICK, false)
    scheduler.sync()
    expect(scheduler.list()).toEqual([])
    t.clock.t += 5000
    await Bun.sleep(200)
    expect(t.starts()).toHaveLength(2)

    await t.host.setEnabled(TICK, true)
    scheduler.sync()
    expect(scheduler.list().map((job) => job.id)).toEqual([TICK])
    await until(() => t.starts().length === 3)
  })

  test('does not record the outcome of a run whose job was disarmed, and never overlaps it', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s', body: waitForFile(t.gate) }])
    scheduler.start()
    await until(() => t.starts().length === 1)

    await t.host.setEnabled(TICK, false)
    scheduler.sync()
    await t.host.setEnabled(TICK, true)
    scheduler.sync()
    await Bun.sleep(200)
    expect(t.starts()).toHaveLength(1)

    // the gate stays open afterwards, so the re-armed job's own run starts and ends right behind the
    // disarmed one; the ordered store writes tell the two runs apart where the job_runs row cannot
    t.release()
    await until(() => t.writes.includes('ok'))
    expect(t.writes).toEqual(['start', 'start', 'ok'])
    expect(t.lines().map((line) => line.split(' ')[0])).toEqual(['import', 'activate', 'start', 'end', 'start', 'end'])
  })

  test('arms a job that became effective after start', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s' }])
    await t.host.setEnabled(TICK, false)
    scheduler.start()
    expect(scheduler.list()).toEqual([])
    await t.host.setEnabled(TICK, true)
    scheduler.sync()
    await until(() => t.has('end tick'))
  })
})

describe('revokePlugin', () => {
  test('aborts the plugin runs, ignores their outcome and starts the job fresh after an interval', async () => {
    const t = setup()
    const body = `${WAIT_FOR_ABORT}; ${waitForFile(t.gate)}`
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s', body }])
    scheduler.start()
    await until(() => t.starts().length === 1)

    scheduler.revokePlugin('acme.poll')
    await until(() => t.has('aborted tick'))
    expect(scheduler.list()[0]).toMatchObject({ state: 'idle', nextRunAt: t.clock.t + 1000 })

    t.release()
    await until(() => t.has('end tick'))
    await Bun.sleep(50)
    expect(t.row()).toMatchObject({ status: 'running', finishedAt: null })

    t.clock.t += 1000
    await until(() => t.starts().length === 2)
  })

  test('leaves other plugins running', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s', body: waitForFile(t.gate) }])
    scheduler.start()
    await until(() => t.starts().length === 1)
    scheduler.revokePlugin('someone.else')
    expect(scheduler.list()[0]?.state).toBe('running')
  })
})

describe('stop', () => {
  test('aborts running signals, clears timers and records nothing afterwards', async () => {
    const t = setup()
    const body = `${WAIT_FOR_ABORT}; ${waitForFile(t.gate)}`
    const scheduler = t.begin([{ name: 'tick', initialDelay: '0s', body }])
    scheduler.start()
    await until(() => t.starts().length === 1)

    scheduler.stop()
    await until(() => t.has('aborted tick'))
    expect(scheduler.list()).toEqual([])

    t.release()
    await until(() => t.has('end tick'))
    await Bun.sleep(50)
    expect(t.row()).toMatchObject({ status: 'running', finishedAt: null })

    t.clock.t += 10_000
    await Bun.sleep(200)
    expect(t.starts()).toHaveLength(1)
    scheduler.stop()
  })

  test('resolves a pending run() when stopped', async () => {
    const t = setup()
    const scheduler = t.begin([{ name: 'tick', interval: '1h', body: waitForFile(t.gate) }])
    scheduler.start()
    const pending = scheduler.run(TICK)
    await until(() => t.starts().length === 1)
    scheduler.stop()
    expect((await pending).status).toBe('failed')
  })
})
