import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands'
import { EditorSelection, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { EditorCallbacks, NavKey, SubmitKind } from './types'

/** Wraps each selection range in `marker`; an empty range gets the pair with the cursor between. */
export function wrapSelection(view: EditorView, marker: string): void {
  view.dispatch(
    view.state.changeByRange((range) => {
      const changes = [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker }
      ]
      const inner = range.empty
        ? { anchor: range.from + marker.length, head: range.from + marker.length }
        : { anchor: range.from + marker.length, head: range.to + marker.length }
      return { changes, range: EditorSelection.range(inner.anchor, inner.head) }
    }),
    { userEvent: 'input.format', scrollIntoView: true }
  )
}

const NAV: Record<string, NavKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'escape'
}
const COMPOSITION_CONFIRM_MS = 50
// Enter is the composer's own: the stock binding would add a newline for the Enter that picks an IME candidate
const baseKeymap = defaultKeymap.filter((binding) => binding.key !== 'Enter')

type EnterChord = { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }

/** What a plain Enter chord does under the configured send key. */
export function enterIntent(
  sendKey: 'enter' | 'mod-enter',
  chord: EnterChord
): SubmitKind | 'newline' {
  const mod = chord.metaKey || chord.ctrlKey
  if (sendKey === 'enter') {
    if (mod) {
      return 'steer'
    }
    return chord.shiftKey || chord.altKey ? 'newline' : 'send'
  }
  return mod ? (chord.shiftKey ? 'steer' : 'send') : 'newline'
}

/**
 * The composer's key handling at highest precedence: send/steer/newline per `sendKey`, suggestion-list
 * navigation offered first, IME-safe Enter, Shift+Tab mode cycling, and Cmd+B/I/E formatting.
 */
export function composerKeymap(props: EditorCallbacks): Extension {
  let compositionEndedAt = -Infinity

  const handle = (view: EditorView, event: KeyboardEvent): boolean => {
    const p = props()
    const imeOwned = event.isComposing || view.composing || event.keyCode === 229
    // the confirming Enter of a CJK composition can arrive as a second, unmarked keydown
    const swallowed = p.ime.ownsKeyDown({
      key: event.key,
      keyCode: event.keyCode,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      nativeEvent: event,
      preventDefault: () => event.preventDefault()
    })
    if (swallowed) {
      return !imeOwned
    }
    if (p.disabled) {
      return false
    }
    const nav = NAV[event.key]
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Tab' && event.shiftKey && !event.altKey && !mod && p.onCycleMode) {
      event.preventDefault()
      p.onCycleMode()
      return true
    }
    if (!nav) {
      return false
    }
    if (nav === 'enter') {
      const confirming =
        imeOwned || p.ime.isComposing() || Date.now() - compositionEndedAt < COMPOSITION_CONFIRM_MS
      if (confirming) {
        return false
      }
    }
    if ((nav === 'up' || nav === 'down') && (event.shiftKey || event.altKey || mod)) {
      return false
    }
    if (nav === 'tab' && (event.shiftKey || event.altKey || mod)) {
      return false
    }
    if (nav === 'enter' && event.shiftKey && !mod) {
      insertNewline(view)
      return true
    }
    if (p.onKeyNav?.(nav) === true) {
      return true
    }
    if (nav === 'escape') {
      if (!p.onEscape) {
        return false
      }
      p.onEscape()
      return true
    }
    if (nav === 'up' && view.state.doc.length === 0 && p.onUpInEmpty) {
      p.onUpInEmpty()
      return true
    }
    if (nav !== 'enter') {
      return false
    }
    const intent = enterIntent(p.sendKey, event)
    if (intent === 'newline') {
      insertNewline(view)
    } else {
      p.onSubmit(intent)
    }
    return true
  }

  const format = (marker: string) => (view: EditorView) => {
    if (props().disabled) {
      return true
    }
    wrapSelection(view, marker)
    return true
  }

  return [
    EditorView.domEventHandlers({
      compositionstart: () => {
        props().ime.setComposing(true)
        return false
      },
      compositionend: () => {
        compositionEndedAt = Date.now()
        props().ime.onCompositionEnd()
        // CM commits the composed text after this handler, so settle once it has
        setTimeout(() => props().onCompositionSettled?.(), COMPOSITION_CONFIRM_MS)
        return false
      },
      keyup: (event) => {
        props().ime.onKeyUp({
          key: event.key,
          keyCode: event.keyCode,
          shiftKey: event.shiftKey,
          nativeEvent: event,
          preventDefault: () => event.preventDefault()
        })
        return false
      },
      blur: () => {
        props().ime.reset()
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
    keymap.of([...baseKeymap, ...historyKeymap])
  ]
}
