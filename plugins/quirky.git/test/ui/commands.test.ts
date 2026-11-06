import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { fakeContext, layoutFor, mountView, numbered, registerPanel, reviewFile, reviewModel, settle, stubIntersectionObserver, textDiff } = s

const COMMANDS = [
  'show',
  'open-diff',
  'close-diff',
  'open-changes',
  'open-branch-changes',
  'open-commit',
  'review-conflicts',
  'next-change',
  'previous-change',
  'next-conflict',
  'previous-conflict',
  'revert-change',
  'save',
  'reload-from-disk',
  'overwrite',
  'collapse-all',
  'load-diff',
  'refresh-compare',
  'set-filter',
  'select',
  'toggle-history'
]

let fake: ReturnType<typeof fakeContext>
let mounted: ReturnType<typeof mountView> | null = null
let unregister: (() => void) | null = null
let observer: ReturnType<typeof stubIntersectionObserver>

/** Mounts the Review tab with one changed file whose diff has changes far apart. */
const openReviewTab = async () => {
  fake.handlers['quirky.git/review'] = () => reviewModel([reviewFile('math.ts')])
  fake.handlers['quirky.git/diff'] = () => textDiff({ source: 'review', original: numbered(30), modified: numbered(30).replace('line 3\n', 'x\n') })
  mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
  await settle()
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
  observer = stubIntersectionObserver()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  observer.restore()
  unregister?.()
  unregister = null
})

describe('quirky.git commands', () => {
  test('SC-64: activate provides every command of the table', () => {
    for (const id of COMMANDS) expect(fake.provided.has(`command:quirky.git/${id}`)).toBe(true)
    expect(fake.provided.has(s.DIFF_VIEW)).toBe(true)
    expect(fake.provided.has(s.PANEL)).toBe(true)
  })

  test('SC-64: show opens the Source Control panel', async () => {
    await fake.run('show')
    expect(fake.panelToggles).toEqual([{ id: s.PANEL, open: true }])
  })

  describe('opening views', () => {

    test('open-diff needs a path', async () => {
      await expect(fake.run('open-diff', {})).rejects.toThrow('open-diff needs a path.')
      await expect(fake.run('open-diff')).rejects.toThrow('open-diff needs a path.')
    })

    test('SC-64: with no worktree open the open commands say so', async () => {
      fake.layout = layoutFor(null)
      for (const id of ['open-diff', 'open-changes', 'open-branch-changes', 'open-commit', 'review-conflicts']) {
        await expect(fake.run(id, { path: 'a.ts', commit: 'abc' })).rejects.toThrow('Open a worktree first.')
      }
      expect(fake.opened).toEqual([])
    })

    test('keybinding handlers get undefined arguments and still work', async () => {
      await expect(fake.run('show', undefined)).resolves.toBeUndefined()
      await expect(fake.run('open-changes', null)).resolves.toBeUndefined()
    })
  })

  describe('acting on the open view', () => {
    const VIEW_COMMANDS = [
      'next-change',
      'previous-change',
      'next-conflict',
      'previous-conflict',
      'revert-change',
      'save',
      'reload-from-disk',
      'overwrite',
      'collapse-all',
      'load-diff'
    ]

    test('SC-64: with no diff view open each view command says so', async () => {
      for (const id of VIEW_COMMANDS) await expect(fake.run(id, { path: 'a.ts' })).rejects.toThrow('No diff view is open.')
    })

    test('after the view closes the commands say so again', async () => {
      await openReviewTab()
      await expect(fake.run('next-change')).resolves.toBeUndefined()
      mounted!.unmount()
      mounted = null
      await expect(fake.run('next-change')).rejects.toThrow('No diff view is open.')
    })

    test('commands that a mode has no control for do nothing', async () => {
      await openReviewTab()
      for (const id of ['next-conflict', 'previous-conflict', 'save', 'reload-from-disk', 'overwrite']) await expect(fake.run(id)).resolves.toBeUndefined()
    })

    test('load-diff names the card it cannot find', async () => {
      await openReviewTab()
      await expect(fake.run('load-diff', { path: 'x' })).rejects.toThrow('No section for x.')
    })
  })

  describe('driving the panel', () => {
    const calls: unknown[][] = []
    beforeEach(() => {
      calls.length = 0
      unregister = registerPanel({
        setFilter: (query) => void calls.push(['setFilter', query]),
        select: (paths) => void calls.push(['select', paths]),
        toggleHistory: (open) => void calls.push(['toggleHistory', open]),
        refreshCompare: () => void calls.push(['refreshCompare'])
      })
    })

    test('SC-64: set-filter, select, toggle-history and refresh-compare reach the panel', async () => {
      await fake.run('set-filter', { query: 'math' })
      await fake.run('set-filter', { query: '' })
      await fake.run('select', { paths: ['a.ts', 'b.ts'] })
      await fake.run('toggle-history', { open: true })
      await fake.run('toggle-history')
      await fake.run('refresh-compare')
      expect(calls).toEqual([
        ['setFilter', 'math'],
        ['setFilter', ''],
        ['select', ['a.ts', 'b.ts']],
        ['toggleHistory', true],
        ['toggleHistory', undefined],
        ['refreshCompare']
      ])
    })

    test('the panel commands tolerate missing arguments', async () => {
      await fake.run('set-filter')
      await fake.run('select')
      expect(calls).toEqual([
        ['setFilter', ''],
        ['select', []]
      ])
    })

    test('with the panel closed they say Source Control is not open', async () => {
      unregister?.()
      unregister = null
      for (const id of ['set-filter', 'select', 'toggle-history', 'refresh-compare']) {
        await expect(fake.run(id, {})).rejects.toThrow('Source Control is not open.')
      }
    })
  })
})
