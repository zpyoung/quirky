import { expect, test } from 'bun:test'
import { INITIAL_DELAY_MS, nextDelay } from '../src/lib/backoff'

test('doubles from 0.5s up to 5s', () => {
  const seen = [INITIAL_DELAY_MS]
  for (let i = 0; i < 6; i++) seen.push(nextDelay(seen[seen.length - 1]!))
  expect(seen).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000])
})
