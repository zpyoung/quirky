import { randomBytes } from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import type { CheckResult, MessageRow } from '../src/contracts'
import type { WorkerListResult, WorkerShowResult } from '../src/worker-contracts'
import { installFederationMailOwnerFixture, type FederationMailOwnerFixture } from './federation-mail-support'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from './workers/acceptance-support'

const homes: WorkerAcceptance[] = []
const ownerFixtures: FederationMailOwnerFixture[] = []
afterEach(async () => {
  for (const home of homes.splice(0).reverse()) await home.cleanup()
  for (const owner of ownerFixtures.splice(0).reverse()) owner.cleanup()
})

async function pair(home: WorkerAcceptance, host: WorkerAcceptance): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const homeListener = await home.fixture.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token,
  }) as { endpoint: string; fingerprint: string }
  const hostListener = await host.fixture.call('quirky.orchestration/peerListen', {
    host: '127.0.0.1', port: 0, token,
  }) as { endpoint: string; fingerprint: string }
  const pairedHome = await home.fixture.call('quirky.orchestration/peerPair', {
    peerId: 'mail-host', label: 'Mail Host', endpoint: hostListener.endpoint, token, fingerprint: hostListener.fingerprint,
  }) as { peer: { id: string } }
  await host.fixture.call('quirky.orchestration/peerPair', {
    peerId: 'mail-home', label: 'Mail Home', endpoint: homeListener.endpoint, token, fingerprint: homeListener.fingerprint,
  })
  return pairedHome.peer.id
}

test('paired daemons preserve FIFO mail and ask identity; a rejected home completion leaves the host unsettled', async () => {
  const home = await startWorkerAcceptance({ heldPrefix: 'Hold the task until the acceptance CLI sends a reply.' })
  homes.push(home)
  const host = await startWorkerAcceptance({ heldPrefix: 'Hold the task until the acceptance CLI sends a reply.' })
  homes.push(host)
  const peerId = await pair(home, host)
  const owner = await installFederationMailOwnerFixture(home)
  ownerFixtures.push(owner)

  const hostRepo = (await host.fixture.call('quirky.repo/list', {})) as Array<{ id: string }>
  expect(hostRepo.length).toBeGreaterThan(0)
  const started = await owner.start({
    peerId,
    repoId: hostRepo[0]!.id,
    worktreeName: 'federation-mail-worker',
    taskTitle: 'Federated mail task',
    spec: 'Wait for coordinator guidance, ask one blocking question, then report success.',
  })
  expect(started.receipt.state).toBe('ready')

  const homeShow = await home.fixture.call('quirky.orchestration/workerShow', {
    dispatchId: started.receipt.dispatchId,
  }) as WorkerShowResult
  const hostSession = homeShow.worker?.sessionId
  if (typeof hostSession !== 'string') throw new Error('the attached host worker has no session identity')
  const hostRow = await eventually(async () => {
    const result = await host.fixture.call('quirky.orchestration/workerList', { includeRemote: false }) as WorkerListResult
    return result.workers.find((row) => row.taskTitle === 'Federated mail task') ?? null
  }, (row) => row !== null, 'the exact service-owned host Dispatch to attach')
  if (hostRow === null) throw new Error('the exact host Dispatch was not available')
  const hostRows = hostRow
  const hostShow = await host.fixture.call('quirky.orchestration/workerShow', {
    dispatchId: hostRows.dispatchId,
  }) as WorkerShowResult
  expect(hostShow.worker?.sessionId).toBe(hostSession)

  for (const body of ['first', 'second']) {
    await owner.sendGuidance({ runId: started.runId, dispatchId: started.receipt.dispatchId, body })
  }
  const messages: MessageRow[] = []
  let deliveryId: string | null = null
  const deadline = Date.now() + 5000
  while (messages.length < 2 && Date.now() < deadline) {
    const consumed: Extract<CheckResult, { mode: 'consume' }> = await host.callAs(hostSession, 'check', [
      '--unread', '--wait', '--timeout-ms', String(Math.max(0, deadline - Date.now())),
      ...(deliveryId === null ? [] : ['--ack', deliveryId]),
    ])
    messages.push(...consumed.messages)
    deliveryId = consumed.deliveryId
    if (consumed.timedOut || consumed.cancelled || consumed.connectionLost) break
  }
  expect(messages.map((message) => message.body)).toEqual(['first', 'second'])

  const timedOut = await host.cli(hostSession!, [
    'orchestration', 'ask', '--question', 'Should the worker continue?', '--options', 'yes,no',
    '--timeout-ms', '50',
  ])
  expect(timedOut.code).toBe(1)
  const question = JSON.parse(timedOut.stdout) as { state: string; messageId: string }
  expect(question.state).toBe('timedOut')
  const homeQuestion = await eventually(
    () => owner.show(started.runId),
    (detail) => detail.questions.some((entry) => entry.messageId === question.messageId),
    'the original question to reach its home service Run',
  )
  expect(homeQuestion.questions.find((entry) => entry.messageId === question.messageId)?.status).toBe('pending')

  await owner.reply({ runId: started.runId, messageId: question.messageId, body: 'yes' })
  const resumed = await host.callAs<{ state: string; answer: string; messageId: string }>(hostSession!, 'ask', [
    '--resume', question.messageId, '--timeout-ms', '5000',
  ])
  expect(resumed).toMatchObject({ state: 'answered', answer: 'yes', messageId: question.messageId })
  expect((await owner.reply({ runId: started.runId, messageId: question.messageId, body: 'yes' })).duplicate).toBe(true)
  await expect(owner.reply({ runId: started.runId, messageId: question.messageId, body: 'no' })).rejects.toThrow()

  const heartbeat = await host.callAs<{ heartbeat: { status: string } }>(hostSession!, 'send', [
    '--type', 'heartbeat',
    '--subject', 'Worker heartbeat',
    '--task-id', hostRows.taskId,
    '--dispatch-id', hostRows.dispatchId,
    '--phase', 'answered',
  ])
  expect(heartbeat.heartbeat.status).toBe('accepted')

  const rejectedResult = await host.cli(hostSession!, [
    'orchestration', 'send',
    '--type', 'worker_done',
    '--task-id', hostRows.taskId,
    '--dispatch-id', hostRows.dispatchId,
    '--outcome', 'succeeded',
    '--subject', 'Rejected federated completion',
    '--body', 'The home owner policy deliberately rejects this report.',
  ])
  const rejected = JSON.parse(rejectedResult.stdout) as { kind: string; report: { status: string } }
  expect(rejected.report.status).toBe('rejected')
  const hostAfterRejection = await host.fixture.call('quirky.orchestration/workerShow', {
    dispatchId: hostRows.dispatchId,
  }) as WorkerShowResult
  expect(hostAfterRejection.dispatch.status).toBe('dispatched')
  expect((await owner.show(started.runId)).workers.find((worker) => worker.dispatchId === started.receipt.dispatchId)?.assignmentActive).toBe(true)

  await owner.setVerdict('accepted')
  const accepted = await host.callAs<{ kind: string; report: { status: string } }>(hostSession!, 'send', [
    '--type', 'worker_done',
    '--task-id', hostRows.taskId,
    '--dispatch-id', hostRows.dispatchId,
    '--outcome', 'succeeded',
    '--subject', 'Accepted federated completion',
    '--body', 'The same bound attempt reports success after the owner policy allows it.',
  ])
  expect(accepted.kind).toBe('worker_report')
  expect(accepted.report.status).toBe('accepted')
  const homeAfterAcceptance = await owner.show(started.runId)
  expect(homeAfterAcceptance.workers.find((worker) => worker.dispatchId === started.receipt.dispatchId)?.assignmentActive).toBe(false)
  const hostAfterAcceptance = await host.fixture.call('quirky.orchestration/workerShow', {
    dispatchId: hostRows.dispatchId,
  }) as WorkerShowResult
  expect(hostAfterAcceptance.dispatch.status).toBe('completed')
  const processExitStart = await owner.start({
    peerId,
    repoId: hostRepo[0]!.id,
    worktreeName: 'federation-process-exit',
    taskTitle: 'Federated process-exit task',
    spec: 'Remain active so the host records a positive unexpected process exit.',
  })
  const processExitHostRow = await eventually(async () => {
    const result = await host.fixture.call('quirky.orchestration/workerList', { includeRemote: false }) as WorkerListResult
    return result.workers.find((row) => row.taskTitle === 'Federated process-exit task') ?? null
  }, (row) => row !== null, 'the second exact host Dispatch')
  if (processExitHostRow === null) throw new Error('the second host Dispatch was not available')
  const processExitHostShow = await host.fixture.call('quirky.orchestration/workerShow', {
    dispatchId: processExitHostRow.dispatchId,
  }) as WorkerShowResult
  const processExitSessionId = processExitHostShow.worker?.sessionId
  if (typeof processExitSessionId !== 'string') throw new Error('the second host worker has no process identity')
  const processExitEvents = await eventually(
    () => host.events(processExitSessionId),
    (events) => events.some((event) => event.type === 'started' && event.sessionId === processExitSessionId),
    'the real process identity for the second host worker',
  )
  const processExitProcess = processExitEvents.find((event) =>
    event.type === 'started' && event.sessionId === processExitSessionId)
  if (typeof processExitProcess?.pid !== 'number') throw new Error('the second host process did not publish its real PID')
  process.kill(processExitProcess.pid, 'SIGTERM')
  const settledHome = await eventually(
    () => home.fixture.call('quirky.orchestration/workerShow', {
      dispatchId: processExitStart.receipt.dispatchId,
    }) as Promise<WorkerShowResult>,
    (result) => result.dispatch.failureCount === 1 && result.dispatch.status === 'failed' &&
      result.worker?.state === 'failed' && result.worker.stage === 'process_exited',
    'the home Dispatch to settle from the persisted exact host process-exit observation',
  )
  expect(settledHome.dispatch.status).toBe('failed')
  const exitedHome = await eventually(
    () => owner.show(processExitStart.runId),
    (detail) => detail.workers.some((worker) =>
      worker.dispatchId === processExitStart.receipt.dispatchId && worker.assignmentActive === false),
    'the service owner to reflect the exited home attempt',
  )
  expect(exitedHome.workers.find((worker) => worker.dispatchId === processExitStart.receipt.dispatchId)?.state).toBe('exited')
  const exitDispatch = await home.fixture.call('quirky.orchestration/dispatchShow', {
    taskId: processExitStart.receipt.taskId,
  }) as { dispatch: { status: string } }
  expect(exitDispatch.dispatch.status).toBe('failed')
}, 180_000)
