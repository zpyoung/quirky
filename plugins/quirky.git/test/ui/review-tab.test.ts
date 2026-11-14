import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode, type GitDiff, type GitStatusEntry, type ReviewFile, type ReviewModel } from '@quirky/protocol'
import { registerDom } from './register-dom'

registerDom()
const s = await import('./support')
const { reviewViewFor } = await import('../../src/review/open')
const { onSelectedPath, selectedPath, selectPath } = await import('../../src/review/selection')
const { deferReview, openDiffView, takeDeferredReview } = await import('../../src/view/registry')
afterAll(() => GlobalRegistrator.unregister())

const {
  act, byLabel, byText, click, edit, failure, fakeContext, layoutFor, modifiedEditor, mountView, numbered, reviewFile, reviewModel, settle,
  status, stubIntersectionObserver, stubResizeObserver, textDiff
} = s

const COMMIT = 'f5429a1'.padEnd(40, '0')
const README = 'README.md'
const APP = 'src/app.ts'
const ENABLED = 'src/feature/enabled.ts'
const FLAGS = 'src/feature/flags.ts'

const sourceEntry = (path: string, area: GitStatusEntry['area'], entryStatus: GitStatusEntry['status'] = 'modified'): GitStatusEntry => ({
  path,
  area,
  status: entryStatus,
  added: 1,
  removed: 0,
  binary: false
})

const initialFiles = (): ReviewFile[] => [
  reviewFile(README, { mark: 'reviewed' }),
  reviewFile(APP),
  reviewFile(ENABLED, { notes: 2 }),
  reviewFile(FLAGS, { mark: 'changed' })
]

let fake: ReturnType<typeof fakeContext>
let mounted: ReturnType<typeof mountView> | null = null
let intersection: ReturnType<typeof stubIntersectionObserver>
let resize: ReturnType<typeof stubResizeObserver>
let model: ReviewModel
let diffBody: (path: string, against: string) => Partial<GitDiff>
let scrolled: Element[]
let originalScroll: typeof Element.prototype.scrollIntoView

const conflict = () =>
  Object.assign(failure('changed since you looked', 'changed-on-disk'), { code: RpcErrorCode.Conflict })

const open = async (input: object = { worktree: 'w1', mode: 'review' }) => {
  mounted = mountView(fake, input)
  await settle()
  return mounted.element
}

const card = (root: ParentNode, path: string) => root.querySelector<HTMLElement>(`section[data-path="${path}"]`)!
const order = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('section[data-path]')].map((el) => el.dataset.path)
const bodyOf = (root: ParentNode, path: string) => card(root, path).querySelector<HTMLElement>('[data-review-body]')!
const toggleOf = (root: ParentNode, path: string) => card(root, path).querySelector<HTMLButtonElement>('button[aria-expanded]')!
const diffCalls = () => fake.callsTo('quirky.git/diff').map((c) => [c.params.path, c.params.against])
const refreshModel = async () => {
  await act(async () => fake.emit({ type: 'quirky.git/reviewChanged', data: { worktreeId: 'w1' } } as never))
  await settle()
}
const select = async (path: string | null, origin: 'panel' | 'review' = 'panel') => {
  await act(async () => selectPath('w1', path, origin))
  await settle()
}
const setMark = async (path: string, mark: ReviewFile['mark']) => {
  model = reviewModel(model.files.map((f) => (f.path === path ? { ...f, mark } : f)))
  await refreshModel()
}

const draftReview = async () => {
  const element = await open()
  act(() => card(element, APP).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
  edit(element, 'draft text\n')
  await settle()
  element.querySelector<HTMLElement>('[data-review-scroll]')!.scrollTop = 321
  return element
}

const expectDraftPreserved = (element: HTMLElement) => {
  expect(element.querySelector('.ui-scope-chip')).toBeNull()
  expect(order(element)).toEqual([README, APP, ENABLED, FLAGS])
  expect(card(element, APP).getAttribute('data-active')).toBe('')
  expect(modifiedEditor(element).state.doc.toString()).toBe('draft text\n')
  expect(element.querySelector<HTMLElement>('[data-review-scroll]')!.scrollTop).toBe(321)
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
  intersection = stubIntersectionObserver()
  resize = stubResizeObserver()
  model = reviewModel(initialFiles())
  diffBody = (path, against) => ({
    original: `${against}\n${numbered(10, 'line')}`,
    modified: `${against}\n${numbered(10, 'line').replace('line 5', 'five')}`
  })
  fake.handlers['quirky.git/review'] = () => model
  fake.handlers['quirky.git/diff'] = (params) =>
    textDiff({
      path: params.path as string,
      source: params.source as GitDiff['source'],
      modifiedHash: `hash:${params.path}`,
      ...diffBody(params.path as string, String(params.against ?? params.source))
    })
  fake.handlers['quirky.git/setReviewMark'] = (params) => {
    const reviewed = params.reviewed === true
    model = reviewModel(model.files.map((f) => (f.path === params.path ? { ...f, mark: reviewed ? 'reviewed' : 'none' } : f)))
    return {}
  }
  fake.handlers['quirky.git/commitFiles'] = (params) => ({
    commit: String(params.commit),
    entries: [
      { path: 'a.ts', status: 'modified', added: 1, removed: 1, binary: false },
      { path: 'b.ts', status: 'added', added: 4, removed: 0, binary: false }
    ]
  })
  scrolled = []
  originalScroll = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  selectPath('w1', null, 'panel')
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  intersection.restore()
  resize.restore()
  Element.prototype.scrollIntoView = originalScroll
})

describe('quirky.git review tab', () => {
  test('SC-1: the header counts files and reviewed files against the base', async () => {
    const element = await open()
    expect(element.querySelector('[data-review-summary]')?.textContent).toBe('feat vs main · 4 files · 1 reviewed')
    expect(byText(element, 'Collapse all')).not.toBeNull()
    expect(byLabel(element, 'Switch to side-by-side diff')).not.toBeNull()
    expect(byLabel(element, 'More actions')).not.toBeNull()
  })

  test('SC-1: cards stack in path order, or tree order when the panel is in tree mode', async () => {
    model = reviewModel([reviewFile('zed.ts'), reviewFile('src/b.ts'), reviewFile('src/z/q.ts'), reviewFile('src/a.ts')])
    const element = await open()
    expect(order(element)).toEqual(['src/a.ts', 'src/b.ts', 'src/z/q.ts', 'zed.ts'])
    fake.settings.viewMode = 'tree'
    await act(async () => fake.emit({ type: 'setting.changed', id: 'setting:quirky.git/viewMode', value: 'tree' }))
    await settle()
    expect(order(element)).toEqual(['src/z/q.ts', 'src/a.ts', 'src/b.ts', 'zed.ts'])
  })

  test('SC-1: the card header carries the counts, note count, mark and mark button', async () => {
    const element = await open()
    const enabled = card(element, ENABLED)
    expect(enabled.textContent).toContain('+2')
    expect(enabled.textContent).toContain('-1')
    expect(enabled.textContent).toContain('✎ 2 notes')
    expect(card(element, APP).textContent).not.toContain('✎')
    expect(byText(enabled, 'Mark reviewed')).not.toBeNull()
    expect(enabled.querySelector('[role="img"][aria-label="Not reviewed"]')).not.toBeNull()
    expect(byText(card(element, README), '✓ Reviewed')).not.toBeNull()
    expect(byText(card(element, FLAGS), '● Changed since review')).not.toBeNull()
  })

  test('SC-4: reviewed cards start collapsed and the others expanded', async () => {
    const element = await open()
    expect(bodyOf(element, README).hidden).toBe(true)
    expect(toggleOf(element, README).getAttribute('aria-expanded')).toBe('false')
    for (const path of [APP, ENABLED, FLAGS]) expect(bodyOf(element, path).hidden).toBe(false)
    expect(diffCalls().map(([path]) => path)).not.toContain(README)
  })

  test('SC-4: a manual expand holds across refreshes and resets when the mark changes', async () => {
    const element = await open()
    await click(toggleOf(element, README))
    expect(bodyOf(element, README).hidden).toBe(false)
    await refreshModel()
    expect(bodyOf(element, README).hidden).toBe(false)

    await setMark(README, 'none')
    expect(bodyOf(element, README).hidden).toBe(false)
    await click(toggleOf(element, README))
    expect(bodyOf(element, README).hidden).toBe(true)
    await refreshModel()
    expect(bodyOf(element, README).hidden).toBe(true)

    await setMark(README, 'reviewed')
    expect(bodyOf(element, README).hidden).toBe(true)
    await setMark(README, 'changed')
    expect(bodyOf(element, README).hidden).toBe(false)
  })

  test('Collapse all folds every card, and the button then expands them again', async () => {
    const element = await open()
    await click(byText(element, 'Collapse all'))
    for (const path of order(element)) expect(bodyOf(element, path!).hidden).toBe(true)
    await click(byText(element, 'Expand all'))
    for (const path of order(element)) expect(bodyOf(element, path!).hidden).toBe(false)
  })

  test('SC-4: marking reviewed sends the loaded hash, then selects and reveals the next unreviewed card', async () => {
    const element = await open()
    await select(ENABLED)
    const origins: string[] = []
    const off = onSelectedPath('w1', (path, origin) => void origins.push(`${origin}:${path}`))
    scrolled.length = 0
    await click(byText(card(element, ENABLED), 'Mark reviewed'))
    off()

    expect(fake.callsTo('quirky.git/setReviewMark')[0]!.params).toEqual({
      worktree: 'w1',
      path: ENABLED,
      reviewed: true,
      expected: `hash:${ENABLED}`
    })
    expect(origins).toEqual([`review:${FLAGS}`])
    expect(selectedPath('w1')).toBe(FLAGS)
    expect(scrolled).toContain(card(element, FLAGS))
    expect(byText(card(element, ENABLED), '✓ Reviewed')).not.toBeNull()
    expect(bodyOf(element, ENABLED).hidden).toBe(true)
    expect(element.querySelector('[data-review-summary]')?.textContent).toContain('2 reviewed')
  })

  test('SC-4: when no unreviewed file is left the selection stays put', async () => {
    model = reviewModel([reviewFile(APP), reviewFile(README, { mark: 'reviewed' })])
    const element = await open()
    await select(APP)
    scrolled.length = 0
    await click(byText(card(element, APP), 'Mark reviewed'))
    expect(selectedPath('w1')).toBe(APP)
    expect(scrolled.length).toBe(0)
  })

  test('a conflict refreshes the model and leaves the mark and the selection alone', async () => {
    const element = await open()
    await select(ENABLED)
    fake.handlers['quirky.git/setReviewMark'] = () => {
      throw conflict()
    }
    const reads = fake.callsTo('quirky.git/review').length
    await click(byText(card(element, ENABLED), 'Mark reviewed'))
    expect(byText(card(element, ENABLED), 'Mark reviewed')).not.toBeNull()
    expect(selectedPath('w1')).toBe(ENABLED)
    expect(fake.callsTo('quirky.git/review').length).toBeGreaterThan(reads)
    expect(fake.toasts).toEqual([])
  })

  test('clicking ✓ Reviewed clears the mark without moving the selection', async () => {
    const element = await open()
    await select(APP)
    await click(byText(card(element, README), '✓ Reviewed'))
    expect(fake.callsTo('quirky.git/setReviewMark')[0]!.params).toMatchObject({ path: README, reviewed: false })
    expect(byText(card(element, README), 'Mark reviewed')).not.toBeNull()
    expect(selectedPath('w1')).toBe(APP)
  })

  test('SC-5: a changed card shows the changes since review, and Full diff switches it to the base', async () => {
    const element = await open()
    const flags = card(element, FLAGS)
    expect(diffCalls()).toContainEqual([FLAGS, 'reviewed'])
    expect(flags.textContent).toContain('Showing changes since you reviewed')
    expect(modifiedEditor(flags).state.doc.toString()).toContain('reviewed')

    await click(byText(flags, 'Full diff'))
    expect(diffCalls().at(-1)).toEqual([FLAGS, 'base'])
    expect(card(element, FLAGS).textContent).not.toContain('Showing changes since you reviewed')
    expect(modifiedEditor(card(element, FLAGS)).state.doc.toString()).toContain('base')

    await setMark(FLAGS, 'reviewed')
    await setMark(FLAGS, 'changed')
    expect(card(element, FLAGS).textContent).toContain('Showing changes since you reviewed')
    expect(diffCalls().at(-1)).toEqual([FLAGS, 'reviewed'])
  })

  test('a refresh that leaves the diff unchanged keeps the loaded editor; changed content rebuilds it', async () => {
    const element = await open()
    const editor = () => card(element, APP).querySelector('.cm-editor')
    const before = editor()
    expect(before).not.toBeNull()

    model = reviewModel(model.files.map((f) => (f.path === APP ? { ...f, added: 3 } : f)))
    await refreshModel()
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
    await settle()
    expect(editor()).toBe(before)

    const loads = diffCalls().length
    diffBody = (path, against) => ({ original: 'a\n', modified: `${against}\nedited ${path}\n` })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
    await settle()
    expect(diffCalls().length).toBeGreaterThan(loads)
    expect(editor()).not.toBe(before)
  })

  test('a card edited on disk while folded shows the new content when expanded, with its counts unchanged', async () => {
    model = reviewModel([reviewFile(APP)])
    let disk = 'old\n'
    fake.handlers['quirky.git/diff'] = (params) =>
      textDiff({ path: params.path as string, source: 'review', original: 'base\n', modified: disk, modifiedHash: disk })
    const element = await open()
    await click(toggleOf(element, APP))
    expect(bodyOf(element, APP).hidden).toBe(true)

    disk = 'new\n'
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
    await settle()
    await click(toggleOf(element, APP))
    await settle()
    expect(modifiedEditor(card(element, APP)).state.sliceDoc()).toBe('new\n')
  })

  test('expanding a card while an earlier refresh of it is still in flight reads again, so it never shows older content than disk', async () => {
    model = reviewModel([reviewFile(APP)])
    let disk = 'first\n'
    let gate: { started: () => void; release: Promise<void> } | null = null
    fake.handlers['quirky.git/diff'] = async (params) => {
      const snapshot = disk
      const held = gate
      gate = null
      if (held) {
        held.started()
        await held.release
      }
      return textDiff({ path: params.path as string, source: 'review', original: 'base\n', modified: snapshot, modifiedHash: snapshot })
    }
    const element = await open()
    let release!: () => void
    let started!: () => void
    const reading = new Promise<void>((r) => (started = r))
    gate = { started, release: new Promise<void>((r) => (release = r)) }
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
    await reading

    await click(toggleOf(element, APP))
    disk = 'second\n'
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
    await settle()
    await click(toggleOf(element, APP))
    await act(async () => release())
    await settle()
    expect(modifiedEditor(card(element, APP)).state.sliceDoc()).toBe('second\n')
  })

  describe('a card never stays behind the disk', () => {
    type Gate = { started: Promise<void>; release(): void; fail(): void }
    let disk: string
    let hold: () => Gate
    const changed = () => act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
    const shown = (element: ParentNode) => modifiedEditor(card(element, APP)).state.sliceDoc()
    const reads = () => fake.callsTo('quirky.git/diff').length

    beforeEach(() => {
      model = reviewModel([reviewFile(APP)])
      disk = 'first\n'
      let next: { started(): void; settled: Promise<void> } | null = null
      hold = () => {
        let release!: () => void
        let fail!: () => void
        let started!: () => void
        const settled = new Promise<void>((resolve, reject) => {
          release = resolve
          fail = () => reject(new Error('read failed'))
        })
        const gate: Gate = { started: new Promise<void>((r) => (started = r)), release, fail }
        next = { started, settled }
        return gate
      }
      fake.handlers['quirky.git/diff'] = async (params) => {
        const snapshot = disk
        const held = next
        next = null
        if (held) {
          held.started()
          await held.settled
        }
        return textDiff({ path: params.path as string, source: 'review', original: 'base\n', modified: snapshot, modifiedHash: snapshot })
      }
    })

    test('a read that rejects while its card was folded and reopened is retried by the next expansion', async () => {
      const element = await open()
      const gate = hold()
      await changed()
      await gate.started
      await click(toggleOf(element, APP))
      await click(toggleOf(element, APP))
      await act(async () => gate.fail())
      await settle()
      expect(card(element, APP).textContent).toContain('read failed')

      disk = 'second\n'
      await click(toggleOf(element, APP))
      const folded = reads()
      await click(toggleOf(element, APP))
      await settle()
      expect(reads()).toBe(folded + 1)
      expect(shown(element)).toBe('second\n')
    })

    test('a read that rejects is retried by the next refresh', async () => {
      const element = await open()
      const gate = hold()
      await changed()
      await gate.started
      disk = 'second\n'
      await act(async () => gate.fail())
      await settle()
      expect(card(element, APP).textContent).toContain('read failed')

      await changed()
      await settle()
      expect(shown(element)).toBe('second\n')
    })

    test('an invalidation during an in-flight read is read once that read lands', async () => {
      const element = await open()
      const gate = hold()
      await changed()
      await gate.started
      const during = reads()
      disk = 'second\n'
      await changed()
      await changed()
      expect(reads()).toBe(during)
      await act(async () => gate.release())
      await settle()
      expect(reads()).toBe(during + 1)
      expect(shown(element)).toBe('second\n')
    })

    test('a folded card that missed several refreshes reads once when it is expanded', async () => {
      const element = await open()
      await click(toggleOf(element, APP))
      const folded = reads()
      for (const text of ['one\n', 'two\n', 'three\n']) {
        disk = text
        await changed()
      }
      await settle()
      expect(reads()).toBe(folded)

      await click(toggleOf(element, APP))
      await settle()
      expect(reads()).toBe(folded + 1)
      expect(shown(element)).toBe('three\n')
    })
  })

  test('F7 expands a folded card it moves into, so the active change is visible', async () => {
    model = reviewModel([reviewFile('a.ts'), reviewFile('b.ts')])
    diffBody = () => ({ original: numbered(10, 'line'), modified: numbered(10, 'line').replace('line 5', 'five') })
    const element = await open()
    await click(toggleOf(element, 'b.ts'))
    expect(bodyOf(element, 'b.ts').hidden).toBe(true)

    await act(async () => openDiffView()!.nextChange())
    await act(async () => openDiffView()!.nextChange())
    await settle()
    expect(card(element, 'b.ts').hasAttribute('data-active')).toBe(true)
    expect(bodyOf(element, 'b.ts').hidden).toBe(false)
  })

  test('a failing review read after a good one says the tab may be out of date, Retry reads again, and success clears it', async () => {
    const element = await open()
    expect(element.querySelector('[role=alert]')).toBeNull()

    fake.handlers['quirky.git/review'] = () => {
      throw new Error('repository unavailable')
    }
    await refreshModel()
    const alert = element.querySelector('[role=alert]')!
    expect(alert.textContent).toContain('repository unavailable')
    expect(order(element)).toEqual([README, APP, ENABLED, FLAGS])

    fake.handlers['quirky.git/review'] = () => model
    await click(byText(alert as HTMLElement, 'Retry'))
    await settle()
    expect(element.querySelector('[role=alert]')).toBeNull()
  })

  test('SC-15: inline below 900px and side-by-side from 900px, and the toggle overrides the width', async () => {
    fake.settings.diffDefaultView = 'side-by-side'
    const element = await open()
    const panes = () => card(element, APP).querySelectorAll('.cm-mergeViewEditor').length

    await resize.resize(899)
    expect(panes()).toBe(0)
    await resize.resize(900)
    expect(panes()).toBe(2)
    await resize.resize(500)
    expect(panes()).toBe(0)

    await click(byLabel(element, 'Switch to side-by-side diff'))
    expect(panes()).toBe(2)
    await resize.resize(1600)
    await resize.resize(400)
    expect(panes()).toBe(2)
    await click(byLabel(element, 'Switch to inline diff'))
    await resize.resize(1600)
    expect(panes()).toBe(0)
    expect(fake.calls.some((c) => c.method === 'setting.set' && String(c.params.id).endsWith('diffDefaultView'))).toBe(false)
  })

  test('the more-actions menu toggles word wrap and whitespace', async () => {
    const element = await open()
    await click(byLabel(element, 'More actions'))
    const item = (name: string) => [...element.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((b) => b.textContent!.includes(name))
    await click(item('Word wrap'))
    expect(fake.settings.diffWordWrap).toBe(true)
    await click(byLabel(element, 'More actions'))
    await click(item('Show whitespace'))
    expect(fake.settings.diffShowWhitespace).toBe(true)
  })

  test('SC-3: the mounted tab registers a handle that reveals, expands and activates a card', async () => {
    const element = await open()
    const handle = reviewViewFor('w1')!
    expect(handle.worktree).toBe('w1')

    scrolled.length = 0
    act(() => handle.reveal(README))
    await settle()
    expect(bodyOf(element, README).hidden).toBe(false)
    expect(scrolled).toContain(card(element, README))
    expect(diffCalls()).toContainEqual([README, 'base'])

    act(() => handle.reveal(FLAGS))
    await settle()
    act(() => openDiffView()!.nextChange())
    await settle()
    const editors = [...element.querySelectorAll('[data-diff-editor]')]
    const flagsEditor = modifiedEditor(element, editors.indexOf(card(element, FLAGS).querySelector('[data-diff-editor]')!))
    expect(flagsEditor.state.selection.main.head).toBeGreaterThan(0)
    const appEditor = modifiedEditor(element, editors.indexOf(card(element, APP).querySelector('[data-diff-editor]')!))
    expect(appEditor.state.selection.main.head).toBe(0)
  })

  test('SC-3: revealing a path waits for the card to exist', async () => {
    model = reviewModel([reviewFile(APP)])
    const element = await open({ worktree: 'w1', mode: 'review', reveal: 'late.ts' })
    scrolled.length = 0
    model = reviewModel([reviewFile(APP), reviewFile('late.ts')])
    await refreshModel()
    expect(scrolled).toContain(card(element, 'late.ts'))
  })

  test('SC-3: the input reveal scrolls to its card once it is drawn', async () => {
    const element = await open({ worktree: 'w1', mode: 'review', reveal: ENABLED })
    expect(scrolled).toContain(card(element, ENABLED))
  })

  test('SC-3: scrollToTop returns the stack to its first card', async () => {
    const element = await open()
    const scroller = element.querySelector<HTMLElement>('[data-review-scroll]')!
    scroller.scrollTop = 400
    act(() => reviewViewFor('w1')!.scrollToTop())
    expect(scroller.scrollTop).toBe(0)
  })

  test('the handle is dropped when the tab unmounts', async () => {
    await open()
    expect(reviewViewFor('w1')).not.toBeNull()
    mounted!.unmount()
    mounted = null
    expect(reviewViewFor('w1')).toBeNull()
  })

  test('the panel moving the selection reveals that card; the tab moving it does not echo', async () => {
    const element = await open()
    scrolled.length = 0
    await select(APP)
    expect(scrolled.length).toBe(1)
    expect(scrolled[0]).toBe(card(element, APP))
    await select(ENABLED, 'review')
    await select('not-a-card.ts')
    expect(scrolled.length).toBe(1)
  })

  test('13: staged and unstaged scopes use status entries and refresh without review controls', async () => {
    const entries = [
      sourceEntry(README, 'staged'),
      sourceEntry(APP, 'unstaged'),
      sourceEntry('src/new.ts', 'staged', 'added'),
      sourceEntry('notes.txt', 'untracked', 'untracked')
    ]
    let currentStatus = status(entries)
    fake.handlers['quirky.git/status'] = () => currentStatus

    let element = await open({ worktree: 'w1', mode: 'review', source: 'staged' })
    expect(order(element)).toEqual([README, 'src/new.ts'])
    expect(element.querySelector('.ui-scope-chip')?.textContent).toContain('Staged changes')
    for (const path of order(element)) {
      expect(byText(card(element, path!), 'Mark reviewed')).toBeNull()
      expect(card(element, path!).querySelector('[contenteditable="true"]')).toBeNull()
    }
    expect(fake.callsTo('quirky.git/diff').map(({ params }) => params)).toEqual([
      { worktree: 'w1', path: README, source: 'staged' },
      { worktree: 'w1', path: 'src/new.ts', source: 'staged' }
    ])
    expect(mounted!.report()).toMatchObject({ source: 'staged', commit: null })

    const reads = fake.callsTo('quirky.git/status').length
    currentStatus = status([...entries, sourceEntry('z.ts', 'staged', 'added')])
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
    await settle()
    expect(fake.callsTo('quirky.git/status').length).toBeGreaterThan(reads)
    expect(order(element)).toEqual([README, 'src/new.ts', 'z.ts'])

    mounted!.unmount()
    mounted = null
    element = await open({ worktree: 'w1', mode: 'review', source: 'unstaged' })
    expect(order(element)).toEqual(['notes.txt', APP])
    expect(element.querySelector('.ui-scope-chip')?.textContent).toContain('Unstaged changes')
    for (const path of order(element)) expect(byText(card(element, path!), 'Mark reviewed')).toBeNull()
    expect(card(element, APP).querySelector('[contenteditable="true"]')).not.toBeNull()
    expect(fake.callsTo('quirky.git/diff').slice(-2).map(({ params }) => params)).toEqual([
      { worktree: 'w1', path: 'notes.txt', source: 'unstaged' },
      { worktree: 'w1', path: APP, source: 'unstaged' }
    ])
    expect(mounted!.report()).toMatchObject({ source: 'unstaged', commit: null })
  })

  test('13: empty and capped source scopes explain their completeness', async () => {
    let currentStatus = status([sourceEntry(APP, 'unstaged')])
    fake.handlers['quirky.git/status'] = () => currentStatus
    const element = await open({ worktree: 'w1', mode: 'review', source: 'staged' })
    expect(element.textContent).toContain('No staged changes')

    currentStatus = { ...status([sourceEntry(README, 'staged')]), capped: true }
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
    await settle()
    const notice = [...element.querySelectorAll<HTMLElement>('.git-review__notice')].find((node) =>
      node.textContent?.includes('Git status stopped at its entry limit, so this list is incomplete.')
    )!
    expect(notice).not.toBeNull()
    expect(notice.compareDocumentPosition(card(element, README)) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  test('13: a deferred review request is consumed before the stored input is applied', async () => {
    fake.handlers['quirky.git/status'] = () => status([sourceEntry(APP, 'unstaged')])
    deferReview('w1', { reveal: APP, source: 'unstaged' })
    const element = await open()
    expect(element.querySelector('.ui-scope-chip')?.textContent).toContain('Unstaged changes')
    expect(card(element, APP).getAttribute('data-active')).toBe('')
    expect(takeDeferredReview('w1')).toBeUndefined()
  })

  test('13: a deferred reveal-only request replaces stored staged and commit scopes', async () => {
    const storedInputs = [
      { source: 'staged' as const, reveal: README, noteId: 'stale-note' },
      { commit: COMMIT, reveal: README, noteId: 'stale-note' }
    ]
    for (const stored of storedInputs) {
      deferReview('w1', { reveal: APP })
      const element = await open({ worktree: 'w1', mode: 'review', ...stored })
      expect(element.querySelector('.ui-scope-chip')).toBeNull()
      expect(order(element)).toEqual([README, APP, ENABLED, FLAGS])
      expect(card(element, APP).getAttribute('data-active')).toBe('')
      expect(card(element, README).getAttribute('data-active')).toBeNull()
      expect(fake.callsTo('quirky.git/commitFiles')).toHaveLength(0)
      mounted!.unmount()
      mounted = null
    }
  })

  test('13: an empty deferred request clears stored scope, reveal, and note target', async () => {
    deferReview('w1', {})
    const element = await open({ worktree: 'w1', mode: 'review', source: 'staged', reveal: APP, noteId: 'stale-note' })
    expect(element.querySelector('.ui-scope-chip')).toBeNull()
    expect(order(element)).toEqual([README, APP, ENABLED, FLAGS])
    expect(element.querySelector('[data-active]')).toBeNull()
    expect(takeDeferredReview('w1')).toBeUndefined()
  })

  test('13b: applyScope applies without a draft and reports an unchanged scope without asking', async () => {
    const element = await open()
    const handle = reviewViewFor('w1')!
    expect(await handle.applyScope!({ source: 'staged' }, 'refuse')).toBe('applied')
    expect(element.querySelector('.ui-scope-chip')?.textContent).toContain('Staged changes')

    let confirms = 0
    fake.context.confirm = async () => {
      confirms++
      return true
    }
    expect(await handle.applyScope!({ source: 'staged' }, 'ask')).toBe('unchanged')
    expect(confirms).toBe(0)
  })

  test('13b: refuse reports dirty and preserves the active draft and scroll without asking', async () => {
    const element = await draftReview()
    let confirms = 0
    fake.context.confirm = async () => {
      confirms++
      return true
    }
    expect(await reviewViewFor('w1')!.applyScope!({ source: 'staged' }, 'refuse')).toBe('dirty')
    expect(confirms).toBe(0)
    expectDraftPreserved(element)
  })

  test('13b: a cancelled confirmation preserves the active draft and scroll', async () => {
    const element = await draftReview()
    let title = ''
    fake.context.confirm = async (request) => {
      title = request.title
      return false
    }
    expect(await reviewViewFor('w1')!.applyScope!({ commit: COMMIT }, 'ask')).toBe('cancelled')
    expect(title).toBe('Discard unsaved edits in 1 file?')
    expectDraftPreserved(element)
  })

  test('13b: a pending confirmation makes a concurrent scope request busy', async () => {
    const element = await draftReview()
    let confirms = 0
    const confirmation = Promise.withResolvers<boolean>()
    fake.context.confirm = () => {
      confirms++
      return confirmation.promise
    }
    const handle = reviewViewFor('w1')!
    const pending = handle.applyScope!({ commit: COMMIT }, 'ask')
    await settle()
    expect(await handle.applyScope!({ source: 'unstaged' }, 'ask')).toBe('busy')
    expect(confirms).toBe(1)
    expectDraftPreserved(element)
    confirmation.resolve(false)
    expect(await pending).toBe('cancelled')
    expectDraftPreserved(element)
  })

  test('13b: a confirmation error propagates and releases the confirmation guard', async () => {
    const element = await draftReview()
    let confirms = 0
    fake.context.confirm = async () => {
      confirms++
      if (confirms === 1) throw new Error('confirm failed')
      return false
    }
    const handle = reviewViewFor('w1')!
    await expect(handle.applyScope!({ source: 'staged' }, 'ask')).rejects.toThrow('confirm failed')
    expectDraftPreserved(element)
    expect(await handle.applyScope!({ source: 'staged' }, 'ask')).toBe('cancelled')
    expect(confirms).toBe(2)
    expectDraftPreserved(element)
  })

  test('13b: confirming a scope change applies it and drops the old draft', async () => {
    const element = await draftReview()
    fake.context.confirm = async () => true
    expect(await reviewViewFor('w1')!.applyScope!({ source: 'staged' }, 'ask')).toBe('applied')
    expect(element.querySelector('.ui-scope-chip')?.textContent).toContain('Staged changes')
    expect(order(element)).toEqual([])
  })

  test('13b: the legacy setScope path still asks and ignores a cancelled result', async () => {
    const element = await draftReview()
    let title = ''
    fake.context.confirm = async (request) => {
      title = request.title
      return false
    }
    act(() => reviewViewFor('w1')!.setScope(COMMIT))
    await settle()
    expect(title).toBe('Discard unsaved edits in 1 file?')
    expectDraftPreserved(element)
  })

  test('SC-33: a commit scope shows the commit chip and no review controls, and removing the chip returns', async () => {
    const element = await open()
    const handle = reviewViewFor('w1')!
    act(() => handle.setScope(COMMIT))
    await settle()

    expect(fake.callsTo('quirky.git/commitFiles')[0]!.params).toEqual({ worktree: 'w1', commit: COMMIT })
    expect(element.querySelector('.ui-scope-chip')?.textContent).toContain('Commit f5429a1')
    expect(order(element)).toEqual(['a.ts', 'b.ts'])
    expect(byText(element, 'Mark reviewed')).toBeNull()
    expect(element.querySelector('[role="img"][aria-label="Not reviewed"]')).toBeNull()
    expect(fake.callsTo('quirky.git/diff').at(-1)!.params).toMatchObject({ source: 'commit', commit: COMMIT })
    expect(element.querySelector('[data-review-summary]')?.textContent).toBe('feat vs main · 2 files')

    act(() => handle.setScope(COMMIT))
    await settle()
    expect(fake.callsTo('quirky.git/commitFiles')).toHaveLength(1)

    await click(byLabel(element, 'Remove Commit f5429a1'))
    expect(element.querySelector('.ui-scope-chip')).toBeNull()
    expect(order(element)).toEqual([README, APP, ENABLED, FLAGS])
    expect(byText(card(element, APP), 'Mark reviewed')).not.toBeNull()
  })

  test('SC-33: the commit-scope header keeps its summary and chip as separate elements, the summary titled with its full text', async () => {
    const element = await open({ worktree: 'w1', mode: 'review', commit: COMMIT })
    const summary = element.querySelector('[data-review-summary]')!
    const chip = element.querySelector('.ui-scope-chip')!
    expect(summary.textContent).toBe('feat vs main · 2 files')
    expect(summary.getAttribute('title')).toBe(summary.textContent)
    expect(summary.textContent).toContain('feat vs main')
    expect(summary.contains(chip)).toBe(false)
    expect(chip.contains(summary)).toBe(false)
    expect(summary.parentElement).toBe(chip.parentElement)
    expect(chip.textContent).toContain('Commit f5429a1')
  })

  test('SC-33: a tab opened with a commit starts in that scope', async () => {
    const element = await open({ worktree: 'w1', mode: 'review', commit: COMMIT })
    expect(element.querySelector('.ui-scope-chip')?.textContent).toContain('Commit f5429a1')
    expect(order(element)).toEqual(['a.ts', 'b.ts'])
    act(() => reviewViewFor('w1')!.setScope(null))
    await settle()
    expect(element.querySelector('.ui-scope-chip')).toBeNull()
    expect(order(element)).toEqual([README, APP, ENABLED, FLAGS])
  })

  test('SC-11: a deleted file keeps its card with the removed lines', async () => {
    model = reviewModel([reviewFile('legacy.ts', { status: 'D', added: 0, removed: 3 })])
    fake.handlers['quirky.git/diff'] = () =>
      textDiff({ path: 'legacy.ts', source: 'review', original: 'a\nb\nc\n', modified: '', modifiedHash: null, modifiedDeleted: true })
    const element = await open()
    expect(byText(card(element, 'legacy.ts'), 'Mark reviewed')).not.toBeNull()
    await click(byText(card(element, 'legacy.ts'), 'Mark reviewed'))
    expect(fake.callsTo('quirky.git/setReviewMark')[0]!.params).toMatchObject({ path: 'legacy.ts', expected: null })
  })

  test('CA1: marking a card that has not loaded reads its disk hash first and sends it as expected', async () => {
    model = reviewModel([reviewFile('huge.txt', { added: 12_000, removed: 0 })])
    const element = await open()
    expect(diffCalls()).toEqual([])
    await click(byText(card(element, 'huge.txt'), 'Mark reviewed'))
    expect(fake.callsTo('quirky.git/diff')[0]!.params).toMatchObject({ path: 'huge.txt', source: 'review', against: 'base' })
    expect(fake.callsTo('quirky.git/setReviewMark')[0]!.params).toEqual({ worktree: 'w1', path: 'huge.txt', reviewed: true, expected: 'hash:huge.txt' })
  })

  test('CA1: an unloaded card whose file is deleted sends a null expected hash', async () => {
    model = reviewModel([reviewFile('gone.txt', { status: 'D', added: 0, removed: 12_000 })])
    fake.handlers['quirky.git/diff'] = () =>
      textDiff({ path: 'gone.txt', source: 'review', original: 'a\n', modified: '', modifiedHash: null, modifiedDeleted: true })
    const element = await open()
    await click(byText(card(element, 'gone.txt'), 'Mark reviewed'))
    expect(fake.callsTo('quirky.git/setReviewMark')[0]!.params).toMatchObject({ path: 'gone.txt', expected: null })
  })

  test('CA1: a failed hash read marks nothing and tells the user', async () => {
    model = reviewModel([reviewFile('huge.txt', { added: 12_000, removed: 0 })])
    fake.handlers['quirky.git/diff'] = () => {
      throw failure('disk unreadable')
    }
    const element = await open()
    await click(byText(card(element, 'huge.txt'), 'Mark reviewed'))
    expect(fake.callsTo('quirky.git/setReviewMark')).toHaveLength(0)
    expect(fake.toasts.length).toBe(1)
  })

  test('the tab offers the hash of the diff a card shows, and nothing for a card that has not loaded', async () => {
    model = reviewModel([reviewFile(APP), reviewFile('huge.txt', { added: 12_000, removed: 0 })])
    await open()
    const handle = reviewViewFor('w1')!
    expect(handle.loadedHash?.(APP)).toBe(`hash:${APP}`)
    expect(handle.loadedHash?.('huge.txt')).toBeUndefined()
    expect(handle.loadedHash?.('not-a-card.ts')).toBeUndefined()
  })

  test('CA2: Full diff clicked while the since-review load is pending ends on the base diff', async () => {
    model = reviewModel([reviewFile(FLAGS, { mark: 'changed' })])
    const replies: Array<{ against: string; reply: () => void }> = []
    fake.handlers['quirky.git/diff'] = (params) =>
      new Promise((resolve) => {
        const against = String(params.against)
        replies.push({ against, reply: () => resolve(textDiff({ path: FLAGS, source: 'review', original: 'o\n', modified: `${against.toUpperCase()}\n`, modifiedHash: `h:${against}` })) })
      })
    const element = await open()
    await click(byText(card(element, FLAGS), 'Full diff'))
    await act(async () => replies[0]!.reply())
    await settle()
    expect(replies.map((r) => r.against)).toEqual(['reviewed', 'base'])
    await act(async () => replies[1]!.reply())
    await settle()
    expect(modifiedEditor(card(element, FLAGS)).state.doc.toString()).toBe('BASE\n')
    expect(card(element, FLAGS).textContent).not.toContain('Showing changes since you reviewed')
  })

  test('XA2: when the Full diff cannot load the card shows the error and Retry, not the since-review diff', async () => {
    const element = await open()
    const flagsDiff = fake.handlers['quirky.git/diff']!
    fake.handlers['quirky.git/diff'] = (params) => {
      if (params.path === FLAGS && params.against === 'base') throw failure('base unreadable')
      return flagsDiff(params)
    }
    await click(byText(card(element, FLAGS), 'Full diff'))
    const flags = card(element, FLAGS)
    expect(flags.textContent).toContain('base unreadable')
    expect(flags.querySelector('.cm-editor')).toBeNull()
    fake.handlers['quirky.git/diff'] = flagsDiff
    await click(byText(flags, 'Retry'))
    expect(diffCalls().at(-1)).toEqual([FLAGS, 'base'])
    expect(modifiedEditor(card(element, FLAGS)).state.doc.toString()).toContain('base')
  })

  test('SA2: a commit scope follows the tree order of the panel', async () => {
    fake.settings.viewMode = 'tree'
    fake.handlers['quirky.git/commitFiles'] = (params) => ({
      commit: String(params.commit),
      entries: ['src/a.ts', 'src/z/q.ts', 'zed.ts'].map((path) => ({ path, status: 'modified', added: 1, removed: 1, binary: false }))
    })
    const element = await open({ worktree: 'w1', mode: 'review', commit: COMMIT })
    expect(order(element)).toEqual(['src/z/q.ts', 'src/a.ts', 'zed.ts'])
  })

  test('SA3: a commit card shows the worktree notes on its path', async () => {
    const note = (path: string, id: string) => ({ id, worktreeId: 'w1', path, startLine: 1, line: 1, body: 'x', createdAt: 1, updatedAt: null })
    fake.handlers['quirky.git/notes'] = () => ({ notes: [note('a.ts', 'n1'), note('a.ts', 'n2'), note('b.ts', 'n3')] })
    const element = await open({ worktree: 'w1', mode: 'review', commit: COMMIT })
    expect(card(element, 'a.ts').textContent).toContain('✎ 2 notes')
    expect(card(element, 'b.ts').textContent).toContain('✎ 1 note')
  })

  test('a large card waits for Load diff', async () => {
    model = reviewModel([reviewFile('huge.txt', { added: 12_000, removed: 0 })])
    const element = await open()
    expect(diffCalls()).toEqual([])
    await click(byText(card(element, 'huge.txt'), 'Load diff'))
    expect(diffCalls()).toEqual([['huge.txt', 'base']])
  })

  test('cards beyond the first six load as they scroll into view', async () => {
    model = reviewModel(Array.from({ length: 8 }, (_, i) => reviewFile(`f${i + 1}.ts`)))
    const element = await open()
    expect(diffCalls().map(([path]) => path)).toEqual(['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts'])
    await intersection.reveal(card(element, 'f8.ts'))
    expect(diffCalls().map(([path]) => path)).toContain('f8.ts')
  })

  test('a failing review read with no model shows the error', async () => {
    fake.handlers['quirky.git/review'] = () => {
      throw new Error('git exploded')
    }
    const element = await open()
    expect(element.textContent).toContain('git exploded')
  })
})
