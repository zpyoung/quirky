import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { WatcherDetail } from '../src/control-contracts'
import { startNativeControlFixture, type NativeControlFixture } from './native-worker-fixture'

const ANSWER_BODY = 'Proceed with the isolated fixture.'
const QUESTION_BODY = 'Continue?'

type SessionObservation = { id: string; status: string; exitCode: number | null; exitCause?: string | null }

// These deadlines bound RPCs to an independently running daemon; fake timers cannot advance its state.
async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  description: string,
  lastObservation: string
): Promise<T> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new Error(`Timed out waiting for ${description}; last observed state: ${lastObservation}`)
  const timeout = Promise.withResolvers<{ kind: 'timeout' }>()
  const timer = setTimeout(() => timeout.resolve({ kind: 'timeout' }), remainingMs)
  try {
    const outcome = await Promise.race([
      operation.then(value => ({ kind: 'value' as const, value })),
      timeout.promise
    ])
    if (outcome.kind === 'timeout') {
      throw new Error(`Timed out waiting for ${description}; last observed state: ${lastObservation}`)
    }
    return outcome.value
  } finally {
    clearTimeout(timer)
  }
}

async function watcherDetail(fixture: NativeControlFixture, watcherId: string): Promise<WatcherDetail> {
  const detail = await fixture.client.callAny('quirky.heimdall/detail', { target: { watcherId } }) as WatcherDetail | null
  if (!detail) throw new Error(`Heimdall detail disappeared for watcher ${watcherId}`)
  return detail
}

async function waitForDetail(
  fixture: NativeControlFixture,
  watcherId: string,
  description: string,
  accept: (detail: WatcherDetail) => boolean,
  timeoutMs = 60_000
): Promise<WatcherDetail> {
  const deadline = Date.now() + timeoutMs
  let lastObservation = 'no detail response'
  for (;;) {
    const detail = await beforeDeadline(watcherDetail(fixture, watcherId), deadline, description, lastObservation)
    lastObservation = JSON.stringify({
      status: detail.status,
      enrollment: {
        enabled: detail.enrollment.enabled,
        paused: detail.enrollment.paused,
        parkReason: detail.enrollment.parkReason,
        commandRevision: detail.enrollment.commandRevision
      },
      workers: detail.workers,
      journal: detail.journal
    })
    if (accept(detail)) return detail
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    // This polls live daemon/provider state; fake timers cannot advance isolated child processes.
    await Bun.sleep(Math.min(50, remainingMs))
  }
  throw new Error(`Timed out waiting for ${description}; last public detail observation: ${lastObservation}`)
}

function successfulCliResult(label: string, result: { code: number | null; stdout: string; stderr: string }): unknown {
  if (result.code !== 0) {
    throw new Error(`${label} CLI failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`${label} CLI did not return JSON\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`, { cause: error })
  }
}

async function waitForSessionExit(fixture: NativeControlFixture, sessionId: string): Promise<SessionObservation> {
  const deadline = Date.now() + 30_000
  let lastObservation = 'session get returned no result'
  for (;;) {
    const session = await beforeDeadline(
      fixture.client.callAny('quirky.session/get', { session: sessionId }) as Promise<SessionObservation>,
      deadline,
      `public session/get to observe ${sessionId} exited`,
      lastObservation
    )
    lastObservation = JSON.stringify(session)
    if (session.id === sessionId && session.status === 'exited') return session
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    // Public session state changes in an independently running daemon process.
    await Bun.sleep(Math.min(50, remainingMs))
  }
  throw new Error(`Timed out waiting for public session/get to observe ${sessionId} exited; last observation: ${lastObservation}`)
}

describe('native Heimdall worker controls', () => {
  test('answers a real worker question and stops that exact live process', async () => {
    const fixture = await startNativeControlFixture()
    try {
      const worker = await fixture.enrollQuestionWorker()
      const pending = await waitForDetail(
        fixture,
        worker.watcherId,
        `question ${worker.messageId} to park the attached worker`,
        detail => detail.status?.state === 'parked' &&
          detail.enrollment.parkReason === 'worker-question' &&
          detail.workers.some(candidate => candidate.identity.dispatchId === worker.dispatchId &&
            candidate.identity.sessionId === worker.sessionId &&
            candidate.identity.processIncarnation === worker.processIncarnation &&
            candidate.question?.messageId === worker.messageId &&
            candidate.question.answered !== true)
      )
      expect(pending.enrollment.enabled).toBe(false)
      expect(pending.journal).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'escalation',
          escalationKind: 'worker-question',
          messageId: worker.messageId,
          dispatchId: worker.dispatchId,
          body: QUESTION_BODY,
          resolved: false
        })
      ]))

      const startedEvidence = await fixture.readQuestionEvidence()
      expect(startedEvidence.code).toBeNull()
      expect(startedEvidence.providerPid).toBeGreaterThan(0)
      if (startedEvidence.cliPid === null) throw new Error('actual orchestration ask child did not report a process id')
      expect(startedEvidence.cliPid).toBeGreaterThan(0)
      expect(startedEvidence.sessionId).toBe(worker.sessionId)
      expect(startedEvidence.sessionTokenPresent).toBe(true)

      const answer = await fixture.runCli([
        'heimdall', 'answer', worker.watcherId, worker.messageId, '--body', ANSWER_BODY, '--json'
      ])
      expect(successfulCliResult('heimdall answer', answer)).toMatchObject({ kind: 'applied' })
      const askEvidence = await fixture.waitForQuestionResult()
      expect(askEvidence.code).toBe(0)
      expect(successfulCliResult('orchestration ask', askEvidence)).toMatchObject({
        state: 'answered',
        answer: ANSWER_BODY,
        messageId: worker.messageId
      })
      const answered = await waitForDetail(
        fixture,
        worker.watcherId,
        `the exact worker question ${worker.messageId} to be answered and unparked`,
        detail => detail.enrollment.enabled === true &&
          detail.enrollment.paused === false &&
          detail.enrollment.parkReason === null &&
          detail.status?.state !== 'parked' &&
          detail.workers.some(candidate => candidate.identity.dispatchId === worker.dispatchId) &&
          !detail.workers.some(candidate => candidate.question?.messageId === worker.messageId && candidate.question.answered !== true) &&
          detail.journal.some(entry => {
            const payload = entry.payload
            return entry.evidenceKind === 'worker-question-answered' &&
              typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
              (payload as Record<string, unknown>).messageId === worker.messageId &&
              (payload as Record<string, unknown>).body === ANSWER_BODY
          })
      )
      expect(answered.ownerFence.revision).toBeGreaterThan(pending.ownerFence.revision)
      expect(answered.enrollment.commandRevision).toBeGreaterThan(pending.enrollment.commandRevision)
      expect(answered.journal).toEqual(expect.arrayContaining([
        expect.objectContaining({
          evidenceKind: 'worker-question-answered',
          payload: { messageId: worker.messageId, body: ANSWER_BODY }
        })
      ]))

      const duplicate = await fixture.client.callAny('quirky.heimdall/command', {
        target: answered.target,
        expectedOwner: answered.ownerFence,
        command: { kind: 'answer-question', messageId: worker.messageId, body: 'A second answer must not apply.' }
      }) as { kind: string; reason?: string }
      expect(duplicate).toMatchObject({ kind: 'refused', reason: 'question-already-answered' })
      const afterDuplicate = await watcherDetail(fixture, worker.watcherId)
      expect(afterDuplicate.ownerFence.revision).toBe(answered.ownerFence.revision)
      expect(afterDuplicate.enrollment.commandRevision).toBe(answered.enrollment.commandRevision)

      const liveWorker = afterDuplicate.workers.find(candidate => candidate.identity.dispatchId === worker.dispatchId)
      expect(liveWorker).toMatchObject({
        state: 'live',
        identity: {
          dispatchId: worker.dispatchId,
          sessionId: worker.sessionId,
          processIncarnation: worker.processIncarnation
        }
      })
      const stop = await fixture.runCli(['heimdall', 'stop-worker', worker.watcherId, worker.dispatchId, '--json'])
      expect(successfulCliResult('heimdall stop-worker', stop)).toMatchObject({ kind: 'applied' })

      const exitedSession = await waitForSessionExit(fixture, worker.sessionId)
      expect(exitedSession).toMatchObject({ id: worker.sessionId, status: 'exited' })
      expect(typeof exitedSession.exitCode).toBe('number')
      expect(readFileSync(fixture.evidencePaths.providerPid, 'utf8').trim()).toBe(String(startedEvidence.providerPid))
    } finally {
      await fixture.cleanup()
    }
  }, 240_000)
})
