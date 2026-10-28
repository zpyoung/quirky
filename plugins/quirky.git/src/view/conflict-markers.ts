import { RangeSetBuilder, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

/** One conflict block; every field is a 1-based line number. `base` is present only in diff3-style blocks. */
export type ConflictBlock = { start: number; base?: number; separator: number; end: number }

const START = /^<{7}(?: |$)/
const BASE = /^\|{7}(?: |$)/
const SEPARATOR = /^={7}$/
const END = /^>{7}(?: |$)/

/**
 * The complete conflict blocks in `text`: `<<<<<<<` to `>>>>>>>` with a `=======` between and an
 * optional `|||||||` before it. Lines are counted the way CodeMirror counts them (CRLF and lone
 * CR are one break). Unterminated blocks are skipped, so text mid-edit never throws a wrong
 * range. A second `<<<<<<<` before the first block closes starts a new block instead of
 * nesting, which keeps later blocks visible while the person is deleting markers.
 */
export function conflictBlocks(text: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = []
  let open: Partial<ConflictBlock> | null = null
  text.split(/\r\n?|\n/).forEach((line, index) => {
    const n = index + 1
    if (START.test(line)) {
      open = { start: n }
    } else if (open === null) {
      return
    } else if (BASE.test(line)) {
      if (open.separator === undefined && open.base === undefined) open.base = n
    } else if (SEPARATOR.test(line)) {
      if (open.separator === undefined) open.separator = n
    } else if (END.test(line) && open.separator !== undefined) {
      const { start, base, separator } = open as ConflictBlock
      blocks.push(base === undefined ? { start, separator, end: n } : { start, base, separator, end: n })
      open = null
    }
  })
  return blocks
}

const LINE_CLASSES = {
  marker: 'ui-editor-conflict-marker',
  current: 'ui-editor-conflict-current',
  base: 'ui-editor-conflict-base',
  incoming: 'ui-editor-conflict-incoming'
} as const

class LabelWidget extends WidgetType {
  constructor(readonly label: string) {
    super()
  }

  eq(other: LabelWidget): boolean {
    return other.label === this.label
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'ui-editor-conflict-label'
    span.textContent = this.label
    return span
  }
}

const lineDecoration = (cls: string) => Decoration.line({ class: cls })

export function conflictDecorationSet(doc: Text): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const marker = (lineNumber: number, label: string) => {
    const line = doc.line(lineNumber)
    builder.add(line.from, line.from, lineDecoration(LINE_CLASSES.marker))
    builder.add(line.to, line.to, Decoration.widget({ widget: new LabelWidget(label), side: 1 }))
  }
  const side = (first: number, last: number, cls: string) => {
    for (let n = first; n <= last; n++) {
      const from = doc.line(n).from
      builder.add(from, from, lineDecoration(cls))
    }
  }
  for (const block of conflictBlocks(doc.toString())) {
    marker(block.start, 'Current change')
    side(block.start + 1, (block.base ?? block.separator) - 1, LINE_CLASSES.current)
    if (block.base !== undefined) {
      marker(block.base, 'Common ancestor')
      side(block.base + 1, block.separator - 1, LINE_CLASSES.base)
    }
    marker(block.separator, 'Incoming change')
    side(block.separator + 1, block.end - 1, LINE_CLASSES.incoming)
    marker(block.end, 'End conflict')
  }
  return builder.finish()
}

const field = StateField.define<DecorationSet>({
  create: (state: EditorState) => conflictDecorationSet(state.doc),
  update: (value, tr) => (tr.docChanged ? conflictDecorationSet(tr.state.doc) : value),
  provide: (f) => EditorView.decorations.from(f)
})

/** A CodeMirror 6 extension that highlights conflict blocks and keeps them current as the document changes. */
export function conflictDecorations(): Extension {
  return field
}
