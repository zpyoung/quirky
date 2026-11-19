import { defaultSchema } from 'rehype-sanitize'
import type { Options as Schema } from 'rehype-sanitize'

const CODE_CLASS = /^(?:language-[\w.+-]+|math-inline|math-display)$/
const CLOBBER_PREFIX = 'user-content-'

/**
 * What the untrusted profile lets through after the raw HTML step: the markdown tags, the allowed raw
 * tags (never with attributes), and only the hast that quirky's own plugins emit. KaTeX and Shiki
 * output is produced after this runs, so it is not listed.
 */
export const UNTRUSTED_SCHEMA: Schema = {
  tagNames: [
    'a', 'blockquote', 'br', 'code', 'del', 'details', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'input',
    'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'section', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th',
    'thead', 'tr', 'ul'
  ],
  attributes: {
    a: ['ariaDescribedBy', 'ariaLabel', 'dataFootnoteBackref', 'dataFootnoteRef', ['className', 'data-footnote-backref'], 'href', 'id'],
    code: [['className', CODE_CLASS], 'metastring', 'dataPathCandidate'],
    h2: [['className', 'sr-only'], 'id'],
    img: ['alt', 'src', 'title'],
    input: [['disabled', true], ['type', 'checkbox'], 'checked'],
    li: [['className', 'task-list-item'], 'id'],
    ol: [['className', 'contains-task-list'], 'start'],
    section: ['dataFootnotes', ['className', 'footnotes']],
    td: ['align'],
    th: ['align'],
    ul: [['className', 'contains-task-list']]
  },
  protocols: { href: ['http', 'https'], src: ['http', 'https'] },
  ancestors: defaultSchema.ancestors,
  required: defaultSchema.required,
  clobber: ['ariaDescribedBy', 'id'],
  clobberPrefix: CLOBBER_PREFIX,
  strip: ['script', 'style']
}

type HastNode = { type: string; properties?: Record<string, unknown>; children?: HastNode[] }

/**
 * remark-rehype already prefixes footnote ids, so sanitize's clobber prefix doubles it. This keeps one
 * prefix on ids and on the `#` links that point at them.
 */
export function rehypeUndoubleClobber() {
  const doubled = `${CLOBBER_PREFIX}${CLOBBER_PREFIX}`
  const visit = (node: HastNode) => {
    const properties = node.properties
    if (node.type === 'element' && properties) {
      if (typeof properties.id === 'string' && properties.id.startsWith(doubled)) properties.id = properties.id.slice(CLOBBER_PREFIX.length)
      if (typeof properties.href === 'string' && properties.href.startsWith(`#${doubled}`)) {
        properties.href = `#${properties.href.slice(1 + CLOBBER_PREFIX.length)}`
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  return (tree: HastNode) => visit(tree)
}
