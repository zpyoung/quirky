import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** Hooks the editor to the composer's stylesheet, which holds every rule from STYLEGUIDE tokens. */
export const composerTheme: Extension = EditorView.editorAttributes.of({ class: 'composer-cm' })
