import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** Composer chrome from `--ui-*` tokens only; mirrors the token pattern of the shared editor theme. */
export const composerTheme: Extension = EditorView.theme({
  '&': { color: 'var(--ui-text)', backgroundColor: 'var(--ui-transparent)', fontSize: 'var(--ui-font-body)', maxHeight: '40vh', flex: '0 0 auto' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5', overflowY: 'auto', minHeight: 'calc(1.5em + var(--ui-space-6) * 2)' },
  '.cm-content': { caretColor: 'var(--ui-accent)', padding: 'var(--ui-space-6) 0' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ui-accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--ui-accent) 30%, var(--ui-transparent))' },
  '.cm-activeLine': { backgroundColor: 'var(--ui-transparent)' },
  '.cm-placeholder': { color: 'var(--ui-muted)' },
  '.cm-composer-code': { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 'var(--ui-font-mono)', backgroundColor: 'var(--ui-selected)', borderRadius: 'var(--ui-radius-mark)' },
  '.cm-composer-codeblock': { backgroundColor: 'var(--ui-selected)', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 'var(--ui-font-mono)', padding: '0 var(--ui-space-8)' },
  '.cm-composer-codeblock .cm-composer-code': { backgroundColor: 'var(--ui-transparent)' },
  '.cm-composer-listline': { paddingInlineStart: 'var(--ui-space-8)' },
  '.cm-composer-pill': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--ui-space-4)',
    padding: '0 var(--ui-space-6)',
    marginInlineEnd: 'var(--ui-space-4)',
    verticalAlign: 'baseline',
    backgroundColor: 'color-mix(in srgb, var(--ui-accent) 14%, var(--ui-transparent))',
    color: 'var(--ui-text)',
    border: 'var(--ui-border-width) solid var(--ui-border)',
    borderRadius: 'var(--ui-radius-mark)',
    fontSize: 'var(--ui-font-label)'
  },
  '.cm-composer-pill-command': { fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--ui-accent)' },
  '.cm-composer-pill-icon': { color: 'var(--ui-muted)' }
})
