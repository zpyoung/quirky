import type { CSSProperties } from 'react'
import { uiTokens } from '@quirky/ui'

const switchStyle: CSSProperties = {
  accentColor: `var(${uiTokens.color.accent})`,
  appearance: 'auto',
  background: `var(${uiTokens.color.transparent})`,
  border: 0,
  margin: 0,
  padding: 0,
  width: 'auto'
}

type SwitchProps = {
  checked: boolean
  label: string
  disabled: boolean
  id?: string
  'aria-describedby'?: string
  onChange: (checked: boolean) => void
}

/** A native checkbox exposed with switch semantics for assistive technology. */
export function Switch({ checked, label, disabled, id, 'aria-describedby': describedBy, onChange }: SwitchProps) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
      style={switchStyle}
    />
  )
}
