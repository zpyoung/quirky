import { createElement, Fragment } from 'react'
import { parseSafeMarkdownInline, type SafeInlineToken } from './list-model'

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; text: string }

export function parseSafeMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] | null = null
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
    paragraph.length = 0
  }
  const flushList = () => {
    if (!list) return
    blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (code) {
      if (/^\s*```/.test(line)) {
        blocks.push({ type: 'code', text: code.join('\n') })
        code = null
      } else code.push(line)
      continue
    }
    if (/^\s*```/.test(line)) {
      flushParagraph()
      flushList()
      code = []
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! })
      continue
    }
    const unorderedItem = /^\s*[-*+]\s+(.+)$/.exec(line)
    const orderedItem = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (unorderedItem || orderedItem) {
      flushParagraph()
      const ordered = orderedItem !== null
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push((orderedItem ?? unorderedItem)![1]!)
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  if (code) blocks.push({ type: 'code', text: code.join('\n') })
  return blocks
}

function inlineElement(token: SafeInlineToken, key: number) {
  if (token.type === 'text') return createElement(Fragment, { key }, token.value)
  if (token.type === 'strong') return createElement('strong', { key }, token.value)
  if (token.type === 'emphasis') return createElement('em', { key }, token.value)
  if (token.type === 'code') return createElement('code', { key }, token.value)
  return createElement('a', { key, href: token.href, rel: 'noreferrer' }, token.value)
}

function inline(text: string) {
  return parseSafeMarkdownInline(text).map(inlineElement)
}

export function SafeMarkdown({ content }: { content: string }) {
  return createElement('div', { className: 'auto-run-markdown' }, ...parseSafeMarkdownBlocks(content).map((block, index) => {
    if (block.type === 'heading') return createElement(`h${block.level}`, { key: index }, ...inline(block.text))
    if (block.type === 'paragraph') return createElement('p', { key: index }, ...inline(block.text))
    if (block.type === 'code') return createElement('pre', { key: index }, createElement('code', null, block.text))
    const listElement = block.ordered ? 'ol' : 'ul'
    return createElement(listElement, { key: index }, ...block.items.map((item, itemIndex) => createElement('li', { key: itemIndex }, ...inline(item))))
  }))
}
