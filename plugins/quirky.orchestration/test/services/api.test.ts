import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { QuirkyEvent } from '@quirky/protocol'
import {
  callAs, failureOf, installAgentCli, openOrchestrationDb, requestId, runAgentCli,
  startServicesE2E, waitFor, type ServiceE2E, type ServiceClientId
} from './support'

const CLI_MAIN = resolve(import.meta.dir, '../../../../packages/cli/src/main.ts')
const EVENT_NAME = 'quirky.orchestration/message-arrived'

let harness: ServiceE2E

beforeEach(async () => {
  harness = await startServicesE2E()
})

afterEach(async () => {
  await harness?.cleanup()
})

type ServiceRun = {
  id: string
  coordinatorSessionId: string | null
  consumerGeneration: number
  serviceOwner: { pluginId: string; key: string }
}
type ServiceWorker = {
  assignmentActive: boolean
  dispatchId: string
  sessionId: string | null
  processIncarnation: string | null
  state: 'live' | 'exited' | 'unverifiable'
  lastContactAtMs: number | null
}
type ServiceQuestion = {
  messageId: string
  answerMessageId: string | null
  status: 'pending' | 'answered' | 'closed'
  body: string
  answerBody: string | null
}
type ServiceRunDetail = { run: ServiceRun; workers: ServiceWorker[]; questions: ServiceQuestion[] }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object response')
  return value as Record<string, unknown>
}

function stringField(value: unknown, field: string): string {
  const result = record(value)[field]
  if (typeof result !== 'string') throw new Error(`expected ${field} to be a string`)
  return result
}

function numberField(value: unknown, field: string): number {
  const result = record(value)[field]
  if (typeof result !== 'number') throw new Error(`expected ${field} to be a number`)
  return result
}

function nullableStringField(value: unknown, field: string): string | null {
  const result = record(value)[field]
  if (result !== null && typeof result !== 'string') throw new Error(`expected ${field} to be a string or null`)
  return result
}

function nullableNumberField(value: unknown, field: string): number | null {
  const result = record(value)[field]
  if (result !== null && typeof result !== 'number') throw new Error(`expected ${field} to be a number or null`)
  return result
}

function stringArrayField(value: unknown, field: string): unknown[] {
  const result = record(value)[field]
  if (!Array.isArray(result)) throw new Error(`expected ${field} to be an array`)
  return result
}

function parseRunCreate(value: unknown): { run: ServiceRun; replayed: boolean } {
  const root = record(value)
  const runValue = record(root.run)
  const owner = record(runValue.serviceOwner)
  const mutation = record(root.mutation)
  const coordinatorSessionId = runValue.coordinatorSessionId
  const generation = runValue.consumerGeneration
  if (coordinatorSessionId !== null && typeof coordinatorSessionId !== 'string') throw new Error('Run creator must be a session ID or null')
  if (typeof generation !== 'number') throw new Error('Run consumerGeneration must be a number')
  if (typeof owner.pluginId !== 'string' || typeof owner.key !== 'string' || typeof mutation.replayed !== 'boolean') {
    throw new Error('service Run response is missing owner or replay provenance')
  }
  return {
    run: {
      id: stringField(runValue, 'id'),
      coordinatorSessionId,
      consumerGeneration: generation,
      serviceOwner: { pluginId: owner.pluginId, key: owner.key }
    },
    replayed: mutation.replayed
  }
}

function parseRunDetail(value: unknown): ServiceRunDetail {
  const root = record(value)
  const runValue = record(root.run)
  const owner = record(runValue.serviceOwner)
  const coordinatorSessionId = runValue.coordinatorSessionId
  const generation = runValue.consumerGeneration
  if (coordinatorSessionId !== null && typeof coordinatorSessionId !== 'string') throw new Error('Run creator must be a session ID or null')
  if (typeof generation !== 'number' || typeof owner.pluginId !== 'string' || typeof owner.key !== 'string') {
    throw new Error('service Run detail is missing ownership data')
  }
  const workers = stringArrayField(root, 'workers').map((value): ServiceWorker => {
    const worker = record(value)
    const state = worker.state
    if (state !== 'live' && state !== 'exited' && state !== 'unverifiable') throw new Error('worker detail has an invalid liveness state')
    if (typeof worker.assignmentActive !== 'boolean') throw new Error('worker detail is missing assignment state')
    return {
      assignmentActive: worker.assignmentActive,
      dispatchId: stringField(worker, 'dispatchId'),
      sessionId: nullableStringField(worker, 'sessionId'),
      processIncarnation: nullableStringField(worker, 'processIncarnation'),
      state,
      lastContactAtMs: nullableNumberField(worker, 'lastContactAtMs')
    }
  })
  const questions = stringArrayField(root, 'questions').map((value): ServiceQuestion => {
    const question = record(value)
    const status = question.status
    if (status !== 'pending' && status !== 'answered' && status !== 'closed') throw new Error('question detail has an invalid status')
    return {
      messageId: stringField(question, 'messageId'),
      answerMessageId: nullableStringField(question, 'answerMessageId'),
      status,
      body: stringField(question, 'body'),
      answerBody: nullableStringField(question, 'answerBody')
    }
  })
  return {
    run: {
      id: stringField(runValue, 'id'),
      coordinatorSessionId,
      consumerGeneration: generation,
      serviceOwner: { pluginId: owner.pluginId, key: owner.key }
    },
    workers,
    questions
  }
}

function runCreateParams(key: string, objective: string, id = requestId()): Record<string, unknown> {
  return { requestId: id, contractVersion: 1, key, objective }
}

async function createRun(client: ServiceClientId, key = `key-${randomUUID()}`, objective = `objective-${randomUUID()}`): Promise<ServiceRun> {
  const result = parseRunCreate(await callAs(harness, client, 'serviceRunCreate', runCreateParams(key, objective)))
  return result.run
}

async function startWorker(runId: string, options: { worktree?: string; requestId?: string } = {}): Promise<string> {
  const result = record(await callAs(harness, 'a', 'serviceWorkerStart', {
    runId,
    requestId: options.requestId ?? requestId(),
    contractVersion: 1,
    worktree: options.worktree ?? `path:${harness.repo}`,
    agent: 'claude',
    spec: `Service worker ${randomUUID()}`,
    timeoutMs: 20_000
  }))
  const state = record(result.receipt ?? result).state
  expect(state).toBe('ready')
  return stringField(result.receipt ?? result, 'dispatchId')
}

function errorReason(error: string | null): string {
  if (!error) throw new Error('expected the service API call to fail')
  return error
}

function eventMatches(event: QuirkyEvent, runId: string, messageId?: string): boolean {
  if (event.type !== EVENT_NAME || !('data' in event)) return false
  const data = event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('runId' in data) || data.runId !== runId) return false
  return messageId === undefined || ('messageId' in data && data.messageId === messageId)
}

function eventCount(h: ServiceE2E, runId: string): number {
  return h.events.filter((event) => eventMatches(event, runId)).length
}

describe('service-owned Run authority and receipts', () => {
  test('authenticates kernel plugin callers, isolates owners, and preserves stable-key receipt semantics', async () => {
    const key = `stable-${randomUUID()}`
    const objective = `owner objective ${randomUUID()}`
    const params = runCreateParams(key, objective)
    const cliFailure = await failureOf(harness.call('quirky.orchestration/serviceRunCreate', params))
    expect(cliFailure).not.toBeNull()

    const original = parseRunCreate(await callAs(harness, 'a', 'serviceRunCreate', params))
    const replay = parseRunCreate(await callAs(harness, 'a', 'serviceRunCreate', params))
    expect(replay.run.id).toBe(original.run.id)
    expect(replay.replayed).toBe(true)
    const stableKey = parseRunCreate(await callAs(harness, 'a', 'serviceRunCreate', runCreateParams(key, objective)))
    expect(stableKey.run.id).toBe(original.run.id)
    expect(original.run.coordinatorSessionId).toBeNull()
    expect(original.run.serviceOwner.pluginId).toBe('acme.orchestration-a')
    expect(original.run.serviceOwner.key).toBe(key)

    const mismatch = runCreateParams(key, `${objective} changed`, stringField(record(params), 'requestId'))
    expect(errorReason(await failureOf(callAs(harness, 'a', 'serviceRunCreate', mismatch)))).toContain('request_mismatch')

    const otherOwner = parseRunCreate(await callAs(harness, 'b', 'serviceRunCreate', runCreateParams(key, objective)))
    expect(otherOwner.run.id).not.toBe(original.run.id)

    const sharedRequest = requestId()
    const sharedPayload = runCreateParams(`principal-${randomUUID()}`, `principal isolation ${randomUUID()}`, sharedRequest)
    const principalA = parseRunCreate(await callAs(harness, 'a', 'serviceRunCreate', sharedPayload))
    const principalB = parseRunCreate(await callAs(harness, 'b', 'serviceRunCreate', sharedPayload))
    expect(principalA.run.id).not.toBe(principalB.run.id)
    expect(principalA.run.serviceOwner.pluginId).toBe('acme.orchestration-a')
    expect(principalB.run.serviceOwner.pluginId).toBe('acme.orchestration-b')
    const foreignDetail = await failureOf(callAs(harness, 'b', 'serviceRunShow', { runId: original.run.id }))

    expect(await failureOf(callAs(harness, 'b', 'serviceCheck', {
      runId: original.run.id, requestId: requestId(), contractVersion: 1
    }))).not.toBeNull()
    expect(errorReason(foreignDetail)).not.toContain(objective)

    const spoofedOwner = await failureOf(callAs(harness, 'a', 'serviceRunCreate', {
      ...runCreateParams(`spoof-${randomUUID()}`, 'spoof check'), pluginId: 'acme.orchestration-b', authority: 'kernel_plugin'
    }))
    expect(spoofedOwner).not.toBeNull()

    const unknownRequestId = requestId()
    const unknownObjective = `unknown receipt ${randomUUID()}`
    const unknownParams = runCreateParams(`unknown-${randomUUID()}`, unknownObjective, unknownRequestId)
    const accepted = parseRunCreate(await callAs(harness, 'a', 'serviceRunCreate', unknownParams))
    const db = openOrchestrationDb(harness)
    try {
      db.query("UPDATE mutation_receipts SET state = 'pending', checkpoint_json = NULL, result_json = NULL WHERE request_id = ?").run(unknownRequestId)
      const countBefore = numberField(db.query('SELECT COUNT(*) AS count FROM runs WHERE objective = ?').get(unknownObjective), 'count')
      expect(countBefore).toBe(1)
      expect(errorReason(await failureOf(callAs(harness, 'a', 'serviceRunCreate', unknownParams)))).toContain('operation_unknown')
      const countAfter = numberField(db.query('SELECT COUNT(*) AS count FROM runs WHERE objective = ?').get(unknownObjective), 'count')
      expect(countAfter).toBe(countBefore)
      expect(accepted.run.id).toBeTruthy()
    } finally {
      db.close()
    }
  })

  test('does not repeat a timed-out service check with an unknown receipt', async () => {
    const run = await createRun('a')
    const timeoutRequest = { runId: run.id, requestId: requestId(), contractVersion: 1, wait: true, timeoutMs: 0 }
    const timedOut = record(await callAs(harness, 'a', 'serviceCheck', timeoutRequest))
    expect(timedOut.timedOut).toBe(true)

    const db = openOrchestrationDb(harness)
    try {
      db.query("UPDATE mutation_receipts SET state = 'pending', checkpoint_json = NULL, result_json = NULL WHERE request_id = ?").run(timeoutRequest.requestId)
      const deliveryCount = numberField(db.query('SELECT COUNT(*) AS count FROM deliveries WHERE run_id = ?').get(run.id), 'count')
      expect(errorReason(await failureOf(callAs(harness, 'a', 'serviceCheck', timeoutRequest)))).toContain('operation_unknown')
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM deliveries WHERE run_id = ?').get(run.id), 'count')).toBe(deliveryCount)
      expect(parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })).questions).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('owned Run details, mailbox consumption, and question replies', () => {
  test('repeated owner detail is non-consuming and question answers are authoritative and conflict-safe', async () => {
    const run = await createRun('a')
    const questionBody = `Need approval ${randomUUID()}`
    installAgentCli(harness, CLI_MAIN, [
      'orchestration', 'ask', '--to', `run:${run.id}`, '--question', questionBody, '--timeout-ms', '20000'
    ])
    const dispatchId = await startWorker(run.id)

    const question = await waitFor(async () => {
      const detail = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id }))
      return detail.questions.find((candidate) => candidate.status === 'pending')
    }, 15_000, 'worker question')
    expect(question.body).toBe(questionBody)

    const db = openOrchestrationDb(harness)
    let deliveryId: string
    try {
      const receiptCount = numberField(db.query('SELECT COUNT(*) AS count FROM mutation_receipts').get(), 'count')
      const pointerCount = numberField(db.query('SELECT COUNT(*) AS count FROM pointer_operations').get(), 'count')
      const detailBefore = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id }))
      expect(detailBefore.run.coordinatorSessionId).toBeNull()
      const detailedWorker = detailBefore.workers.find((candidate) => candidate.dispatchId === dispatchId)
      if (!detailedWorker || typeof detailedWorker.sessionId !== 'string' || typeof detailedWorker.processIncarnation !== 'string') {
        throw new Error('the service Run detail omitted its proven worker identity')
      }
      expect(detailedWorker.state).toBe('live')
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM mutation_receipts').get(), 'count')).toBe(receiptCount)
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM pointer_operations').get(), 'count')).toBe(pointerCount)
      const beforeCount = numberField(db.query('SELECT COUNT(*) AS count FROM deliveries WHERE run_id = ?').get(run.id), 'count')
      const refreshed = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id }))
      expect(refreshed.run.consumerGeneration).toBe(detailBefore.run.consumerGeneration)
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM deliveries WHERE run_id = ?').get(run.id), 'count')).toBe(beforeCount)
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM mutation_receipts').get(), 'count')).toBe(receiptCount)
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM pointer_operations').get(), 'count')).toBe(pointerCount)

      const checked = record(await callAs(harness, 'a', 'serviceCheck', {
        runId: run.id, requestId: requestId(), contractVersion: 1, types: ['question']
      }))
      deliveryId = stringField(checked, 'deliveryId')
      expect(checked.mode).toBe('consume')
      expect(stringArrayField(checked, 'messages').map((message) => stringField(message, 'id'))).toContain(question.messageId)
      const checkedQuestion = stringArrayField(checked, 'questions').map(record)
        .find((candidate) => candidate.messageId === question.messageId)
      expect(checkedQuestion?.status).toBe('pending')
      expect(checkedQuestion?.body).toBe(questionBody)
      const delivery = record(db.query('SELECT status, consumer_generation FROM deliveries WHERE id = ?').get(deliveryId))
      expect(stringField(delivery, 'status')).toBe('outstanding')
      expect(numberField(delivery, 'consumer_generation')).toBe(detailBefore.run.consumerGeneration)
      expect(numberField(db.query('SELECT read FROM messages WHERE id = ?').get(question.messageId), 'read')).toBe(0)

      await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })
      await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })
      expect(stringField(db.query('SELECT status FROM deliveries WHERE id = ?').get(deliveryId), 'status')).toBe('outstanding')

      const replayedDelivery = record(await callAs(harness, 'a', 'serviceCheck', {
        runId: run.id, requestId: requestId(), contractVersion: 1, types: ['question']
      }))
      expect(replayedDelivery.deliveryId).toBe(deliveryId)
      expect(replayedDelivery.replayed).toBe(true)

      const answerBody = `Approved ${randomUUID()}`
      const unrelatedRun = await createRun('a')
      const wrongRunReply = await failureOf(callAs(harness, 'a', 'serviceReply', {
        runId: unrelatedRun.id, messageId: question.messageId, body: 'not for this Run',
        requestId: requestId(), contractVersion: 1
      }))
      expect(wrongRunReply).not.toBeNull()
      const pendingAfterWrongRun = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })).questions
        .find((candidate) => candidate.messageId === question.messageId)
      expect(pendingAfterWrongRun?.status).toBe('pending')

      const replyParams = {
        runId: run.id, messageId: question.messageId, body: answerBody,
        requestId: requestId(), contractVersion: 1
      }
      const reply = record(await callAs(harness, 'a', 'serviceReply', replyParams))
      expect(reply.kind).toBe('question_answer')
      const answered = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id }))
      const answeredQuestion = answered.questions.find((candidate) => candidate.messageId === question.messageId)
      expect(answeredQuestion?.status).toBe('answered')
      expect(answeredQuestion?.body).toBe(questionBody)
      expect(answeredQuestion?.answerBody).toBe(answerBody)
      if (!answeredQuestion?.answerMessageId) throw new Error('the accepted question reply has no message identity')

      db.query("UPDATE mutation_receipts SET state = 'pending', checkpoint_json = NULL, result_json = NULL WHERE request_id = ?").run(replyParams.requestId)
      expect(errorReason(await failureOf(callAs(harness, 'a', 'serviceReply', replyParams)))).toContain('operation_unknown')
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get(answeredQuestion.answerMessageId), 'count')).toBe(1)
      expect(errorReason(await failureOf(callAs(harness, 'a', 'serviceReply', {
        runId: run.id, messageId: question.messageId, body: 'Conflicting answer',
        requestId: requestId(), contractVersion: 1
      })))).toContain('answer_conflict')

      const acknowledged = record(await callAs(harness, 'a', 'serviceCheck', {
        runId: run.id, requestId: requestId(), contractVersion: 1, ackDeliveryId: deliveryId
      }))
      const answeredAfterAck = stringArrayField(acknowledged, 'questions').map(record)
        .find((candidate) => candidate.messageId === question.messageId)
      expect(answeredAfterAck?.status).toBe('answered')
      expect(answeredAfterAck?.body).toBe(questionBody)
      expect(answeredAfterAck?.answerBody).toBe(answerBody)
    } finally {
      db.close()
    }
  }, 60_000)
})

describe('worker placement, sender authority, and committed arrival events', () => {
  test('requires explicit placement, hides foreign dispatches, and emits only committed Run-sender mail', async () => {
    const run = await createRun('a')
    const db = openOrchestrationDb(harness)
    try {
      const invalidRequests = ['current', 'new-child'] as const
      for (const worktree of invalidRequests) {
        const invalidRequest = requestId()
        const error = await failureOf(callAs(harness, 'a', 'serviceWorkerStart', {
          runId: run.id, requestId: invalidRequest, contractVersion: 1, worktree,
          agent: 'claude', spec: `invalid ${worktree}`
        }))
        expect(error).not.toBeNull()
        expect(numberField(db.query('SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?').get(run.id), 'count')).toBe(0)
        expect(numberField(db.query('SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_id = ?').get(invalidRequest), 'count')).toBe(0)
      }

      const aliasRequest = requestId()
      expect(await failureOf(callAs(harness, 'a', 'serviceWorkerStart', {
        runId: run.id, requestId: aliasRequest, contractVersion: 1, worktree: `path:${harness.repo}`,
        agent: 'claude', spec: 'aliases are not service authority', from: 'forged', terminal: 'forged'
      }))).not.toBeNull()
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM tasks WHERE run_id = ?').get(run.id), 'count')).toBe(0)
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_id = ?').get(aliasRequest), 'count')).toBe(0)

      const dispatchId = await startWorker(run.id)
      const foreignSend = await failureOf(callAs(harness, 'b', 'serviceSend', {
        runId: run.id, dispatchId, body: 'must remain private', requestId: requestId(), contractVersion: 1
      }))
      expect(foreignSend).not.toBeNull()
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM messages WHERE body = ?').get('must remain private'), 'count')).toBe(0)

      const otherRun = await createRun('a')
      const crossRunBody = `cross-run dispatch ${randomUUID()}`
      expect(await failureOf(callAs(harness, 'a', 'serviceSend', {
        runId: otherRun.id, dispatchId, body: crossRunBody, requestId: requestId(), contractVersion: 1
      }))).not.toBeNull()
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM messages WHERE body = ?').get(crossRunBody), 'count')).toBe(0)

      const rollbackBody = `rolled back ${randomUUID()}`
      const rollbackRequest = requestId()
      db.exec(`CREATE TRIGGER service_send_rollback AFTER INSERT ON messages WHEN NEW.body = '${rollbackBody}' BEGIN SELECT RAISE(ABORT, 'forced service send rollback'); END`)
      const eventsBefore = eventCount(harness, run.id)
      expect(await failureOf(callAs(harness, 'a', 'serviceSend', {
        runId: run.id, dispatchId, body: rollbackBody, requestId: rollbackRequest, contractVersion: 1
      }))).not.toBeNull()
      // Flush the daemon's socket-delivered event queue; fake timers cannot drive a separate daemon process.
      await Bun.sleep(50)
      expect(eventCount(harness, run.id)).toBe(eventsBefore)
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM messages WHERE body = ?').get(rollbackBody), 'count')).toBe(0)
      expect(numberField(db.query('SELECT COUNT(*) AS count FROM mutation_receipts WHERE request_id = ?').get(rollbackRequest), 'count')).toBe(0)
      db.exec('DROP TRIGGER service_send_rollback')

      const successful = record(await callAs(harness, 'a', 'serviceSend', {
        runId: run.id, dispatchId, body: 'committed guidance', requestId: rollbackRequest, contractVersion: 1
      }))
      const message = record(stringArrayField(successful, 'messages')[0])
      const messageId = stringField(message, 'id')
      const arrival = await waitFor(() => harness.events.find((event) => eventMatches(event, run.id, messageId)), 5_000, 'committed message-arrived event')
      expect(arrival.type).toBe(EVENT_NAME)
      if (!('data' in arrival)) throw new Error('message-arrived event has no payload')
      const data = record(arrival.data)
      expect(data).toEqual({ runId: run.id, messageId, type: 'status' })
      const row = record(db.query('SELECT run_id, from_session_id, sender_kind, sender_id, mailbox_kind, mailbox_id, type FROM messages WHERE id = ?').get(messageId))
      expect(row).toEqual({
        run_id: run.id, from_session_id: null, sender_kind: 'run', sender_id: run.id,
        mailbox_kind: 'dispatch', mailbox_id: dispatchId, type: 'status'
      })
    } finally {
      db.exec('DROP TRIGGER IF EXISTS service_send_rollback')
      db.close()
    }
  }, 60_000)
})

describe('exact worker controls and guarded release', () => {
  test('rejects changed process identity before stop, then uses the existing exact-identity stop path', async () => {
    const run = await createRun('a')
    const dispatchId = await startWorker(run.id)
    const detail = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id }))
    const worker = detail.workers.find((candidate) => candidate.dispatchId === dispatchId)
    if (!worker || typeof worker.sessionId !== 'string' || typeof worker.processIncarnation !== 'string') {
      throw new Error('the running worker did not expose its proven process identity')
    }
    const expectedIdentity = { sessionId: worker.sessionId, processIncarnation: worker.processIncarnation }

    const foreignStop = await failureOf(callAs(harness, 'b', 'serviceWorkerStop', {
      runId: run.id, dispatchId, expectedIdentity, requestId: requestId(), contractVersion: 1
    }))
    expect(foreignStop).not.toBeNull()
    const unrelatedRun = await createRun('a')
    expect(await failureOf(callAs(harness, 'a', 'serviceWorkerStop', {
      runId: unrelatedRun.id, dispatchId, expectedIdentity, requestId: requestId(), contractVersion: 1
    }))).not.toBeNull()
    const afterForeignStop = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })).workers
      .find((candidate) => candidate.dispatchId === dispatchId)
    expect(afterForeignStop?.sessionId).toBe(expectedIdentity.sessionId)
    expect(afterForeignStop?.processIncarnation).toBe(expectedIdentity.processIncarnation)
    expect(afterForeignStop?.state).toBe('live')

    const mismatch = await failureOf(callAs(harness, 'a', 'serviceWorkerStop', {
      runId: run.id, dispatchId,
      expectedIdentity: { ...expectedIdentity, processIncarnation: `wrong-${expectedIdentity.processIncarnation}` },
      requestId: requestId(), contractVersion: 1
    }))
    expect(errorReason(mismatch)).toMatch(/identity|incarnation|worker_identity_changed/u)
    const afterMismatchedStop = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })).workers
      .find((candidate) => candidate.dispatchId === dispatchId)
    expect(afterMismatchedStop?.sessionId).toBe(expectedIdentity.sessionId)
    expect(afterMismatchedStop?.processIncarnation).toBe(expectedIdentity.processIncarnation)
    expect(afterMismatchedStop?.state).toBe('live')

    const stopped = record(await callAs(harness, 'a', 'serviceWorkerStop', {
      runId: run.id, dispatchId, expectedIdentity, requestId: requestId(), contractVersion: 1
    }))
    expect(stopped).toMatchObject({ dispatchId, state: 'stopped', processAction: 'closed_agent_terminal' })
    const afterStop = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })).workers
      .find((candidate) => candidate.dispatchId === dispatchId)
    expect(afterStop).toMatchObject({
      dispatchId,
      sessionId: expectedIdentity.sessionId,
      processIncarnation: expectedIdentity.processIncarnation,
      state: 'exited',
      assignmentActive: false
    })
  }, 60_000)

  test('releases a settled worker through archive and custody guards without erasing its identity', async () => {
    const run = await createRun('a')
    const dispatchId = await startWorker(run.id)
    const live = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })).workers
      .find((candidate) => candidate.dispatchId === dispatchId)
    if (!live || typeof live.sessionId !== 'string' || typeof live.processIncarnation !== 'string') {
      throw new Error('the running worker did not expose its proven process identity')
    }
    const stableIdentity = { sessionId: live.sessionId, processIncarnation: live.processIncarnation }
    const dispatch = record(record(await harness.call('quirky.orchestration/workerShow', { dispatchId })).dispatch)
    const report = await runAgentCli(harness, stableIdentity.sessionId, [
      'orchestration', 'send', '--type', 'worker_done',
      '--task-id', stringField(dispatch, 'taskId'), '--dispatch-id', dispatchId,
      '--outcome', 'succeeded', '--subject', 'Service release fixture',
      '--body', 'The isolated worker started its assigned task. This report uses its real inherited launch authority. The fixture is ready for guarded release.'
    ])
    expect(report.code).toBe(0)
    expect(record(record(JSON.parse(report.stdout)).report).status).toBe('accepted')
    const settled = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })).workers
      .find((candidate) => candidate.dispatchId === dispatchId)
    expect(settled?.state).toBe('live')
    expect(settled?.assignmentActive).toBe(false)
    const unrelatedRun = await createRun('a')
    expect(await failureOf(callAs(harness, 'a', 'serviceWorkerRelease', {
      runId: unrelatedRun.id, dispatchId, requestId: requestId(), contractVersion: 1
    }))).not.toBeNull()

    const released = record(await callAs(harness, 'a', 'serviceWorkerRelease', {
      runId: run.id, dispatchId, requestId: requestId(), contractVersion: 1
    }))
    expect(released.state).toBe('released')
    const archive = record(await harness.call('quirky.orchestration/workerRead', { dispatchId, source: 'terminal' }))
    expect(archive.archived).toBe(true)
    expect(archive.sourceExact).toBe(true)
    expect(archive.sessionId).toBe(stableIdentity.sessionId)

    const after = parseRunDetail(await callAs(harness, 'a', 'serviceRunShow', { runId: run.id })).workers
      .find((candidate) => candidate.dispatchId === dispatchId)
    expect(after?.dispatchId).toBe(dispatchId)
    expect(after?.sessionId).toBe(stableIdentity.sessionId)
    expect(after?.processIncarnation).toBe(stableIdentity.processIncarnation)
    expect(after?.state).toBe('exited')
    expect(after?.assignmentActive).toBe(false)
  }, 60_000)
})

