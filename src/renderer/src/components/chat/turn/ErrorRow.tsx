import { TriangleAlert } from 'lucide-react'
import type { RenderItemOf } from '../chat-turns'

/** The row a failed start or an agent exit leaves in the transcript, in the words the host wrote. */
export function ErrorRow({ item }: { item: RenderItemOf<'status'> }): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-sm text-card-foreground"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{item.body.text}</span>
    </div>
  )
}
