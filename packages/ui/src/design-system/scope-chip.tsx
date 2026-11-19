import type { ScopeChipProps } from './contracts'
import { ControlIcon } from './tool-icons'
import { IconButton } from './primitives'

/** A removable chip naming the scope a view is narrowed to. */
export function ScopeChip({ label, onRemove, removeLabel }: ScopeChipProps) {
  return (
    <span className="ui-scope-chip">
      <span className="ui-scope-chip__label">{label}</span>
      <IconButton label={removeLabel ?? `Remove ${label}`} className="ui-scope-chip__remove" onClick={onRemove}>
        <ControlIcon name="x" />
      </IconButton>
    </span>
  )
}
