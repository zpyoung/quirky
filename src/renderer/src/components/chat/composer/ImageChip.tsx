import { translate } from '@/i18n/i18n'
import { Loader2, X } from 'lucide-react'

/**
 * A removable chip for an image attached to the composer: a thumbnail when the bytes are at hand,
 * else its name. A pending chip is still uploading and holds Send.
 */
export function ImageChip({
  name,
  preview,
  pending = false,
  onRemove
}: {
  name: string
  preview?: string
  pending?: boolean
  onRemove: () => void
}): React.JSX.Element {
  const remove = (
    <button
      type="button"
      aria-label={translate('components.chat.composer.removeAttachment', 'Remove {{name}}', {
        name
      })}
      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={onRemove}
    >
      <X className="size-3" aria-hidden />
    </button>
  )
  if (preview) {
    return (
      <span
        title={name}
        className="relative size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted"
      >
        <img src={preview} alt={name} className="size-full object-cover" />
        <span className="absolute top-0.5 right-0.5 rounded-sm bg-background">{remove}</span>
      </span>
    )
  }
  return (
    <span
      title={name}
      className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
    >
      {pending ? <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden /> : null}
      <span className="max-w-56 truncate">{name}</span>
      {remove}
    </span>
  )
}
