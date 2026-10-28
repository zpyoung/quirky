import { Node } from '@tiptap/core'
import type { MarkdownLexerConfiguration, MarkdownToken } from '@tiptap/core'

function decodeHtmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => {
    if (entity === '&amp;') return '&'
    if (entity === '&lt;') return '<'
    if (entity === '&gt;') return '>'
    if (entity === '&quot;') return '"'
    return "'"
  })
}

function encodeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function findDetailsClose(source: string, from: number): { start: number; end: number } | null {
  let offset = from
  let lineStart = source.lastIndexOf('\n', from - 1) + 1
  let fence: { char: string; length: number } | null = null
  let inlineCodeLength = 0

  while (offset <= source.length) {
    const newline = source.indexOf('\n', offset)
    const end = newline < 0 ? source.length : newline
    const line = source.slice(offset, end)
    const prefix = source.slice(lineStart, offset)
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)

    if (fence) {
      const marker = fenceMatch?.[1]
      if (marker && marker[0] === fence.char && marker.length >= fence.length && line.slice(fenceMatch![0].length).trim() === '') {
        fence = null
      }
      if (newline < 0) break
      offset = end + 1
      lineStart = offset
      continue
    }

    if (inlineCodeLength === 0 && /^ {0,3}$/.test(prefix) && fenceMatch) {
      const marker = fenceMatch[1]!
      fence = { char: marker[0]!, length: marker.length }
      if (newline < 0) break
      offset = end + 1
      lineStart = offset
      continue
    }

    let index = 0
    while (index < line.length) {
      if (line[index] === '`') {
        let runEnd = index + 1
        while (line[runEnd] === '`') runEnd += 1
        const runLength = runEnd - index
        if (inlineCodeLength === 0) inlineCodeLength = runLength
        else if (runLength === inlineCodeLength) inlineCodeLength = 0
        index = runEnd
        continue
      }
      if (inlineCodeLength === 0) {
        const closing = /^<\/details\s*>/i.exec(line.slice(index))
        if (closing) return { start: offset + index, end: offset + index + closing[0].length }
      }
      index += 1
    }

    if (newline < 0) break
    offset = end + 1
    lineStart = offset
  }
  return null
}

export const MarkdownToggle = Node.create({
  name: 'markdownToggle',
  group: 'block',
  content: 'block*',
  defining: true,

  addAttributes() {
    return {
      summary: { default: 'Toggle' },
      open: { default: false }
    }
  },

  parseHTML() {
    return [{
      tag: 'details',
      getAttrs: (element) => {
        if (!(element instanceof HTMLElement)) return false
        return {
          summary: element.querySelector('summary')?.textContent ?? 'Toggle',
          open: element.hasAttribute('open')
        }
      },
      contentElement: (element) => {
        const content = element.ownerDocument.createElement('div')
        for (const child of Array.from(element.childNodes)) {
          if (child instanceof HTMLElement && child.tagName.toLowerCase() === 'summary') continue
          content.appendChild(child.cloneNode(true))
        }
        return content
      }
    }]
  },

  renderHTML({ node }) {
    return [
      'details',
      { 'data-markdown-toggle': '', class: 'markdown-toggle', ...(node.attrs.open ? { open: true } : {}) },
      ['summary', {}, String(node.attrs.summary ?? 'Toggle')],
      ['div', { class: 'markdown-toggle-content' }, 0]
    ]
  },

  markdownTokenizer: {
    name: 'markdownToggle',
    start: (source: string) => source.search(/<details(?=\s|>)/i),
    tokenize: (source: string, _tokens: MarkdownToken[], lexer: MarkdownLexerConfiguration) => {
      const opening = /^<details(?:\s[^>]*)?>\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>\s*/i.exec(source)
      if (!opening) return undefined
      const bodyStart = opening[0].length
      const closing = findDetailsClose(source, bodyStart)
      if (!closing) return undefined
      const raw = source.slice(0, closing.end)
      const detailsOpen = /^<details\b([^>]*)>/i.exec(source)?.[1] ?? ''
      const open = /(?:^|\s)open(?:\s|$)/i.test(detailsOpen.trim())
      const summary = decodeHtmlText(opening[1]!.replace(/<[^>]*>/g, '').trim()) || 'Toggle'
      const body = source.slice(bodyStart, closing.start)
        .replace(/^\s*<div(?:\s[^>]*)?>/i, '')
        .replace(/<\/div>\s*$/i, '')
        .replace(/<p(?:\s[^>]*)?>/gi, '')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      return { type: 'markdownToggle', raw, summary, open, text: body, tokens: lexer.blockTokens(body) }
    }
  },

  parseMarkdown(token, helpers) {
    const attributes = token as Record<string, unknown>
    const summary = typeof attributes.summary === 'string' ? attributes.summary : 'Toggle'
    const open = attributes.open === true
    const tokens = Array.isArray(attributes.tokens) ? attributes.tokens : []
    return { type: 'markdownToggle', attrs: { summary, open }, content: helpers.parseChildren(tokens) }
  },

  renderMarkdown({ node, helpers }) {
    const summary = encodeHtmlText(String(node.attrs.summary ?? 'Toggle'))
    const content = helpers.renderChildren(node)
    return `<details${node.attrs.open ? ' open' : ''}><summary>${summary}</summary>\n\n${content}\n\n</details>`
  }
})
