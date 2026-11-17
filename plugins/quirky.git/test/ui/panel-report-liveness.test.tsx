import { afterAll, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, q, rowOf, settle, settleAfter, statusOf, type } = await import('./panel-support')
afterAll(() => GlobalRegistrator.unregister())

test('the report keeps updating after an action that outlives a status change', async () => {
  jest.useFakeTimers()
  const fake = fakeContext(layoutFor('feat'))
  const pendingCommit = Promise.withResolvers<{ sha: string }>()
  fake.status = statusOf([entry('math.ts', 'staged')], { head: 'a'.repeat(40), ahead: 0 })
  fake.on('quirky.git/commit', () => pendingCommit.promise)
  const mounted = mountPanel(fake)
  try {
    await settle()
    const message = q(mounted.element, 'textarea') as HTMLTextAreaElement
    await type(message, 'msg')
    await click(q(mounted.element, '.ui-split-button__primary'))
    expect(fake.called('quirky.git/commit')).toHaveLength(1)
    fake.status = statusOf([], { head: 'b'.repeat(40), ahead: 1 })
    fake.compare = compareOf({ headOid: 'b'.repeat(40), ahead: 1 })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    await settleAfter(3_000)
    await act(async () => pendingCommit.resolve({ sha: 'b'.repeat(40) }))
    await settle()
    await settleAfter(3_000)
    fake.status = statusOf([entry('new.ts', 'untracked')], { head: 'b'.repeat(40), ahead: 1 })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    await settleAfter(3_000)
    await settleAfter(3_000)
    expect(mounted.element.textContent).toContain('new.ts')
    expect(fake.reports.at(-1)).toMatchObject({ busy: null, sections: [{ id: 'untracked', count: 1 }] })
  } finally {
    await act(async () => pendingCommit.resolve({ sha: 'b'.repeat(40) }))
    mounted.unmount()
    jest.useRealTimers()
  }
})

test('a persistent compare failure does not withhold the report', async () => {
  jest.useFakeTimers()
  const fake = fakeContext(layoutFor('feat'))
  const initial = statusOf([], { head: 'a'.repeat(40), ahead: 0 })
  fake.status = initial
  fake.compare = compareOf({ headOid: initial.head })
  const mounted = mountPanel(fake)
  try {
    await settle()
    fake.on('quirky.git/compare', () => { throw failure('compare broke') })
    fake.status = statusOf([entry('new.ts', 'untracked')], { head: 'b'.repeat(40), ahead: 1 })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    await settleAfter(3_000)
    await settleAfter(3_000)
    expect(mounted.element.textContent).toContain('compare broke')
    expect(rowOf(mounted.element, 'new.ts')).not.toBeNull()
    expect(fake.reports.at(-1)).toMatchObject({ ahead: 1, sections: [{ id: 'untracked', count: 1 }] })
  } finally {
    mounted.unmount()
    jest.useRealTimers()
  }
})

test('a persistent review failure does not withhold the report', async () => {
  jest.useFakeTimers()
  const fake = fakeContext(layoutFor('feat'))
  const initial = statusOf([], { head: 'a'.repeat(40), ahead: 0 })
  fake.status = initial
  fake.compare = compareOf({ headOid: initial.head })
  const mounted = mountPanel(fake)
  try {
    await settle()
    fake.on('quirky.git/review', () => { throw failure('review broke') })
    fake.status = statusOf([entry('new.ts', 'untracked')], { head: initial.head })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    await settleAfter(3_000)
    await settleAfter(3_000)
    expect(mounted.element.textContent).toContain('review broke')
    expect(fake.reports.at(-1)).toMatchObject({ sections: [{ id: 'untracked', count: 1 }] })
  } finally {
    mounted.unmount()
    jest.useRealTimers()
  }
})

test('an initial persistent status failure does not withhold the report', async () => {
  jest.useFakeTimers()
  const fake = fakeContext(layoutFor('feat'))
  fake.on('quirky.git/status', () => { throw failure('status broke') })
  const mounted = mountPanel(fake)
  try {
    await settle()
    await settleAfter(3_000)
    expect(mounted.element.textContent).toContain('status broke')
    expect(fake.reports.at(-1)).toMatchObject({ worktree: 'feat', branch: null, base: null, ahead: 0, sections: [] })
  } finally {
    mounted.unmount()
    jest.useRealTimers()
  }
})
