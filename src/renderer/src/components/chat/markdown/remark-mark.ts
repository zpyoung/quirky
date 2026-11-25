import type { PhrasingContent, Root } from 'mdast'
import { SKIP, visit } from 'unist-util-visit'

const MARK = /==(?=\S)([^=\n]*?\S)==/g

/** Turns `==text==` inside a text node into a `<mark>`. Text split across other markup is left alone. */
export function remarkMark() {
  return (tree: Root) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined || !node.value.includes('==')) {
        return
      }
      const parts: PhrasingContent[] = []
      let cursor = 0
      for (const match of node.value.matchAll(MARK)) {
        const start = match.index ?? 0
        if (start > cursor) {
          parts.push({ type: 'text', value: node.value.slice(cursor, start) })
        }
        parts.push({
          type: 'emphasis',
          data: { hName: 'mark' },
          children: [{ type: 'text', value: match[1] }]
        })
        cursor = start + match[0].length
      }
      if (parts.length === 0) {
        return
      }
      if (cursor < node.value.length) {
        parts.push({ type: 'text', value: node.value.slice(cursor) })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parent of a text node holds phrasing content
      ;(parent.children as PhrasingContent[]).splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}
