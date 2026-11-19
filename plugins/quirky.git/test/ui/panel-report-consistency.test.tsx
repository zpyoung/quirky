import { afterAll, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { GitCompare, ReviewModel } from '@quirky/protocol'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act, compareOf, entry, fakeContext, layoutFor, mountPanel, reviewOf, settle, settleAfter, statusOf } = await import('./panel-support')
afterAll(() => GlobalRegistrator.unregister())

test('reports wait for review and compare reads belonging to the current status snapshot', async () => {
  jest.useFakeTimers()
  const fake = fakeContext(layoutFor('feat'))
  const initial = statusOf([], { head: 'a'.repeat(40), ahead: 0 })
  fake.status = initial
  fake.compare = compareOf({ headOid: initial.head })
  const staleReview = Promise.withResolvers<ReviewModel>()
  const freshReview = Promise.withResolvers<ReviewModel>()
  const freshCompare = Promise.withResolvers<GitCompare>()
  let reviewReads = 0
  let holdReviews = false
  fake.on('quirky.git/review', () => {
    if (!holdReviews) return reviewOf(initial, fake.compare)
    return ++reviewReads === 1 ? staleReview.promise : freshReview.promise
  })
  const mounted = mountPanel(fake)
  try {
    await settle()
    expect(fake.reports.at(-1)?.ahead).toBe(0)
    holdReviews = true
    const next = statusOf([
      entry('math.ts'), entry('README.md', 'staged'), entry('new.ts', 'staged'), entry('notes.txt', 'untracked')
    ], { head: 'b'.repeat(40), ahead: 1 })
    const changed = ['math.ts', 'README.md', 'new.ts', 'notes.txt', 'util.ts'].map(path => ({
      path, status: 'modified' as const, added: 1, removed: 0, binary: false
    }))
    const compared = compareOf({ headOid: next.head, entries: changed, ahead: 1, added: 5 })
    const incorrectlyCommitted = reviewOf(statusOf([], { head: next.head }), compared)
    const latest = reviewOf(next, compared)
    fake.status = next
    fake.on('quirky.git/compare', () => freshCompare.promise)
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    await settleAfter(3_000)
    await act(async () => staleReview.resolve(incorrectlyCommitted))
    await settle()
    expect(fake.reports.filter(report => report.ahead === 1)).toEqual([])
    await act(async () => freshReview.resolve(latest))
    await settle()
    expect(fake.reports.filter(report => report.ahead === 1)).toEqual([])
    await act(async () => freshCompare.resolve(compared))
    await settle()
    expect(fake.reports.at(-1)).toMatchObject({
      ahead: 1, base: 'origin/main', sections: [
        { id: 'unstaged', count: 1 }, { id: 'staged', count: 2 },
        { id: 'untracked', count: 1 }, { id: 'branch', count: 1 }
      ]
    })
  } finally {
    await act(async () => {
      staleReview.resolve(reviewOf(initial, compareOf()))
      freshReview.resolve(reviewOf(fake.status, compareOf()))
      freshCompare.resolve(compareOf())
    })
    mounted.unmount()
    jest.useRealTimers()
  }
})
