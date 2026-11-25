import type { AgentJournalChatMode } from '../../../../../shared/agent-session-journal-v1-items'
import type { RenderItemOf } from '../chat-turns'

const MODE_LABELS: Record<AgentJournalChatMode, string> = {
  ask: 'Ask',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
  'full-access': 'Full access',
  plan: 'Plan'
}

/** A quiet line where the chat's mode changed. */
export function ModeMarkerRow({ item }: { item: RenderItemOf<'mode'> }): React.JSX.Element {
  const { mode, previous } = item.body
  return (
    <div
      role="status"
      data-chat-row="mode"
      className="flex items-center gap-2 text-xs text-chat-foreground-faint"
    >
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span>
        {previous ? `Mode changed from ${MODE_LABELS[previous]} to ` : 'Mode set to '}
        {MODE_LABELS[mode]}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}
