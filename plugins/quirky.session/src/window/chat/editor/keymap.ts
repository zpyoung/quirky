import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands'
import { EditorSelection, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { EditorCallbacks, NavKey } from './types'

/** Wraps each selection range in `marker`; an empty range gets the pair with the cursor between. */
export function wrapSelection(view: EditorView, marker: string): void {
  view.dispatch(
    view.state.changeByRange((range) => {
      const changes = [{ from: range.from, insert: marker }, { from: range.to, insert: marker }]
      const inner = range.empty
        ? { anchor: range.from + marker.length, head: range.from + marker.length }
        : { anchor: range.from + marker.length, head: range.to + marker.length }
      return { changes, range: EditorSelection.range(inner.anchor, inner.head) }
    }),
    { userEvent: 'input.format', scrollIntoView: true }
  )
}

const NAV: Record<string, NavKey> = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', Tab: 'tab', Escape: 'escape' }
const COMPOSITION_CONFIRM_MS = 50

/**
 * The composer's key handling at highest precedence: send/steer/newline per `sendKey`, suggestion-list
 * navigation offered first, IME-safe Enter, and Cmd+B/I/E formatting.
 */
export function composerKeymap(props: EditorCallbacks): Extension {
  let compositionEndedAt = -Infinity

  const handle = (view: EditorView, event: KeyboardEvent): boolean => {
    const p = props()
    if (p.disabled) return false
    const nav = NAV[event.key]
    const mod = event.metaKey || event.ctrlKey
    if (!nav) return false
    if (nav === 'enter') {
      const confirming = event.isComposing || view.composing || (event.keyCode === 229 && Date.now() - compositionEndedAt < COMPOSITION_CONFIRM_MS)
      if (confirming) return false
    }
    if ((nav === 'up' || nav === 'down') && (event.shiftKey || event.altKey || mod)) return false
    if (nav === 'tab' && (event.shiftKey || event.altKey || mod)) return false
    if (nav === 'enter' && event.shiftKey && !mod) {
      insertNewline(view)
      return true
    }
    if (p.onKeyNav?.(nav) === true) return true
    if (nav === 'escape') {
      if (!p.onEscape) return false
      p.onEscape()
      return true
    }
    if (nav === 'up' && view.state.doc.length === 0 && p.onUpInEmpty) {
      p.onUpInEmpty()
      return true
    }
    if (nav !== 'enter') return false
    if (p.sendKey === 'enter') {
      if (mod) p.onSubmit('steer')
      else if (event.shiftKey || event.altKey) insertNewline(view)
      else p.onSubmit('send')
    } else if (mod) {
      p.onSubmit(event.shiftKey ? 'steer' : 'send')
    } else {
      insertNewline(view)
    }
    return true
  }

  const format = (marker: string) => (view: EditorView) => {
    if (props().disabled) return true
    wrapSelection(view, marker)
    return true
  }

  return [
    EditorView.domEventHandlers({
      compositionend: () => {
        compositionEndedAt = Date.now()
        return false
      }
    }),
    Prec.highest(
      keymap.of([
        { key: 'Mod-b', run: format('**'), preventDefault: true },
        { key: 'Mod-i', run: format('*'), preventDefault: true },
        { key: 'Mod-e', run: format('`'), preventDefault: true },
        { any: handle }
      ])
    ),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap])
  ]
}
