import { expect, test } from 'bun:test'
import type { PacingInput } from '../src/types'
import { computePacing } from '../src/pacing'

const minute = 60_000

function pacingInput(overrides: Partial<PacingInput> = {}): PacingInput {
  return {
    pacing: { kind: 'interval', minutes: 1, anchor: 'wall-clock' },
    createdAt: 0,
    iterationStartedAt: 0,
    iterationEndedAt: 150_000,
    ...overrides
  }
}

test('does not schedule a deadline before the first iteration ends', () => {
  expect(computePacing(pacingInput({ iterationStartedAt: null, iterationEndedAt: null }))).toEqual({
    nextIterationAt: null,
    skippedTicks: 0
  })
})

test('on-idle pacing leaves the next iteration immediately eligible', () => {
  expect(computePacing(pacingInput({ pacing: { kind: 'on-idle' } }))).toEqual({
    nextIterationAt: null,
    skippedTicks: 0
  })
})

test('from-end pacing adds the interval to the iteration end', () => {
  expect(
    computePacing(
      pacingInput({
        pacing: { kind: 'interval', minutes: 3, anchor: 'from-end' },
        createdAt: 12_345,
        iterationStartedAt: 200_000,
        iterationEndedAt: 450_000
      })
    )
  ).toEqual({ nextIterationAt: 630_000, skippedTicks: 0 })
})

test('wall-clock pacing chooses the next epoch tick and counts ticks during an iteration', () => {
  expect(
    computePacing(
      pacingInput({ iterationStartedAt: 0, iterationEndedAt: 150_000 })
    )
  ).toEqual({ nextIterationAt: 180_000, skippedTicks: 2 })
})

test('wall-clock pacing excludes the start boundary and includes the end boundary', () => {
  expect(
    computePacing(
      pacingInput({ iterationStartedAt: 60_000, iterationEndedAt: 120_000 })
    )
  ).toEqual({ nextIterationAt: 180_000, skippedTicks: 1 })
})

test('wall-clock pacing counts no ticks when the interval starts between ticks', () => {
  expect(
    computePacing(
      pacingInput({ iterationStartedAt: 150_000, iterationEndedAt: 170_000 })
    )
  ).toEqual({ nextIterationAt: 180_000, skippedTicks: 0 })
})

test('wall-clock pacing uses creation time as a nonzero epoch', () => {
  const createdAt = 12_500
  expect(
    computePacing(
      pacingInput({
        createdAt,
        iterationStartedAt: createdAt,
        iterationEndedAt: createdAt + 150_000
      })
    )
  ).toEqual({ nextIterationAt: createdAt + 180_000, skippedTicks: 2 })
})

test('wall-clock pacing counts long intervals with bounded arithmetic', () => {
  const ticksDuringIteration = 5_000_000
  const createdAt = 13
  const iterationEndedAt = createdAt + ticksDuringIteration * minute
  expect(
    computePacing(
      pacingInput({
        createdAt,
        iterationStartedAt: createdAt,
        iterationEndedAt
      })
    )
  ).toEqual({ nextIterationAt: iterationEndedAt + minute, skippedTicks: ticksDuringIteration })
})

test('wall-clock pacing reports no skipped ticks when the iteration start is unavailable', () => {
  expect(
    computePacing(
      pacingInput({ iterationStartedAt: null, iterationEndedAt: 170_000 })
    )
  ).toEqual({ nextIterationAt: 180_000, skippedTicks: 0 })
})

test('computing a schedule does not mutate its input', () => {
  const source = pacingInput({ createdAt: 12_500, iterationStartedAt: 12_500, iterationEndedAt: 162_500 })
  const before = structuredClone(source)
  Object.freeze(source.pacing)
  Object.freeze(source)

  expect(computePacing(source)).toEqual({ nextIterationAt: 192_500, skippedTicks: 2 })
  expect(source).toEqual(before)
})
