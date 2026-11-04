import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode, type GitDiff, type ReviewFile, type ReviewModel } from '@quirky/protocol'
import { registerDom } from './register-dom'

registerDom()
const s = await import('./support')
const { reviewViewFor } = await import('../../src/review/open')
const { openDiffView } = await import('../../src/view/registry')
afterAll(() => GlobalRegistrator.unregister())

const { act, byText, click, edit, failure, fakeContext, layoutFor, modifiedEditor, mountView, reviewFile, reviewModel, settle, stubIntersectionObserver, stubResizeObserver, textDiff, wait } = s

const COMMIT = 'f5429a1'.padEnd(40, '0')
const APP = 'src/app.ts'
const FLAGS = 'src/flags.ts'
const GUIDE = 'docs/guide.md'
const README = 'README.md'
const MOD = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
const STALE = 'changed on disk'
const INVALID = 'The Markdown preview renderer returned invalid content.'

type Disk = { original: string; modified: string; hash: string }

let fake: ReturnType<typeof fakeContext>
let mounted: ReturnType<typeof mountView> | null = null
let intersection: ReturnType<typeof stubIntersectionObserver>
let resize: ReturnType<typeof stubResizeObserver>
let model: ReviewModel
let disk: Map<string, Disk>
let saves: Array<Record<string, unknown>>
let confirmations: Array<{ title: string; body?: string; confirmLabel?: string }>
let allow: boolean
let saveError: Error | null
let scrolled: Element[]
let originalScroll: typeof Element.prototype.scrollIntoView

const content = (path: string, modified: string, hash: string): Disk => ({ original: `# ${path}\nbase\n`, modified, hash })

const open = async (input: object = { worktree: 'w1', mode: 'review' }) => {
  mounted = mountView(fake, input)
  await settle()
  return mounted.element
}
const card = (root: ParentNode, path: string) => root.querySelector<HTMLElement>(`section[data-path="${path}"]`)!
const order = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('section[data-path]')].map((el) => el.dataset.path)
const head = (root: ParentNode, path: string) => card(root, path).querySelector<HTMLElement>('header')!
const draftOf = (root: ParentNode, path: string) => modifiedEditor(card(root, path)).state.sliceDoc()
const unsaved = (root: ParentNode, path: string) => head(root, path).textContent!.includes('Unsaved')
const alerts = (root: ParentNode, path: string) => [...card(root, path).querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? '')
const staleBar = (root: ParentNode, path: string) => alerts(root, path).find((text) => text.includes(STALE))
const diffReads = (path?: string) => fake.callsTo('quirky.git/diff').filter((c) => path === undefined || c.params.path === path)
const previewCalls = (action: string) => fake.callsTo('quirky.editor/markdownPreview').filter((c) => c.params.action === action)
const changed = () => act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } } as never))
const refreshModel = async () => {
  await act(async () => fake.emit({ type: 'quirky.git/reviewChanged', data: { worktreeId: 'w1' } } as never))
  await settle()
}
const agentWrites = async (path: string, modified: string, hash = `agent:${modified}`) => {
  disk.set(path, { ...disk.get(path)!, modified, hash })
  await changed()
  await settle()
}
const type = (root: ParentNode, path: string, text: string) => edit(card(root, path), text)
const saveWithKeyboard = async (root: ParentNode, path: string) => {
  const view = modifiedEditor(card(root, path))
  await act(async () => void view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ...MOD, bubbles: true })))
  await wait(10)
}
const conflict = () => Object.assign(failure('changed since you looked', 'changed-on-disk'), { code: RpcErrorCode.Conflict })

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
  intersection = stubIntersectionObserver()
  resize = stubResizeObserver()
  model = reviewModel([reviewFile(APP), reviewFile(FLAGS), reviewFile(GUIDE), reviewFile(README)])
  disk = new Map([
    [APP, content(APP, 'app v1\n', 'app-1')],
    [FLAGS, content(FLAGS, 'flags v1\n', 'flags-1')],
    [GUIDE, content(GUIDE, '# Guide\n\n![logo](logo.png)\n', 'guide-1')],
    [README, content(README, 'readme v1\n', 'readme-1')]
  ])
  saves = []
  confirmations = []
  allow = true
  saveError = null
  fake.context.confirm = async (options) => {
    confirmations.push(options)
    return allow
  }
  fake.handlers['quirky.git/review'] = () => model
  fake.handlers['quirky.git/diff'] = (params) => {
    const entry = disk.get(params.path as string)!
    return textDiff({ path: params.path as string, source: params.source as GitDiff['source'], original: entry.original, modified: entry.modified, modifiedHash: entry.hash })
  }
  fake.handlers['quirky.git/save'] = (params) => {
    saves.push(params)
    if (saveError) throw saveError
    const path = params.path as string
    const hash = `saved:${saves.length}`
    disk.set(path, { ...disk.get(path)!, modified: params.content as string, hash })
    return { hash }
  }
  fake.handlers['quirky.git/commitFiles'] = (params) => ({
    commit: String(params.commit),
    entries: [{ path: 'a.ts', status: 'modified', added: 1, removed: 1, binary: false }]
  })
  scrolled = []
  originalScroll = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  intersection.restore()
  resize.restore()
  Element.prototype.scrollIntoView = originalScroll
})

describe('SC-34: editing a file in its card', () => {
  test('SC-34: the header shows Unsaved from the first keystroke, and Mod+S saves with the hash the card shows', async () => {
    const element = await open()
    expect(unsaved(element, APP)).toBe(false)

    type(element, APP, 'app v2\n')
    await settle()
    expect(unsaved(element, APP)).toBe(true)
    expect(unsaved(element, FLAGS)).toBe(false)
    expect(mounted!.report().dirty).toBe(true)

    await saveWithKeyboard(element, APP)
    expect(saves).toEqual([{ worktree: 'w1', path: APP, content: 'app v2\n', expected: 'app-1' }])
    expect(unsaved(element, APP)).toBe(false)
    expect(draftOf(element, APP)).toBe('app v2\n')
    expect(mounted!.report().dirty).toBe(false)
    expect(fake.toasts).toEqual([])
  })

  test('SC-34: the next save carries the hash the last one returned', async () => {
    const element = await open()
    type(element, APP, 'app v2\n')
    await saveWithKeyboard(element, APP)
    type(element, APP, 'app v3\n')
    await saveWithKeyboard(element, APP)
    expect(saves.map((save) => save.expected)).toEqual(['app-1', 'saved:1'])
  })

  test('SC-34: a failed save toasts Save failed and keeps the draft and the label', async () => {
    saveError = failure('disk full')
    const element = await open()
    type(element, APP, 'app v2\n')
    await saveWithKeyboard(element, APP)
    expect(fake.toasts).toEqual([['Save failed', 'disk full']])
    expect(draftOf(element, APP)).toBe('app v2\n')
    expect(unsaved(element, APP)).toBe(true)
    expect(staleBar(element, APP)).toBeUndefined()
  })

  test('SC-34: a reviewed file saved from its card sends the hash it was marked at', async () => {
    model = reviewModel([reviewFile(APP, { mark: 'reviewed' })])
    const element = await open({ worktree: 'w1', mode: 'review', reveal: APP })
    type(element, APP, 'app v2\n')
    await saveWithKeyboard(element, APP)
    expect(saves[0]).toMatchObject({ path: APP, expected: 'app-1' })
  })

  test('SC-34: a changed card that shows the changes since review is editable, its modified side being the disk', async () => {
    model = reviewModel([reviewFile(APP, { mark: 'changed' })])
    const element = await open()
    expect(fake.callsTo('quirky.git/diff')[0]!.params).toMatchObject({ against: 'reviewed' })
    type(element, APP, 'app v2\n')
    await saveWithKeyboard(element, APP)
    expect(saves[0]).toMatchObject({ path: APP, content: 'app v2\n', expected: 'app-1' })
  })

  test('SC-34: binary and too-large cards show their notices and no editor', async () => {
    model = reviewModel([reviewFile('blob.bin', { binary: true }), reviewFile('huge.txt')])
    fake.handlers['quirky.git/diff'] = (params) =>
      params.path === 'blob.bin'
        ? textDiff({ path: 'blob.bin', source: 'review', kind: 'binary', binary: true, original: '', modified: '' })
        : textDiff({ path: 'huge.txt', source: 'review', tooLarge: { originalLines: 1, modifiedLines: 90_000, characters: 10, reason: 'lines' } })
    const element = await open()
    expect(element.textContent).toContain('Binary file changed')
    expect(element.textContent).toContain('too large')
    expect(element.querySelector('[data-diff-editor]')).toBeNull()
    expect(element.textContent).not.toContain('Unsaved')
  })

  test('SC-34: a deleted card takes no edits', async () => {
    model = reviewModel([reviewFile('gone.ts', { status: 'D', added: 0, removed: 2 })])
    fake.handlers['quirky.git/diff'] = () =>
      textDiff({ path: 'gone.ts', source: 'review', original: 'a\nb\n', modified: '', modifiedHash: null, modifiedDeleted: true })
    const element = await open()
    expect(element.querySelector('[data-diff-editor]')).not.toBeNull()
    expect(element.querySelector('.cm-content[contenteditable=true]')).toBeNull()
  })

  test('SC-34: a commit scope keeps its cards read-only, without Revert or Unsaved', async () => {
    fake.handlers['quirky.git/diff'] = () => textDiff({ path: 'a.ts', source: 'commit', modifiedHash: 'c1' })
    const element = await open({ worktree: 'w1', mode: 'review', commit: COMMIT })
    expect(element.querySelector('[data-diff-editor]')).not.toBeNull()
    expect(element.querySelector('.cm-content[contenteditable=true]')).toBeNull()
    expect(element.querySelector('button[name="reject"]')).toBeNull()
    expect(element.textContent).not.toContain('Revert')
    expect(element.textContent).not.toContain('Unsaved')
  })
})

describe('SC-35: closing the tab with unsaved edits', () => {
  const dirtyBoth = async () => {
    const element = await open()
    type(element, APP, 'app v2\n')
    type(element, FLAGS, 'flags v2\n')
    await settle()
    return element
  }
  let closing: Promise<void> = Promise.resolve()
  const requestClose = async () => {
    closing = openDiffView()!.requestClose()
    await settle()
  }
  const dialog = () => document.body.querySelector('[role="dialog"]')
  const choose = async (label: string) => {
    await click(byText(document.body, label))
    await act(async () => closing)
    await settle()
  }
  const closed = () => fake.opened.some((o) => o.id === 'view:quirky.session/worktree')

  test('SC-35: a clean tab closes without asking', async () => {
    await open()
    await requestClose()
    await closing
    expect(dialog()).toBeNull()
    expect(closed()).toBe(true)
  })

  test('SC-35: the report is dirty while either card has edits', async () => {
    const element = await dirtyBoth()
    expect(mounted!.report().dirty).toBe(true)
    await saveWithKeyboard(element, APP)
    expect(mounted!.report().dirty).toBe(true)
    await saveWithKeyboard(element, FLAGS)
    expect(mounted!.report().dirty).toBe(false)
  })

  test('SC-35: Save writes both files in card order and closes the tab', async () => {
    await dirtyBoth()
    await requestClose()
    expect(dialog()).not.toBeNull()
    await choose('Save')
    expect(saves.map((save) => [save.path, save.content, save.expected])).toEqual([
      [APP, 'app v2\n', 'app-1'],
      [FLAGS, 'flags v2\n', 'flags-1']
    ])
    expect(closed()).toBe(true)
    expect(dialog()).toBeNull()
  })

  test("SC-35: Don't Save closes the tab and leaves the disk alone", async () => {
    await dirtyBoth()
    await requestClose()
    await choose("Don't Save")
    expect(saves).toEqual([])
    expect(closed()).toBe(true)
  })

  test('SC-35: Cancel keeps the tab and both drafts', async () => {
    const element = await dirtyBoth()
    await requestClose()
    await choose('Cancel')
    expect(saves).toEqual([])
    expect(closed()).toBe(false)
    expect(dialog()).toBeNull()
    expect(draftOf(element, APP)).toBe('app v2\n')
    expect(draftOf(element, FLAGS)).toBe('flags v2\n')
    expect(unsaved(element, APP) && unsaved(element, FLAGS)).toBe(true)
  })

  test('SC-35: a save that fails keeps the tab open with that file draft, and the later file is not written', async () => {
    const element = await dirtyBoth()
    saveError = failure('disk full')
    await requestClose()
    await choose('Save')
    expect(saves.map((save) => save.path)).toEqual([APP])
    expect(closed()).toBe(false)
    expect(draftOf(element, APP)).toBe('app v2\n')
    expect(draftOf(element, FLAGS)).toBe('flags v2\n')
    expect(mounted!.report().dirty).toBe(true)
  })

  test('SC-35: a file that changed on disk stops the save and keeps the tab open', async () => {
    const element = await dirtyBoth()
    saveError = conflict()
    await requestClose()
    await choose('Save')
    expect(closed()).toBe(false)
    expect(staleBar(element, APP)).toBeDefined()
    expect(mounted!.report().stale).toBe(true)
  })
})

describe('SC-36: the file changes on disk under unsaved edits', () => {
  const draft = async () => {
    const element = await open()
    type(element, APP, 'my draft\n')
    await settle()
    return element
  }

  test('SC-36: the card keeps the draft and offers Reload from Disk and Overwrite', async () => {
    const element = await draft()
    const readsBefore = diffReads(APP).length
    await agentWrites(APP, 'agent v2\n')

    expect(diffReads(APP).length).toBe(readsBefore + 1)
    expect(draftOf(element, APP)).toBe('my draft\n')
    expect(unsaved(element, APP)).toBe(true)
    expect(staleBar(element, APP)).toBeDefined()
    expect(byText(card(element, APP), 'Reload from Disk')).not.toBeNull()
    expect(byText(card(element, APP), 'Overwrite')).not.toBeNull()
    expect(mounted!.report().stale).toBe(true)
    expect(mounted!.report().dirty).toBe(true)
  })

  test('SC-36: a read that matches the held diff leaves the card unmarked', async () => {
    const element = await draft()
    const before = card(element, APP).querySelector('.cm-editor')
    const readsBefore = diffReads(APP).length
    await changed()
    await settle()
    expect(diffReads(APP).length).toBe(readsBefore + 1)
    expect(staleBar(element, APP)).toBeUndefined()
    expect(card(element, APP).querySelector('.cm-editor')).toBe(before)
    expect(draftOf(element, APP)).toBe('my draft\n')
  })

  test('SC-36: Mod+S under a stale draft shows the choice and writes nothing', async () => {
    const element = await draft()
    await agentWrites(APP, 'agent v2\n')
    saveError = conflict()
    await saveWithKeyboard(element, APP)

    expect(saves).toEqual([{ worktree: 'w1', path: APP, content: 'my draft\n', expected: 'app-1' }])
    expect(disk.get(APP)!.modified).toBe('agent v2\n')
    expect(staleBar(element, APP)).toBeDefined()
    expect(draftOf(element, APP)).toBe('my draft\n')
    expect(fake.toasts).toEqual([])
  })

  test('SC-36: Reload from Disk drops the draft and shows the agent version', async () => {
    const element = await draft()
    await agentWrites(APP, 'agent v2\n')
    await click(byText(card(element, APP), 'Reload from Disk'))

    expect(draftOf(element, APP)).toBe('agent v2\n')
    expect(unsaved(element, APP)).toBe(false)
    expect(staleBar(element, APP)).toBeUndefined()
    expect(mounted!.report().dirty).toBe(false)
    expect(mounted!.report().stale).toBe(false)
    expect(saves).toEqual([])
  })

  test('SC-36: Overwrite writes the draft without expected, over the agent change', async () => {
    const element = await draft()
    await agentWrites(APP, 'agent v2\n')
    await click(byText(card(element, APP), 'Overwrite'))

    expect(saves).toEqual([{ worktree: 'w1', path: APP, content: 'my draft\n' }])
    expect(disk.get(APP)!.modified).toBe('my draft\n')
    expect(staleBar(element, APP)).toBeUndefined()
    expect(unsaved(element, APP)).toBe(false)
  })

  test('SC-36: a clean card still follows the disk', async () => {
    const element = await open()
    await agentWrites(APP, 'agent v2\n')
    expect(draftOf(element, APP)).toBe('agent v2\n')
    expect(staleBar(element, APP)).toBeUndefined()
  })

  test('SC-36: a read that fails under a draft keeps the pane and the draft', async () => {
    const element = await draft()
    fake.handlers['quirky.git/diff'] = () => {
      throw failure('git exploded')
    }
    await changed()
    await settle()
    expect(draftOf(element, APP)).toBe('my draft\n')
    expect(card(element, APP).textContent).not.toContain('git exploded')
  })

  test('SC-36: a draft typed while a read is in flight is not replaced by it', async () => {
    const element = await open()
    let release!: () => void
    let started!: () => void
    const reading = new Promise<void>((resolve) => (started = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const base = fake.handlers['quirky.git/diff']!
    disk.set(APP, { ...disk.get(APP)!, modified: 'agent v2\n', hash: 'agent-2' })
    fake.handlers['quirky.git/diff'] = async (params) => {
      const reply = base(params)
      started()
      await gate
      return reply
    }
    await changed()
    await reading
    type(element, APP, 'my draft\n')
    await act(async () => release())
    await settle()
    expect(draftOf(element, APP)).toBe('my draft\n')
    expect(staleBar(element, APP)).toBeDefined()
  })
})

describe('SC-36: a read that moves only the original side under a draft', () => {
  const diffCount = () => diffReads(APP).length
  const expand = async (root: ParentNode) => click(root.querySelector<HTMLButtonElement>(`button[aria-label="Expand ${APP}"]`))
  beforeEach(() => {
    model = reviewModel([reviewFile(APP, { mark: 'changed' })])
    fake.handlers['quirky.git/diff'] = (params) => {
      const entry = disk.get(APP)!
      const original = params.against === 'reviewed' ? 'reviewed original\n' : 'base original\n'
      return textDiff({ path: APP, source: 'review', original, modified: entry.modified, modifiedHash: entry.hash })
    }
    fake.handlers['quirky.git/setReviewMark'] = () => {
      model = reviewModel([reviewFile(APP, { mark: 'reviewed' })])
      return {}
    }
  })

  test('SC-36: Full diff is disabled while the card has edits, and the header keeps showing the side the body shows', async () => {
    const element = await open()
    const full = () => byText(card(element, APP), 'Full diff')!
    expect(full().disabled).toBe(false)
    type(element, APP, 'my draft\n')
    await settle()
    expect(full().disabled).toBe(true)
    expect(full().title).toBe('Save or discard your edits first')
    const reads = diffCount()
    await click(full())
    expect(diffCount()).toBe(reads)
    expect(card(element, APP).textContent).toContain('Showing changes since you reviewed')
    expect(staleBar(element, APP)).toBeUndefined()
    expect(draftOf(element, APP)).toBe('my draft\n')

    await saveWithKeyboard(element, APP)
    expect(full().disabled).toBe(false)
  })

  test('SC-36: marking a card with edits reviewed does not call the disk changed, and the new side shows after the save', async () => {
    const element = await open()
    type(element, APP, 'my draft\n')
    await settle()
    await click(byText(card(element, APP), '● Changed since review'))
    await expand(element)

    expect(fake.callsTo('quirky.git/diff').at(-1)!.params).toMatchObject({ against: 'base' })
    expect(staleBar(element, APP)).toBeUndefined()
    expect(mounted!.report().stale).toBe(false)
    expect(draftOf(element, APP)).toBe('my draft\n')
    expect(unsaved(element, APP)).toBe(true)
    expect(card(element, APP).textContent).not.toContain('base original')
    const reads = diffCount()
    await settle()
    expect(diffCount()).toBe(reads)

    await saveWithKeyboard(element, APP)
    await settle()
    expect(saves).toHaveLength(1)
    expect(staleBar(element, APP)).toBeUndefined()
    expect(card(element, APP).textContent).toContain('base original')
    expect(draftOf(element, APP)).toBe('my draft\n')
    expect(unsaved(element, APP)).toBe(false)
  })

  test('SC-36: the base moving under a draft leaves the draft and the bar alone, and the save then shows the new base', async () => {
    model = reviewModel([reviewFile(APP)])
    let base = 'base one\n'
    fake.handlers['quirky.git/diff'] = () => {
      const entry = disk.get(APP)!
      return textDiff({ path: APP, source: 'review', original: base, modified: entry.modified, modifiedHash: entry.hash })
    }
    const element = await open()
    type(element, APP, 'my draft\n')
    await settle()
    base = 'base two\n'
    await changed()
    await settle()
    expect(staleBar(element, APP)).toBeUndefined()
    expect(draftOf(element, APP)).toBe('my draft\n')

    await saveWithKeyboard(element, APP)
    await changed()
    await settle()
    expect(card(element, APP).textContent).toContain('base two')
    expect(draftOf(element, APP)).toBe('my draft\n')
  })

  test('SC-36: a disk write under a draft still marks the card stale when the original moved too', async () => {
    const element = await open()
    type(element, APP, 'my draft\n')
    await settle()
    await click(byText(card(element, APP), '● Changed since review'))
    await expand(element)
    expect(staleBar(element, APP)).toBeUndefined()

    await agentWrites(APP, 'agent v2\n')
    expect(staleBar(element, APP)).toBeDefined()
    expect(draftOf(element, APP)).toBe('my draft\n')
  })
})

describe('SC-37: reverting a change while edits are unsaved', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const twoChanges = twenty.replace('line 3\n', 'three\n').replace('line 15\n', 'fifteen\n')
  const buttons = (root: ParentNode, path: string) => [...card(root, path).querySelectorAll<HTMLButtonElement>('button[name="reject"]')]
  const press = async (target: Element | undefined) => {
    await act(async () => void target!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
    await wait(20)
  }
  beforeEach(() => {
    model = reviewModel([reviewFile(APP)])
    disk.set(APP, { original: twenty, modified: twoChanges, hash: 'app-1' })
  })

  test('SC-37: with unsaved edits Revert undoes the change in the draft, with no confirm and no save', async () => {
    const element = await open()
    const edited = twoChanges.replace('line 20\n', 'twenty\n')
    type(element, APP, edited)
    await settle()
    expect(buttons(element, APP)).toHaveLength(3)

    await press(buttons(element, APP)[0])
    expect(confirmations).toEqual([])
    expect(saves).toEqual([])
    expect(draftOf(element, APP)).toBe(edited.replace('three\n', 'line 3\n'))
    expect(unsaved(element, APP)).toBe(true)

    await saveWithKeyboard(element, APP)
    expect(saves).toEqual([{ worktree: 'w1', path: APP, content: edited.replace('three\n', 'line 3\n'), expected: 'app-1' }])
  })

  test('SC-37: without unsaved edits Revert asks, then writes at once', async () => {
    const element = await open()
    await press(buttons(element, APP)[0])
    expect(confirmations).toHaveLength(1)
    expect(confirmations[0]).toMatchObject({ title: 'Revert this change?', confirmLabel: 'Revert' })
    expect(saves).toEqual([{ worktree: 'w1', path: APP, content: twoChanges.replace('three\n', 'line 3\n'), expected: 'app-1' }])
    expect(unsaved(element, APP)).toBe(false)
  })

  test('SC-37: Revert in a draft whose text ends up equal to the disk leaves the card clean', async () => {
    const element = await open()
    type(element, APP, twoChanges.replace('fifteen\n', 'line 15\n'))
    await settle()
    expect(unsaved(element, APP)).toBe(true)
    await press(buttons(element, APP)[0])
    await wait(350)
    expect(draftOf(element, APP)).toBe(twenty)
    expect(confirmations).toEqual([])
    expect(saves).toEqual([])
  })

  test('SC-37: side by side offers the same draft-only Revert', async () => {
    const element = await open()
    await resize.resize(1000)
    await wait(60)
    const edited = twoChanges.replace('line 20\n', 'twenty\n')
    type(element, APP, edited)
    await settle()
    const icons = [...card(element, APP).querySelectorAll<HTMLButtonElement>('button[aria-label="Revert change"]')]
    expect(icons.length).toBeGreaterThan(0)
    await press(icons[0])
    expect(confirmations).toEqual([])
    expect(saves).toEqual([])
    expect(draftOf(element, APP)).toBe(edited.replace('three\n', 'line 3\n'))
  })
})

describe('SC-37: typing while a Revert save is pending', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const twoChanges = twenty.replace('line 3\n', 'three\n').replace('line 15\n', 'fifteen\n')
  const reverted = twoChanges.replace('three\n', 'line 3\n')
  let settleSave: { ok(): void; fail(): void }
  let pendingElement: HTMLElement

  const typeAtEnd = async (text: string) => {
    const view = modifiedEditor(card(pendingElement, APP))
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
    })
    await settle()
  }

  beforeEach(async () => {
    model = reviewModel([reviewFile(APP)])
    disk.set(APP, { original: twenty, modified: twoChanges, hash: 'app-1' })
    fake.handlers['quirky.git/save'] = (params) => {
      saves.push(params)
      return new Promise((resolve, reject) => {
        settleSave = {
          ok: () => resolve({ hash: 'saved:revert' }),
          fail: () => reject(failure('disk full'))
        }
      })
    }
    pendingElement = await open()
    const first = card(pendingElement, APP).querySelector<HTMLButtonElement>('button[name="reject"]')!
    await act(async () => void first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
    await wait(20)
    expect(saves.map((save) => save.content)).toEqual([reverted])
  })

  test('SC-37: keystrokes during the pending save mark the card unsaved', async () => {
    expect(unsaved(pendingElement, APP)).toBe(false)
    await typeAtEnd('typed\n')
    expect(unsaved(pendingElement, APP)).toBe(true)
    expect(mounted!.report().dirty).toBe(true)
  })

  test('SC-37: when the save succeeds the card holds the reverted text plus the typing, unsaved', async () => {
    await typeAtEnd('typed\n')
    await act(async () => settleSave.ok())
    await settle()
    expect(draftOf(pendingElement, APP)).toBe(reverted + 'typed\n')
    expect(unsaved(pendingElement, APP)).toBe(true)
    expect(mounted!.report().dirty).toBe(true)
    expect(fake.toasts).toEqual([])

    fake.handlers['quirky.git/save'] = (params) => {
      saves.push(params)
      return { hash: 'saved:next' }
    }
    await saveWithKeyboard(pendingElement, APP)
    expect(saves.at(-1)).toEqual({ worktree: 'w1', path: APP, content: reverted + 'typed\n', expected: 'saved:revert' })
  })

  test('SC-37: when the save fails after typing, the typing and the reverted change stay, unsaved', async () => {
    await typeAtEnd('typed\n')
    await act(async () => settleSave.fail())
    await settle()
    expect(draftOf(pendingElement, APP)).toBe(reverted + 'typed\n')
    expect(unsaved(pendingElement, APP)).toBe(true)
    expect(mounted!.report().dirty).toBe(true)
    expect(fake.toasts).toEqual([['Revert failed', 'disk full']])

    fake.handlers['quirky.git/save'] = (params) => {
      saves.push(params)
      return { hash: 'saved:next' }
    }
    await saveWithKeyboard(pendingElement, APP)
    expect(saves.at(-1)).toEqual({ worktree: 'w1', path: APP, content: reverted + 'typed\n', expected: 'app-1' })
    expect(unsaved(pendingElement, APP)).toBe(false)
  })

  test('SC-37: when the save fails with no typing, the editor is restored and the card stays clean', async () => {
    expect(draftOf(pendingElement, APP)).toBe(reverted)
    await act(async () => settleSave.fail())
    await settle()
    expect(draftOf(pendingElement, APP)).toBe(twoChanges)
    expect(unsaved(pendingElement, APP)).toBe(false)
    expect(mounted!.report().dirty).toBe(false)
    expect(fake.toasts).toEqual([['Revert failed', 'disk full']])
    await wait(350)
    expect(unsaved(pendingElement, APP)).toBe(false)
  })
})

describe('SC-38: previewing a Markdown file', () => {
  let renders: number
  let renderReply: (params: Record<string, unknown>) => unknown
  const previewButton = (root: ParentNode, path: string) => byText(head(root, path), 'Preview')
  const sourceButton = (root: ParentNode, path: string) => byText(head(root, path), 'Source')
  const previewOf = (root: ParentNode, path: string) => card(root, path).querySelector<HTMLElement>('[data-markdown-preview]')
  const paneOf = (root: ParentNode, path: string) => card(root, path).querySelector<HTMLElement>('[data-diff-editor]')!.closest<HTMLElement>('[hidden], [data-review-body]')!

  beforeEach(() => {
    renders = 0
    renderReply = (params) => ({
      leaseId: params.leaseId,
      worktreeId: String(params.worktree).replace(/^id:/, ''),
      path: params.path,
      html: `<h1>render ${++renders}</h1><p>${String(params.text).replace(/</g, '&lt;')}</p>`
    })
    fake.handlers['quirky.editor/markdownPreview'] = (params) => (params.action === 'render' ? renderReply(params) : {})
  })

  test('SC-38: only Markdown cards with a text diff have Preview', async () => {
    model = reviewModel([reviewFile(APP), reviewFile(GUIDE), reviewFile('NOTES.MARKDOWN'), reviewFile('gone.md', { status: 'D', added: 0, removed: 2 })])
    disk.set('NOTES.MARKDOWN', content('NOTES.MARKDOWN', 'notes\n', 'n-1'))
    const base = fake.handlers['quirky.git/diff']!
    fake.handlers['quirky.git/diff'] = (params) =>
      params.path === 'gone.md'
        ? textDiff({ path: 'gone.md', source: 'review', original: 'a\nb\n', modified: '', modifiedHash: null, modifiedDeleted: true })
        : base(params)
    const element = await open()
    expect(previewButton(element, GUIDE)).not.toBeNull()
    expect(previewButton(element, 'NOTES.MARKDOWN')).not.toBeNull()
    expect(previewButton(element, APP)).toBeNull()
    expect(previewButton(element, 'gone.md')).toBeNull()
  })

  test('SC-38: Preview renders the disk side through the editor with the worktree id and shows it over the hidden pane', async () => {
    const element = await open()
    await click(previewButton(element, GUIDE))

    const [render] = previewCalls('render')
    expect(render!.params).toEqual({
      action: 'render',
      leaseId: expect.any(String),
      worktree: 'id:w1',
      path: GUIDE,
      text: '# Guide\n\n![logo](logo.png)\n'
    })
    expect(previewOf(element, GUIDE)!.innerHTML).toContain('<h1>render 1</h1>')
    expect(sourceButton(element, GUIDE)).not.toBeNull()
    expect(previewButton(element, GUIDE)).toBeNull()
    expect(card(element, GUIDE).querySelector('[data-diff-editor]')).not.toBeNull()
    expect(paneOf(element, GUIDE).hidden).toBe(true)
  })

  test('SC-38: unsaved edits show in the preview, and Source returns to the diff with the draft intact', async () => {
    const element = await open()
    type(element, GUIDE, '# Draft\n')
    await settle()
    await click(previewButton(element, GUIDE))
    expect(previewCalls('render')[0]!.params.text).toBe('# Draft\n')
    expect(previewOf(element, GUIDE)!.textContent).toContain('# Draft')

    const lease = previewCalls('render')[0]!.params.leaseId
    await click(sourceButton(element, GUIDE))
    expect(previewOf(element, GUIDE)).toBeNull()
    expect(previewCalls('release').map((c) => c.params.leaseId)).toEqual([lease])
    expect(draftOf(element, GUIDE)).toBe('# Draft\n')
    expect(unsaved(element, GUIDE)).toBe(true)
    expect(paneOf(element, GUIDE).hidden).toBe(false)
  })

  test('SC-38: each Markdown card keeps its own choice', async () => {
    disk.set(README, { ...disk.get(README)!, modified: 'readme\n' })
    const element = await open()
    await click(previewButton(element, GUIDE))
    expect(previewOf(element, GUIDE)).not.toBeNull()
    expect(previewOf(element, README)).toBeNull()
    await refreshModel()
    expect(previewOf(element, GUIDE)).not.toBeNull()
    expect(sourceButton(element, README)).toBeNull()
  })

  test('SC-38: a reply that does not echo the lease, worktree and path, or lacks html, is refused and released', async () => {
    const replies: unknown[] = [
      null,
      'html',
      [],
      { worktreeId: 'w1', path: GUIDE, html: '<p>x</p>' },
      { leaseId: 'other', worktreeId: 'w1', path: GUIDE, html: '<p>x</p>' }
    ]
    for (const reply of replies) {
      fake.calls.length = 0
      fake.handlers['quirky.editor/markdownPreview'] = (params) => (params.action === 'render' ? reply : {})
      const element = await open()
      await click(previewButton(element, GUIDE))
      expect(card(element, GUIDE).textContent).toContain(INVALID)
      expect(previewOf(element, GUIDE)).toBeNull()
      expect(previewCalls('release')).toHaveLength(1)
      expect(sourceButton(element, GUIDE)).not.toBeNull()
      mounted!.unmount()
      mounted = null
    }
  })

  test('SC-38: a reply with the right ids but no html string is refused', async () => {
    renderReply = (params) => ({ leaseId: params.leaseId, worktreeId: 'w1', path: params.path, html: 5 })
    const element = await open()
    await click(previewButton(element, GUIDE))
    expect(card(element, GUIDE).textContent).toContain(INVALID)
  })

  test('SC-38: a reply whose worktree or path differs is refused', async () => {
    renderReply = (params) => ({ leaseId: params.leaseId, worktreeId: 'w2', path: params.path, html: '<p>x</p>' })
    const element = await open()
    await click(previewButton(element, GUIDE))
    expect(card(element, GUIDE).textContent).toContain(INVALID)
    renderReply = (params) => ({ leaseId: params.leaseId, worktreeId: 'w1', path: 'elsewhere.md', html: '<p>x</p>' })
    await click(sourceButton(element, GUIDE))
    await click(previewButton(element, GUIDE))
    expect(card(element, GUIDE).textContent).toContain(INVALID)
  })

  test('SC-38: a render that fails says so in the card and leaves Source available', async () => {
    fake.handlers['quirky.editor/markdownPreview'] = (params) => {
      if (params.action === 'render') throw failure('renderer is down')
      return {}
    }
    const element = await open()
    await click(previewButton(element, GUIDE))
    expect(card(element, GUIDE).textContent).toContain('Markdown preview unavailable: renderer is down')
    expect(previewOf(element, GUIDE)).toBeNull()
    await click(sourceButton(element, GUIDE))
    expect(card(element, GUIDE).textContent).not.toContain('Markdown preview unavailable')
    expect(draftOf(element, GUIDE)).toBe('# Guide\n\n![logo](logo.png)\n')
  })

  test('SC-38: a diff revision change while shown renders again under a fresh lease and releases the old one', async () => {
    const element = await open()
    await click(previewButton(element, GUIDE))
    const first = previewCalls('render')[0]!.params.leaseId
    await agentWrites(GUIDE, '# Agent\n')

    const renderedAgain = previewCalls('render')
    expect(renderedAgain).toHaveLength(2)
    expect(renderedAgain[1]!.params.text).toBe('# Agent\n')
    expect(renderedAgain[1]!.params.leaseId).not.toBe(first)
    expect(previewCalls('release').map((c) => c.params.leaseId)).toEqual([first])
    expect(previewOf(element, GUIDE)!.innerHTML).toContain('render 2')
  })

  test('SC-38: unmounting the tab releases the lease', async () => {
    const element = await open()
    await click(previewButton(element, GUIDE))
    const lease = previewCalls('render')[0]!.params.leaseId
    mounted!.unmount()
    mounted = null
    await settle()
    expect(previewCalls('release').map((c) => c.params.leaseId)).toEqual([lease])
    expect(element.isConnected).toBe(false)
  })

  test('SC-38: a render that lands after Source is released instead of shown', async () => {
    let answer!: () => void
    fake.handlers['quirky.editor/markdownPreview'] = (params) =>
      params.action === 'render'
        ? new Promise((resolve) => (answer = () => resolve({ leaseId: params.leaseId, worktreeId: 'w1', path: params.path, html: '<p>late</p>' })))
        : {}
    const element = await open()
    await click(previewButton(element, GUIDE))
    await click(sourceButton(element, GUIDE))
    await act(async () => answer())
    await settle()
    expect(previewOf(element, GUIDE)).toBeNull()
    expect(previewCalls('release')).toHaveLength(2)
  })

  test('SC-38: a release that fails is ignored', async () => {
    fake.handlers['quirky.editor/markdownPreview'] = (params) => {
      if (params.action === 'release') throw failure('gone')
      return renderReply(params)
    }
    const element = await open()
    await click(previewButton(element, GUIDE))
    await click(sourceButton(element, GUIDE))
    expect(fake.toasts).toEqual([])
    expect(sourceButton(element, GUIDE)).toBeNull()
  })

  test('SC-38: in a commit scope Preview shows the commit version', async () => {
    fake.handlers['quirky.git/commitFiles'] = (params) => ({
      commit: String(params.commit),
      entries: [{ path: GUIDE, status: 'modified', added: 1, removed: 1, binary: false }]
    })
    fake.handlers['quirky.git/diff'] = (params) => {
      expect(params).toMatchObject({ source: 'commit', commit: COMMIT })
      return textDiff({ path: GUIDE, source: 'commit', original: '# Old\n', modified: '# In the commit\n', modifiedHash: 'c1' })
    }
    const element = await open({ worktree: 'w1', mode: 'review', commit: COMMIT })
    await click(previewButton(element, GUIDE))
    expect(previewCalls('render')[0]!.params).toMatchObject({ worktree: 'id:w1', path: GUIDE, text: '# In the commit\n' })
    expect(previewOf(element, GUIDE)).not.toBeNull()
    expect(element.querySelector('.cm-content[contenteditable=true]')).toBeNull()
  })
})

describe('SC-39: a file stops differing from the base while edits are unsaved', () => {
  const dirtyReadme = async () => {
    const element = await open()
    type(element, README, 'my readme\n')
    await settle()
    return element
  }
  const leave = async (path: string) => {
    model = reviewModel(model.files.filter((f) => f.path !== path))
    const entry = disk.get(path)!
    disk.set(path, { ...entry, modified: entry.original, hash: `base:${path}` })
    await refreshModel()
    await changed()
    await settle()
  }

  test('SC-39: the card stays in place with the draft and the changed-on-disk choice', async () => {
    const element = await dirtyReadme()
    const before = order(element)
    await leave(README)

    expect(order(element)).toEqual(before)
    expect(draftOf(element, README)).toBe('my readme\n')
    expect(unsaved(element, README)).toBe(true)
    expect(staleBar(element, README)).toBeDefined()
    expect(mounted!.report().sections).toBe(4)
  })

  test('SC-39: Reload from Disk then removes the card', async () => {
    const element = await dirtyReadme()
    await leave(README)
    await click(byText(card(element, README), 'Reload from Disk'))
    expect(card(element, README)).toBeNull()
    expect(order(element)).toHaveLength(3)
    expect(mounted!.report().dirty).toBe(false)
  })

  test('SC-39: a clean card leaves with its row', async () => {
    const element = await open()
    await leave(README)
    expect(card(element, README)).toBeNull()
    expect(order(element)).toHaveLength(3)
  })

  test('SC-39: a retained card keeps its place among its neighbours', async () => {
    const element = await open()
    const before = order(element)
    const at = before.indexOf(APP)
    type(element, APP, 'my app\n')
    await settle()
    await leave(APP)
    expect(order(element)).toEqual(before)
    expect(order(element).indexOf(APP)).toBe(at)
  })

  test('SC-39: a retained card leaves once its draft is saved over the disk', async () => {
    const element = await dirtyReadme()
    await leave(README)
    await click(byText(card(element, README), 'Overwrite'))
    expect(saves).toEqual([{ worktree: 'w1', path: README, content: 'my readme\n' }])
    expect(card(element, README)).toBeNull()
    expect(mounted!.report().dirty).toBe(false)
  })
})

describe('SC-40: opening a commit while edits are unsaved', () => {
  const dirtyApp = async () => {
    const element = await open()
    type(element, APP, 'my draft\n')
    await settle()
    return element
  }

  test('SC-40: Cancel keeps the worktree review and the draft', async () => {
    const element = await dirtyApp()
    allow = false
    act(() => reviewViewFor('w1')!.setScope(COMMIT))
    await settle()

    expect(confirmations).toEqual([{ title: 'Discard unsaved edits in 1 file?', body: expect.any(String), confirmLabel: 'Discard' }])
    expect(element.querySelector('.ui-scope-chip')).toBeNull()
    expect(fake.callsTo('quirky.git/commitFiles')).toEqual([])
    expect(draftOf(element, APP)).toBe('my draft\n')
    expect(unsaved(element, APP)).toBe(true)
  })

  test('SC-40: Discard shows the commit and drops the draft', async () => {
    const element = await dirtyApp()
    act(() => reviewViewFor('w1')!.setScope(COMMIT))
    await settle()

    expect(confirmations).toHaveLength(1)
    expect(element.querySelector('.ui-scope-chip')?.textContent).toContain('Commit f5429a1')
    expect(order(element)).toEqual(['a.ts'])
    expect(mounted!.report().dirty).toBe(false)
    expect(saves).toEqual([])

    act(() => reviewViewFor('w1')!.setScope(null))
    await settle()
    expect(order(element)).toContain(APP)
    expect(draftOf(element, APP)).toBe('app v1\n')
    expect(unsaved(element, APP)).toBe(false)
  })

  test('SC-40: the question counts the files with edits', async () => {
    const element = await open()
    type(element, APP, 'my app\n')
    type(element, FLAGS, 'my flags\n')
    await settle()
    act(() => reviewViewFor('w1')!.setScope(COMMIT))
    await settle()
    expect(confirmations[0]!.title).toBe('Discard unsaved edits in 2 files?')
  })

  test('SC-40: no question without edits, and none for the scope already shown', async () => {
    await open()
    act(() => reviewViewFor('w1')!.setScope(COMMIT))
    await settle()
    act(() => reviewViewFor('w1')!.setScope(COMMIT))
    await settle()
    expect(confirmations).toEqual([])
  })

  test('SC-40: asking for the worktree review it already shows keeps the draft and asks nothing', async () => {
    const element = await dirtyApp()
    act(() => reviewViewFor('w1')!.setScope(null))
    await settle()
    expect(confirmations).toEqual([])
    expect(draftOf(element, APP)).toBe('my draft\n')
  })

  test('SC-40: removing the commit chip from a commit scope needs no question, since commit cards hold no edits', async () => {
    const element = await open({ worktree: 'w1', mode: 'review', commit: COMMIT })
    await click(element.querySelector<HTMLButtonElement>('button[aria-label="Remove Commit f5429a1"]'))
    expect(confirmations).toEqual([])
    expect(element.querySelector('.ui-scope-chip')).toBeNull()
  })
})
