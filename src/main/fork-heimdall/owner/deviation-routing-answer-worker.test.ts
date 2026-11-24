import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLatestEscalations } from '../../../shared/fork-heimdall/ledger-queries'
import type { WorkerEscalationDeviation } from '../../../shared/fork-heimdall/owner/deviation'
import {
  CoordinatorSeatLostError,
  QuestionAlreadyAnsweredError
} from '../orchestration/orchestration-contract'
import {
  decodeOwnerDeviation,
  findOldestOpenOwnerDeviation,
  recordDeviation,
  type OwnerDeviationEscalation
} from './deviation-ledger'
import { driveOwnerDeviation } from './deviation-routing'
import {
  appendAcceptedOwnerReady,
  baseDeps,
  buildRunner,
  memoryLedgerStore,
  requireOpenOwnerDeviation,
  snapshot,
  type MemoryLedgerStore,
  type TestRoutingDependencies
} from './deviation-routing-test-harness'
import type { OwnerReportReadResult } from './owner-report-io'
import { OWNER_STALL_THRESHOLD_MS } from './stall-detector'

const { sendOwnerTurn, readOwnerReport } = vi.hoisted(() => ({
  sendOwnerTurn: vi.fn(async (_input: { session: unknown; turnText: string }) => {}),
  readOwnerReport: vi.fn(async (): Promise<OwnerReportReadResult<unknown>> => ({
    ok: false,
    reason: 'missing'
  }))
}))

vi.mock('./owner-session', () => ({
  ensureOwnerSession: vi.fn(async () => ({
    watcherId: 'watcher-1',
    sessionId: 'session-1',
    handle: 'handle-1',
    host: {}
  })),
  sendOwnerTurn,
  releaseOwnerSession: vi.fn()
}))
vi.mock('./owner-report-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readOwnerReport,
  issueOwnerReportPath: vi.fn(async () => '/report/path.json'),
  ownerReportPathForWake: () => '/report/path.json'
}))

const question = {
  kind: 'worker-question' as const,
  messageId: 'msg-question',
  dispatchId: 'dispatch-1',
  question: 'Which sandbox host?'
}

const escalation: WorkerEscalationDeviation = {
  kind: 'worker-escalation',
  escalationId: 'escalation-1',
  messageId: 'msg-escalation',
  dispatchId: 'dispatch-1',
  reason: 'QUIRKY_SANDBOX_DOCKER_HOST is not set in .claude/settings.local.json'
}

function sentOwnerTurnText(index: number): string {
  const input = sendOwnerTurn.mock.calls[index]?.[0]
  if (!input) {
    throw new Error(`Expected owner turn ${index} to have been sent`)
  }
  return input.turnText
}

/** Sends the first brief and accepts the owner's ready, so the next drive reads `report`. */
async function ownerReplies(
  deps: TestRoutingDependencies,
  ledgerStore: MemoryLedgerStore,
  report: unknown
): Promise<'idle' | 'handled'> {
  const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
  await driveOwnerDeviation(deps, runner, snapshot)
  appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
  readOwnerReport.mockResolvedValueOnce({ ok: true, path: '/report/path.json', report })
  return driveOwnerDeviation(deps, runner, snapshot)
}

function openDeviation(
  ledgerStore: MemoryLedgerStore,
  kind: 'worker-question' | 'worker-escalation'
): OwnerDeviationEscalation {
  const found = getLatestEscalations(ledgerStore.read('watcher-1'))
    .filter(
      (entry): entry is OwnerDeviationEscalation =>
        entry.escalationKind === 'owner-deviation' && entry.status === 'open'
    )
    .find((entry) => decodeOwnerDeviation(entry)?.kind === kind)
  if (!found) {
    throw new Error(`Expected an open ${kind} deviation`)
  }
  return found
}

// the import boundary keeps upstream OrchestrationError out of this directory; delivery reads only the code
function orchestrationRefusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function answerWorker(messageId: string) {
  return { kind: 'answer-worker', messageId, answer: 'Read it from the process env.' }
}

beforeEach(() => {
  vi.clearAllMocks()
  readOwnerReport.mockResolvedValue({ ok: false, reason: 'missing' })
})

describe('driveOwnerDeviation: answer-worker delivery', () => {
  it('rejects answer-worker aimed at an escalation instead of throwing, and the queue advances', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', escalation)
    recordDeviation({ ledgerStore, now: () => 2, createId: () => 'e2' }, 'watcher-1', question)
    const deps = baseDeps(ledgerStore)
    deps.readWorkerQuestion.mockResolvedValue({ status: 'absent' })
    deps.answerWorkerQuestion.mockRejectedValue(
      orchestrationRefusal(
        'question_not_found',
        'Question msg-escalation was not found in Run run-1.'
      )
    )
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })

    await driveOwnerDeviation(deps, runner, snapshot)
    appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
    readOwnerReport.mockResolvedValueOnce({
      ok: true,
      path: '/report/path.json',
      report: answerWorker('msg-escalation')
    })
    await expect(driveOwnerDeviation(deps, runner, snapshot)).resolves.toBe('handled')

    expect(deps.answerWorkerQuestion).not.toHaveBeenCalled()
    expect(deps.park).not.toHaveBeenCalled()
    expect(sendOwnerTurn).toHaveBeenCalledTimes(2)
    expect(sentOwnerTurnText(1)).toContain('worker escalation')
    expect(openDeviation(ledgerStore, 'worker-escalation').foldCount).toBe(2)

    await driveOwnerDeviation(deps, runner, snapshot)

    expect(sendOwnerTurn).toHaveBeenCalledTimes(3)
    expect(sentOwnerTurnText(2)).toContain('Which sandbox host?')
    expect(openDeviation(ledgerStore, 'worker-escalation').status).toBe('open')
  })

  it('delivers an answer to a pending question and resolves the deviation', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', question)
    const deps = baseDeps(ledgerStore)

    await ownerReplies(deps, ledgerStore, answerWorker('msg-question'))

    expect(deps.readWorkerQuestion).toHaveBeenCalledWith('msg-question')
    expect(deps.answerWorkerQuestion).toHaveBeenCalledWith(
      'msg-question',
      'Read it from the process env.'
    )
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))).toBeNull()
  })

  it.each([
    ['absent', { status: 'absent' as const }, 'not an open worker question'],
    ['closed', { status: 'closed' as const }, 'closed']
  ])('rejects an answer to a question the Run reads as %s', async (_label, state, reason) => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', question)
    const deps = baseDeps(ledgerStore)
    deps.readWorkerQuestion.mockResolvedValue(state)

    await expect(ownerReplies(deps, ledgerStore, answerWorker('msg-question'))).resolves.toBe(
      'handled'
    )

    expect(deps.answerWorkerQuestion).not.toHaveBeenCalled()
    expect(sentOwnerTurnText(1)).toContain(reason)
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(2)
  })

  it.each([
    ['a conflicting answer', new QuestionAlreadyAnsweredError('msg-question')],
    [
      'a question closed mid-delivery',
      orchestrationRefusal('dispatch_inactive', 'Question msg-question is closed.')
    ],
    [
      'a question gone mid-delivery',
      orchestrationRefusal('question_not_found', 'Question msg-question was not found.')
    ]
  ])('rejects instead of throwing when delivery refuses %s', async (_label, error) => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', question)
    const deps = baseDeps(ledgerStore)
    deps.answerWorkerQuestion.mockRejectedValue(error)

    await expect(ownerReplies(deps, ledgerStore, answerWorker('msg-question'))).resolves.toBe(
      'handled'
    )

    expect(sentOwnerTurnText(1)).toContain(error.message)
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(2)
  })

  it('waits without spending a retry while the question cannot be read', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', question)
    const deps = baseDeps(ledgerStore)
    deps.readWorkerQuestion.mockResolvedValue({ status: 'unverifiable', reason: 'seat offline' })

    await expect(ownerReplies(deps, ledgerStore, answerWorker('msg-question'))).resolves.toBe(
      'handled'
    )

    expect(deps.answerWorkerQuestion).not.toHaveBeenCalled()
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(1)
  })

  it('hands the deviation to a human once the question stays unreadable for a stall window, and the queue advances', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', question)
    recordDeviation({ ledgerStore, now: () => 2, createId: () => 'e2' }, 'watcher-1', escalation)
    const deps = baseDeps(ledgerStore)
    deps.readWorkerQuestion.mockResolvedValue({ status: 'unverifiable', reason: 'seat offline' })
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })

    await driveOwnerDeviation(deps, runner, snapshot)
    appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
    readOwnerReport.mockResolvedValue({
      ok: true,
      path: '/report/path.json',
      report: answerWorker('msg-question')
    })
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(decodeOwnerDeviation(requireOpenOwnerDeviation(ledgerStore))?.kind).toBe(
      'worker-question'
    )

    // the harness stamps the owner's ready at 10_000+, so this is one full stall window past it
    deps.ledgerRecord = { ...deps.ledgerRecord, now: () => 20_000 + OWNER_STALL_THRESHOLD_MS }
    await expect(driveOwnerDeviation(deps, runner, snapshot)).resolves.toBe('handled')

    const handedOff = getLatestEscalations(ledgerStore.read('watcher-1'))
      .filter(
        (entry): entry is OwnerDeviationEscalation => entry.escalationKind === 'owner-deviation'
      )
      .find((entry) => decodeOwnerDeviation(entry)?.kind === 'worker-question')
    expect(handedOff?.status).toBe('escalated')
    expect(handedOff?.reason).toContain('seat offline')
    expect(runner.ownerBudgetInterval).toBeNull()
    expect(deps.answerWorkerQuestion).not.toHaveBeenCalled()
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    expect(decodeOwnerDeviation(requireOpenOwnerDeviation(ledgerStore))?.kind).toBe(
      'worker-escalation'
    )
  })

  it('still propagates a lost coordinator seat', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', question)
    const deps = baseDeps(ledgerStore)
    deps.answerWorkerQuestion.mockRejectedValue(new CoordinatorSeatLostError('watcher-1'))

    await expect(ownerReplies(deps, ledgerStore, answerWorker('msg-question'))).rejects.toThrow(
      CoordinatorSeatLostError
    )
  })
})
