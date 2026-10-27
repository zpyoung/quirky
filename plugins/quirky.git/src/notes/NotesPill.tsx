/** The sparkle, "AI notes" and a count that the notes pills of the diff views show. */
export function NotesPillContent({ count }: { count: number }) {
  return (
    <>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" className="qgv-note-sparkle">
        <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6z" fill="currentColor" />
      </svg>{' '}
      <span>AI notes</span> <span className="qgv-note-count">{count}</span>
    </>
  )
}
