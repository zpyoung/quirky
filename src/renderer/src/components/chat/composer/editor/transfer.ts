import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { EditorCallbacks } from './types'

/**
 * Pastes go to the host first, which takes images and copied files and leaves text to the editor.
 * A dropped file is never read into the document: the surrounding pane attaches it.
 */
export function transferHandlers(props: EditorCallbacks): Extension {
  return EditorView.domEventHandlers({
    paste(event) {
      return props().onPaste(event)
    },
    drop(event) {
      if ((event.dataTransfer?.files?.length ?? 0) === 0) {
        return false
      }
      event.preventDefault()
      return true
    }
  })
}
