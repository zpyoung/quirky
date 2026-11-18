import { afterAll, beforeEach, describe, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { GitCompare, ReviewModel } from '@quirky/protocol'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, buttonText, click, compareOf, entry, fakeContext, layoutFor, mountPanel, press, q, qa, reviewOf, rowOf, settle, settleAfter, statusOf } = s

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

type Fake = ReturnType<typeof fakeContext>

async function open(configure: (fake: Fake) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'))
  configure(fake)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

const conflict = (path: string, kind: 'both_modified' | 'deleted_by_them' = 'both_modified', state: 'unresolved' | 'resolved_locally' = 'unresolved') =>
  entry(path, 'conflicts', 'modified', { conflict: { kind, state } })

async function rightClick(element: HTMLElement, path: string) {
  await act(async () => {
    rowOf(element, path)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
  })
  await settle()
}

const stageItem = () =>
  qa(document.body, '[role="menu"] [role="menuitem"]').find((item) => item.textContent?.trim().startsWith('Stage')) as HTMLButtonElement | undefined

/** Whether Stage is offered for the row's context menu. */
async function stageEnabled(element: HTMLElement, path: string): Promise<boolean> {
  await rightClick(element, path)
  const enabled = stageItem()?.disabled === false
  await press(q(document.body, '[role="menu"]')!, 'Escape')
  return enabled
}

test('live conflict rows and operation actions stay coherent while review and compare are pending', async () => {
  jest.useFakeTimers()
  const fake = fakeContext(layoutFor('feat'))
  const initial = statusOf([entry('existing.ts')], { head: 'a'.repeat(40) })
  fake.noteCounts['existing.ts'] = 2
  fake.status = initial
  fake.compare = compareOf({ headOid: initial.head })
  const currentReview = Promise.withResolvers<ReviewModel>()
  const resolvedReview = Promise.withResolvers<ReviewModel>()
  const currentCompare = Promise.withResolvers<GitCompare>()
  const mounted = mountPanel(fake)
  try {
    await settle()
    fake.on('quirky.git/review', () => currentReview.promise)
    fake.on('quirky.git/compare', () => currentCompare.promise)
    fake.status = statusOf([conflict('a.ts'), conflict('existing.ts')], { head: 'b'.repeat(40), operation: 'merge' })
    const compared = compareOf({ headOid: fake.status.head })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    await settleAfter(3_000)
    expect(buttonText(mounted.element, 'Review conflicts')).toBeDefined()
    expect(rowOf(mounted.element, 'a.ts')).not.toBeNull()
    expect(q(rowOf(mounted.element, 'a.ts')!, '[aria-label="Unresolved conflict (Both modified)"]')).not.toBeNull()
    expect(q(rowOf(mounted.element, 'existing.ts')!, '[aria-label="Unresolved conflict (Both modified)"]')).not.toBeNull()
    expect(q(rowOf(mounted.element, 'existing.ts')!, '[aria-label="2 notes"]')).not.toBeNull()
    expect(buttonText(mounted.element, 'Abort merge')).toBeDefined()
    expect(fake.reports.at(-1)?.operation).toBe('none')
    await click(rowOf(mounted.element, 'a.ts'))
    expect(fake.views.at(-1)?.input).toEqual({ worktree: 'feat', mode: 'conflict-file', path: 'a.ts' })

    await act(async () => currentReview.resolve(reviewOf(fake.status, compared)))
    await settle()
    expect(fake.reports.at(-1)?.operation).toBe('none')
    await act(async () => currentCompare.resolve(compared))
    await settle()
    expect(fake.reports.at(-1)).toMatchObject({ operation: 'merge', sections: [{ id: 'conflicts', count: 2 }] })

    fake.on('quirky.git/review', () => resolvedReview.promise)
    fake.status = statusOf([conflict('a.ts', 'both_modified', 'resolved_locally'), entry('existing.ts', 'staged')], {
      head: 'b'.repeat(40), operation: 'merge'
    })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    await settleAfter(3_000)
    expect(buttonText(mounted.element, 'Continue merge')).toBeDefined()
    expect(buttonText(mounted.element, 'Abort merge')).toBeDefined()
    expect(q(rowOf(mounted.element, 'a.ts')!, '[aria-label^="Resolved locally conflict"]')).not.toBeNull()
    expect(q(rowOf(mounted.element, 'existing.ts')!, '[aria-label^="Unresolved conflict"]')).toBeNull()
  } finally {
    await act(async () => {
      currentReview.resolve(reviewOf(fake.status, fake.compare))
      resolvedReview.resolve(reviewOf(fake.status, fake.compare))
      currentCompare.resolve(fake.compare)
    })
    mounted.unmount()
    jest.useRealTimers()
  }
})

describe('SC-41: conflicts lead to Continue', () => {
  test('the ship bar is replaced by the conflict card with Review conflicts and Abort merge', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([conflict('math.ts')], { operation: 'merge' })
    })
    expect(q(element, '[data-git-ship] [role="status"] .ui-inline-agent-card h3')?.textContent).toBe('Merge conflicts: 1 unresolved')
    expect(element.textContent).toContain('Resolved files move back to normal changes after they leave the live conflict state.')
    expect(q(element, 'textarea')).toBeNull()
    expect(q(element, '[data-git-ship-bar]')).toBeNull()
    expect(q(element, '.ui-split-button')).toBeNull()
    expect(buttonText(element, 'Continue merge')).toBeUndefined()
    expect(buttonText(element, 'Abort merge')).toBeDefined()
    await click(buttonText(element, 'Review conflicts'))
    expect(fake.views.at(-1)?.input).toEqual({ worktree: 'feat', mode: 'conflicts' })
    unmount()
  })

  test('the conflicted rows sit in the list with an Unresolved badge and no count chip', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([conflict('math.ts'), conflict('b.ts', 'deleted_by_them')], { operation: 'merge' })
    })
    expect(q(rowOf(element, 'math.ts')!, '[aria-label="Unresolved conflict (Both modified)"]')?.textContent).toContain('⚠')
    expect(q(rowOf(element, 'b.ts')!, '[aria-label="Unresolved conflict (Deleted by them)"]')).not.toBeNull()
    expect(rowOf(element, 'math.ts')?.getAttribute('title')).toContain('Both modified')
    expect(element.textContent).not.toContain('conflict(s)')
    expect(q(element, '[data-section="conflicts"]')).toBeNull()
    unmount()
  })

  test('an unresolved conflict can be staged only once its markers are gone', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([conflict('a.ts'), conflict('b.ts')], { operation: 'merge' })
      f.on('quirky.git/conflictFile', (params) => ({
        path: params.path,
        content: params.path === 'a.ts' ? 'x\n<<<<<<< ours\none\n=======\ntwo\n>>>>>>> theirs\n' : 'resolved\n'
      }))
    })
    expect(await stageEnabled(element, 'a.ts')).toBe(false)
    expect(await stageEnabled(element, 'b.ts')).toBe(true)
    await rightClick(element, 'b.ts')
    await click(stageItem())
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['b.ts'] })
    unmount()
  })

  test('conflicts beyond the first 50 are checked too, at most 8 reads at a time', async () => {
    let inFlight = 0
    let widest = 0
    const paths = Array.from({ length: 60 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.ts`)
    const { element, unmount } = await open((f) => {
      f.status = statusOf(paths.map((path) => conflict(path)), { operation: 'merge' })
      f.on('quirky.git/conflictFile', async (params) => {
        inFlight++
        widest = Math.max(widest, inFlight)
        await Promise.resolve()
        inFlight--
        return { path: params.path, content: params.path === 'f55.ts' ? 'resolved\n' : '<<<<<<< ours\none\n=======\ntwo\n>>>>>>> theirs\n' }
      })
    })
    expect(await stageEnabled(element, 'f55.ts')).toBe(true)
    expect(await stageEnabled(element, 'f54.ts')).toBe(false)
    expect(widest).toBeLessThanOrEqual(8)
    unmount()
  })

  test('a conflict whose file is gone counts as marker-free; one whose read fails stays blocked', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([conflict('gone.ts'), conflict('deleted-gone.ts', 'deleted_by_them'), conflict('broken.ts')], { operation: 'merge' })
      f.on('quirky.git/conflictFile', (params) => {
        if (params.path === 'broken.ts') throw new Error('boom')
        return { path: params.path, content: null }
      })
    })
    expect(await stageEnabled(element, 'gone.ts')).toBe(true)
    expect(await stageEnabled(element, 'deleted-gone.ts')).toBe(false)
    expect(await stageEnabled(element, 'broken.ts')).toBe(false)
    unmount()
  })

  test('markers are re-checked on each status read, so saving the file enables Stage', async () => {
    jest.useFakeTimers()
    let unmount: (() => void) | undefined
    try {
      let content = '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n'
      const opened = await open((f) => {
        f.status = statusOf([conflict('a.ts')], { operation: 'merge' })
        f.on('quirky.git/conflictFile', (params) => ({ path: params.path, content }))
      })
      unmount = opened.unmount
      const { fake, element } = opened
      expect(await stageEnabled(element, 'a.ts')).toBe(false)
      content = 'fixed\n'
      await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
      await settle()
      await settleAfter(3_000)
      expect(await stageEnabled(element, 'a.ts')).toBe(true)
    } finally {
      unmount?.()
      jest.useRealTimers()
    }
  })

  test('a resolved-locally row shows its check badge and offers no Stage; the banner then offers Continue merge', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([conflict('math.ts', 'both_modified', 'resolved_locally')], { operation: 'merge' })
    })
    expect(q(rowOf(element, 'math.ts')!, '[aria-label^="Resolved locally conflict"]')?.textContent).toContain('✓')
    expect(q(element, '[data-git-ship] [role="status"] .ui-inline-agent-card h3')?.textContent).toBe('Merge in progress')
    await click(buttonText(element, 'Continue merge'))
    expect(fake.called('quirky.git/continue')).toHaveLength(1)
    unmount()
  })

  test('once the operation ends the ship bar is back and offers Push', async () => {
    jest.useFakeTimers()
    let unmount: (() => void) | undefined
    try {
      const opened = await open((f) => {
        f.status = statusOf([], { operation: 'merge' })
      })
      unmount = opened.unmount
      const { fake, element } = opened
      fake.status = statusOf([], { ahead: 2, upstreamStatus: { hasUpstream: true, name: 'origin/zoe/feat', sha: 'b'.repeat(40), ahead: 2, behind: 0, behindPatchEquivalent: null } })
      await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
      await settle()
      await settleAfter(3_000)
      expect(q(element, '.ui-split-button__primary')?.textContent).toBe('Push 2 commits')
      expect(q(element, '[role="status"] .ui-inline-agent-card')).toBeNull()
    } finally {
      unmount?.()
      jest.useRealTimers()
    }
  })

  test('a conflict card with no ship bar behind it keeps the compare quiet', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([conflict('a.ts')], { operation: 'merge' })
      f.compare = compareOf({ entries: [] })
    })
    expect(q(element, '[data-git-clean]')).toBeNull()
    unmount()
  })
})

describe('SC-46: a cherry-pick has no Abort', () => {
  test('shows "Cherry-pick in progress" with Continue cherry-pick only, and no commit box', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'staged')], { operation: 'cherry-pick' })
    })
    expect(q(element, '[role="status"] .ui-inline-agent-card h3')?.textContent).toBe('Cherry-pick in progress')
    expect(buttonText(element, 'Continue cherry-pick')).toBeDefined()
    expect(buttonText(element, 'Abort cherry-pick')).toBeUndefined()
    expect(qa(element, '[role="status"] .ui-inline-agent-card button').map((b) => b.textContent)).toEqual(['Continue cherry-pick'])
    expect(q(element, 'textarea')).toBeNull()
    unmount()
  })

  test('cherry-pick conflicts show the card with Review conflicts and no Abort', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([conflict('a.ts')], { operation: 'cherry-pick' })
    })
    expect(q(element, '[role="status"] .ui-inline-agent-card h3')?.textContent).toBe('Cherry-pick conflicts: 1 unresolved')
    expect(qa(element, '[role="status"] .ui-inline-agent-card button').map((b) => b.textContent)).toEqual(['Review conflicts'])
    unmount()
  })
})

test('a failed initial review leaves status conflict rows and Abort available', async () => {
  jest.useFakeTimers()
  const fake = fakeContext(layoutFor('feat'))
  fake.status = statusOf([conflict('a.ts')], { operation: 'merge' })
  fake.on('quirky.git/review', () => { throw new Error('review broke') })
  const mounted = mountPanel(fake)
  try {
    await settle()
    expect(mounted.element.textContent).toContain('review broke')
    expect(buttonText(mounted.element, 'Review conflicts')).toBeDefined()
    expect(buttonText(mounted.element, 'Abort merge')).toBeDefined()
    expect(rowOf(mounted.element, 'a.ts')).not.toBeNull()
    await click(rowOf(mounted.element, 'a.ts'))
    expect(fake.views.at(-1)?.input).toEqual({ worktree: 'feat', mode: 'conflict-file', path: 'a.ts' })
    expect(fake.reports.at(-1)).toMatchObject({ operation: 'merge', sections: [{ id: 'conflicts', count: 1 }] })
  } finally {
    mounted.unmount()
    jest.useRealTimers()
  }
})
