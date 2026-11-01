import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Editor, Extensions } from '@tiptap/core'
import type {
  findRichMatches as FindRichMatches,
  revealRichSearchMatch as RevealRichSearchMatch,
  RichSearchHighlight as RichSearchHighlightExport
} from '../src/markdown/search'
import type {
  createHeadlessMarkdownEditor as CreateHeadlessMarkdownEditor,
  createMarkdownExtensions as CreateMarkdownExtensions
} from '../src/markdown/tiptap'

type RichSearchRange = { from: number; to: number }
type HeadlessEditorOptions = {
  element: null
  extensions: Extensions
  content: string
  contentType: 'markdown'
  editable: true
}

let EditorConstructor: new (options: HeadlessEditorOptions) => Editor
let createHeadlessMarkdownEditor: typeof CreateHeadlessMarkdownEditor
let createMarkdownExtensions: typeof CreateMarkdownExtensions
let findRichMatches: typeof FindRichMatches
let revealRichSearchMatch: typeof RevealRichSearchMatch
let RichSearchHighlight: typeof RichSearchHighlightExport
let MARKDOWN_MAX_SEARCH_MATCHES: number
let editor: Editor | undefined

// TipTap inspects browser globals at module initialization, so load it only after Happy DOM registration.
beforeAll(async () => {
  GlobalRegistrator.register()
  ;({ Editor: EditorConstructor } = await import('@tiptap/core'))
  ;({ createHeadlessMarkdownEditor, createMarkdownExtensions } = await import('../src/markdown/tiptap'))
  ;({ findRichMatches, revealRichSearchMatch, RichSearchHighlight } = await import('../src/markdown/search'))
  ;({ MARKDOWN_MAX_SEARCH_MATCHES } = await import('../src/markdown/source'))
})
afterEach(() => {
  editor?.destroy()
  editor = undefined
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function makeEditor(markdown: string): Editor {
  editor = createHeadlessMarkdownEditor(markdown)
  return editor
}

function makeEditorWithSearchHighlight(markdown: string): Editor {
  editor = new EditorConstructor({
    element: null,
    extensions: [...createMarkdownExtensions(), RichSearchHighlight],
    content: markdown,
    contentType: 'markdown',
    editable: true
  })
  const container = document.createElement('div')
  document.body.append(container)
  editor.mount(container)
  return editor
}

function textRanges(current: Editor, text: string): RichSearchRange[] {
  const ranges: RichSearchRange[] = []
  current.state.doc.descendants((node, position) => {
    if (!node.isText || !node.text) return
    let offset = 0
    while ((offset = node.text.indexOf(text, offset)) !== -1) {
      ranges.push({ from: position + offset, to: position + offset + text.length })
      offset += text.length
    }
  })
  return ranges
}

function selectedText(current: Editor, range: RichSearchRange): string {
  return current.state.doc.textBetween(range.from, range.to, '\n', '\uFFFC')
}

test('finds heading, paragraph, and nested task-list matches at ProseMirror positions', () => {
  const current = makeEditor('# Heading needle\n\nParagraph needle\n\n- [ ] Parent needle\n  - [x] Child needle\n    - [ ] Grandchild needle')
  const result = findRichMatches(current, 'needle', {})

  expect(result.total).toBe(5)
  expect(result.matches).toEqual(textRanges(current, 'needle'))
  expect(result.matches.map((range) => selectedText(current, range))).toEqual(Array(5).fill('needle'))
})

test('returns repeated occurrences in document order with exact editor ranges', () => {
  const current = makeEditor('needle needle\n\nneedle')
  const result = findRichMatches(current, 'needle', {})

  expect(result.total).toBe(3)
  expect(result.matches).toEqual(textRanges(current, 'needle'))
  expect(result.matches.map((range) => selectedText(current, range))).toEqual(['needle', 'needle', 'needle'])
})

test('matches visible text across inline marks', () => {
  const current = makeEditor('**mark**down')
  const paragraph = current.state.doc.firstChild!
  const result = findRichMatches(current, 'markdown', {})

  expect(paragraph.textContent).toBe('markdown')
  expect(paragraph.childCount).toBe(2)
  expect(result).toEqual({ matches: [{ from: 1, to: 9 }], total: 1 })
  expect(selectedText(current, result.matches[0]!)).toBe('markdown')
})

test('honors case and Unicode whole-word constraints', () => {
  const current = makeEditor('# Needle needlebox _needle 1needle\n\nNeedle\n\ncafé caféine _café 1café')
  const caseInsensitive = findRichMatches(current, 'needle', {})
  const caseSensitive = findRichMatches(current, 'needle', { matchCase: true })
  const wholeWord = findRichMatches(current, 'needle', { wholeWord: true })
  const caseSensitiveWholeWord = findRichMatches(current, 'needle', { matchCase: true, wholeWord: true })
  const unicodeWholeWord = findRichMatches(current, 'café', { wholeWord: true })

  expect(caseInsensitive.total).toBe(5)
  expect(caseInsensitive.matches.map((range) => selectedText(current, range))).toEqual([
    'Needle', 'needle', 'needle', 'needle', 'Needle'
  ])
  expect(caseSensitive.matches).toEqual(textRanges(current, 'needle'))
  expect(caseSensitive.total).toBe(3)
  expect(wholeWord.matches.map((range) => selectedText(current, range))).toEqual(['Needle', 'Needle'])
  expect(caseSensitiveWholeWord).toEqual({ matches: [], total: 0 })
  expect(unicodeWholeWord.matches).toEqual([textRanges(current, 'café')[0]!])
  expect(unicodeWholeWord.matches.map((range) => selectedText(current, range))).toEqual(['café'])
})

test('does not match across inline atoms and preserves their ProseMirror offset', () => {
  const current = makeEditor('before![picture](image.png)after')
  let atomPosition = -1
  current.state.doc.descendants((node, position) => {
    if (node.isInline && node.isLeaf && !node.isText) atomPosition = position
  })

  expect(atomPosition).toBeGreaterThan(0)
  expect(findRichMatches(current, 'beforeafter', {}).total).toBe(0)
  const result = findRichMatches(current, 'after', {})
  expect(result.matches).toEqual(textRanges(current, 'after'))
  expect(result.matches[0]?.from).toBe(atomPosition + 1)
})

test('caps returned ranges at the shared search-match limit while counting all matches', () => {
  const count = MARKDOWN_MAX_SEARCH_MATCHES + 2
  const current = makeEditor(Array.from({ length: count }, () => 'x').join(' '))
  const result = findRichMatches(current, 'x', {})

  expect(result.matches).toHaveLength(MARKDOWN_MAX_SEARCH_MATCHES)
  expect(result.total).toBe(count)
})

test('updates the active highlight without focusing or changing the document', () => {
  const current = makeEditorWithSearchHighlight('first needle, then needle')
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  const doc = current.state.doc
  const matches = findRichMatches(current, 'needle', {}).matches
  const dom = current.view.dom

  revealRichSearchMatch(current, matches[0]!)
  expect(document.activeElement).toBe(input)
  expect(current.state.doc).toBe(doc)
  expect(selectedText(current, { from: current.state.selection.from, to: current.state.selection.to })).toBe('needle')
  expect(current.state.selection.from).toBe(matches[0]?.from)
  expect(current.state.selection.to).toBe(matches[0]?.to)
  expect(dom.querySelectorAll('.markdown-search-match')).toHaveLength(1)
  expect(dom.querySelector('.markdown-search-match')?.textContent).toBe('needle')

  revealRichSearchMatch(current, matches[1]!)
  expect(document.activeElement).toBe(input)
  expect(current.state.doc).toBe(doc)
  expect(current.state.selection.from).toBe(matches[1]?.from)
  expect(current.state.selection.to).toBe(matches[1]?.to)
  expect(dom.querySelectorAll('.markdown-search-match')).toHaveLength(1)
  expect(dom.querySelector('.markdown-search-match')?.textContent).toBe('needle')

  revealRichSearchMatch(current, null)
  expect(document.activeElement).toBe(input)
  expect(current.state.doc).toBe(doc)
  expect(dom.querySelector('.markdown-search-match')).toBeNull()
})
