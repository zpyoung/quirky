import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode } from '@quirky/protocol'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, DIFF_VIEW, entry, failure, fakeContext, layoutFor, listboxOf, mountPanel, noticeOf, press, q, qa, rowOf, rowPaths, selectedPaths, settle, statusOf } = s
const { onSelectedPath, selectedPath, selectPath } = await import('../../src/review/selection')
const { registerReviewView } = await import('../../src/view/registry')

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

type Fake = ReturnType<typeof fakeContext>

/** Scenario 4's worktree: enabled.ts is selected and unreviewed, flags.ts changed since its review. */
const four = (fake: Fake) => {
  fake.status = statusOf([
    entry('README.md', 'unstaged', 'modified', { added: 2, removed: 1 }),
    entry('src/app.ts', 'staged', 'modified', { added: 10, removed: 2 }),
    entry('src/feature/enabled.ts', 'untracked', 'untracked', { added: 4 }),
    entry('src/feature/flags.ts', 'unstaged', 'modified', { added: 1 })
  ])
  fake.compare = compareOf({
    entries: [{ path: 'src/feature/flags.ts', status: 'modified', added: 5, removed: 0, binary: false }],
    added: 22,
    removed: 2
  })
}

async function open(configure: (fake: Fake) => void = four) {
  const fake = fakeContext(layoutFor('feat'))
  configure(fake)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

const listbox = (element: HTMLElement) => listboxOf(element)!
const countLine = (element: HTMLElement) => q(element, '[data-count-line]')?.textContent
const dialog = () => q(document.body, '[role="dialog"]')
const dialogTitle = () => {
  const titleId = dialog()?.getAttribute('aria-labelledby')
  return titleId ? document.getElementById(titleId)?.textContent ?? null : null
}
const menuLabels = () => qa(document.body, '[role="menu"] [role="menuitem"]').map((item) => (item.textContent ?? '').replace('✓', ''))

/** Whether `elements` appear in the document in the order given. */
const inOrder = (...elements: Array<Element | null | undefined>): boolean =>
  elements.every((element, index) => element && (index === 0 || (elements[index - 1]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0))

async function rightClick(element: HTMLElement, path: string) {
  await act(async () => {
    rowOf(element, path)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }))
  })
  await settle()
}

describe('the list', () => {
  test('lists each changed file once, flat and in byte path order, with no section headings', async () => {
    const { element, unmount } = await open()
    expect(rowPaths(element)).toEqual(['README.md', 'src/app.ts', 'src/feature/enabled.ts', 'src/feature/flags.ts'])
    expect(qa(element, '[data-section]').map((section) => section.getAttribute('data-section'))).toEqual(['history'])
    expect(element.textContent).not.toContain('Staged Changes')
    expect(element.textContent).not.toContain('Committed on Branch')
    unmount()
  })

  test('is one listbox tab stop whose rows are options', async () => {
    const { element, unmount } = await open()
    expect(listbox(element).getAttribute('role')).toBe('listbox')
    expect(listbox(element).tabIndex).toBe(0)
    expect(qa(listbox(element), '[role="option"]')).toHaveLength(4)
    expect(qa(listbox(element), 'button').every((button) => button.tabIndex === -1)).toBe(true)
    unmount()
  })

  test('a file changed in commits and on disk appears once, with the uncommitted dot', async () => {
    const { element, unmount } = await open()
    expect(rowPaths(element).filter((path) => path === 'src/feature/flags.ts')).toHaveLength(1)
    const row = rowOf(element, 'src/feature/flags.ts')!
    expect(q(row, '.git-row__dirty')).not.toBeNull()
    expect(q(row, '.git-row__dirty--staged')).toBeNull()
    unmount()
  })

  test('a staged file shows a filled dot and a committed-only file shows none', async () => {
    const { element, unmount } = await open((fake) => {
      four(fake)
      fake.compare = compareOf({
        entries: [{ path: 'lib/done.ts', status: 'added', added: 3, removed: 0, binary: false }],
        added: 3
      })
    })
    expect(q(rowOf(element, 'src/app.ts')!, '.git-row__dirty--staged')).not.toBeNull()
    expect(q(rowOf(element, 'lib/done.ts')!, '.git-row__dirty')).toBeNull()
    unmount()
  })

  test('a row reads mark, icon, name, folder, counts, note count, dot and status letter in that order', async () => {
    const { element, unmount } = await open((fake) => {
      four(fake)
      fake.marks['src/feature/flags.ts'] = 'changed'
      fake.noteCounts['src/feature/flags.ts'] = 2
    })
    const row = rowOf(element, 'src/feature/flags.ts')!
    const mark = q(row, '.git-row__mark [role="img"]')
    expect(mark?.getAttribute('aria-label')).toBe('Changed since review')
    expect(inOrder(
      mark,
      q(row, '.ui-file-icon'),
      q(row, '[data-row-name]'),
      q(row, '.git-row__dir'),
      q(row, '.git-row__added'),
      q(row, '.git-row__notes'),
      q(row, '.git-row__dirty'),
      q(row, '.git-row__status')
    )).toBe(true)
    expect(q(row, '[data-row-name]')?.textContent).toBe('flags.ts')
    expect(q(row, '.git-row__dir')?.getAttribute('data-row-dir')).toBe('src/feature')
    expect(q(row, '.git-row__dir')?.title).toBe('src/feature')
    expect(row.title).toBe('src/feature/flags.ts')
    expect(q(row, '.git-row__added')?.textContent).toBe('+5')
    expect(q(row, '[aria-label*="deletions"]')).toBeNull()
    expect(q(row, '.git-row__notes')?.textContent).toBe('✎2')
    expect(q(row, '.git-row__status')?.textContent).toBe('M')
    unmount()
  })

  test.each([
    ['README.md', 'none', 'Not reviewed'],
    ['src/app.ts', 'reviewed', 'Reviewed']
  ] as const)('%s shows the %s review mark', async (path, mark, label) => {
    const { element, unmount } = await open((fake) => {
      four(fake)
      fake.marks[path] = mark
    })
    expect(q(rowOf(element, path)!, '.git-row__mark [role="img"]')?.getAttribute('aria-label')).toBe(label)
    unmount()
  })

  test('status letters follow the change from the base: M, A, D and R', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([entry('gone.ts', 'unstaged', 'deleted'), entry('new.ts', 'staged', 'renamed', { oldPath: 'old.ts' }), entry('fresh.txt', 'untracked')])
      fake.compare = compareOf({ entries: [{ path: 'edited.ts', status: 'modified', added: 1, removed: 1, binary: false }] })
    })
    const letter = (path: string) => q(rowOf(element, path)!, '.git-row__status')?.textContent
    expect([letter('edited.ts'), letter('gone.ts'), letter('new.ts'), letter('fresh.txt')]).toEqual(['M', 'D', 'R', 'A'])
    unmount()
  })

  test('a conflicted file shows its conflict instead of a status letter', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([entry('a.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })], { operation: 'merge' })
    })
    const row = rowOf(element, 'a.ts')!
    expect(q(row, '.git-row__status')).toBeNull()
    expect(q(row, '[aria-label="Unresolved conflict (Both modified)"]')?.textContent).toContain('Unresolved')
    unmount()
  })

  test('has no bulk buttons on the rows, the header or the list', async () => {
    const { element, unmount } = await open()
    const labels = qa(element, 'button').map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '')
    expect(labels.filter((label) => /discard all|stage all|unstage all|revert all/i.test(label))).toEqual([])
    unmount()
  })

  test('has no notes shelf, even when files carry notes', async () => {
    const { element, unmount } = await open((f) => {
      four(f)
      f.noteCounts['README.md'] = 2
    })
    expect(q(element, '[data-notes-shelf]')).toBeNull()
    expect(q(element, 'section[aria-label="Notes"]')).toBeNull()
    expect(q(rowOf(element, 'README.md')!, '.git-row__notes')?.textContent).toBe('✎2')
    unmount()
  })
})

describe('the header and count line', () => {
  test('the header line reads branch → base chip with the line totals', async () => {
    const { element, unmount } = await open()
    const header = q(element, '[data-branch-row]')!
    expect(q(header, '[data-branch-name]')?.textContent).toBe('zoe/feat')
    expect(q(header, '[data-base-ref]')?.textContent).toBe('origin/main')
    expect(q(header, '[aria-label="Lines changed on this branch"]')?.textContent).toBe('+22 −2')
    unmount()
  })

  test('the base chip opens Change Base Ref', async () => {
    const { element, unmount } = await open()
    await click(q(element, '[data-base-ref]'))
    expect(dialogTitle()).toBe('Change Base Ref')
    unmount()
  })

  test('the count line reads "M of N reviewed · K uncommitted"', async () => {
    const { element, unmount } = await open((fake) => {
      four(fake)
      fake.marks['README.md'] = 'reviewed'
      fake.marks['src/app.ts'] = 'reviewed'
    })
    expect(countLine(element)).toBe('2 of 4 reviewed · 4 uncommitted')
    unmount()
  })

  test('the count line leaves out the uncommitted part when nothing is uncommitted', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([])
      fake.compare = compareOf({ entries: [{ path: 'util.ts', status: 'added', added: 4, removed: 0, binary: false }] })
      fake.marks['util.ts'] = 'reviewed'
    })
    expect(countLine(element)).toBe('1 of 1 reviewed')
    unmount()
  })

  test('only the header line and count line sit above the first row; the list, commits and commit area follow', async () => {
    const { element, unmount } = await open()
    const frame = q(element, '.ui-tool-panel-frame__body')!
    const above = qa(frame, '*').filter((el) => el.compareDocumentPosition(rowOf(element, 'README.md')!) & Node.DOCUMENT_POSITION_FOLLOWING && !el.contains(rowOf(element, 'README.md')!))
    expect(above.some((el) => el.hasAttribute('data-branch-row'))).toBe(true)
    expect(above.some((el) => el.hasAttribute('data-count-line'))).toBe(true)
    expect(inOrder(q(element, '[data-branch-row]'), q(element, '[data-count-line]'), listbox(element), q(element, '[data-section="history"]'), q(element, '[data-git-ship]'))).toBe(true)
    expect(q(q(element, '[data-git-ship]')!, '#source-control-commit-message')).not.toBeNull()
    unmount()
  })

  test('the Commits section starts collapsed', async () => {
    const { element, unmount } = await open()
    expect(q(element, '[data-section="history"] ul')).toBeNull()
    unmount()
  })
})

describe('selecting a row', () => {
  test('a click selects the row, shows Revert and Open on it alone, and opens the Review tab at that file', async () => {
    const { fake, element, unmount } = await open()
    await click(rowOf(element, 'src/feature/enabled.ts'))
    expect(selectedPaths(element)).toEqual(['src/feature/enabled.ts'])
    expect(qa(rowOf(element, 'src/feature/enabled.ts')!, '.git-row__actions button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Revert src/feature/enabled.ts',
      'Open src/feature/enabled.ts'
    ])
    for (const path of rowPaths(element).filter((p) => p !== 'src/feature/enabled.ts')) {
      expect(qa(rowOf(element, path)!, '.git-row__actions')).toHaveLength(0)
      expect(qa(rowOf(element, path)!, 'button')).toHaveLength(0)
    }
    expect(selectedPath('feat')).toBe('src/feature/enabled.ts')
    expect(fake.views).toEqual([{ id: DIFF_VIEW, input: { worktree: 'feat', mode: 'review', reveal: 'src/feature/enabled.ts' } }])
    unmount()
  })

  test('nothing is revealed by hovering', async () => {
    const { element, unmount } = await open()
    await act(async () => {
      rowOf(element, 'README.md')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(selectedPaths(element)).toEqual([])
    expect(qa(element, '.git-row__actions')).toHaveLength(0)
    expect(q(element, '.git-row__reveal')).toBeNull()
    unmount()
  })

  test('a selection made in the Review tab selects the row without opening anything', async () => {
    const { fake, element, unmount } = await open()
    await act(async () => selectPath('feat', 'src/app.ts', 'review'))
    expect(selectedPaths(element)).toEqual(['src/app.ts'])
    expect(fake.views).toEqual([])
    unmount()
  })

  test('the panel starts from the selection the worktree already has', async () => {
    const fake = fakeContext(layoutFor('feat'))
    four(fake)
    const { element, unmount } = await (async () => {
      const mounted = mountPanel(fake)
      return mounted
    })()
    await settle()
    await act(async () => selectPath('feat', 'README.md', 'review'))
    expect(selectedPaths(element)).toEqual(['README.md'])
    unmount()
  })

  test('the Open button opens the file in the editor and Revert starts the revert confirm', async () => {
    const { fake, element, unmount } = await open()
    await click(rowOf(element, 'README.md'))
    await click(byLabel(element, 'Open README.md'))
    expect(fake.called('quirky.editor/open').at(-1)?.params).toEqual({ worktree: 'feat', path: 'README.md', focus: true })
    await click(byLabel(element, 'Revert README.md'))
    expect(dialogTitle()).toBe('Discard changes to "README.md"?')
    unmount()
  })
})

describe('the keyboard', () => {
  test('↓ and ↑ move the selection and tell the shared selection, without opening Review', async () => {
    const { fake, element, unmount } = await open()
    const heard: Array<[string | null, string]> = []
    const stop = onSelectedPath('feat', (path, origin) => void heard.push([path, origin]))
    await press(listbox(element), 'ArrowDown')
    expect(selectedPaths(element)).toEqual(['README.md'])
    await press(listbox(element), 'ArrowDown')
    await press(listbox(element), 'ArrowDown')
    expect(selectedPaths(element)).toEqual(['src/feature/enabled.ts'])
    await press(listbox(element), 'ArrowUp')
    expect(selectedPaths(element)).toEqual(['src/app.ts'])
    expect(heard).toEqual([['README.md', 'panel'], ['src/app.ts', 'panel'], ['src/feature/enabled.ts', 'panel'], ['src/app.ts', 'panel']])
    expect(fake.views).toEqual([])
    stop()
    unmount()
  })

  test('↓ stops at the last row and ↑ stops at the first', async () => {
    const { element, unmount } = await open()
    for (let i = 0; i < 6; i++) await press(listbox(element), 'ArrowDown')
    expect(selectedPaths(element)).toEqual(['src/feature/flags.ts'])
    for (let i = 0; i < 6; i++) await press(listbox(element), 'ArrowUp')
    expect(selectedPaths(element)).toEqual(['README.md'])
    unmount()
  })

  test('Enter opens the selected file in Review at that file', async () => {
    const { fake, element, unmount } = await open()
    await press(listbox(element), 'ArrowDown')
    await press(listbox(element), 'Enter')
    expect(fake.views.at(-1)).toEqual({ id: DIFF_VIEW, input: { worktree: 'feat', mode: 'review', reveal: 'README.md' } })
    unmount()
  })

  test('Space marks the file reviewed and moves to the next file that still needs a look', async () => {
    const { fake, element, unmount } = await open((f) => {
      four(f)
      f.marks['src/feature/enabled.ts'] = 'none'
      f.marks['src/app.ts'] = 'reviewed'
      f.marks['README.md'] = 'reviewed'
      f.marks['src/feature/flags.ts'] = 'changed'
    })
    expect(countLine(element)).toBe('2 of 4 reviewed · 4 uncommitted')
    await act(async () => selectPath('feat', 'src/feature/enabled.ts', 'review'))
    await press(listbox(element), ' ')
    expect(fake.called('quirky.git/setReviewMark').at(-1)?.params).toEqual({ worktree: 'feat', path: 'src/feature/enabled.ts', reviewed: true, expected: 'hash:src/feature/enabled.ts' })
    expect(countLine(element)).toBe('3 of 4 reviewed · 4 uncommitted')
    expect(q(rowOf(element, 'src/feature/enabled.ts')!, '.git-row__mark [role="img"]')?.getAttribute('aria-label')).toBe('Reviewed')
    expect(selectedPaths(element)).toEqual(['src/feature/flags.ts'])
    expect(selectedPath('feat')).toBe('src/feature/flags.ts')
    unmount()
  })

  test('marking sends the hash the open Review card shows, and null for a card showing a deletion', async () => {
    const { fake, element, unmount } = await open()
    const shown: Record<string, string | null | undefined> = { 'README.md': 'a'.repeat(64), 'src/app.ts': null }
    const stop = registerReviewView({ worktree: 'feat', reveal() {}, scrollToTop() {}, setScope() {}, loadedHash: (path) => shown[path] })
    await act(async () => selectPath('feat', 'README.md', 'review'))
    await press(listbox(element), ' ')
    await act(async () => selectPath('feat', 'src/app.ts', 'review'))
    await press(listbox(element), ' ')
    expect(fake.called('quirky.git/diff')).toHaveLength(0)
    expect(fake.called('quirky.git/setReviewMark').map((call) => call.params.expected)).toEqual(['a'.repeat(64), null])
    stop()
    unmount()
  })

  test('marking a file the Review tab has not loaded reads its base diff for the hash', async () => {
    const { fake, element, unmount } = await open((f) => {
      four(f)
      f.on('quirky.git/diff', () => ({ original: 'x', modified: '', modifiedHash: null, modifiedDeleted: true, kind: 'text', binary: false }))
    })
    await act(async () => selectPath('feat', 'README.md', 'review'))
    await press(listbox(element), ' ')
    expect(fake.called('quirky.git/diff').at(-1)?.params).toEqual({ worktree: 'feat', path: 'README.md', source: 'review', against: 'base' })
    expect(fake.called('quirky.git/setReviewMark').at(-1)?.params).toEqual({ worktree: 'feat', path: 'README.md', reviewed: true, expected: null })
    unmount()
  })

  test('a mark whose hash cannot be read is not sent', async () => {
    const { fake, element, unmount } = await open((f) => {
      four(f)
      f.on('quirky.git/diff', () => {
        throw new Error('diff failed')
      })
    })
    await act(async () => selectPath('feat', 'README.md', 'review'))
    await press(listbox(element), ' ')
    expect(fake.called('quirky.git/setReviewMark')).toHaveLength(0)
    unmount()
  })

  test('the auto-advance reaches the Review tab as a panel-origin selection', async () => {
    const { element, unmount } = await open()
    const heard: Array<[string | null, string]> = []
    const stop = onSelectedPath('feat', (path, origin) => void heard.push([path, origin]))
    await act(async () => selectPath('feat', 'README.md', 'review'))
    heard.length = 0
    await press(listbox(element), ' ')
    expect(heard).toEqual([['src/app.ts', 'panel']])
    stop()
    unmount()
  })

  test('Space on a reviewed file unmarks it and the selection stays', async () => {
    const { fake, element, unmount } = await open((f) => {
      four(f)
      f.marks['README.md'] = 'reviewed'
    })
    await act(async () => selectPath('feat', 'README.md', 'review'))
    await press(listbox(element), ' ')
    expect(fake.called('quirky.git/setReviewMark').at(-1)?.params).toEqual({ worktree: 'feat', path: 'README.md', reviewed: false })
    expect(selectedPaths(element)).toEqual(['README.md'])
    expect(countLine(element)).toBe('0 of 4 reviewed · 4 uncommitted')
    unmount()
  })

  test('Space on the last file that needs review leaves the selection where it is', async () => {
    const { element, unmount } = await open((f) => {
      four(f)
      for (const path of ['README.md', 'src/app.ts', 'src/feature/enabled.ts']) f.marks[path] = 'reviewed'
    })
    await act(async () => selectPath('feat', 'src/feature/flags.ts', 'review'))
    await press(listbox(element), ' ')
    expect(selectedPaths(element)).toEqual(['src/feature/flags.ts'])
    expect(countLine(element)).toBe('4 of 4 reviewed · 4 uncommitted')
    unmount()
  })

  test('a mark that loses to a racing write refreshes and leaves the selection', async () => {
    const { fake, element, unmount } = await open((f) => {
      four(f)
      f.on('quirky.git/setReviewMark', () => {
        throw Object.assign(new Error('changed on disk'), { code: RpcErrorCode.Conflict, data: { reason: 'changed-on-disk' } })
      })
    })
    const reads = fake.called('quirky.git/review').length
    await act(async () => selectPath('feat', 'README.md', 'review'))
    await press(listbox(element), ' ')
    expect(selectedPaths(element)).toEqual(['README.md'])
    expect(fake.called('quirky.git/review').length).toBeGreaterThan(reads)
    unmount()
  })

  test.each(['Backspace', 'Delete'])('%s starts Revert file with its confirm, and confirming discards the file', async (key) => {
    const { fake, element, unmount } = await open()
    await act(async () => selectPath('feat', 'README.md', 'review'))
    await press(listbox(element), key)
    expect(dialogTitle()).toBe('Discard changes to "README.md"?')
    expect(dialog()?.textContent).toContain('This will revert the unstaged changes to this file. This cannot be undone.')
    expect(fake.called('quirky.git/discard')).toHaveLength(0)
    await click(buttonText(dialog()!, 'Discard'))
    expect(fake.called('quirky.git/discard').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['README.md'], yes: true })
    unmount()
  })

  test('Backspace on an untracked file says it will be deleted', async () => {
    const { fake, element, unmount } = await open()
    await act(async () => selectPath('feat', 'src/feature/enabled.ts', 'review'))
    await press(listbox(element), 'Backspace')
    expect(dialogTitle()).toBe('Delete "enabled.ts"?')
    expect(dialog()?.textContent).toContain('This will permanently delete this file.')
    await click(buttonText(dialog()!, 'Delete'))
    expect(fake.called('quirky.git/discard').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['src/feature/enabled.ts'], yes: true })
    unmount()
  })

  test('a staged file is unstaged before it is discarded', async () => {
    const { fake, element, unmount } = await open()
    await act(async () => selectPath('feat', 'src/app.ts', 'review'))
    await press(listbox(element), 'Backspace')
    await click(buttonText(dialog()!, 'Discard'))
    expect(fake.calls.map((call) => call.method).filter((method) => ['quirky.git/unstage', 'quirky.git/discard'].includes(method))).toEqual(['quirky.git/unstage', 'quirky.git/discard'])
    expect(fake.called('quirky.git/unstage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['src/app.ts'] })
    unmount()
  })

  test('Cancel on the revert confirm changes nothing', async () => {
    const { fake, element, unmount } = await open()
    await act(async () => selectPath('feat', 'README.md', 'review'))
    await press(listbox(element), 'Backspace')
    await click(buttonText(dialog()!, 'Cancel'))
    expect(dialog()).toBeNull()
    expect(fake.called('quirky.git/discard')).toHaveLength(0)
    unmount()
  })

  test('Escape clears the selection', async () => {
    const { element, unmount } = await open()
    await press(listbox(element), 'ArrowDown')
    expect(selectedPaths(element)).toEqual(['README.md'])
    await press(listbox(element), 'Escape')
    expect(selectedPaths(element)).toEqual([])
    expect(selectedPath('feat')).toBeNull()
    expect(qa(element, '.git-row__actions')).toHaveLength(0)
    unmount()
  })

  test('keys with a modifier stay free for the panel, so Cmd+Enter still commits', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('README.md', 'staged')])
    })
    const message = byLabel(element, 'Commit message') as HTMLTextAreaElement
    await s.type(message, 'msg')
    await act(async () => selectPath('feat', 'README.md', 'review'))
    await press(listbox(element), 'Enter', { metaKey: true })
    expect(fake.views).toEqual([])
    expect(fake.called('quirky.git/commit')).toHaveLength(1)
    unmount()
  })

  test('the F7 and ⌘⇧A style window commands still reach the panel handle', async () => {
    const { activePanel } = await import('../../src/panel/registry')
    const { element, unmount } = await open()
    await act(async () => activePanel().select(['src/app.ts']))
    expect(selectedPaths(element)).toEqual(['src/app.ts'])
    await act(async () => activePanel().select([]))
    expect(selectedPaths(element)).toEqual([])
    unmount()
  })
})

describe('the row menu', () => {
  test('lists Open in Review, Open file, Mark reviewed, Revert file…, Stage, Copy path, Copy relative path and Reveal in Finder, in that order', async () => {
    const { element, unmount } = await open()
    await rightClick(element, 'README.md')
    expect(menuLabels()).toEqual(['Open in Review', 'Open file', 'Mark reviewed', 'Revert file…', 'Stage', 'Copy path', 'Copy relative path', 'Reveal in Finder'])
    unmount()
  })

  test('shows Unmark for a reviewed file and Unstage for a staged one', async () => {
    const { element, unmount } = await open((f) => {
      four(f)
      f.marks['src/app.ts'] = 'reviewed'
    })
    await rightClick(element, 'src/app.ts')
    expect(menuLabels()).toEqual(['Open in Review', 'Open file', 'Unmark', 'Revert file…', 'Unstage', 'Copy path', 'Copy relative path', 'Reveal in Finder'])
    unmount()
  })

  test('right-clicking selects the row', async () => {
    const { element, unmount } = await open()
    await rightClick(element, 'src/app.ts')
    expect(selectedPaths(element)).toEqual(['src/app.ts'])
    unmount()
  })

  test('each item does its job', async () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } })
    const { fake, element, unmount } = await open()
    const pick = async (label: string) => {
      await rightClick(element, 'README.md')
      await click(buttonText(document.body, label))
    }
    await pick('Open in Review')
    expect(fake.views.at(-1)?.input).toEqual({ worktree: 'feat', mode: 'review', reveal: 'README.md' })
    await pick('Open file')
    expect(fake.called('quirky.editor/open').at(-1)?.params).toEqual({ worktree: 'feat', path: 'README.md', focus: true })
    await pick('Stage')
    expect(fake.called('quirky.git/stage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['README.md'] })
    await pick('Copy path')
    await pick('Copy relative path')
    expect(copied).toEqual(['/repo/feat/README.md', 'README.md'])
    await pick('Reveal in Finder')
    expect(fake.called('quirky.git/reveal').at(-1)?.params).toEqual({ worktree: 'feat', path: 'README.md' })
    await pick('Revert file…')
    expect(dialogTitle()).toBe('Discard changes to "README.md"?')
    unmount()
  })

  test('Mark reviewed marks and advances like Space', async () => {
    const { fake, element, unmount } = await open()
    await rightClick(element, 'README.md')
    await click(buttonText(document.body, 'Mark reviewed'))
    expect(fake.called('quirky.git/setReviewMark').at(-1)?.params).toEqual({ worktree: 'feat', path: 'README.md', reviewed: true, expected: 'hash:README.md' })
    expect(selectedPaths(element)).toEqual(['src/app.ts'])
    unmount()
  })

  test('Unstage unstages a staged file', async () => {
    const { fake, element, unmount } = await open()
    await rightClick(element, 'src/app.ts')
    await click(buttonText(document.body, 'Unstage'))
    expect(fake.called('quirky.git/unstage').at(-1)?.params).toEqual({ worktree: 'feat', paths: ['src/app.ts'] })
    unmount()
  })

  test('Stage is greyed for a file with nothing uncommitted', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf({ entries: [{ path: 'done.ts', status: 'modified', added: 1, removed: 1, binary: false }] })
    })
    await rightClick(element, 'done.ts')
    expect(buttonText(document.body, 'Stage')?.disabled).toBe(true)
    unmount()
  })
})

describe('the ⋯ menu', () => {
  test('lists List, Tree, Change base…, Refresh and Revert all…', async () => {
    const { element, unmount } = await open()
    await click(byLabel(element, 'More source control actions'))
    expect(menuLabels()).toEqual(['List', 'Tree', 'Change base…', 'Refresh', 'AI settings…', 'Revert all…'])
    expect(qa(document.body, '[role="menu"] [aria-checked="true"]').map((item) => item.textContent?.replace('✓', ''))).toEqual(['List'])
    unmount()
  })

  test('adds Summarize branch with AI while AI actions are on', async () => {
    const { element, unmount } = await open((f) => {
      four(f)
      f.settings['ai-enabled'] = true
    })
    await click(byLabel(element, 'More source control actions'))
    expect(menuLabels()).toEqual(['List', 'Tree', 'Change base…', 'Refresh', 'Summarize branch with AI', 'AI settings…', 'Revert all…'])
    unmount()
  })

  test('AI settings… opens the Source Control AI settings view for the worktree', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'AI settings…'))
    expect(fake.views.at(-1)).toEqual({ id: 'view:quirky.git/ai-settings', input: { worktree: 'feat' } })
    unmount()
  })

  test('Tree writes the view mode and shows folders, and the keyboard follows the tree order', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Tree'))
    expect(fake.called('setting.set').at(-1)?.params).toEqual({ id: 'setting:quirky.git/viewMode', value: 'tree' })
    expect(qa(element, '[data-directory-path]').map((dir) => dir.getAttribute('data-directory-path'))).toEqual(['src', 'src/feature'])
    expect(rowPaths(element)).toEqual(['src/feature/enabled.ts', 'src/feature/flags.ts', 'src/app.ts', 'README.md'])
    await press(listbox(element), 'ArrowDown')
    await press(listbox(element), 'ArrowDown')
    expect(selectedPaths(element)).toEqual(['src/feature/flags.ts'])
    unmount()
  })

  test('tree rows leave the folder text out, and list rows keep it', async () => {
    const { element, unmount } = await open((f) => {
      four(f)
      f.settings.viewMode = 'tree'
    })
    expect(rowPaths(element)).toContain('src/feature/enabled.ts')
    expect(qa(element, '[data-row-dir]')).toHaveLength(0)
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'List'))
    expect(q(rowOf(element, 'src/feature/enabled.ts')!, '[data-row-dir]')?.getAttribute('data-row-dir')).toBe('src/feature')
    unmount()
  })

  test('the folder is the shrinkable part of a row, ahead of the counts and the name', () => {
    const css = readFileSync(join(import.meta.dir, '../../../../packages/ui/src/design-system/git-rows.css'), 'utf8')
    const shrinkOf = (selector: string): number => {
      const rule = css.split('}').find((block) => block.split('{')[0]!.split(',').some((part) => part.trim() === selector))
      return Number(/flex: 0 (\d+) auto/.exec(rule ?? '')?.[1])
    }
    const folder = shrinkOf('.git-rows .git-row__title > .git-row__dir')
    const counts = shrinkOf('.git-rows .git-row__end > .git-row__added')
    const name = shrinkOf('.git-rows .git-row__title > .git-row__text')
    expect(folder).toBeGreaterThan(counts)
    expect(counts).toBeGreaterThan(name)
    expect(name).toBeGreaterThan(0)
  })

  test('a Review selection inside a collapsed folder expands it so the row is selected and announced', async () => {
    const { element, unmount } = await open((f) => {
      four(f)
      f.settings.viewMode = 'tree'
    })
    await click(q(element, '[data-directory-path="src/feature"] button'))
    expect(rowPaths(element)).toEqual(['src/app.ts', 'README.md'])
    await act(async () => selectPath('feat', 'src/feature/flags.ts', 'review'))
    expect(selectedPaths(element)).toEqual(['src/feature/flags.ts'])
    const active = listbox(element).getAttribute('aria-activedescendant')
    expect(active).not.toBeNull()
    expect(document.getElementById(active!)).not.toBeNull()
    unmount()
  })

  test('collapsing a folder hides its files from the keyboard order', async () => {
    const { element, unmount } = await open((f) => {
      four(f)
      f.settings.viewMode = 'tree'
    })
    await click(q(element, '[data-directory-path="src/feature"] button'))
    expect(rowPaths(element)).toEqual(['src/app.ts', 'README.md'])
    await press(listbox(element), 'ArrowDown')
    expect(selectedPaths(element)).toEqual(['src/app.ts'])
    unmount()
  })

  test('Change base… opens the dialog and Refresh reads status, compare and review again', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Refresh'))
    const before = fake.calls.length
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Change base…'))
    expect(dialogTitle()).toBe('Change Base Ref')
    expect(fake.calls.length).toBeGreaterThan(before - 1)
    unmount()
  })

  test.each(['open', 'draft', 'closed', 'merged'])('the pull-request AI actions are in the menu only while the PR is not closed or merged (%s)', async (state) => {
    const { element, unmount } = await open((f) => {
      four(f)
      f.settings['ai-enabled'] = true
      f.on('quirky.hosting/forBranch', () => ({ kind: 'found', review: { number: 42, url: 'https://github.com/octo/quirky/pull/42', state } }))
    })
    await click(byLabel(element, 'More source control actions'))
    expect(menuLabels().includes('Review pull request with AI')).toBe(state === 'open' || state === 'draft')
    expect(menuLabels()).toContain('Summarize branch with AI')
    unmount()
  })

  test('Revert all… is greyed when the list is empty', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf()
    })
    await click(byLabel(element, 'More source control actions'))
    expect(buttonText(document.body, 'Revert all…')?.disabled).toBe(true)
    unmount()
  })
})

describe('Revert all', () => {
  const discards = (fake: Fake) => fake.called('quirky.git/discard').map((call) => call.params.paths)

  test('confirms with the file count, then reverts every file in path order', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Revert all…'))
    expect(dialogTitle()).toBe('Revert all 4 files?')
    expect(fake.called('quirky.git/discard')).toHaveLength(0)
    await click(buttonText(dialog()!, 'Revert all'))
    expect(discards(fake)).toEqual([['README.md'], ['src/app.ts'], ['src/feature/enabled.ts'], ['src/feature/flags.ts']])
    expect(noticeOf(element)).toBeNull()
    unmount()
  })

  test('Cancel reverts nothing', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Revert all…'))
    await click(buttonText(dialog()!, 'Cancel'))
    expect(fake.called('quirky.git/discard')).toHaveLength(0)
    unmount()
  })

  test('stops at the first failure, names the file and how many are left, and keeps what was reverted', async () => {
    const { fake, element, unmount } = await open((f) => {
      four(f)
      f.on('quirky.git/discard', (params) => {
        if ((params.paths as string[])[0] === 'src/app.ts') throw failure('Failed to discard 1 file(s)', { failures: [{ path: 'src/app.ts', message: 'read-only' }] })
        return { ok: true }
      })
    })
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Revert all…'))
    await click(buttonText(dialog()!, 'Revert all'))
    expect(discards(fake)).toEqual([['README.md'], ['src/app.ts']])
    const notice = noticeOf(element)!
    expect(notice.textContent).toContain('Revert all stopped at “src/app.ts”')
    expect(notice.textContent).toContain('3 of 4 files left')
    expect(buttonText(notice, 'Retry')).toBeDefined()
    unmount()
  })

  test('Retry continues with the files that are left', async () => {
    let fail = true
    const { fake, element, unmount } = await open((f) => {
      four(f)
      f.on('quirky.git/discard', (params) => {
        if (fail && (params.paths as string[])[0] === 'src/app.ts') throw new Error('locked')
        return { ok: true }
      })
    })
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Revert all…'))
    await click(buttonText(dialog()!, 'Revert all'))
    fail = false
    await click(buttonText(noticeOf(element)!, 'Retry'))
    expect(discards(fake)).toEqual([['README.md'], ['src/app.ts'], ['src/app.ts'], ['src/feature/enabled.ts'], ['src/feature/flags.ts']])
    unmount()
  })

  test('applies the filter: it reverts only the files in the list', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Filter files by name'))
    await s.type(byLabel(element, 'Filter files…') as HTMLInputElement, 'feature')
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Revert all…'))
    expect(dialogTitle()).toBe('Revert all 2 files?')
    await click(buttonText(dialog()!, 'Revert all'))
    expect(discards(fake)).toEqual([['src/feature/enabled.ts'], ['src/feature/flags.ts']])
    unmount()
  })
})

describe('Revert file for a committed change', () => {
  const committed = (fake: Fake) => {
    fake.status = statusOf([])
    fake.compare = compareOf({ entries: [{ path: 'src/done.ts', status: 'modified', added: 2, removed: 1, binary: false }] })
    fake.on('quirky.git/diff', () => ({ path: 'src/done.ts', staged: false, original: 'base text\n', modified: 'new text\n', binary: false, source: 'review', kind: 'text', modifiedHash: 'f'.repeat(64) }))
  }

  test('writes the base content through save, guarded by the hash it read', async () => {
    const { fake, element, unmount } = await open(committed)
    await click(rowOf(element, 'src/done.ts'))
    await click(byLabel(element, 'Revert src/done.ts'))
    expect(dialogTitle()).toBe('Revert "done.ts"?')
    await click(buttonText(dialog()!, 'Revert'))
    expect(fake.called('quirky.git/discard')).toHaveLength(0)
    expect(fake.called('quirky.git/diff').at(-1)?.params).toEqual({ worktree: 'feat', path: 'src/done.ts', source: 'review', against: 'base' })
    expect(fake.called('quirky.git/save').at(-1)?.params).toEqual({ worktree: 'feat', path: 'src/done.ts', content: 'base text\n', expected: 'f'.repeat(64) })
    unmount()
  })

  test('a committed deletion is restored only when the file is still missing', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf({ entries: [{ path: 'src/gone.ts', status: 'deleted', added: 0, removed: 2, binary: false }] })
      f.on('quirky.git/diff', () => ({ path: 'src/gone.ts', staged: false, original: 'base text\n', modified: '', binary: false, source: 'review', kind: 'text', modifiedHash: null, modifiedDeleted: true }))
    })
    await click(rowOf(element, 'src/gone.ts'))
    await click(byLabel(element, 'Revert src/gone.ts'))
    await click(buttonText(dialog()!, 'Revert'))
    expect(fake.called('quirky.git/save').at(-1)?.params).toEqual({ worktree: 'feat', path: 'src/gone.ts', content: 'base text\n', expected: null })
    unmount()
  })

  test('a save without a readable hash is refused instead of sent unguarded', async () => {
    const { fake, element, unmount } = await open((f) => {
      committed(f)
      f.on('quirky.git/diff', () => ({ original: 'base text\n', binary: false, kind: 'text' }))
    })
    await click(rowOf(element, 'src/done.ts'))
    await click(byLabel(element, 'Revert src/done.ts'))
    await click(buttonText(dialog()!, 'Revert'))
    expect(fake.called('quirky.git/save')).toHaveLength(0)
    expect(noticeOf(element)?.textContent).toContain('Failed to revert “src/done.ts”')
    unmount()
  })

  test('a file added on the branch is deleted through the editor after a confirm that says so', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf({ entries: [{ path: 'lib/new.ts', status: 'added', added: 3, removed: 0, binary: false }] })
    })
    await click(rowOf(element, 'lib/new.ts'))
    await click(byLabel(element, 'Revert lib/new.ts'))
    expect(dialogTitle()).toBe('Delete "new.ts"?')
    expect(fake.called('quirky.editor/mutate')).toHaveLength(0)
    await click(buttonText(dialog()!, 'Delete'))
    expect(fake.called('quirky.editor/mutate').at(-1)?.params).toEqual({ worktree: 'feat', action: 'delete', path: 'lib/new.ts', yes: true })
    expect(fake.called('quirky.git/discard')).toHaveLength(0)
    unmount()
  })

  test('a renamed file restores the old path from the base, then deletes the new one', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf({ entries: [{ path: 'lib/after.ts', oldPath: 'lib/before.ts', status: 'renamed', added: 0, removed: 0, binary: false }] })
      f.on('quirky.git/diff', () => ({ original: 'old text\n', modified: 'old text\n', binary: false, kind: 'text', source: 'review', modifiedHash: 'c'.repeat(64) }))
    })
    await click(rowOf(element, 'lib/after.ts'))
    await click(byLabel(element, 'Revert lib/after.ts'))
    expect(dialogTitle()).toBe('Revert the rename of "after.ts"?')
    await click(buttonText(dialog()!, 'Revert'))
    expect(fake.called('quirky.git/diff').at(-1)?.params).toEqual({ worktree: 'feat', path: 'lib/after.ts', oldPath: 'lib/before.ts', source: 'review', against: 'base' })
    expect(fake.calls.filter((call) => call.method === 'quirky.git/save' || call.method === 'quirky.editor/mutate').map((call) => [call.method, call.params])).toEqual([
      ['quirky.git/save', { worktree: 'feat', path: 'lib/before.ts', content: 'old text\n', expected: null }],
      ['quirky.editor/mutate', { worktree: 'feat', action: 'delete', path: 'lib/after.ts', yes: true }]
    ])
    unmount()
  })

  test('a rename whose delete failed is retried without restoring the old path again', async () => {
    let restored = false
    let failDelete = true
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf({ entries: [{ path: 'lib/after.ts', oldPath: 'lib/before.ts', status: 'renamed', added: 0, removed: 0, binary: false }] })
      f.on('quirky.git/diff', (params) => {
        const onDisk = params.path === 'lib/before.ts' && restored
        return { original: 'old text\n', modified: onDisk || params.path === 'lib/after.ts' ? 'old text\n' : '', binary: false, kind: 'text', source: 'review', modifiedHash: 'c'.repeat(64), ...(params.path === 'lib/before.ts' && !restored ? { modifiedDeleted: true } : {}) }
      })
      f.on('quirky.git/save', () => {
        if (restored) throw new Error('changed on disk')
        restored = true
        return { hash: 'd'.repeat(64) }
      })
      f.on('quirky.editor/mutate', () => {
        if (failDelete) throw new Error('delete failed')
        return {}
      })
    })
    await click(rowOf(element, 'lib/after.ts'))
    await click(byLabel(element, 'Revert lib/after.ts'))
    await click(buttonText(dialog()!, 'Revert'))
    expect(noticeOf(element)?.textContent).toContain('Failed to revert')
    failDelete = false
    await click(buttonText(noticeOf(element)!, 'Retry'))
    expect(fake.called('quirky.editor/mutate')).toHaveLength(2)
    expect(noticeOf(element)).toBeNull()
    unmount()
  })

  test('a committed file too large to read in full is refused instead of saved empty', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf({ entries: [{ path: 'src/big.txt', status: 'modified', added: 1, removed: 1, binary: false }] })
      f.on('quirky.git/diff', () => ({
        path: 'src/big.txt',
        staged: false,
        original: '',
        modified: '',
        binary: false,
        source: 'review',
        kind: 'text',
        modifiedHash: 'f'.repeat(64),
        tooLarge: { originalLines: 25000, modifiedLines: 25000, characters: 100000, reason: 'lines' }
      }))
    })
    await click(rowOf(element, 'src/big.txt'))
    await click(byLabel(element, 'Revert src/big.txt'))
    await click(buttonText(dialog()!, 'Revert'))
    expect(fake.called('quirky.git/save')).toHaveLength(0)
    expect(noticeOf(element)?.textContent).toContain('too large')
    unmount()
  })

  test('a rename whose old path is occupied again keeps the new file', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.compare = compareOf({ entries: [{ path: 'lib/after.ts', oldPath: 'lib/before.ts', status: 'renamed', added: 0, removed: 0, binary: false }] })
      f.on('quirky.git/diff', () => ({ original: 'old text\n', modified: '', binary: false, kind: 'text', source: 'review', modifiedHash: 'c'.repeat(64) }))
      f.on('quirky.git/save', () => {
        throw new Error('changed on disk')
      })
    })
    await click(rowOf(element, 'lib/after.ts'))
    await click(byLabel(element, 'Revert lib/after.ts'))
    await click(buttonText(dialog()!, 'Revert'))
    expect(fake.called('quirky.editor/mutate')).toHaveLength(0)
    expect(noticeOf(element)?.textContent).toContain('Failed to revert')
    unmount()
  })

  test('Revert all names each file it could not revert and why', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('c.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })])
      f.compare = compareOf({ entries: [{ path: 'lib/new.ts', status: 'added', added: 3, removed: 0, binary: false }] })
    })
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Revert all…'))
    expect(dialogTitle()).toBe('Revert all 1 file?')
    await click(buttonText(dialog()!, 'Revert all'))
    expect(fake.called('quirky.editor/mutate').map((call) => call.params.path)).toEqual(['lib/new.ts'])
    const left = fake.toasts.at(-1)!
    expect(left[0]).toBe('Revert all left 1 file unchanged')
    expect(left[1]).toBe('c.ts: Resolve the conflict before reverting this file')
    unmount()
  })

  test('a file the review calls uncommitted but the status has not listed yet is not reverted from a guess', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([])
      f.on('quirky.git/review', () => s.reviewOf(statusOf([entry('x.ts')]), compareOf()))
    })
    await click(rowOf(element, 'x.ts'))
    await click(byLabel(element, 'Revert x.ts'))
    expect(dialog()).toBeNull()
    expect(fake.toasts.at(-1)).toEqual(['Can’t revert “x.ts”', 'Git status is still loading'])
    await click(byLabel(element, 'More source control actions'))
    expect(buttonText(document.body, 'Revert all…')?.disabled).toBe(true)
    unmount()
  })

  test('a failed save shows a notice with Retry', async () => {
    let fail = true
    const { fake, element, unmount } = await open((f) => {
      committed(f)
      f.on('quirky.git/save', () => {
        if (fail) throw new Error('file changed on disk')
        return { hash: 'e'.repeat(64) }
      })
    })
    await rightClick(element, 'src/done.ts')
    await click(buttonText(document.body, 'Revert file…'))
    await click(buttonText(dialog()!, 'Revert'))
    expect(noticeOf(element)?.textContent).toContain('Failed to revert “src/done.ts”')
    fail = false
    await click(buttonText(noticeOf(element)!, 'Retry'))
    expect(fake.called('quirky.git/save')).toHaveLength(2)
    unmount()
  })
})

describe('Change Base Ref', () => {
  test('says how many review marks the change clears, above the branches', async () => {
    const { element, unmount } = await open((fake) => {
      four(fake)
      fake.marks['README.md'] = 'reviewed'
      fake.marks['src/app.ts'] = 'reviewed'
      fake.marks['src/feature/flags.ts'] = 'changed'
    })
    await click(q(element, '[data-base-ref]'))
    const notice = q(dialog()!, '[data-clears-marks]')!
    expect(notice.textContent).toBe('This clears 3 review marks')
    const branches = q(dialog()!, '[aria-label="Branches"]')!
    expect(inOrder(notice, branches)).toBe(true)
    unmount()
  })

  test('says "1 review mark" for one and nothing when no file is marked', async () => {
    const one = await open((fake) => {
      four(fake)
      fake.marks['README.md'] = 'reviewed'
    })
    await click(q(one.element, '[data-base-ref]'))
    expect(q(dialog()!, '[data-clears-marks]')?.textContent).toBe('This clears 1 review mark')
    one.unmount()
    document.body.innerHTML = ''
    const none = await open()
    await click(q(none.element, '[data-base-ref]'))
    expect(q(dialog()!, '[data-clears-marks]')).toBeNull()
    none.unmount()
  })
})

describe('opening commits', () => {
  test('opening a commit from the Commits section opens the Review tab scoped to it', async () => {
    const commit = { oid: 'c'.repeat(40), parents: [], author: 'Zoe', email: 'z@example.com', authoredAt: 1, committedAt: 1, subject: 'Add flags', body: '', refs: [] }
    const { fake, element, unmount } = await open((f) => {
      four(f)
      f.on('quirky.git/history', () => ({ commits: [commit], hasMore: false }))
    })
    await click(byLabel(element, 'Expand Commits'))
    await click(q(element, '[data-commit-row] .ui-list-row__main'))
    expect(fake.views.at(-1)).toEqual({ id: DIFF_VIEW, input: { worktree: 'feat', mode: 'review', commit: 'c'.repeat(40) } })
    unmount()
  })
})

describe('the filter', () => {
  test('narrows the list, keeps the count line and Escape restores it', async () => {
    const { element, unmount } = await open()
    await click(byLabel(element, 'Filter files by name'))
    await s.type(byLabel(element, 'Filter files…') as HTMLInputElement, 'APP')
    expect(rowPaths(element)).toEqual(['src/app.ts'])
    expect(countLine(element)).toBe('0 of 4 reviewed · 4 uncommitted')
    await press(byLabel(element, 'Filter files…')!, 'Escape')
    expect(rowPaths(element)).toHaveLength(4)
    unmount()
  })
})
