import { useEffect, useRef } from 'react'
import { Annotation, EditorState, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, lineNumbers, type DecorationSet } from '@codemirror/view'
import type { SecretHit } from '../core/types'

/** Marks a transaction the component made itself, so it is not reported as the person typing. */
const external = Annotation.define<boolean>()
const setHits = StateEffect.define<SecretHit[]>()

function marksOf(hits: SecretHit[], length: number): DecorationSet {
  const ranges: Range<Decoration>[] = hits
    .filter((hit) => hit.start < hit.end && hit.end <= length)
    .map((hit) => Decoration.mark({ class: 'ui-secret-highlight', attributes: { title: `Potential secret: ${hit.excerpt}` } }).range(hit.start, hit.end))
  return Decoration.set(ranges, true)
}

const secretMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHits)) return marksOf(effect.value, transaction.state.doc.length)
    }
    return marks.map(transaction.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})


type Props = {
  text: string
  secrets: SecretHit[]
  onEdit: (text: string) => void
}

/**
 * The brief as plain text in CodeMirror 6, with line numbers, word wrap and a red mark over each
 * likely secret. Typing calls `onEdit`; replacing `text` from outside does not.
 */
export function PreviewEditor({ text, secrets, onEdit }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const edit = useRef(onEdit)
  edit.current = onEdit
  const initial = useRef({ text, secrets })

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.current.text,
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          secretMarks,
          EditorView.contentAttributes.of({ 'aria-label': 'Brief preview' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(external))) {
              edit.current(update.state.doc.toString())
            }
          })
        ]
      })
    })
    editor.dispatch({ effects: setHits.of(initial.current.secrets) })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === text) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, annotations: external.of(true) })
  }, [text])

  useEffect(() => {
    view.current?.dispatch({ effects: setHits.of(secrets), annotations: external.of(true) })
  }, [secrets])

  return <div ref={host} className="ui-code-editor" data-preview-editor />
}
