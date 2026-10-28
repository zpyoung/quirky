/** What the prompt needs of a note. */
export type FormattableNote = { path: string; startLine: number; line: number; body: string; source?: 'markdown' }

// a body keeps LF and CR because the escape below turns them into `\n` and `\r`; a path is not escaped
const BODY_CONTROLS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g
const PATH_CONTROLS = /[\u0000-\u001F\u007F]/g

function formatNote(note: FormattableNote): string {
  const escaped = note.body.replace(BODY_CONTROLS, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  const location = note.startLine === note.line ? `Line: ${note.line}` : `Lines: ${note.startLine}-${note.line}`
  return [
    `File: ${note.path.replace(PATH_CONTROLS, '')}`,
    ...(note.source === 'markdown' ? ['Source: markdown'] : []),
    location,
    `User comment: "${escaped}"`
  ].join('\n')
}

/**
 * The prompt an agent receives for review notes: Orca's text, one block per note, blocks joined by
 * a blank line, nothing before or after. Control characters are removed first (an ESC in a body
 * could end a bracketed paste early), so what reaches the agent is plain text.
 */
export function formatNotes(notes: readonly FormattableNote[]): string {
  return notes.map(formatNote).join('\n\n')
}
