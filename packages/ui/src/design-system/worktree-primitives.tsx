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

/**
 * How many leading chips fit whole in `budget`, counting the "+N" for the rest (`moreWidth`) and the
 * `gap` between items. Returns 0 when not even one chip fits; the caller then shows only "+N".
 */
export function fitTagChipCount(chips: readonly number[], total: number, moreWidth: number, budget: number, gap: number): number {
  for (let count = chips.length; count > 0; count--) {
    let width = gap * (count - 1)
    for (let index = 0; index < count; index++) width += chips[index]!
    if (total > count) width += gap + moreWidth
    if (width <= budget) return count
  }
  return 0
}

const px = (value: string) => Number.parseFloat(value) || 0

/** Width the chips may take beside their siblings once the `.ui-name-share` sibling keeps `nameShare` of the row; null when unmeasurable. */
function chipBudget(chips: HTMLElement, nameShare: number): { budget: number; gap: number } | null {
  const row = chips.parentElement
  if (!row || row.clientWidth === 0) return null
  const rowStyle = globalThis.getComputedStyle(row)
  const rowGap = px(rowStyle.columnGap)
  let others = 0
  let name = false
  for (const child of Array.from(row.children) as HTMLElement[]) {
    if (child === chips) continue
    if (child.classList.contains('ui-name-share')) name = true
    else others += child.offsetWidth
  }
  if (!name) return null
  const gaps = rowGap * (row.children.length - 1)
  return { budget: row.clientWidth * (1 - nameShare) - others - gaps, gap: px(globalThis.getComputedStyle(chips).columnGap) }
}

/**
 * Tags as whole chips plus a "+N" count for the rest, at most `max` chips. With `nameShare` and a
 * `.ui-name-share` sibling, chips that would squeeze that name below its share of the row move into
 * the "+N" instead, even when that leaves none. Without a measurable layout it shows `max` chips.
 */
export function TagChips({ tags, max = 2, nameShare }: TagChipsProps & { nameShare?: number }) {
  const container = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState<number | null>(null)
  const candidates = tags.slice(0, Math.max(0, max))
  const measurable = fit !== null
  // key stands for tags and max, which arrive as a fresh array every render
  const key = `${max}:${tags.map((tag) => `${tag.id}\u0000${tag.name}`).join('\u0001')}`

  useLayoutEffect(() => {
    const element = container.current
    if (!element || nameShare === undefined) return
    const measure = () => {
      const space = chipBudget(element, nameShare)
      if (!space) return setFit(null)
      const widths = [...element.querySelectorAll<HTMLElement>('.ui-tag-chip')].map((chip) => chip.offsetWidth)
      const more = element.querySelector<HTMLElement>('.ui-tag-chips__probe-more')
      setFit(fitTagChipCount(widths, tags.length, more?.offsetWidth ?? 0, space.budget, space.gap))
    }
    measure()
    const row = element.parentElement
    if (!row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [key, nameShare, measurable])

  if (tags.length === 0) return null
  const shownCount = Math.min(fit ?? candidates.length, candidates.length)
  const shown = candidates.slice(0, shownCount)
  const probes = candidates.slice(shownCount)
  const hidden = tags.length - shown.length
  return (
    <span className="ui-tag-chips" ref={container}>
      {shown.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} />)}
      {hidden > 0 ? <span className="ui-tag-chips__more" aria-label={`${hidden} more ${hidden === 1 ? 'tag' : 'tags'}`}>+{hidden}</span> : null}
      {measurable ? (
        <span className="ui-tag-chips__probes" aria-hidden="true">
          {probes.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} />)}
          <span className="ui-tag-chips__probe-more">+{tags.length}</span>
        </span>
      ) : null}
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
