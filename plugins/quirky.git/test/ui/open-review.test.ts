import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode } from '@quirky/protocol'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { fakeContext, layoutFor, failure } = await import('./panel-support')
const { openReview, registerReviewView, reviewViewFor } = await import('../../src/review/open')
const { setReviewMark } = await import('../../src/review/useReview')
const { onSelectedPath, selectPath, selectedPath } = await import('../../src/review/selection')

afterAll(() => GlobalRegistrator.unregister())

const unregisters: Array<() => void> = []
afterEach(() => {
  for (const off of unregisters.splice(0)) off()
})

function handleFor(worktree: string) {
  const reveals: Array<[string, string | undefined]> = []
  const scopes: Array<string | null> = []
  const tops = { count: 0 }
  const handle = {
    worktree,
    reveal: (path: string, noteId?: string) => void reveals.push([path, noteId]),
    scrollToTop: () => void tops.count++,
    setScope: (commit: string | null) => void scopes.push(commit)
  }
  unregisters.push(registerReviewView(handle))
  return { handle, reveals, scopes, tops }
}

describe('openReview without a mounted view', () => {
  test('opens one Review tab per worktree through the hosted-tab API', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat', reveal: 'src/a.ts' })
    const opens = fake.called('quirky.terminal/openViewTab')
    expect(opens).toHaveLength(1)
    expect(opens[0]!.params).toMatchObject({ key: 'git-diff:["feat","review"]', title: 'Review' })
    expect(opens[0]!.params.input).toMatchObject({ worktree: 'feat', mode: 'review', reveal: 'src/a.ts' })
  })

  test('a commit scope and a reveal share the tab key', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    await openReview(fake.context, { worktree: 'feat', commit: 'f5429a1', reveal: 'x.ts' })
    const keys = new Set(fake.called('quirky.terminal/openViewTab').map((c) => c.params.key))
    expect([...keys]).toEqual(['git-diff:["feat","review"]'])
  })
})

describe('openReview with a mounted view', () => {
  test('activates its tab and reveals the path without opening another', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    const tab = (await fake.context.call('quirky.terminal/workspace', { workspace: 'id:feat' })) as {
      workspace: { root: { tabs: Array<{ id: string }> } }
    }
    fake.on('quirky.terminal/activateTab', () => ({ workspace: tab.workspace }))
    const { handle, reveals, scopes, tops } = handleFor('feat')
    expect(reviewViewFor('feat')).toBe(handle)
    const opensBefore = fake.called('quirky.terminal/openViewTab').length

    await openReview(fake.context, { worktree: 'feat', reveal: 'src/a.ts', noteId: 'n1' })

    expect(fake.called('quirky.terminal/activateTab')).toHaveLength(1)
    expect(fake.called('quirky.terminal/activateTab')[0]!.params).toMatchObject({ tab: tab.workspace.root.tabs[0]!.id })
    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(opensBefore)
    expect(reveals).toEqual([['src/a.ts', 'n1']])
    expect(scopes).toEqual([null])
    expect(tops.count).toBe(0)
  })

  test('without a path it scrolls to the top and reveals nothing', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    fake.on('quirky.terminal/activateTab', () => ({}))
    const { reveals, scopes, tops } = handleFor('feat')

    await openReview(fake.context, { worktree: 'feat' })

    expect(tops.count).toBe(1)
    expect(reveals).toEqual([])
    expect(scopes).toEqual([null])
  })

  test('sets the scope when a commit is given', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    fake.on('quirky.terminal/activateTab', () => ({}))
    const { reveals, scopes, tops } = handleFor('feat')

    await openReview(fake.context, { worktree: 'feat', commit: 'f5429a1' })

    expect(scopes).toEqual(['f5429a1'])
    expect(reveals).toEqual([])
    expect(tops.count).toBe(1)
  })

  test('a handle for another worktree is ignored', async () => {
    const fake = fakeContext(layoutFor('feat'))
    const { reveals } = handleFor('other')
    await openReview(fake.context, { worktree: 'feat', reveal: 'a.ts' })
    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(1)
    expect(reveals).toEqual([])
  })

  test('unregistering removes the handle', () => {
    const { handle } = handleFor('feat')
    unregisters.pop()!()
    expect(reviewViewFor('feat')).not.toBe(handle)
    expect(reviewViewFor('feat')).toBeNull()
  })
})

describe('selection store', () => {
  test('notifies listeners with the origin and stops after unsubscribe', () => {
    const seen: Array<[string | null, string]> = []
    const off = onSelectedPath('wt-sel', (path, origin) => void seen.push([path, origin]))
    expect(selectedPath('wt-sel')).toBeNull()

    selectPath('wt-sel', 'a.ts', 'panel')
    selectPath('wt-sel', 'b.ts', 'review')
    expect(selectedPath('wt-sel')).toBe('b.ts')
    off()
    selectPath('wt-sel', null, 'panel')

    expect(seen).toEqual([['a.ts', 'panel'], ['b.ts', 'review']])
    expect(selectedPath('wt-sel')).toBeNull()
  })

  test('is per worktree', () => {
    const seen: string[] = []
    const off = onSelectedPath('wt-one', (path) => void seen.push(path ?? ''))
    selectPath('wt-two', 'x.ts', 'panel')
    off()
    expect(seen).toEqual([])
    expect(selectedPath('wt-one')).toBeNull()
  })
})

describe('setReviewMark', () => {
  test('returns ok on success and passes the expected hash', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/setReviewMark', () => ({ mark: 'reviewed' }))
    await expect(setReviewMark(fake.context, { worktree: 'feat', path: 'a.ts', reviewed: true, expected: 'h1' })).resolves.toBe('ok')
    expect(fake.called('quirky.git/setReviewMark')[0]!.params).toEqual({ worktree: 'feat', path: 'a.ts', reviewed: true, expected: 'h1' })
  })

  test('maps a changed-on-disk conflict to conflict', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/setReviewMark', () => {
      throw Object.assign(failure('changed since you looked', { reason: 'changed-on-disk' }), { code: RpcErrorCode.Conflict })
    })
    await expect(setReviewMark(fake.context, { worktree: 'feat', path: 'a.ts', reviewed: true, expected: 'h1' })).resolves.toBe('conflict')
  })

  test('rethrows a conflict for any other reason', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/setReviewMark', () => {
      throw Object.assign(failure('busy', { reason: 'busy' }), { code: RpcErrorCode.Conflict })
    })
    await expect(setReviewMark(fake.context, { worktree: 'feat', path: 'a.ts', reviewed: true })).rejects.toThrow('busy')
  })

  test('rethrows any other error', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/setReviewMark', () => {
      throw Object.assign(failure('nope'), { code: RpcErrorCode.NotFound })
    })
    await expect(setReviewMark(fake.context, { worktree: 'feat', path: 'a.ts', reviewed: false })).rejects.toThrow('nope')
  })
})
