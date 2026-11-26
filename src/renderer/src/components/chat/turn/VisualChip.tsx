import { LayoutDashboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { RenderItemOf } from '../chat-turns'
import { useChatTurnEnv } from './chat-turn-env'

/** A visual the agent drew in this turn: `title vN`, opening it in the visual panel. */
export function VisualChip({ item }: { item: RenderItemOf<'visual'> }): React.JSX.Element {
  const { onOpenVisual } = useChatTurnEnv()
  const { viewId, version, title, closed } = item.body
  const versioned = translate('components.chat.turn.visualVersioned', '{{title}} v{{version}}', {
    title: title ?? translate('components.chat.turn.visualDefaultTitle', 'Visual'),
    version
  })
  const label = closed
    ? translate('components.chat.turn.visualClosed', '{{label}} (closed)', { label: versioned })
    : versioned
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="self-start"
      data-chat-row="visual"
      disabled={onOpenVisual === undefined}
      title={translate(
        'components.chat.turn.openVisualInPanel',
        'Open {{label}} in the visual panel',
        {
          label
        }
      )}
      onClick={() => onOpenVisual?.(viewId)}
    >
      <LayoutDashboard aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  )
}
