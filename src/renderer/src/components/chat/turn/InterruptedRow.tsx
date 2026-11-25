import { CircleSlash } from 'lucide-react'
import { formatDuration } from './elapsed'

/** Closes a turn the agent was cut off in, such as one running when Quirky quit. */
export function InterruptedRow({ durationMs }: { durationMs?: number }): React.JSX.Element {
  const after = durationMs === undefined ? '' : formatDuration(durationMs)
  return (
    <div
      role="status"
      data-chat-row="interrupted"
      className="flex items-center gap-2 text-xs text-chat-foreground-faint"
    >
      <CircleSlash className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {after ? `Interrupted after ${after}` : 'Interrupted'}. The turn did not finish. Send a
        message to continue.
      </span>
    </div>
  )
}
