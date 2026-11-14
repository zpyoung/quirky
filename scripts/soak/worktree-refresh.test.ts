import { expect, test } from 'bun:test'
import type { ProbeRecord } from './contracts'
import { summarizeWorktreeRefreshes } from './worktree-refresh'

const PREFIX = 'notification-worktree-refresh '
const RUN_STARTED_AT = '2026-11-14T00:00:00.000Z'

function diagnostic(
  event: 'slow' | 'finished',
  overrides: Partial<{
    v: number
    id: string
    startedAt: string
    at: string
    elapsedMs: number
    loopLagMs: number
    outcome: 'ok' | 'error' | 'timeout'
  }> = {},
): string {
  const common = {
    v: 1,
    id: 'activation-1:1',
    event,
    startedAt: '2026-11-14T00:00:01.000Z',
    at: event === 'slow' ? '2026-11-14T00:00:03.000Z' : '2026-11-14T00:00:03.500Z',
    elapsedMs: event === 'slow' ? 2000 : 2500,
    loopLagMs: event === 'slow' ? 7 : 12,
    ...(event === 'finished' ? { outcome: 'ok' as const } : {}),
    ...overrides,
  }
  return `${PREFIX}${JSON.stringify(common)}`
}

function probes(...records: Partial<ProbeRecord>[]): ProbeRecord[] {
  return records.map((record) => ({ at: 0, ms: 0, ownLagMs: 0, timedOut: false, ...record }))
}

test('correlates slow completion with run phase and the largest overlapping probe lag', () => {
  const summary = summarizeWorktreeRefreshes(
    [diagnostic('slow'), diagnostic('finished')].join('\n'),
    RUN_STARTED_AT,
    probes(
      { at: 1.5, ms: 500, ownLagMs: 8 },
      { at: 2, ms: 1000, ownLagMs: 19 },
      { at: 3.5, ms: 100, ownLagMs: 40 },
    ),
  )

  expect(summary).toEqual({
    slow: 1,
    completed: 1,
    failed: 0,
    pending: 0,
    invalid: 0,
    examples: [{
      id: 'activation-1:1',
      startedAt: '2026-11-14T00:00:01.000Z',
      phase: 'run',
      elapsedMs: 2500,
      loopLagMs: 12,
      maxProbeOwnLagMs: 19,
      outcome: 'ok',
    }],
  })
})

test('classifies pre-run refreshes as setup and missing run timestamps as unknown', () => {
  const setup = diagnostic('slow', {
    id: 'setup',
    startedAt: '2026-11-13T23:59:58.000Z',
    at: '2026-11-14T00:00:00.000Z',
    elapsedMs: 2000,
  })
  const withoutRunStart = summarizeWorktreeRefreshes(setup, undefined, [])
  const withRunStart = summarizeWorktreeRefreshes(setup, RUN_STARTED_AT, [])

  expect(withoutRunStart.examples[0]?.phase).toBe('unknown')
  expect(withRunStart.examples[0]?.phase).toBe('setup')
})

test('counts unfinished slow reads as pending and preserves fast failures', () => {
  const pending = diagnostic('slow', { id: 'pending' })
  const fastError = diagnostic('finished', {
    id: 'fast-error',
    elapsedMs: 40,
    loopLagMs: 0,
    outcome: 'error',
  })
  const summary = summarizeWorktreeRefreshes(`${pending}\n${fastError}`, RUN_STARTED_AT, [])

  expect(summary).toMatchObject({ slow: 1, completed: 0, failed: 1, pending: 1, invalid: 0 })
  expect(summary.examples.map(({ id, outcome }) => [id, outcome])).toEqual([
    ['pending', 'pending'],
    ['fast-error', 'error'],
  ])
})

test('counts timeout finishes as failed while retaining slow completion accounting', () => {
  const slow = diagnostic('slow', { id: 'timed-out' })
  const timeout = diagnostic('finished', {
    id: 'timed-out',
    at: '2026-11-14T00:00:31.000Z',
    elapsedMs: 30_000,
    loopLagMs: 15,
    outcome: 'timeout',
  })
  const summary = summarizeWorktreeRefreshes(`${slow}\n${timeout}`, RUN_STARTED_AT, [])

  expect(summary).toMatchObject({ slow: 1, completed: 0, failed: 1, pending: 0, invalid: 0 })
  expect(summary.examples[0]).toMatchObject({ outcome: 'timeout', elapsedMs: 30_000 })
})

test('identical duplicate records are idempotent', () => {
  const slow = diagnostic('slow')
  const finished = diagnostic('finished')
  const summary = summarizeWorktreeRefreshes(`${slow}\n${slow}\n${finished}\n${finished}`, RUN_STARTED_AT, [])

  expect(summary).toMatchObject({ slow: 1, completed: 1, failed: 0, pending: 0, invalid: 0 })
})

test('counts a contradictory terminal record once even when that record is repeated', () => {
  const slow = diagnostic('slow', { id: 'conflicting-terminal' })
  const successful = diagnostic('finished', { id: 'conflicting-terminal' })
  const failed = diagnostic('finished', { id: 'conflicting-terminal', outcome: 'error' })
  const summary = summarizeWorktreeRefreshes(
    [slow, successful, failed, failed].join('\n'),
    RUN_STARTED_AT,
    [],
  )

  expect(summary.invalid).toBe(1)
})

test('malformed, unsupported, invalid, and contradictory diagnostics are invalid', () => {
  const unsupported = diagnostic('slow', { id: 'unsupported', v: 2 })
  const invalidValue = diagnostic('slow', { id: 'invalid', elapsedMs: -1 })
  const terminalOk = diagnostic('finished', { id: 'conflict', outcome: 'ok' })
  const terminalError = diagnostic('finished', { id: 'conflict', outcome: 'error' })
  const summary = summarizeWorktreeRefreshes(
    [
      `${PREFIX}{not-json`,
      unsupported,
      invalidValue,
      terminalOk,
      terminalError,
    ].join('\n'),
    RUN_STARTED_AT,
    [],
  )

  expect(summary.invalid).toBeGreaterThanOrEqual(4)
})

test('keeps exact counts while retaining ten duration-descending examples with ID tie breaks', () => {
  const records: string[] = []
  for (let index = 0; index < 12; index++) {
    const id = index < 2
      ? `tie-${index === 0 ? 'b' : 'a'}`
      : index < 10
        ? `read-${index}`
        : `zz-low-${index}`
    const elapsedMs = index < 2 ? 2000 : index < 10 ? 3000 - index * 10 : 2000
    records.push(diagnostic('slow', { id, elapsedMs }))
  }
  const summary = summarizeWorktreeRefreshes(records.join('\n'), RUN_STARTED_AT, [])

  expect(summary.slow).toBe(12)
  expect(summary.pending).toBe(12)
  expect(summary.examples).toHaveLength(10)
  expect(summary.examples.slice(0, 2).map(({ id }) => id)).toEqual(['read-2', 'read-3'])
  expect(summary.examples.slice(-2).map(({ id }) => id)).toEqual(['tie-a', 'tie-b'])
})

test('ignores legacy logs and reports no probe lag without an overlapping probe', () => {
  expect(summarizeWorktreeRefreshes('quirky.worktree/list did not answer within 2000ms', RUN_STARTED_AT, [])).toEqual({
    slow: 0,
    completed: 0,
    failed: 0,
    pending: 0,
    invalid: 0,
    examples: [],
  })
  const summary = summarizeWorktreeRefreshes(
    diagnostic('slow'),
    RUN_STARTED_AT,
    probes({ at: 20, ms: 100, ownLagMs: 99 }),
  )
  expect(summary.examples[0]?.maxProbeOwnLagMs).toBeNull()
})
test('rejects forbidden slow outcomes, changed identities, and terminal data preceding slow', () => {
  const slowWithOutcome = diagnostic('slow', { id: 'outcome', outcome: 'ok' })
  const slow = diagnostic('slow', { id: 'ordering', elapsedMs: 2300 })
  const earlierFinish = diagnostic('finished', {
    id: 'ordering',
    at: '2026-11-14T00:00:02.500Z',
    elapsedMs: 2200,
  })
  const changedStart = diagnostic('finished', {
    id: 'identity',
    startedAt: '2026-11-14T00:00:02.000Z',
  })
  const identitySlow = diagnostic('slow', { id: 'identity' })
  const slowOne = diagnostic('slow', { id: 'repeated', loopLagMs: 1 })
  const slowTwo = diagnostic('slow', { id: 'repeated', loopLagMs: 2 })
  const summary = summarizeWorktreeRefreshes(
    [slowWithOutcome, slow, earlierFinish, identitySlow, changedStart, slowOne, slowTwo].join('\n'),
    RUN_STARTED_AT,
    [],
  )

  expect(summary.invalid).toBeGreaterThanOrEqual(4)
})
