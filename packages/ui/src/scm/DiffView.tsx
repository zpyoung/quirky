import { useEffect, useRef } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import type { GitDiff } from '@quirky/protocol'
import { languageForPath, type LanguageId } from '../lib/language'

function languageExtension(id: LanguageId): Extension[] {
  switch (id) {
    case 'javascript':
      return [javascript()]
    case 'jsx':
      return [javascript({ jsx: true })]
    case 'typescript':
      return [javascript({ typescript: true })]
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })]
    case 'json':
      return [json()]
    case 'markdown':
      return [markdown()]
    case 'python':
      return [python()]
    case 'plain':
      return []
  }
}

/** Read-only side-by-side diff: the left side is `original`, the right side is `modified`. */
export function DiffView({ diff }: { diff: GitDiff }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const parent = host.current
    if (!parent || diff.binary) return
    const extensions = [
      lineNumbers(),
      oneDark,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      ...languageExtension(languageForPath(diff.path))
    ]
    const view = new MergeView({
      a: { doc: diff.original, extensions },
      b: { doc: diff.modified, extensions },
      parent,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 6 }
    })
    return () => view.destroy()
  }, [diff])

  if (diff.binary) return <div className="diff-note">Binary file</div>
  return <div className="diff-host" ref={host} />
}
