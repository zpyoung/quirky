import { useId, type KeyboardEvent } from 'react'
import { Button } from '@quirky/ui'

/** A compact native switch with its visible label kept beside the checkbox. */
export function Switch({
  checked,
  label,
  ariaLabel = label,
  onChange
}: {
  checked: boolean
  label: string
  ariaLabel?: string
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-6)', minWidth: 0 }}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        aria-checked={checked}
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        style={{ accentColor: 'var(--ui-accent)', flexShrink: 0 }}
      />
      <span className="ui-form-row__label">{label}</span>
    </label>
  )
}

export type Segment<T extends string> = { value: T; label: string }

/** Radio semantics and arrow-key behavior composed from the shared button primitive. */
export function Segmented<T extends string>({
  value,
  options,
  label,
  onChange
}: {
  value: T | null
  options: Segment<T>[]
  label: string
  onChange: (value: T) => void
}) {
  const selected = options.findIndex((option) => option.value === value)

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
    onChange(options[next]!.value)
  }

  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-6)' }}>
      {options.map((option, index) => (
        <Button
          key={option.value}
          variant={option.value === value ? 'primary' : 'secondary'}
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === (selected === -1 ? 0 : selected) ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
