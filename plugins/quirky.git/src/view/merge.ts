import { EditorState, EditorSelection, type Extension, type Text } from '@codemirror/state'
import {
  EditorView,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers
} from '@codemirror/view'
import {
  MergeView,
  diff,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  rejectChunk,
  unifiedMergeView,
  type Chunk,
  type DiffConfig
} from '@codemirror/merge'
import { withoutTrailingNewline } from '../diffText'
import { notesExtension, revealNote, setNotesModel, type NotesExtensionOptions, type NotesModel } from '../notes/extension'
import { selectionLineRange, type LineRange } from '../notes/line-range'
import { lineBreakExtension, shellTheme, syntaxExtensions } from './theme'

export type MergeOptions = {
  original: string
  modified: string
  path: string
  sideBySide: boolean
  wrap: boolean
  showWhitespace: boolean
  collapseUnchanged: boolean
  /** The modified side takes edits, shows Revert Block, and Mod+S calls `onSave`. */
  editable: boolean
  /** Select the first change on creation; default true. */
  scrollToFirst?: boolean
  onSave?(): void
  /** The modified document changed. */
  onDocChange?(): void
  /** The selection or the set of changes changed. */
  onUpdate?(): void
  onFocus?(): void
  /** Draws notes on the modified side and reports the gestures that ask for one. */
  notes?: NotesExtensionOptions
}

/** A mounted diff editor: navigation over its changes and access to the modified text. */
export type MergeHandle = {
  destroy(): void
  /** Moves to the next change, wrapping; false when there is none. */
  nextChange(): boolean
  previousChange(): boolean
  /** Selects change `n` (1-based) and scrolls to it. */
  goToChange(n: number): boolean
  /** The 1-based change holding the cursor, or null. */
  currentChange(): number | null
  changeCount(): number
  /** Puts the change holding the cursor back to the original text, in the editor only. */
  revertChange(): boolean
  getModified(): string
  focus(): void
  /** Replaces the notes the modified side draws; a no-op unless `options.notes` was given. */
  setNotes(model: NotesModel): void
  /** Scrolls the card of note `id` into view; false when it is not drawn. */
  revealNote(id: string): boolean
  /** The lines the modified side's selection covers, for a note. */
  selectionRange(): LineRange
}

const TRIM_ONLY = /^[ \t]*$/

/** Whether `text[from, to)` is blanks inside the indentation or the trailing run of its line. */
function atLineEdge(text: string, from: number, to: number): boolean {
  if (!TRIM_ONLY.test(text.slice(from, to))) return false
  const lineStart = text.lastIndexOf('\n', from - 1) + 1
  const newline = text.indexOf('\n', to)
  const lineEnd = newline === -1 ? text.length : newline
  return TRIM_ONLY.test(text.slice(lineStart, to)) || TRIM_ONLY.test(text.slice(from, lineEnd))
}

/**
 * Drops character changes that only add or remove leading or trailing spaces and tabs, which is
 * how "show whitespace" off hides trim-whitespace differences. Blanks between other characters,
 * string literals included, and any change touching a line break stay.
 */
function ignoreTrimWhitespace(): DiffConfig {
  return {
    scanLimit: 500,
    override: (a, b) =>
      diff(a, b, { scanLimit: 500 }).filter(
        (change) => !(atLineEdge(a, change.fromA, change.toA) && atLineEdge(b, change.fromB, change.toB))
      )
  }
}

function hostExtensions(options: MergeOptions, host: Element, side: 'a' | 'b'): Extension[] {
  const editable = side === 'b' && options.editable
  const extensions: Extension[] = [
    lineNumbers(),
    shellTheme,
    syntaxExtensions(options.path, host),
    lineBreakExtension(options.modified)
  ]
  if (options.wrap) extensions.push(EditorView.lineWrapping)
  if (options.showWhitespace) extensions.push(highlightWhitespace(), highlightTrailingWhitespace())
  if (!editable) extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
  if (side === 'b') {
    if (options.notes) extensions.push(notesExtension(options.notes))
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onDocChange?.()
        if (update.docChanged || update.selectionSet) options.onUpdate?.()
      }),
      EditorView.domEventHandlers({ focus: () => void options.onFocus?.() })
    )
    if (editable) {
      extensions.push(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              options.onSave?.()
              return true
            }
          }
        ])
      )
    }
  }
  return extensions
}

/** The inline view's chunk buttons: Revert Block only, since accepting would edit the comparison side. */
function revertOnlyControls(type: 'reject' | 'accept', action: (event: MouseEvent) => void): HTMLElement {
  const button = document.createElement('button')
  if (type === 'accept') {
    button.hidden = true
    return button
  }
  button.type = 'button'
  button.name = 'reject'
  button.textContent = 'Revert Block'
  button.setAttribute('aria-label', 'Revert Block')
  button.addEventListener('mousedown', action)
  return button
}

/** Puts `chunk` of `view` back to the text it has in `original`; the same edit `rejectChunk` makes for the inline view. */
function revertChunk(view: EditorView, chunk: Chunk, original: Text): void {
  let insert = original.sliceString(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1), view.state.lineBreak)
  if (chunk.fromA !== chunk.toA && chunk.toB <= view.state.doc.length) insert += view.state.lineBreak
  view.dispatch({
    changes: { from: chunk.fromB, to: Math.min(view.state.doc.length, chunk.toB), insert },
    userEvent: 'revert'
  })
}

/**
 * Mounts a diff of `original` against `modified` in `parent`: side by side (a `MergeView`) or
 * inline (one editor with a unified merge view). Colours come from the shell's theme variables.
 * Read-only diffs drop one trailing line break so no empty last line shows; editable ones keep
 * the text exactly so a save does not rewrite the file's ending.
 */
export function createMerge(parent: HTMLElement, options: MergeOptions): MergeHandle {
  const trim = options.editable ? (text: string) => text : withoutTrailingNewline
  const original = trim(options.original)
  const modified = trim(options.modified)
  const diffConfig = options.showWhitespace ? { scanLimit: 500 } : ignoreTrimWhitespace()
  const collapse = options.collapseUnchanged ? { margin: 3, minSize: 4 } : undefined

  let editor: EditorView
  let sideA: EditorView | null = null
  let destroy: () => void
  if (options.sideBySide) {
    const view = new MergeView({
      a: { doc: original, extensions: hostExtensions(options, parent, 'a') },
      b: { doc: modified, extensions: hostExtensions(options, parent, 'b') },
      parent,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: collapse,
      diffConfig,
      ...(options.editable ? { revertControls: 'a-to-b' as const } : {})
    })
    editor = view.b
    sideA = view.a
    destroy = () => view.destroy()
  } else {
    editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: modified,
        extensions: [
          hostExtensions(options, parent, 'b'),
          unifiedMergeView({
            original,
            gutter: true,
            highlightChanges: true,
            mergeControls: options.editable ? revertOnlyControls : false,
            collapseUnchanged: collapse,
            diffConfig
          })
        ]
      })
    })
    destroy = () => editor.destroy()
  }

  const chunks = (): readonly Chunk[] => getChunks(editor.state)?.chunks ?? []

  const goToChange = (n: number): boolean => {
    const chunk = chunks()[n - 1]
    if (!chunk) return false
    editor.dispatch({
      selection: EditorSelection.cursor(chunk.fromB),
      effects: EditorView.scrollIntoView(EditorSelection.range(chunk.endB, chunk.fromB), { y: 'start', yMargin: 24 }),
      userEvent: 'select.byChunk'
    })
    return true
  }

  const currentChange = (): number | null => {
    const head = editor.state.selection.main.head
    const index = chunks().findIndex((chunk) => chunk.fromB <= head && head <= chunk.endB)
    return index === -1 ? null : index + 1
  }

  if (options.scrollToFirst !== false) goToChange(1)

  return {
    destroy,
    nextChange: () => goToNextChunk(editor),
    previousChange: () => goToPreviousChunk(editor),
    goToChange,
    currentChange,
    changeCount: () => chunks().length,
    revertChange() {
      const at = currentChange()
      if (at === null) return false
      if (!sideA) return rejectChunk(editor, editor.state.selection.main.head)
      revertChunk(editor, chunks()[at - 1], sideA.state.doc)
      return true
    },
    getModified: () => editor.state.sliceDoc(),
    focus: () => editor.focus(),
    setNotes: (model) => {
      if (options.notes) setNotesModel(editor, model)
    },
    revealNote: (id) => (options.notes ? revealNote(editor, id) : false),
    selectionRange: () => selectionLineRange(editor.state)
  }
}
