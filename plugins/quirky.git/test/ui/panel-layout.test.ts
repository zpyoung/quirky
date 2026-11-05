import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, DIFF_VIEW, entry, fakeContext, layoutFor, listboxOf, mountPanel, press, q, qa, rowOf, rowPaths, settle, statusOf, type } = s

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

const dialog = () => q(document.body, '[role="dialog"]')

describe('SC-8: the panel layout', () => {
  test('lists every file once in path order, then the collapsed Commits dock, with no section headings', async () => {
    const { element, unmount } = await open()
    expect(rowPaths(element)).toEqual(['README.md', 'math.ts', 'new.ts', 'notes.txt', 'src/math.ts', 'util.ts'])
    expect(qa(element, '[data-section]').map((section) => section.getAttribute('data-section'))).toEqual(['history'])
    expect(q(element, '[data-section="history"] ul')).toBeNull()
    unmount()
  })

  test('puts the filter toggle and the more-actions menu in the frame header, with one title', async () => {
    const { element, unmount } = await open()
    const filter = byLabel(element, 'Filter files by name')
    const more = byLabel(element, 'More source control actions')
    expect(filter?.closest('.ui-tool-panel-frame__header .ui-tool-panel-frame__actions')).not.toBeNull()
    expect(more?.closest('.ui-tool-panel-frame__header .ui-tool-panel-frame__actions')).not.toBeNull()
    expect(qa(element, 'h2').filter((h) => h.textContent === 'Source control')).toHaveLength(1)
    unmount()
  })

  test('keeps the filter field in the body and the toggle works from the header', async () => {
    const { element, unmount } = await open()
    await click(byLabel(element, 'Filter files by name'))
    const field = byLabel(element, 'Filter files…')
    expect(field?.closest('.ui-tool-panel-frame__body')).not.toBeNull()
    await click(byLabel(element, 'Clear and close filter'))
    expect(byLabel(element, 'Filter files…')).toBeNull()
    unmount()
  })

  test('right-aligns the source control actions menu with its trigger near the window edge', async () => {
    const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const boundsDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
    const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    let trigger: HTMLElement | null = null
    let triggerBoundsDescriptor: PropertyDescriptor | undefined
    let unmount: (() => void) | undefined
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: function (this: HTMLElement) {
          if (this.classList.contains('qt-menu')) {
            return new DOMRect(0, 0, 320, 200)
          }
          return getBoundingClientRect.call(this)
        }
      })
      const mounted = await open()
      unmount = mounted.unmount
      trigger = byLabel(mounted.element, 'More source control actions')
      expect(trigger).not.toBeNull()
      triggerBoundsDescriptor = Object.getOwnPropertyDescriptor(trigger!, 'getBoundingClientRect')
      Object.defineProperty(trigger!, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(1220, 80, 20, 20)
      })
      await click(trigger)

      const anchor = q(document.body, '.qt-menu-anchor')!
      const left = Number.parseFloat(anchor.style.left)
      expect(left + 320).toBe(1240)
      expect(left + 320).toBeLessThanOrEqual(window.innerWidth)
    } finally {
      if (trigger) {
        if (triggerBoundsDescriptor) Object.defineProperty(trigger, 'getBoundingClientRect', triggerBoundsDescriptor)
        else Reflect.deleteProperty(trigger, 'getBoundingClientRect')
      }
      unmount?.()
      if (innerWidthDescriptor) Object.defineProperty(window, 'innerWidth', innerWidthDescriptor)
      else Reflect.deleteProperty(window, 'innerWidth')
      if (boundsDescriptor) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', boundsDescriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
    }
  })

  test('the header line reads <branch> → <base> with the line totals', async () => {
    const { element, unmount } = await open()
    const row = q(element, '[data-branch-row]')!
    expect(q(row, '[data-branch-name]')?.textContent).toBe('zoe/feat')
    expect(q(row, '[data-base-ref]')?.textContent).toBe('origin/main')
    expect(q(row, '[aria-label*="to pull"]')).toBeNull()
    expect(q(row, '[aria-label="Lines changed on this branch"]')?.textContent).toBe('+52 −3')
    unmount()
  })

  test('rows show the filename, parent directory and nonzero change counts', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([entry('src/app/math.ts', 'unstaged', 'modified', { added: 5, removed: 0 })])
    })
    const row = rowOf(element, 'src/app/math.ts')!
    expect(q(row, '[data-row-name]')?.textContent).toBe('math.ts')
    expect(q(row, '[data-row-dir]')?.getAttribute('data-row-dir')).toBe('src/app')
    expect(q(row, '[aria-label="5 additions"]')?.textContent).toBe('+5')
    expect(q(row, '[aria-label*="deletions"]')).toBeNull()
    unmount()
  })

  test.each([
    ['math.ts', 'modified'],
    ['notes.txt', 'added']
  ])('the %s row announces its Git state instead of an agent state', async (path, status) => {
    const { element, unmount } = await open()
    try {
      const row = rowOf(element, path)!
      expect(q(row, '[aria-label^="Git status"]')?.getAttribute('aria-label')).toBe(`Git status ${status}`)
      expect(q(row, '[aria-label^="Status:"]')).toBeNull()
    } finally {
      unmount()
    }
  })
})

describe('SC-10: empty states', () => {

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

describe('SC-14: row actions', () => {
  test('only the selected row carries buttons, and they are Revert and Open', async () => {
    const { element, unmount } = await open((fake) => {
      fake.status = statusOf([entry('math.ts', 'unstaged'), entry('gone.ts', 'unstaged', 'deleted'), entry('README.md', 'staged')])
    })
    const buttons = (path: string) => qa(rowOf(element, path)!, '.git-row__actions button').map((button) => button.getAttribute('title'))
    expect(qa(element, '.git-row__actions')).toHaveLength(0)
    await click(rowOf(element, 'math.ts'))
    expect(buttons('math.ts')).toEqual(['Revert', 'Open'])
    await click(rowOf(element, 'gone.ts'))
    expect(buttons('gone.ts')).toEqual(['Revert'])
    expect(buttons('math.ts')).toEqual([])
    unmount()
  })

  test('a submodule row has no Revert, keeps the hint "Stage inside submodule", and a click expands it', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('vendor/lib', 'unstaged', 'modified', { submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false } })])
      f.on('quirky.git/submoduleStatus', () => ({ entries: [] }))
    })
    const row = rowOf(element, 'vendor/lib')!
    expect(row.title).toContain('Stage inside submodule')
    await click(row)
    expect(fake.called('quirky.git/submoduleStatus')).toHaveLength(1)
    expect(fake.views).toEqual([])
    await click(byLabel(element, 'Revert vendor/lib'))
    expect(dialog()).toBeNull()
    expect(fake.toasts.at(-1)?.[1]).toContain('submodule')
    unmount()
  })
})

describe('opening Review', () => {
  test('clicking a row, committed or not, opens the one Review tab at that file', async () => {
    const { fake, element, unmount } = await open()
    await click(rowOf(element, 'math.ts'))
    await click(rowOf(element, 'util.ts'))
    await click(rowOf(element, 'new.ts'))
    expect(fake.views.map((view) => view.input)).toEqual([
      { worktree: 'feat', mode: 'review', reveal: 'math.ts' },
      { worktree: 'feat', mode: 'review', reveal: 'util.ts' },
      { worktree: 'feat', mode: 'review', reveal: 'new.ts' }
    ])
    expect(fake.views.every((view) => view.id === DIFF_VIEW)).toBe(true)
    unmount()
  })

  test('the highlight follows the last row clicked, wherever it sits', async () => {
    const { element, unmount } = await open()
    await click(rowOf(element, 'README.md'))
    expect(rowOf(element, 'README.md')?.getAttribute('aria-selected')).toBe('true')
    await click(rowOf(element, 'util.ts'))
    expect(rowOf(element, 'README.md')?.getAttribute('aria-selected')).toBe('false')
    expect(rowOf(element, 'util.ts')?.getAttribute('aria-selected')).toBe('true')
    unmount()
  })

  test('there is no selection footer or bulk bar', async () => {
    const { element, unmount } = await open()
    await click(rowOf(element, 'README.md'), { metaKey: true })
    await click(rowOf(element, 'math.ts'), { shiftKey: true })
    expect(q(element, '[role="toolbar"][aria-label="Selection actions"]')).toBeNull()
    expect(element.textContent).not.toContain('selected')
    unmount()
  })

  test('the Review view is opened for the conflict review through the operation card, not a row', async () => {
    const { fake, element, unmount } = await open((f) => {
      f.status = statusOf([entry('a.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })], { operation: 'merge' })
    })
    await click(buttonText(element, 'Review conflicts'))
    expect(fake.views.map((view) => view.input)).toEqual([{ worktree: 'feat', mode: 'conflicts' }])
    unmount()
  })
})

describe('SC-15: the selection', () => {
  test('changing the view mode keeps the selected file selected', async () => {
    const { fake, element, unmount } = await open()
    await click(rowOf(element, 'src/math.ts'))
    fake.settings.viewMode = 'tree'
    await act(async () => fake.emit({ type: 'setting.changed', id: 'setting:quirky.git/viewMode', value: 'tree' }))
    await settle()
    expect(rowOf(element, 'src/math.ts')?.getAttribute('aria-selected')).toBe('true')
    unmount()
  })

  test('the selection shows in the panel report', async () => {
    const { fake, element, unmount } = await open()
    await click(rowOf(element, 'math.ts'))
    expect(fake.reports.at(-1).selection).toEqual(['math.ts'])
    await press(listboxOf(element)!, 'Escape')
    expect(fake.reports.at(-1).selection).toEqual([])
    unmount()
  })

  test('the panel reports its areas and the committed-only files', async () => {
    const { fake, unmount } = await open()
    expect(fake.reports.at(-1).sections).toEqual([
      { id: 'unstaged', count: 1 },
      { id: 'staged', count: 2 },
      { id: 'untracked', count: 1 },
      { id: 'branch', count: 2 }
    ])
    unmount()
  })
})

describe('SC-16: the filter', () => {
  test('narrows rows case-insensitively, hides the Commits dock, and Escape restores', async () => {
    const { element, unmount } = await open()
    await click(byLabel(element, 'Filter files by name'))
    await type(byLabel(element, 'Filter files…') as HTMLInputElement, 'MATH')
    expect(rowPaths(element)).toEqual(['math.ts', 'src/math.ts'])
    expect(q(element, '[data-section="history"]')).toBeNull()
    expect(byLabel(element, 'Filter files by name')?.getAttribute('title')).toBe('Filter: MATH')
    await press(byLabel(element, 'Filter files…')!, 'Escape')
    expect(byLabel(element, 'Filter files…')).toBeNull()
    expect(rowOf(element, 'README.md')).not.toBeNull()
    expect(q(element, '[data-section="history"]')).not.toBeNull()
    unmount()
  })

  test('a query that matches nothing says so', async () => {
    const { element, unmount } = await open()
    await click(byLabel(element, 'Filter files by name'))
    await type(byLabel(element, 'Filter files…') as HTMLInputElement, 'zzz')
    expect(element.textContent).toContain('No files match the filter.')
    expect(listboxOf(element)).toBeNull()
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
    fake.compare = compareOf()
    fake.settings.viewMode = 'tree'
  }

  test('groups rows by compacted folder, folders first, without folder buttons', async () => {
    const { element, unmount } = await open(tree)
    const dirs = qa(element, '[data-directory-path]')
    expect(dirs.map((dir) => `${dir.getAttribute('data-directory-name')} ${q(dir, '[role="img"]')?.textContent}`)).toEqual(['lib 1', 'src/app 2'])
    expect(qa(element, '[data-directory-path] .git-folder-head button')).toHaveLength(2)
    expect(rowPaths(element)).toEqual(['lib/c.ts', 'src/app/a.ts', 'src/app/b.ts'])
    unmount()
  })

  test('Escape from source control actions returns focus to its trigger', async () => {
    const { element, unmount } = await open()
    try {
      const trigger = byLabel(element, 'More source control actions')!
      trigger.focus()
      await click(trigger)
      const menu = q(document.body, '[role="menu"]')!
      expect(document.activeElement).toBe(menu)
      await press(menu, 'Escape')
      expect(q(document.body, '[role="menu"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    } finally {
      unmount()
    }
  })

  test('announces singular and plural file counts on folder badges', async () => {
    const { element, unmount } = await open(tree)
    try {
      const dirs = qa(element, '[data-directory-path]')
      expect(q(dirs[0]!, '[role="img"]')?.getAttribute('aria-label')).toMatch(/^1 file$/)
      expect(q(dirs[1]!, '[role="img"]')?.getAttribute('aria-label')).toMatch(/^2 files$/)
    } finally {
      unmount()
    }
  })

  test('Tree changes the view and returns focus to the actions trigger', async () => {
    const { fake, element, unmount } = await open()
    try {
      const trigger = byLabel(element, 'More source control actions')!
      trigger.focus()
      await click(trigger)
      const action = buttonText(document.body, 'Tree')!
      action.focus()
      await click(action)
      expect(fake.called('setting.set').at(-1)?.params).toEqual({ id: 'setting:quirky.git/viewMode', value: 'tree' })
      expect(qa(element, '[data-directory-path]').map((dir) => dir.getAttribute('data-directory-path'))).toContain('src')
      expect(q(document.body, '[role="menu"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    } finally {
      unmount()
    }
  })
})

describe('SC-18: dragging', () => {
  test('dragging a row carries its absolute path as text', async () => {
    const { element, unmount } = await open((f) => {
      f.status = statusOf([entry('src/app/a.ts')])
    })
    const data: Record<string, string> = {}
    const event = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer?: unknown }
    event.dataTransfer = { setData: (type: string, value: string) => void (data[type] = value) }
    await act(async () => {
      rowOf(element, 'src/app/a.ts')!.dispatchEvent(event)
    })
    expect(data).toEqual({ 'text/plain': '/repo/feat/src/app/a.ts' })
    unmount()
  })
})
