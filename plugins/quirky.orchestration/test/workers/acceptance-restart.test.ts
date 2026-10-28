import { chmodSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { QuirkyClient } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl, type RuntimeInfo } from '@quirky/protocol/node'
import type { RunRow, TaskRow } from '../../src/contracts'
import type { WorkerListResult, WorkerShowResult } from '../../src/worker-contracts'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from './acceptance-support'

const ROOT = resolve(import.meta.dir, '../../../..')
const DAEMON = join(ROOT, 'packages/daemon/src/main.ts')
const CLI = join(ROOT, 'packages/cli/src/main.ts')
const CONTROL = join(import.meta.dir, 'acceptance-control.ts')

async function createRun(h: WorkerAcceptance): Promise<RunRow> {
  const result = await h.callAs<{ run: RunRow }>(h.coordinator.id, 'run-create', [
    '--objective', 'Daemon restart recovery acceptance'
  ])
  return result.run
}

function inputText(h: WorkerAcceptance, session: string): string {
  return h.events(session)
    .filter((event) => event.type === 'input' && typeof event.base64 === 'string')
    .map((event) => Buffer.from(event.base64 as string, 'base64').toString())
    .join('')
}

function installReadinessGate(h: WorkerAcceptance): void {
  const launcher = join(h.fixture.fakebin, 'claude')
  writeFileSync(launcher, `#!${process.execPath}
import { startWorkerControl } from ${JSON.stringify(CONTROL)}
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('1.0.0 (isolated restart provider fixture)\\n')
  process.exit(0)
}
const control = startWorkerControl()
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', chunk => control.log({ type: 'input', base64: chunk.toString('base64') }))
process.stdin.resume()
const finish = () => { control.stop(); process.exit(0) }
process.on('SIGTERM', finish)
process.on('SIGHUP', finish)
process.on('SIGINT', finish)
`)
  chmodSync(launcher, 0o755)
}

async function restartPrivateDaemon(h: WorkerAcceptance, original: RuntimeInfo): Promise<RuntimeInfo> {
  const { fixture } = h
  expect(fixture.processScope.home).toBe(fixture.home)

  const current = readRuntime(fixture.home)
  if (!current || current.pid !== original.pid || current.startedAt !== original.startedAt || current.token !== original.token) {
    throw new Error('the private fixture runtime changed before the targeted daemon crash')
  }
  if (!(await isDaemonAlive(current))) throw new Error(`private daemon ${current.pid} was not healthy before SIGKILL`)

  process.kill(current.pid, 'SIGKILL')
  await eventually(() => isDaemonAlive(current), (alive) => !alive, 'the targeted private daemon to stop')

  const logPath = join(dirname(fixture.home), 'restart-daemon.log')
  const daemon = fixture.processScope.spawn([process.execPath, DAEMON], {
    env: {
      HOME: fixture.userHome,
      QUIRKY_HOME: fixture.home,
      PATH: `${fixture.fakebin}:/usr/bin:/bin`,
      SHELL: join(dirname(fixture.fakebin), 'shells', 'sh'),
      QUIRKY_AGENT_SEARCH_DIRS: '',
      QUIRKY_PORT: '0',
      QUIRKY_TEST_AGENT_TIME_SCALE: '0.1',
      WORKER_TEST_CLI: CLI,
      ...fixture.processScope.env
    },
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath)
  })

  const runtime = await eventually(async () => {
    if (daemon.exitCode !== null) throw new Error(`restarted private daemon exited ${daemon.exitCode}`)
    const next = readRuntime(fixture.home)
    return next && next.pid !== current.pid && await isDaemonAlive(next) ? next : null
  }, (next) => next !== null, 'a healthy new daemon epoch', 20_000)
  if (!runtime) throw new Error('the restarted private daemon did not publish a runtime')
  return runtime
}

test('a daemon crash while an accepted worker waits for readiness persists unknown and refuses exact pending replay', async () => {
  const h = await startWorkerAcceptance()
  let restartedClient: QuirkyClient | undefined
  try {
    const originalRuntime = readRuntime(h.fixture.home)
    if (!originalRuntime || !(await isDaemonAlive(originalRuntime))) throw new Error('worker acceptance fixture has no healthy private daemon')

    const run = await createRun(h)
    installReadinessGate(h)

    const requestId = crypto.randomUUID()
    const startArgs = [
      'orchestration', 'worker-start',
      '--spec', 'Wait for provider readiness that this fixture deliberately withholds.',
      '--task-title', 'Restart recovery pending worker',
      '--worktree', 'current', '--agent', 'claude', '--timeout-ms', '30000',
      '--retry-request', requestId
    ]
    // Start via the launched coordinator's inherited authority; keep its CLI outstanding across the crash.
    const pendingStart = h.cli(h.coordinator.id, startArgs, 60_000)
    void pendingStart.catch(() => {})

    const acceptedCandidate = await eventually(async () => {
      const fleet = await h.fixture.call('quirky.orchestration/workerList', { runId: run.id }) as WorkerListResult
      const row = fleet.workers.find((worker) => worker.runId === run.id)
      if (!row) return null

      const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: row.dispatchId }) as WorkerShowResult
      const worker = shown.worker
      if (!worker || worker.state !== 'starting' || worker.stage !== 'waiting_ready' || shown.dispatch.status !== 'pending' || !worker.sessionId) return null

      const events = h.events(worker.sessionId)
      const providerStart = events.find((event) => event.type === 'started')
      if (!providerStart || events.some((event) => event.type === 'input')) return null
      return {
        dispatchId: worker.dispatchId,
        sessionId: worker.sessionId,
        providerStart,
        submitted: inputText(h, worker.sessionId)
      }
    }, (value) => value !== null, 'a launched provider waiting for readiness before any preamble is sent', 20_000)
    if (!acceptedCandidate) throw new Error('the accepted worker waiting for readiness did not become publicly observable')
    const accepted = acceptedCandidate

    const submittedBeforeCrash = accepted.submitted
    const crashedRuntime = readRuntime(h.fixture.home)
    expect(crashedRuntime?.pid).toBe(originalRuntime.pid)
    const nextRuntime = await restartPrivateDaemon(h, originalRuntime)

    // A dropped RPC connection releases the real CLI child; do not enqueue replay until its request loop is free.
    const interrupted = await pendingStart
    expect(interrupted.code).not.toBe(0)

    restartedClient = await QuirkyClient.connect(rpcUrl(nextRuntime), { role: 'cli', name: 'worker-restart-acceptance' })
    h.fixture.call = (method, params = {}) => restartedClient!.callAny(method, params)

    const recovered = await eventually(
      () => h.fixture.call('quirky.orchestration/workerShow', { dispatchId: accepted.dispatchId }) as Promise<WorkerShowResult>,
      (shown) => shown.worker?.state === 'start_unknown',
      'the accepted worker to recover as start_unknown'
    )
    expect(inputText(h, accepted.sessionId)).toBe(submittedBeforeCrash)
    expect(recovered.dispatch.status).toBe('pending')
    expect(recovered.projection.outcome).toBe('outcome_unknown')
    expect(recovered.terminalResource?.sessionId).toBe(accepted.sessionId)
    const recoveredTasks = await h.callAs<{ tasks: TaskRow[] }>(h.coordinator.id, 'task-list', ['--run', run.id])
    expect(recoveredTasks.tasks.find((task) => task.id === recovered.dispatch.taskId)?.status).toBe('blocked')

    const sessionsBeforeReplay = await h.fixture.call('quirky.session/list', {}) as Array<{ id: string }>
    const fleetBeforeReplay = await h.fixture.call('quirky.orchestration/workerList', { runId: run.id }) as WorkerListResult
    expect(fleetBeforeReplay.workers.map((worker) => worker.dispatchId)).toEqual([accepted.dispatchId])

    const replay = await h.cli(h.coordinator.id, startArgs, 60_000)
    expect(replay.code).not.toBe(0)
    expect(JSON.parse(replay.stdout)).toMatchObject({ error: { reason: 'operation_unknown' } })

    const afterReplay = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: accepted.dispatchId }) as WorkerShowResult
    expect(inputText(h, accepted.sessionId)).toBe(submittedBeforeCrash)
    const providerEventsAfterReplay = h.events(accepted.sessionId)
    expect(providerEventsAfterReplay.filter((event) => event.type === 'started')).toEqual([accepted.providerStart])
    expect(providerEventsAfterReplay.some((event) => event.type === 'input')).toBe(false)
    expect(afterReplay.dispatch.status).toBe('pending')
    expect(afterReplay.projection.outcome).toBe('outcome_unknown')
    expect(afterReplay.terminalResource?.id).toBe(recovered.terminalResource?.id)

    const sessionsAfterReplay = await h.fixture.call('quirky.session/list', {}) as Array<{ id: string }>
    expect(sessionsAfterReplay.map((session) => session.id).sort()).toEqual(sessionsBeforeReplay.map((session) => session.id).sort())
    const fleetAfterReplay = await h.fixture.call('quirky.orchestration/workerList', { runId: run.id }) as WorkerListResult
    expect(fleetAfterReplay.workers.map((worker) => worker.dispatchId)).toEqual([accepted.dispatchId])
  } finally {
    restartedClient?.close()
    await h.cleanup()
  }
}, 180_000)
