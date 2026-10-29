import { Badge } from '@quirky/ui'

/** The sparkle, "AI notes" and a count that the notes pills of the diff views show. */
export function NotesPillContent({ count }: { count: number }) {
  return (
    <>
      <span aria-hidden="true">✦</span>
      <span>AI notes</span>{' '}
      <Badge tone="accent">{count}</Badge>
    </>
  )
}
