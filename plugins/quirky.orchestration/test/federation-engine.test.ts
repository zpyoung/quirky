import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import type { MutationResult, RunRow } from '../src/contracts'
import type { WorkerControlResult, WorkerListResult, WorkerReadResult, WorkerShowResult, WorkerStartReceipt } from '../src/worker-contracts'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from './workers/acceptance-support'

const fixtures: WorkerAcceptance[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})

async function daemon(): Promise<WorkerAcceptance> {
  const fixture = await startWorkerAcceptance()
  fixtures.push(fixture)
  return fixture
}

async function pair(home: WorkerAcceptance, host: WorkerAcceptance): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const peerId = `host-${randomUUID()}`
  const homeListener = await home.fixture.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token,
  }) as { endpoint: string; fingerprint: string }
  const hostListener = await host.fixture.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token,
  }) as { endpoint: string; fingerprint: string }
  const pairedHome = await home.fixture.call('quirky.orchestration/peerPair', {
    peerId, label: 'Acceptance host', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint,
  }) as { peer: { id: string } }
  await host.fixture.call('quirky.orchestration/peerPair', {
    peerId: `home-${peerId}`, label: 'Acceptance home', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint,
  })
  return pairedHome.peer.id
}

async function coordinator(home: WorkerAcceptance): Promise<RunRow> {
  const result = await home.callAs<MutationResult<{ run: RunRow }>>(home.coordinator.id, 'run-create', [
    '--objective', 'Paired-daemon worker federation acceptance',
  ])
  return result.run
}

async function sessions(fixture: WorkerAcceptance): Promise<Session[]> {
  return fixture.fixture.call('quirky.session/list', {}) as Promise<Session[]>
}

async function workers(fixture: WorkerAcceptance, runId?: string): Promise<WorkerListResult> {
  return fixture.fixture.call('quirky.orchestration/workerList', {
    limit: 50,
    ...(runId ? { runId } : {}),
  }) as Promise<WorkerListResult>
}

async function startRemote(
  home: WorkerAcceptance,
  peerId: string,
  runId: string,
  worktreeId: string,
  taskTitle: string,
  requestId = randomUUID(),
): Promise<{ receipt: MutationResult<WorkerStartReceipt>; args: string[] }> {
  const args = [
    '--run', runId,
    '--spec', `Federation acceptance: ${taskTitle}`,
    '--task-title', taskTitle,
    '--worktree', worktreeId,
    '--agent', 'claude',
    '--on', peerId,
    '--timeout-ms', '30000',
    '--retry-request', requestId,
  ]
  const receipt = await home.callAs<MutationResult<WorkerStartReceipt>>(
    home.coordinator.id,
    'worker-start',
    args,
  )
  return { receipt, args }
}

async function runControl<T>(fixture: WorkerAcceptance, verb: string, dispatchId: string): Promise<T> {
  return fixture.callAs<T>(fixture.coordinator.id, verb, ['--dispatch', dispatchId])
}

test('paired daemon worker-start executes only on the selected host and replays one durable receipt', async () => {
  const home = await daemon()
  const host = await daemon()
  const peerId = await pair(home, host)
  const run = await coordinator(home)
  const homeSessionsBefore = (await sessions(home)).map(session => session.id).sort()
  const hostSessionsBefore = (await sessions(host)).map(session => session.id).sort()
  const hostWorktreeId = host.coordinator.worktreeId
  const title = `Federated existing workspace ${randomUUID()}`
  const started = await startRemote(home, peerId, run.id, hostWorktreeId, title)
  expect(started.receipt.state).toBe('ready')
  expect(started.receipt.runId).toBe(run.id)
  const homeReceipt = started.receipt

  const hostFleet = await eventually(
    () => workers(host),
    fleet => fleet.workers.some(worker => worker.taskTitle === title),
    'host service Run to expose the attached worker',
    90_000,
  )
  const hostRow = hostFleet.workers.find(worker => worker.taskTitle === title)!
  expect(hostRow.runId).not.toBe(run.id)
  expect(hostRow.dispatchId).not.toBe(homeReceipt.dispatchId)
  const hostShow = await host.fixture.call('quirky.orchestration/workerShow', {
    dispatchId: hostRow.dispatchId,
  }) as WorkerShowResult
  expect(hostShow.worker?.sessionId).toBeTruthy()
  expect(hostShow.worker?.worktreeId).toBe(hostWorktreeId)
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
  expect((await sessions(host)).length).toBeGreaterThan(hostSessionsBefore.length)

  const homeFleet = await workers(home, run.id)
  const homeRow = homeFleet.workers.find(worker => worker.dispatchId === homeReceipt.dispatchId)
  expect(homeRow?.projection.host.kind).toBe('remote')
  expect((await home.fixture.call('quirky.orchestration/workerShow', {
    dispatchId: homeReceipt.dispatchId,
  }) as WorkerShowResult).worker?.sessionId).toBe(hostShow.worker?.sessionId)

  const replay = await home.callAs<MutationResult<WorkerStartReceipt>>(
    home.coordinator.id,
    'worker-start',
    started.args,
  )
  expect(replay.mutation.replayed).toBe(true)
  expect((await workers(host)).workers.filter(worker => worker.taskTitle === title)).toHaveLength(1)
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)

  const hostRepos = await host.fixture.call('quirky.repo/list', {}) as Array<{ id: string }>
  const repo = hostRepos[0]
  if (!repo) throw new Error('host acceptance fixture has no registered repository')
  const newName = `federated-${randomUUID()}`
  const newTitle = `Federated new top-level ${randomUUID()}`
  const newTop = await home.callAs<MutationResult<WorkerStartReceipt>>(
    home.coordinator.id,
    'worker-start',
    [
      '--run', run.id,
      '--spec', `Federation acceptance: ${newTitle}`,
      '--task-title', newTitle,
      '--worktree', 'new-top-level',
      '--repo', repo.id,
      '--name', newName,
      '--agent', 'claude',
      '--on', peerId,
      '--timeout-ms', '30000',
      '--retry-request', randomUUID(),
    ],
  )
  expect(newTop.state).toBe('ready')
  const newTopRow = (await eventually(
    () => workers(host),
    fleet => fleet.workers.some(worker => worker.taskTitle === newTitle),
    'host new-top-level worker receipt',
    90_000,
  )).workers.find(worker => worker.taskTitle === newTitle)!
  const newTopShow = await host.fixture.call('quirky.orchestration/workerShow', {
    dispatchId: newTopRow.dispatchId,
  }) as WorkerShowResult
  const newTopWorktree = await host.fixture.call('quirky.worktree/show', {
    worktree: newTopShow.worker?.worktreeId,
  }) as { id: string; repoId: string; name: string }
  expect(newTopWorktree.id).not.toBe(hostWorktreeId)
  expect(newTopWorktree).toMatchObject({ repoId: repo.id, name: newName })
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
}, 120_000)

test('illegal remote placement is rejected before home Task/Dispatch or host process effects', async () => {
  const home = await daemon()
  const host = await daemon()
  const peerId = await pair(home, host)
  const run = await coordinator(home)
  const homeSessionsBefore = (await sessions(home)).map(session => session.id).sort()
  const hostSessionsBefore = (await sessions(host)).map(session => session.id).sort()
  const tasksBefore = await home.fixture.call('quirky.orchestration/taskList', { runId: run.id }) as { tasks: unknown[] }
  const rejectedPlacements = ['current', 'new-child', 'new-top-level'] as const
  for (const placement of rejectedPlacements) {
    const result = await home.cli(home.coordinator.id, [
      'orchestration', 'worker-start', '--run', run.id, '--spec', 'This must be refused before effects.',
      '--worktree', placement, '--agent', 'claude', '--on', peerId, '--retry-request', randomUUID(),
    ])
    expect(result.code).toBe(1)
  }
  const tasksAfter = await home.fixture.call('quirky.orchestration/taskList', { runId: run.id }) as { tasks: unknown[] }
  expect(tasksAfter.tasks).toEqual(tasksBefore.tasks)
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
  expect((await sessions(host)).map(session => session.id).sort()).toEqual(hostSessionsBefore)
  expect((await workers(host)).workers).toHaveLength(0)
}, 120_000)

test('remote retain, stop, release/archive, and abandon affect only the exact host worker', async () => {
  const home = await daemon()
  const host = await daemon()
  const peerId = await pair(home, host)
  const run = await coordinator(home)
  const hostWorktreeId = host.coordinator.worktreeId
  const homeSessionsBefore = (await sessions(home)).map(session => session.id).sort()
  const retainedStart = await startRemote(home, peerId, run.id, hostWorktreeId, `Retain ${randomUUID()}`)
  const stoppedStart = await startRemote(home, peerId, run.id, hostWorktreeId, `Stop ${randomUUID()}`)
  const releasedStart = await startRemote(home, peerId, run.id, hostWorktreeId, `Release ${randomUUID()}`)
  const abandonedStart = await startRemote(home, peerId, run.id, hostWorktreeId, `Abandon ${randomUUID()}`)
  const allHostWorkers = await eventually(
    () => workers(host),
    fleet => fleet.workers.length >= 4,
    'four isolated host service workers',
    90_000,
  )
  const retainedHost = allHostWorkers.workers.find(row => row.taskTitle.includes('Retain '))!
  const stoppedHost = allHostWorkers.workers.find(row => row.taskTitle.includes('Stop '))!
  const releasedHost = allHostWorkers.workers.find(row => row.taskTitle.includes('Release '))!
  const abandonedHost = allHostWorkers.workers.find(row => row.taskTitle.includes('Abandon '))!

  const retained = await runControl<MutationResult<WorkerControlResult>>(home, 'worker-retain', retainedStart.receipt.dispatchId)
  expect(retained.state).toBe('retained')
  const hostSessions = await host.fixture.call('quirky.terminal/sessions', {}) as { sessions: Array<{ sessionId: string; alive: boolean }> }
  expect(hostSessions.sessions.find(session => session.sessionId === retainedHost.agentTerminalHandle)?.alive).toBe(true)

  const stopped = await runControl<MutationResult<WorkerControlResult>>(home, 'worker-stop', stoppedStart.receipt.dispatchId)
  expect(stopped.state).toBe('stopped')
  const releasedSessionId = releasedHost.resource?.sessionId
  if (!releasedSessionId) throw new Error('release target has no exact host session')
  const completed = await host.callAs<{ report: { status: string } }>(releasedSessionId, 'send', [
    '--type', 'worker_done', '--task-id', releasedHost.taskId, '--dispatch-id', releasedHost.dispatchId,
    '--outcome', 'succeeded', '--subject', 'Release target completed', '--body', 'Settle before releasing its terminal.',
  ])
  expect(completed.report.status).toBe('accepted')
  const released = await runControl<MutationResult<WorkerControlResult>>(home, 'worker-release', releasedStart.receipt.dispatchId)
  expect(released.state).toBe('released')
  const archived = await home.fixture.call('quirky.orchestration/workerRead', {
    dispatchId: releasedStart.receipt.dispatchId,
  }) as WorkerReadResult
  expect(archived.archived).toBe(true)
  expect(archived.remote?.hostDispatchId).toBe(releasedHost.dispatchId)
  const abandoned = await runControl<MutationResult<WorkerControlResult>>(home, 'worker-abandon', abandonedStart.receipt.dispatchId)
  expect(abandoned.state).toBe('abandoned')
  expect(await host.ptyAlive(stoppedHost.agentTerminalHandle!)).toBe(false)
  expect(await host.ptyAlive(releasedSessionId)).toBe(false)
  expect(await host.ptyAlive(retainedHost.agentTerminalHandle!)).toBe(true)
  expect(await host.ptyAlive(abandonedHost.agentTerminalHandle!)).toBe(true)
  expect(await host.ptyAlive(host.coordinator.id)).toBe(true)
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
}, 120_000)
