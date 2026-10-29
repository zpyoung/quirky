import { randomBytes } from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import type { MutationResult, RunRow } from '../src/contracts'
import type { WorkerControlResult, WorkerFleetRow, WorkerListResult, WorkerReadResult, WorkerShowResult, WorkerStartReceipt } from '../src/worker-contracts'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from './workers/acceptance-support'

type FederationAcceptance = { home: WorkerAcceptance; host: WorkerAcceptance; peerId: string; cleanup(): Promise<void> }
let federation: FederationAcceptance | undefined
afterEach(async () => { await federation?.cleanup(); federation = undefined })

async function pairDaemons(): Promise<FederationAcceptance> {
  const home = await startWorkerAcceptance()
  let host: WorkerAcceptance | undefined
  try {
    host = await startWorkerAcceptance()
    const token = randomBytes(32).toString('base64url')
    const peerId = `host-${crypto.randomUUID()}`
    const homeListener = await home.fixture.call('quirky.orchestration/peerListen', { host: '127.0.0.1', port: 0, token }) as { endpoint: string; fingerprint: string; incarnation: string }
    const hostListener = await host.fixture.call('quirky.orchestration/peerListen', { host: '127.0.0.1', port: 0, token }) as { endpoint: string; fingerprint: string; incarnation: string }
    await home.fixture.call('quirky.orchestration/peerPair', {
      peerId, label: 'Federation test host', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint
    })
    await host.fixture.call('quirky.orchestration/peerPair', {
      peerId: `home-${peerId}`, label: 'Federation test home', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint
    })
    return {
      home, host, peerId,
      async cleanup() { await host!.cleanup(); await home.cleanup() }
    }
  } catch (error) {
    await host?.cleanup()
    await home.cleanup()
    throw error
  }
}

async function createHomeRun(h: FederationAcceptance): Promise<RunRow> {
  const accepted = await h.home.callAs<MutationResult<{ run: RunRow }>>(h.home.coordinator.id, 'run-create', ['--objective', 'Federated worker surface acceptance'])
  return accepted.run
}

async function startRemote(h: FederationAcceptance, spec: string): Promise<WorkerStartReceipt> {
  const receipt = await h.home.callAs<MutationResult<WorkerStartReceipt>>(h.home.coordinator.id, 'worker-start', [
    '--on', h.peerId,
    '--spec', spec,
    '--agent', 'claude',
    '--worktree', h.host.coordinator.worktreeId,
    '--timeout-ms', '5000'
  ])
  expect(receipt.state).toBe('ready')
  return receipt
}

async function hostWorkerFor(h: FederationAcceptance, sessionId: string): Promise<WorkerFleetRow> {
  const worker = await eventually(async () => {
    const result = await h.host!.fixture.call('quirky.orchestration/workerList', { limit: 100 }) as WorkerListResult
    return result.workers.find((row) => row.projection.host.kind === 'local' && row.resource?.sessionId === sessionId) ?? null
  }, (row) => row !== null, 'host-owned remote worker row')
  if (!worker) throw new Error('host worker inventory did not contain the exact remote worker session')
  return worker
}

async function sendHostCompletion(h: FederationAcceptance, worker: WorkerFleetRow): Promise<void> {
  const sessionId = worker.resource?.sessionId
  if (!sessionId) throw new Error('host worker has no actual session identity')
  await h.host!.callAs<unknown>(sessionId, 'send', [
    '--type', 'worker_done', '--task-id', worker.taskId, '--dispatch-id', worker.dispatchId,
    '--outcome', 'succeeded', '--subject', 'Federated completion', '--body', 'Host worker completed through its real process.'
  ])
}

test('home reads and controls the exact host worker, preserves host output provenance, and archives before release', async () => {
  const h = federation = await pairDaemons()
  await createHomeRun(h)
  const retainedReceipt = await startRemote(h, 'Keep the retained worker live to prove its host custody remains open.')
  const retainedShown = await h.home.fixture.call('quirky.orchestration/workerShow', { dispatchId: retainedReceipt.dispatchId }) as WorkerShowResult
  const retainedSessionId = retainedShown.worker?.sessionId
  expect(retainedShown.projection.host).toEqual({ kind: 'remote', id: h.peerId })
  expect(retainedSessionId).toBeTruthy()
  const retained = await h.home.callAs<MutationResult<WorkerControlResult>>(h.home.coordinator.id, 'worker-retain', ['--dispatch', retainedReceipt.dispatchId])
  expect(retained.state).toBe('retained')
  expect(await h.host.ptyAlive(retainedSessionId!)).toBe(true)
  const abandoned = await h.home.callAs<MutationResult<WorkerControlResult>>(h.home.coordinator.id, 'worker-abandon', ['--dispatch', retainedReceipt.dispatchId])
  expect(abandoned.state).toBe('abandoned')
  expect(abandoned.processAction).toBe('none')
  expect(await h.host.ptyAlive(retainedSessionId!)).toBe(true)
  const receipt = await startRemote(h, 'Remain live for remote output and control acceptance.')
  const shown = await h.home.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  const hostSessionId = shown.worker?.sessionId

  expect(shown.dispatch.id).toBe(receipt.dispatchId)
  expect(shown.worker?.dispatchId).toBe(receipt.dispatchId)
  expect(shown.projection.host).toEqual({ kind: 'remote', id: h.peerId })
  expect(shown.terminal).toBeNull()
  expect(hostSessionId).toBeTruthy()
  expect((await h.home.fixture.call('quirky.session/list', {}) as Array<{ id: string }>).map(({ id }) => id)).not.toContain(hostSessionId)
  expect(await h.host.ptyAlive(hostSessionId!)).toBe(true)

  const beforeRelease = await h.home.fixture.call('quirky.orchestration/workerRead', {
    dispatchId: receipt.dispatchId, source: 'terminal', limit: 1
  }) as WorkerReadResult
  expect(beforeRelease.dispatchId).toBe(receipt.dispatchId)
  expect(beforeRelease.sourceExact).toBe(true)
  expect(beforeRelease.remote).toMatchObject({ peerId: h.peerId, hostDispatchId: expect.any(String), hostIncarnation: expect.any(String) })


  const hostWorker = await hostWorkerFor(h, hostSessionId!)
  await sendHostCompletion(h, hostWorker)
  const released = await h.home.callAs<MutationResult<WorkerControlResult>>(h.home.coordinator.id, 'worker-release', ['--dispatch', receipt.dispatchId])
  expect(released.state).toBe('released')
  expect(released.processAction).toBe('closed_agent_terminal')
  expect(await h.host.ptyAlive(hostSessionId!)).toBe(false)

  const archived = await h.home.fixture.call('quirky.orchestration/workerRead', {
    dispatchId: receipt.dispatchId, source: 'terminal'
  }) as WorkerReadResult
  expect(archived.dispatchId).toBe(receipt.dispatchId)
  expect(archived.archived).toBe(true)
  expect(archived.sourceExact).toBe(true)
  expect(archived.content).toContain('Ready.')
  expect(archived.remote).toMatchObject({ peerId: h.peerId, hostDispatchId: beforeRelease.remote?.hostDispatchId })
}, 120_000)

test('remote fleet snapshots are bounded and stable and host loss stays partial and unverifiable', async () => {
  const h = federation = await pairDaemons()
  const run = await createHomeRun(h)
  const remote = await startRemote(h, 'Remain live for fleet pagination acceptance.')
  const local = await h.home.callAs<MutationResult<WorkerStartReceipt>>(h.home.coordinator.id, 'worker-start', [
    '--spec', 'Remain live beside the remote fleet row.', '--agent', 'claude', '--worktree', 'current', '--timeout-ms', '5000'
  ])
  expect(local.state).toBe('ready')
  const homeOnly = await h.home.callAs<WorkerListResult>(h.home.coordinator.id, 'worker-list', ['--run', run.id, '--limit', '10'])
  const homeRemoteRow = homeOnly.workers.find((row) => row.dispatchId === remote.dispatchId)
  expect(homeRemoteRow?.projection.host).toEqual({ kind: 'remote', id: h.peerId })
  expect(homeRemoteRow?.projection.liveness.status).toBe('unverifiable')
  expect(homeRemoteRow?.projection.nextAction.kind).toBe('none')

  const first = await h.home.callAs<WorkerListResult>(h.home.coordinator.id, 'worker-list', [
    '--run', run.id, '--include-remote', '--limit', '1'
  ])
  expect(first.workers).toHaveLength(1)
  expect(first.page.nextCursor).not.toBeNull()
  const additionalRemote = await startRemote(h, 'Start after the captured fleet snapshot.')
  const next = await h.home.callAs<WorkerListResult>(h.home.coordinator.id, 'worker-list', [
    '--run', run.id, '--include-remote', '--limit', '1', '--cursor', first.page.nextCursor!
  ])
  const captured = [...first.workers, ...next.workers]
  expect(first.page.snapshotId).toBe(next.page.snapshotId)
  expect(captured.map((row) => row.dispatchId)).toContain(remote.dispatchId)
  expect(captured.map((row) => row.dispatchId)).toContain(local.dispatchId)
  expect(captured.map((row) => row.dispatchId)).not.toContain(additionalRemote.dispatchId)
  const remoteRow = captured.find((row) => row.dispatchId === remote.dispatchId)
  expect(remoteRow?.projection.host).toEqual({ kind: 'remote', id: h.peerId })
  expect(first.partialHostErrors).toEqual([])
  const remoteShown = await h.home.fixture.call('quirky.orchestration/workerShow', { dispatchId: remote.dispatchId }) as WorkerShowResult
  const remoteSessionId = remoteShown.worker?.sessionId
  const additionalShown = await h.home.fixture.call('quirky.orchestration/workerShow', { dispatchId: additionalRemote.dispatchId }) as WorkerShowResult
  const additionalSessionId = additionalShown.worker?.sessionId
  expect(remoteSessionId).toBeTruthy()
  expect(additionalSessionId).toBeTruthy()
  const stopped = await h.home.callAs<MutationResult<WorkerControlResult>>(h.home.coordinator.id, 'worker-stop', ['--dispatch', additionalRemote.dispatchId])
  expect(stopped.state).toBe('stopped')
  expect(stopped.processAction).toBe('closed_agent_terminal')
  expect(await h.host.ptyAlive(additionalSessionId!)).toBe(false)
  expect(await h.host.ptyAlive(remoteSessionId!)).toBe(true)

  

  await h.home.fixture.call('quirky.orchestration/peerUnpair', { peerId: h.peerId })
  const partial = await h.home.callAs<WorkerListResult>(h.home.coordinator.id, 'worker-list', [
    '--run', run.id, '--include-remote', '--limit', '10'
  ])
  expect(partial.partialHostErrors).toEqual([expect.objectContaining({ host: h.peerId })])
  expect(partial.workers.every((row) => row.projection.liveness.status !== 'exited' || row.projection.host.kind === 'local')).toBe(true)

  await expect(h.home.fixture.call('quirky.orchestration/workerRead', {
    dispatchId: remote.dispatchId, source: 'terminal'
  })).rejects.toBeInstanceOf(Error)
  const localAfterRemoteFailure = await h.home.fixture.call('quirky.orchestration/workerShow', { dispatchId: local.dispatchId }) as WorkerShowResult
  expect(localAfterRemoteFailure.worker?.state).toBe('ready')
}, 120_000)

test('remote placement refusal occurs before either daemon launches or accepts a task', async () => {
  const h = federation = await pairDaemons()
  await createHomeRun(h)
  const homeSessionsBefore = await h.home.fixture.call('quirky.session/list', {}) as Array<{ id: string }>
  const hostSessionsBefore = await h.host.fixture.call('quirky.session/list', {}) as Array<{ id: string }>
  const hostWorkersBefore = await h.host.fixture.call('quirky.orchestration/workerList', { limit: 100 }) as WorkerListResult

  const refused = await h.home.cli(h.home.coordinator.id, [
    'orchestration', 'worker-start', '--on', h.peerId, '--spec', 'Must not launch from current placement.',
    '--agent', 'claude', '--worktree', 'current', '--timeout-ms', '5000'
  ])
  expect(refused.code).not.toBe(0)
  expect(await h.home.fixture.call('quirky.session/list', {})).toEqual(homeSessionsBefore)
  expect(await h.host.fixture.call('quirky.session/list', {})).toEqual(hostSessionsBefore)
  const hostWorkersAfter = await h.host.fixture.call('quirky.orchestration/workerList', { limit: 100 }) as WorkerListResult
  expect(hostWorkersAfter.workers.map((row) => row.dispatchId)).toEqual(hostWorkersBefore.workers.map((row) => row.dispatchId))
}, 120_000)

test('an unexpected real host-process exit settles the home attempt once through federated lifecycle authority', async () => {
  const h = await pairDaemons()
  try {
    const run = await createHomeRun(h)
    const receipt = await startRemote(h, 'Stay active until the test terminates the real host process.')
    const shown = await h.home.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
    const sessionId = shown.worker?.sessionId
    expect(sessionId).toBeTruthy()

    const events = await eventually(
      () => h.host.events(sessionId!),
      (items) => items.some((item) => item.type === 'started' && item.sessionId === sessionId),
      'real host worker process identity'
    )
    const started = events.find((item) => item.type === 'started' && item.sessionId === sessionId)
    if (typeof started?.pid !== 'number') throw new Error('host worker did not publish its actual process ID')
    process.kill(started.pid, 'SIGTERM')

    const settled = await eventually(
      () => h.home.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as Promise<WorkerShowResult>,
      (result) => result.dispatch.failureCount === 1 && result.worker?.state === 'failed' && result.worker.stage === 'process_exited',
      'home to accept the authenticated host exit certificate'
    )
    expect(settled.dispatch.status).toBe('failed')
    expect(await h.host.ptyAlive(sessionId!)).toBe(false)
    const tasks = await h.home.callAs<{ tasks: Array<{ id: string; status: string }> }>(h.home.coordinator.id, 'task-list', ['--run', run.id])
    expect(tasks.tasks.find((task) => task.id === receipt.taskId)?.status).toBe('ready')

    const duplicate = await h.home.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
    expect(duplicate.dispatch.failureCount).toBe(1)
  } finally {
    await h.cleanup()
  }
}, 120_000)
