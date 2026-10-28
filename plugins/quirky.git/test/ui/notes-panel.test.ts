import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, press, q, qa, rowOf, settle, statusOf } = s
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { PopupMenu } = await import('../../src/panel/Menu')
const { postSendRequest, SendMenu } = await import('../../src/notes/SendMenu')
const { commandHandlers } = await import('../../src/view/commands')

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
  act(() => postSendRequest(null))
})

type TestNote = { id: string; worktreeId: string; path: string; startLine: number; line: number; body: string; createdAt: number; updatedAt: number | null }
const note = (id: string, path: string, startLine: number, line = startLine, body = `Note ${id}`): TestNote => ({
  id,
  worktreeId: 'feat',
  path,
  startLine,
  line,
  body,
  createdAt: 1,
  updatedAt: null
})

/** NA-10's five notes in the order the daemon lists them. */
const FIVE = [note('n1', 'README.md', 1), note('n2', 'gone.ts', 3), note('n3', 'math.ts', 5), note('n4', 'math.ts', 30), note('n5', 'util.ts', 2, 4)]

const TARGETS = {
  sessions: [
    { session: 's1', agent: 'claude', label: 'Claude', title: 'fix tests', status: 'working', state: 'working', lastActivityAt: Date.now() - 2 * 60_000 - 500, sendable: true },
    { session: 's2', agent: 'codex', label: 'Codex', title: 'review', status: 'waiting', state: 'waiting', lastActivityAt: Date.now(), sendable: false, reason: 'Codex is waiting for approval.' }
  ],
  agents: [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ]
}

type Fake = ReturnType<typeof fakeContext>

/** The panel over math.ts (unstaged), notes.txt (untracked), util.ts (staged) and README.md (only on the branch). */
async function open(notes: TestNote[], configure: (fake: Fake) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'))
  fake.status = statusOf([entry('math.ts', 'unstaged'), entry('notes.txt', 'untracked'), entry('util.ts', 'staged')])
  fake.compare = compareOf({ entries: [{ path: 'README.md', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
  let stored = notes
  fake.on('quirky.git/notes', () => ({ notes: stored }))
  fake.on('quirky.git/noteTargets', () => TARGETS)
  configure(fake)
  const mounted = mountPanel(fake)
  await settle()
  return {
    fake,
    ...mounted,
    setNotes: async (next: TestNote[]) => {
      stored = next
      await act(async () => fake.emit({ type: 'quirky.git/notesChanged', data: { worktreeId: 'feat' } } as never))
      await settle()
    }
  }
}

const shelf = (root: ParentNode) => q(root, '.scm-notes')
const menus = () => qa(document.body, '[role="menu"]')
const menuButtons = (menu: Element) => qa(menu as HTMLElement, ':scope > li > button')
const hover = (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
/** The label of each entry of a menu: its heading text or its row's label. */
const labels = (menu: Element) => qa(menu as HTMLElement, ':scope > li').map((li) => q(li, '.menu-label')?.textContent ?? li.textContent)
const key = async (name: string) => press(document.activeElement ?? document.body, name)

describe('NA-13: the shelf and the overflow item exist only with notes', () => {
  test('no notes: no shelf and no Notes item', async () => {
    const { element, unmount } = await open([])
    expect(shelf(element)).toBeNull()
    await click(byLabel(element, 'More source control actions'))
    expect(qa(document.body, '[role="menu"] button').map((b) => b.textContent)).toEqual(['View as tree', 'Change Base Ref…', 'Refresh branch compare'])
    unmount()
  })

  test('two notes: the shelf sits between the branch row and the body, and the item reads Notes 2', async () => {
    const { element, unmount } = await open([note('n1', 'math.ts', 5), note('n2', 'util.ts', 2)])
    const box = shelf(element)!
    expect(box.previousElementSibling?.className).toContain('scm-branch')
    expect(q(element, '.scm-body')!.previousElementSibling).toBe(box)
    await click(byLabel(element, 'More source control actions'))
    expect(qa(document.body, '[role="menu"] button').map((b) => b.textContent)).toContain('Notes 2')
    unmount()
  })

  test('choosing Notes expands a collapsed shelf and scrolls it into view', async () => {
    const { element, unmount } = await open([note('n1', 'math.ts', 5), note('n2', 'util.ts', 2)])
    await click(q(element, '.scm-notes-toggle'))
    expect(qa(element, '.scm-note-row')).toHaveLength(0)
    let scrolled = 0
    shelf(element)!.scrollIntoView = () => void scrolled++
    await click(byLabel(element, 'More source control actions'))
    await click(buttonText(document.body, 'Notes 2'))
    expect(qa(element, '.scm-note-row')).toHaveLength(2)
    expect(q(element, '.scm-notes-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(scrolled).toBe(1)
    unmount()
  })

  test('the shelf follows notesChanged for its worktree and ignores other worktrees', async () => {
    const { fake, element, setNotes, unmount } = await open([note('n1', 'math.ts', 5)])
    expect(qa(element, '.scm-note-row')).toHaveLength(1)
    const reads = fake.called('quirky.git/notes').length
    await act(async () => fake.emit({ type: 'quirky.git/notesChanged', data: { worktreeId: 'other' } } as never))
    await settle()
    expect(fake.called('quirky.git/notes')).toHaveLength(reads)
    await setNotes([])
    expect(shelf(element)).toBeNull()
    await setNotes([note('n9', 'util.ts', 1)])
    expect(qa(element, '.scm-note-row')).toHaveLength(1)
    unmount()
  })
})

describe('notes worktree boundaries', () => {
  test('refreshes the mixed shelf when the editor emits changed', async () => {
    let notes = [note('git-note', 'src/a.ts', 1)]
    const { fake, element, unmount } = await open(notes, (context) => {
      context.on('quirky.git/notes', () => ({ notes }))
    })
    expect(qa(element, '.scm-note-row').map((row) => q(row, '.scm-note-path')?.textContent)).toEqual(['src/a.ts'])

    notes = [note('markdown:note-id', 'README.md', 2, 2, 'Markdown review')]
    await act(async () => fake.emit({ type: 'quirky.editor/changed', data: { revision: 2 } } as never))
    await settle()
    expect(qa(element, '.scm-note-row').map((row) => q(row, '.scm-note-path')?.textContent)).toEqual(['README.md'])
    expect(fake.called('quirky.git/notes')).toHaveLength(2)
    unmount()
  })

  test('does not display the previous worktree list while the next read is pending or fails', async () => {
    const { promise: nextRead, reject: rejectNextRead } = Promise.withResolvers<never>()
    const { fake, element, unmount } = await open([note('a-note', 'a.md', 1)], (context) => {
      context.on('quirky.git/notes', (params) =>
        params.worktree === 'next' ? nextRead : { notes: [note('a-note', 'a.md', 1)] }
      )
    })

    await act(async () => fake.setLayout(layoutFor('next')))
    await settle()
    expect(shelf(element)).toBeNull()
    expect(fake.called('quirky.git/notes')).toHaveLength(2)

    rejectNextRead(new Error('Markdown note storage is unavailable'))
    await settle()
    expect(fake.toasts).toContainEqual(['Failed to load notes', 'Markdown note storage is unavailable'])
    expect(shelf(element)).toBeNull()
    unmount()
  })
})

describe('NA-9: rows count notes by path', () => {
  test('every row of a path shows the count; rows without notes show none', async () => {
    const { element, unmount } = await open([note('a', 'math.ts', 5), note('b', 'math.ts', 30), note('c', 'util.ts', 2)], (fake) => {
      fake.status = statusOf([entry('math.ts', 'unstaged'), entry('util.ts', 'staged'), entry('util.ts', 'unstaged'), entry('plain.ts', 'unstaged')])
    })
    const counts = (path: string, section: string) => q(rowOf(element, path, section)!, '.scm-note-count')
    expect(counts('math.ts', 'unstaged')?.textContent).toBe('2')
    expect(counts('math.ts', 'unstaged')?.title).toBe('2 notes')
    expect(counts('util.ts', 'staged')?.textContent).toBe('1')
    expect(counts('util.ts', 'staged')?.title).toBe('1 note')
    expect(counts('util.ts', 'unstaged')?.textContent).toBe('1')
    expect(counts('plain.ts', 'unstaged')).toBeNull()
    unmount()
  })

  test('branch rows count too', async () => {
    const { element, unmount } = await open([note('a', 'README.md', 1)])
    expect(q(rowOf(element, 'README.md', 'branch')!, '.scm-note-count')?.title).toBe('1 note')
    unmount()
  })
})

describe('NA-10: the shelf lists, opens and orders notes', () => {
  test('the header reads Notes 5 and each row shows its path, line label and text', async () => {
    const { element, unmount } = await open(FIVE.map((n) => (n.id === 'n5' ? { ...n, body: 'Use a constant' } : n)))
    expect(q(element, '.scm-notes-title')?.textContent).toBe('Notes')
    expect(q(element, '.scm-notes-head .scm-count')?.textContent).toBe('5')
    const rows = qa(element, '.scm-note-row').map((row) => [q(row, '.scm-note-path')?.textContent, q(row, '.scm-note-lines')?.textContent, q(row, '.scm-note-text')?.textContent])
    expect(rows).toEqual([
      ['README.md', 'Line 1', 'Note n1'],
      ['gone.ts', 'Line 3', 'Note n2'],
      ['math.ts', 'Line 5', 'Note n3'],
      ['math.ts', 'Line 30', 'Note n4'],
      ['util.ts', 'Lines 2-4', 'Use a constant']
    ])
    unmount()
  })

  test('clicking a note opens the diff the opening rule picks and names the note', async () => {
    const { fake, element, unmount } = await open(FIVE)
    const rows = qa(element, '.scm-note-open')
    for (const row of rows) await click(row)
    const w = 'feat'
    expect(fake.views.map((v) => v.input)).toEqual([
      { worktree: w, mode: 'file', source: 'branch', path: 'README.md', noteId: 'n1' },
      { worktree: w, mode: 'file', source: 'unstaged', path: 'gone.ts', noteId: 'n2' },
      { worktree: w, mode: 'file', source: 'unstaged', path: 'math.ts', noteId: 'n3' },
      { worktree: w, mode: 'file', source: 'unstaged', path: 'math.ts', noteId: 'n4' },
      { worktree: w, mode: 'file', source: 'staged', path: 'util.ts', noteId: 'n5' }
    ])
    expect(fake.views.every((v) => v.id === 'view:quirky.git/diff')).toBe(true)
    unmount()
  })

  test('an untracked path opens its untracked diff; an unstaged change wins over a staged one', async () => {
    const { fake, element, unmount } = await open([note('a', 'notes.txt', 1), note('b', 'both.ts', 1)], (f) => {
      f.status = statusOf([entry('notes.txt', 'untracked'), entry('both.ts', 'staged'), entry('both.ts', 'unstaged')])
    })
    for (const row of qa(element, '.scm-note-open')) await click(row)
    expect(fake.views.map((v) => (v.input as { source: string }).source)).toEqual(['unstaged', 'unstaged'])
    unmount()
  })

  test('a note on a renamed staged file keeps the old path', async () => {
    const { fake, element, unmount } = await open([note('a', 'new.ts', 1)], (f) => {
      f.status = statusOf([entry('new.ts', 'staged', 'renamed', { oldPath: 'old.ts' })])
    })
    await click(q(element, '.scm-note-open'))
    expect(fake.views.at(-1)?.input).toEqual({ worktree: 'feat', mode: 'file', source: 'staged', path: 'new.ts', oldPath: 'old.ts', noteId: 'a' })
    unmount()
  })
})

describe('NA-11: notes are copied as their prompt text', () => {
  const clipboard = () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } })
    return copied
  }

  test('copy all and copy note write the formatNotes text', async () => {
    const copied = clipboard()
    const { fake, element, unmount } = await open([note('a', 'math.ts', 5), note('b', 'util.ts', 2)], (f) => {
      f.on('quirky.git/formatNotes', (params) => ({ text: params.ids ? `one:${(params.ids as string[]).join()}` : 'all', count: 1 }))
    })
    await click(byLabel(element, 'Copy all notes to clipboard'))
    await click(qa(element, '[aria-label="Copy note"]')[1])
    expect(copied).toEqual(['all', 'one:b'])
    expect(fake.called('quirky.git/formatNotes').map((c) => c.params)).toEqual([{ worktree: 'feat' }, { worktree: 'feat', ids: ['b'] }])
    unmount()
  })

  test('a refused clipboard write shows the toast', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => Promise.reject(new Error('denied')) } })
    const { fake, element, unmount } = await open([note('a', 'math.ts', 5)], (f) => {
      f.on('quirky.git/formatNotes', () => ({ text: 'x', count: 1 }))
    })
    await click(byLabel(element, 'Copy all notes to clipboard'))
    await click(q(element, '[aria-label="Copy note"]'))
    expect(fake.toasts.map((t) => t[0])).toEqual(['Failed to copy notes', 'Failed to copy notes'])
    unmount()
  })
})

describe('NA-12: notes are cleared per file or all at once, after a yes', () => {
  const dialog = () => q(document.body, '[role="dialog"]')

  async function openClear(element: HTMLElement, label: string) {
    await click(byLabel(element, 'More note actions'))
    await click(buttonText(document.body, label))
  }

  test('the menu offers Clear all notes... then one entry per path', async () => {
    const { element, unmount } = await open([note('a', 'math.ts', 5), note('b', 'math.ts', 30), note('c', 'util.ts', 2)])
    await click(byLabel(element, 'More note actions'))
    expect(qa(document.body, '[role="menu"] button').map((b) => b.textContent)).toEqual(['Clear all notes...', 'Clear notes for math.ts', 'Clear notes for util.ts'])
    unmount()
  })

  test('a file clear asks with the daemon text, then clears with yes', async () => {
    const { fake, element, unmount } = await open([note('a', 'math.ts', 5), note('b', 'math.ts', 30), note('c', 'util.ts', 2)], (f) => {
      f.on('quirky.git/describeClearNotes', (params) => (params.path ? `Clear 2 notes from ${params.path}?` : 'Clear 3 notes from this workspace?'))
      f.on('quirky.git/clearNotes', () => ({ cleared: 2 }))
    })
    await openClear(element, 'Clear notes for math.ts')
    expect(dialog()?.getAttribute('aria-label')).toBe('Clear 2 notes from math.ts?')
    expect(qa(dialog()!, 'button').map((b) => b.textContent)).toEqual(['Cancel', 'Clear'])
    expect(fake.called('quirky.git/clearNotes')).toHaveLength(0)
    await click(buttonText(dialog()!, 'Clear'))
    expect(fake.called('quirky.git/clearNotes').map((c) => c.params)).toEqual([{ worktree: 'feat', path: 'math.ts', yes: true }])
    expect(dialog()).toBeNull()
    unmount()
  })

  test('cancelling the clear-all dialog deletes nothing', async () => {
    const { fake, element, unmount } = await open([note('a', 'math.ts', 5)], (f) => {
      f.on('quirky.git/describeClearNotes', () => 'Clear 1 note from this workspace?')
      f.on('quirky.git/clearNotes', () => ({ cleared: 1 }))
    })
    await openClear(element, 'Clear all notes...')
    expect(dialog()?.getAttribute('aria-label')).toBe('Clear 1 note from this workspace?')
    await click(buttonText(dialog()!, 'Cancel'))
    expect(fake.called('quirky.git/clearNotes')).toHaveLength(0)
    expect(dialog()).toBeNull()
    unmount()
  })

  test('a failed clear shows the toast', async () => {
    const { fake, element, unmount } = await open([note('a', 'math.ts', 5)], (f) => {
      f.on('quirky.git/describeClearNotes', () => 'Clear 1 note from this workspace?')
      f.on('quirky.git/clearNotes', () => {
        throw failure('store is read-only')
      })
    })
    await openClear(element, 'Clear all notes...')
    await click(buttonText(dialog()!, 'Clear'))
    expect(fake.toasts).toEqual([['Failed to clear notes.', 'store is read-only']])
    unmount()
  })
})

describe('menus: submenus open on hover and ArrowRight and close on ArrowLeft and Escape', () => {
  async function mountMenu() {
    const picked: string[] = []
    let closed = 0
    const items = [
      { label: 'Alpha', submenu: [{ label: 'One', onSelect: () => void picked.push('One') }, { label: 'Two', disabled: true }, { label: 'Three', onSelect: () => void picked.push('Three') }] },
      { label: 'Beta', onSelect: () => void picked.push('Beta') }
    ]
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    await act(async () => root.render(createElement(PopupMenu, { x: 10, y: 10, label: 'Test', items, onClose: () => void closed++ })))
    await settle()
    return { picked, closed: () => closed, unmount: () => act(async () => root.unmount()) }
  }

  test('hovering a row with a submenu opens it and hovering another row closes it', async () => {
    const menu = await mountMenu()
    expect(menus()).toHaveLength(1)
    await hover(buttonText(document.body, 'Alpha')!)
    expect(menus().map((m) => m.getAttribute('aria-label'))).toEqual(['Test', 'Alpha'])
    expect(buttonText(document.body, 'Alpha')?.getAttribute('aria-haspopup')).toBe('menu')
    await hover(buttonText(document.body, 'Beta')!)
    expect(menus()).toHaveLength(1)
    await menu.unmount()
  })

  test('ArrowRight opens the submenu and focuses its first enabled row, ArrowDown skips disabled rows', async () => {
    const menu = await mountMenu()
    expect(document.activeElement?.textContent).toBe('Alpha')
    await key('ArrowRight')
    expect(menus()).toHaveLength(2)
    expect(document.activeElement?.textContent).toBe('One')
    await key('ArrowDown')
    expect(document.activeElement?.textContent).toBe('Three')
    await key('ArrowDown')
    expect(document.activeElement?.textContent).toBe('One')
    await menu.unmount()
  })

  test('ArrowLeft closes the submenu and returns to its row; Escape closes the submenu first, then the menu', async () => {
    const menu = await mountMenu()
    await key('ArrowRight')
    await key('ArrowLeft')
    expect(menus()).toHaveLength(1)
    expect(document.activeElement?.textContent).toBe('Alpha')
    await key('ArrowRight')
    await key('Escape')
    expect(menus()).toHaveLength(1)
    expect(menu.closed()).toBe(0)
    await key('Escape')
    expect(menu.closed()).toBe(1)
    await menu.unmount()
  })

  test('picking a submenu row runs it and closes the menu; clicking the row that owns a submenu does not close', async () => {
    const menu = await mountMenu()
    await click(buttonText(document.body, 'Alpha'))
    expect(menu.closed()).toBe(0)
    expect(menus()).toHaveLength(2)
    await click(buttonText(document.body, 'Three'))
    expect(menu.picked).toEqual(['Three'])
    expect(menu.closed()).toBe(1)
    await menu.unmount()
  })
  test('a mousedown or Escape inside an element that stops propagation, such as a terminal pane, still closes the menu', async () => {
    const pane = document.createElement('div')
    pane.addEventListener('mousedown', (event) => event.stopPropagation())
    pane.addEventListener('keydown', (event) => event.stopPropagation())
    pane.tabIndex = 0
    document.body.append(pane)
    const menu = await mountMenu()
    await act(async () => void pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(menu.closed()).toBe(1)
    await menu.unmount()
    const again = await mountMenu()
    await act(async () => void pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(again.closed()).toBe(1)
    await again.unmount()
    pane.remove()
  })
})

describe('NA-17: the send menu offers scopes, then targets', () => {
  async function mountSend(fake: Fake, scopes: Array<{ id: string; label: string; notes: TestNote[]; params: Record<string, unknown> }>, props: Record<string, unknown> = {}) {
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    await act(async () => root.render(createElement(SendMenu, { context: fake.context, worktree: 'feat', scopes, ...props } as never)))
    await settle()
    return { element, unmount: () => act(async () => root.unmount()) }
  }
  const two = [note('a', 'math.ts', 5), note('b', 'math.ts', 30)]
  const all = [...two, note('c', 'util.ts', 2)]
  const SCOPES = [
    { id: 'file', label: 'This file', notes: two, params: { scope: 'file', path: 'math.ts' } },
    { id: 'all', label: 'All unsent notes', notes: all, params: { scope: 'all' } }
  ]
  const trigger = (root: ParentNode) => byLabel(root, 'Send notes to an agent') as HTMLButtonElement

  test('two scopes: Send notes with counts, each opening Send notes to, then New agent', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    const { element, unmount } = await mountSend(fake, SCOPES)
    expect(trigger(element).title).toBe('Send notes to an agent')
    await click(trigger(element))
    expect(fake.called('quirky.git/noteTargets')[0]?.params).toEqual({ worktree: 'feat' })
    const top = menus()[0]!
    expect(qa(top as HTMLElement, ':scope > li').map((li) => li.textContent)).toEqual(['Send notes', 'This file2', 'All unsent notes3'])
    expect(qa(top as HTMLElement, '.menu-badge').map((b) => b.textContent)).toEqual(['2', '3'])

    await hover(buttonText(top, 'This file2')!)
    const sub = menus()[1]!
    expect(labels(sub)).toEqual(['Send notes to', 'Claude', 'Codex', 'New agent', 'Claude', 'Codex'])
    const [s1, s2] = menuButtons(sub) as HTMLButtonElement[]
    expect(q(s1!, '.menu-detail')?.textContent).toBe('Working · 2m ago · fix tests')
    expect(q(s1!, '.dot-working')).not.toBeNull()
    expect(s1!.disabled).toBe(false)
    expect(s2!.disabled).toBe(true)
    expect(s2!.title).toBe('Codex is waiting for approval.')
    expect(q(s2!, '.dot-waiting')).not.toBeNull()
    await unmount()
  })

  test('a single scope shows its targets directly', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    const { element, unmount } = await mountSend(fake, [SCOPES[1]!])
    await click(trigger(element))
    expect(menus()).toHaveLength(1)
    expect(labels(menus()[0]!)).toEqual(['Send notes to', 'Claude', 'Codex', 'New agent', 'Claude', 'Codex'])
    await unmount()
  })

  test('sending to a session asks the daemon, toasts progress and holds the notes meanwhile', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    let release: (value: unknown) => void = () => {}
    fake.on('quirky.git/sendNotes', () => new Promise((resolve) => (release = resolve)))
    const { element, unmount } = await mountSend(fake, SCOPES)
    await click(trigger(element))
    await hover(buttonText(menus()[0]!, 'This file2')!)
    await click(menuButtons(menus()[1]!)[0]!)
    expect(fake.called('quirky.git/sendNotes').map((c) => c.params)).toEqual([{ worktree: 'feat', scope: 'file', path: 'math.ts', session: 's1' }])
    expect(fake.toasts).toEqual([['Sending notes...', '']])
    expect(menus()).toHaveLength(0)
    expect(trigger(element).disabled).toBe(false)
    release({ sent: ['a', 'b'], kept: [], target: { session: 's1' }, delivery: 'pasted' })
    await settle()
    expect(fake.toasts).toEqual([['Sending notes...', ''], ['Notes sent.', '']])
    await unmount()
  })

  test('sending to a new agent passes the agent id; a refusal toasts the daemon message', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    fake.on('quirky.git/sendNotes', () => {
      throw failure('The agent did not receive the notes.')
    })
    const { element, unmount } = await mountSend(fake, [SCOPES[1]!])
    await click(trigger(element))
    const agents = menuButtons(menus()[0]!).filter((b) => b.textContent === 'Codex')
    await click(agents[agents.length - 1])
    expect(fake.called('quirky.git/sendNotes').map((c) => c.params)).toEqual([{ worktree: 'feat', scope: 'all', agent: 'codex' }])
    expect(fake.toasts).toEqual([['Sending notes...', ''], ['Failed to send notes', 'The agent did not receive the notes.']])
    await unmount()
  })

  test('with every unsent note in flight the trigger reads Sending… and with none it reads All notes sent', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    let release: (value: unknown) => void = () => {}
    fake.on('quirky.git/sendNotes', () => new Promise((resolve) => (release = resolve)))
    const { element, unmount } = await mountSend(fake, [SCOPES[1]!])
    await click(trigger(element))
    await click(menuButtons(menus()[0]!).find((b) => b.textContent?.startsWith('Claude'))!)
    expect(trigger(element).disabled).toBe(true)
    expect(trigger(element).title).toBe('Sending…')
    release({ sent: ['a', 'b', 'c'], kept: [], target: { session: 's1' }, delivery: 'pasted' })
    await settle()
    expect(trigger(element).disabled).toBe(false)
    await unmount()

    const empty = await mountSend(fake, [{ ...SCOPES[1]!, notes: [] }])
    expect(trigger(empty.element).disabled).toBe(true)
    expect(trigger(empty.element).title).toBe('All notes sent')
    await empty.unmount()
  })

  test('the shelf offers only All unsent notes and the card scope This note', async () => {
    const { fake, element, unmount } = await open([note('a', 'math.ts', 5)])
    await click(q(shelf(element)!, '[aria-label="Send notes to an agent"]'))
    expect(menus()).toHaveLength(1)
    expect(menus()[0]!.getAttribute('aria-label')).toBe('Send notes')
    await click(menuButtons(menus()[0]!).find((b) => b.textContent?.startsWith('Claude'))!)
    expect(fake.called('quirky.git/sendNotes').at(-1)?.params).toEqual({ worktree: 'feat', scope: 'all', session: 's1' })
    unmount()
  })
})

describe('NA-22: Send Review Notes to Agent opens the shelf menu', () => {
  test('with no notes nothing happens', async () => {
    const { fake, unmount } = await open([])
    const shown: Array<[string, boolean]> = []
    fake.context.togglePanel = ((id: string, show: boolean) => void shown.push([id, show])) as never
    await commandHandlers(fake.context)['send-review-notes']!()
    await settle()
    expect(shown).toEqual([])
    expect(menus()).toHaveLength(0)
    unmount()
  })

  test('with a note the panel opens and the shelf menu opens on All unsent notes', async () => {
    const { fake, unmount } = await open([note('a', 'math.ts', 5)])
    const shown: Array<[string, boolean]> = []
    fake.context.togglePanel = ((id: string, show: boolean) => void shown.push([id, show])) as never
    await commandHandlers(fake.context)['send-review-notes']!()
    await settle()
    expect(shown).toEqual([['panel:quirky.git/source-control', true]])
    expect(menus()).toHaveLength(1)
    expect(labels(menus()[0]!)).toEqual(['Send notes to', 'Claude', 'Codex', 'New agent', 'Claude', 'Codex'])
    unmount()
  })

  test('a request older than 5 seconds is dropped', async () => {
    const { unmount } = await open([note('a', 'math.ts', 5)])
    await act(async () => postSendRequest({ nonce: 1, issuedAt: Date.now() - 5001 }))
    await settle()
    expect(menus()).toHaveLength(0)
    await act(async () => postSendRequest({ nonce: 2, issuedAt: Date.now() }))
    await settle()
    expect(menus()).toHaveLength(1)
    unmount()
  })

  test('a request posted before the panel shows is answered when it mounts', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.status = statusOf([entry('math.ts', 'unstaged')])
    fake.on('quirky.git/notes', () => ({ notes: [note('a', 'math.ts', 5)] }))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    postSendRequest({ nonce: 3, issuedAt: Date.now() })
    const mounted = mountPanel(fake)
    await settle()
    expect(menus()).toHaveLength(1)
    mounted.unmount()
  })
})
