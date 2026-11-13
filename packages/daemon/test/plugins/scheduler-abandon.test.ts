import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type JobInfo } from '@quirky/protocol'
import { PluginHost } from '../../src/plugins/host'
import { Scheduler } from '../../src/plugins/scheduler'
import { UnansweredHandlers } from '../../src/plugins/unanswered'
import { Store } from '../../src/store'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, waitForFile, writeModulePlugin } from './fixtures'

const PLUGIN = 'acme.poll'
const JOB = `job:${PLUGIN}/tick`
const ACCOUNT_PLUGIN = 'acme.accounts'
const ACCOUNT_JOB = `job:${ACCOUNT_PLUGIN}/usage-refresh`
const SECOND = 1000
const STALL_WARNING = `${JOB} did not stop after its 1000 ms timeout and is still running; it will not run again until that run ends or ${PLUGIN} is reloaded`
const BOUND_WARNING = `${JOB} has 4 or more handlers that never finished; it will not run again until fewer than 4 remain or the daemon restarts`

const cleanups: Array<() => Promise<void> | void> = []
let harness: Harness | null = null

afterEach(async () => {
  await harness?.cleanup()
  harness = null
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  removeTempDirs()
})

type SetupOptions = {
  interval?: string
  initialDelay?: string
  timeout?: string
  body?: string
  activate?: string | ((gateDir: string) => string)
  abortGraceMs?: number
  recheckMs?: number
}

function setup(options: SetupOptions = {}) {
  const root = makeTempDir()
  const installedDir = join(root, 'installed')
  const gateDir = join(root, 'gates')
  mkdirSync(installedDir)
  mkdirSync(gateDir)
  const marker = join(root, 'marker.log')
  const gate = join(root, 'gate')
  const store = new Store(join(root, 'quirky.db'))
  const logs: string[] = []
  const writes: string[] = []
  const warnings: string[] = []
  const warningAdds: string[] = []
  const warningCalls: string[] = []
  const warningRemoves: string[] = []
  const warningSnapshots: Array<JobInfo | undefined> = []
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
  const host = new PluginHost({
    builtinDir: null,
    installedDir,
    store,
    emit: () => scheduler?.sync(),
    log: (message) => logs.push(message)
  })
  let scheduler: Scheduler | undefined
  const unanswered = new UnansweredHandlers({
    warn: (pluginId, message) => {
      warningCalls.push(message)
      if (!warnings.includes(message)) {
        warnings.push(message)
        warningAdds.push(message)
        host.addWarning(pluginId, message)
      }
      warningSnapshots.push(scheduler?.list()[0])
      scheduler?.sync()
    },
    unwarn: (pluginId, message) => {
      const index = warnings.indexOf(message)
      if (index >= 0) {
        warnings.splice(index, 1)
        host.removeWarning(pluginId, message)
      }
      warningRemoves.push(message)
      warningSnapshots.push(scheduler?.list()[0])
      scheduler?.sync()
    }
  })
  const activate = typeof options.activate === 'function'
    ? options.activate(gateDir)
    : options.activate ?? `context.provide(${JSON.stringify(JOB)}, async ({ signal }) => {
        record('start tick ' + Date.now())
        ${options.body ?? waitForFile(gate)}
        record('end tick ' + Date.now())
      })`
  writeModulePlugin(
    installedDir,
    marker,
    {
      id: PLUGIN,
      contributes: {
        job: [{ id: 'tick', interval: options.interval ?? '1s', initialDelay: options.initialDelay ?? '0s', timeout: options.timeout ?? '1s' }]
      }
    },
    { activate }
  )
  host.load()
  scheduler = new Scheduler({
    plugins: host,
    store: recordingStore,
    log: (message) => logs.push(message),
    unanswered,
    abortGraceMs: options.abortGraceMs ?? 50,
    recheckMs: options.recheckMs ?? 50
  })

  const clearWarning = (message: string) => {
    const index = warnings.indexOf(message)
    if (index >= 0) {
      warnings.splice(index, 1)
      host.removeWarning(PLUGIN, message)
    }
  }
  const release = (path = gate) => writeFileSync(path, '')
  cleanups.push(async () => {
    release()
    for (let run = 1; run <= 8; run += 1) release(join(gateDir, String(run)))
    scheduler?.stop()
    await Bun.sleep(30)
    await host.stop()
    store.close()
  })

  const lines = () => readMarker(marker)
  const starts = () => lines().filter((line) => line.startsWith('start tick '))
  const ends = () => lines().filter((line) => line.startsWith('end tick '))
  const row = () => store.listJobRuns().get(JOB)
  const info = () => scheduler?.list()[0]
  return {
    gate,
    gateDir,
    host,
    logs,
    lines,
    starts,
    ends,
    row,
    clearWarning,
    writes,
    warnings,
    warningAdds,
    warningCalls,
    warningRemoves,
    warningSnapshots,
    unanswered,
    release,
    info,
    get scheduler() {
      return scheduler!
    }
  }
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('until timed out')
    await Bun.sleep(10)
  }
}

describe('stalled scheduled jobs', () => {
  // These scenarios exercise the scheduler's actual timeout and interval timers against wall time.
  test('J1: reports a handler that ignores its abort and does not start another run', async () => {
    const t = setup()
    t.scheduler.start()

    await until(() => t.info()?.stalled?.handlers === 1)
    expect(t.info()).toMatchObject({
      state: 'running',
      nextRunAt: null,
      lastRun: { status: 'timed-out' },
      stalled: { handlers: 1 }
    })
    expect(t.warnings).toEqual([STALL_WARNING])
    expect(t.logs).toContain(STALL_WARNING)
    expect(t.warningSnapshots.at(-1)).toMatchObject({ state: 'running', stalled: { handlers: 1 } })

    await Bun.sleep(2200)
    expect(t.starts()).toHaveLength(1)
    expect(t.warnings).toEqual([STALL_WARNING])
  })

  test('J2: a handler that settles on abort is not counted or warned', async () => {
    const t = setup({ body: "await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))" })
    t.scheduler.start()

    await until(() => t.ends().length === 1 && t.info()?.state === 'idle')
    expect(t.info()).toMatchObject({ state: 'idle', lastRun: { status: 'timed-out' } })
    expect(t.info()?.nextRunAt).toBe(t.info()?.lastRun?.finishedAt! + SECOND)
    expect(t.unanswered.count(JOB)).toBe(0)
    expect(t.info()?.stalled).toBeUndefined()
    expect(t.warnings).toEqual([])
    expect(t.logs).toEqual([])
  })

  test('J3: manual runs distinguish a stalled handler from one still in its grace period', async () => {
    const t = setup({ interval: '1h', initialDelay: '1h' })
    t.scheduler.start()
    const first = t.scheduler.run(JOB)
    await until(() => t.starts().length === 1)
    await first

    await expect(t.scheduler.run(JOB)).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: `${JOB} is already running`
    })
    await until(() => t.info()?.stalled?.handlers === 1)
    await expect(t.scheduler.run(JOB)).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: `${JOB} is stalled: a run that timed out is still running`,
      data: { reason: 'stalled' }
    })
  })

  test('J4: a late side effect settles before the next fixed-delay run', async () => {
    const t = setup({ body: "await Bun.sleep(2500); record('late-effect')" })
    t.scheduler.start()

    await until(() => t.lines().includes('late-effect'), 6000)
    await until(() => t.starts().length === 2, 6000)
    const lines = t.lines()
    expect(lines.indexOf('late-effect')).toBeGreaterThan(lines.indexOf(t.starts()[0]!))
    expect(lines.indexOf(t.starts()[1]!)).toBeGreaterThan(lines.indexOf('late-effect'))
    expect(t.writes.slice(0, 4)).toEqual(['start', 'timed-out', 'settled', 'start'])
    expect(t.row()).toMatchObject({ status: 'running', finishedAt: null })
    expect(t.unanswered.count(JOB)).toBe(0)
    expect(t.warnings).toEqual([])
    expect(t.logs.some((line) => new RegExp(`${JOB} ended \\d+ ms after its timeout`).test(line))).toBe(true)
  })

  test('J5: repeated timeout cycles never overlap a handler in one activation', async () => {
    const t = setup({
      activate: () => `let live = 0
let maxLive = 0
context.provide(${JSON.stringify(JOB)}, async () => {
  live += 1
  maxLive = Math.max(maxLive, live)
  record('start tick ' + Date.now())
  await Bun.sleep(1500)
  live -= 1
  record('end tick ' + Date.now())
  record('max live ' + maxLive)
})`
    })
    t.scheduler.start()

    await until(() => t.ends().length >= 3, 10_000)
    const maxima = t.lines().filter((line) => line.startsWith('max live ')).map((line) => Number(line.slice('max live '.length)))
    expect(maxima).toHaveLength(3)
    expect(maxima.every((count) => count === 1)).toBe(true)
    expect(t.warningSnapshots.every((info) => (info?.stalled?.handlers ?? 0) <= 1)).toBe(true)
    expect(t.unanswered.count(JOB)).toBe(0)
    expect(t.warnings).toHaveLength(0)
  }, 15_000)

  test('J6/J7: reloads stop at four outstanding handlers and recovery is rechecked', async () => {
    const t = setup({
      activate: (gateDir) => `let runNumber = 0
context.provide(${JSON.stringify(JOB)}, async () => {
  const run = ++runNumber
  record('start tick ' + run)
  while (!existsSync(${JSON.stringify(gateDir)} + '/' + run)) await Bun.sleep(5)
  record('end tick ' + run)
})`
    })
    t.scheduler.start()

    await until(() => t.starts().length === 1)
    await until(() => t.unanswered.count(JOB) === 1)
    for (let count = 1; count < 4; count += 1) {
      t.scheduler.revokePlugin(PLUGIN)
      t.clearWarning(STALL_WARNING)
      await until(() => t.starts().length === count + 1)
      await until(() => t.unanswered.count(JOB) === count + 1)
      expect(t.warnings).toContain(STALL_WARNING)
    }

    expect(t.starts()).toHaveLength(4)
    expect(t.unanswered.count(JOB)).toBe(4)
    expect(t.info()).toMatchObject({ state: 'running', nextRunAt: null, stalled: { handlers: 4 } })
    expect(t.warnings).toContain(BOUND_WARNING)
    expect(t.warningAdds.filter((message) => message === BOUND_WARNING)).toHaveLength(1)

    t.scheduler.revokePlugin(PLUGIN)
    await Bun.sleep(1100)
    expect(t.starts()).toHaveLength(4)
    expect(t.info()).toMatchObject({ state: 'running', nextRunAt: null, stalled: { handlers: 4 } })
    await expect(t.scheduler.run(JOB)).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: `${JOB} is stalled: a run that timed out is still running`,
      data: { reason: 'stalled' }
    })

    const releasedAt = Date.now()
    t.release(join(t.gateDir, '1'))
    await until(() => t.unanswered.count(JOB) === 3)
    expect(t.warnings).not.toContain(BOUND_WARNING)
    await until(() => t.starts().length === 5, 1000)
    expect(Date.now() - releasedAt).toBeLessThanOrEqual(150)
    expect(t.info()?.stalled?.handlers).toBe(3)
  }, 15_000)

  test('J8: a cooperative run settles cleanly when its plugin is revoked', async () => {
    const t = setup({ interval: '1s', body: "await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))" })
    t.scheduler.start()
    await until(() => t.starts().length === 1)

    t.scheduler.revokePlugin(PLUGIN)
    await until(() => t.ends().length === 1 && t.info()?.state === 'idle')
    expect(t.unanswered.count(JOB)).toBe(0)
    expect(t.warnings).toEqual([])
    await until(() => t.starts().length === 2)
  })

  test('J9: an abandoned job context cannot notify after its plugin is disabled and enabled', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const gate = join(scratch, 'gate')
    const freshActivation = join(scratch, 'fresh-activation')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      {
        id: ACCOUNT_PLUGIN,
        contributes: {
          job: [{ id: 'usage-refresh', interval: '1h', initialDelay: '0s', timeout: '24h' }]
        }
      },
      {
        activate: `const isFreshActivation = existsSync(${JSON.stringify(freshActivation)})
          context.provide(${JSON.stringify(ACCOUNT_JOB)}, async () => {
            if (isFreshActivation) {
              record('fresh handler started')
              return
            }
            record('old handler started')
            ${waitForFile(gate)}
            try {
              context.notify({ title: 'stale job', body: 'should not send' })
              record('notify returned')
            } catch (error) {
              record(error instanceof Error ? error.message : String(error))
            }
          })`
      }
    )
    harness = await startHarness({ home, builtinPluginsDir: null, schedulerRecheckMs: 25 })
    const client = await harness.connect()

    await waitFor(() => readMarker(marker).includes('old handler started'))
    await client.call('plugin.disable', { id: ACCOUNT_PLUGIN })
    writeFileSync(freshActivation, '')
    await client.call('plugin.enable', { id: ACCOUNT_PLUGIN })
    await waitFor(() => readMarker(marker).includes('fresh handler started'))
    writeFileSync(gate, '')
    await waitFor(() => readMarker(marker).includes(`${ACCOUNT_PLUGIN} is no longer active`))

    expect(readMarker(marker)).not.toContain('notify returned')
    expect(harness.notifications).toEqual([])
  })

  test('J10: stopping clears a pending grace timer without warning or stall log', async () => {
    const t = setup({ interval: '1h', initialDelay: '1h', abortGraceMs: 50 })
    t.scheduler.start()
    const first = t.scheduler.run(JOB)
    await until(() => t.starts().length === 1)
    await first

    t.scheduler.stop()
    await Bun.sleep(100)
    expect(t.warnings).toEqual([])
    expect(t.logs.some((line) => line === STALL_WARNING)).toBe(false)
  })

})
