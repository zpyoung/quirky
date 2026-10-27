import { Editor, type Extensions } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { Mathematics } from '@tiptap/extension-mathematics'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { MarkdownDocumentLink } from './DocumentLink'
import { MarkdownToggle } from './Toggle'

export function createMarkdownExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5] },
      link: false,
      trailingNode: false
    }),
    Markdown.configure({ markedOptions: { gfm: true } }),
    MarkdownDocumentLink,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: 'noopener noreferrer' }
    }),
    Image.configure({ allowBase64: false, inline: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    MarkdownToggle,
    Mathematics.configure({ katexOptions: { throwOnError: false } })
  ]
}

export function createHeadlessMarkdownEditor(markdown: string): Editor {
  return new Editor({
    element: null,
    extensions: createMarkdownExtensions(),
    content: markdown,
    contentType: 'markdown',
    editable: true
  })
}

export function serializeMarkdown(markdown: string): string | null {
  let editor: Editor | null = null
  try {
    editor = createHeadlessMarkdownEditor(markdown)
    return editor.getMarkdown()
  } catch {
    return null
  } finally {
    editor?.destroy()
  }
}

export function roundTripMarkdown(markdown: string): string | null {
  const canonical = serializeMarkdown(markdown)
  if (canonical === null) return null
  return serializeMarkdown(canonical)
}
