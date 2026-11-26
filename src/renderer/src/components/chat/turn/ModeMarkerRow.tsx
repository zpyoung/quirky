import type { AgentJournalChatMode } from '../../../../../shared/agent-session-journal-v1-items'
import type { RenderItemOf } from '../chat-turns'
import { translate } from '@/i18n/i18n'

function modeLabel(mode: AgentJournalChatMode): string {
  switch (mode) {
    case 'ask':
      return translate('components.chat.turn.modeAsk', 'Ask')
    case 'accept-edits':
      return translate('components.chat.turn.modeAcceptEdits', 'Accept edits')
    case 'auto':
      return translate('components.chat.turn.modeAuto', 'Auto')
    case 'full-access':
      return translate('components.chat.turn.modeFullAccess', 'Full access')
    case 'plan':
      return translate('components.chat.turn.modePlan', 'Plan')
  }
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
        {previous
          ? translate('components.chat.turn.modeChanged', 'Mode changed from {{from}} to {{to}}', {
              from: modeLabel(previous),
              to: modeLabel(mode)
            })
          : translate('components.chat.turn.modeSet', 'Mode set to {{mode}}', {
              mode: modeLabel(mode)
            })}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}
