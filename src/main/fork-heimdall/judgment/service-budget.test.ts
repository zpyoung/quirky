import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OBJECTIVE_JUDGMENT_QUESTION_IDS } from '../../../shared/fork-heimdall/judgment/registry'
import type { JudgmentQuestionRequest } from '../../../shared/fork-heimdall/judgment/types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import { HeimdallDatabase } from '../database'
import { HeimdallLedgerStore } from '../ledger-store'
import { judgmentRequestFitsTransportLimits, JUDGMENT_MAX_REQUEST_BYTES } from './client'
import { computeJudgmentIdentity } from './identity'
import { world as buildWorld } from './judgment-test-world'
import { expandJudgmentState, JUDGMENT_STATE_NORMALIZATION_GUIDANCE } from './state-normalization'
import { stableJson } from './state-projection'
import { JudgmentService, type JudgmentServiceDependencies } from './service'
import { JudgmentAnswerStore } from './store'

const watcherId = 'judgment-budget-watcher'

function world(): ObjectiveWorld {
  return buildWorld()
}

let root: string
let database: HeimdallDatabase
let ledger: HeimdallLedgerStore
let calls: number
let dependencies: JudgmentServiceDependencies

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-judgment-budget-'))
  database = new HeimdallDatabase(root)
  ledger = new HeimdallLedgerStore(database)
  calls = 0
  dependencies = {
    store: new JudgmentAnswerStore(ledger),
    databasePath: () => database.databasePath(),
    readAccess: () => ({ enabled: true, apiKey: 'secret' }),
    questionPolicy: () => ({
      mode: 'shadow',
      thresholdName: 'TEST_CONFIDENCE',
      calibratedModel: null
    }),
    createClient: () => {
      throw new Error('test must install client')
    }
  }
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('bounded judgment service', () => {
  it('retries a new bounded identity, filters only omitted subjects, and replays it', async () => {
    ledger.append({
      eventId: 'historical-attempt',
      watcherId,
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'historical-attempt',
      fingerprint: 'historical-fingerprint',
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'historical-evidence'
      },
      state: 'settled',
      effect: 'not-landed',
      reason: 'old failure '.repeat(500),
      dispatchId: 'worker-state'
    })
    ledger.append({
      eventId: 'pending-attempt',
      watcherId,
      atMs: 2,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'pending-attempt',
      fingerprint: 'pending-fingerprint',
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'pending-evidence'
      },
      state: 'running',
      dispatchId: 'pending-dispatch'
    })
    const current = world()
    const full = computeJudgmentIdentity('content-1', current, ledger.read(watcherId))
    dependencies.store.recordOutcome(
      watcherId,
      {
        stateIdentity: full.stateIdentity,
        contentIdentity: full.contentIdentity,
        projectionDigest: full.projectionDigest
      },
      'unavailable',
      'legacy oversized state'
    )
    dependencies.maxStateBytes = full.serializedBytes - 1
    const requests: JudgmentQuestionRequest[] = [
      {
        id: 'historical-failure',
        questionId: OBJECTIVE_JUDGMENT_QUESTION_IDS.failureClassification,
        subjectId: 'worker-state',
        question: {
          type: 'choice',
          instructions: 'Classify the historical failure.',
          criteria: { infra: 'Infrastructure', criteria: 'Criteria' }
        }
      },
      {
        id: 'global-worker-screen',
        questionId: OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen,
        subjectId: 'worker-state',
        question: {
          type: 'choice',
          instructions: 'Screen all retained worker state.',
          criteria: { clean: 'Clean', tainted: 'Tainted' }
        }
      },
      {
        id: 'pending-failure',
        questionId: OBJECTIVE_JUDGMENT_QUESTION_IDS.failureClassification,
        subjectId: 'pending-dispatch',
        question: {
          type: 'choice',
          instructions: 'Classify the pending dispatch.',
          criteria: { infra: 'Infrastructure', criteria: 'Criteria' }
        }
      },
      {
        id: 'global-preflight',
        questionId: OBJECTIVE_JUDGMENT_QUESTION_IDS.preflight,
        subjectId: 'implement',
        question: {
          type: 'choice',
          instructions: 'Check retained state before implementation.',
          criteria: { proceed: 'Proceed', hold: 'Hold' }
        }
      }
    ]
    let sentQuestionIds: string[] = []
    dependencies.createClient = () => ({
      evaluate: async (_state, questions) => {
        calls += 1
        sentQuestionIds = Object.keys(questions)
        const answer = {
          type: 'choice' as const,
          choice: 'proceed',
          probabilities: { proceed: 1 },
          confidence: 1
        }
        return {
          model: 'jev-test-1',
          answers: Object.fromEntries(sentQuestionIds.map((id) => [id, answer]))
        }
      }
    })
    const input = {
      watcherId,
      contentIdentity: 'content-1',
      world: current,
      requests,
      authority: 'local-desktop' as const
    }

    const first = await new JudgmentService(dependencies).evaluate(input)
    expect(first.status).toBe('answered')
    expect(first.stateIdentity).not.toBe(full.stateIdentity)
    expect(sentQuestionIds).toEqual(['global-worker-screen', 'pending-failure', 'global-preflight'])
    expect(first.answers['historical-failure']).toBeUndefined()
    expect(first.notices.some((notice) => notice.includes('oldest-history-first'))).toBe(true)

    expect(JSON.stringify(ledger.read(watcherId))).toContain('oldest-history-first')

    const replay = await new JudgmentService(dependencies).evaluate(input)
    expect(replay.status).toBe('answered')
    expect(replay.stateIdentity).toBe(first.stateIdentity)
    expect(replay.answers).toEqual(first.answers)
    expect(replay.notices.some((notice) => notice.includes('oldest-history-first'))).toBe(true)
    expect(calls).toBe(1)
  })

  it('sends normalized bytes with trusted guidance, bypasses stale raw absence, and replays once', async () => {
    const repeated = 'exact repeated context with unicode 界 and escaped \\\\ text '.repeat(40)
    const current = world()
    current.contract = {
      ...current.contract,
      objectiveText: repeated,
      writeTerritory: [repeated, repeated]
    }
    const computed = computeJudgmentIdentity('normalized-content', current, ledger.read(watcherId))
    expect(computed.normalization).not.toBeNull()
    const rawState = expandJudgmentState(computed.state)
    const { contentIdentity: _contentIdentity, ...rawProjection } = rawState
    const legacyProjectionDigest = createHash('sha256')
      .update(stableJson(rawProjection))
      .digest('hex')
    const legacyIdentity = {
      contentIdentity: 'normalized-content',
      projectionDigest: legacyProjectionDigest,
      stateIdentity: createHash('sha256')
        .update(`normalized-content\n${legacyProjectionDigest}`)
        .digest('hex')
    }
    expect(legacyIdentity.stateIdentity).not.toBe(computed.stateIdentity)
    dependencies.store.recordOutcome(
      watcherId,
      legacyIdentity,
      'unavailable',
      'legacy raw-shape absence'
    )

    const request: JudgmentQuestionRequest = {
      id: 'normalized-failure',
      questionId: OBJECTIVE_JUDGMENT_QUESTION_IDS.failureClassification,
      subjectId: 'dispatch-1',
      question: {
        type: 'choice',
        instructions: 'Classify the failure.',
        criteria: { infra: 'Infrastructure', criteria: 'Acceptance criteria' }
      }
    }
    const sent: { state: unknown; question: JudgmentQuestionRequest['question'] }[] = []
    dependencies.createClient = () => ({
      evaluate: async (state, questions) => {
        calls += 1
        sent.push({ state, question: questions[request.id]! })
        return {
          model: 'jev-test-1',
          answers: {
            [request.id]: {
              type: 'choice',
              choice: 'infra',
              probabilities: { infra: 0.98, criteria: 0.02 },
              confidence: 0.95
            }
          }
        }
      }
    })
    const input = {
      watcherId,
      contentIdentity: 'normalized-content',
      world: current,
      requests: [request],
      authority: 'local-desktop' as const
    }
    const first = await new JudgmentService(dependencies).evaluate(input)
    expect(first.status).toBe('answered')
    expect(sent[0]!.state).toEqual(computed.state)
    expect(JSON.stringify(sent[0]!.state)).toBe(computed.serializedState)
    expect(sent[0]!.question.instructions).toContain('Trusted state encoding')
    expect(sent[0]!.question.instructions).toContain(request.question.instructions)
    expect(sent[0]!.question.criteria).toEqual(request.question.criteria)
    expect(first.notices.some((notice) => notice.includes('shared-string normalization'))).toBe(
      true
    )
    expect(JSON.stringify(ledger.read(watcherId))).not.toContain(repeated)

    const replay = await new JudgmentService(dependencies).evaluate(input)
    expect(replay.stateIdentity).toBe(first.stateIdentity)
    expect(replay.answers).toEqual(first.answers)
    expect(calls).toBe(1)

    await new JudgmentService(dependencies).evaluate({
      ...input,
      contentIdentity: 'legacy-wire-content',
      world: world()
    })
    expect(sent[1]!.question.instructions).toBe(request.question.instructions)
  })

  it('falls back to the exact raw identity when normalized guidance exceeds request limits', async () => {
    const repeated = 'shared request-limit state value '.repeat(4)
    const current = world()
    current.contract = {
      ...current.contract,
      objectiveText: repeated,
      writeTerritory: [repeated, repeated]
    }
    const projected = computeJudgmentIdentity('fallback-content', current, ledger.read(watcherId))
    const raw = computeJudgmentIdentity('fallback-content', current, ledger.read(watcherId), {
      normalize: false
    })
    expect(projected.normalization).not.toBeNull()
    expect(raw.normalization).toBeNull()

    const requestFor = (length: number): JudgmentQuestionRequest => ({
      id: 'request-limit',
      questionId: OBJECTIVE_JUDGMENT_QUESTION_IDS.preflight,
      subjectId: 'implement',
      question: {
        type: 'choice',
        instructions: 'q'.repeat(length),
        criteria: { proceed: 'Proceed', hold: 'Hold' }
      }
    })
    let low = 1
    let high = JUDGMENT_MAX_REQUEST_BYTES
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const request = requestFor(middle)
      if (
        judgmentRequestFitsTransportLimits('typesafe', raw.state, {
          [request.id]: request.question
        })
      ) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    const request = requestFor(low)
    expect(
      judgmentRequestFitsTransportLimits('typesafe', raw.state, {
        [request.id]: request.question
      })
    ).toBe(true)
    expect(
      judgmentRequestFitsTransportLimits('typesafe', projected.state, {
        [request.id]: {
          ...request.question,
          instructions: `${JUDGMENT_STATE_NORMALIZATION_GUIDANCE}\n\n${request.question.instructions}`
        }
      })
    ).toBe(false)
    dependencies.store.recordOutcome(
      watcherId,
      {
        stateIdentity: projected.stateIdentity,
        contentIdentity: projected.contentIdentity,
        projectionDigest: projected.projectionDigest
      },
      'unavailable',
      'old normalized request did not fit'
    )

    let sentState: unknown
    let sentInstructions = ''
    dependencies.createClient = () => ({
      evaluate: async (state, questions) => {
        calls += 1
        sentState = state
        sentInstructions = questions[request.id]!.instructions
        return {
          model: 'jev-test-1',
          answers: {
            [request.id]: {
              type: 'choice',
              choice: 'proceed',
              probabilities: { proceed: 1, hold: 0 },
              confidence: 1
            }
          }
        }
      }
    })
    const input = {
      watcherId,
      contentIdentity: 'fallback-content',
      world: current,
      requests: [request],
      authority: 'local-desktop' as const
    }
    const first = await new JudgmentService(dependencies).evaluate(input)
    expect(first.status).toBe('answered')
    expect(first.stateIdentity).toBe(raw.stateIdentity)
    expect(sentState).toEqual(raw.state)
    expect(sentInstructions).toBe(request.question.instructions)
    expect(first.notices.some((notice) => notice.includes('normalization'))).toBe(false)

    dependencies.readAccess = () => ({
      enabled: true,
      provider: 'openrouter',
      apiKey: 'openrouter-secret'
    })
    const replay = await new JudgmentService(dependencies).evaluate(input)
    expect(replay.stateIdentity).toBe(raw.stateIdentity)
    expect(replay.answers).toEqual(first.answers)
    expect(calls).toBe(1)
  })

  it('fails closed before pending or provider calls when neither request representation fits', async () => {
    const repeated = 'shared oversized request state '.repeat(4)
    const current = world()
    current.contract = {
      ...current.contract,
      objectiveText: repeated,
      writeTerritory: [repeated, repeated]
    }
    const request: JudgmentQuestionRequest = {
      id: 'oversized-request',
      questionId: OBJECTIVE_JUDGMENT_QUESTION_IDS.preflight,
      subjectId: 'implement',
      question: {
        type: 'choice',
        instructions: 'q'.repeat(JUDGMENT_MAX_REQUEST_BYTES),
        criteria: { proceed: 'Proceed', hold: 'Hold' }
      }
    }
    dependencies.createClient = () => ({
      evaluate: async () => {
        calls += 1
        throw new Error('provider must not be called')
      }
    })
    const input = {
      watcherId,
      contentIdentity: 'oversized-request-content',
      world: current,
      requests: [request],
      authority: 'local-desktop' as const
    }
    const first = await new JudgmentService(dependencies).evaluate(input)
    expect(first.status).toBe('unavailable')
    expect(first.reason).toContain('request-size')
    expect(calls).toBe(0)

    const replay = await new JudgmentService(dependencies).evaluate(input)
    expect(replay.status).toBe('unavailable')
    expect(calls).toBe(0)
  })
})
