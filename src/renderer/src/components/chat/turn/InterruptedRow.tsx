import { CircleSlash } from 'lucide-react'
import { translate } from '@/i18n/i18n'
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
        {after
          ? translate(
              'components.chat.turn.interruptedAfter',
              'Interrupted after {{duration}}. The turn did not finish. Send a message to continue.',
              { duration: after }
            )
          : translate(
              'components.chat.turn.interrupted',
              'Interrupted. The turn did not finish. Send a message to continue.'
            )}
      </span>
    </div>
  )
}
