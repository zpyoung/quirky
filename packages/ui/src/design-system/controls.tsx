import { useEffect } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, HTMLAttributes } from 'react'
import type { AffixInputProps, ChoiceOption, DisclosureButtonProps, LinkButtonProps, ReachMeterProps, SegmentedControlProps, TagButtonProps } from './contracts'
import { classNames } from './shared'
import { ControlIcon } from './tool-icons'

const ARROW_STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/** Moves focus between the radios of a group on arrow, Home and End keys; returns the index now focused, or null when the key is not one of those. */
function moveRadioFocus(event: ReactKeyboardEvent<HTMLElement>): number | null {
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
  if (radios.length === 0) return null
  const current = Math.max(0, radios.indexOf(event.target as HTMLElement))
  let next: number
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = radios.length - 1
  else if (event.key in ARROW_STEPS) next = (current + ARROW_STEPS[event.key] + radios.length) % radios.length
  else return null
  event.preventDefault()
  radios[next].focus()
  return next
}

function tabStop(options: ChoiceOption[], value: string | null | undefined, index: number): 0 | -1 {
  const checked = options.findIndex((option) => option.value === value)
  return index === (checked === -1 ? 0 : checked) ? 0 : -1
}

/**
 * A single-choice scale where each choice reaches further than the one before it: segments up to and
 * including `value` are filled, the current one is outlined and its name bold. Arrow keys move
 * between segments and select as they go; `caution` tints the name of the widest choice.
 */
export function ReachMeter({ label, options, value, onChange, className }: ReachMeterProps) {
  const current = options.findIndex((option) => option.value === value)
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = moveRadioFocus(event)
    if (next !== null) onChange(options[next].value)
  }
  return (
    <div role="radiogroup" aria-label={label} className={classNames('ui-reach-meter', className)} onKeyDown={onKeyDown}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={index === current}
          tabIndex={tabStop(options, value, index)}
          title={option.title}
          className={classNames('ui-reach-meter__segment', index <= current && 'ui-reach-meter__segment--in', index === current && 'ui-reach-meter__segment--current', option.caution && 'ui-reach-meter__segment--caution')}
          onClick={() => onChange(option.value)}
        >
          <span className="ui-reach-meter__bar" aria-hidden="true" />
          <span className="ui-reach-meter__name">{option.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * A compact single-choice group for toolbars. `value` may be null when nothing is chosen yet. Arrow
 * keys only move focus; Space or Enter chooses, so passing through a `caution` option that asks
 * for confirmation never triggers it.
 */
export function SegmentedControl({ label, options, value, onChange, className }: SegmentedControlProps) {
  return (
    <div role="radiogroup" aria-label={label} className={classNames('ui-segmented', className)} onKeyDown={(event) => { moveRadioFocus(event) }}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={tabStop(options, value, index)}
          title={option.title}
          className={classNames('ui-segmented__option', option.caution && 'ui-segmented__option--caution')}
          onClick={() => onChange(option.value)}
        >{option.label}</button>
      ))}
    </div>
  )
}

/**
 * A text input with an optional read-only lead-in (`prefixText`) and a trailing control (`suffix`)
 * inside one bordered field. The lead-in is decorative: name the input with `aria-label`.
 */
export function AffixInput({ prefixText, suffix, mono = false, className, ref, ...props }: AffixInputProps) {
  return (
    <div className={classNames('ui-affix-input', mono && 'ui-affix-input--mono')}>
      {prefixText !== undefined && <span className="ui-affix-input__prefix" aria-hidden="true">{prefixText}</span>}
      <input autoCapitalize="off" autoCorrect="off" {...props} ref={ref} className={classNames('ui-affix-input__input', className)} />
      {suffix !== undefined && <span className="ui-affix-input__suffix">{suffix}</span>}
    </div>
  )
}

/** A button that reads as an inline link, for an action inside a sentence or footer line. */
export function LinkButton({ tone, className, type = 'button', ...props }: LinkButtonProps) {
  return <button {...props} type={type} className={classNames('ui-link-button', tone === 'failing' && 'ui-link-button--failing', className)} />
}

/** A small outlined button that labels a value and flips it when pressed. */
export function TagButton({ className, type = 'button', ...props }: TagButtonProps) {
  return <button {...props} type={type} className={classNames('ui-tag-button', className)} />
}

/** A chevron button that shows and hides a region; `label` is its accessible name and `expanded` is exposed as aria-expanded. */
export function DisclosureButton({ label, expanded, className, type = 'button', ...props }: DisclosureButtonProps) {
  return (
    <button {...props} type={type} aria-label={label} aria-expanded={expanded} className={classNames('ui-disclosure-button', expanded && 'ui-disclosure-button--open', className)}>
      <ControlIcon name="caret-right" size={12} />
    </button>
  )
}

/** A keyboard shortcut hint such as ⌘↵. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <kbd {...props} className={classNames('ui-kbd', className)} />
}
