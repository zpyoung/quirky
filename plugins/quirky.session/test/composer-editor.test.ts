import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, createElement, createRef } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { EditorView } from '@codemirror/view'
import type { ComposerEditorHandle, ComposerEditorProps, Trigger } from '../src/window/chat/editor/types'

let createRoot: typeof import('react-dom/client').createRoot
let ComposerEditor: typeof import('../src/window/chat/editor/ComposerEditor').ComposerEditor
let CMView: typeof import('@codemirror/view').EditorView
let commands: typeof import('@codemirror/commands')
let pillRanges: typeof import('../src/window/chat/editor/pills').pillRanges
let root: Root | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ComposerEditor } = await import('../src/window/chat/editor/ComposerEditor'))
  ;({ EditorView: CMView } = await import('@codemirror/view'))
  commands = await import('@codemirror/commands')
  ;({ pillRanges } = await import('../src/window/chat/editor/pills'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

type Spy = {
  submits: string[]
  changes: string[]
  triggers: (Trigger | null)[]
  nav: string[]
  escapes: number
  upInEmpty: number
  pasted: File[][]
  dropped: File[][]
  longPastes: string[]
}

async function mount(overrides: Partial<ComposerEditorProps> & { navConsumes?: boolean } = {}) {
  const spy: Spy = { submits: [], changes: [], triggers: [], nav: [], escapes: 0, upInEmpty: 0, pasted: [], dropped: [], longPastes: [] }
  const ref = createRef<ComposerEditorHandle>()
  const { navConsumes, ...rest } = overrides
  const props: ComposerEditorProps = {
    value: '',
    onChange: (v) => spy.changes.push(v),
    placeholder: 'Message',
    sendKey: 'enter',
    onSubmit: (k) => spy.submits.push(k),
    onTrigger: (t) => spy.triggers.push(t),
    onKeyNav: (k) => {
      spy.nav.push(k)
      return navConsumes === true
    },
    onEscape: () => void spy.escapes++,
    onUpInEmpty: () => void spy.upInEmpty++,
    onPasteFiles: (f) => spy.pasted.push(f),
    onDropFiles: (f) => spy.dropped.push(f),
    onLongPaste: (t) => spy.longPastes.push(t),
    accessibleName: 'Message the agent',
    ...rest
  }
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(ComposerEditor, { ...props, ref })))
  const view = CMView.findFromDOM(host)!
  return { spy, ref, view, host, props }
}

const key = (view: EditorView, init: KeyboardEventInit & { key: string }) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  view.contentDOM.dispatchEvent(event)
  return event
}
const set = (view: EditorView, text: string, cursor = text.length) =>
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: cursor } })

describe('pills', () => {
  test('a pill serialises to @path or /name plus a space and renders as a widget', async () => {
    const { ref, view, spy } = await mount()
    await act(async () => ref.current!.insertPill({ kind: 'file', path: 'src/README.md' }, { from: 0, to: 0 }))
    expect(view.state.doc.toString()).toBe('@src/README.md ')
    expect(spy.changes.at(-1)).toBe('@src/README.md ')
    const el = view.contentDOM.querySelector('.cm-composer-pill-file') as HTMLElement
    expect(el.textContent).toBe('README.md')
    expect(el.title).toBe('src/README.md')
    await act(async () => ref.current!.insertPill({ kind: 'command', name: 'review' }, { from: 0, to: 0 }))
    expect(view.state.doc.toString().startsWith('/review ')).toBe(true)
  })

  test('insertPill without a range replaces the active trigger', async () => {
    const { ref, view } = await mount()
    await act(async () => set(view, 'Look at @REA'))
    await act(async () => ref.current!.insertPill({ kind: 'file', path: 'README.md' }))
    expect(view.state.doc.toString()).toBe('Look at @README.md ')
    expect(pillRanges(view.state)).toEqual([{ from: 8, to: 19, text: '@README.md ' }])
  })

  test('backspace right after a pill deletes the whole pill', async () => {
    const { ref, view } = await mount()
    await act(async () => set(view, 'Look at @REA'))
    await act(async () => ref.current!.insertPill({ kind: 'file', path: 'README.md' }))
    await act(async () => void commands.deleteCharBackward(view))
    expect(view.state.doc.toString()).toBe('Look at ')
    expect(pillRanges(view.state)).toEqual([])
  })

  test('the cursor skips over a pill', async () => {
    const { view } = await mount({ value: 'a @x.ts b' })
    expect(pillRanges(view.state)).toEqual([{ from: 2, to: 8, text: '@x.ts ' }])
    await act(async () => view.dispatch({ selection: { anchor: 2 } }))
    await act(async () => void commands.cursorCharRight(view))
    expect(view.state.selection.main.head).toBe(8)
  })

  test('external value with @path and a leading /name renders pills', async () => {
    const { view } = await mount({ value: '/review check @README.md now' })
    expect(pillRanges(view.state).map((p) => p.text)).toEqual(['/review ', '@README.md '])
    expect(view.contentDOM.querySelectorAll('.cm-composer-pill').length).toBe(2)
  })

  test('adjacent file pills all render', async () => {
    const { view } = await mount({ value: '@one.ts @two.ts @three.ts ' })
    expect(pillRanges(view.state).map((p) => p.text)).toEqual(['@one.ts ', '@two.ts ', '@three.ts '])
  })

  test('undo and redo of an inserted pill keep it a pill', async () => {
    const { ref, view } = await mount()
    await act(async () => ref.current!.insertPill({ kind: 'file', path: 'a.ts' }, { from: 0, to: 0 }))
    expect(pillRanges(view.state).length).toBe(1)
    view.contentDOM.blur()
    await act(async () => void commands.undo(view))
    expect(view.state.doc.toString()).toBe('')
    expect(pillRanges(view.state)).toEqual([])
    await act(async () => void commands.redo(view))
    expect(view.state.doc.toString()).toBe('@a.ts ')
    expect(pillRanges(view.state)).toEqual([{ from: 0, to: 6, text: '@a.ts ' }])
    expect(view.contentDOM.querySelectorAll('.cm-composer-pill').length).toBe(1)
    await act(async () => void commands.deleteCharBackward(view))
    expect(view.state.doc.toString()).toBe('')
  })

  test('undo of a Backspace over a pill restores the pill, and redo removes it again', async () => {
    const { view } = await mount({ value: '@a.ts ' })
    await act(async () => view.dispatch({ selection: { anchor: 6 } }))
    await act(async () => void commands.deleteCharBackward(view))
    expect(pillRanges(view.state)).toEqual([])
    await act(async () => void commands.undo(view))
    expect(view.state.doc.toString()).toBe('@a.ts ')
    expect(pillRanges(view.state)).toEqual([{ from: 0, to: 6, text: '@a.ts ' }])
    expect(view.contentDOM.querySelectorAll('.cm-composer-pill').length).toBe(1)
    await act(async () => void commands.redo(view))
    expect(view.state.doc.toString()).toBe('')
    expect(pillRanges(view.state)).toEqual([])
  })

  test('undo of a selection delete restores every pill inside it', async () => {
    const { view } = await mount({ value: 'a @x.ts @y.ts b' })
    expect(pillRanges(view.state).length).toBe(2)
    await act(async () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }))
    await act(async () => void commands.deleteCharBackward(view))
    expect(view.state.doc.toString()).toBe('')
    await act(async () => void commands.undo(view))
    expect(view.state.doc.toString()).toBe('a @x.ts @y.ts b')
    expect(pillRanges(view.state).map((p) => p.text)).toEqual(['@x.ts ', '@y.ts '])
    expect(view.contentDOM.querySelectorAll('.cm-composer-pill').length).toBe(2)
    await act(async () => void commands.redo(view))
    expect(view.state.doc.toString()).toBe('')
    expect(pillRanges(view.state)).toEqual([])
  })

  test('an external value change re-renders pills without calling onChange', async () => {
    const { view, spy, host, props, ref } = await mount()
    await act(async () => root!.render(createElement(ComposerEditor, { ...props, value: 'see @a/b.ts ok', ref })))
    expect(view.state.doc.toString()).toBe('see @a/b.ts ok')
    expect(pillRanges(view.state).length).toBe(1)
    expect(spy.changes).toEqual([])
    expect(host).toBeDefined()
  })
})

describe('triggers', () => {
  test('@ at start or after whitespace opens a file trigger', async () => {
    const { view, spy } = await mount()
    await act(async () => set(view, '@REA'))
    expect(spy.triggers.at(-1)).toEqual({ kind: '@', query: 'REA', from: 0, to: 4 })
    await act(async () => set(view, 'Look at @src/a'))
    expect(spy.triggers.at(-1)).toEqual({ kind: '@', query: 'src/a', from: 8, to: 14 })
  })

  test('@ inside a word is not a trigger, and whitespace ends one', async () => {
    const { view, spy } = await mount()
    await act(async () => set(view, 'mail me@x'))
    expect(spy.triggers.at(-1)).toBeNull()
    await act(async () => set(view, '@REA done'))
    expect(spy.triggers.at(-1)).toBeNull()
  })

  test('/ only at the very start of the document is a command trigger', async () => {
    const { view, spy } = await mount()
    await act(async () => set(view, '/rev'))
    expect(spy.triggers.at(-1)).toEqual({ kind: '/', query: 'rev', from: 0, to: 4 })
    await act(async () => set(view, 'run /rev'))
    expect(spy.triggers.at(-1)).toBeNull()
    await act(async () => set(view, ' /rev'))
    expect(spy.triggers.at(-1)).toBeNull()
  })

  test('moving the selection re-reports the trigger', async () => {
    const { view, spy } = await mount()
    await act(async () => set(view, '@REA more'))
    expect(spy.triggers.at(-1)).toBeNull()
    await act(async () => view.dispatch({ selection: { anchor: 4 } }))
    expect(spy.triggers.at(-1)).toEqual({ kind: '@', query: 'REA', from: 0, to: 4 })
  })
})

describe('keys', () => {
  test("sendKey 'enter': Enter sends, Shift+Enter newline, Mod+Enter steers", async () => {
    const { view, spy } = await mount({ value: 'hi' })
    await act(async () => void key(view, { key: 'Enter' }))
    expect(spy.submits).toEqual(['send'])
    expect(view.state.doc.toString()).toBe('hi')
    await act(async () => view.dispatch({ selection: { anchor: 2 } }))
    await act(async () => void key(view, { key: 'Enter', shiftKey: true }))
    expect(view.state.doc.toString()).toBe('hi\n')
    expect(spy.submits).toEqual(['send'])
    await act(async () => void key(view, { key: 'Enter', metaKey: true }))
    expect(spy.submits).toEqual(['send', 'steer'])
  })

  test('Shift+Enter inserts a newline and is never offered to onKeyNav, even when nav would consume', async () => {
    const { view, spy } = await mount({ value: 'hi', navConsumes: true })
    await act(async () => view.dispatch({ selection: { anchor: 2 } }))
    await act(async () => void key(view, { key: 'Enter', shiftKey: true }))
    expect(view.state.doc.toString()).toBe('hi\n')
    expect(spy.nav).toEqual([])
    expect(spy.submits).toEqual([])
  })

  test("Shift+Enter inserts a newline in sendKey 'mod-enter' too", async () => {
    const { view, spy } = await mount({ value: 'hi', sendKey: 'mod-enter', navConsumes: true })
    await act(async () => view.dispatch({ selection: { anchor: 2 } }))
    await act(async () => void key(view, { key: 'Enter', shiftKey: true }))
    expect(view.state.doc.toString()).toBe('hi\n')
    expect(spy.submits).toEqual([])
  })

  test('a disabled editor never submits or steers and rejects edits', async () => {
    const { view, spy } = await mount({ value: 'hi', disabled: true })
    await act(async () => void key(view, { key: 'Enter' }))
    await act(async () => void key(view, { key: 'Enter', metaKey: true }))
    await act(async () => void key(view, { key: 'Enter', shiftKey: true }))
    await act(async () => void key(view, { key: 'b', metaKey: true }))
    expect(spy.submits).toEqual([])
    expect(view.state.doc.toString()).toBe('hi')
    expect(view.state.readOnly).toBe(true)
  })

  test("sendKey 'mod-enter': Enter newline, Mod+Enter sends, Shift+Mod+Enter steers", async () => {
    const { view, spy } = await mount({ value: 'hi', sendKey: 'mod-enter' })
    await act(async () => view.dispatch({ selection: { anchor: 2 } }))
    await act(async () => void key(view, { key: 'Enter' }))
    expect(view.state.doc.toString()).toBe('hi\n')
    expect(spy.submits).toEqual([])
    await act(async () => void key(view, { key: 'Enter', metaKey: true }))
    await act(async () => void key(view, { key: 'Enter', metaKey: true, shiftKey: true }))
    expect(spy.submits).toEqual(['send', 'steer'])
  })

  test('onKeyNav is offered first and a consumed key does nothing else', async () => {
    const { view, spy } = await mount({ value: 'hi', navConsumes: true })
    await act(async () => void key(view, { key: 'Enter' }))
    await act(async () => void key(view, { key: 'Escape' }))
    await act(async () => void key(view, { key: 'ArrowDown' }))
    await act(async () => void key(view, { key: 'Tab' }))
    expect(spy.nav).toEqual(['enter', 'escape', 'down', 'tab'])
    expect(spy.submits).toEqual([])
    expect(spy.escapes).toBe(0)
  })

  test('an unconsumed Escape calls onEscape; Up in an empty editor calls onUpInEmpty', async () => {
    const { view, spy } = await mount()
    await act(async () => void key(view, { key: 'Escape' }))
    expect(spy.escapes).toBe(1)
    await act(async () => void key(view, { key: 'ArrowUp' }))
    expect(spy.upInEmpty).toBe(1)
    await act(async () => set(view, 'x'))
    await act(async () => void key(view, { key: 'ArrowUp' }))
    expect(spy.upInEmpty).toBe(1)
  })

  test('Enter never submits while composing', async () => {
    const { view, spy } = await mount({ value: 'hi' })
    await act(async () => void key(view, { key: 'Enter', isComposing: true }))
    expect(spy.submits).toEqual([])
  })

  test('keyCode 229 Enter submits only when composition did not just end', async () => {
    const { view, spy } = await mount({ value: 'hi' })
    await act(async () => void view.contentDOM.dispatchEvent(new Event('compositionend', { bubbles: true })))
    await act(async () => void key(view, { key: 'Enter', keyCode: 229 }))
    expect(spy.submits).toEqual([])
    await Bun.sleep(70)
    await act(async () => void key(view, { key: 'Enter', keyCode: 229 }))
    expect(spy.submits).toEqual(['send'])
  })

  test('Cmd+B, Cmd+I and Cmd+E wrap the selection', async () => {
    const { view } = await mount({ value: 'word' })
    for (const [k, marker] of [['b', '**'], ['i', '*'], ['e', '`']] as const) {
      await act(async () => set(view, 'word'))
      await act(async () => view.dispatch({ selection: { anchor: 0, head: 4 } }))
      const mac = /Mac|iPhone|iPad/.test(navigator.platform)
      await act(async () => void key(view, { key: k, metaKey: mac, ctrlKey: !mac }))
      expect(view.state.doc.toString()).toBe(`${marker}word${marker}`)
    }
  })
})

describe('wrapSelection', () => {
  test('wraps a selection and puts an empty cursor between the markers', async () => {
    const { ref, view } = await mount({ value: 'a b' })
    await act(async () => view.dispatch({ selection: { anchor: 2, head: 3 } }))
    await act(async () => ref.current!.wrapSelection('**'))
    expect(view.state.doc.toString()).toBe('a **b**')
    await act(async () => ref.current!.clear())
    await act(async () => ref.current!.wrapSelection('`'))
    expect(view.state.doc.toString()).toBe('``')
    expect(view.state.selection.main.head).toBe(1)
  })
})

describe('paste and drop', () => {
  const dispatch = (view: EditorView, type: string, extra: Record<string, unknown>) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    for (const [k, v] of Object.entries(extra)) Object.defineProperty(event, k, { value: v })
    view.contentDOM.dispatchEvent(event)
    return event
  }

  test('text over 2,000 characters goes to onLongPaste and inserts nothing', async () => {
    const { view, spy } = await mount()
    const text = 'x'.repeat(2001)
    const event = dispatch(view, 'paste', { clipboardData: { files: [], items: [], getData: () => text } })
    expect(spy.longPastes).toEqual([text])
    expect(view.state.doc.length).toBe(0)
    expect(event.defaultPrevented).toBe(true)
  })

  test('text at the limit is left to the default paste', async () => {
    const { view, spy } = await mount()
    dispatch(view, 'paste', { clipboardData: { files: [], items: [], getData: () => 'x'.repeat(2000) } })
    expect(spy.longPastes).toEqual([])
    expect(spy.pasted).toEqual([])
    expect(view.state.doc.length).toBe(2000)
  })

  test('image files go to onPasteFiles and nothing is inserted', async () => {
    const { view, spy } = await mount()
    const png = new File(['x'], 'a.png', { type: 'image/png' })
    const event = dispatch(view, 'paste', { clipboardData: { files: [png], items: [], getData: () => '' } })
    expect(spy.pasted).toEqual([[png]])
    expect(view.state.doc.length).toBe(0)
    expect(event.defaultPrevented).toBe(true)
  })

  test('dropped files go to onDropFiles; a non-file drop is ignored', async () => {
    const { view, spy } = await mount()
    const file = new File(['x'], 'a.ts')
    const event = dispatch(view, 'drop', { dataTransfer: { files: [file], items: [] } })
    expect(spy.dropped).toEqual([[file]])
    expect(event.defaultPrevented).toBe(true)
    dispatch(view, 'drop', { dataTransfer: { files: [], items: [], getData: () => '' } })
    expect(spy.dropped.length).toBe(1)
  })
})

describe('markup', () => {
  test('exposes the accessible name and keeps markdown syntax visible', async () => {
    const { view } = await mount({ value: 'keep **bold** and `code`\n\n```ts\nlet a\n```' })
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Message the agent')
    expect(view.contentDOM.getAttribute('aria-multiline')).toBe('true')
    expect(view.contentDOM.textContent).toContain('**bold**')
    expect(view.contentDOM.textContent).toContain('```ts')
    expect(view.contentDOM.querySelectorAll('.cm-composer-codeblock').length).toBe(3)
  })
})
