import { useRef, type KeyboardEvent } from 'react'
import { s } from './styles'

/** A two-state control that reads as a switch to assistive technology. */
export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      style={{ ...s.switchTrack, background: checked ? 'var(--accent)' : 'var(--bg-active)' }}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" style={{ ...s.switchThumb, left: checked ? 15 : 1 }} />
    </button>
  )
}

export type Segment<T extends string> = { value: T; label: string }

/**
 * Mutually exclusive choices as a radio group. A `value` of null selects none, and arrow keys
 * move the choice as they do for native radios.
 */
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
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex((option) => option.value === value)

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    refs.current[next]?.focus()
    onChange(options[next]!.value)
  }

  return (
    <div role="radiogroup" aria-label={label} style={s.segments}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            refs.current[index] = node
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === (selected === -1 ? 0 : selected) ? 0 : -1}
          className={option.value === value ? 'active' : undefined}
          style={option.value === value ? s.segmentSelected : s.segment}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
