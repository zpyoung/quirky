import { expect, test } from 'bun:test'
import { pacingDelay } from '../src/pacing'

test('a stopped pacing policy is not rearmed by accumulated gate or error backoff', () => {
  expect(pacingDelay({
    tier:'stopped',nowMs:10_000,lastLiveReadAtMs:0,consecutiveErrors:3,consecutiveGateHolds:2
  })).toBeNull()
})
