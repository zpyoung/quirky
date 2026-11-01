import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { fakeContext, layoutFor } = await import('./panel-support')
const { openHostedDiff, updateHostedDiffDirty } = await import('../../src/view/hosted-tabs')

afterAll(() => GlobalRegistrator.unregister())

const ICON = { kind: 'tool', name: 'git-diff', hue: 'azure' }

describe('hosted diff tab icon', () => {
  test('opening a diff passes the git-diff icon', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openHostedDiff(fake.context, { worktree: 'feat', mode: 'file', path: 'a.ts', area: 'unstaged' })
    const opens = fake.called('quirky.terminal/openViewTab')
    expect(opens).toHaveLength(1)
    expect(opens[0]!.params.icon).toEqual(ICON)
  })

  test('marking the diff dirty re-opens the tab with the same icon', async () => {
    const fake = fakeContext(layoutFor('feat'))
    const opened = await openHostedDiff(fake.context, { worktree: 'feat', mode: 'file', path: 'a.ts', area: 'unstaged' })
    await updateHostedDiffDirty(fake.context, opened, true)
    const opens = fake.called('quirky.terminal/openViewTab')
    expect(opens).toHaveLength(2)
    expect(opens[1]!.params).toMatchObject({ closeParams: { worktree: 'feat', dirty: true } })
    expect(opens[1]!.params.icon).toEqual(ICON)
  })
})

describe('hosted diff dirty state', () => {
  test.each([false, true])('a stale view reporting dirty=%s leaves its replacement unchanged', async (dirty) => {
    const fake = fakeContext(layoutFor('feat'))
    const previous = await openHostedDiff(fake.context, {
      worktree: 'feat', mode: 'file', path: 'a.ts', area: 'unstaged', preview: true
    })
    const replacement = await openHostedDiff(fake.context, {
      worktree: 'feat', mode: 'file', path: 'b.ts', area: 'unstaged', preview: true
    })
    expect(replacement.tabId).toBe(previous.tabId)
    const before = structuredClone(await fake.context.call('quirky.terminal/workspace', { workspace: 'id:feat' }))

    await updateHostedDiffDirty(fake.context, previous, dirty)

    const after = await fake.context.call('quirky.terminal/workspace', { workspace: 'id:feat' })
    expect(after).toMatchObject({
      workspace: {
        root: {
          tabs: [{ id: replacement.tabId, input: replacement, title: 'b.ts (Diff)', closeParams: { dirty: false } }]
        }
      }
    })
    expect(after).toEqual(before)
  })
})
