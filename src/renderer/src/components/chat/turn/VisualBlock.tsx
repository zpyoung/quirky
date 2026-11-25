import { PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { RenderItemOf } from '../chat-turns'
import { VisualItemCard } from '../panels/VisualItemCard'
import { useChatTurnEnv } from './chat-turn-env'
import { VisualChip } from './VisualChip'

/** A visual in the turn: drawn in place when the agent asked for `inline`, a chip into the panel for `pane`. */
export function VisualBlock({ item }: { item: RenderItemOf<'visual'> }): React.JSX.Element {
  const {
    sessionId,
    target,
    onOpenVisual,
    workspaceRoot,
    readWorkspaceImage,
    worktreeId,
    markdown
  } = useChatTurnEnv()
  if (item.body.placement !== 'inline') {
    return <VisualChip item={item} />
  }
  return (
    <div data-chat-row="visual" className="flex min-w-0 flex-col gap-1">
      <VisualItemCard
        item={item}
        sessionId={sessionId}
        target={target}
        workspaceRoot={workspaceRoot ?? null}
        worktreeId={worktreeId ?? null}
        onOpenLink={markdown.onOpenLink}
        {...(readWorkspaceImage ? { readWorkspaceImage } : {})}
      />
      {onOpenVisual && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="self-start"
          onClick={() => onOpenVisual(item.body.viewId)}
        >
          <PanelRight aria-hidden="true" />
          {translate('components.chat.turn.openInPanel', 'Open in panel')}
        </Button>
      )}
    </div>
  )
}
