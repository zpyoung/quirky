import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { languageForPath, type LanguageId } from '../language'

const mix = (token: string, percent: number): string => `color-mix(in srgb, var(${token}) ${percent}%, transparent)`

/** The editor chrome and the merge view's change colours, all from the shell's theme variables. */
export const shellTheme: Extension = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg)', fontSize: '12px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: mix('--accent', 30) },
  '.cm-gutters': { backgroundColor: 'var(--bg-raised)', color: 'var(--dim)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-changedLine': { backgroundColor: mix('--green', 12) },
  '.cm-changedText, .cm-insertedLine .cm-changedText': { backgroundColor: mix('--green', 28) },
  '.cm-deletedChunk': { backgroundColor: mix('--danger', 12), paddingLeft: '6px' },
  '.cm-deletedChunk .cm-deletedText, .cm-deletedLine del': { backgroundColor: mix('--danger', 28) },
  '.cm-deletedLine del, .cm-insertedLine ins': { textDecoration: 'none' },
  '.cm-insertedLine': { backgroundColor: mix('--green', 12) },
  '.cm-deletedLine': { backgroundColor: mix('--danger', 12) },
  '.cm-changeGutter': { width: '3px', paddingLeft: '1px' },
  '.cm-gutterElement.cm-changedLineGutter, .cm-changedLineGutter': { background: 'var(--green)' },
  '.cm-gutterElement.cm-deletedLineGutter, .cm-deletedLineGutter': { background: 'var(--danger)' },
  '.cm-collapsedLines': {
    color: 'var(--muted)',
    background: 'var(--bg-hover)',
    cursor: 'pointer',
    padding: '2px 8px',
    fontSize: '11px'
  },
  '.cm-chunkButtons': { position: 'absolute', insetInlineEnd: '6px', top: '2px' },
  '.cm-chunkButtons button': {
    background: 'var(--bg-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '3px',
    padding: '0 6px',
    fontSize: '11px'
  },
  '.cm-trailingSpace': { backgroundColor: mix('--danger', 35) },
  '.cm-highlightSpace': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--dim) 20%, transparent 5%)' },
  '.qg-conflict-marker': { backgroundColor: mix('--amber', 18), color: 'var(--amber)' },
  '.qg-conflict-current': { backgroundColor: mix('--green', 12) },
  '.qg-conflict-base': { backgroundColor: mix('--grey', 14) },
  '.qg-conflict-incoming': { backgroundColor: mix('--accent', 12) },
  '.qg-conflict-label': { marginLeft: '12px', color: 'var(--muted)', fontSize: '11px', fontStyle: 'italic' }
})

/** The language support for a path, or no extension for plain text. */
export function languageExtension(id: LanguageId): Extension[] {
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

/** Whether the shell's background colour is dark; an unreadable colour counts as dark, like the shell's default. */
export function isDarkShell(element: Element): boolean {
  const value = getComputedStyle(element).getPropertyValue('--bg').trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1]
  if (!hex) return true
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}

/** Token colours for a path's language, picked for the shell's light or dark background. */
export function syntaxExtensions(path: string, host: Element): Extension[] {
  const style = isDarkShell(host) ? oneDarkHighlightStyle : defaultHighlightStyle
  return [...languageExtension(languageForPath(path)), syntaxHighlighting(style, { fallback: true })]
}

/** CodeMirror keeps '\n' as its line break unless told otherwise; a CRLF file must save back as CRLF. */
export function lineBreakExtension(text: string): Extension {
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text)
  return crlf ? EditorState.lineSeparator.of('\r\n') : []
}
