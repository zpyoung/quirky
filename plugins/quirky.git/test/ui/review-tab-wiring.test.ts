import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { GitDiff, GitStatusEntry, ReviewModel } from '@quirky/protocol'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const p = await import('./panel-support')
const s = await import('./support')
const { parseInput, mountDiffView } = await import('../../src/view/DiffWindow')
const { commandHandlers } = await import('../../src/view/commands')
const { openHostedDiff } = await import('../../src/view/hosted-tabs')
const { noteViewInput } = await import('../../src/notes/open-note')
const { diffViewKey } = await import('../../src/shared/view-input')
const { openReview, registerReviewView, reviewViewFor } = await import('../../src/review/open')
afterAll(() => GlobalRegistrator.unregister())

const { act, byLabel, failure, modifiedEditor, numbered, reviewFile, reviewModel, settle, stubIntersectionObserver, stubResizeObserver, textDiff, wait } = {
  ...s,
  failure: p.failure
}

const APP = 'src/app.ts'
const README = 'README.md'
const COMMIT = 'f5429a1'.padEnd(40, '0')
const TWO_CHANGES = {
  original: numbered(20),
  modified: numbered(20).replace('line 3\n', 'three\n').replace('line 15\n', 'fifteen\n')
}

let fake: ReturnType<typeof p.fakeContext>
let model: ReviewModel
let intersection: ReturnType<typeof stubIntersectionObserver>
let resize: ReturnType<typeof stubResizeObserver>
let scrolled: Element[]
let originalScroll: typeof Element.prototype.scrollIntoView
const unmounts: Array<() => void> = []

type Mounted = { element: HTMLElement; reports: Array<Record<string, unknown>>; unmount(): void }

/** Mounts the diff view as the host does for a hosted tab: the tab's input with its id merged in. */
function mount(input: object): Mounted {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: Array<Record<string, unknown>> = []
  let cleanup: (() => void) | void
  act(() => {
    cleanup = mountDiffView(fake.context)(element, { input, report: (state) => void reports.push(state as Record<string, unknown>) })
  })
  let done = false
  const unmount = () => {
    if (done) return
    done = true
    act(() => {
      cleanup?.()
    })
    element.remove()
  }
  unmounts.push(unmount)
  return { element, reports, unmount }
}

const open = async (input: object = { worktree: 'w1', mode: 'review' }): Promise<Mounted> => {
  const mounted = mount(input)
  await settle()
  return mounted
}

const cardOf = (root: ParentNode, path: string) => root.querySelector<HTMLElement>(`section[data-path="${path}"]`)!
const paths = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('section[data-path]')].map((el) => el.dataset.path)
const revertButtons = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('button[name="reject"]')]
const mousedown = async (target: Element | undefined) => {
  if (!target) throw new Error('nothing to press')
  await act(async () => void target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  await wait(20)
}
const diffBody = (overrides: Partial<GitDiff> = {}) => (params: Record<string, unknown>) =>
  textDiff({ path: params.path as string, source: 'review', modifiedHash: 'h1', ...TWO_CHANGES, ...overrides })

beforeEach(() => {
  document.body.innerHTML = ''
  fake = p.fakeContext(p.layoutFor('w1'))
  intersection = stubIntersectionObserver()
  resize = stubResizeObserver()
  model = reviewModel([reviewFile(README, { mark: 'reviewed' }), reviewFile(APP)])
  fake.on('quirky.git/review', () => model)
  fake.on('quirky.git/diff', diffBody())
  fake.on('quirky.git/commitFiles', (params) => ({
    commit: String(params.commit),
    entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 1, binary: false }]
  }))
  scrolled = []
  originalScroll = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
})
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  intersection.restore()
  resize.restore()
  Element.prototype.scrollIntoView = originalScroll
})

describe('parseInput maps the legacy diff modes to the Review tab', () => {
  test('a file input reveals its path; a missing mode is a file input', () => {
    expect(parseInput({ worktree: 'w1', mode: 'file', source: 'unstaged', path: APP })).toEqual({ worktree: 'w1', mode: 'review', reveal: APP })
    expect(parseInput({ worktree: 'w1', path: APP })).toEqual({ worktree: 'w1', mode: 'review', reveal: APP })
  })

  test('a commit file input scopes the tab to the commit and reveals the path', () => {
    expect(parseInput({ worktree: 'w1', mode: 'file', source: 'commit', commit: COMMIT, path: APP, oldPath: 'old.ts' })).toEqual({
      worktree: 'w1',
      mode: 'review',
      reveal: APP,
      commit: COMMIT
    })
  })

  test('a combined input is the worktree review, or the commit scope when it names a commit', () => {
    expect(parseInput({ worktree: 'w1', mode: 'combined', area: 'unstaged' })).toEqual({ worktree: 'w1', mode: 'review' })
    expect(parseInput({ worktree: 'w1', mode: 'combined', commit: COMMIT, commitMessage: { subject: 's', body: '' } })).toMatchObject({
      worktree: 'w1',
      mode: 'review',
      commit: COMMIT
    })
  })

  test('hosted identity, placement and the note id survive the mapping', () => {
    expect(parseInput({ worktree: 'w1', mode: 'file', path: APP, tabId: 't1', groupId: 'g1', preview: true, split: false, noteId: 'n1' })).toEqual({
      worktree: 'w1',
      mode: 'review',
      reveal: APP,
      tabId: 't1',
      groupId: 'g1',
      preview: true,
      split: false,
      noteId: 'n1'
    })
  })

  test('review, conflicts and conflict-file inputs are left as they are', () => {
    expect(parseInput({ worktree: 'w1', mode: 'review', reveal: APP, commit: COMMIT })).toEqual({ worktree: 'w1', mode: 'review', reveal: APP, commit: COMMIT })
    expect(parseInput({ worktree: 'w1', mode: 'conflicts' })).toEqual({ worktree: 'w1', mode: 'conflicts' })
    expect(parseInput({ worktree: 'w1', mode: 'conflict-file', path: 'b.ts' })).toEqual({ worktree: 'w1', mode: 'conflict-file', path: 'b.ts' })
  })

  test('an input without a worktree is refused', () => {
    expect(parseInput({ mode: 'file', path: APP })).toBeNull()
    expect(parseInput(null)).toBeNull()
  })
})

describe('window commands open the Review tab', () => {
  const lastOpen = () => fake.called('quirky.terminal/openViewTab').at(-1)!.params
  const REVIEW_KEY = 'git-diff:["w1","review"]'
  let commands: ReturnType<typeof commandHandlers>
  beforeEach(() => {
    commands = commandHandlers(fake.context)
  })

  test('open-diff reveals the path in the worktree review', async () => {
    await commands['open-diff']!({ path: APP, source: 'unstaged' })
    expect(lastOpen().key).toBe(REVIEW_KEY)
    expect(lastOpen().title).toBe('Review')
    expect(lastOpen().input).toMatchObject({ worktree: 'w1', mode: 'review', reveal: APP })
    expect(lastOpen().input).not.toHaveProperty('source')
    expect(lastOpen().input).not.toHaveProperty('commit')
  })

  test('open-diff of a commit file scopes the tab to the commit, and a branch file does not', async () => {
    await commands['open-diff']!({ path: APP, source: 'commit', commit: COMMIT })
    expect(lastOpen().input).toMatchObject({ mode: 'review', reveal: APP, commit: COMMIT })
    await commands['open-diff']!({ path: APP, source: 'branch' })
    expect(lastOpen().input).not.toHaveProperty('commit')
    expect(lastOpen().key).toBe(REVIEW_KEY)
  })

  test('open-diff of a conflict still opens the conflict file view', async () => {
    await commands['open-diff']!({ path: 'b.ts', source: 'conflict', preview: true })
    expect(lastOpen().input).toMatchObject({ worktree: 'w1', mode: 'conflict-file', path: 'b.ts' })
    expect(lastOpen().key).not.toBe(REVIEW_KEY)
    expect(() => commands['open-diff']!({ source: 'conflict' })).toThrow('open-diff needs a path.')
  })

  test('open-changes, open-branch-changes and open-commit open the review without defaulting to unstaged', async () => {
    await commands['open-changes']!({})
    expect(lastOpen().input).toEqual(expect.objectContaining({ mode: 'review' }))
    expect(lastOpen().input).not.toHaveProperty('area')
    await commands['open-changes']!({ area: 'staged' })
    expect(lastOpen().input).not.toHaveProperty('area')
    await commands['open-branch-changes']!({})
    expect(lastOpen().input).toMatchObject({ mode: 'review' })
    expect(lastOpen().input).not.toHaveProperty('commit')
    await commands['open-commit']!({ commit: COMMIT })
    expect(lastOpen().input).toMatchObject({ mode: 'review', commit: COMMIT })
    expect(fake.called('quirky.terminal/openViewTab').map((c) => c.params.key)).toEqual([REVIEW_KEY, REVIEW_KEY, REVIEW_KEY, REVIEW_KEY])
    expect(() => commands['open-commit']!({})).toThrow('open-commit needs a commit.')
  })

  test('with the tab mounted the commands steer it instead of opening another', async () => {
    await commands['open-changes']!({})
    const tab = (await fake.context.call('quirky.terminal/workspace', { workspace: 'id:w1' })) as { workspace: unknown }
    fake.on('quirky.terminal/activateTab', () => tab)
    const reveals: Array<[string, string | undefined]> = []
    const scopes: Array<string | null> = []
    let tops = 0
    const off = registerReviewView({
      worktree: 'w1',
      reveal: (path, noteId) => void reveals.push([path, noteId]),
      scrollToTop: () => void tops++,
      setScope: (commit) => void scopes.push(commit)
    })
    try {
      const opens = fake.called('quirky.terminal/openViewTab').length
      await commands['open-changes']!({})
      await commands['open-diff']!({ path: APP })
      await commands['open-commit']!({ commit: COMMIT })
      expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(opens)
      expect(fake.called('quirky.terminal/activateTab')).toHaveLength(3)
      expect(tops).toBe(2)
      expect(reveals).toEqual([[APP, undefined]])
      expect(scopes).toEqual([null, null, COMMIT])
    } finally {
      off()
    }
  })

  test('a failed open shows a toast', async () => {
    fake.on('quirky.terminal/workspace', () => {
      throw new Error('terminal is down')
    })
    await commands['open-changes']!({})
    expect(fake.toasts).toEqual([['Could not open diff', 'terminal is down']])
  })
})

describe('legacy diff tabs fold into one Review tab per worktree', () => {
  const hosted = (input: object) => openHostedDiff(fake.context, { worktree: 'w1', preview: false, ...input } as never)
  beforeEach(() => {
    fake.on('quirky.terminal/activateTab', () => ({}))
  })
  const tabsOf = async () => {
    const { workspace } = (await fake.context.call('quirky.terminal/workspace', { workspace: 'id:w1' })) as {
      workspace: { root: { tabs: Array<{ id: string; key: string; title: string; input: Record<string, unknown> }> } }
    }
    return workspace.root.tabs
  }

  test('the first mounted legacy tab becomes the Review tab and is named as one', async () => {
    const first = await hosted({ mode: 'file', source: 'unstaged', path: APP })
    const { element } = await open(first)

    expect(element.querySelector('[data-review-tab]')).not.toBeNull()
    expect(reviewViewFor('w1')).not.toBeNull()
    const [tab] = await tabsOf()
    expect(tab).toMatchObject({ id: first.tabId, title: 'Review' })
    expect(tab!.key).toBe(diffViewKey(first))
    expect(tab!.input).toMatchObject({ mode: 'file' })
    expect(scrolled).toContain(cardOf(element, APP))
  })

  test('openReview reuses the surviving legacy tab instead of opening another', async () => {
    const first = await hosted({ mode: 'file', source: 'unstaged', path: APP })
    await open(first)
    const opens = fake.called('quirky.terminal/openViewTab').length
    scrolled.length = 0

    await openReview(fake.context, { worktree: 'w1', reveal: README })

    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(opens)
    expect(fake.called('quirky.terminal/activateTab').map((c) => c.params.tab)).toEqual([first.tabId])
  })

  test('a later legacy tab reveals its path in the surviving tab and closes itself', async () => {
    const first = await hosted({ mode: 'combined', area: 'unstaged' })
    const survivor = await open(first)
    const second = await hosted({ mode: 'file', source: 'unstaged', path: README })
    scrolled.length = 0

    const later = await open(second)

    expect(later.element.querySelector('[data-review-tab]')).toBeNull()
    expect(later.element.textContent).toBe('')
    expect(scrolled).toContain(cardOf(survivor.element, README))
    expect(fake.called('quirky.terminal/activateTab').map((c) => c.params.tab)).toEqual([first.tabId])
    expect(fake.called('quirky.terminal/closeTab').map((c) => c.params.tab)).toEqual([second.tabId!])
  })

  test('a later legacy commit tab sets the surviving tab to that commit', async () => {
    const survivor = await open(await hosted({ mode: 'combined', area: 'unstaged' }))
    await open(await hosted({ mode: 'combined', commit: COMMIT }))

    expect(survivor.element.querySelector('.ui-scope-chip')?.textContent).toContain('Commit f5429a1')
    expect(paths(survivor.element)).toEqual(['a.ts'])
  })

  test('a restored review tab beside the surviving one folds the same way', async () => {
    await open(await hosted({ mode: 'file', path: APP }))
    const later = await open({ worktree: 'w1', mode: 'review', reveal: README, tabId: 'restored-review-tab' })
    expect(later.element.querySelector('[data-review-tab]')).toBeNull()
    expect(fake.called('quirky.terminal/closeTab').map((c) => c.params.tab)).toEqual(['restored-review-tab'])
  })

  test('worktrees fold independently, and a closed Review tab frees its place', async () => {
    const one = await open(await hosted({ mode: 'file', path: APP }))
    const other = await open({ worktree: 'w2', mode: 'file', path: APP, tabId: 'other-tab' })
    expect(other.element.querySelector('[data-review-tab]')).not.toBeNull()
    other.unmount()

    one.unmount()
    const next = await open(await hosted({ mode: 'combined', area: 'all' }))
    expect(next.element.querySelector('[data-review-tab]')).not.toBeNull()
  })

  test('a view that is not a hosted tab never folds', async () => {
    await open(await hosted({ mode: 'file', path: APP }))
    const top = await open({ worktree: 'w1', mode: 'file', path: README })
    expect(top.element.querySelector('[data-review-tab]')).not.toBeNull()
    expect(fake.called('quirky.terminal/closeTab')).toEqual([])
  })
})

describe('Revert puts one change back on disk', () => {
  let confirmations: Array<Record<string, unknown>>
  let saves: Array<Record<string, unknown>>
  let allow: boolean
  beforeEach(() => {
    confirmations = []
    saves = []
    allow = true
    fake.context.confirm = async (options) => {
      confirmations.push(options as unknown as Record<string, unknown>)
      return allow
    }
    fake.on('quirky.git/save', (params) => {
      saves.push(params)
      return { hash: `h${saves.length + 1}` }
    })
  })

  const expectedAfterFirst = TWO_CHANGES.modified.replace('three\n', 'line 3\n')

  test('every change of a card has a Revert button, labelled for what it does', async () => {
    const { element } = await open()
    const buttons = revertButtons(cardOf(element, APP))
    expect(buttons).toHaveLength(2)
    expect(buttons.map((b) => b.textContent)).toEqual(['↶ Revert', '↶ Revert'])
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Revert change')
  })

  test('confirming applies the change to the card and saves it with the hash the card was built from', async () => {
    const { element } = await open()
    await mousedown(revertButtons(cardOf(element, APP))[0])

    expect(confirmations).toHaveLength(1)
    expect(confirmations[0]).toMatchObject({ title: 'Revert this change?', confirmLabel: 'Revert' })
    expect(saves).toEqual([{ worktree: 'w1', path: APP, content: expectedAfterFirst, expected: 'h1' }])
    expect(modifiedEditor(cardOf(element, APP)).state.sliceDoc()).toBe(expectedAfterFirst)
    expect(fake.toasts).toEqual([])
  })

  test('the next revert carries the hash the last save returned', async () => {
    const { element } = await open()
    await mousedown(revertButtons(cardOf(element, APP))[0])
    await mousedown(revertButtons(cardOf(element, APP))[0])

    expect(saves.map((save) => save.expected)).toEqual(['h1', 'h2'])
    expect(saves[1]!.content).toBe(TWO_CHANGES.original)
  })

  test('declining the confirm changes and saves nothing', async () => {
    allow = false
    const { element } = await open()
    await mousedown(revertButtons(cardOf(element, APP))[0])

    expect(confirmations).toHaveLength(1)
    expect(saves).toEqual([])
    expect(modifiedEditor(cardOf(element, APP)).state.sliceDoc()).toBe(TWO_CHANGES.modified)
  })

  test('a failed save restores the card and shows a toast', async () => {
    fake.on('quirky.git/save', () => {
      throw failure('disk full')
    })
    const { element } = await open()
    await mousedown(revertButtons(cardOf(element, APP))[0])

    expect(modifiedEditor(cardOf(element, APP)).state.sliceDoc()).toBe(TWO_CHANGES.modified)
    expect(fake.toasts).toEqual([['Revert failed', 'disk full']])
    expect(revertButtons(cardOf(element, APP))).toHaveLength(2)
  })

  test('a file that changed on disk is refused and the card is restored', async () => {
    fake.on('quirky.git/save', () => {
      throw failure('changed since you looked', { reason: 'changed-on-disk' })
    })
    const { element } = await open()
    await mousedown(revertButtons(cardOf(element, APP))[0])

    expect(modifiedEditor(cardOf(element, APP)).state.sliceDoc()).toBe(TWO_CHANGES.modified)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]![0]).toBe('Revert failed')
  })

  test('a reviewed card is offered Revert too', async () => {
    const { element } = await open({ worktree: 'w1', mode: 'review', reveal: README })
    expect(revertButtons(cardOf(element, README))).toHaveLength(2)
    await mousedown(revertButtons(cardOf(element, README))[0])
    expect(saves[0]).toMatchObject({ path: README, expected: 'h1' })
  })

  test('the hash a revert saved is the one the next mark carries', async () => {
    fake.on('quirky.git/setReviewMark', () => ({}))
    const { element } = await open()
    await mousedown(revertButtons(cardOf(element, APP))[0])
    const mark = [...cardOf(element, APP).querySelectorAll('button')].find((b) => b.textContent === 'Mark reviewed')!
    await act(async () => void mark.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(fake.called('quirky.git/setReviewMark').at(-1)!.params).toMatchObject({ path: APP, reviewed: true, expected: 'h2' })
  })

  test('a commit scope has no Revert, because its modified side is not the disk', async () => {
    fake.on('quirky.git/diff', diffBody({ source: 'commit' }))
    const { element } = await open({ worktree: 'w1', mode: 'review', commit: COMMIT })
    expect(element.querySelector('[data-diff-editor]')).not.toBeNull()
    expect(revertButtons(element)).toHaveLength(0)
    expect(element.textContent).not.toContain('Revert')
  })

  test('a deleted file has no disk side to revert onto', async () => {
    model = reviewModel([reviewFile('gone.ts', { status: 'D', added: 0, removed: 3 })])
    fake.on('quirky.git/diff', () =>
      textDiff({ path: 'gone.ts', source: 'review', original: 'a\nb\nc\n', modified: '', modifiedHash: null, modifiedDeleted: true })
    )
    const { element } = await open()
    expect(element.querySelector('[data-diff-editor]')).not.toBeNull()
    expect(revertButtons(element)).toHaveLength(0)
  })

  test('side by side offers the same buttons and the same confirm and save', async () => {
    const { element } = await open()
    await resize.resize(1000)
    await wait(60)
    const buttons = [...cardOf(element, APP).querySelectorAll<HTMLButtonElement>('button[aria-label="Revert change"]')]
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.textContent).toBe('↶')

    await mousedown(buttons[0])
    expect(confirmations).toHaveLength(1)
    expect(saves).toEqual([{ worktree: 'w1', path: APP, content: expectedAfterFirst, expected: 'h1' }])
  })

  test('the revert-change command goes through the same confirm and save', async () => {
    const { element } = await open()
    const view = modifiedEditor(cardOf(element, APP))
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
    })
    await act(async () => void (await commandHandlers(fake.context)['revert-change']!()))
    await wait(30)
    expect(confirmations).toHaveLength(1)
    expect(saves[0]!.content).toBe(expectedAfterFirst)
  })
})

describe('the add-note control is reachable from the cursor line', () => {
  const addButton = (root: ParentNode, line: number) => byLabel(root, `Add note on line ${line}`)

  test('moving the cursor to a line shows its control with an accessible name', async () => {
    const { element } = await open()
    const view = modifiedEditor(cardOf(element, APP))
    expect(addButton(element, 12)).toBeNull()

    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(12).from } })
    })
    await settle()
    const button = addButton(element, 12)!
    expect(button).not.toBeNull()
    expect(button.textContent).toBe('+')
    expect(button.dataset.line).toBe('12')

    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(14).from } })
    })
    await settle()
    expect(addButton(element, 12)).toBeNull()
    expect(addButton(element, 14)).not.toBeNull()
  })

  test('the hovered line keeps its control beside the cursor line, under the same name', async () => {
    const { element } = await open()
    const view = modifiedEditor(cardOf(element, APP))
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(5).from } })
    })
    const line = view.domAtPos(view.state.doc.line(9).from).node
    const target = line instanceof Element ? line : line.parentElement!
    await act(async () => void target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
    await settle()
    expect(addButton(element, 5)).not.toBeNull()
    expect(addButton(element, 9)).not.toBeNull()
  })

  test('the control opens a note draft on its line', async () => {
    const { element } = await open()
    const view = modifiedEditor(cardOf(element, APP))
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(7).from } })
    })
    await settle()
    await act(async () => void addButton(element, 7)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await settle()
    expect(element.querySelector('[data-note-card="draft"]')?.textContent).toContain('Line 7')
  })
})

describe('opening a note reveals its file in the Review tab', () => {
  const note = { id: 'n1', worktreeId: 'w1', path: APP, startLine: 10, line: 10, body: 'Look here', createdAt: 1, updatedAt: null }

  test('the note input is a review input for its file', () => {
    expect(noteViewInput(APP, 'n1', [], null)).toEqual({ mode: 'review', reveal: APP, noteId: 'n1' })
    const staged: GitStatusEntry[] = [{ path: APP, area: 'staged', status: 'modified' }]
    expect(noteViewInput(APP, 'n1', staged, null)).toEqual({ mode: 'review', reveal: APP, noteId: 'n1' })
  })

  test('a note on a conflicted file still opens the conflict file view', () => {
    const conflicted: GitStatusEntry[] = [{ path: 'b.ts', area: 'conflicts', status: 'modified' }]
    expect(noteViewInput('b.ts', 'n2', conflicted, null)).toEqual({ mode: 'conflict-file', path: 'b.ts' })
  })

  test('openReview with the note shows its card in the revealed file', async () => {
    fake.on('quirky.git/notes', () => ({ notes: [note] }))
    const { element } = await open({ worktree: 'w1', ...noteViewInput(APP, 'n1', [], null) })
    expect(cardOf(element, APP).querySelector('[data-note-card="saved"]')?.textContent).toContain('Look here')
    expect(scrolled).toContain(cardOf(element, APP))
  })

  test('openReview from a note opens the one tab with the note id and reveals it in a mounted tab', async () => {
    await openReview(fake.context, { worktree: 'w1', reveal: APP, noteId: 'n1' })
    expect(fake.called('quirky.terminal/openViewTab').at(-1)!.params.input).toMatchObject({ mode: 'review', reveal: APP, noteId: 'n1' })
  })
})

describe('what the legacy views covered still holds in a card', () => {
  const lines = (n: number) => numbered(n)

  test('SC-63: image, binary and too-large cards show their fallbacks', async () => {
    model = reviewModel([reviewFile('logo.png'), reviewFile('blob.bin', { binary: true }), reviewFile('big.txt')])
    fake.on('quirky.git/diff', (params) => {
      const path = params.path as string
      if (path === 'logo.png') return textDiff({ path, source: 'review', kind: 'image', binary: true, mime: 'image/png', original: 'iVBORw0KGgo=', modified: 'iVBORw0KGgo=' })
      if (path === 'blob.bin') return textDiff({ path, source: 'review', kind: 'binary' as never, binary: true, original: '', modified: '' })
      return textDiff({ path, source: 'review', original: '', modified: '', tooLarge: { originalLines: 130_000, modifiedLines: 130_000, characters: 10, reason: 'lines' } })
    })
    const { element } = await open()
    expect(cardOf(element, 'logo.png').querySelectorAll('img')).toHaveLength(2)
    expect(cardOf(element, 'blob.bin').textContent).toContain('Binary file changed')
    expect(cardOf(element, 'big.txt').textContent).toContain('too large to display safely')
  })

  test('SC-62: a card whose diff fails shows git\'s message and retries', async () => {
    let fail = true
    fake.on('quirky.git/diff', (params) => {
      if (fail) throw new Error('git exploded')
      return textDiff({ path: params.path as string, source: 'review', original: lines(5), modified: lines(5).replace('line 2\n', 'two\n') })
    })
    const { element } = await open()
    expect(cardOf(element, APP).textContent).toContain('git exploded')
    fail = false
    const retry = [...cardOf(element, APP).querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
    await act(async () => void retry.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(cardOf(element, APP).querySelector('[data-diff-editor]')).not.toBeNull()
  })

  test('SC-62: a card whose size is unknown loads on request and says so', async () => {
    model = reviewModel([reviewFile('mystery.txt', { added: null, removed: null })])
    const { element } = await open()
    expect(cardOf(element, 'mystery.txt').textContent).toContain("size isn't known yet")
    expect(fake.called('quirky.git/diff')).toHaveLength(0)
    const load = [...cardOf(element, 'mystery.txt').querySelectorAll('button')].find((b) => b.textContent === 'Load diff')!
    await act(async () => void load.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(fake.called('quirky.git/diff')).toHaveLength(1)
  })

  test('SC-60: F7 and Shift+F7 walk the changes across cards and wrap', async () => {
    model = reviewModel([reviewFile('a.ts'), reviewFile('b.ts')])
    fake.on('quirky.git/diff', (params) => textDiff({ path: params.path as string, source: 'review', original: lines(30), modified: lines(30).replace('line 3\n', 'x\n').replace('line 25\n', 'y\n') }))
    const { element } = await open()
    const lineOf = (path: string) => {
      const view = modifiedEditor(cardOf(element, path))
      return view.state.doc.lineAt(view.state.selection.main.head).text
    }
    const fire = (command: 'next-change' | 'previous-change') => act(async () => void (await commandHandlers(fake.context)[command]!()))

    await fire('next-change')
    expect(lineOf('a.ts')).toBe('x')
    await fire('next-change')
    expect(lineOf('a.ts')).toBe('y')
    await fire('next-change')
    expect(lineOf('b.ts')).toBe('x')
    await fire('previous-change')
    expect(lineOf('a.ts')).toBe('y')
  })

  test('SC-64: load-diff and collapse-all reach the open Review tab', async () => {
    model = reviewModel([reviewFile('huge.txt', { added: 12_000, removed: 0 }), reviewFile(APP)])
    const { element } = await open()
    const commands = commandHandlers(fake.context)
    expect(fake.called('quirky.git/diff').map((c) => c.params.path)).toEqual([APP])
    await act(async () => void (await commands['load-diff']!({ path: 'huge.txt' })))
    await settle()
    expect(fake.called('quirky.git/diff').map((c) => c.params.path)).toContain('huge.txt')
    await expect(commands['load-diff']!({ path: 'nothere.txt' })).rejects.toThrow('No section for nothere.txt.')

    await act(async () => void commands['collapse-all']!({ collapsed: true }))
    await settle()
    expect([...element.querySelectorAll<HTMLElement>('[data-review-body]')].every((body) => body.hidden)).toBe(true)
  })
})
