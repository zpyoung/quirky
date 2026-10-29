import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Editor } from '@tiptap/core'
import type { createHeadlessMarkdownEditor as CreateMarkdownEditor } from '../src/markdown/tiptap'

let createHeadlessMarkdownEditor: typeof CreateMarkdownEditor
let editor: Editor | undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  // tiptap inspects window at import time, so happy dom must be registered first.
  ;({ createHeadlessMarkdownEditor } = await import('../src/markdown/tiptap'))
})
afterEach(() => {
  editor?.destroy()
  editor = undefined
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function mount(markdown: string): Editor {
  editor = createHeadlessMarkdownEditor(markdown)
  const element = document.createElement('div')
  document.body.append(element)
  editor.mount(element)
  return editor
}

/** Exercises DOM reparsing, rather than commands that bypass the native-input path. */
async function appendNativeText(current: Editor, text: string): Promise<void> {
  const walker = document.createTreeWalker(current.view.dom, NodeFilter.SHOW_TEXT)
  let last: Node | null = null
  while (walker.nextNode()) last = walker.currentNode
  if (!last) throw new Error('Editor has no text to append to')
  const { promise, resolve } = Promise.withResolvers<void>()
  current.once('update', () => resolve())
  last.nodeValue += text
  await promise
}

test('native editing preserves untouched soft line breaks', async () => {
  const current = mount('notes\nneedle-phrase-qa here')
  await appendNativeText(current, ' edited-by-qa')
  expect(current.getMarkdown()).toBe('notes\nneedle-phrase-qa here edited-by-qa')
})

test('native editing keeps soft breaks inside marked text distinct from explicit hard breaks', async () => {
  const current = mount('**first\nsecond**  \nthird')
  await appendNativeText(current, ' edited')
  expect(current.getMarkdown()).toBe('**first\nsecond**  \nthird edited')
})

test('intentional hard breaks remain serializable after native input', async () => {
  const current = mount('first\nsecond')
  await appendNativeText(current, ' edited')
  current.commands.setTextSelection(current.state.doc.content.size - 1)
  current.commands.setHardBreak()
  current.commands.insertContent({ type: 'text', text: 'third' })
  expect(current.getMarkdown()).toBe('first\nsecond edited  \nthird')
})
