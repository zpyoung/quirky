import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { describeToolInput, formatToolInput } from '../../../../../shared/native-chat-tool-summary'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { RenderItemOf } from '../chat-turns'
import { callLifecycle, summarizeActivity } from './activity-summary'

function stateWord(state: 'running' | 'completed' | 'failed' | 'interrupted'): string {
  switch (state) {
    case 'running':
      return translate('components.chat.turn.callRunning', 'Running')
    case 'completed':
      return translate('components.chat.turn.callDone', 'Done')
    case 'failed':
      return translate('components.chat.turn.callFailed', 'Failed')
    case 'interrupted':
      return translate('components.chat.turn.callInterrupted', 'Interrupted')
  }
}

function CallRow({
  call,
  turnEnded
}: {
  call: RenderItemOf<'tool-call'>
  turnEnded: boolean
}): React.JSX.Element {
  const lifecycle = callLifecycle(call, turnEnded)
  const detail = formatToolInput(call.body.input)
  const output = call.body.output?.head ?? ''
  const label = `${call.body.name} ${describeToolInput(call.body.input)}`.trim()
  const hasDetail = detail !== '' || output !== ''
  return (
    <li data-call-state={lifecycle}>
      <details className="group/call">
        <summary
          className={cn(
            'flex items-center gap-2 py-0.5 text-sm text-chat-foreground-faint',
            hasDetail ? 'cursor-pointer' : 'cursor-default'
          )}
        >
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              lifecycle === 'running' && 'animate-pulse bg-chat-warning motion-reduce:animate-none',
              lifecycle === 'completed' && 'bg-chat-foreground-faint',
              (lifecycle === 'failed' || lifecycle === 'interrupted') && 'bg-destructive'
            )}
            role="img"
            aria-label={stateWord(lifecycle)}
          />
          <span className="min-w-0 truncate font-mono text-chat-code" title={label}>
            {label}
          </span>
        </summary>
        {hasDetail && (
          <pre className="ml-3.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1 font-mono text-chat-code text-muted-foreground scrollbar-sleek">
            {[detail, output].filter((part) => part !== '').join('\n\n')}
          </pre>
        )}
      </details>
    </li>
  )
}

/** A run of tool calls folded into one line that opens to one row per call. */
export function Activity({
  calls,
  turnEnded
}: {
  calls: readonly RenderItemOf<'tool-call'>[]
  turnEnded: boolean
}): React.JSX.Element {
  const running = calls.some((call) => callLifecycle(call, turnEnded) === 'running')
  const [open, setOpen] = useState(running)
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      aria-label={translate('components.chat.turn.toolActivity', 'Tool activity')}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 py-1 text-sm text-chat-foreground-faint">
        <ChevronRight
          className={cn(
            'size-3.5 transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
          aria-hidden="true"
        />
        {summarizeActivity(calls, turnEnded)}
      </summary>
      <ul className="ml-2 flex flex-col gap-0.5 border-l border-border pl-3">
        {calls.map((call) => (
          <CallRow key={call.itemId} call={call} turnEnded={turnEnded} />
        ))}
      </ul>
    </details>
  )
}
