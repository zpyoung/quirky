import { Node } from '@tiptap/core'
import { isSafeMarkdownLink } from './operations'

export const MarkdownDocumentLink = Node.create({
  name: 'markdownDocumentLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      target: { default: '' },
      label: { default: '' }
    }
  },

  parseHTML() {
    return [{
      tag: 'a[data-markdown-document-link]',
      priority: 1000,
      getAttrs: (element) => {
        if (!(element instanceof HTMLElement)) return false
        return { target: element.dataset.target ?? '', label: element.textContent ?? '' }
      }
    }]
  },

  renderHTML({ node }) {
    const target = String(node.attrs.target ?? '')
    const label = String(node.attrs.label ?? '') || target
    const href = isSafeMarkdownLink(target) ? target : '#'
    return ['a', { href, 'data-markdown-document-link': '', 'data-target': target, rel: 'noopener noreferrer' }, label]
  },

  markdownTokenizer: {
    name: 'markdownDocumentLink',
    level: 'inline',
    start: (source: string) => source.indexOf('[['),
    tokenize: (source: string) => {
      const match = /^\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]*))?\]\]/.exec(source)
      if (!match) return undefined
      const target = match[1]!.trim()
      const label = match[2] ?? target
      if (target === '') return undefined
      return { type: 'markdownDocumentLink', raw: match[0], target, label }
    }
  },

  parseMarkdown(token) {
    const attrs = token as Record<string, unknown>
    const target = typeof attrs.target === 'string' ? attrs.target : ''
    const label = typeof attrs.label === 'string' ? attrs.label : target
    return {
      type: 'markdownDocumentLink',
      attrs: { target, label }
    }
  },

  renderMarkdown({ node }) {
    const target = String(node.attrs.target ?? '')
    const label = String(node.attrs.label ?? '')
    return `[[${target}${label && label !== target ? `|${label}` : ''}]]`
  }
})
