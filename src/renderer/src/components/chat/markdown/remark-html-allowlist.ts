import type { Html, Parent, Root, RootContent, Text } from 'mdast'
import { visit } from 'unist-util-visit'

const ALLOWED_TAGS = new Set(['details', 'summary', 'kbd', 'sub', 'sup', 'mark', 'br'])
const PHRASING_PARENTS = new Set([
  'paragraph',
  'heading',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'tableCell'
])
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/y

/**
 * Rewrites a raw HTML source into one where allowed tags carry no attributes and every other `<`
 * is escaped, so the later raw-HTML parse can only ever produce allowed elements. Returns null
 * when no allowed tag is present.
 */
function allowTags(value: string): string | null {
  let out = ''
  let kept = false
  let index = 0
  while (index < value.length) {
    if (value[index] !== '<') {
      out += value[index]
      index += 1
      continue
    }
    TAG.lastIndex = index
    const match = TAG.exec(value)
    const name = match?.[2].toLowerCase()
    if (match && name && ALLOWED_TAGS.has(name)) {
      out += name === 'br' ? '<br>' : `<${match[1]}${name}>`
      kept = true
      index += match[0].length
    } else {
      out += '&lt;'
      index += 1
    }
  }
  return kept ? out : null
}

/**
 * The untrusted profile's raw HTML rule: `details`, `summary`, `kbd`, `sub`, `sup`, `mark` and `br`
 * survive with no attributes, and every other `html` node becomes literal text.
 */
export function remarkHtmlAllowlist() {
  return (tree: Root) => {
    visit(tree, 'html', (node: Html, index, parent) => {
      if (!parent || index === undefined) {
        return
      }
      const rewritten = allowTags(node.value)
      if (rewritten !== null) {
        node.value = rewritten
        return
      }
      const text: Text = { type: 'text', value: node.value }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a parent of an html node is a Parent
      const replacement = PHRASING_PARENTS.has((parent as Parent).type)
        ? text
        : { type: 'paragraph' as const, children: [text] }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an html node sits where a paragraph or phrasing content is allowed, and the replacement matches its parent
      ;(parent.children as RootContent[]).splice(index, 1, replacement)
    })
  }
}
