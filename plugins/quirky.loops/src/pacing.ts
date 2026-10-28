import type { PacingInput, PacingSchedule } from './types'

const millisecondsPerMinute = 60_000

export function computePacing(input: PacingInput): PacingSchedule {
  const { pacing, iterationEndedAt } = input
  if (pacing.kind === 'on-idle' || iterationEndedAt === null) {
    return { nextIterationAt: null, skippedTicks: 0 }
  }

  const intervalMs = pacing.minutes * millisecondsPerMinute
  if (pacing.anchor === 'from-end') {
    return { nextIterationAt: iterationEndedAt + intervalMs, skippedTicks: 0 }
  }

  const endTickIndex = Math.floor((iterationEndedAt - input.createdAt) / intervalMs)
  const nextTickIndex = Math.max(1, endTickIndex + 1)
  let skippedTicks = 0

  if (input.iterationStartedAt !== null) {
    const startTickIndex = Math.floor((input.iterationStartedAt - input.createdAt) / intervalMs)
    skippedTicks = Math.max(0, Math.max(0, endTickIndex) - Math.max(0, startTickIndex))
  }

  return {
    nextIterationAt: input.createdAt + nextTickIndex * intervalMs,
    skippedTicks
  }
}
