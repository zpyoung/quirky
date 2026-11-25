import { GitFork } from 'lucide-react'
import type { RenderItemOf } from '../chat-turns'

/** Opens a forked chat: says which chat it continues. */
export function ForkRow({ item }: { item: RenderItemOf<'fork'> }): React.JSX.Element {
  const { fromTitle } = item.body
  return (
    <div
      role="status"
      data-chat-row="fork"
      className="flex items-center gap-2 text-xs text-chat-foreground-faint"
    >
      <GitFork className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {fromTitle ? `Forked from ${fromTitle}` : 'Forked from another chat'}
      </span>
    </div>
  )
}
