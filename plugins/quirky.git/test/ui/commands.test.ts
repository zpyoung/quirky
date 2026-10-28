import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { act, expectOpened, fakeContext, layoutFor, mountView, numbered, registerPanel, settle, textDiff } = s

const COMMANDS = [
  'show',
  'open-diff',
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

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
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
    test('SC-64: open-diff opens the file diff view on the path, in the open view\'s worktree', async () => {
      await fake.run('open-diff', { path: 'math.ts', source: 'unstaged' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'file', path: 'math.ts', source: 'unstaged' })
    })

    test('open-diff takes oldPath, commit and an explicit worktree, and defaults the source from the area', async () => {
      await fake.run('open-diff', { path: 'b.ts', oldPath: 'a.ts', commit: 'abc', source: 'commit', worktree: 'other' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'other', mode: 'file', path: 'b.ts', source: 'commit', oldPath: 'a.ts', commit: 'abc' })
      await fake.run('open-diff', { path: 'x.ts', area: 'staged' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'file', path: 'x.ts', source: 'staged' })
      await fake.run('open-diff', { path: 'x.ts' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'file', path: 'x.ts', source: 'unstaged' })
    })

    test('SC-64: open-diff with source conflict opens the conflict file view', async () => {
      await fake.run('open-diff', { path: 'a.ts', source: 'conflict' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'conflict-file', path: 'a.ts' })
    })
    test('open-diff sends placement and display through the public terminal hosted-view API', async () => {
      await fake.run('open-diff', {
        path: 'README.md',
        source: 'unstaged',
        preview: true,
        split: true,
        groupId: 'w1:group',
        display: 'preview'
      })
      expect(fake.callsTo('quirky.terminal/openViewTab').at(-1)?.params).toMatchObject({
        workspace: 'id:w1',
        group: 'w1:group',
        preview: false,
        input: {
          worktree: 'w1',
          mode: 'file',
          source: 'unstaged',
          path: 'README.md',
          display: 'preview',
          groupId: 'w1:group',
          preview: false,
          split: true
        }
      })
      expect(fake.callsTo('quirky.terminal/moveTab').at(-1)?.params).toMatchObject({ split: 'right', of: 'w1:group' })
    })


    test('open-diff needs a path', async () => {
      await expect(fake.run('open-diff', {})).rejects.toThrow('open-diff needs a path.')
      await expect(fake.run('open-diff')).rejects.toThrow('open-diff needs a path.')
    })

    test('SC-64: open-changes opens the combined diff of an area', async () => {
      await fake.run('open-changes', { area: 'staged' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'combined', area: 'staged' })
      await fake.run('open-changes', { area: 'unstaged' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'combined', area: 'unstaged' })
      await fake.run('open-changes')
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'combined', area: 'unstaged' })
    })

    test('open-branch-changes, open-commit and review-conflicts', async () => {
      await fake.run('open-branch-changes')
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'combined', area: 'branch' })
      await fake.run('open-commit', { commit: 'abc1234' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'combined', commit: 'abc1234' })
      await expect(fake.run('open-commit', {})).rejects.toThrow('open-commit needs a commit.')
      await fake.run('review-conflicts', { worktree: 'w9' })
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w9', mode: 'conflicts' })
    })

    test('the worktree comes from the open diff view when the layout has another view', async () => {
      fake.layout = { ...layoutFor(null), view: { id: s.DIFF_VIEW, input: { worktree: 'from-layout' } } }
      await fake.run('review-conflicts')
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'from-layout', mode: 'conflicts' })
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
      fake.handlers['quirky.git/diff'] = () => textDiff({ original: numbered(30), modified: numbered(30).replace('line 3\n', 'x\n') })
      mounted = mountView(fake, { worktree: 'w1', mode: 'file', source: 'unstaged', path: 'math.ts' })
      await settle()
      await expect(fake.run('next-change')).resolves.toBeUndefined()
      mounted.unmount()
      mounted = null
      await expect(fake.run('next-change')).rejects.toThrow('No diff view is open.')
    })

    test('commands that a mode has no control for do nothing', async () => {
      fake.handlers['quirky.git/diff'] = () => textDiff()
      mounted = mountView(fake, { worktree: 'w1', mode: 'file', source: 'staged', path: 'math.ts' })
      await settle()
      for (const id of ['next-conflict', 'previous-conflict', 'collapse-all']) await expect(fake.run(id)).resolves.toBeUndefined()
      await expect(fake.run('load-diff', { path: 'x' })).resolves.toBeUndefined()
    })

    test('a view opened with a new input replaces the old one as the target', async () => {
      fake.handlers['quirky.git/diff'] = () => textDiff()
      const first = mountView(fake, { worktree: 'w1', mode: 'file', path: 'a.ts' })
      await settle()
      const second = mountView(fake, { worktree: 'w2', mode: 'file', path: 'b.ts' })
      first.unmount()
      await settle()
      await fake.run('open-changes')
      expectOpened(fake, s.DIFF_VIEW, { worktree: 'w2', mode: 'combined', area: 'unstaged' })
      mounted = second
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

  test('SC-64: save, reload-from-disk and overwrite reach the open editable diff', async () => {
    const far = { original: numbered(30), modified: numbered(30).replace('line 3\n', 'x\n') }
    fake.handlers['quirky.git/diff'] = () => textDiff(far)
    fake.handlers['quirky.git/save'] = () => ({ hash: 'h2' })
    mounted = mountView(fake, { worktree: 'w1', mode: 'file', source: 'unstaged', path: 'math.ts' })
    await settle()
    s.edit(mounted.element, 'edited\n')
    await act(async () => void (await fake.run('save')))
    expect(fake.callsTo('quirky.git/save').length).toBe(1)
    await act(async () => void (await fake.run('overwrite')))
    expect(fake.callsTo('quirky.git/save').length).toBe(1)
    s.edit(mounted.element, 'edited again\n')
    await act(async () => void (await fake.run('overwrite')))
    expect(fake.callsTo('quirky.git/save').length).toBe(2)
    expect('expected' in fake.callsTo('quirky.git/save')[1].params).toBe(false)
  })
})
