import type { CSSProperties } from 'react'
import { ControlIcon, IconButton } from '@quirky/ui'

const SIZE = 'calc(var(--ui-space-24) * 2)'

const frame = {
  position: 'relative',
  flex: 'none',
  width: SIZE,
  height: SIZE,
  borderRadius: 'var(--ui-radius-control)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  background: 'var(--ui-selected)',
  overflow: 'hidden'
} satisfies CSSProperties
const picture = { display: 'block', width: '100%', height: '100%', objectFit: 'cover' } satisfies CSSProperties
const remove = {
  position: 'absolute',
  top: 'var(--ui-space-2)',
  right: 'var(--ui-space-2)',
  padding: 'var(--ui-space-2)',
  borderRadius: 'var(--ui-radius-mark)',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)',
  borderColor: 'var(--ui-border)'
} satisfies CSSProperties

/** A removable thumbnail of an image attached to the composer, titled with its file name. */
export function ImageChip({ name, preview, onRemove }: { name: string; preview: string; onRemove: () => void }) {
  return (
    <span style={frame} title={name} className="composer-image-chip">
      <img src={preview} alt={name} style={picture} />
      <IconButton label={`Remove ${name}`} style={remove} onClick={onRemove}>
        <ControlIcon name="x" />
      </IconButton>
    </span>
  )
}
