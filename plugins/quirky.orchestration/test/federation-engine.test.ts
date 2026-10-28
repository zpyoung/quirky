import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Session } from '@quirky/protocol'
import type { MutationResult, RunRow } from '../src/contracts'
import type { WorkerControlResult, WorkerListResult, WorkerReadResult, WorkerShowResult, WorkerStartReceipt } from '../src/worker-contracts'
import { eventually, mutation, startOrchestrationFixture, type OrchestrationFixture, type OrchestrationParty } from './fixture'

const fixtures: OrchestrationFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})

async function daemon(): Promise<OrchestrationFixture> {
  const fixture = await startOrchestrationFixture()
  fixtures.push(fixture)
  return fixture
}

async function pair(home: OrchestrationFixture, host: OrchestrationFixture): Promise<void> {
  const token = randomBytes(32).toString('base64url')
  const homeListener = await home.setupClient.callAny('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token,
  }) as { endpoint: string; fingerprint: string }
  const hostListener = await host.setupClient.callAny('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token,
  }) as { endpoint: string; fingerprint: string }
  await home.setupClient.callAny('quirky.orchestration/peerPair', {
    peerId: 'host-a', label: 'Acceptance host', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint,
  })
  await host.setupClient.callAny('quirky.orchestration/peerPair', {
    peerId: 'home-a', label: 'Acceptance home', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint,
  })
}

async function coordinator(home: OrchestrationFixture, party: OrchestrationParty): Promise<RunRow> {
  const result = await party.client.callAny('quirky.orchestration/runCreate', {
    ...mutation(), objective: 'Paired-daemon worker federation acceptance',
  }) as MutationResult<{ run: RunRow }>
  return result.run
}

async function sessions(fixture: OrchestrationFixture): Promise<Session[]> {
  return fixture.setupClient.callAny('quirky.session/list', {}) as Promise<Session[]>
}

async function workers(fixture: OrchestrationFixture, runId?: string): Promise<WorkerListResult> {
  return fixture.setupClient.callAny('quirky.orchestration/workerList', {
    limit: 50,
    ...(runId ? { runId } : {}),
  }) as Promise<WorkerListResult>
}

async function createIsolatedGitRepo(fixture: OrchestrationFixture): Promise<{ id: string; path: string }> {
  const path = join(fixture.root, `git-${randomUUID()}`)
  mkdirSync(path, { recursive: true })
  const initialized = Bun.spawnSync(['git', 'init', path])
  if (initialized.exitCode !== 0) throw new Error(`git init failed: ${initialized.stderr.toString()}`)
  const committed = Bun.spawnSync([
    'git', '-C', path, '-c', 'user.name=Federation Fixture', '-c', 'user.email=federation@example.test',
    'commit', '--allow-empty', '-m', 'federation fixture baseline',
  ])
  if (committed.exitCode !== 0) throw new Error(`fixture commit failed: ${committed.stderr.toString()}`)
  const repo = await fixture.setupClient.callAny('quirky.repo/add', { path }) as { id: string; path: string }
  return { id: repo.id, path: repo.path }
}

async function startRemote(
  home: OrchestrationFixture,
  coordinator: OrchestrationParty,
  runId: string,
  worktreeId: string,
  taskTitle: string,
  requestId = randomUUID(),
): Promise<{ receipt: MutationResult<WorkerStartReceipt>; args: string[] }> {
  const args = [
    'orchestration', 'worker-start',
    '--run', runId,
    '--spec', `Federation acceptance: ${taskTitle}`,
    '--task-title', taskTitle,
    '--worktree', worktreeId,
    '--agent', 'claude',
    '--on', 'host-a',
    '--timeout-ms', '30000',
    '--retry-request', requestId,
  ]
  const result = await home.runCli(coordinator, args, { processTimeoutMs: 180_000 })
  if (result.code !== 0) throw new Error(`federated worker-start failed (${result.code}): ${result.stderr}\n${result.stdout}`)
  return { receipt: JSON.parse(result.stdout) as MutationResult<WorkerStartReceipt>, args }
}

async function runControl<T>(fixture: OrchestrationFixture, party: OrchestrationParty, verb: string, dispatchId: string): Promise<T> {
  const result = await fixture.runCli(party, ['orchestration', verb, '--dispatch', dispatchId], { processTimeoutMs: 180_000 })
  if (result.code !== 0) throw new Error(`orchestration ${verb} failed (${result.code}): ${result.stderr}\n${result.stdout}`)
  return JSON.parse(result.stdout) as T
}

test('paired daemon worker-start executes only on the selected host and replays one durable receipt', async () => {
  const home = await daemon()
  const host = await daemon()
  const homeParty = await home.createParty('federation-home', 'claude')
  const hostParty = await host.createParty('federation-host', 'claude')
  await pair(home, host)
  const run = await coordinator(home, homeParty)
  const homeSessionsBefore = (await sessions(home)).map(session => session.id).sort()
  const hostSessionsBefore = (await sessions(host)).map(session => session.id).sort()
  const title = `Federated existing workspace ${randomUUID()}`
  const started = await startRemote(home, homeParty, run.id, hostParty.worktreeId, title)
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
  const hostShow = await host.setupClient.callAny('quirky.orchestration/workerShow', {
    dispatchId: hostRow.dispatchId,
  }) as WorkerShowResult
  expect(hostShow.worker?.sessionId).toBeTruthy()
  expect(hostShow.worker?.worktreeId).toBe(hostParty.worktreeId)
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
  expect((await sessions(host)).length).toBeGreaterThan(hostSessionsBefore.length)

  const homeFleet = await workers(home, run.id)
  const homeRow = homeFleet.workers.find(worker => worker.dispatchId === homeReceipt.dispatchId)
  expect(homeRow?.projection.host.kind).toBe('remote')
  expect((await home.setupClient.callAny('quirky.orchestration/workerShow', {
    dispatchId: homeReceipt.dispatchId,
  }) as WorkerShowResult).worker?.sessionId).toBe(hostShow.worker?.sessionId)

  const replay = await home.runCli(homeParty, started.args, { processTimeoutMs: 180_000 })
  expect(replay.code).toBe(0)
  expect((JSON.parse(replay.stdout) as MutationResult<WorkerStartReceipt>).mutation.replayed).toBe(true)
  expect((await workers(host)).workers.filter(worker => worker.taskTitle === title)).toHaveLength(1)
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
  const repo = await createIsolatedGitRepo(host)
  const newName = `federated-${randomUUID()}`
  const newTitle = `Federated new top-level ${randomUUID()}`
  const newTop = await home.runCli(homeParty, [
    'orchestration', 'worker-start',
    '--run', run.id,
    '--spec', `Federation acceptance: ${newTitle}`,
    '--task-title', newTitle,
    '--worktree', 'new-top-level',
    '--repo', repo.id,
    '--name', newName,
    '--agent', 'claude',
    '--on', 'host-a',
    '--timeout-ms', '30000',
    '--retry-request', randomUUID(),
  ], { processTimeoutMs: 180_000 })
  expect(newTop.code).toBe(0)
  const newTopReceipt = JSON.parse(newTop.stdout) as MutationResult<WorkerStartReceipt>
  expect(newTopReceipt.state).toBe('ready')
  const newTopRow = (await eventually(
    () => workers(host),
    fleet => fleet.workers.some(worker => worker.taskTitle === newTitle),
    'host new-top-level worker receipt',
    90_000,
  )).workers.find(worker => worker.taskTitle === newTitle)!
  const newTopShow = await host.setupClient.callAny('quirky.orchestration/workerShow', {
    dispatchId: newTopRow.dispatchId,
  }) as WorkerShowResult
  expect(newTopShow.worker?.worktreeId).toBeTruthy()
  expect(newTopShow.worker?.worktreeId).not.toBe(hostParty.worktreeId)
  expect(newTopShow.worker?.worktreeId).not.toBeNull()
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
})

test('illegal remote placement is rejected before home Task/Dispatch or host process effects', async () => {
  const home = await daemon()
  const host = await daemon()
  const homeParty = await home.createParty('placement-home', 'claude')
  const hostParty = await host.createParty('placement-host', 'claude')
  await pair(home, host)
  const run = await coordinator(home, homeParty)
  const homeSessionsBefore = (await sessions(home)).map(session => session.id).sort()
  const hostSessionsBefore = (await sessions(host)).map(session => session.id).sort()
  const tasksBefore = await home.setupClient.callAny('quirky.orchestration/taskList', { runId: run.id }) as { tasks: unknown[] }
  const rejectedPlacements = [
    ['current'],
    ['new-child'],
    ['new-top-level'],
  ] as const
  for (const [placement] of rejectedPlacements) {
    const result = await home.runCli(homeParty, [
      'orchestration', 'worker-start', '--run', run.id, '--spec', 'This must be refused before effects.',
      '--worktree', placement, '--agent', 'claude', '--on', 'host-a', '--retry-request', randomUUID(),
    ], { processTimeoutMs: 60_000 })
    expect(result.code).toBe(1)
  }
  const tasksAfter = await home.setupClient.callAny('quirky.orchestration/taskList', { runId: run.id }) as { tasks: unknown[] }
  expect(tasksAfter.tasks).toEqual(tasksBefore.tasks)
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
  expect((await sessions(host)).map(session => session.id).sort()).toEqual(hostSessionsBefore)
  expect((await workers(host)).workers).toHaveLength(0)
  expect(hostParty.worktreeId).toBeTruthy()
})

test('remote retain, stop, release/archive, and abandon affect only the exact host worker', async () => {
  const home = await daemon()
  const host = await daemon()
  const homeParty = await home.createParty('controls-home', 'claude')
  const hostParty = await host.createParty('controls-host', 'claude')
  await pair(home, host)
  const run = await coordinator(home, homeParty)
  const homeSessionsBefore = (await sessions(home)).map(session => session.id).sort()
  const retainedStart = await startRemote(home, homeParty, run.id, hostParty.worktreeId, `Retain ${randomUUID()}`)
  const stoppedStart = await startRemote(home, homeParty, run.id, hostParty.worktreeId, `Stop ${randomUUID()}`)
  const releasedStart = await startRemote(home, homeParty, run.id, hostParty.worktreeId, `Release ${randomUUID()}`)
  const abandonedStart = await startRemote(home, homeParty, run.id, hostParty.worktreeId, `Abandon ${randomUUID()}`)
  const allHostWorkers = await eventually(
    () => workers(host),
    fleet => fleet.workers.length >= 4,
    'four isolated host service workers',
    90_000,
  )
  const hostByTitle = new Map(allHostWorkers.workers.map(row => [row.taskTitle, row]))
  const retainedTitle = allHostWorkers.workers.find(row => row.taskTitle.includes('Retain '))!.taskTitle
  const stoppedTitle = allHostWorkers.workers.find(row => row.taskTitle.includes('Stop '))!.taskTitle
  const releasedTitle = allHostWorkers.workers.find(row => row.taskTitle.includes('Release '))!.taskTitle
  const abandonedTitle = allHostWorkers.workers.find(row => row.taskTitle.includes('Abandon '))!.taskTitle
  const retainedHost = hostByTitle.get(retainedTitle)!
  const stoppedHost = hostByTitle.get(stoppedTitle)!
  const releasedHost = hostByTitle.get(releasedTitle)!
  const abandonedHost = hostByTitle.get(abandonedTitle)!

  const retained = await runControl<MutationResult<WorkerControlResult>>(home, homeParty, 'worker-retain', retainedStart.receipt.dispatchId)
  expect(retained.state).toBe('retained')
  const hostSessions = await host.setupClient.callAny('quirky.terminal/sessions', {}) as { sessions: Array<{ sessionId: string; alive: boolean }> }
  expect(hostSessions.sessions.find(session => session.sessionId === retainedHost.agentTerminalHandle)?.alive).toBe(true)

  const stopped = await runControl<MutationResult<WorkerControlResult>>(home, homeParty, 'worker-stop', stoppedStart.receipt.dispatchId)
  expect(stopped.state).toBe('stopped')
  const released = await runControl<MutationResult<WorkerControlResult>>(home, homeParty, 'worker-release', releasedStart.receipt.dispatchId)
  expect(released.state).toBe('released')
  const archived = await homeParty.client.callAny('quirky.orchestration/workerRead', {
    dispatchId: releasedStart.receipt.dispatchId,
  }) as WorkerReadResult
  expect(archived.archived).toBe(true)
  expect(archived.remote?.hostDispatchId).toBe(releasedHost.dispatchId)
  const abandoned = await runControl<MutationResult<WorkerControlResult>>(home, homeParty, 'worker-abandon', abandonedStart.receipt.dispatchId)
  expect(abandoned.state).toBe('abandoned')
  expect(stoppedHost.dispatchId).not.toBe(releasedHost.dispatchId)
  expect(abandonedHost.dispatchId).not.toBe(retainedHost.dispatchId)
  expect((await sessions(home)).map(session => session.id).sort()).toEqual(homeSessionsBefore)
})
