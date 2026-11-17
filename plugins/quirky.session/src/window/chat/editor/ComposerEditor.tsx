import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from 'react'
import { Annotation, Compartment, EditorState } from '@codemirror/state'
import { EditorView, placeholder as placeholderExtension } from '@codemirror/view'
import { composerKeymap, wrapSelection } from './keymap'
import { markdownStyling } from './markdown'
import { pillTransaction, pillsExtension, reparsePills } from './pills'
import { composerTheme } from './theme'
import { transferHandlers } from './transfer'
import { detectTrigger } from './triggers'
import type { ComposerEditorHandle, ComposerEditorProps } from './types'

const EXTERNAL = Annotation.define<boolean>()
const accessEditing = (disabled: boolean) => [EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]
const host = { display: 'flex', flexDirection: 'column', flex: '0 0 auto' } satisfies CSSProperties

/**
 * The composer's message editor: plain text with visible, faded markdown syntax, atomic file and
 * command pills, and the send/steer/newline key handling. The document is the message text.
 */
export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(props, ref) {
  const mount = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const editable = useRef(new Compartment())
  const placeholder = useRef(new Compartment())

  useEffect(() => {
    const read = () => latest.current
    const state = EditorState.create({
      doc: latest.current.value,
      extensions: [
        pillsExtension,
        markdownStyling,
        composerTheme,
        composerKeymap(read),
        transferHandlers(read),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of(() => ({ 'aria-label': read().accessibleName, 'aria-multiline': 'true', role: 'textbox' })),
        editable.current.of(accessEditing(!!latest.current.disabled)),
        placeholder.current.of(placeholderExtension(latest.current.placeholder)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(EXTERNAL))) read().onChange(update.state.doc.toString())
          if (update.docChanged || update.selectionSet) read().onTrigger(detectTrigger(update.state))
        })
      ]
    })
    const created = new EditorView({ state, parent: mount.current! })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        editable.current.reconfigure(accessEditing(!!props.disabled)),
        placeholder.current.reconfigure(placeholderExtension(props.placeholder))
      ]
    })
  }, [props.disabled, props.placeholder])

  useEffect(() => {
    const current = view.current
    if (!current || current.state.doc.toString() === props.value) return
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: props.value },
      selection: { anchor: props.value.length },
      effects: reparsePills(),
      annotations: EXTERNAL.of(true)
    })
  }, [props.value])

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    insertPill(pill, range) {
      const current = view.current
      if (!current) return
      const target = range ?? detectTrigger(current.state) ?? { from: current.state.selection.main.from, to: current.state.selection.main.to }
      current.dispatch({ ...pillTransaction(pill, target), userEvent: 'input.complete', scrollIntoView: true })
      current.focus()
    },
    wrapSelection(marker) {
      if (view.current) wrapSelection(view.current, marker)
    },
    clear() {
      const current = view.current
      if (current) current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: '' } })
    }
  }))

  return <div ref={mount} style={host} />
})
