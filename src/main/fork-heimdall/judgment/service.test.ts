import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import type { JudgmentQuestionRequest } from '../../../shared/fork-heimdall/judgment/types'
import { HeimdallDatabase } from '../database'
import { HeimdallLedgerStore } from '../ledger-store'
import { JudgmentClientFailure, type JudgmentClientFailureDiagnostic } from './client'
import { computeJudgmentIdentity } from './identity'
import { world as buildWorld } from './judgment-test-world'
import { JudgmentService, type JudgmentServiceDependencies } from './service'
import {
  JUDGMENT_ANSWER_OBSERVATION,
  JUDGMENT_OUTCOME_OBSERVATION,
  JudgmentAnswerStore
} from './store'

const watcherId = 'judgment-watcher'
const requests: JudgmentQuestionRequest[] = [
  {
    id: 'failure:dispatch-1',
    questionId: 'failure',
    subjectId: 'dispatch-1',
    question: {
      type: 'choice',
      instructions: 'Classify the failure.',
      criteria: { infra: 'Infrastructure', criteria: 'Acceptance criteria' }
    }
  }
]

function world(): ObjectiveWorld {
  return buildWorld()
}

let root: string
let database: HeimdallDatabase
let ledger: HeimdallLedgerStore
let calls: number
let accessReads: number
let enabled: boolean
let model: string
let clientCreations: { apiKey: string; provider: 'typesafe' | 'openrouter' }[]
let dependencies: JudgmentServiceDependencies

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-judgment-service-'))
  database = new HeimdallDatabase(root)
  ledger = new HeimdallLedgerStore(database)
  calls = 0
  accessReads = 0
  enabled = true
  model = 'jev-test-1'
  clientCreations = []
  dependencies = {
    store: new JudgmentAnswerStore(ledger),
    databasePath: () => database.databasePath(),
    readAccess: () => {
      accessReads += 1
      return enabled ? { enabled: true, apiKey: 'secret' } : { enabled: false }
    },
    questionPolicy: () => ({
      mode: 'shadow',
      thresholdName: 'FAILURE_CONFIDENCE',
      calibratedModel: null
    }),
    createClient: (apiKey, options) => {
      clientCreations.push({ apiKey, provider: options.provider })
      return {
        evaluate: async () => {
          calls += 1
          return {
            model,
            answers: {
              'failure:dispatch-1': {
                type: 'choice',
                choice: 'infra',
                probabilities: { infra: 0.98, criteria: 0.02 },
                confidence: 0.95
              }
            }
          }
        }
      }
    }
  }
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('durable judgment evaluation', () => {
  it('records OpenRouter provenance and replays it after provider changes', async () => {
    dependencies.readAccess = () => {
      accessReads += 1
      return { enabled: true, provider: 'openrouter', apiKey: 'openrouter-secret' }
    }
    const input = {
      watcherId,
      contentIdentity: 'content-openrouter',
      world: world(),
      requests,
      authority: 'local-desktop' as const
    }
    const first = await new JudgmentService(dependencies).evaluate(input)
    expect(first.status).toBe('answered')
    expect(first.answers['failure:dispatch-1']?.provider).toBe('openrouter')
    expect(clientCreations).toEqual([{ apiKey: 'openrouter-secret', provider: 'openrouter' }])

    dependencies.readAccess = () => ({
      enabled: true,
      provider: 'typesafe',
      apiKey: 'typesafe-secret'
    })
    const replay = await new JudgmentService(dependencies).evaluate(input)
    expect(replay.answers).toEqual(first.answers)
    expect(replay.answers['failure:dispatch-1']?.provider).toBe('openrouter')
    expect(clientCreations).toHaveLength(1)
  })

  it('replays legacy records without transport provenance', async () => {
    const current = world()
    const computed = computeJudgmentIdentity('legacy-content', current, ledger.read(watcherId))
    const identity = {
      stateIdentity: computed.stateIdentity,
      contentIdentity: computed.contentIdentity,
      projectionDigest: computed.projectionDigest
    }
    ledger.append(
      {
        eventId: 'legacy-answer',
        watcherId,
        atMs: 1,
        origin: 'client',
        class: 'observation',
        kind: 'client-observation',
        what: JUDGMENT_ANSWER_OBSERVATION,
        detail: JSON.stringify({
          ...identity,
          requestId: 'failure:dispatch-1',
          questionId: 'failure',
          subjectId: 'dispatch-1',
          mode: 'shadow',
          thresholdName: 'FAILURE_CONFIDENCE',
          calibratedModel: null,
          model: 'jev-legacy',
          answer: {
            type: 'choice',
            choice: 'infra',
            probabilities: { infra: 0.98, criteria: 0.02 },
            confidence: 0.95
          }
        })
      },
      { resolved: false }
    )
    ledger.append(
      {
        eventId: 'legacy-outcome',
        watcherId,
        atMs: 2,
        origin: 'client',
        class: 'observation',
        kind: 'client-observation',
        what: JUDGMENT_OUTCOME_OBSERVATION,
        detail: JSON.stringify({ ...identity, status: 'answered' })
      },
      { resolved: false }
    )

    const replay = await new JudgmentService(dependencies).evaluate({
      watcherId,
      contentIdentity: 'legacy-content',
      world: current,
      requests,
      authority: 'local-desktop'
    })
    expect(replay.status).toBe('answered')
    expect(replay.answers['failure:dispatch-1']).toEqual({
      questionId: 'failure',
      subjectId: 'dispatch-1',
      mode: 'shadow',
      model: 'jev-legacy',
      answer: {
        type: 'choice',
        choice: 'infra',
        probabilities: { infra: 0.98, criteria: 0.02 },
        confidence: 0.95
      }
    })
    expect(clientCreations).toEqual([])
  })

  it('replays answers after reopening storage and after ordinary observation eviction', async () => {
    const input = {
      watcherId,
      contentIdentity: 'content-1',
      world: world(),
      requests,
      authority: 'local-desktop' as const
    }
    const first = await new JudgmentService(dependencies).evaluate(input)
    expect(first.status).toBe('answered')
    for (let index = 0; index < 80; index += 1) {
      ledger.append({
        eventId: `observation-${index}`,
        watcherId,
        atMs: index,
        origin: 'client',
        class: 'observation',
        kind: 'client-observation',
        what: 'ordinary-tick'
      })
    }
    database.close()
    database = new HeimdallDatabase(root)
    ledger = new HeimdallLedgerStore(database)
    dependencies.store = new JudgmentAnswerStore(ledger)
    const replay = await new JudgmentService(dependencies).evaluate(input)
    expect(replay.status).toBe('answered')
    expect(replay.answers).toEqual(first.answers)
    expect(replay.stateIdentity).toBe(first.stateIdentity)
    expect(calls).toBe(1)
    expect(replay.notices).toEqual([])
  })

  it('asks again when a worker report arrives without a workspace change', async () => {
    const service = new JudgmentService(dependencies)
    const input = {
      watcherId,
      contentIdentity: 'content-1',
      world: world(),
      requests,
      authority: 'local-desktop' as const
    }
    const before = await service.evaluate(input)
    ledger.append({
      eventId: 'report-arrived',
      watcherId,
      atMs: 100,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'orchestration-mailbox',
      payload: {
        type: 'worker_done',
        subject: 'Build unavailable',
        body: 'Infrastructure failed',
        payload: { dispatchId: 'dispatch-1', outcome: 'failed' }
      }
    })
    const after = await service.evaluate(input)
    expect(after.contentIdentity).toBe(before.contentIdentity)
    expect(after.stateIdentity).not.toBe(before.stateIdentity)
    expect(calls).toBe(2)
  })

  it('records remote absence without reading credentials even when desktop answers exist', async () => {
    const service = new JudgmentService(dependencies)
    const input = {
      watcherId,
      contentIdentity: 'content-1',
      world: world(),
      requests,
      authority: 'local-desktop' as const
    }
    await service.evaluate(input)
    const readsBefore = accessReads
    const remote = await service.evaluate({ ...input, authority: 'remote-execution-host' })
    expect(remote.status).toBe('remote')
    expect(remote.reason).toContain('remote')
    expect(accessReads).toBe(readsBefore)
    expect(calls).toBe(1)
  })

  it('allows explicit opt-in after disabled observation but does not reactivate authority when disabled', async () => {
    const service = new JudgmentService(dependencies)
    const input = {
      watcherId,
      contentIdentity: 'content-1',
      world: world(),
      requests,
      authority: 'local-desktop' as const
    }
    enabled = false
    expect((await service.evaluate(input)).status).toBe('disabled')
    expect(calls).toBe(0)
    enabled = true
    expect((await service.evaluate(input)).status).toBe('answered')
    enabled = false
    expect((await service.evaluate(input)).status).toBe('disabled')
    expect(calls).toBe(1)
  })

  it('records an unknown provider failure once without persisting arbitrary error text', async () => {
    const secret = 'secret provider error'
    dependencies.createClient = () => ({
      evaluate: async () => {
        calls += 1
        throw new Error(secret)
      }
    })
    const service = new JudgmentService(dependencies)
    const input = {
      watcherId,
      contentIdentity: 'content-1',
      world: world(),
      requests,
      authority: 'local-desktop' as const
    }
    const first = await service.evaluate(input)
    const replay = await service.evaluate(input)
    expect(first.status).toBe('unavailable')
    expect(first.reason).not.toContain(secret)
    expect(replay.reason).toBe(first.reason)
    expect(calls).toBe(1)
    expect(JSON.stringify(ledger.read(watcherId))).not.toContain(secret)
  })

  it('persists bounded failure causes without exposing provider text', async () => {
    const unsafeText = 'private-key provider-body'
    const cases: {
      diagnostic: JudgmentClientFailureDiagnostic
      reasonCode: string
    }[] = [
      { diagnostic: { code: 'network-error' }, reasonCode: 'network-error' },
      { diagnostic: { code: 'timeout' }, reasonCode: 'timeout' },
      {
        diagnostic: { code: 'http-status', status: 503 },
        reasonCode: 'http-status:503'
      },
      {
        diagnostic: { code: 'retry-exhausted', status: 429, attempts: 3 },
        reasonCode: 'retry-exhausted:429'
      },
      {
        diagnostic: { code: 'state-size' },
        reasonCode: 'state-size'
      },
      {
        diagnostic: { code: 'request-size' },
        reasonCode: 'request-size'
      },
      {
        diagnostic: { code: 'response-size' },
        reasonCode: 'response-size'
      },
      {
        diagnostic: { code: 'malformed-response' },
        reasonCode: 'malformed-response'
      },
      {
        diagnostic: { code: 'malformed-response', reason: 'invalid-json' },
        reasonCode: 'malformed-response:invalid-json'
      },
      {
        diagnostic: { code: 'malformed-response', reason: 'invalid-utf8' },
        reasonCode: 'malformed-response:invalid-utf8'
      },
      {
        diagnostic: { code: 'malformed-response', reason: 'invalid-envelope' },
        reasonCode: 'malformed-response:invalid-envelope'
      },
      {
        diagnostic: { code: 'malformed-response', reason: 'unexpected-answer' },
        reasonCode: 'malformed-response:unexpected-answer'
      }
    ]

    for (const [index, testCase] of cases.entries()) {
      dependencies.createClient = () => ({
        evaluate: async () => {
          calls += 1
          throw new JudgmentClientFailure(unsafeText, testCase.diagnostic)
        }
      })
      const input = {
        watcherId,
        contentIdentity: `failure-${index}`,
        world: world(),
        requests,
        authority: 'local-desktop' as const
      }
      const callsBefore = calls
      const first = await new JudgmentService(dependencies).evaluate(input)
      const replay = await new JudgmentService(dependencies).evaluate(input)
      expect(first.status).toBe('unavailable')
      expect(first.reason).toContain(testCase.reasonCode)
      expect(replay.reason).toBe(first.reason)
      expect(calls).toBe(callsBefore + 1)
    }
    const persisted = JSON.stringify(ledger.read(watcherId))
    expect(persisted).not.toContain('private-key')
    expect(persisted).not.toContain('provider-body')
  })

  it('retains valid answers from partial results and replays terminal unavailability', async () => {
    const partialRequests = [
      ...requests,
      { ...requests[0]!, id: 'failure:dispatch-2', subjectId: 'dispatch-2' }
    ]
    dependencies.createClient = () => ({
      evaluate: async () => {
        calls += 1
        return {
          model,
          answers: {
            'failure:dispatch-1': {
              type: 'choice',
              choice: 'infra',
              probabilities: { infra: 0.98, criteria: 0.02 },
              confidence: 0.95
            }
          },
          unavailable: { 'failure:dispatch-2': 'missing-confidence' }
        }
      }
    })
    const input = {
      watcherId,
      contentIdentity: 'partial-response',
      world: world(),
      requests: partialRequests,
      authority: 'local-desktop' as const
    }

    const first = await new JudgmentService(dependencies).evaluate(input)
    expect(first.status).toBe('unavailable')
    expect(first.answers['failure:dispatch-1']?.answer).toEqual({
      type: 'choice',
      choice: 'infra',
      probabilities: { infra: 0.98, criteria: 0.02 },
      confidence: 0.95
    })
    expect(first.answers['failure:dispatch-2']).toBeUndefined()
    expect(first.reason).toContain('valid=1/2')
    expect(first.reason).toContain('missing-confidence=1')
    expect(first.notices.some((notice) => notice.includes('observed'))).toBe(true)
    for (const notice of first.notices) {
      expect(first.reason).not.toContain(notice)
    }

    const replay = await new JudgmentService(dependencies).evaluate(input)
    expect(replay.status).toBe('unavailable')
    expect(replay.answers).toEqual(first.answers)
    expect(replay.reason).toBe(first.reason)
    expect(calls).toBe(1)
  })

  it('records bounded field-failure counts when every item is unavailable', async () => {
    const reasons = [
      'missing-answer',
      'answer-shape',
      'answer-type',
      'missing-confidence',
      'missing-probabilities',
      'score-weight-mismatch',
      'score-legend',
      'score-range',
      'probability-keys',
      'probability-distribution',
      'choice-invalid',
      'choice-not-max'
    ] as const
    const fieldRequests = reasons.map((_, index) => ({
      ...requests[0]!,
      id: `failure:field-${index}`,
      subjectId: `dispatch-${index}`
    }))
    dependencies.createClient = () => ({
      evaluate: async () => {
        calls += 1
        return {
          model,
          answers: {},
          unavailable: reasons.reduce<Record<string, (typeof reasons)[number]>>(
            (result, reason, index) => {
              result[fieldRequests[index]!.id] = reason
              return result
            },
            {}
          )
        }
      }
    })
    const result = await new JudgmentService(dependencies).evaluate({
      watcherId,
      contentIdentity: 'all-fields-unavailable',
      world: world(),
      requests: fieldRequests,
      authority: 'local-desktop'
    })

    expect(result.status).toBe('unavailable')
    expect(Object.keys(result.answers)).toEqual([])
    expect(result.reason).toContain(`valid=0/${reasons.length}`)
    for (const reason of reasons) {
      expect(result.reason).toContain(`${reason}=1`)
    }
    for (const request of fieldRequests) {
      expect(result.reason).not.toContain(request.id)
    }
    expect(calls).toBe(1)
  })

  it('rejects a malicious client-port map without salvaging answers or storing its ID', async () => {
    const maliciousId = 'private-answer-id'
    dependencies.createClient = () => ({
      evaluate: async () => {
        calls += 1
        return {
          model,
          answers: {
            'failure:dispatch-1': {
              type: 'choice',
              choice: 'infra',
              probabilities: { infra: 0.98, criteria: 0.02 },
              confidence: 0.95
            },
            [maliciousId]: {
              type: 'choice',
              choice: 'infra',
              probabilities: { infra: 0.98, criteria: 0.02 },
              confidence: 0.95
            }
          }
        }
      }
    })
    const result = await new JudgmentService(dependencies).evaluate({
      watcherId,
      contentIdentity: 'malicious-client-map',
      world: world(),
      requests,
      authority: 'local-desktop'
    })

    expect(result.status).toBe('unavailable')
    expect(result.answers).toEqual({})
    expect(result.reason).toContain('malformed-response:unexpected-answer')
    expect(result.reason).not.toContain(maliciousId)
    const persisted = JSON.stringify(ledger.read(watcherId))
    expect(persisted).not.toContain(maliciousId)
    expect(calls).toBe(1)
  })

  it('retains a durable subset if recording a later valid answer fails', async () => {
    const partialRequests = [
      ...requests,
      { ...requests[0]!, id: 'failure:dispatch-2', subjectId: 'dispatch-2' }
    ]
    const originalRecordAnswer = dependencies.store.recordAnswer.bind(dependencies.store)
    let answerWrites = 0
    dependencies.store.recordAnswer = (...args) => {
      answerWrites += 1
      if (answerWrites === 2) {
        throw new Error('private recorder detail')
      }
      originalRecordAnswer(...args)
    }
    dependencies.createClient = () => ({
      evaluate: async () => {
        calls += 1
        const answer = {
          type: 'choice' as const,
          choice: 'infra',
          probabilities: { infra: 0.98, criteria: 0.02 },
          confidence: 0.95
        }
        return {
          model,
          answers: {
            'failure:dispatch-1': answer,
            'failure:dispatch-2': answer
          }
        }
      }
    })
    const input = {
      watcherId,
      contentIdentity: 'partial-recorder',
      world: world(),
      requests: partialRequests,
      authority: 'local-desktop' as const
    }
    const first = await new JudgmentService(dependencies).evaluate(input)
    expect(first.status).toBe('unavailable')
    expect(Object.keys(first.answers)).toEqual(['failure:dispatch-1'])
    expect(first.reason).toContain('evaluation failed')
    expect(JSON.stringify(ledger.read(watcherId))).not.toContain('private recorder detail')

    const replay = await new JudgmentService(dependencies).evaluate(input)
    expect(replay.status).toBe('unavailable')
    expect(replay.answers).toEqual(first.answers)
    expect(replay.reason).toBe(first.reason)
    expect(calls).toBe(1)
  })

  it('classifies a malformed result returned through the client port', async () => {
    dependencies.createClient = () => ({
      evaluate: async () => {
        calls += 1
        return { model: 'jev-test', answers: {} }
      }
    })
    const result = await new JudgmentService(dependencies).evaluate({
      watcherId,
      contentIdentity: 'malformed-client-result',
      world: world(),
      requests,
      authority: 'local-desktop'
    })
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('malformed-response')
    expect(calls).toBe(1)
  })

  it('does not repeat an invocation interrupted after its durable pending marker', async () => {
    const current = world()
    const computed = computeJudgmentIdentity('content-1', current, ledger.read(watcherId))
    dependencies.store.recordPending(
      watcherId,
      {
        stateIdentity: computed.stateIdentity,
        contentIdentity: computed.contentIdentity,
        projectionDigest: computed.projectionDigest
      },
      requests.map((request) => request.id)
    )
    const result = await new JudgmentService(dependencies).evaluate({
      watcherId,
      contentIdentity: 'content-1',
      world: current,
      requests,
      authority: 'local-desktop'
    })
    expect(result.status).toBe('pending')
    expect(calls).toBe(0)
  })

  it('records oversized state as unavailable instead of sending a truncated projection', async () => {
    dependencies.maxStateBytes = 16
    const result = await new JudgmentService(dependencies).evaluate({
      watcherId,
      contentIdentity: 'content-1',
      world: world(),
      requests,
      authority: 'local-desktop'
    })
    expect(result.status).toBe('unavailable')
    expect(result.reason).toContain('state-size')
    expect(calls).toBe(0)
  })

  it('never grants authority to stale answers when the active request set shrinks', async () => {
    const extra = { ...requests[0]!, id: 'failure:dispatch-2', subjectId: 'dispatch-2' }
    dependencies.createClient = () => ({
      evaluate: async () => {
        calls += 1
        const answer = {
          type: 'choice' as const,
          choice: 'infra',
          probabilities: { infra: 0.98, criteria: 0.02 },
          confidence: 0.95
        }
        return { model, answers: { 'failure:dispatch-1': answer, 'failure:dispatch-2': answer } }
      }
    })
    const service = new JudgmentService(dependencies)
    const input = {
      watcherId,
      contentIdentity: 'content-1',
      world: world(),
      requests: [...requests, extra],
      authority: 'local-desktop' as const
    }
    expect((await service.evaluate(input)).status).toBe('answered')
    const reduced = await service.evaluate({ ...input, requests })
    expect(reduced.status).toBe('unavailable')
    expect(calls).toBe(1)
  })

  it('announces each newly returned model once without changing recorded answers', async () => {
    const service = new JudgmentService(dependencies)
    const input = {
      watcherId,
      contentIdentity: 'content-1',
      world: world(),
      requests,
      authority: 'local-desktop' as const
    }
    const first = await service.evaluate(input)
    expect(first.notices.some((notice) => notice.includes('jev-test-1'))).toBe(true)
    model = 'jev-test-2'
    const second = await service.evaluate({ ...input, contentIdentity: 'content-2' })
    expect(second.notices.some((notice) => notice.includes('jev-test-2'))).toBe(true)
    const third = await service.evaluate({ ...input, contentIdentity: 'content-3' })
    expect(third.notices).toEqual([])
    expect((await service.evaluate(input)).answers).toEqual(first.answers)
    expect(calls).toBe(3)
  })
})
