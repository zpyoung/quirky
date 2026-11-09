import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type {
  ActivityMarkProps,
  BulkBarProps,
  CheckboxProps,
  HoverCardProps,
  NoticeLineProps,
  SwatchGroupProps,
  TagChipProps,
  TagChipsProps,
  UiTagColor,
} from './contracts'

const swatchColors: Array<UiTagColor | null> = ['blue', 'violet', 'teal', 'coral', 'magenta', 'mint', 'sand', 'rose', null]

/** A status mark whose shape, not just its color, names the state; the label is its accessible name. */
export function ActivityMark({ state, label }: ActivityMarkProps) {
  return <span className={`ui-activity-mark ui-activity-mark--${state}`} data-state={state} role="img" aria-label={label} />
}

/** A single tag, tinted by its hue (grey when the tag has none); it never wraps or truncates. */
export function TagChip({ name, color }: TagChipProps) {
  return <span className="ui-tag-chip" data-color={color ?? 'grey'}>{name}</span>
}

/** The first `max` tags as whole chips plus a "+N" count for the rest. */
export function TagChips({ tags, max = 2 }: TagChipsProps) {
  if (tags.length === 0) return null
  const shown = tags.slice(0, Math.max(0, max))
  const hidden = tags.length - shown.length
  return (
    <span className="ui-tag-chips">
      {shown.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} />)}
      {hidden > 0 ? <span className="ui-tag-chips__more" aria-label={`${hidden} more ${hidden === 1 ? 'tag' : 'tags'}`}>+{hidden}</span> : null}
    </span>
  )
}

/** A native checkbox that can show a mixed state; `onChange` receives the value the click asks for. */
export function Checkbox({ checked, indeterminate = false, label, onChange, hideLabel = false }: CheckboxProps) {
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className="ui-checkbox">
      <input
        ref={input}
        type="checkbox"
        className="ui-checkbox__input"
        checked={checked}
        aria-checked={indeterminate ? 'mixed' : checked}
        aria-label={hideLabel ? label : undefined}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {hideLabel ? null : <span className="ui-checkbox__text">{label}</span>}
    </label>
  )
}

/** A radiogroup of the eight tag hues plus grey (`null`); arrow keys move and select, wrapping at the ends. */
export function SwatchGroup({ value, onChange, label }: SwatchGroupProps) {
  const swatches = useRef<Array<HTMLButtonElement | null>>([])
  const move = (index: number) => {
    const next = (index + swatchColors.length) % swatchColors.length
    onChange(swatchColors[next] ?? null)
    swatches.current[next]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const target = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? swatchColors.length - 1
            : null
    if (target === null) return
    event.preventDefault()
    move(target)
  }
  const current = swatchColors.indexOf(value)
  return (
    <div className="ui-swatch-group" role="radiogroup" aria-label={label}>
      {swatchColors.map((color, index) => {
        const name = color ?? 'grey'
        const checked = index === current
        return (
          <button
            key={name}
            ref={(node) => { swatches.current[index] = node }}
            type="button"
            role="radio"
            className="ui-swatch"
            data-color={name}
            aria-checked={checked}
            aria-label={name}
            tabIndex={checked || (current < 0 && index === 0) ? 0 : -1}
            onClick={() => onChange(color)}
            onKeyDown={(event) => onKeyDown(event, index)}
          />
        )
      })}
    </div>
  )
}

/** One muted line of status text with link-style actions. */
export function NoticeLine({ children, actions }: NoticeLineProps) {
  return (
    <p className="ui-notice-line">
      <span className="ui-notice-line__text">{children}</span>
      {actions?.map((action) => (
        <button key={action.label} type="button" className="ui-notice-line__action" disabled={action.disabled} onClick={action.onAction}>
          {action.label}
        </button>
      ))}
    </p>
  )
}

/** A non-interactive tooltip-style card under its anchor; it never takes focus. */
export function HoverCard({ anchor, open, children }: HoverCardProps) {
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const shown = open && anchor !== null
  useLayoutEffect(() => {
    if (!shown) return
    const place = () => {
      const box = anchor.getBoundingClientRect()
      setPosition({ left: Math.max(0, box.left), top: box.bottom })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [shown, anchor])
  useEffect(() => {
    if (!shown) setPosition({ visibility: 'hidden' })
  }, [shown])
  return shown ? createPortal(<div className="ui-hover-card" role="tooltip" style={position}>{children}</div>, document.body) : null
}

/** A raised strip naming the selection size with bulk actions; dismissing on Escape is the caller's job. */
export function BulkBar({ count, actions, onClear }: BulkBarProps) {
  return (
    <div className="ui-bulk-bar" role="region" aria-label="Bulk actions">
      <span className="ui-bulk-bar__count">{count} selected</span>
      <span className="ui-bulk-bar__actions">
        {actions.map((action) => (
          <button key={action.label} type="button" className="ui-bulk-bar__action" disabled={action.disabled} onClick={action.onAction}>
            {action.label}
          </button>
        ))}
        <button type="button" className="ui-bulk-bar__action ui-bulk-bar__action--clear" onClick={onClear}>Clear</button>
      </span>
    </div>
  )
}
