import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode, type GitStatusEntry } from '@quirky/protocol'
import { registerDom } from './register-dom'
import { editTargets, MAX_EDIT_FILES } from '../../src/review/open-changes'

registerDom()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { fakeContext, layoutFor, mountView, numbered, registerPanel, reviewFile, reviewModel, settle, status, stubIntersectionObserver, textDiff } = s

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

const statusEntry = (
  path: string,
  area: GitStatusEntry['area'],
  status?: GitStatusEntry['status'],
  extra: Partial<GitStatusEntry> = {}
): GitStatusEntry => ({ path, area, status: status ?? (area === 'untracked' ? 'untracked' : 'modified'), ...extra })

const setStatus = (entries: GitStatusEntry[], capped = false) => {
  fake.handlers['quirky.git/status'] = () => ({ ...status(entries), capped })
}

const setReviewTerminal = () => {
  const workspace = (tabs: unknown[] = [], revision = 0) => ({
    id: 'w1',
    revision,
    activeGroup: 'g1',
    root: { kind: 'group', id: 'g1', tabs, activeTab: tabs.length > 0 ? 'review-tab' : null }
  })
  fake.handlers['quirky.terminal/workspace'] = () => ({ workspace: workspace() })
  fake.handlers['quirky.terminal/openViewTab'] = (params) => {
    const tab = {
      kind: 'view',
      id: 'review-tab',
      viewId: params.viewId,
      key: params.key,
      input: params.input,
      title: params.title,
      pinned: false,
      preview: params.preview === true
    }
    return { tab: 'review-tab', workspace: workspace([tab], 1) }
  }
  fake.handlers['quirky.terminal/rekeyViewTabs'] = () => ({})
  fake.handlers['quirky.terminal/activateTab'] = () => ({})
  fake.handlers['ui.window.self'] = () => ({ connId: 7 })
  fake.handlers['quirky.worktree/navigate'] = () => ({})
}

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
      setReviewTerminal()
      await expect(fake.run('open-changes', null)).resolves.toMatchObject({
        mode: 'diff',
        source: null,
        focused: true,
        review: { focused: true, statusComplete: null }
      })
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

describe('open-changes edit mode', () => {
  beforeEach(() => setReviewTerminal())

  test('editTargets deduplicates, sorts, honors source scope and skips deletions', () => {
    const entries = [
      statusEntry('x', 'staged', 'deleted'),
      statusEntry('x', 'untracked'),
      statusEntry('y', 'staged', 'deleted'),
      statusEntry('z', 'unstaged', 'deleted'),
      statusEntry('r', 'staged', 'renamed', { oldPath: 'q' }),
      statusEntry('k', 'conflicts'),
      statusEntry('m', 'staged'),
      statusEntry('m', 'unstaged')
    ]
    expect(editTargets(entries, null)).toEqual({ open: ['k', 'm', 'r', 'x'], deleted: ['y', 'z'] })
    expect(editTargets(entries, 'staged')).toEqual({ open: ['m', 'r', 'x'], deleted: ['y'] })
    expect(editTargets(entries, 'unstaged')).toEqual({ open: ['m', 'x'], deleted: ['z'] })
  })

  test('editTargets sorts paths by UTF-8 bytes rather than locale or UTF-16 order', () => {
    const entries = [statusEntry('𐀀', 'untracked'), statusEntry('\uE000', 'untracked')]
    expect(editTargets(entries, null).open).toEqual(['\uE000', '𐀀'])
  })

  test('opens each selected target once in byte order and returns deleted paths as skipped', async () => {
    setStatus([
      statusEntry('x', 'staged', 'deleted'),
      statusEntry('x', 'untracked'),
      statusEntry('y', 'staged', 'deleted'),
      statusEntry('z', 'unstaged', 'deleted'),
      statusEntry('r', 'staged', 'renamed', { oldPath: 'q' }),
      statusEntry('k', 'conflicts'),
      statusEntry('m', 'staged'),
      statusEntry('m', 'unstaged')
    ])
    fake.handlers['quirky.editor/open'] = ({ path }) => ({ id: `buffer:${path}`, openedTabId: `tab:${path}` })

    const result = await fake.run('open-changes', { mode: 'edit', focus: false }) as {
      opened: Array<{ path: string; tabId: string; bufferId: string }>
      skipped: Array<{ path: string; reason: string }>
    }

    expect(fake.callsTo('quirky.editor/open').map((call) => call.params)).toEqual([
      { worktree: 'w1', path: 'k', focus: false },
      { worktree: 'w1', path: 'm', focus: false },
      { worktree: 'w1', path: 'r', focus: false },
      { worktree: 'w1', path: 'x', focus: false }
    ])
    expect(result.opened).toEqual([
      { path: 'k', tabId: 'tab:k', bufferId: 'buffer:k' },
      { path: 'm', tabId: 'tab:m', bufferId: 'buffer:m' },
      { path: 'r', tabId: 'tab:r', bufferId: 'buffer:r' },
      { path: 'x', tabId: 'tab:x', bufferId: 'buffer:x' }
    ])
    expect(result.skipped).toEqual([{ path: 'y', reason: 'deleted' }, { path: 'z', reason: 'deleted' }])
  })

  test('reports per-file failures and continues opening the remaining targets', async () => {
    setStatus([statusEntry('a.ts', 'unstaged'), statusEntry('b.ts', 'unstaged'), statusEntry('c.ts', 'untracked')])
    fake.handlers['quirky.editor/open'] = ({ path }) => {
      if (path === 'a.ts') return { id: 'buf-a', openedTabId: 'tab-a' }
      if (path === 'b.ts') throw Object.assign(new Error('file does not exist: /w/b.ts'), { code: RpcErrorCode.NotFound })
      throw Object.assign(new Error('file too large (1 bytes; maximum 0): /w/c.ts'), { code: -32602 })
    }

    const result = await fake.run('open-changes', { mode: 'edit', focus: false }) as {
      opened: Array<{ path: string; tabId: string; bufferId: string }>
      skipped: Array<{ path: string; reason: string; message?: string }>
    }

    expect(result.opened).toEqual([{ path: 'a.ts', tabId: 'tab-a', bufferId: 'buf-a' }])
    expect(result.skipped).toEqual([
      { path: 'b.ts', reason: 'missing', message: 'file does not exist: /w/b.ts' },
      { path: 'c.ts', reason: 'failed', message: 'file too large (1 bytes; maximum 0): /w/c.ts' }
    ])
    expect(fake.callsTo('quirky.editor/open').map((call) => call.params.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  test('edit focus opens files in the background then focuses the first file in this window', async () => {
    setStatus([statusEntry('a.ts', 'unstaged'), statusEntry('b.ts', 'unstaged')])
    fake.handlers['quirky.editor/open'] = ({ path }) => ({ id: `buf-${path}`, openedTabId: `tab-${path}` })

    const result = await fake.run('open-changes', { mode: 'edit' }) as { focused: boolean }

    expect(fake.callsTo('quirky.editor/open').map((call) => call.params)).toEqual([
      { worktree: 'w1', path: 'a.ts', focus: false },
      { worktree: 'w1', path: 'b.ts', focus: false },
      { worktree: 'w1', path: 'a.ts', focus: true, window: 7 }
    ])
    expect(fake.callsTo('ui.window.self')).toHaveLength(1)
    expect(result.focused).toBe(true)
  })

  test('both opens files in the background before focusing the Review', async () => {
    setStatus([statusEntry('a.ts', 'unstaged'), statusEntry('b.ts', 'unstaged')])
    fake.handlers['quirky.editor/open'] = ({ path }) => ({ id: `buf-${path}`, openedTabId: `tab-${path}` })

    const result = await fake.run('open-changes', { mode: 'both' }) as {
      focused: boolean
      review: { focused: boolean; created: boolean }
    }

    expect(fake.callsTo('quirky.editor/open').map((call) => call.params)).toEqual([
      { worktree: 'w1', path: 'a.ts', focus: false },
      { worktree: 'w1', path: 'b.ts', focus: false }
    ])
    expect(fake.callsTo('ui.window.self')).toHaveLength(1)
    expect(fake.callsTo('quirky.terminal/openViewTab')[0]!.params.activate).toBe(true)
    expect(fake.callsTo('quirky.worktree/navigate')).toEqual([{
      method: 'quirky.worktree/navigate',
      params: { worktree: 'id:w1', target: 'terminal', window: 7 }
    }])
    expect(fake.calls.findIndex((call) => call.method === 'quirky.terminal/openViewTab'))
      .toBeLessThan(fake.calls.findIndex((call) => call.method === 'quirky.worktree/navigate'))
    expect(result).toMatchObject({ focused: true, review: { created: true, focused: true } })
  })

  test('rejects if the focused editor open fails', async () => {
    setStatus([statusEntry('a.ts', 'unstaged')])
    fake.handlers['quirky.editor/open'] = (params) => {
      if (params.focus === true) throw new Error('UI window connection 7 is not open')
      return { id: 'buf-a', openedTabId: 'tab-a' }
    }

    await expect(fake.run('open-changes', { mode: 'edit' })).rejects.toThrow('UI window connection 7 is not open')
  })

  test('refuses more than 50 files before opening an editor or Review tab', async () => {
    setStatus(Array.from({ length: MAX_EDIT_FILES + 1 }, (_, index) => statusEntry(`file-${index.toString().padStart(2, '0')}.ts`, 'untracked')))
    fake.handlers['quirky.editor/open'] = () => ({ id: 'buf', openedTabId: 'tab' })

    for (const mode of ['edit', 'both']) {
      await expect(fake.run('open-changes', { mode })).rejects.toThrow(
        'open-changes would open 51 files in the editor; edit and both open at most 50.'
      )
    }

    expect(fake.callsTo('quirky.editor/open')).toEqual([])
    expect(fake.callsTo('quirky.terminal/openViewTab')).toEqual([])
  })

  test('opens 50 files when the target count is at the limit', async () => {
    setStatus(Array.from({ length: MAX_EDIT_FILES }, (_, index) => statusEntry(`file-${index.toString().padStart(2, '0')}.ts`, 'untracked')))
    fake.handlers['quirky.editor/open'] = ({ path }) => ({ id: `buf-${path}`, openedTabId: `tab-${path}` })

    const result = await fake.run('open-changes', { mode: 'edit', focus: false }) as { opened: unknown[]; skipped: unknown[] }

    expect(fake.callsTo('quirky.editor/open')).toHaveLength(MAX_EDIT_FILES)
    expect(result.opened).toHaveLength(MAX_EDIT_FILES)
    expect(result.skipped).toEqual([])
  })

  test('refuses edit and both on capped status before any narrowed selection opens', async () => {
    setStatus([statusEntry('a.ts', 'unstaged'), statusEntry('b.ts', 'staged')], true)
    fake.handlers['quirky.editor/open'] = () => ({ id: 'buf', openedTabId: 'tab' })

    for (const args of [{ mode: 'edit' }, { mode: 'both' }, { mode: 'edit', area: 'staged' }, { mode: 'both', area: 'staged' }]) {
      await expect(fake.run('open-changes', args)).rejects.toThrow(
        'git status stopped at its entry limit, so the changed-file list is incomplete; edit and both need the full list.'
      )
    }
    expect(fake.callsTo('quirky.editor/open')).toEqual([])
    expect(fake.callsTo('quirky.terminal/openViewTab')).toEqual([])
  })

  test('rejects a scoped path absent from a complete status list', async () => {
    setStatus([statusEntry('b.ts', 'unstaged')])

    await expect(fake.run('open-diff', { path: 'a.ts', source: 'staged' })).rejects.toThrow(
      'a.ts has no staged changes.'
    )
    expect(fake.callsTo('quirky.terminal/openViewTab')).toEqual([])
  })

  test('returns incomplete status for capped diff scopes and rejects a scoped path it cannot check', async () => {
    setStatus([statusEntry('a.ts', 'unstaged'), statusEntry('b.ts', 'staged')], true)

    const staged = await fake.run('open-changes', { area: 'staged' }) as {
      statusComplete: boolean
      source: string | null
      review: { statusComplete: boolean | null }
    }
    const whole = await fake.run('open-changes', {}) as {
      statusComplete: boolean
      review: { statusComplete: boolean | null }
    }
    const listed = await fake.run('open-diff', { path: 'b.ts', source: 'staged' }) as { statusComplete: boolean }
    const opensBeforeMissingPath = fake.callsTo('quirky.terminal/openViewTab').length
    await expect(fake.run('open-diff', { path: 'c.ts', source: 'staged' })).rejects.toThrow(
      'git status stopped at its entry limit, so c.ts could not be checked for staged changes.'
    )

    expect(staged).toMatchObject({ statusComplete: false, source: 'staged', review: { statusComplete: false } })
    expect(whole).toMatchObject({ statusComplete: false, review: { statusComplete: null } })
    expect(listed.statusComplete).toBe(false)
    expect(fake.callsTo('quirky.terminal/openViewTab')).toHaveLength(opensBeforeMissingPath)
  })

  test('rejects status failures and refuses conflict opens in the background', async () => {
    fake.handlers['quirky.git/status'] = () => {
      throw new Error('status unavailable')
    }
    await expect(fake.run('open-changes', { mode: 'edit' })).rejects.toThrow('status unavailable')
    expect(fake.callsTo('quirky.editor/open')).toEqual([])

    await expect(fake.run('open-diff', { path: 'b.ts', source: 'conflict', focus: false })).rejects.toThrow(
      'open-diff cannot open a conflict file in the background.'
    )
    expect(fake.callsTo('quirky.terminal/openViewTab')).toEqual([])
  })
})
