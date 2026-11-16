import { createElement, useMemo, type CSSProperties, type ReactNode } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

const TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre',
  'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
]
const VOID = new Set(['br', 'hr'])

// raw html never reaches the tree because remark-rehype is not told to keep it; the schema is the second gate
const SCHEMA = {
  ...defaultSchema,
  tagNames: TAGS,
  attributes: { a: ['href'], code: [['className', /^language-[\w.+-]+$/]], ol: ['start'] },
  protocols: { href: ['http', 'https'] },
  clobber: []
} satisfies typeof defaultSchema

const PROCESSOR = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSanitize, SCHEMA)

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

const mono = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 'var(--ui-font-mono)' } satisfies CSSProperties
const styles: Record<string, CSSProperties> = {
  p: { margin: '0 0 var(--ui-space-6)' },
  pre: { ...mono, margin: '0 0 var(--ui-space-6)', padding: 'var(--ui-space-6) var(--ui-space-8)', overflowX: 'auto', background: 'var(--ui-selected)', borderRadius: 'var(--ui-radius-control)' },
  blockquote: { margin: '0 0 var(--ui-space-6)', paddingInlineStart: 'var(--ui-space-8)', color: 'var(--ui-muted)', borderInlineStart: 'var(--ui-border-width) solid var(--ui-border)' },
  ul: { margin: '0 0 var(--ui-space-6)', paddingInlineStart: 'var(--ui-space-16)' },
  ol: { margin: '0 0 var(--ui-space-6)', paddingInlineStart: 'var(--ui-space-16)' },
  table: { borderCollapse: 'collapse', margin: '0 0 var(--ui-space-6)' },
  th: { padding: 'var(--ui-space-4) var(--ui-space-8)', textAlign: 'left', borderBottom: 'var(--ui-border-width) solid var(--ui-border)' },
  td: { padding: 'var(--ui-space-4) var(--ui-space-8)', borderBottom: 'var(--ui-border-width) solid var(--ui-border)' },
  h1: { margin: '0 0 var(--ui-space-6)', fontSize: 'var(--ui-font-title)' },
  h2: { margin: '0 0 var(--ui-space-6)', fontSize: 'var(--ui-font-title)' },
  h3: { margin: '0 0 var(--ui-space-6)', fontSize: 'var(--ui-font-body)' },
  h4: { margin: '0 0 var(--ui-space-6)', fontSize: 'var(--ui-font-body)' },
  h5: { margin: '0 0 var(--ui-space-6)', fontSize: 'var(--ui-font-body)' },
  h6: { margin: '0 0 var(--ui-space-6)', fontSize: 'var(--ui-font-body)' }
}
const inlineCode = { ...mono, padding: '0 var(--ui-space-4)', background: 'var(--ui-selected)', borderRadius: 'var(--ui-radius-mark)' } satisfies CSSProperties
const root = { minWidth: 0, overflowWrap: 'anywhere' } satisfies CSSProperties
const caret = { color: 'var(--ui-accent)' } satisfies CSSProperties

function toReact(node: HastNode, key: number, inPre: boolean, openLink: (href: string) => void): ReactNode {
  if (node.type === 'text') return node.value ?? ''
  if (node.type !== 'element' || !node.tagName || !TAGS.includes(node.tagName)) return null
  const tag = node.tagName
  const children = VOID.has(tag) ? undefined : (node.children ?? []).map((child, index) => toReact(child, index, inPre || tag === 'pre', openLink))
  const props: Record<string, unknown> = { key }
  if (styles[tag]) props.style = styles[tag]
  if (tag === 'code') {
    const className = node.properties?.className
    if (Array.isArray(className)) props.className = className.join(' ')
    if (!inPre) props.style = inlineCode
  }
  if (tag === 'a') {
    const href = node.properties?.href
    if (typeof href !== 'string') return children
    props.href = href
    props.rel = 'noopener noreferrer'
    props.style = { color: 'var(--ui-accent)' }
    props.onClick = (event: { preventDefault(): void }) => {
      event.preventDefault()
      openLink(href)
    }
  }
  if (tag === 'ol' && typeof node.properties?.start === 'number') props.start = node.properties.start
  return createElement(tag, props, ...(children ?? []))
}

/** The sanitized React tree for `markdown`: only the allowed tags, links as http(s), nothing from raw html. */
export function renderMarkdown(markdown: string, openLink: (href: string) => void): ReactNode[] {
  const tree = PROCESSOR.runSync(PROCESSOR.parse(markdown)) as HastNode
  return (tree.children ?? []).map((child, index) => toReact(child, index, false, openLink))
}

/**
 * An agent's markdown. Links ask before opening because the text is untrusted, and a stream that
 * is still running ends in a caret.
 */
export function Prose({ context, text, streaming = false }: { context: UiPluginContext; text: string; streaming?: boolean }) {
  const openLink = (href: string) => {
    void context
      .confirm({ title: 'Open link', body: href, confirmLabel: 'Open' })
      .then((ok) => (ok ? context.call('quirky.terminal/openExternal', { target: href }) : undefined))
      .catch((error) => context.toast('Could not open link', error instanceof Error ? error.message : String(error)))
  }
  const content = useMemo(() => renderMarkdown(text, openLink), [text, context])
  return (
    <div style={root}>
      {content}
      {streaming && <span style={caret} aria-hidden="true">{'▍'}</span>}
    </div>
  )
}
