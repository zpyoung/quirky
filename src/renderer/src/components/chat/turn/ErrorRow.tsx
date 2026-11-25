import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RenderItemOf } from '../chat-turns'
import { useChatErrorActions } from './chat-error-actions'

/** The row a failed start or an agent exit leaves in the transcript, in the words the host wrote. */
export function ErrorRow({ item }: { item: RenderItemOf<'status'> }): React.JSX.Element {
  const actions = useChatErrorActions()
  const onRestart = actions?.onRestart
  const onOpenInTerminal = actions?.onOpenInTerminal
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-sm text-card-foreground"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{item.body.text}</span>
      </div>
      {(onRestart || onOpenInTerminal) && (
        <div className="flex flex-wrap gap-2 pl-6">
          {onRestart && (
            <Button type="button" variant="outline" size="xs" onClick={onRestart}>
              Restart
            </Button>
          )}
          {onOpenInTerminal && (
            <Button type="button" variant="outline" size="xs" onClick={onOpenInTerminal}>
              Open in terminal
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
