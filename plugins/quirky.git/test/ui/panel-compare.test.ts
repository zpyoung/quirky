import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, DIFF_VIEW, entry, failure, fakeContext, layoutFor, mountPanel, noticeOf, q, qa, rowOf, settle, statusOf, type } = s
const { activePanel } = await import('../../src/panel/registry')

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

const dialog = () => q(document.body, '[role="dialog"]')
const dialogTitle = () => {
  const titleId = dialog()?.getAttribute('aria-labelledby')
  return titleId ? document.getElementById(titleId)?.textContent ?? null : null
}

describe('SC-48: compare explains when it cannot run', () => {
  const unavailable = compareOf({ status: 'invalid-base', base: 'origin/gone', message: 'Base ref origin/gone could not be resolved in this repository.' })

  test('with uncommitted changes the message shows with Change base ref and Retry', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts')])
      f.compare = unavailable
    })
    expect(element.textContent).toContain('Base ref origin/gone could not be resolved in this repository.')
    expect(q(element, '[role="status"] .ui-inline-agent-card')).toBeNull()
    expect(buttonText(element, 'Change base ref')).toBeDefined()
    const before = fake.called('quirky.git/compare').length
    await click(buttonText(element, 'Retry'))
    expect(fake.called('quirky.git/compare').length).toBe(before + 1)
    unmount()
  })

  test('with no uncommitted changes it shows the "Branch compare unavailable" card', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf({ status: 'no-merge-base', message: 'This branch and origin/main do not share a merge base, so compare-to-base is unavailable.' })
    })
    expect(q(element, '[role="status"] .ui-inline-agent-card h3')?.textContent).toBe('Branch compare unavailable')
    expect(element.textContent).toContain('do not share a merge base')
    expect(element.textContent).not.toContain('No changes on this branch')
    unmount()
  })
})

describe('SC-47 and SC-51: Committed on Branch refreshes', () => {
  const branch = [{ path: 'util.ts', status: 'added' as const, added: 40, removed: 0, binary: false }]

  test('Refresh branch compare in the menu reloads it immediately', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.compare = compareOf({ entries: branch, added: 40 })
    })
    const before = fake.called('quirky.git/compare').length
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Refresh branch compare'))
    expect(fake.called('quirky.git/compare').length).toBe(before + 1)
    unmount()
  })

  test('the section updates at once after the panel\'s own commit', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts', 'staged')])
      f.compare = compareOf()
    })
    expect(q(element, '[data-section="branch"]')).toBeNull()
    fake.compare = compareOf({ entries: [{ path: 'math.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1 })
    await type(byLabel(element, 'Commit message') as HTMLTextAreaElement, 'msg')
    await click(q(element, '[data-git-primary]'))
    expect(rowOf(element, 'math.ts', 'branch')).not.toBeNull()
    unmount()
  })

  test('a status read showing HEAD moved reloads compare', async () => {
    const { fake, unmount } = await open()
    const before = fake.called('quirky.git/compare').length
    fake.status = statusOf([], { head: 'f'.repeat(40) })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(fake.called('quirky.git/compare').length).toBe(before + 1)
    unmount()
  })

  test('changing the compare base setting reloads compare', async () => {
    const { fake, unmount } = await open()
    const before = fake.called('quirky.git/compare').length
    fake.settings.compareBase = 'branch-upstream'
    await act(async () => fake.emit({ type: 'setting.changed', id: 'setting:quirky.git/compareBase', value: 'branch-upstream' }))
    await settle()
    expect(fake.called('quirky.git/compare').length).toBe(before + 1)
    unmount()
  })
})

describe('SC-50: Change Base Ref', () => {
  const refs = [
    { name: 'main', kind: 'local' },
    { name: 'release', kind: 'local' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'origin/release', kind: 'remote' }
  ]
  const setup = (f: Fake) => {
    f.on('quirky.git/branches', (params) => ({
      refs: refs.filter((r) => r.name.includes((params.query as string | undefined) ?? '')),
      current: 'zoe/feat'
    }))
  }

  test('searching narrows the list, marks the current base and picking writes it', async () => {
    const { fake, element, unmount } = await open(setup)
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Change Base Ref…'))
    expect(dialogTitle()).toBe('Change Base Ref')
    expect(dialog()?.textContent).toContain('Pick the branch compare target for this repository.')
    expect(qa(dialog()!, '[aria-label="Branches"] .ui-list-row__main')).toHaveLength(4)
    expect(q(dialog()!, '[aria-label="Branches"] [aria-pressed="true"]')?.textContent).toContain('origin/main')
    await type(byLabel(dialog()!, 'Search branches') as HTMLInputElement, 'rel')
    expect(fake.called('quirky.git/branches').at(-1)?.params).toEqual({ worktree: 'feat', query: 'rel' })
    expect(qa(dialog()!, '[aria-label="Branches"] .ui-list-row__main').map((row) => row.textContent)).toEqual(['releaselocal', 'origin/releaseremote'])
    await click(q(dialog()!, '[aria-label="Branches"] .ui-list-row__main'))
    expect(fake.called('quirky.git/setBase').at(-1)?.params).toEqual({ worktree: 'feat', base: 'release' })
    expect(dialog()).toBeNull()
    unmount()
  })

  test('Use Primary clears the base; the base button in the branch row opens the dialog too', async () => {
    const { fake, element, unmount } = await open(setup)
    await click(q(element, '[data-base-ref]'))
    await click(buttonText(dialog()!, 'Use Primary'))
    expect(fake.called('quirky.git/setBase').at(-1)?.params).toEqual({ worktree: 'feat', clear: true })
    unmount()
  })

  test('a refused base shows the message and keeps the dialog open', async () => {
    const { element, unmount } = await open((f) => {
      setup(f)
      f.on('quirky.git/setBase', () => {
        throw failure('Base ref origin/gone could not be resolved in this repository.', { reason: 'invalid-base' })
      })
    })
    await click(q(element, '[data-base-ref]'))
    await click(q(dialog()!, '[aria-label="Branches"] .ui-list-row__main'))
    expect(dialog()?.textContent).toContain('could not be resolved')
    unmount()
  })
})

describe('SC-54: the Commits dock', () => {
  const commit = (n: number, subject: string) => ({
    oid: `${n}`.repeat(40).slice(0, 40),
    parents: [],
    author: 'Zoe',
    email: 'zoe@example.com',
    authoredAt: Date.now() - 3 * 3600_000,
    committedAt: Date.now(),
    subject,
    body: '',
    refs: n === 1 ? ['HEAD -> zoe/feat', 'tag: v1'] : []
  })

  const history = (f: Fake) => {
    f.on('quirky.git/history', (params) => ({
      commits: params.limit === 200 ? [commit(1, 'Merge main'), commit(2, 'Add math'), commit(3, 'Old one')] : [commit(1, 'Merge main'), commit(2, 'Add math')],
      hasMore: params.limit !== 200
    }))
    f.on('quirky.git/commitFiles', () => ({
      commit: '1'.repeat(40),
      parent: '0'.repeat(40),
      entries: [
        { path: 'math.ts', status: 'modified', added: 2, removed: 1, binary: false },
        { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', added: 0, removed: 0, binary: false }
      ]
    }))
  }

  test('is collapsed by default and loads nothing until opened', async () => {
    const { fake, element, unmount } = await open(history)
    expect(q(element, '[data-history-content]')).toBeNull()
    expect(fake.called('quirky.git/history')).toHaveLength(0)
    unmount()
  })

  test('rows show subject, short id, author, relative time and ref chips', async () => {
    const { fake, element, unmount } = await open(history)
    await click(byLabel(element, 'Expand Commits'))
    expect(fake.called('quirky.git/history').at(-1)?.params).toEqual({ worktree: 'feat' })
    const row = q(element, '[data-commit-row]')!
    expect(q(row, '.ui-list-row__title')?.textContent).toContain('Merge main')
    expect(q(row, '.ui-list-row__description')?.textContent).toBe('1111111 · Zoe · 3h ago')
    expect(qa(row, '[aria-label^="Commit ref "]').map((ref) => ref.textContent)).toEqual(['HEAD -> zoe/feat', 'tag: v1'])
    unmount()
  })

  test('clicking a commit opens its combined diff; expanding it lists files that open their commit diff', async () => {
    const { fake, element, unmount } = await open(history)
    await click(byLabel(element, 'Expand Commits'))
    await click(q(element, '[data-commit-row] .ui-list-row__main'))
    expect(fake.views.at(-1)).toEqual({ id: DIFF_VIEW, input: { worktree: 'feat', mode: 'combined', commit: '1'.repeat(40), title: 'Commit 1111111: Merge main' } })
    await click(byLabel(element, 'Expand commit 1111111'))
    expect(fake.called('quirky.git/commitFiles').at(-1)?.params).toEqual({ worktree: 'feat', commit: '1'.repeat(40) })
    await click(rowOf(element, 'new.ts', 'history'))
    expect(fake.views.at(-1)?.input).toEqual({ worktree: 'feat', mode: 'file', source: 'commit', commit: '1'.repeat(40), path: 'new.ts', oldPath: 'old.ts' })
    unmount()
  })

  test('Load more asks for up to 200 and goes away when everything is shown', async () => {
    const { fake, element, unmount } = await open(history)
    await click(byLabel(element, 'Expand Commits'))
    await click(buttonText(element, 'Load more'))
    expect(fake.called('quirky.git/history').at(-1)?.params).toEqual({ worktree: 'feat', limit: 200 })
    expect(qa(element, '[data-commit-row]')).toHaveLength(3)
    expect(buttonText(element, 'Load more')).toBeUndefined()
    unmount()
  })

  test('toggle-history from the panel handle opens and closes the dock', async () => {
    const { element, unmount } = await open(history)
    await act(async () => activePanel().toggleHistory())
    await settle()
    expect(q(element, '[data-history-content]')).not.toBeNull()
    await act(async () => activePanel().toggleHistory(false))
    await settle()
    expect(q(element, '[data-history-content]')).toBeNull()
    unmount()
  })
})

describe('SC-58 and SC-59: huge repositories', () => {
  const huge = (f: Fake) => {
    f.status = statusOf(
      [...Array.from({ length: 998 }, (_, i) => entry(`node_modules/p${i}/x.js`, 'untracked')), entry('a.ts'), entry('b.ts')],
      { capped: true }
    )
  }

  test('the banner offers Stage All (scope all) and Retry; Changes stages tracked only; Untracked has no Stage all', async () => {
    const { fake, element, unmount } = await open(huge)
    expect(element.textContent).toContain('Too many changes detected. Only the first 1000 are shown.')
    expect(q(element, '[data-section="untracked"] [aria-label="Stage all"]')).toBeNull()
    await click(byLabel(q(element, '[data-section="unstaged"]')!, 'Stage all'))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', scope: 'tracked' })
    await click(buttonText(q(element, '[role="status"] .ui-inline-agent-card')!, 'Stage All'))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', scope: 'all' })
    const before = fake.called('quirky.git/status').length
    await click(buttonText(q(element, '[role="status"] .ui-inline-agent-card')!, 'Retry'))
    expect(fake.called('quirky.git/status').length).toBe(before + 1)
    unmount()
  })

  test('the primary Stage All stages with scope all while capped', async () => {
    const { fake, element, unmount } = await open(huge)
    await click(q(element, '[data-git-primary]'))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', scope: 'all' })
    unmount()
  })

  test('a failed Retry toasts that the panel could not refresh', async () => {
    const { fake, element, unmount } = await open(huge)
    fake.on('quirky.git/status', () => {
      throw new Error('timeout')
    })
    await click(buttonText(q(element, '[role="status"] .ui-inline-agent-card')!, 'Retry'))
    expect(fake.toasts).toContainEqual(['Could not refresh Source Control', 'Try again.'])
    unmount()
  })

  test('offers to add the first huge folder to .gitignore once per worktree', async () => {
    const { fake, element, unmount } = await open((f) => {
      huge(f)
      f.on('quirky.git/hugeFolders', () => ({ folders: ['node_modules', 'dist'] }))
    })
    const notice = noticeOf(element)!
    expect(notice.textContent).toContain('This repository has too many active changes. Add "node_modules" to .gitignore?')
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(fake.called('quirky.git/hugeFolders')).toHaveLength(1)
    await click(buttonText(notice, 'Add to .gitignore'))
    expect(fake.called('quirky.git/ignoreFolder').at(-1)?.params).toEqual({ worktree: 'feat', folder: 'node_modules' })
    expect(noticeOf(element)).toBeNull()
    unmount()
  })
})

describe('SC-64: the panel handle commands act on', () => {
  test('set-filter, select and refresh-compare drive the mounted panel', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('math.ts'), entry('other.ts')])
    })
    await act(async () => activePanel().setFilter('math'))
    await settle()
    expect(qa(element, '[data-row-path] button[aria-pressed]').map((row) => row.closest('[data-row-path]')?.getAttribute('title'))).toEqual(['math.ts'])
    expect(fake.reports.at(-1).filter).toBe('math')
    await act(async () => activePanel().setFilter(''))
    await settle()
    expect(byLabel(element, 'Filter files…')).toBeNull()
    await act(async () => activePanel().select(['math.ts', 'other.ts']))
    await settle()
    expect(q(element, '[role="toolbar"][aria-label="Selection actions"]')?.textContent).toContain('2 selected')
    const before = fake.called('quirky.git/compare').length
    await act(async () => activePanel().refreshCompare())
    await settle()
    expect(fake.called('quirky.git/compare').length).toBe(before + 1)
    unmount()
    expect(() => activePanel()).toThrow('Source Control is not open.')
  })
})
