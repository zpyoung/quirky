import { useEffect, useRef } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import type { GitDiffPair } from '@quirky/protocol'
import { withoutTrailingNewline } from './diffText'
import { languageForPath } from './language'
import { languageExtension } from './view/theme'

/** Read-only side-by-side diff: the left side is `original`, the right side is `modified`. */
export function DiffView({ diff }: { diff: GitDiffPair }) {
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
      a: { doc: withoutTrailingNewline(diff.original), extensions },
      b: { doc: withoutTrailingNewline(diff.modified), extensions },
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
