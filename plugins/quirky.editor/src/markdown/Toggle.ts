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
  let depth = 1
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
        const opening = /^<details(?=\s|>)(?:\s[^<>]*)?>/i.exec(line.slice(index))
        if (opening) {
          depth += 1
          index += opening[0].length
          continue
        }
        const closing = /^<\/details\s*>/i.exec(line.slice(index))
        if (closing) {
          depth -= 1
          if (depth === 0) return { start: offset + index, end: offset + index + closing[0].length }
          index += closing[0].length
          continue
        }
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
      summary: { default: '' },
      headingLevel: { default: null },
      open: { default: false }
    }
  },

  parseHTML() {
    return [{
      tag: 'details',
      getAttrs: (element) => {
        if (!(element instanceof HTMLElement)) return false
        const summaryElement = Array.from(element.children).find((child) => child.tagName.toLowerCase() === 'summary')
        const headingTag = summaryElement?.firstElementChild?.tagName.toLowerCase() ?? ''
        return {
          summary: summaryElement?.textContent ?? '',
          headingLevel: /^h[1-5]$/.test(headingTag) ? Number(headingTag.slice(1)) : null,
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
    const summary = String(node.attrs.summary ?? '')
    const headingLevel = Number(node.attrs.headingLevel)
    const summaryContent = Number.isInteger(headingLevel) && headingLevel >= 1 && headingLevel <= 5
      ? [`h${headingLevel}`, {}, summary]
      : summary
    return [
      'details',
      { 'data-markdown-toggle': '', class: 'markdown-toggle', ...(node.attrs.open ? { open: true } : {}) },
      ['summary', {}, summaryContent],
      ['div', { class: 'markdown-toggle-content' }, 0]
    ]
  },


  markdownTokenizer: {
    name: 'markdownToggle',
    level: 'block',
    start: (source: string) => source.search(/<details(?=\s|>)/i),
    tokenize: (source: string, _tokens: MarkdownToken[], lexer: MarkdownLexerConfiguration) => {
      const opening = /^<details(?:\s[^<>]*)?>[\t \r\n]*<summary(?:\s[^<>]*)?>([\s\S]*?)<\/summary>/i.exec(source)
      if (!opening) return undefined
      const bodyStart = opening[0].length
      const closing = findDetailsClose(source, bodyStart)
      if (!closing) return undefined
      const raw = source.slice(0, closing.end)
      const detailsOpen = /^<details\b([^>]*)>/i.exec(source)?.[1] ?? ''
      const open = /(?:^|\s)open(?:\s|$)/i.test(detailsOpen.trim())
      const summaryMarkup = opening[1]!
      const heading = /^<h([1-5])>([\s\S]*)<\/h\1>$/i.exec(summaryMarkup)
      const headingLevel = heading ? Number(heading[1]) : null
      const summarySource = heading?.[2] ?? summaryMarkup
      const summary = decodeHtmlText(summarySource.replace(/<[^>]*>/g, ''))
      let body = source.slice(bodyStart, closing.start)
      body = body.replace(/^\r?\n\r?\n/, '').replace(/\r?\n\r?\n$/, '')
      return { type: 'markdownToggle', raw, summary, headingLevel, open, text: body, tokens: lexer.blockTokens(body) }
    }
  },

  parseMarkdown(token, helpers) {
    const attributes = token as Record<string, unknown>
    const summary = typeof attributes.summary === 'string' ? attributes.summary : ''
    const headingLevel = typeof attributes.headingLevel === 'number' &&
      Number.isInteger(attributes.headingLevel) && attributes.headingLevel >= 1 && attributes.headingLevel <= 5
      ? attributes.headingLevel
      : null
    const open = attributes.open === true
    const tokens = Array.isArray(attributes.tokens) ? attributes.tokens : []
    return { type: 'markdownToggle', attrs: { summary, headingLevel, open }, content: helpers.parseChildren(tokens) }
  },

  renderMarkdown(node, helpers) {
    const summary = encodeHtmlText(String(node.attrs?.summary ?? ''))
    const headingLevel = Number(node.attrs?.headingLevel)
    const summaryMarkup = Number.isInteger(headingLevel) && headingLevel >= 1 && headingLevel <= 5
      ? `<h${headingLevel}>${summary}</h${headingLevel}>`
      : summary
    const content = helpers.renderChildren(node.content ?? [])
    return `<details${node.attrs?.open ? ' open' : ''}><summary>${summaryMarkup}</summary>\n\n${content}\n\n</details>`
  }
})
