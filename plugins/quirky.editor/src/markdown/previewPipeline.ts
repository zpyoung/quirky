import type React from 'react'
import type ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { extractHeadings, slugHeading } from './source'

const MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), 'details', 'summary'])],
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^(?:language-[\w.+-]+|math-inline|math-display)$/]],
    details: ['open']
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto', 'tel']
  }
} satisfies typeof defaultSchema

const MARKDOWN_CLASS_MARKER = 'quirkyMarkdownClass'
const MARKDOWN_HEADING_MARKER = 'quirkyMarkdownHeading'

type PreviewNode = {
  type?: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
  children?: PreviewNode[]
}

function visitPreviewNodes(node: PreviewNode, visit: (node: PreviewNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) visitPreviewNodes(child, visit)
}

function rehypeMarkMarkdownNodes() {
  return (tree: PreviewNode) => {
    visitPreviewNodes(tree, (node) => {
      if (node.type !== 'element') return
      const data = { ...node.data }
      if (node.properties && 'className' in node.properties) data[MARKDOWN_CLASS_MARKER] = true
      if (/^h[1-5]$/.test(node.tagName ?? '')) data[MARKDOWN_HEADING_MARKER] = true
      if (Object.keys(data).length > 0) node.data = data
    })
  }
}

function rehypeStripUntrustedPresentation() {
  return (tree: PreviewNode) => {
    const stripRawMathAndSvg = (parent: PreviewNode) => {
      if (!parent.children) return
      parent.children = parent.children.filter((child) => {
        const name = child.type === 'element' ? child.tagName?.toLowerCase() : undefined
        return name !== 'math' && name !== 'svg'
      })
      for (const child of parent.children) stripRawMathAndSvg(child)
    }
    stripRawMathAndSvg(tree)
    visitPreviewNodes(tree, (node) => {
      if (node.type !== 'element') return
      if (node.data?.[MARKDOWN_CLASS_MARKER] !== true && node.properties) {
        const className = node.properties.className
        const classNames = Array.isArray(className)
          ? className
          : typeof className === 'string' ? className.split(/\s+/) : []
        // Preserve only code-language and KaTeX token classes if raw-HTML parsing drops provenance.
        if (node.tagName === 'code') {
          const safeClasses = classNames.filter((name) =>
            typeof name === 'string' && /^(?:language-[\w.+-]+|math-inline|math-display)$/.test(name)
          )
          if (safeClasses.length > 0) node.properties.className = safeClasses
          else delete node.properties.className
        } else {
          delete node.properties.className
        }
        delete node.properties.style
      }
      if (node.data && MARKDOWN_CLASS_MARKER in node.data) {
        const data = { ...node.data }
        delete data[MARKDOWN_CLASS_MARKER]
        if (Object.keys(data).length === 0) delete node.data
        else node.data = data
      }
    })
  }
}

function previewText(node: PreviewNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.type === 'element' && node.tagName === 'img' && typeof node.properties?.alt === 'string') return node.properties.alt
  return (node.children ?? []).map(previewText).join('')
}

function rehypeAddMarkdownHeadingIds() {
  return (tree: PreviewNode) => {
    const counts = new Map<string, number>()
    visitPreviewNodes(tree, (node) => {
      if (node.type !== 'element' || node.data?.[MARKDOWN_HEADING_MARKER] !== true) return
      const slug = slugHeading(previewText(node))
      const count = counts.get(slug) ?? 0
      counts.set(slug, count + 1)
      node.properties ??= {}
      node.properties.id = `markdown-${count === 0 ? slug : `${slug}-${count}`}`
      const data = { ...node.data }
      delete data[MARKDOWN_HEADING_MARKER]
      if (Object.keys(data).length === 0) delete node.data
      else node.data = data
    })
  }
}

export const MARKDOWN_PREVIEW_REHYPE_PLUGINS = [
  rehypeMarkMarkdownNodes,
  rehypeRaw,
  rehypeStripUntrustedPresentation,
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
  rehypeAddMarkdownHeadingIds,
  [rehypeKatex, { trust: false, throwOnError: false }]
] satisfies NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>

export function previewHeadingId(markdown: string, anchor: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(anchor)
  } catch {
    return null
  }
  const headings = extractHeadings(markdown)
  const exact = headings.find((heading) => heading.id === decoded)
  const normalized = exact ?? headings.find((heading) => heading.id === slugHeading(decoded))
  return normalized ? `markdown-${normalized.id}` : null
}

export function previewAnchorHref(markdown: string, href: string): string {
  if (!href.startsWith('#')) return href
  const id = previewHeadingId(markdown, href.slice(1))
  return id ? `#${id}` : href
}
