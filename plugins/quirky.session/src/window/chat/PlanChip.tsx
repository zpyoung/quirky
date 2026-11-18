import type { CSSProperties } from 'react'
import { Button } from '@quirky/ui'
import { planChipText, type PlanVersion } from './plan'

const chip = { borderRadius: 'var(--ui-radius-window)' } satisfies CSSProperties
const live = { ...chip, color: 'var(--ui-accent)', borderColor: 'var(--ui-accent)' } satisfies CSSProperties

/** The chat header's Plan chip: names the newest plan version's state and shows or hides the plan panel. */
export function PlanChip({ newest, open, onToggle }: { newest: PlanVersion; open: boolean; onToggle: () => void }) {
  const waiting = newest.status === 'waiting'
  return (
    <Button style={waiting ? live : chip} aria-expanded={open} aria-haspopup="dialog" onClick={onToggle}>
      {planChipText(newest)}
    </Button>
  )
}
