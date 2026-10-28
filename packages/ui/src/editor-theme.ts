import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** Shared CodeMirror/merge chrome. Syntax-language and document state remain caller-owned. */
export const editorTheme: Extension = EditorView.theme({
  '&': { color: 'var(--ui-text)', backgroundColor: 'var(--ui-surface)', fontSize: 'var(--ui-font-mono)' },
  '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--ui-accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ui-accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--ui-accent) 30%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--ui-rail)', color: 'var(--ui-muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-changedLine, .cm-insertedLine': { backgroundColor: 'color-mix(in srgb, var(--ui-working) 12%, transparent)' },
  '.cm-changedText, .cm-insertedLine .cm-changedText': { backgroundColor: 'color-mix(in srgb, var(--ui-working) 28%, transparent)' },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--ui-failing) 12%, transparent)', paddingLeft: 'var(--ui-space-6)' },
  '.cm-deletedChunk .cm-deletedText, .cm-deletedLine del': { backgroundColor: 'color-mix(in srgb, var(--ui-failing) 28%, transparent)' },
  '.cm-deletedLine del, .cm-insertedLine ins': { textDecoration: 'none' },
  '.cm-deletedLine': { backgroundColor: 'color-mix(in srgb, var(--ui-failing) 12%, transparent)' },
  '.cm-changeGutter': { width: 'var(--ui-space-4)', paddingLeft: 'var(--ui-border-width)' },
  '.cm-gutterElement.cm-changedLineGutter, .cm-changedLineGutter': { background: 'var(--ui-working)' },
  '.cm-gutterElement.cm-deletedLineGutter, .cm-deletedLineGutter': { background: 'var(--ui-failing)' },
  '.cm-collapsedLines': { color: 'var(--ui-muted)', background: 'var(--ui-selected)', cursor: 'pointer', padding: 'var(--ui-space-2) var(--ui-space-8)', fontSize: 'var(--ui-font-label)' },
  '.cm-chunkButtons': { position: 'absolute', insetInlineEnd: 'var(--ui-space-6)', top: 'var(--ui-space-2)' },
  '.cm-chunkButtons button': { background: 'var(--ui-selected)', color: 'var(--ui-text)', border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-mark)', padding: '0 var(--ui-space-6)', fontSize: 'var(--ui-font-label)' },
  '.cm-trailingSpace': { backgroundColor: 'color-mix(in srgb, var(--ui-failing) 35%, transparent)' },
  '.cm-highlightSpace': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--ui-muted) 20%, transparent 5%)' },
  '.ui-editor-conflict-marker': { backgroundColor: 'color-mix(in srgb, var(--ui-needs-you) 18%, transparent)', color: 'var(--ui-needs-you)' },
  '.ui-editor-conflict-current': { backgroundColor: 'color-mix(in srgb, var(--ui-working) 12%, transparent)' },
  '.ui-editor-conflict-base': { backgroundColor: 'color-mix(in srgb, var(--ui-muted) 14%, transparent)' },
  '.ui-editor-conflict-incoming': { backgroundColor: 'color-mix(in srgb, var(--ui-accent) 12%, transparent)' },
  '.ui-editor-conflict-label': { marginLeft: 'var(--ui-space-12)', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', fontStyle: 'italic' },
})
