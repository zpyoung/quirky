import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'
import { conversationFixture } from './review-conversation-fixture'
let h: HostingTest | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

test('stack membership keeps stack number separate from PR identities and refuses a mismatched stack', async () => {
  h = await bootHosting(conversationFixture)
  const stack = { number: 42, position: 1, size: 2, base: { ref: 'main', sha: 'b'.repeat(40) } }
  const entry = (number: number, position: number) => ({ position, pullRequest: { number, title: `PR ${number}`, url: `https://github.com/test-owner/test-repo/pull/${number}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: { state: 'SUCCESS' }, headRefName: `feature-${number}`, headRefOid: 'a'.repeat(40) } })
  const graph = { data: { repository: { pullRequest: { stack: { number: 42, size: 2, baseRefName: 'main', entries: { nodes: [entry(8, 2), entry(7, 1)] } } } } } }
  h.writeState({ stack, stackGraph: graph })
  const read = await h.call('reviewStack', { number: 7 })
  expect(read).toMatchObject({ number: 7, available: true, truncated: false, stack: { number: 42, entries: [{ number: 7, position: 1 }, { number: 8, position: 2 }] } })
  h.writeState({ stack, stackGraph: { data: { repository: { pullRequest: { stack: { ...graph.data.repository.pullRequest.stack, number: 99 } } } } } })
  const mismatch = await h.call('reviewStack', { number: 7, noCache: true })
  expect(mismatch).toMatchObject({ number: 7, available: false, reason: 'stack_mismatch', stack: { number: 42, entries: [] } })
  h.writeState({ stack: null })
  expect(await h.call('reviewStack', { number: 7, noCache: true })).toMatchObject({ available: true, stack: null, truncated: false })
}, 20_000)
