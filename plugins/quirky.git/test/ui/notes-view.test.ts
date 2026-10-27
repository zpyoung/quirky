import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { GitStatusEntry } from '@quirky/protocol'
import { registerDom } from './register-dom'

registerDom()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { dragScrollStep } = await import('../../src/notes/drag-scroll')
const { act, byLabel, click, failure, fakeContext, layoutFor, modifiedEditor, mountView, numbered, settle, status, stubIntersectionObserver, textDiff, wait } = s

type TestNote = { id: string; worktreeId: string; path: string; startLine: number; line: number; body: string; createdAt: number; updatedAt: number | null }
const note = (id: string, path: string, startLine: number, line = startLine, body = `Note ${id}`): TestNote => ({
  id,
  worktreeId: 'w1',
  path,
  startLine,
  line,
  body,
  createdAt: 1,
  updatedAt: null
})

const TARGETS = { sessions: [], agents: [{ id: 'claude', label: 'Claude' }] }
const input = { worktree: 'w1', mode: 'file', source: 'unstaged', path: 'math.ts' }
/** Forty lines with changes at 20 and 30, so lines 1-19 carry no deleted chunk. */
const forty = textDiff({ original: numbered(40), modified: numbered(40).replace('line 20\n', 'twenty\n').replace('line 30\n', 'thirty\n') })

type Fake = ReturnType<typeof fakeContext>
type View = ReturnType<typeof modifiedEditor>

let fake: Fake
let mounted: ReturnType<typeof mountView> | null = null
let observer: ReturnType<typeof stubIntersectionObserver> | null = null
let server: ReturnType<typeof serve>

/** An in-memory stand-in for the daemon's notes methods that announces every change. */
function serve(initial: TestNote[]) {
  const state = {
    notes: [...initial],
    next: 1,
    fail: null as Error | null,
    gate: null as Promise<void> | null,
    clipboard: [] as string[],
    confirms: 0
  }
  const changed = () => fake.emit({ type: 'quirky.git/notesChanged', data: { worktreeId: 'w1' } } as never)
  const sorted = () => [...state.notes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.startLine - b.startLine)
  fake.handlers['quirky.git/notes'] = () => ({ notes: sorted() })
  fake.handlers['quirky.git/noteTargets'] = () => TARGETS
  fake.handlers['quirky.git/addNote'] = async (params) => {
    if (state.gate) await state.gate
    if (state.fail) throw state.fail
    const line = params.line as number
    const added = note(`new${state.next++}`, params.path as string, (params.startLine as number | undefined) ?? line, line, (params.body as string).trim())
    state.notes.push(added)
    changed()
    return { note: added }
  }
  fake.handlers['quirky.git/editNote'] = (params) => {
    const found = state.notes.find((n) => n.id === params.id)!
    found.body = (params.body as string).trim()
    found.updatedAt = 2
    changed()
    return { note: found }
  }
  fake.handlers['quirky.git/deleteNote'] = (params) => {
    state.notes = state.notes.filter((n) => n.id !== params.id)
    changed()
    return { ok: true }
  }
  fake.handlers['quirky.git/formatNotes'] = (params) => ({ text: `format ${JSON.stringify(params)}`, count: state.notes.length })
  fake.handlers['quirky.git/describeClearNotes'] = () => `Clear ${state.notes.length} notes from this workspace?`
  fake.handlers['quirky.git/clearNotes'] = () => {
    const cleared = state.notes.length
    state.notes = []
    changed()
    return { cleared }
  }
  fake.context.confirm = async () => {
    state.confirms++
    return true
  }
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void state.clipboard.push(text) }, configurable: true })
  return state
}

const open = async (notes: TestNote[] = [], diff = forty, viewInput: object = input) => {
  server = serve(notes)
  fake.handlers['quirky.git/diff'] = () => diff
  mounted = mountView(fake, viewInput)
  await settle()
  return mounted
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
})
afterEach(async () => {
  mounted?.unmount()
  mounted = null
  await settle()
  observer?.restore()
  observer = null
})

const q = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => root.querySelector<T>(selector)
const qa = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => [...root.querySelectorAll<T>(selector)]
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The `.cm-line` element of line `n` of the modified side. */
function lineEl(view: View, n: number): HTMLElement {
  const { node } = view.domAtPos(view.state.doc.line(n).from)
  const el = node instanceof Element ? node : node.parentElement!
  return el.closest('.cm-line') as HTMLElement
}

/** The line-number cell of line `n`; the first cell of the gutter is a hidden spacer. */
function numberCell(view: View, n: number): HTMLElement {
  const cells = qa(view.dom, '.cm-lineNumbers .cm-gutterElement').slice(1)
  const cell = cells.find((c) => c.textContent === String(n))
  if (!cell) throw new Error(`no line number ${n}`)
  return cell
}

const pointer = (type: string, init: PointerEventInit = {}) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX: 4, clientY: 4, ...init })

async function dispatch(target: Element | Document, event: Event): Promise<void> {
  await act(async () => void target.dispatchEvent(event))
  await settle()
}

async function hover(view: View, n: number): Promise<void> {
  await dispatch(lineEl(view, n), new MouseEvent('mousemove', { bubbles: true }))
}

const plusButton = (root: ParentNode) => q<HTMLButtonElement>(root, 'button[aria-label="Add note for the AI"]')

/** Hovers line `n` and clicks its "+". */
async function addAt(view: View, n: number): Promise<void> {
  await hover(view, n)
  await click(plusButton(view.dom))
}

const draftOf = (root: ParentNode) => q(root, '.qgv-note-draft')
const cardsOf = (root: ParentNode) => qa(root, '.qgv-note-card')
const textareaOf = (card: ParentNode) => q<HTMLTextAreaElement>(card, 'textarea')!
const buttonIn = (card: ParentNode, label: string) => qa<HTMLButtonElement>(card, 'button').find((b) => text(b) === label || b.getAttribute('aria-label') === label) ?? null

async function setValue(area: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(target: Element, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => void target.dispatchEvent(event))
  await settle()
  return event
}

/** The chord for Add Review Note on the editor, with whichever of Cmd and Ctrl CodeMirror takes as Mod. */
async function chord(view: View): Promise<void> {
  for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
    const event = await press(view.contentDOM, 'A', { code: 'KeyA', keyCode: 65, shiftKey: true, ...mod })
    if (event.defaultPrevented) return
  }
}

function select(view: View, from: number, to: number, toColumn = 0): void {
  act(() => {
    view.dispatch({ selection: { anchor: view.state.doc.line(from).from, head: view.state.doc.line(to).from + toColumn } })
  })
}

const addCalls = () => fake.callsTo('quirky.git/addNote').map((c) => c.params)

describe('NA-1: the "+" beside a line adds a one-line note', () => {
  test('hover, "+", type, Enter: a draft card under the line becomes the saved card', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    expect(plusButton(element)).toBeNull()

    await hover(view, 30)
    const plus = plusButton(element)!
    expect(plus.title).toBe('Add note for the AI')
    expect(plus.closest('.qgv-note-gutter')).not.toBeNull()
    await click(plus)

    const draft = draftOf(element)!
    expect(text(q(draft, '.qgv-note-title'))).toBe('Line 30')
    expect(textareaOf(draft).placeholder).toBe('Add note for the AI')
    expect(qa(draft, 'button').map(text)).toEqual(['Cancel', 'Add note'])
    expect(lineEl(view, 30).nextElementSibling?.contains(draft)).toBe(true)

    await setValue(textareaOf(draft), 'Handle the empty list')
    await press(textareaOf(draft), 'Enter')
    expect(addCalls()).toEqual([{ worktree: 'w1', path: 'math.ts', line: 30, body: 'Handle the empty list' }])

    await wait(10)
    expect(draftOf(element)).toBeNull()
    const [saved] = cardsOf(element)
    expect(text(q(saved, '.qgv-note-meta'))).toBe('Note line 30')
    expect(text(q(saved, '.qgv-note-body'))).toBe('Handle the empty list')
    expect(lineEl(view, 30).nextElementSibling?.contains(saved)).toBe(true)
    expect(buttonIn(saved, 'Send notes to an agent')).not.toBeNull()
    expect(buttonIn(saved, 'Edit note')).not.toBeNull()
    expect(buttonIn(saved, 'Delete note')).not.toBeNull()
    expect(text(q(element, '.qgv-note-pill'))).toBe('AI notes 1')
  })
})

describe('NA-2: a range comes from a gutter drag or from Mod+Shift+A', () => {
  test('(a) press line number 3, drag to 7, release: Lines 3-7, saved as Note lines 3-7', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await dispatch(numberCell(view, 3), pointer('pointerdown'))
    await dispatch(numberCell(view, 5), pointer('pointermove'))
    await wait(40)
    expect(qa(view.dom, '.qgv-note-range').map((el) => el.textContent)).toEqual(['line 3', 'line 4', 'line 5'])
    await dispatch(numberCell(view, 7), pointer('pointerup'))

    const draft = draftOf(element)!
    expect(text(q(draft, '.qgv-note-title'))).toBe('Lines 3-7')
    expect(lineEl(view, 7).nextElementSibling?.contains(draft)).toBe(true)
    await setValue(textareaOf(draft), 'Extract this')
    await press(textareaOf(draft), 'Enter')
    expect(addCalls()).toEqual([{ worktree: 'w1', path: 'math.ts', startLine: 3, line: 7, body: 'Extract this' }])
    await wait(10)
    expect(text(q(cardsOf(element)[0], '.qgv-note-meta'))).toBe('Note lines 3-7')
  })

  test('dragging upward orders the range', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await dispatch(numberCell(view, 9), pointer('pointerdown'))
    await dispatch(numberCell(view, 6), pointer('pointerup'))
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Lines 6-9')
  })

  test('(b) a selection from line 12 column 1 to line 15 column 1 and the chord: Lines 12-14', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    select(view, 12, 15)
    await chord(view)
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Lines 12-14')
    expect(qa(view.dom, '.qgv-note-range').map((el) => el.textContent)).toEqual(['line 12', 'line 13', 'line 14'])
  })

  test('(b) a selection that ends inside line 15 keeps it, and a cursor makes a one-line draft', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    select(view, 12, 15, 2)
    await chord(view)
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Lines 12-15')
    await press(textareaOf(draftOf(element)!), 'Escape')
    select(view, 8, 8)
    await chord(view)
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Line 8')
  })

  test('the chord leaves an open draft as it is', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await addAt(view, 30)
    await setValue(textareaOf(draftOf(element)!), 'typed')
    select(view, 3, 5, 1)
    await chord(view)
    expect(qa(element, '.qgv-note-draft')).toHaveLength(1)
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Line 30')
    expect(textareaOf(draftOf(element)!).value).toBe('typed')
  })

  test('(c) Escape before the release cancels the drag; a click with no drag is a one-line draft', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await dispatch(numberCell(view, 3), pointer('pointerdown'))
    await dispatch(numberCell(view, 9), pointer('pointermove'))
    await dispatch(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await dispatch(numberCell(view, 9), pointer('pointerup'))
    expect(draftOf(element)).toBeNull()
    expect(qa(view.dom, '.qgv-note-range')).toHaveLength(0)

    await dispatch(numberCell(view, 11), pointer('pointerdown'))
    await dispatch(numberCell(view, 11), pointer('pointerup'))
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Line 11')
  })

  test('a drag ignores touch, ctrl-click, other buttons and a press while a draft is open', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    for (const init of [{ pointerType: 'touch' }, { ctrlKey: true }, { button: 2 }]) {
      await dispatch(numberCell(view, 3), pointer('pointerdown', init))
      await dispatch(numberCell(view, 4), pointer('pointerup', init))
      expect(draftOf(element)).toBeNull()
    }
    await addAt(view, 30)
    await dispatch(numberCell(view, 3), pointer('pointerdown'))
    await dispatch(numberCell(view, 5), pointer('pointerup'))
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Line 30')
  })

  test('pressing the "+" and releasing on it opens its line once', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await hover(view, 30)
    const plus = plusButton(element)!
    await dispatch(plus, pointer('pointerdown'))
    await dispatch(plus, pointer('pointerup'))
    await dispatch(plus, new MouseEvent('click', { bubbles: true }))
    expect(qa(element, '.qgv-note-draft')).toHaveLength(1)
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Line 30')
  })
})

describe('NA-2: the drag pulls the view at the edges like Orca', () => {
  const frame = 1000 / 60
  const at = (clientY: number, frameDeltaMs = frame) => dragScrollStep({ top: 100, bottom: 500, clientY, frameDeltaMs })

  test('nothing within the middle, a 4 px floor at the edge and a 32 px ceiling', () => {
    expect(at(300)).toBe(0)
    expect(at(124)).toBe(0)
    expect(at(123)).toBeCloseTo(-(4 + 0.6), 5)
    expect(at(114)).toBeCloseTo(-(4 + 10 * 0.6), 5)
    expect(at(-400)).toBeCloseTo(-32, 5)
    expect(at(476)).toBe(0)
    expect(at(477)).toBeCloseTo(4 + 0.6, 5)
    expect(at(900)).toBeCloseTo(32, 5)
  })

  test('the step scales with the frame time and a long frame is capped at 50 ms', () => {
    expect(at(900, frame * 2)).toBeCloseTo(64, 5)
    expect(at(900, 5000)).toBeCloseTo(32 * (50 / frame), 5)
  })
})

describe('NA-3: the draft card keys and buttons', () => {
  const draftOn = async (n = 30) => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await addAt(view, n)
    return { element, view, area: textareaOf(draftOf(element)!) }
  }

  test('Enter and Mod+Enter save; Shift+Enter adds a line break', async () => {
    const { element, area } = await draftOn()
    await setValue(area, 'first')
    const shifted = await press(area, 'Enter', { shiftKey: true })
    expect(shifted.defaultPrevented).toBe(false)
    expect(addCalls()).toHaveLength(0)
    const plain = await press(area, 'Enter')
    expect(plain.defaultPrevented).toBe(true)
    expect(addCalls()).toHaveLength(1)
    await wait(10)

    const view = modifiedEditor(element)
    await addAt(view, 31)
    const again = textareaOf(draftOf(element)!)
    await setValue(again, 'second')
    await press(again, 'Enter', { metaKey: true, shiftKey: true })
    expect(addCalls().map((p) => p.body)).toEqual(['first', 'second'])
  })

  test('Escape cancels, and Enter while an input method is composing does not save', async () => {
    const { element, area } = await draftOn()
    await setValue(area, 'text')
    await press(area, 'Enter', { isComposing: true })
    expect(addCalls()).toHaveLength(0)
    expect(draftOf(element)).not.toBeNull()
    await press(area, 'Escape')
    expect(draftOf(element)).toBeNull()
    expect(addCalls()).toHaveLength(0)
  })

  test('keys typed in the card do not reach the window', async () => {
    const { area } = await draftOn()
    let seen = 0
    const onWindow = () => void seen++
    window.addEventListener('keydown', onWindow)
    await press(area, 'F7')
    await press(area, 'A', { shiftKey: true, metaKey: true })
    window.removeEventListener('keydown', onWindow)
    expect(seen).toBe(0)
  })

  test('a click outside keeps a draft with text and cancels an empty one', async () => {
    const { element, area } = await draftOn()
    await setValue(area, 'keep me')
    await dispatch(document.body, new MouseEvent('mousedown', { bubbles: true }))
    expect(draftOf(element)).not.toBeNull()
    await setValue(area, '   ')
    await dispatch(document.body, new MouseEvent('mousedown', { bubbles: true }))
    expect(draftOf(element)).toBeNull()
  })

  test('a mouse press inside the card never cancels it', async () => {
    const { element } = await draftOn()
    await dispatch(draftOf(element)!, new MouseEvent('mousedown', { bubbles: true }))
    expect(draftOf(element)).not.toBeNull()
  })

  test('a second draft on line 31 carries the first draft text over and closes the first', async () => {
    const { element, view, area } = await draftOn()
    await setValue(area, 'carry me')
    await addAt(view, 31)
    expect(qa(element, '.qgv-note-draft')).toHaveLength(1)
    const draft = draftOf(element)!
    expect(text(q(draft, '.qgv-note-title'))).toBe('Line 31')
    expect(textareaOf(draft).value).toBe('carry me')
    expect(lineEl(view, 31).nextElementSibling?.contains(draft)).toBe(true)
  })

  test('Add note is disabled while the trimmed text is empty and reads Adding... while the save runs', async () => {
    const { element, area } = await draftOn()
    const add = () => buttonIn(draftOf(element)!, 'Add note')!
    expect(add().disabled).toBe(true)
    await setValue(area, '   ')
    expect(add().disabled).toBe(true)
    await setValue(area, 'go')
    expect(add().disabled).toBe(false)

    let release!: () => void
    server.gate = new Promise((resolve) => (release = resolve))
    await click(add())
    const saving = buttonIn(draftOf(element)!, 'Add note') ?? qa<HTMLButtonElement>(draftOf(element)!, 'button').find((b) => text(b) === 'Adding...')!
    expect(text(saving)).toBe('Adding...')
    expect(saving.disabled).toBe(true)
    release()
    await wait(10)
    expect(draftOf(element)).toBeNull()
  })

  test('the textarea grows from 60 to 240 pixels with its content', async () => {
    const { area } = await draftOn()
    expect(area.style.height).toBe('60px')
    Object.defineProperty(area, 'scrollHeight', { configurable: true, get: () => 120 })
    await setValue(area, 'a\nb\nc\nd')
    expect(area.style.height).toBe('120px')
    Object.defineProperty(area, 'scrollHeight', { configurable: true, get: () => 900 })
    await setValue(area, 'a\nb\nc\nd\ne')
    expect(area.style.height).toBe('240px')
  })
})

describe('NA-6: notes are edited and deleted', () => {
  const withNote = async () => {
    const { element } = await open([note('n1', 'math.ts', 30, 30, 'Handle the empty list')])
    return { element, card: () => cardsOf(element)[0]! }
  }

  test('Edit note shows Cancel and a disabled Save; Enter saves a changed text', async () => {
    const { card } = await withNote()
    await click(buttonIn(card(), 'Edit note'))
    const area = textareaOf(card())
    expect(area.value).toBe('Handle the empty list')
    expect(qa(card(), 'button').map(text).filter(Boolean)).toEqual(['Cancel', 'Save'])
    expect(buttonIn(card(), 'Save')!.disabled).toBe(true)
    await press(area, 'Enter')
    expect(fake.callsTo('quirky.git/editNote')).toHaveLength(0)

    await setValue(area, '  ')
    expect(buttonIn(card(), 'Save')!.disabled).toBe(true)
    await setValue(area, 'Handle empty and null')
    expect(buttonIn(card(), 'Save')!.disabled).toBe(false)
    const shifted = await press(area, 'Enter', { shiftKey: true })
    expect(shifted.defaultPrevented).toBe(false)
    expect(fake.callsTo('quirky.git/editNote')).toHaveLength(0)
    await press(area, 'Enter')
    expect(fake.callsTo('quirky.git/editNote')[0]!.params).toEqual({ worktree: 'w1', id: 'n1', body: 'Handle empty and null' })
    await wait(10)
    expect(q(card(), 'textarea')).toBeNull()
    expect(text(q(card(), '.qgv-note-body'))).toBe('Handle empty and null')
  })

  test('Escape and Cancel leave the text as it was', async () => {
    const { card } = await withNote()
    await click(buttonIn(card(), 'Edit note'))
    await setValue(textareaOf(card()), 'changed')
    await press(textareaOf(card()), 'Escape')
    expect(text(q(card(), '.qgv-note-body'))).toBe('Handle the empty list')
    await click(buttonIn(card(), 'Edit note'))
    expect(textareaOf(card()).value).toBe('Handle the empty list')
    await setValue(textareaOf(card()), 'changed')
    await click(buttonIn(card(), 'Cancel'))
    expect(text(q(card(), '.qgv-note-body'))).toBe('Handle the empty list')
    expect(fake.callsTo('quirky.git/editNote')).toHaveLength(0)
  })

  test('Delete note removes the card and the pill with no confirmation', async () => {
    const { element, card } = await withNote()
    expect(q(element, '.qgv-note-pill')).not.toBeNull()
    await click(buttonIn(card(), 'Delete note'))
    await wait(10)
    expect(fake.callsTo('quirky.git/deleteNote')[0]!.params).toEqual({ worktree: 'w1', id: 'n1' })
    expect(server.confirms).toBe(0)
    expect(cardsOf(element)).toHaveLength(0)
    expect(q(element, '.qgv-note-pill')).toBeNull()
  })

  test('the card send menu offers only this note', async () => {
    const { card } = await withNote()
    await click(buttonIn(card(), 'Send notes to an agent'))
    const menu = q(document.body, '[role="menu"][aria-label="Send notes"]')!
    expect(qa(menu, ':scope > li').map(text)).toEqual(['Send notes to', 'New agent', 'Claude'])
    await click(buttonIn(menu, 'Claude'))
    expect(fake.callsTo('quirky.git/sendNotes')[0]!.params).toEqual({ worktree: 'w1', scope: 'note', id: 'n1', agent: 'claude' })
  })
})

describe('NA-7: a note shows in every diff of its path, never where there is no text', () => {
  const util = [note('u1', 'util.ts', 2, 4, 'Rename x')]
  const lines = (n: number) => numbered(n)

  test('the staged, branch and commit diffs of the path show the same card under line 4', async () => {
    for (const source of [
      { source: 'staged' },
      { source: 'branch' },
      { source: 'commit', commit: 'c'.repeat(40) }
    ]) {
      const { element, unmount } = await open(util, textDiff({ path: 'util.ts', original: lines(30), modified: lines(30).replace('line 20\n', 'twenty\n'), source: source.source as never }), {
        worktree: 'w1',
        mode: 'file',
        path: 'util.ts',
        ...source
      })
      const view = modifiedEditor(element)
      const [card] = cardsOf(element)
      expect(text(q(card!, '.qgv-note-meta'))).toBe('Note lines 2-4')
      expect(lineEl(view, 4).nextElementSibling?.contains(card!)).toBe(true)
      unmount()
      mounted = null
    }
  })

  test('a note past the last line is drawn after the last line', async () => {
    const short = textDiff({ original: numbered(30), modified: numbered(30).replace('line 20\n', 'twenty\n') })
    const { element } = await open([note('far', 'math.ts', 99)], short)
    const view = modifiedEditor(element)
    expect(text(q(cardsOf(element)[0]!, '.qgv-note-meta'))).toBe('Note line 99')
    expect(lineEl(view, view.state.doc.lines).nextElementSibling?.contains(cardsOf(element)[0]!)).toBe(true)
  })

  test('a combined section shows the card and takes new notes like a single diff', async () => {
    observer = stubIntersectionObserver()
    server = serve(util)
    fake.handlers['quirky.git/status'] = () => status([{ path: 'util.ts', area: 'unstaged', status: 'modified', added: 1, removed: 1 } as GitStatusEntry])
    fake.handlers['quirky.git/diff'] = () => textDiff({ path: 'util.ts', original: lines(30), modified: lines(30).replace('line 20\n', 'twenty\n') })
    mounted = mountView(fake, { worktree: 'w1', mode: 'combined', area: 'unstaged' })
    await settle()
    const view = modifiedEditor(mounted.element)
    expect(text(q(cardsOf(mounted.element)[0]!, '.qgv-note-meta'))).toBe('Note lines 2-4')
    await addAt(view, 10)
    expect(text(q(draftOf(mounted.element)!, '.qgv-note-title'))).toBe('Line 10')
    await setValue(textareaOf(draftOf(mounted.element)!), 'Also this')
    await press(textareaOf(draftOf(mounted.element)!), 'Enter')
    expect(addCalls()).toEqual([{ worktree: 'w1', path: 'util.ts', line: 10, body: 'Also this' }])
  })

  for (const [name, diff] of [
    ['an image diff', textDiff({ kind: 'image', binary: true, mime: 'image/png', original: '', modified: '' })],
    ['a binary diff', textDiff({ binary: true, kind: 'binary' as never, original: '', modified: '' })],
    ['a too-large diff', textDiff({ original: '', modified: '', tooLarge: { originalLines: 130_000, modifiedLines: 130_000, characters: 10, reason: 'lines' } })]
  ] as const) {
    test(`${name} shows no "+" and accepts no chord`, async () => {
      const { element } = await open([note('n1', 'math.ts', 3)], diff)
      expect(q(element, '.cm-editor')).toBeNull()
      expect(plusButton(element)).toBeNull()
      expect(q(element, '.qgv-note-card')).toBeNull()
      await act(async () => void (await fake.run('add-review-note')))
      await settle()
      expect(draftOf(element)).toBeNull()
    })
  }
})

describe('NA-8: a failed save keeps the draft', () => {
  test('the toast says so, the draft keeps its text, nothing is stored', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await addAt(view, 30)
    server.fail = failure('Unknown worktree')
    const area = textareaOf(draftOf(element)!)
    await setValue(area, 'Handle the empty list')
    await press(area, 'Enter')
    await wait(10)
    expect(fake.toasts.map(([title]) => title)).toEqual(['Failed to save comment'])
    expect(draftOf(element)).not.toBeNull()
    expect(textareaOf(draftOf(element)!).value).toBe('Handle the empty list')
    expect(buttonIn(draftOf(element)!, 'Add note')!.disabled).toBe(false)
    expect(server.notes ?? []).toEqual([])
    expect(cardsOf(element)).toHaveLength(0)
  })

  test('a text of only blanks is not sent and an oversize text is refused with a toast', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await addAt(view, 30)
    const area = textareaOf(draftOf(element)!)
    await setValue(area, ' '.repeat(70_000) + 'x')
    await press(area, 'Enter')
    expect(fake.toasts).toEqual([['Comment is too large to submit safely.', '']])
    expect(addCalls()).toHaveLength(0)
  })
})

describe('NA-14: the diff header pill and the combined view note controls', () => {
  const three = [note('m1', 'math.ts', 5), note('m2', 'math.ts', 30), note('u1', 'util.ts', 2, 4)]

  test('the single-file header pill opens the send menu with This file and All unsent notes', async () => {
    const { element } = await open(three)
    const pill = q<HTMLButtonElement>(element, '.qgv-note-pill')!
    expect(text(pill)).toBe('AI notes 2')
    expect(pill.getAttribute('aria-label')).toBe('Send AI notes to an agent')
    expect(pill.closest('.qgv-bar')).not.toBeNull()
    await click(pill)
    const menu = q(document.body, '[role="menu"]')!
    expect(qa(menu, ':scope > li').map((li) => text(li))).toEqual(['Send notes', 'This file2', 'All unsent notes3'])
  })

  test('no pill without a note on the file', async () => {
    const { element } = await open([note('u1', 'util.ts', 2, 4)])
    expect(q(element, '.qgv-note-pill')).toBeNull()
  })

  async function combined(notes: TestNote[]) {
    observer = stubIntersectionObserver()
    server = serve(notes)
    const entry = (path: string): GitStatusEntry => ({ path, area: 'unstaged', status: 'modified', added: 1, removed: 1 })
    fake.handlers['quirky.git/status'] = () => status([entry('math.ts'), entry('util.ts'), entry('other.ts')])
    fake.handlers['quirky.git/diff'] = (params) => textDiff({ path: params.path as string, original: numbered(30), modified: numbered(30).replace('line 20\n', 'twenty\n') })
    mounted = mountView(fake, { worktree: 'w1', mode: 'combined', area: 'unstaged' })
    await settle()
    return mounted.element
  }

  test('the toolbar shows Show 3 AI notes and a Send menu; only sections with notes get a send icon', async () => {
    const element = await combined(three)
    const pill = byLabel(element, 'Show 3 AI notes')!
    expect(text(pill)).toBe('AI notes 3')
    expect(pill.closest('.qgv-toolbar')).not.toBeNull()
    const sendIcon = (path: string) => q(element.querySelector(`section[data-path="${path}"]`)!, '.qgv-section-head [aria-label="Send notes to an agent"]')
    expect(sendIcon('math.ts')).not.toBeNull()
    expect(sendIcon('util.ts')).not.toBeNull()
    expect(sendIcon('other.ts')).toBeNull()

    await click(sendIcon('math.ts'))
    const menu = q(document.body, '[role="menu"]')!
    expect(qa(menu, ':scope > li').map((li) => text(li))).toEqual(['Send notes', 'This file2', 'All unsent notes3'])
    await click(document.body)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    const send = q(element, '.qgv-toolbar')!.querySelector<HTMLButtonElement>('button[aria-label="Send notes to an agent"]')!
    expect(text(send)).toContain('Send')
  })

  test('no notes: no pill, no Send, no section send icon', async () => {
    const element = await combined([])
    expect(q(element, '.qgv-note-pill')).toBeNull()
    expect(q(element, '.qgv-toolbar [aria-label="Send notes to an agent"]')).toBeNull()
    expect(q(element, '.qgv-section-head [aria-label="Send notes to an agent"]')).toBeNull()
  })

  test('the pill previews up to 4 notes with Copy and Clear', async () => {
    const five = [...three, note('m3', 'math.ts', 31), note('m4', 'math.ts', 32)]
    const element = await combined(five)
    await click(byLabel(element, 'Show 5 AI notes'))
    const popover = q(element, '.qgv-note-popover')!
    expect(qa(popover, '.qgv-note-preview')).toHaveLength(4)
    expect(text(q(popover, '.qgv-note-more'))).toBe('1 more note in Source Control')
    expect(qa(popover, '.qgv-note-preview').map((row) => text(q(row, '.qgv-note-preview-path')))).toEqual(['math.ts', 'math.ts', 'math.ts', 'math.ts'])

    await click(buttonIn(popover, 'Copy'))
    expect(fake.callsTo('quirky.git/formatNotes')[0]!.params).toEqual({ worktree: 'w1' })
    expect(server.clipboard).toEqual(['format {"worktree":"w1"}'])

    await click(buttonIn(popover, 'Clear'))
    expect(fake.callsTo('quirky.git/describeClearNotes')[0]!.params).toEqual({ worktree: 'w1' })
    expect(server.confirms).toBe(1)
    expect(fake.callsTo('quirky.git/clearNotes')[0]!.params).toEqual({ worktree: 'w1', yes: true })
    await wait(10)
    expect(q(element, '.qgv-note-pill')).toBeNull()
  })

  test('a refused clipboard write toasts Failed to copy notes', async () => {
    const element = await combined(three)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => Promise.reject(new Error('denied')) }, configurable: true })
    await click(byLabel(element, 'Show 3 AI notes'))
    await click(buttonIn(q(element, '.qgv-note-popover')!, 'Copy'))
    expect(fake.toasts[0]![0]).toBe('Failed to copy notes')
  })
})

describe('scrolling to a note and the add-review-note command', () => {
  test('opening with a noteId scrolls that note card into view', async () => {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.noteId ?? this.className)
    }
    try {
      await open([note('n1', 'math.ts', 5), note('n2', 'math.ts', 30)], forty, { ...input, noteId: 'n2' })
      await wait(80)
      expect(scrolled).toContain('n2')
      expect(scrolled).not.toContain('n1')
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  test('the command opens a draft for the selection of the diff in view', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    select(view, 5, 7, 3)
    await act(async () => void (await fake.run('add-review-note')))
    await settle()
    expect(text(q(draftOf(element)!, '.qgv-note-title'))).toBe('Lines 5-7')
    await act(async () => void (await fake.run('add-review-note')))
    expect(qa(element, '.qgv-note-draft')).toHaveLength(1)
  })

  test('the command does nothing when no diff is open', async () => {
    await act(async () => void (await fake.run('add-review-note')))
    expect(document.querySelector('.qgv-note-draft')).toBeNull()
  })

  test('the draft survives the diff being replaced by a refresh', async () => {
    const { element } = await open()
    const view = modifiedEditor(element)
    await addAt(view, 30)
    await setValue(textareaOf(draftOf(element)!), 'still here')
    fake.handlers['quirky.git/diff'] = () => ({ ...forty, modified: forty.modified.replace('line 5\n', 'five\n'), modifiedHash: 'hash-2' })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: {} } as never))
    await wait(30)
    expect(textareaOf(draftOf(element)!).value).toBe('still here')
  })
})
