/** Removes one trailing line break so CodeMirror does not render an empty last line. */
export function withoutTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}
