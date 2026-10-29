import { expect, test } from 'bun:test'
import { assertMobileCallAllowed } from '../src/daemon/authorization'

test('mobile tabCounts rejects extra parameters and unknown method names', () => {
  for (const params of [{ worktree: 'wt-1' }, { session: 'session-1' }, { token: 'secret' }]) {
    expect(() => assertMobileCallAllowed('quirky.terminal/tabCounts', params)).toThrow()
  }
  expect(() => assertMobileCallAllowed('quirky.terminal/tabCounts/extra', {})).toThrow()
})
