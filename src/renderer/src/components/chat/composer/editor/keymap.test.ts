// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { composerKeymap, enterIntent } from './keymap'
import type { ComposerEditorProps } from './types'

type KeyInit = KeyboardEventInit & { keyCode?: number }

const mounted: EditorView[] = []

function mount(overrides: Partial<ComposerEditorProps> = {}, doc = '') {
  const { result } = renderHook(() => useImeEnterGestureOwnership())
  const props: ComposerEditorProps = {
    initialValue: doc,
    onChange: vi.fn(),
    placeholder: '',
    sendKey: 'enter',
    ime: result.current,
    onSubmit: vi.fn(),
    onTrigger: vi.fn(),
    onPaste: () => false,
    accessibleName: 'Message',
    ...overrides
  }
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [composerKeymap(() => props)] }),
    parent: document.body
  })
  mounted.push(view)
  return { view, props, ime: result.current }
}

function press(view: EditorView, init: KeyInit): KeyboardEvent {
  const { keyCode, ...rest } = init
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...rest })
  if (keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: keyCode })
  }
  view.contentDOM.dispatchEvent(event)
  return event
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

afterEach(() => {
  mounted.splice(0).forEach((view) => view.destroy())
})

describe('enterIntent', () => {
  const plain = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }

  it('sends on Enter and steers on Cmd+Enter when Enter is the send key', () => {
    expect(enterIntent('enter', plain)).toBe('send')
    expect(enterIntent('enter', { ...plain, metaKey: true })).toBe('steer')
    expect(enterIntent('enter', { ...plain, shiftKey: true })).toBe('newline')
  })

  it('needs Cmd+Enter to send when that is the send key', () => {
    expect(enterIntent('mod-enter', plain)).toBe('newline')
    expect(enterIntent('mod-enter', { ...plain, metaKey: true })).toBe('send')
    expect(enterIntent('mod-enter', { ...plain, metaKey: true, shiftKey: true })).toBe('steer')
  })
})

describe('composer keymap', () => {
  it('sends on Enter and inserts a newline on Shift+Enter', () => {
    const { view, props } = mount({}, 'hello')
    press(view, { key: 'Enter', keyCode: 13 })
    expect(props.onSubmit).toHaveBeenCalledWith('send')

    vi.mocked(props.onSubmit).mockClear()
    press(view, { key: 'Enter', keyCode: 13, shiftKey: true })
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(view.state.doc.lines).toBe(2)
  })

  it('steers on Cmd+Enter', () => {
    const { view, props } = mount({}, 'hello')
    press(view, { key: 'Enter', keyCode: 13, metaKey: true })
    expect(props.onSubmit).toHaveBeenCalledWith('steer')
  })

  it('never sends or edits while the composer is disabled', () => {
    const { view, props } = mount({ disabled: true }, 'hello')
    press(view, { key: 'Enter', keyCode: 13 })
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('offers keys to the suggestion list before acting on them', () => {
    const onKeyNav = vi.fn().mockReturnValue(true)
    const { view, props } = mount({ onKeyNav }, 'hello')
    press(view, { key: 'Enter', keyCode: 13 })
    expect(onKeyNav).toHaveBeenCalledWith('enter')
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('recalls on Up in an empty editor and leaves Up alone otherwise', () => {
    const onUpInEmpty = vi.fn()
    const empty = mount({ onUpInEmpty })
    press(empty.view, { key: 'ArrowUp', keyCode: 38 })
    expect(onUpInEmpty).toHaveBeenCalledTimes(1)

    onUpInEmpty.mockClear()
    const typed = mount({ onUpInEmpty }, 'draft')
    press(typed.view, { key: 'ArrowUp', keyCode: 38 })
    expect(onUpInEmpty).not.toHaveBeenCalled()
  })

  it('calls onEscape when the list does not take Escape', () => {
    const onEscape = vi.fn()
    const { view } = mount({ onEscape }, 'hello')
    press(view, { key: 'Escape', keyCode: 27 })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })
})

describe('IME composition (TEST-5)', () => {
  it('does not send on the Enter that picks a composition candidate', () => {
    const { view, props } = mount({}, 'konnichiwa')
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    press(view, { key: 'Enter', keyCode: 229, isComposing: true })
    press(view, { key: 'Process', keyCode: 229, isComposing: true })
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('konnichiwa')
  })

  it('swallows the unmarked Enter the IME redispatches right after the composition ends', () => {
    const { view, props } = mount({}, 'konnichiwa')
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    press(view, { key: 'Enter', keyCode: 229, isComposing: true })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    press(view, { key: 'Enter', keyCode: 13 })
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('sends on a later Enter once the composition has ended', async () => {
    const { view, props } = mount({}, 'konnichiwa')
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    press(view, { key: 'Enter', keyCode: 229, isComposing: true })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    view.contentDOM.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await nextFrame()
    await new Promise((resolve) => setTimeout(resolve, 60))
    press(view, { key: 'Enter', keyCode: 13 })
    expect(props.onSubmit).toHaveBeenCalledWith('send')
  })
})
