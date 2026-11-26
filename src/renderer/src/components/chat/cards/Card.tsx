import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type CardTone = 'neutral' | 'failing'

/** A framed card with a small kind label; `header` follows the label and `children` is the body. */
export function Card({
  label,
  ariaLabel,
  tone = 'neutral',
  header,
  children
}: {
  label: string
  ariaLabel: string
  tone?: CardTone
  header?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <article
      aria-label={ariaLabel}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-sm text-card-foreground',
        tone === 'failing' ? 'border-destructive/50' : 'border-border'
      )}
    >
      <div className="flex min-w-0 items-center gap-2 bg-muted/50 px-3 py-1.5">
        <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {header}
      </div>
      {children !== undefined && (
        <div className="min-w-0 px-3 py-2 [overflow-wrap:anywhere]">{children}</div>
      )}
    </article>
  )
}

/** "+18 −4" in the diff colors; nothing when neither count is known. */
export function Delta({ added, removed }: { added?: number; removed?: number }): React.JSX.Element {
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-chat-code">
      {added !== undefined && <span className="text-chat-diff-added">{`+${added}`}</span>}
      {removed !== undefined && <span className="text-chat-diff-removed">{`−${removed}`}</span>}
    </span>
  )
}
