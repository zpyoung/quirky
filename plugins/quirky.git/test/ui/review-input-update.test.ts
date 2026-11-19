import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { MountCleanup } from '@quirky/protocol'
import type { Fake } from './panel-support'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// React/UI test helpers must load after happy-dom has registered its globals.
const p = await import('./panel-support')
const s = await import('./support')
const { mountDiffView } = await import('../../src/view/DiffWindow')
const { openHostedDiff, claimReviewTab, releaseReviewTab } = await import('../../src/view/hosted-tabs')
const { diffViewKey } = await import('../../src/shared/view-input')
afterAll(() => GlobalRegistrator.unregister())

const APP = 'src/app.ts'
const NOTE = {
  id: 'n1', worktreeId: 'w1', path: APP, startLine: 1, line: 1, body: 'Check this', createdAt: 1, updatedAt: null
}

let fake: Fake
let observerCleanups: Array<() => void>
const mounts: Array<{ cleanup: MountCleanup; element: HTMLElement; unmount(): Promise<void> }> = []

function mount(input: unknown) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup!: MountCleanup
  s.act(() => {
    const result = mountDiffView(fake.context)(element, { input })
    if (typeof result !== 'function') throw new Error('diff view did not return cleanup')
    cleanup = result
  })
  let done = false
  const mounted = {
    element,
    cleanup,
    async unmount() {
      if (done) return
      done = true
      await s.act(async () => cleanup())
      element.remove()
    }
  }
  mounts.push(mounted)
  return mounted
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake = p.fakeContext(p.layoutFor('w1'))
  fake.status = p.statusOf([p.entry(APP)])
  fake.on('quirky.git/review', () => s.reviewModel([s.reviewFile(APP)]))
  fake.on('quirky.git/notes', () => ({ notes: [NOTE] }))
  fake.on('quirky.terminal/activateTab', () => ({}))
  const intersection = s.stubIntersectionObserver()
  const resize = s.stubResizeObserver()
  observerCleanups = [() => intersection.restore(), () => resize.restore()]
})

afterEach(async () => {
  for (const mounted of mounts.splice(0)) await mounted.unmount()
  await s.settle()
  for (const restore of observerCleanups) restore()
})

test('a note input updates the existing Review mount without losing its place or singleton claim', async () => {
  const first = await openHostedDiff(fake.context, { worktree: 'w1', mode: 'review' })
  const ownerId = first.tabId
  if (ownerId === undefined) throw new Error('Review tab has no identity')
  const owner = mount(first)
  await s.settle()
  expect(owner.element.querySelector('[data-review-tab]')).not.toBeNull()

  const workspaceId = 'id:w1'
  const { workspace } = await fake.context.call('quirky.terminal/workspace', { workspace: workspaceId }) as {
    workspace: { activeGroup: string; revision: number }
  }
  const rawNoteInput = { worktree: 'w1', mode: 'review', reveal: APP, noteId: NOTE.id } as const
  const openedNote = await fake.context.call('quirky.terminal/openViewTab', {
    workspace: workspaceId,
    group: workspace.activeGroup,
    viewId: p.DIFF_VIEW,
    key: diffViewKey(rawNoteInput),
    input: rawNoteInput,
    title: 'Review',
    reuse: true,
    activate: true,
    closeMethod: 'quirky.git/diffCloseGuard',
    closeParams: { worktree: 'w1', dirty: false },
    closeContext: true,
    revision: workspace.revision
  }) as { tab: string }
  expect(openedNote.tab).toBe(ownerId)
  let accepted = false
  s.act(() => {
    accepted = owner.cleanup.updateInput?.({ ...rawNoteInput, tabId: openedNote.tab }) === true
  })
  expect(accepted).toBe(true)
  await s.settle()

  expect(owner.element.querySelector('[data-review-tab]')).not.toBeNull()
  expect(owner.element.querySelector(`[data-path="${APP}"] [data-note-card="saved"]`)?.textContent).toContain(NOTE.body)

  const { workspace: current } = await fake.context.call('quirky.terminal/workspace', { workspace: workspaceId }) as {
    workspace: { activeGroup: string; revision: number }
  }
  const duplicateBase = { worktree: 'w1', mode: 'review' } as const
  const opened = await fake.context.call('quirky.terminal/openViewTab', {
    workspace: workspaceId,
    group: workspace.activeGroup,
    viewId: p.DIFF_VIEW,
    key: diffViewKey(duplicateBase),
    input: duplicateBase,
    title: 'Review',
    reuse: false,
    activate: true,
    closeMethod: 'quirky.git/diffCloseGuard',
    closeParams: { worktree: 'w1', dirty: false },
    closeContext: true,
    revision: current.revision
  }) as { tab: string }
  const duplicateInput = { ...duplicateBase, tabId: opened.tab }
  const duplicate = mount(duplicateInput)
  await s.settle()
  expect(duplicate.element.querySelector('[data-review-tab]')).toBeNull()
  expect(fake.called('quirky.terminal/closeTab').map((call) => call.params.tab)).toContain(opened.tab)
  expect(duplicate.cleanup.updateInput?.({ ...duplicateInput, reveal: APP, noteId: NOTE.id })).toBe(false)

  await owner.unmount()
  expect(claimReviewTab('w1', 'next-review')).toBe(true)
  releaseReviewTab('w1', 'next-review')
})
