import { EditorState, type Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { languageForPath, type LanguageId } from '../language'


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

/** Whether the shared surface token resolves to a dark colour; unreadable values use the dark syntax palette. */
export function isDarkShell(element: Element): boolean {
  const value = getComputedStyle(element).getPropertyValue('--ui-surface').trim()
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
