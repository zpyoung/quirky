import { createElement, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

/** The tags of `read-only-preview`'s sanitizer schema, which the ask preview feeds it. */
const ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'caption', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
]

const STRIPPED_WITH_CONTENT = [
  'audio', 'base', 'button', 'embed', 'form', 'iframe', 'img', 'input', 'link', 'math', 'meta', 'object',
  'script', 'source', 'style', 'svg', 'video'
]

const SCHEMA = {
  ...defaultSchema,
  tagNames: ALLOWED_TAGS,
  attributes: { a: ['href'] },
  protocols: { href: ['http', 'https'] },
  strip: [...(defaultSchema.strip ?? []), ...STRIPPED_WITH_CONTENT]
} satisfies typeof defaultSchema

// raw HTML is never enabled, so remark-rehype drops it before the sanitizer sees it
const PROCESSOR = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSanitize, SCHEMA)

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

const ABSOLUTE_WEB_URL = /^https?:\/\/\S+$/i
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tr', 'ul', 'ol'])

const HEADING: CSSProperties = { margin: 0, fontSize: 'var(--ui-font-title)', lineHeight: 1.4 }
const BLOCK: CSSProperties = { margin: 0 }
const MONO: CSSProperties = { fontFamily: 'var(--ui-font-mono)', fontSize: 'var(--ui-font-mono)' }
const CELL: CSSProperties = {
  border: 'var(--ui-border-width) solid var(--ui-border)',
  padding: 'var(--ui-space-4) var(--ui-space-6)',
  textAlign: 'left'
}

const TAG_STYLES: Record<string, CSSProperties> = {
  h1: HEADING,
  h2: HEADING,
  h3: HEADING,
  h4: HEADING,
  h5: HEADING,
  h6: HEADING,
  p: BLOCK,
  blockquote: { margin: 0, paddingInlineStart: 'var(--ui-space-12)', borderInlineStart: 'var(--ui-focus-width) solid var(--ui-border)', color: 'var(--ui-muted)' },
  ul: { margin: 0, paddingInlineStart: 'var(--ui-space-24)' },
  ol: { margin: 0, paddingInlineStart: 'var(--ui-space-24)' },
  pre: { ...MONO, margin: 0, padding: 'var(--ui-space-8)', overflow: 'auto', background: 'var(--ui-selected)', borderRadius: 'var(--ui-radius-control)' },
  code: MONO,
  hr: { border: 0, borderTop: 'var(--ui-border-width) solid var(--ui-border)', margin: 0, width: '100%' },
  table: { borderCollapse: 'collapse' },
  th: CELL,
  td: CELL,
  a: { color: 'var(--ui-accent)' }
}

function toReact(node: HastNode, key: string, parent: string | undefined, onLink: (href: string) => void): ReactNode {
  if (node.type === 'text') {
    const value = node.value ?? ''
    return parent !== undefined && TABLE_PARTS.has(parent) && value.trim() === '' ? null : value
  }
  if (node.type !== 'element' || node.tagName === undefined) return null
  const tag = node.tagName
  const children = (node.children ?? []).map((child, index) => toReact(child, String(index), tag, onLink))
  if (tag === 'a') {
    const href = node.properties?.href
    if (typeof href !== 'string' || !ABSOLUTE_WEB_URL.test(href)) return createElement('span', { key }, ...children)
    const open = (event: MouseEvent) => {
      event.preventDefault()
      onLink(href)
    }
    return createElement('a', { key, href, style: TAG_STYLES.a, rel: 'noreferrer noopener', onClick: open, onAuxClick: open }, ...children)
  }
  return createElement(tag, { key, style: TAG_STYLES[tag] }, ...children)
}

/**
 * Turns untrusted markdown into React elements. Only the tags of the ask preview's sanitizer
 * schema survive, with no attributes except `href` on `a`, and only for absolute http(s) URLs;
 * images and raw HTML are dropped. A link click does not navigate: it calls `onLink` with the URL.
 */
export function renderMarkdown(text: string, onLink: (href: string) => void): ReactNode[] {
  const tree = PROCESSOR.runSync(PROCESSOR.parse(text)) as unknown as HastNode
  return (tree.children ?? []).map((child, index) => toReact(child, String(index), undefined, onLink))
}
