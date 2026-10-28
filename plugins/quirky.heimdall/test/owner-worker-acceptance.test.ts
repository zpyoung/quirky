import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import { startWorkerAcceptance, type WorkerAcceptance } from '../../quirky.orchestration/test/workers/acceptance-support'
import { createOwnerWorkerStructuredRunnerFactory } from './owner-worker-fakes/mixed-structured-runner'
import type { StructuredRunnerFactory } from '../../quirky.structured/runner'

const KIND_PLUGIN_DIR = join(import.meta.dir, 'owner-worker-fakes/kind-plugin')
const KIND_ID = 'acme.owner-worker-kind'
const FIXTURE_ID = `${KIND_ID}/configure`
const QUESTION = 'Should the deployment use the blue or green release slot?'
const ANSWER = 'Use the green release slot after the health check.'
const MESSAGE_BODY = 'Keep the release blocked until the green slot health check passes.'

type JsonRecord = Record<string, unknown>
type CliResult = { code: number; stdout: string; stderr: string }
type OwnerReport = { owner: JsonRecord; pending: JsonRecord }
type OwnedWorker = { dispatchId: string; runId: string; sessionId: string; pid: number }
type TestGlobals = typeof globalThis & { __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory }

const globals = globalThis as TestGlobals
let harness: WorkerAcceptance | null = null

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function stringField(value: unknown, key: string, label: string): string {
  const field = record(value, label)[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${label}.${key} must be a non-empty string`)
  return field
}

function arrayField(value: unknown, key: string, label: string): unknown[] {
  const field = record(value, label)[key]
  if (!Array.isArray(field)) throw new Error(`${label}.${key} must be an array`)
  return field
}

function reportFile(pending: JsonRecord, value: unknown): void {
  const path = stringField(pending, 'reportPath', 'owner pending report')
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
}

async function inspect(watcherId: string): Promise<JsonRecord> {
  const result = await harness!.fixture.call('quirky.heimdall/inspect', { watcherId })
  if (!Array.isArray(result)) throw new Error('Heimdall inspection must return an array')
  const selected = result.find((entry) => isRecord(entry) && isRecord(entry.enrollment) && entry.enrollment.watcherId === watcherId)
  return record(selected, 'Heimdall inspection')
}

async function waitForOwnerReport(watcherId: string, naturalKey: string): Promise<OwnerReport> {
  return waitForAsync(async () => {
    const owner = record(await harness!.fixture.call('quirky.heimdall/ownerInspect', { watcherId }), 'owner inspection')
    const pending = owner.pending
    if (!isRecord(pending) || pending.phase !== 'waiting' || !isRecord(pending.deviation) || pending.deviation.naturalKey !== naturalKey) return null
    return { owner, pending }
  }, 20_000)
}

async function setDeviation(watcherId: string, naturalKey: string, detail: string): Promise<OwnerReport> {
  await harness!.fixture.call(FIXTURE_ID, { naturalKey, detail })
  await harness!.fixture.call('quirky.heimdall/reconcile', { watcherId })
  return waitForOwnerReport(watcherId, naturalKey)
}

async function ownerReady(watcherId: string, pending: JsonRecord): Promise<{ result: JsonRecord; cli: CliResult }> {
  const cli = await harness!.fixture.cli([
    'heimdall', 'owner-ready',
    '--watcher-id', watcherId,
    '--report-key', stringField(pending, 'reportKey', 'owner pending report'),
    '--json'
  ])
  let parsed: unknown
  try {
    parsed = JSON.parse(cli.stdout) as unknown
  } catch (error) {
    throw new Error(`owner-ready CLI returned invalid JSON: ${cli.stdout}`, { cause: error })
  }
  return { result: record(parsed, 'owner-ready result'), cli }
}

function attemptsForCapability(inspection: JsonRecord, capability: string): JsonRecord[] {
  return arrayField(inspection, 'journal', 'Heimdall inspection')
    .filter(isRecord)
    .filter((entry) => entry.kind === 'attempt' && isRecord(entry.action) && entry.action.capability === capability)
}

async function waitForAttempt(watcherId: string, capability: string): Promise<{ inspection: JsonRecord; attempt: JsonRecord }> {
  return waitForAsync(async () => {
    const inspection = await inspect(watcherId)
    const attempt = attemptsForCapability(inspection, capability).at(-1)
    if (attempt?.state === 'settled' && attempt.effect !== 'landed') {
      throw new Error(`Owner ${capability} ${String(attempt.effect)}: ${String(attempt.reason)}`)
    }
    return attempt?.effect === 'landed' ? { inspection, attempt } : null
  }, 20_000)
}

async function waitForOwnedWorker(watcherId: string): Promise<OwnedWorker> {
  try {
  return await waitForAsync(async () => {
    const inspection = await inspect(watcherId)
    const enrollment = record(inspection.enrollment, 'Heimdall enrollment')
    if (typeof enrollment.orchestrationRunId !== 'string') return null
    const dispatchAttempt = attemptsForCapability(inspection, 'dispatch-worker').at(-1)
    if (dispatchAttempt?.state === 'settled' && dispatchAttempt.effect !== 'landed') {
      throw new Error(`Worker start ${String(dispatchAttempt.effect)}: ${String(dispatchAttempt.reason)}`)
    }
    if (!dispatchAttempt || typeof dispatchAttempt.dispatchId !== 'string') return null
    const dispatchId = dispatchAttempt.dispatchId
    const shown = record(await harness!.fixture.call('quirky.orchestration/workerShow', { dispatchId }), 'orchestration worker show')
    const worker = shown.worker
    const dispatch = shown.dispatch
    if (!isRecord(worker) || !isRecord(dispatch) || typeof worker.sessionId !== 'string' || typeof dispatch.runId !== 'string') return null
    if (dispatch.runId !== enrollment.orchestrationRunId) throw new Error('the owner worker dispatch belongs to a different Run')
    const events = harness!.events(worker.sessionId)
    const started = events.find((event) => event.type === 'started' && typeof event.pid === 'number')
    if (!started || typeof started.pid !== 'number') return null
    return { dispatchId, runId: dispatch.runId, sessionId: worker.sessionId, pid: started.pid }
  }, 90_000)
  } catch (error) {
    throw new Error(`Owned worker never became ready: ${JSON.stringify(await inspect(watcherId))}`, { cause: error })
  }
}

async function workerCli(sessionId: string, args: string[]): Promise<CliResult> {
  return harness!.cli(sessionId, ['orchestration', ...args])
}

function parseCliJson(result: CliResult, label: string): JsonRecord {
  try {
    return record(JSON.parse(result.stdout) as unknown, label)
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${result.stdout}`, { cause: error })
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProviderProcess(sessionId: string): Promise<number> {
  return waitForAsync(async () => {
    const eventsPath = join(harness!.fixture.home, 'worker-fixture', `${sessionId}.events.jsonl`)
    if (!existsSync(eventsPath)) return null
    const events: unknown[] = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown)
    const started = events.find((event) => isRecord(event) && event.type === 'started' && typeof event.pid === 'number')
    return isRecord(started) && typeof started.pid === 'number' ? started.pid : null
  }, 15_000)
}

afterEach(async () => {
  try {
    await harness?.cleanup()
  } finally {
    harness = null
    delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  }
})


test('owner worker messages, answers, and exact stop reach an attested native child', async () => {
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = createOwnerWorkerStructuredRunnerFactory(() => {
    if (!harness) throw new Error('the owner worker harness is not connected')
    return harness.fixture.processScope
  })
  harness = await startWorkerAcceptance({ heldPrefix: 'The native worker has started the assigned task and is awaiting coordinator guidance.', uniqueThreads: true })
  await harness.fixture.call('quirky.agents/refresh', {})
  await harness.fixture.call('quirky.agents/setEnabled', { agent: 'codex', enabled: true })
  const agentCatalog = record(await harness.fixture.call('quirky.agents/list', {}), 'agent catalog')
  const codex = arrayField(agentCatalog, 'agents', 'agent catalog')
    .map((entry) => record(entry, 'agent row'))
    .find((entry) => entry.id === 'codex')
  if (!codex) throw new Error('Codex is missing from the public agent catalog')
  expect(codex).toMatchObject({ installed: true, enabled: true })


  await harness.fixture.call('plugin.install', { path: KIND_PLUGIN_DIR, yes: true })
  const coordinatorWorktreeId = stringField(harness.coordinator, 'worktreeId', 'coordinator session')
  const enrollmentResult = record(await harness.fixture.call('quirky.heimdall/enroll', {
    kind: KIND_ID,
    kindPayload: { worktreeId: coordinatorWorktreeId },
    owner: { agent: 'claude' },
    ownerInterventionCapability: 'on',
    capabilities: {
      'dispatch-worker': 'on',
      'message-worker': 'on',
      'answer-worker': 'on',
      'stop-worker': 'on'
    }
  }), 'Heimdall enrollment result')
  const watcherId = stringField(enrollmentResult.enrollment, 'watcherId', 'Heimdall enrollment result')

  const dispatchReport = await waitForOwnerReport(watcherId, 'owner-worker:dispatch')
  reportFile(dispatchReport.pending, {
    kind: 'kind-action',
    action: { operation: 'dispatch-worker', evidenceKey: 'owner-worker:dispatch' }
  })
  expect((await ownerReady(watcherId, dispatchReport.pending)).result.kind).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const target = await waitForOwnedWorker(watcherId)
  const targetIdentity = record(await harness.fixture.call('quirky.session/identity', { session: target.sessionId }), 'native worker identity')
  expect(targetIdentity).toMatchObject({ sessionId: target.sessionId, live: true })

  const sibling = record(await harness.fixture.call('quirky.structured/create', {
    worktree: coordinatorWorktreeId,
    agent: 'codex',
    title: 'Unowned native sibling',
    prompt: '[hold] Remain alive while the owner stops its exact worker.'
  }), 'unowned structured session')
  const siblingId = stringField(sibling, 'id', 'unowned structured session')
  const connectedSibling = await waitForAsync(async () => {
    const session = await harness!.session(siblingId)
    if (session.status === 'exited') {
      const messages = await harness!.fixture.call('quirky.structured/messages', { session: siblingId })
      throw new Error(`Unowned sibling failed before any stop: ${JSON.stringify(messages)}`)
    }
    return session.providerSession && session.status === 'working' ? session : null
  })
  expect(connectedSibling.providerSession?.id).not.toBe((await harness.session(target.sessionId)).providerSession?.id)
  const siblingPid = await waitForProviderProcess(siblingId)
  expect(processIsAlive(siblingPid)).toBe(true)

  const messageReport = await setDeviation(watcherId, 'owner-worker:message', 'Send a real message to the owned worker.')
  reportFile(messageReport.pending, { kind: 'message-worker', dispatchId: target.dispatchId, body: MESSAGE_BODY })
  expect((await ownerReady(watcherId, messageReport.pending)).result.kind).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await waitForAttempt(watcherId, 'message-worker')
  const deliveryCli = await workerCli(target.sessionId, ['check', '--wait', '--timeout-ms', '5000'])
  if (deliveryCli.code !== 0) throw new Error(`Worker check exit ${deliveryCli.code}: ${deliveryCli.stderr || deliveryCli.stdout}`)
  const delivery = parseCliJson(deliveryCli, 'worker delivery')
  expect(typeof delivery.deliveryId).toBe('string')
  expect(arrayField(delivery, 'messages', 'worker delivery')).toContainEqual(expect.objectContaining({ body: MESSAGE_BODY }))
  const askResult = await workerCli(target.sessionId, ['ask', '--question', QUESTION, '--timeout-ms', '0'])
  const question = parseCliJson(askResult, 'worker ask result')
  expect(question.state).toBe('timedOut')
  const messageId = stringField(question, 'messageId', 'worker ask result')


  const answerReport = await waitForAsync(async () => {
    const owner = record(await harness!.fixture.call('quirky.heimdall/ownerInspect', { watcherId }), 'owner inspection')
    const pending = owner.pending
    if (!isRecord(pending) || pending.phase !== 'waiting' || !isRecord(pending.deviation)) return null
    return pending.deviation.messageId === messageId && pending.deviation.dispatchId === target.dispatchId
      ? { owner, pending } : null
  }, 20_000)
  reportFile(answerReport.pending, { kind: 'answer-worker', dispatchId: target.dispatchId, messageId, body: ANSWER })
  const acceptedAnswer = await ownerReady(watcherId, answerReport.pending)
  expect(acceptedAnswer.result.kind).toBe('accepted')
  expect(acceptedAnswer.cli.code).toBe(0)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await waitForAttempt(watcherId, 'answer-worker')
  const replayedAnswer = await ownerReady(watcherId, answerReport.pending)
  expect(replayedAnswer.result.kind).toBe('refused')
  expect(replayedAnswer.cli.code).not.toBe(0)
  const resumedAsk = await harness.callAs<JsonRecord>(target.sessionId, 'ask', ['--resume', messageId, '--timeout-ms', '1000'])
  expect(resumedAsk).toMatchObject({ state: 'answered', answer: ANSWER, messageId })

  const stopReport = await setDeviation(watcherId, 'owner-worker:stop', 'Stop only the selected owned worker.')
  reportFile(stopReport.pending, { kind: 'stop-worker', dispatchId: target.dispatchId })
  const acceptedStop = await ownerReady(watcherId, stopReport.pending)
  expect(acceptedStop.result.kind).toBe('accepted')
  expect(acceptedStop.cli.code).toBe(0)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const stopAttempt = await waitForAttempt(watcherId, 'stop-worker')
  expect(stopAttempt.attempt.effect).toBe('landed')
  await waitForAsync(async () => {
    const session = record(await harness!.session(target.sessionId), 'stopped worker session')
    return session.status === 'exited' && !processIsAlive(target.pid) ? true : null
  }, 15_000)
  expect(processIsAlive(siblingPid)).toBe(true)
  expect((await harness.session(siblingId)).status).not.toBe('exited')
}, 150_000)
