import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
const { createMerge } = await import('../../src/view/merge')
const { EditorView } = await import('@codemirror/view')

afterAll(() => GlobalRegistrator.unregister())

const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
const edited = original.replace('line 3\n', 'line three\n').replace('line 25\n', 'line twenty-five\n')

const base = {
  original,
  modified: edited,
  path: 'a.ts',
  sideBySide: false,
  wrap: false,
  showWhitespace: true,
  collapseUnchanged: false,
  editable: false
}

const modKey = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }

let parent: HTMLElement
beforeEach(() => {
  document.body.innerHTML = ''
  parent = document.body.appendChild(document.createElement('div'))
})

const editorOf = (root: ParentNode) => EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!

describe.each([false, true])('createMerge (side by side: %p)', (sideBySide) => {
  test('SC-60: starts on the first change, and Next / Previous walk the changes and wrap', () => {
    const merge = createMerge(parent, { ...base, sideBySide })
    expect(merge.changeCount()).toBe(2)
    expect(merge.currentChange()).toBe(1)
    expect(merge.nextChange()).toBe(true)
    expect(merge.currentChange()).toBe(2)
    expect(merge.nextChange()).toBe(true)
    expect(merge.currentChange()).toBe(1)
    expect(merge.previousChange()).toBe(true)
    expect(merge.currentChange()).toBe(2)
    merge.destroy()
  })

  test('no changes: nothing to move to', () => {
    const merge = createMerge(parent, { ...base, sideBySide, modified: original })
    expect(merge.changeCount()).toBe(0)
    expect(merge.currentChange()).toBeNull()
    expect(merge.nextChange()).toBe(false)
    expect(merge.previousChange()).toBe(false)
    merge.destroy()
  })

  test('SC-61: revertChange puts the current block back to the original text in the editor only', () => {
    const merge = createMerge(parent, { ...base, sideBySide, editable: true })
    merge.nextChange()
    expect(merge.currentChange()).toBe(2)
    expect(merge.revertChange()).toBe(true)
    expect(merge.getModified()).toBe(original.replace('line 3\n', 'line three\n'))
    expect(merge.changeCount()).toBe(1)
    merge.destroy()
  })

  test('SC-61: a read-only diff has no Revert Block control and takes no edits', () => {
    const merge = createMerge(parent, { ...base, sideBySide })
    expect(parent.querySelector('button[name=reject]')).toBeNull()
    expect(parent.querySelector('.cm-content[contenteditable=true]')).toBeNull()
    merge.destroy()
  })

  test('an editable diff keeps its text exactly, a read-only one drops one trailing break', () => {
    const editable = createMerge(parent, { ...base, sideBySide, editable: true })
    expect(editable.getModified()).toBe(edited)
    editable.destroy()
    const readOnly = createMerge(parent, { ...base, sideBySide })
    expect(readOnly.getModified()).toBe(edited.slice(0, -1))
    readOnly.destroy()
  })

  test('onDocChange fires for edits, and Mod-s calls onSave', () => {
    let docChanges = 0
    let saves = 0
    const merge = createMerge(parent, {
      ...base,
      sideBySide,
      editable: true,
      onDocChange: () => void docChanges++,
      onSave: () => void saves++
    })
    const view = editorOf(sideBySide ? parent.querySelectorAll('.cm-mergeViewEditor')[1] : parent)
    view.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(docChanges).toBe(1)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ...modKey, bubbles: true }))
    expect(saves).toBe(1)
    merge.destroy()
  })

  test('a CRLF file keeps its line endings', () => {
    const crlf = 'a\r\nb\r\n'
    const merge = createMerge(parent, { ...base, sideBySide, editable: true, original: crlf, modified: 'a\r\nbb\r\n' })
    expect(merge.getModified()).toBe('a\r\nbb\r\n')
    merge.destroy()
  })
})

describe('createMerge options', () => {
  test('inline revert controls offer Revert Block and no accept', () => {
    const merge = createMerge(parent, { ...base, editable: true })
    const reject = parent.querySelectorAll('button[name=reject]')
    expect(reject.length).toBeGreaterThan(0)
    expect(reject[0].textContent).toBe('Revert Block')
    merge.destroy()
  })

  test('side-by-side editable shows revert controls between the panes', () => {
    const merge = createMerge(parent, { ...base, sideBySide: true, editable: true })
    expect(parent.querySelector('.cm-merge-revert')).not.toBeNull()
    merge.destroy()
  })

  test('SC-60: wrap and show-whitespace follow their options', () => {
    const wrapped = createMerge(parent, { ...base, wrap: true })
    expect(parent.querySelector('.cm-lineWrapping')).not.toBeNull()
    wrapped.destroy()
    const plain = createMerge(parent, { ...base, wrap: false })
    expect(parent.querySelector('.cm-lineWrapping')).toBeNull()
    plain.destroy()
  })

  test('SC-60: with whitespace off, a change that only adds indentation is not a change', () => {
    const indented = createMerge(parent, { ...base, original: 'a\nb\n', modified: 'a\n  b\n', showWhitespace: false })
    expect(indented.changeCount()).toBe(0)
    indented.destroy()
    const shown = createMerge(parent, { ...base, original: 'a\nb\n', modified: 'a\n  b\n', showWhitespace: true })
    expect(shown.changeCount()).toBe(1)
    shown.destroy()
    const blank = createMerge(parent, { ...base, original: 'a\nb\n', modified: 'a\n\nb\n', showWhitespace: false })
    expect(blank.changeCount()).toBe(1)
    blank.destroy()
  })

  test('SC-60: collapse unchanged folds long unchanged runs into a band', () => {
    const folded = createMerge(parent, { ...base, collapseUnchanged: true })
    expect(parent.querySelector('.cm-collapsedLines')).not.toBeNull()
    folded.destroy()
    const open = createMerge(parent, { ...base, collapseUnchanged: false })
    expect(parent.querySelector('.cm-collapsedLines')).toBeNull()
    open.destroy()
  })
})
