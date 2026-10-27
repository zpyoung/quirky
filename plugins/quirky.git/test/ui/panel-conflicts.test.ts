import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, entry, fakeContext, layoutFor, mountPanel, q, qa, rowOf, settle, statusOf } = s

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

describe('SC-41: conflicts lead to Continue', () => {
  test('the commit box is replaced by the conflict card with Review conflicts and Abort merge', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([conflict('math.ts')], { operation: 'merge' })
    })
    expect(q(element, '.scm-card-conflict strong')?.textContent).toBe('Merge conflicts: 1 unresolved')
    expect(element.textContent).toContain('Resolved files move back to normal changes after they leave the live conflict state.')
    expect(q(element, 'textarea')).toBeNull()
    expect(q(element, '.scm-split')).toBeNull()
    expect(buttonText(element, 'Continue merge')).toBeUndefined()
    await click(buttonText(element, 'Review conflicts'))
    expect(fake.views.at(-1)?.input).toEqual({ worktree: 'feat', mode: 'conflicts' })
    unmount()
  })

  test('the conflicts section shows the kind, an Unresolved badge and "N conflict(s)"', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([conflict('math.ts'), conflict('b.ts', 'deleted_by_them')], { operation: 'merge' })
    })
    const row = rowOf(element, 'math.ts')!
    expect(q(row, '.scm-row-sub')?.textContent).toBe('Both modified')
    expect(q(row, '.scm-badge')?.textContent).toBe('Unresolved')
    expect(q(row, '.scm-badge')?.getAttribute('aria-label')).toBe('Unresolved conflict (Both modified)')
    expect(q(rowOf(element, 'b.ts')!, '.scm-row-sub')?.textContent).toBe('Deleted by them')
    expect(q(element, '[data-section="conflicts"] .scm-section-note')?.textContent).toBe('2 conflict(s)')
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
    expect(byLabel(element, 'Stage a.ts')).toBeNull()
    expect(byLabel(element, 'Stage b.ts')).not.toBeNull()
    await click(byLabel(element, 'Stage b.ts'))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['b.ts'] })
    unmount()
  })

  test('a conflict whose file is gone counts as marker-free; one whose read fails stays blocked', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([conflict('gone.ts', 'deleted_by_them'), conflict('broken.ts')], { operation: 'merge' })
      f.on('quirky.git/conflictFile', (params) => {
        if (params.path === 'broken.ts') throw new Error('boom')
        return { path: params.path, content: null }
      })
    })
    expect(byLabel(element, 'Stage gone.ts')).not.toBeNull()
    expect(byLabel(element, 'Stage broken.ts')).toBeNull()
    unmount()
  })

  test('markers are re-checked on each status read, so saving the file enables Stage', async () => {
    let content = '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n'
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([conflict('a.ts')], { operation: 'merge' })
      f.on('quirky.git/conflictFile', (params) => ({ path: params.path, content }))
    })
    expect(byLabel(element, 'Stage a.ts')).toBeNull()
    content = 'fixed\n'
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(byLabel(element, 'Stage a.ts')).not.toBeNull()
    unmount()
  })

  test('a resolved-locally row shows its check badge and offers nothing; the banner then offers Continue merge', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([conflict('math.ts', 'both_modified', 'resolved_locally'), entry('math.ts', 'staged')], { operation: 'merge' })
    })
    const row = rowOf(element, 'math.ts', 'conflicts')!
    expect(q(row, '.scm-badge')?.textContent).toBe('Resolved locally')
    expect(q(row, '.scm-badge')?.className).toContain('scm-badge-resolved')
    expect(qa(row.parentElement!, '.scm-row-actions button')).toHaveLength(0)
    expect(q(element, '.scm-card strong')?.textContent).toBe('Merge in progress')
    await click(buttonText(element, 'Continue merge'))
    expect(fake.called('quirky.git/continue')).toHaveLength(1)
    unmount()
  })

  test('once the operation ends the commit area is back and offers Push', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([], { operation: 'merge' })
    })
    fake.status = statusOf([], { ahead: 2, upstreamStatus: { hasUpstream: true, name: 'origin/zoe/feat', sha: 'b'.repeat(40), ahead: 2, behind: 0, behindPatchEquivalent: null } })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(q(element, '.scm-primary')?.textContent).toBe('Push')
    expect(q(element, '.scm-card')).toBeNull()
    unmount()
  })
})

describe('SC-46: a cherry-pick has no Abort', () => {
  test('shows "Cherry-pick in progress" with Continue cherry-pick only, and no commit box', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'staged')], { operation: 'cherry-pick' })
    })
    expect(q(element, '.scm-card strong')?.textContent).toBe('Cherry-pick in progress')
    expect(buttonText(element, 'Continue cherry-pick')).toBeDefined()
    expect(buttonText(element, 'Abort cherry-pick')).toBeUndefined()
    expect(qa(element, '.scm-card button').map((b) => b.textContent)).toEqual(['Continue cherry-pick'])
    expect(q(element, 'textarea')).toBeNull()
    unmount()
  })

  test('cherry-pick conflicts show the card with Review conflicts and no Abort', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([conflict('a.ts')], { operation: 'cherry-pick' })
    })
    expect(q(element, '.scm-card-conflict strong')?.textContent).toBe('Cherry-pick conflicts: 1 unresolved')
    expect(qa(element, '.scm-card button').map((b) => b.textContent)).toEqual(['Review conflicts'])
    unmount()
  })
})
