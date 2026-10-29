import type { CSSProperties } from 'react'
import type { Session } from '@quirky/protocol'
import { Badge, Button } from '@quirky/ui'

const layout = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-8)',
  borderTop: 'var(--ui-border-width) solid var(--ui-border)',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)'
} satisfies CSSProperties

export function ExitedBar({ session, onClose }: { session: Session; onClose: () => void }) {
  return (
    <div style={layout} role="status">
      <Badge>{`exited (code ${session.exitCode ?? '?'})`}</Badge>
      <Button type="button" onClick={onClose}>Close</Button>
    </div>
  )
}
