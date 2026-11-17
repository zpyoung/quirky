import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { EditorCallbacks } from './types'

export const LONG_PASTE_CHARS = 2000

const filesOf = (data: DataTransfer | null): File[] => {
  if (!data) return []
  const files = Array.from(data.files ?? [])
  if (files.length > 0) return files
  return Array.from(data.items ?? []).flatMap((item) => (item.kind === 'file' ? [item.getAsFile()].filter((f): f is File => f !== null) : []))
}

/** Image paste and any file drop go to the host; text pastes over the limit go to the host as a long paste. */
export function transferHandlers(props: EditorCallbacks): Extension {
  return EditorView.domEventHandlers({
    paste(event) {
      const images = filesOf(event.clipboardData).filter((file) => file.type.startsWith('image/'))
      if (images.length > 0) {
        event.preventDefault()
        props().onPasteFiles(images)
        return true
      }
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.length > LONG_PASTE_CHARS) {
        event.preventDefault()
        props().onLongPaste(text)
        return true
      }
      return false
    },
    drop(event) {
      const files = filesOf(event.dataTransfer)
      if (files.length === 0) return false
      event.preventDefault()
      props().onDropFiles(files)
      return true
    }
  })
}
