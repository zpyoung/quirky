import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  type EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { tags } from '@lezer/highlight'

const style = HighlightStyle.define([
  { tag: tags.strong, class: 'cm-composer-strong' },
  { tag: tags.emphasis, class: 'cm-composer-emphasis' },
  { tag: tags.strikethrough, class: 'cm-composer-strike' },
  {
    tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4],
    class: 'cm-composer-heading'
  },
  { tag: tags.monospace, class: 'cm-composer-code' },
  { tag: tags.quote, class: 'cm-composer-muted' },
  { tag: tags.link, class: 'cm-composer-link' },
  { tag: [tags.url, tags.labelName, tags.processingInstruction], class: 'cm-composer-muted' }
])

const codeLine = Decoration.line({ class: 'cm-composer-codeblock' })
const listLine = Decoration.line({ class: 'cm-composer-listline' })

function lineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const marked = new Set<number>()
  const lines: [number, Decoration][] = []
  const add = (from: number, to: number, deco: Decoration) => {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos)
      if (!marked.has(line.from)) {
        marked.add(line.from)
        lines.push([line.from, deco])
      }
      pos = line.to + 1
    }
  }
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'FencedCode') {
          add(node.from, node.to, codeLine)
        } else if (node.name === 'ListItem') {
          add(node.from, view.state.doc.lineAt(node.from).to, listLine)
        }
      }
    })
  }
  lines.sort((a, b) => a[0] - b[0])
  for (const [pos, deco] of lines) {
    builder.add(pos, pos, deco)
  }
  return builder.finish()
}

const lineStyling = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = lineDecorations(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = lineDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

/** Markdown styling with every syntax character left visible; markers get a faded token color. */
export const markdownStyling: Extension = [markdown(), syntaxHighlighting(style), lineStyling]
