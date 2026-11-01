import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Editor } from '@tiptap/core'
import { MARKDOWN_MAX_SEARCH_MATCHES, MARKDOWN_SEARCH_MAX_BYTES, utf8Bytes } from './source'

export type RichSearchRange = { from: number; to: number }

type AtomRange = { from: number; to: number }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Finds visible text in editor coordinates, including words split across inline marks. */
export function findRichMatches(
  editor: Editor,
  query: string,
  options: { matchCase?: boolean; wholeWord?: boolean }
): { matches: RichSearchRange[]; total: number } {
  if (query === '' || utf8Bytes(query) > 2048) return { matches: [], total: 0 }

  const core = escapeRegExp(query)
  const pattern = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${core}(?![\\p{L}\\p{N}_])` : core
  const expression = new RegExp(pattern, `${options.matchCase ? '' : 'i'}gu`)
  const encoder = new TextEncoder()
  const matches: RichSearchRange[] = []
  let total = 0
  let contentBytes = 0
  let blockCount = 0
  let oversized = false

  editor.state.doc.descendants((block, blockPosition) => {
    if (!block.isTextblock) return

    const pieces: string[] = []
    const atoms: AtomRange[] = []
    let blockBytes = blockCount === 0 ? 0 : 1
    if (contentBytes + blockBytes > MARKDOWN_SEARCH_MAX_BYTES) {
      oversized = true
      return false
    }

    block.forEach((child, offset) => {
      if (oversized) return

      const remainingBytes = MARKDOWN_SEARCH_MAX_BYTES - contentBytes - blockBytes
      if (child.isText) {
        const text = child.text ?? ''
        if (text.length > remainingBytes) {
          oversized = true
          return
        }
        const bytes = encoder.encode(text).byteLength
        if (bytes > remainingBytes) {
          oversized = true
          return
        }
        blockBytes += bytes
        pieces.push(text)
      } else {
        const bytes = child.nodeSize * 3
        if (bytes > remainingBytes) {
          oversized = true
          return
        }
        blockBytes += bytes
        atoms.push({ from: offset, to: offset + child.nodeSize })
        pieces.push('\uFFFC'.repeat(child.nodeSize))
      }

    })

    if (oversized) return false
    contentBytes += blockBytes
    blockCount += 1

    const text = pieces.join('')
    expression.lastIndex = 0
    let atomIndex = 0
    let match: RegExpExecArray | null
    while ((match = expression.exec(text)) !== null) {
      const from = match.index
      const to = from + match[0].length
      while (atoms[atomIndex] && atoms[atomIndex]!.to <= from) atomIndex += 1
      if (atoms[atomIndex] && atoms[atomIndex]!.from < to) continue

      total += 1
      if (matches.length < MARKDOWN_MAX_SEARCH_MATCHES) {
        matches.push({ from: blockPosition + 1 + from, to: blockPosition + 1 + to })
      }
    }

    return false
  })

  return oversized ? { matches: [], total: 0 } : { matches, total }
}

const richSearchHighlightKey = new PluginKey<DecorationSet>('markdownRichSearchHighlight')
const searchHighlightAttributes = {
  class: 'markdown-search-match',
  style: 'background-color: color-mix(in srgb, var(--ui-accent) 30%, transparent); outline: 1px solid var(--ui-accent);'
}

export const RichSearchHighlight = Extension.create({
  name: 'markdownRichSearchHighlight',
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: richSearchHighlightKey,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, decorations) {
          if (transaction.docChanged) return DecorationSet.empty
          const range = transaction.getMeta(richSearchHighlightKey) as RichSearchRange | null | undefined
          if (range === undefined) return decorations
          return range === null
            ? DecorationSet.empty
            : DecorationSet.create(transaction.doc, [Decoration.inline(range.from, range.to, searchHighlightAttributes)])
        }
      },
      props: {
        decorations(state) {
          return richSearchHighlightKey.getState(state) ?? DecorationSet.empty
        }
      }
    })]
  }
})

/** Reveals the active match without transferring keyboard focus to the document. */
export function revealRichSearchMatch(editor: Editor, range: RichSearchRange | null): void {
  const transaction = editor.state.tr
  if (range !== null) transaction.setSelection(TextSelection.create(transaction.doc, range.from, range.to))
  editor.view.dispatch(transaction.setMeta(richSearchHighlightKey, range))
  if (range !== null) editor.view.dom.querySelector('.markdown-search-match')?.scrollIntoView({ block: 'nearest' })
}
