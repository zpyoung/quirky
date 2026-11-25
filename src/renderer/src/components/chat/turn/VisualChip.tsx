import { Shapes } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RenderItemOf } from '../chat-turns'
import { useChatTurnEnv } from './chat-turn-env'

/** A visual the agent drew in this turn: `title vN`, opening it in the visual panel. */
export function VisualChip({ item }: { item: RenderItemOf<'visual'> }): React.JSX.Element {
  const { onOpenVisual } = useChatTurnEnv()
  const { viewId, version, title, closed } = item.body
  const label = `${title ?? 'Visual'} v${version}${closed ? ' (closed)' : ''}`
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="self-start"
      data-chat-row="visual"
      disabled={onOpenVisual === undefined}
      title={`Open ${label} in the visual panel`}
      onClick={() => onOpenVisual?.(viewId)}
    >
      <Shapes aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  )
}
