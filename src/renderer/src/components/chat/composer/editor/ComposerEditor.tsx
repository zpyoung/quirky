import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
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
const accessEditing = (disabled: boolean) => [
  EditorView.editable.of(!disabled),
  EditorState.readOnly.of(disabled)
]

/**
 * The composer's message editor: plain text with visible, faded markdown syntax, atomic file and
 * command pills, and the send/steer/newline key handling. The document is the message text; a
 * change that comes from outside the editor goes through `setValue` and is never reported back.
 */
export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(props, ref) {
    const mount = useRef<HTMLDivElement>(null)
    const view = useRef<EditorView | null>(null)
    const latest = useRef(props)
    latest.current = props
    const editable = useRef(new Compartment())
    const placeholder = useRef(new Compartment())

    useEffect(() => {
      const read = () => latest.current
      const state = EditorState.create({
        doc: latest.current.initialValue,
        extensions: [
          pillsExtension,
          markdownStyling,
          composerTheme,
          composerKeymap(read),
          transferHandlers(read),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of(() => ({
            'aria-label': read().accessibleName,
            'aria-multiline': 'true',
            role: 'textbox'
          })),
          editable.current.of(accessEditing(!!latest.current.disabled)),
          placeholder.current.of(placeholderExtension(latest.current.placeholder)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(EXTERNAL))) {
              read().onChange(update.state.doc.toString())
            }
            if (update.docChanged || update.selectionSet) {
              read().onTrigger(detectTrigger(update.state))
            }
          })
        ]
      })
      if (!mount.current) {
        return
      }
      const created = new EditorView({ state, parent: mount.current })
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

    useImperativeHandle(ref, () => ({
      focus: () => view.current?.focus(),
      insertPill(pill, range) {
        const current = view.current
        if (!current) {
          return
        }
        const target = range ??
          detectTrigger(current.state) ?? {
            from: current.state.selection.main.from,
            to: current.state.selection.main.to
          }
        current.dispatch({
          ...pillTransaction(pill, target),
          userEvent: 'input.complete',
          scrollIntoView: true
        })
        current.focus()
      },
      insertText(text) {
        const current = view.current
        if (!current) {
          return
        }
        current.dispatch(current.state.replaceSelection(text), {
          userEvent: 'input.paste',
          scrollIntoView: true
        })
      },
      wrapSelection(marker) {
        if (view.current) {
          wrapSelection(view.current, marker)
        }
      },
      setValue(value) {
        const current = view.current
        // a live composition owns the document; the caller re-syncs once it settles
        if (!current || current.composing || current.state.doc.toString() === value) {
          return
        }
        current.dispatch({
          changes: { from: 0, to: current.state.doc.length, insert: value },
          selection: { anchor: value.length },
          effects: reparsePills(),
          annotations: EXTERNAL.of(true)
        })
      },
      getValue: () => view.current?.state.doc.toString() ?? '',
      selection: () => {
        const main = view.current?.state.selection.main
        return { from: main?.from ?? 0, to: main?.to ?? 0 }
      },
      hasFocus: () => view.current?.hasFocus ?? false,
      containsNode: (node) => (node ? (mount.current?.contains(node) ?? false) : false)
    }))

    return <div ref={mount} className="flex min-w-0 flex-col" />
  }
)
