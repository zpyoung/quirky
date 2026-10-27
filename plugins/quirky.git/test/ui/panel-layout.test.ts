import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, DIFF_VIEW, entry, fakeContext, layoutFor, mountPanel, press, q, qa, rowOf, sectionHeadings, settle, statusOf, type } = s

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

const sc1 = () =>
  statusOf(
    [
      entry('README.md', 'staged', 'modified', { added: 2, removed: 1 }),
      entry('math.ts', 'unstaged', 'modified', { added: 5 }),
      entry('new.ts', 'staged', 'renamed', { oldPath: 'old.ts' }),
      entry('notes.txt', 'untracked', 'untracked', { added: 3 })
    ],
    { ahead: 1, upstreamStatus: { hasUpstream: true, name: 'origin/zoe/feat', sha: 'b'.repeat(40), ahead: 1, behind: 0, behindPatchEquivalent: null } }
  )

async function open(configure: (fake: ReturnType<typeof fakeContext>) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'))
  fake.status = sc1()
  fake.compare = compareOf({
    entries: [{ path: 'util.ts', status: 'added', added: 40, removed: 0, binary: false }, { path: 'src/math.ts', status: 'modified', added: 12, removed: 3, binary: false }],
    added: 52,
    removed: 3,
    ahead: 2
  })
  configure(fake)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

describe('SC-8: the panel layout', () => {
  test('lists the sections in the default order, then Committed on Branch and the collapsed Commits dock', async () => {
    const { element, unmount } = await open()
    expect(sectionHeadings(element)).toEqual(['Changes', 'Staged Changes', 'Untracked Files', 'Committed on Branch', 'Commits'])
    expect(qa(element, '.scm-section-head .scm-count').map((c) => c.textContent)).toEqual(['1', '2', '1', '2'])
    expect(q(element, '[data-section="history"] .scm-history')).toBeNull()
    unmount()
  })

  test('shows the filter toggle and the more-actions menu in the header', async () => {
    const { element, unmount } = await open()
    expect(byLabel(element, 'Filter files by name')).not.toBeNull()
    expect(byLabel(element, 'More source control actions')).not.toBeNull()
    unmount()
  })

  test('the branch row reads <branch> → <base> with ↑N and the line-total chip', async () => {
    const { element, unmount } = await open()
    const row = q(element, '.scm-branch')!
    expect(q(row, '.scm-branch-name')?.textContent).toBe('zoe/feat')
    expect(q(row, '.scm-base')?.textContent).toBe('origin/main')
    expect(q(row, '.scm-ahead')?.textContent).toBe('↑1')
    expect(q(row, '.scm-behind')).toBeNull()
    expect(q(row, '.scm-chip')?.textContent).toBe('+52 −3')
    unmount()
  })

  test('rows show the bold name, the muted folder, counts only above zero and the coloured letter', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([entry('src/app/math.ts', 'unstaged', 'modified', { added: 5, removed: 0 })])
    })
    const row = rowOf(element, 'src/app/math.ts')!
    expect(q(row, '.scm-row-name')?.textContent).toBe('math.ts')
    expect(q(row, '.scm-row-dir')?.textContent).toBe('src/app')
    expect(q(row, '.scm-added')?.textContent).toBe('+5')
    expect(q(row, '.scm-removed')).toBeNull()
    expect(q(row, '.scm-letter')?.textContent).toBe('M')
    expect(q(row, '.scm-letter')?.className).toContain('scm-status-modified')
    unmount()
  })

  test('uses a letter per status: A, D, R, U', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([
        entry('a.ts', 'staged', 'added'),
        entry('d.ts', 'unstaged', 'deleted'),
        entry('r.ts', 'staged', 'renamed', { oldPath: 'x.ts' }),
        entry('u.ts', 'untracked')
      ])
    })
    const letters = Object.fromEntries(['a.ts', 'd.ts', 'r.ts', 'u.ts'].map((p) => [p, q(rowOf(element, p)!, '.scm-letter')?.textContent]))
    expect(letters).toEqual({ 'a.ts': 'A', 'd.ts': 'D', 'r.ts': 'R', 'u.ts': 'U' })
    unmount()
  })

  test('the Committed on Branch heading says how many files changed against the base', async () => {
    const { element, unmount } = await open()
    expect(q(element, '[data-section="branch"] .scm-section-head')?.getAttribute('title')).toBe('2 files changed vs origin/main')
    unmount()
  })
})

describe('SC-9: the group order setting', () => {
  test('reorders the sections live, keeping Conflicts first', async () => {
    const { fake, element, unmount } = await open()
    fake.status = statusOf([...fake.status.entries, entry('c.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })], { operation: 'merge' })
    fake.settings.groupOrder = 'staged-first'
    await act(async () => fake.emit({ type: 'setting.changed', id: 'setting:quirky.git/groupOrder', value: 'staged-first' }))
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(sectionHeadings(element).slice(0, 4)).toEqual(['Conflicts', 'Staged Changes', 'Changes', 'Untracked Files'])
    fake.settings.groupOrder = 'untracked-first'
    await act(async () => fake.emit({ type: 'setting.changed', id: 'setting:quirky.git/groupOrder', value: 'untracked-first' }))
    await settle()
    expect(sectionHeadings(element).slice(0, 4)).toEqual(['Conflicts', 'Untracked Files', 'Changes', 'Staged Changes'])
    unmount()
  })
})

describe('SC-10: empty states', () => {
  test('a clean branch with nothing ahead of its base says so', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([])
      fake.compare = compareOf()
    })
    expect(element.textContent).toContain('No changes on this branch')
    expect(element.textContent).toContain('This workspace is clean and this branch has no changes ahead of origin/main')
    unmount()
  })

  test('with no worktree open it asks for a workspace and reports nothing', async () => {
    const fake = fakeContext(layoutFor(null))
    const { element, unmount } = mountPanel(fake)
    await settle()
    expect(element.textContent).toContain('Select a workspace to view changes')
    expect(fake.calls).toEqual([])
    expect(fake.reports.at(-1)).toMatchObject({ worktree: null, sections: [] })
    unmount()
  })
})

describe('SC-11: the uncommitted badge', () => {
  test('counts one per row, then clears when everything is committed', async () => {
    const { fake, unmount } = await open()
    expect(fake.badges.at(-1)).toEqual(['panel:quirky.git/source-control', 4, 'Source Control — 4 uncommitted changes'])
    fake.status = statusOf([])
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(fake.badges.at(-1)?.[1]).toBeNull()
    unmount()
  })

  test('a capped status shows the 1000 entries it has', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => entry(`f${i}.txt`, 'untracked'))
    const { fake, unmount } = await open((f) => {
      f.status = statusOf(rows, { capped: true })
    })
    expect(fake.badges.at(-1)).toEqual(['panel:quirky.git/source-control', 1000, 'Source Control — 1000+ uncommitted changes'])
    unmount()
  })
})

describe('SC-14: row and section buttons', () => {
  test('rows offer the buttons their state allows', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([
        entry('math.ts', 'unstaged'),
        entry('gone.ts', 'unstaged', 'deleted'),
        entry('notes.txt', 'untracked'),
        entry('README.md', 'staged')
      ])
    })
    const labels = (path: string, section: string) => qa(rowOf(element, path, section)!.parentElement!, '.scm-row-actions button').map((b) => b.getAttribute('title'))
    expect(labels('math.ts', 'unstaged')).toEqual(['Discard changes', 'Stage'])
    expect(labels('gone.ts', 'unstaged')).toEqual(['Restore file', 'Stage'])
    expect(labels('notes.txt', 'untracked')).toEqual(['Delete untracked file', 'Stage'])
    expect(labels('README.md', 'staged')).toEqual(['Unstage'])
    unmount()
  })

  test('section headings offer discard, stage or unstage all, and View all', async () => {
    const { element, unmount } = await open()
    const buttons = (section: string) => qa(element, `[data-section="${section}"] .scm-section-actions button`).map((b) => b.getAttribute('aria-label'))
    expect(buttons('unstaged')).toEqual(['Discard all', 'Stage all', 'View all'])
    expect(buttons('untracked')).toEqual(['Delete all untracked', 'Stage all', 'View all'])
    expect(buttons('staged')).toEqual(['Discard all', 'Unstage all', 'View all'])
    unmount()
  })

  test('a submodule row has no buttons and the hint "Stage inside submodule"', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([entry('vendor/lib', 'unstaged', 'modified', { submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false } })])
    })
    const row = rowOf(element, 'vendor/lib')!
    expect(row.textContent).toContain('Stage inside submodule')
    expect(qa(row.parentElement!, '.scm-row-actions button')).toHaveLength(0)
    unmount()
  })
})

describe('opening diffs', () => {
  test('clicking a row opens the diff view with this input', async () => {
    const { fake, element, unmount } = await open()
    await click(rowOf(element, 'math.ts'))
    await click(rowOf(element, 'README.md'))
    await click(rowOf(element, 'new.ts'))
    expect(fake.views).toEqual([
      { id: DIFF_VIEW, input: { worktree: 'feat', mode: 'file', source: 'unstaged', path: 'math.ts' } },
      { id: DIFF_VIEW, input: { worktree: 'feat', mode: 'file', source: 'staged', path: 'README.md' } },
      { id: DIFF_VIEW, input: { worktree: 'feat', mode: 'file', source: 'staged', path: 'new.ts', oldPath: 'old.ts' } }
    ])
    unmount()
  })

  test('an untracked row opens its unstaged diff and a branch row opens its branch diff', async () => {
    const { fake, element, unmount } = await open()
    await click(rowOf(element, 'notes.txt'))
    await click(rowOf(element, 'util.ts'))
    expect(fake.views.map((v) => v.input)).toEqual([
      { worktree: 'feat', mode: 'file', source: 'unstaged', path: 'notes.txt' },
      { worktree: 'feat', mode: 'file', source: 'branch', path: 'util.ts' }
    ])
    unmount()
  })

  test('a conflict row opens the conflict file; View all opens the combined diff or the conflict review', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([
        entry('a.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } }),
        entry('math.ts', 'unstaged')
      ], { operation: 'merge' })
    })
    await click(rowOf(element, 'a.ts'))
    await click(byLabel(q(element, '[data-section="conflicts"]')!, 'View all'))
    await click(byLabel(q(element, '[data-section="unstaged"]')!, 'View all'))
    await click(byLabel(q(element, '[data-section="branch"]')!, 'View all'))
    expect(fake.views.map((v) => v.input)).toEqual([
      { worktree: 'feat', mode: 'conflict-file', path: 'a.ts' },
      { worktree: 'feat', mode: 'conflicts' },
      { worktree: 'feat', mode: 'combined', area: 'unstaged' },
      { worktree: 'feat', mode: 'combined', area: 'branch' }
    ])
    unmount()
  })
})

describe('SC-15: selection and the bulk bar', () => {
  const four = (fake: ReturnType<typeof fakeContext>) => {
    fake.status = statusOf(['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => entry(p)))
  }

  test('click opens and selects nothing; shift selects a range; cmd toggles; escape clears', async () => {
    const { fake, element, unmount } = await open(four)
    await click(rowOf(element, 'a.ts'))
    expect(fake.views).toHaveLength(1)
    expect(q(element, '.scm-bulk')).toBeNull()
    await click(rowOf(element, 'c.ts'), { shiftKey: true })
    expect(q(element, '.scm-bulk')?.textContent).toContain('3 selected')
    expect(buttonText(element, 'Stage (3)')).toBeDefined()
    expect(fake.views).toHaveLength(1)
    await click(rowOf(element, 'b.ts'), { metaKey: true })
    expect(q(element, '.scm-bulk')?.textContent).toContain('2 selected')
    expect(fake.reports.at(-1).selection).toEqual(['a.ts', 'c.ts'])
    await press(q(element, '.scm')!, 'Escape')
    expect(q(element, '.scm-bulk')).toBeNull()
    unmount()
  })

  test('the bulk Stage button stages the selected paths', async () => {
    const { fake, element, unmount } = await open(four)
    await click(rowOf(element, 'a.ts'), { metaKey: true })
    await click(rowOf(element, 'b.ts'), { metaKey: true })
    await click(buttonText(element, 'Stage (2)'))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['a.ts', 'b.ts'] })
    unmount()
  })

  test('a context-click on an unselected row selects only it', async () => {
    const { element, unmount } = await open(four)
    await click(rowOf(element, 'a.ts'), { metaKey: true })
    await act(async () => {
      rowOf(element, 'c.ts')!.parentElement!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    expect(q(element, '.scm-bulk')?.textContent).toContain('1 selected')
    unmount()
  })

  test('a pointer-down outside the panel clears the selection', async () => {
    const { element, unmount } = await open(four)
    await click(rowOf(element, 'a.ts'), { metaKey: true })
    expect(q(element, '.scm-bulk')).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(q(element, '.scm-bulk')).toBeNull()
    unmount()
  })

  test('changing the view mode clears the selection', async () => {
    const { fake, element, unmount } = await open(four)
    await click(rowOf(element, 'a.ts'), { metaKey: true })
    fake.settings.viewMode = 'tree'
    await act(async () => fake.emit({ type: 'setting.changed', id: 'setting:quirky.git/viewMode', value: 'tree' }))
    await settle()
    expect(q(element, '.scm-bulk')).toBeNull()
    unmount()
  })
})

describe('SC-16: the filter', () => {
  test('narrows rows case-insensitively, hides the section buttons and the Commits dock, and Escape restores', async () => {
    const { element, unmount } = await open()
    await click(byLabel(element, 'Filter files by name'))
    await type(byLabel(element, 'Filter files…') as HTMLInputElement, 'MATH')
    expect(qa(element, '.scm-row-main[title]').map((r) => r.getAttribute('title'))).toEqual(['math.ts', 'src/math.ts'])
    expect(q(element, '.scm-section-actions button')).toBeNull()
    expect(q(element, '[data-section="history"]')).toBeNull()
    expect(byLabel(element, 'Filter files by name')?.getAttribute('title')).toBe('Filter: MATH')
    await press(byLabel(element, 'Filter files…')!, 'Escape')
    expect(byLabel(element, 'Filter files…')).toBeNull()
    expect(rowOf(element, 'README.md')).not.toBeNull()
    expect(q(element, '[data-section="history"]')).not.toBeNull()
    unmount()
  })

  test('a query over 2048 bytes shows the too-large message instead of rows', async () => {
    const { element, unmount } = await open()
    await click(byLabel(element, 'Filter files by name'))
    await type(byLabel(element, 'Filter files…') as HTMLInputElement, 'x'.repeat(3000))
    expect(element.textContent).toContain('Search text is too large')
    expect(element.textContent).toContain('Use a shorter file filter.')
    expect(rowOf(element, 'math.ts')).toBeNull()
    await click(byLabel(element, 'Clear and close filter'))
    expect(rowOf(element, 'math.ts')).not.toBeNull()
    unmount()
  })
})

describe('SC-17: the tree view', () => {
  const tree = (fake: ReturnType<typeof fakeContext>) => {
    fake.status = statusOf([entry('src/app/a.ts'), entry('src/app/b.ts'), entry('lib/c.ts')])
    fake.settings.viewMode = 'tree'
  }

  test('groups rows by compacted folder, folders first, and Stage folder stages its files', async () => {
    const { fake, element, unmount } = await open(tree)
    const dirs = qa(element, '[data-section="unstaged"] .scm-dir')
    expect(dirs.map((d) => `${q(d, '.scm-row-name')?.textContent} ${q(d, '.scm-count')?.textContent}`)).toEqual(['lib 1', 'src/app 2'])
    await click(byLabel(dirs[1]!, 'Stage folder src/app'))
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['src/app/a.ts', 'src/app/b.ts'] })
    unmount()
  })

  test('View as tree from the menu writes the view-mode setting', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'View as tree'))
    expect(fake.called('setting.set').at(-1)?.params).toEqual({ id: 'setting:quirky.git/viewMode', value: 'tree' })
    expect(qa(element, '.scm-dir').length).toBeGreaterThan(0)
    unmount()
  })

  test('the more-actions menu lists View as list/tree, Change Base Ref… and Refresh branch compare', async () => {
    const { element, unmount } = await open()
    await click(byLabel(element, 'More source control actions'))
    expect(qa(document.body, '[role="menu"] button').map((b) => b.textContent)).toEqual(['View as tree', 'Change Base Ref…', 'Refresh branch compare'])
    unmount()
  })
})

describe('SC-18: the row menu and dragging', () => {
  async function contextMenu(element: HTMLElement, path: string) {
    await act(async () => {
      rowOf(element, path)!.parentElement!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
    })
    await settle()
  }

  test('offers View, Copy Path, Copy Relative Path and Reveal in Finder', async () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } })
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('src/app/a.ts')])
    })
    await contextMenu(element, 'src/app/a.ts')
    expect(qa(document.body, '[role="menu"] button').map((b) => b.textContent)).toEqual(['View', 'Copy Path', 'Copy Relative Path', 'Reveal in Finder'])
    await click(buttonText(document.body, 'Copy Path'))
    await contextMenu(element, 'src/app/a.ts')
    await click(buttonText(document.body, 'Copy Relative Path'))
    await contextMenu(element, 'src/app/a.ts')
    await click(buttonText(document.body, 'Reveal in Finder'))
    await contextMenu(element, 'src/app/a.ts')
    await click(buttonText(document.body, 'View'))
    expect(copied).toEqual(['/repo/feat/src/app/a.ts', 'src/app/a.ts'])
    expect(fake.called('quirky.git/reveal').at(-1)?.params).toEqual({ worktree: 'feat', path: 'src/app/a.ts' })
    expect(fake.views.at(-1)?.input).toMatchObject({ mode: 'file', path: 'src/app/a.ts' })
    unmount()
  })

  test('dragging a row carries its absolute path as text', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('src/app/a.ts')])
    })
    const data: Record<string, string> = {}
    const event = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer?: unknown }
    event.dataTransfer = { setData: (type: string, value: string) => void (data[type] = value) }
    await act(async () => {
      rowOf(element, 'src/app/a.ts')!.parentElement!.dispatchEvent(event)
    })
    expect(data).toEqual({ 'text/plain': '/repo/feat/src/app/a.ts' })
    unmount()
  })
})
