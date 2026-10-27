import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, type DecorationSet, type PluginValue } from '@codemirror/view'
import { dragScrollStep, REFERENCE_FRAME_MS } from './drag-scroll'
import { orderRange, selectionLineRange, type LineRange } from './line-range'
import type { Note } from './useNotes'

/** A note being written: its lines, the text carried into the card, and a key that changes with each new draft. */
export type NoteDraft = LineRange & { key: number; body: string }

/** What the editor draws: a card per saved note and at most one draft. */
export type NotesModel = { saved: readonly Note[]; draft: NoteDraft | null }

export type CardSpec = { kind: 'saved'; note: Note } | { kind: 'draft'; draft: NoteDraft }

export type NotesExtensionOptions = {
  /** What to draw before the first `setNotesModel`. */
  initial: NotesModel
  /** Renders a card into the element of its block widget; the returned function unmounts it. `remeasure` tells the editor the card changed size. */
  mountCard(element: HTMLElement, card: CardSpec, remeasure: () => void): () => void
  /** A gesture (the "+", a gutter drag or Mod-Shift-a) asked for a note on these lines. */
  onRange(range: LineRange): void
}

const options = Facet.define<NotesExtensionOptions, NotesExtensionOptions>({ combine: (values) => values[0]! })

const setModel = StateEffect.define<NotesModel>()
const setDrag = StateEffect.define<LineRange | null>()
const setHover = StateEffect.define<number | null>()

const SAVED_HEIGHT = 88
const DRAFT_HEIGHT = 152
const CLICK_AFTER_PRESS_MS = 400

/** The end of line `n`, or of the last line when `n` is past the document. */
const lineEnd = (doc: Text, n: number): number => doc.line(Math.min(Math.max(n, 1), doc.lines)).to

const unmounts = new WeakMap<HTMLElement, () => void>()

class CardWidget extends WidgetType {
  constructor(
    readonly spec: CardSpec,
    readonly mount: NotesExtensionOptions['mountCard']
  ) {
    super()
  }

  eq(other: CardWidget): boolean {
    const a = this.spec
    const b = other.spec
    if (a.kind === 'saved' && b.kind === 'saved') {
      return a.note.id === b.note.id && a.note.body === b.note.body && a.note.startLine === b.note.startLine && a.note.line === b.note.line
    }
    return a.kind === 'draft' && b.kind === 'draft' && a.draft.key === b.draft.key && a.draft.startLine === b.draft.startLine && a.draft.line === b.draft.line
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('div')
    element.className = 'qgv-note-widget'
    if (this.spec.kind === 'saved') element.dataset.noteId = this.spec.note.id
    unmounts.set(element, this.mount(element, this.spec, () => view.requestMeasure()))
    return element
  }

  destroy(dom: HTMLElement): void {
    unmounts.get(dom)?.()
    unmounts.delete(dom)
  }

  get estimatedHeight(): number {
    return this.spec.kind === 'draft' ? DRAFT_HEIGHT : SAVED_HEIGHT
  }

  ignoreEvent(): boolean {
    return true
  }
}

type NotesState = { model: NotesModel; drag: LineRange | null; decorations: DecorationSet }

function build(state: EditorState, model: NotesModel, drag: LineRange | null): NotesState {
  const { doc } = state
  const { mountCard } = state.facet(options)
  const ranges: Range<Decoration>[] = []
  for (const note of model.saved) {
    ranges.push(Decoration.widget({ widget: new CardWidget({ kind: 'saved', note }, mountCard), block: true, side: 1 }).range(lineEnd(doc, note.line)))
  }
  if (model.draft) {
    ranges.push(Decoration.widget({ widget: new CardWidget({ kind: 'draft', draft: model.draft }, mountCard), block: true, side: 2 }).range(lineEnd(doc, model.draft.line)))
  }
  const lit = new Set<number>()
  for (const range of [drag, model.draft]) {
    if (!range) continue
    for (let n = Math.max(1, range.startLine); n <= Math.min(doc.lines, range.line); n++) lit.add(n)
  }
  for (const n of lit) ranges.push(Decoration.line({ class: 'qgv-note-range' }).range(doc.line(n).from))
  return { model, drag, decorations: Decoration.set(ranges, true) }
}

const notesField = StateField.define<NotesState>({
  create: (state) => build(state, state.facet(options).initial, null),
  update(value, tr) {
    let { model, drag } = value
    let changed = tr.docChanged
    for (const effect of tr.effects) {
      if (effect.is(setModel)) {
        model = effect.value
        changed = true
      } else if (effect.is(setDrag)) {
        drag = effect.value
        changed = true
      }
    }
    return changed ? build(tr.state, model, drag) : value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

const hoverField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHover)) return effect.value
    return value !== null && value > tr.state.doc.lines ? null : value
  }
})

class AddMarker extends GutterMarker {
  constructor(readonly line: number) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof AddMarker && other.line === this.line
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'qgv-note-add'
    button.title = 'Add note for the AI'
    button.setAttribute('aria-label', 'Add note for the AI')
    button.dataset.line = String(this.line)
    button.textContent = '+'
    return button
  }
}

/** Reserves the gutter's width before any line is hovered. */
class SpacerMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const spacer = document.createElement('span')
    spacer.className = 'qgv-note-spacer'
    return spacer
  }
}

const NUMBER_CELL = '.cm-lineNumbers .cm-gutterElement'

/** The scrollable ancestor that a drag at the edge should pull; the page itself when none scrolls. */
function scrollParent(element: HTMLElement): HTMLElement {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement
}

type Drag = { pointerId: number; anchor: number; focus: number; clientY: number; target: EventTarget | null; frame: number | null; lastFrame: number | null }

class Interactions implements PluginValue {
  private drag: Drag | null = null
  private pressed: { line: number; at: number } | null = null

  constructor(private readonly view: EditorView) {
    view.dom.addEventListener('pointerdown', this.onDown, true)
    view.dom.addEventListener('mousedown', this.onMouseDown, true)
    view.dom.addEventListener('click', this.onClick)
    view.dom.addEventListener('mousemove', this.onMove)
    view.dom.addEventListener('mouseleave', this.onLeave)
  }

  destroy(): void {
    this.view.dom.removeEventListener('pointerdown', this.onDown, true)
    this.view.dom.removeEventListener('mousedown', this.onMouseDown, true)
    this.view.dom.removeEventListener('click', this.onClick)
    this.view.dom.removeEventListener('mousemove', this.onMove)
    this.view.dom.removeEventListener('mouseleave', this.onLeave)
    this.finish(false)
  }

  private get settings(): NotesExtensionOptions {
    return this.view.state.facet(options)
  }

  /** The line a number cell shows, or null for the hidden spacer cell or an unreadable one. */
  private cellLine(cell: Element): number | null {
    if ((cell as HTMLElement).style.visibility === 'hidden') return null
    const n = Number.parseInt(cell.textContent ?? '', 10)
    return Number.isInteger(n) && n >= 1 && n <= this.view.state.doc.lines ? n : null
  }

  /**
   * The line under a pointer event. The element the event names is trusted first, since it is
   * exact when the pointer is not captured; a captured pointer names the editor itself, so the
   * line comes from the document height at the pointer's Y instead.
   */
  private lineAt(target: EventTarget | null, clientY: number): number {
    const { view } = this
    if (target instanceof Element && view.dom.contains(target)) {
      const plus = target.closest<HTMLElement>('.qgv-note-add')
      if (plus) return Number(plus.dataset.line)
      const cell = target.closest(NUMBER_CELL)
      const fromCell = cell ? this.cellLine(cell) : null
      if (fromCell !== null) return fromCell
      const line = target.closest('.cm-line')
      if (line && line.parentElement === view.contentDOM) {
        try {
          return view.state.doc.lineAt(view.posAtDOM(line)).number
        } catch {
          // a line being replaced has no position; the height below still answers
        }
      }
    }
    return view.state.doc.lineAt(view.lineBlockAtHeight(clientY - view.documentTop).from).number
  }

  private pressLine(event: PointerEvent): number | null {
    const target = event.target
    if (!(target instanceof Element)) return null
    const plus = target.closest<HTMLElement>('.qgv-note-add')
    if (plus) return Number(plus.dataset.line)
    const cell = target.closest(NUMBER_CELL)
    if (!cell) return null
    return this.cellLine(cell) ?? this.lineAt(null, event.clientY)
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (this.drag || event.button !== 0 || event.pointerType === 'touch' || event.ctrlKey) return
    // a press while a draft is open belongs to the draft's outside-click rule
    if (this.view.state.field(notesField).model.draft) return
    const anchor = this.pressLine(event)
    if (anchor === null) return
    event.preventDefault()
    event.stopPropagation()
    try {
      this.view.dom.setPointerCapture?.(event.pointerId)
    } catch {
      // the pointer is already gone; the document listeners still finish the drag
    }
    this.drag = { pointerId: event.pointerId, anchor, focus: anchor, clientY: event.clientY, target: event.target, frame: null, lastFrame: null }
    document.addEventListener('pointermove', this.onPointerMove)
    document.addEventListener('pointerup', this.onUp)
    document.addEventListener('pointercancel', this.onCancel)
    document.addEventListener('lostpointercapture', this.onCancel)
    document.addEventListener('keydown', this.onKey, true)
    this.paint()
  }

  // Chromium still sends the compatibility mousedown after a cancelled pointerdown; swallowing it
  // keeps the editor from starting a text selection under the drag.
  private readonly onMouseDown = (event: MouseEvent): void => {
    if (!this.drag) return
    event.preventDefault()
    event.stopPropagation()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const { drag } = this
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.clientY = event.clientY
    drag.target = event.target
    this.schedule()
  }

  private readonly onUp = (event: PointerEvent): void => {
    const { drag } = this
    if (!drag || event.pointerId !== drag.pointerId) return
    // the release can carry a position no move reported, and can beat the next frame
    drag.focus = this.lineAt(event.target, event.clientY)
    const range = orderRange(drag.anchor, drag.focus)
    this.finish()
    this.pressed = { line: drag.anchor, at: Date.now() }
    this.settings.onRange(range)
  }

  private readonly onCancel = (event: Event): void => {
    const { drag } = this
    if (!drag || ('pointerId' in event && (event as PointerEvent).pointerId !== drag.pointerId)) return
    this.finish()
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.drag || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    this.finish()
  }

  private readonly onClick = (event: MouseEvent): void => {
    const plus = event.target instanceof Element ? event.target.closest<HTMLElement>('.qgv-note-add') : null
    if (!plus) return
    event.preventDefault()
    const line = Number(plus.dataset.line)
    // the press already opened this line's draft; the click that follows it must not open another
    if (this.pressed && this.pressed.line === line && Date.now() - this.pressed.at < CLICK_AFTER_PRESS_MS) {
      this.pressed = null
      return
    }
    this.settings.onRange({ startLine: line, line })
  }

  private readonly onMove = (event: MouseEvent): void => {
    if (this.drag) return
    const target = event.target
    if (target instanceof Element && target.closest('.qgv-note-widget')) return
    const line = this.lineAt(target, event.clientY)
    if (line !== this.view.state.field(hoverField)) this.view.dispatch({ effects: setHover.of(line) })
  }

  private readonly onLeave = (): void => {
    if (this.drag || this.view.state.field(hoverField) === null) return
    this.view.dispatch({ effects: setHover.of(null) })
  }

  private paint(): void {
    const { drag } = this
    this.view.dispatch({ effects: setDrag.of(drag ? orderRange(drag.anchor, drag.focus) : null) })
  }

  private schedule(): void {
    const { drag } = this
    if (!drag || drag.frame !== null) return
    drag.frame = requestAnimationFrame(this.runFrame)
  }

  /** One hit-test, one scroll step and one repaint per frame, however many moves arrived. */
  private readonly runFrame = (now: number): void => {
    const { drag } = this
    if (!drag) return
    drag.frame = null
    const delta = drag.lastFrame === null ? REFERENCE_FRAME_MS : now - drag.lastFrame
    drag.lastFrame = now
    const scroller = scrollParent(this.view.dom)
    const rect = scroller === document.documentElement || scroller === document.body ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect()
    const step = dragScrollStep({ top: rect.top, bottom: rect.bottom, clientY: drag.clientY, frameDeltaMs: delta })
    let scrolling = false
    if (step !== 0) {
      const before = scroller.scrollTop
      scroller.scrollTop = before + step
      scrolling = scroller.scrollTop !== before
    }
    const focus = this.lineAt(drag.target, drag.clientY)
    if (focus !== drag.focus) {
      drag.focus = focus
      this.paint()
    }
    // a held, still pointer costs nothing; the loop runs only while the edge is pulling
    if (scrolling) this.schedule()
  }

  /** Ends the drag; `repaint` is false while the editor is being torn down. */
  private finish(repaint = true): void {
    const { drag } = this
    if (!drag) return
    if (drag.frame !== null) cancelAnimationFrame(drag.frame)
    this.drag = null
    document.removeEventListener('pointermove', this.onPointerMove)
    document.removeEventListener('pointerup', this.onUp)
    document.removeEventListener('pointercancel', this.onCancel)
    document.removeEventListener('lostpointercapture', this.onCancel)
    document.removeEventListener('keydown', this.onKey, true)
    try {
      this.view.dom.releasePointerCapture?.(drag.pointerId)
    } catch {
      // capture was never taken or is already gone
    }
    if (repaint) this.view.dispatch({ effects: setDrag.of(null) })
  }
}

const addNoteKeymap = keymap.of([
  {
    key: 'Mod-Shift-a',
    preventDefault: true,
    run(view) {
      // an open draft owns the chord; reopening here would move what the person already typed
      if (view.state.field(notesField).model.draft) return true
      view.state.facet(options).onRange(selectionLineRange(view.state))
      return true
    }
  }
])

/**
 * Notes for the modified side of a diff: a gutter "+" on the hovered line, a drag across the line
 * numbers, Mod-Shift-a on the selection, and a block card under each note and draft. Gestures are
 * reported through `onRange`; what to draw arrives through `setNotesModel`, so the notes live
 * outside the editor and survive it being rebuilt.
 */
export function notesExtension(config: NotesExtensionOptions): Extension {
  return [
    options.of(config),
    notesField,
    hoverField,
    Prec.high(
      gutter({
        class: 'qgv-note-gutter',
        lineMarker(view, block) {
          const hovered = view.state.field(hoverField)
          return hovered !== null && view.state.doc.lineAt(block.from).number === hovered ? new AddMarker(hovered) : null
        },
        lineMarkerChange: (update) => update.startState.field(hoverField) !== update.state.field(hoverField),
        initialSpacer: () => new SpacerMarker()
      })
    ),
    ViewPlugin.fromClass(Interactions),
    Prec.high(addNoteKeymap)
  ]
}

/** Replaces what the editor draws. */
export function setNotesModel(view: EditorView, model: NotesModel): void {
  view.dispatch({ effects: setModel.of(model) })
}

/** Scrolls the card of note `id` into view; false when the editor draws no such note. */
export function revealNote(view: EditorView, id: string): boolean {
  const note = view.state.field(notesField).model.saved.find((saved) => saved.id === id)
  if (!note) return false
  view.dispatch({ effects: EditorView.scrollIntoView(lineEnd(view.state.doc, note.line), { y: 'center' }) })
  // the card exists only once the editor has drawn the line it hangs under
  view.requestMeasure({
    read: () => [...view.dom.querySelectorAll<HTMLElement>('[data-note-id]')].find((el) => el.dataset.noteId === id) ?? null,
    write: (card) => void card?.scrollIntoView?.({ block: 'center' })
  })
  return true
}
