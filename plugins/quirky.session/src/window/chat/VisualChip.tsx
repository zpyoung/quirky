import type { CSSProperties } from 'react'

const chip = {
  display: 'inline-flex',
  alignItems: 'center',
  alignSelf: 'flex-start',
  gap: 'var(--ui-space-4)',
  maxWidth: '100%',
  padding: 'var(--ui-space-2) var(--ui-space-8)',
  color: 'var(--ui-accent)',
  background: 'var(--ui-transparent)',
  border: 'var(--ui-border-width) solid var(--ui-accent)',
  borderRadius: 'var(--ui-radius-window)',
  font: 'inherit',
  fontSize: 'var(--ui-font-label)',
  cursor: 'pointer'
} satisfies CSSProperties
const name = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } satisfies CSSProperties

/** The chip under a turn's message for a visual that turn drew or changed: `◈ <title> v<N>`; it opens that version in the panel. */
export function VisualChip({ title, version, onOpen }: { title: string; version: number; onOpen: () => void }) {
  return (
    <button type="button" style={chip} title={`Open ${title} v${version} in the visual panel`} onClick={onOpen}>
      <span aria-hidden="true">◈</span>
      <span style={name}>{`${title} v${version}`}</span>
    </button>
  )
}
