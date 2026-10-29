import { Badge } from '@quirky/ui'

export function LoopGlyph({ label }: { label: string }) {
  return (
    <span title={label}>
      <Badge tone="accent" label={label}>Loop</Badge>
    </span>
  )
}
