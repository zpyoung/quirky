import { describe, expect, test } from 'bun:test'
import type { WorkerActivity } from '../src/owner/contracts'
import { looksLikeProseQuestion, scanWorkers } from '../src/owner/detection'

const NOW = 1_000_000

function activity(overrides: Partial<WorkerActivity> = {}): WorkerActivity {
  return {
    dispatchId: 'dispatch-1',
    contact: 'live',
    observedAtMs: NOW,
    waitingAtPrompt: true,
    idleSinceMs: NOW,
    lastProgressAtMs: NOW,
    ...overrides
  }
}

describe('scanWorkers', () => {
  test('keeps prompt idle within grace and schedules the grace boundary', () => {
    const result = scanWorkers([
      activity({ idleSinceMs: NOW - 119_999 })
    ], true, NOW)

    expect(result.deviations).toEqual([])
    expect(result.observations).toEqual([])
    expect(result.questions).toEqual([])
    expect(result.nextCheckAtMs).toBe(NOW + 1)
  })

  test('caps prompt-grace rechecks at fifteen seconds', () => {
    const result = scanWorkers([activity({ idleSinceMs: NOW - 1 })], true, NOW)

    expect(result.nextCheckAtMs).toBe(NOW + 15_000)
  })

  test('reports owner idle stall exactly at the grace boundary', () => {
    const worker = activity({ idleSinceMs: NOW - 120_000 })
    const result = scanWorkers([worker], true, NOW)

    expect(result.deviations).toHaveLength(1)
    expect(result.deviations[0]).toMatchObject({
      kind: 'stall',
      dispatchId: 'dispatch-1',
      trigger: 'idle'
    })
    expect(result.deviations[0]?.naturalKey).toContain('dispatch-1')
    expect(result.deviations[0]?.naturalKey).toContain(String(worker.idleSinceMs))
  })

  test('resets idle grace when the verified prompt idle time advances', () => {
    const firstIdleSince = NOW - 120_000
    const first = scanWorkers([activity({ idleSinceMs: firstIdleSince })], true, NOW)
    const restartedIdleSince = NOW - 119_999
    const restarted = scanWorkers([activity({ idleSinceMs: restartedIdleSince })], true, NOW)
    const reachedAgain = scanWorkers([activity({ idleSinceMs: restartedIdleSince })], true, NOW + 1)

    expect(first.deviations).toHaveLength(1)
    expect(restarted.deviations).toEqual([])
    expect(restarted.nextCheckAtMs).toBe(NOW + 1)
    expect(reachedAgain.deviations[0]?.naturalKey).not.toBe(first.deviations[0]?.naturalKey)
  })

  test('reports owner silence at 900000ms since mailbox progress', () => {
    const result = scanWorkers([
      activity({ waitingAtPrompt: false, lastProgressAtMs: NOW - 900_000 })
    ], true, NOW)

    expect(result.deviations).toHaveLength(1)
    expect(result.deviations[0]).toMatchObject({
      kind: 'stall',
      dispatchId: 'dispatch-1',
      trigger: 'silent'
    })
    expect(result.deviations[0].naturalKey).toContain(String(NOW - 900_000))
  })

  test('does not report owner silence at 899999ms and schedules the boundary', () => {
    const result = scanWorkers([
      activity({ waitingAtPrompt: false, lastProgressAtMs: NOW - 899_999 })
    ], true, NOW)

    expect(result.deviations).toEqual([])
    expect(result.nextCheckAtMs).toBe(NOW + 1)
  })

  test('resets silent grace on mailbox progress and gives the new evidence a new key', () => {
    const oldProgress = NOW - 900_000
    const atOldBoundary = scanWorkers([
      activity({ waitingAtPrompt: false, lastProgressAtMs: oldProgress })
    ], true, NOW)
    const newProgress = NOW - 899_999
    const beforeNewBoundary = scanWorkers([
      activity({ waitingAtPrompt: false, lastProgressAtMs: newProgress })
    ], true, NOW)
    const atNewBoundary = scanWorkers([
      activity({ waitingAtPrompt: false, lastProgressAtMs: newProgress })
    ], true, NOW + 1)

    expect(atOldBoundary.deviations[0]?.naturalKey).toContain(String(oldProgress))
    expect(beforeNewBoundary.deviations).toEqual([])
    expect(atNewBoundary.deviations[0]?.naturalKey).toContain(String(newProgress))
    expect(atNewBoundary.deviations[0]?.naturalKey).not.toBe(atOldBoundary.deviations[0]?.naturalKey)
  })

  test('uses mailbox progress rather than output text as evidence of silence', () => {
    const result = scanWorkers([
      activity({
        waitingAtPrompt: false,
        lastProgressAtMs: NOW - 900_000,
        lastMessage: 'I produced a new-looking output line.'
      })
    ], true, NOW)

    expect(result.deviations[0]?.trigger).toBe('silent')
  })

  test('unowned prompt idle creates a prose-question fallback with dispatch identity', () => {
    const idleSinceMs = NOW - 120_000
    const body = 'The check completed.\n\nWhich deployment should I use?'
    const result = scanWorkers([
      activity({ idleSinceMs, lastMessage: body })
    ], false, NOW)

    expect(result.deviations).toEqual([])
    expect(result.observations).toEqual([])
    expect(result.questions).toEqual([{
      key: expect.any(String),
      dispatchId: 'dispatch-1',
      messageId: `prose-question:${idleSinceMs}`,
      body
    }])
    expect(result.questions[0]?.key).toContain('dispatch-1')
    expect(result.questions[0]?.key).toContain(String(idleSinceMs))
  })

  test('unowned prompt idle without a prose question records a stable idle observation', () => {
    const idleSinceMs = NOW - 120_000
    const worker = activity({ idleSinceMs, lastMessage: 'Résumé saved — naïve façade.' })
    const result = scanWorkers([worker], false, NOW)

    expect(result.questions).toEqual([])
    expect(result.observations).toEqual([{
      key: expect.any(String),
      dispatchId: worker.dispatchId,
      idleSinceMs,
      detail: expect.any(String)
    }])
  })

  test('does not let stale, future-dated, unverifiable, exited, missing or changed contacts prove idle or silence', () => {
    const staleProgress = NOW - 900_000
    const invalidActivities: WorkerActivity[] = [
      activity({ observedAtMs: NOW - 15_001, idleSinceMs: NOW - 120_000, lastProgressAtMs: staleProgress }),
      activity({ observedAtMs: NOW + 1, idleSinceMs: NOW - 120_000, lastProgressAtMs: staleProgress }),
      activity({ contact: 'unverifiable', idleSinceMs: NOW - 120_000, lastProgressAtMs: staleProgress }),
      activity({ contact: 'exited', idleSinceMs: NOW - 120_000, lastProgressAtMs: staleProgress }),
      activity({ contact: 'missing', idleSinceMs: NOW - 120_000, lastProgressAtMs: staleProgress }),
      activity({ contact: 'identity-changed', idleSinceMs: NOW - 120_000, lastProgressAtMs: staleProgress })
    ]

    for (const worker of invalidActivities) {
      const result = scanWorkers([worker], true, NOW)
      expect(result.deviations).toEqual([])
      expect(result.observations).toEqual([])
      expect(result.questions).toEqual([])
    }
  })

  test('treats an observation exactly 15 seconds old as current', () => {
    const result = scanWorkers([
      activity({ observedAtMs: NOW - 15_000, idleSinceMs: NOW - 120_000 })
    ], true, NOW)

    expect(result.deviations[0]?.trigger).toBe('idle')
  })

  test('does not create no-owner silent observations', () => {
    const result = scanWorkers([
      activity({ waitingAtPrompt: false, lastProgressAtMs: NOW - 900_000 })
    ], false, NOW)

    expect(result.deviations).toEqual([])
    expect(result.observations).toEqual([])
    expect(result.questions).toEqual([])
    expect(result.nextCheckAtMs).toBeNull()
  })

  test('returns deterministic keys and results for identical evidence', () => {
    const workers = [
      activity({ dispatchId: 'worker-b', idleSinceMs: NOW - 120_000 }),
      activity({ dispatchId: 'worker-a', idleSinceMs: NOW - 120_000 })
    ]

    expect(scanWorkers(workers, true, NOW)).toEqual(scanWorkers(workers, true, NOW))
    expect(scanWorkers(workers, true, NOW).deviations.map(({ dispatchId }) => dispatchId))
      .toEqual(['worker-a', 'worker-b'])
  })
})

describe('looksLikeProseQuestion', () => {
  test('requires a question mark and an interrogative or choice cue', () => {
    expect(looksLikeProseQuestion('Should I keep the existing branch?')).toBe(true)
    expect(looksLikeProseQuestion('Choose the cache or database?')).toBe(true)
    expect(looksLikeProseQuestion('Task completed?')).toBe(false)
    expect(looksLikeProseQuestion('Should I keep the existing branch.')).toBe(false)
  })

  test('checks only the final paragraph', () => {
    expect(looksLikeProseQuestion('Which option should I use?\n\nThe report is complete.')).toBe(false)
    expect(looksLikeProseQuestion('The report is complete.\n\nWhich option should I use?')).toBe(true)
    expect(looksLikeProseQuestion('Which option should I use?\n')).toBe(true)
  })

  test('ignores fenced code and obvious log-only final paragraphs', () => {
    expect(looksLikeProseQuestion('Example:\n\n```text\nWhich option should I use?\n```')).toBe(false)
    expect(looksLikeProseQuestion('2026-10-27T12:00:00Z INFO Which option should I use?')).toBe(false)
  })

  test('accepts ordinary UTF-8 prose without inventing a question', () => {
    expect(looksLikeProseQuestion('Résumé saved — naïve façade; 東京で確認済み。')).toBe(false)
  })
})
