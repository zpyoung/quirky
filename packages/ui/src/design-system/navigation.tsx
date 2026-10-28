import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ListRowProps, MenuProps, SectionHeaderProps, TabsProps } from './contracts'
import { classNames } from './shared'
import { Badge, StatusDot } from './primitives'

export function ListRow({ title, description, status, progress, count, trailing, mainTitle, mainLabel, compact = false, selected = false, disabled = false, onClick }: ListRowProps) {
  const className = classNames(
    'ui-list-row',
    description !== undefined && description !== null && description !== false && 'ui-list-row--double',
    compact && 'ui-list-row--compact',
    selected && 'ui-list-row--selected',
    disabled && 'ui-list-row--disabled',
    onClick && 'ui-list-row--interactive',
  )
  const content = (
    <>
      {status && <span className="ui-list-row__status"><StatusDot status={status} progress={progress} label={`Status: ${status}`} /></span>}
      <span className="ui-list-row__body">
        <span className="ui-list-row__title">{title}</span>
        {description !== undefined && <span className="ui-list-row__description">{description}</span>}
      </span>
      {count !== undefined && <span className="ui-list-row__count"><Badge tone={status === 'needs-you' ? 'needs-you' : 'neutral'}>{count}</Badge></span>}
    </>
  )

  return (
    <div className={className} aria-disabled={disabled || undefined}>
      {onClick ? (
        <button
          type="button"
          className="ui-list-row__main"
          aria-pressed={selected}
          disabled={disabled}
          title={mainTitle}
          aria-label={mainLabel}
          onClick={() => { if (!disabled) onClick() }}
        >
          {content}
        </button>
      ) : (
        <div className="ui-list-row__main" title={mainTitle} aria-label={mainLabel} aria-current={selected ? 'true' : undefined}>
          {content}
        </div>
      )}
      {trailing !== undefined && <span className="ui-list-row__trailing">{trailing}</span>}
    </div>
  )
}

export function SectionHeader({ title, titleTooltip, actions, className, ...attributes }: SectionHeaderProps) {
  return (
    <header {...attributes} className={classNames('ui-section-header', className)}>
      <h2 className="ui-section-header__title" title={titleTooltip}>{title}</h2>
      {actions !== undefined && <div className="ui-section-header__actions">{actions}</div>}
    </header>
  )
}

function nextEnabled(items: TabsProps['items'], start: number, direction: 1 | -1): number {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (start + direction * offset + items.length) % items.length
    if (!items[index].disabled) return index
  }
  return -1
}

function lastEnabled(items: readonly { disabled?: boolean }[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!items[index].disabled) return index
  }
  return -1
}

export function Tabs({ label, items, value, onChange }: TabsProps) {
  const generatedId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = items.findIndex((item) => item.id === value)
  const rovingIndex = selectedIndex >= 0 && !items[selectedIndex].disabled
    ? selectedIndex
    : items.findIndex((item) => !item.disabled)

  const focusAndSelect = (index: number) => {
    if (index < 0) return
    tabRefs.current[index]?.focus()
    onChange(items[index].id)
  }

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let target = -1
    if (event.key === 'ArrowRight') target = nextEnabled(items, index, 1)
    else if (event.key === 'ArrowLeft') target = nextEnabled(items, index, -1)
    else if (event.key === 'Home') target = items.findIndex((item) => !item.disabled)
    else if (event.key === 'End') target = lastEnabled(items)
    else return
    event.preventDefault()
    focusAndSelect(target)
  }

  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(element) => { tabRefs.current[index] = element }}
          type="button"
          className="ui-tabs__tab"
          id={`${generatedId}-tab-${index}`}
          role="tab"
          aria-selected={item.id === value}
          aria-controls={item.panelId}
          disabled={item.disabled}
          tabIndex={index === rovingIndex ? 0 : -1}
          onClick={() => { if (!item.disabled) onChange(item.id) }}
          onKeyDown={(event) => onTabKeyDown(event, index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function Menu({ label, trigger, items }: MenuProps) {
  const generatedId = useId()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLUListElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const closeMenu = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const moveFocus = (start: number, direction: 1 | -1) => {
    for (let offset = 1; offset <= items.length; offset += 1) {
      const index = (start + direction * offset + items.length) % items.length
      if (items[index].disabled) continue
      setActiveIndex(index)
      itemRefs.current[index]?.focus()
      return
    }
  }

  useEffect(() => {
    if (!open) return
    const firstEnabled = items.findIndex((item) => !item.disabled)
    if (firstEnabled >= 0) {
      setActiveIndex(firstEnabled)
      itemRefs.current[firstEnabled]?.focus()
    } else {
      menuRef.current?.focus()
    }

    const dismissOutside = (event: Event) => {
      if (!(event.target instanceof Node)) return
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('focusin', dismissOutside)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('focusin', dismissOutside)
    }
  }, [open, items])

  const onItemKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(index, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(index, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      const first = items.findIndex((item) => !item.disabled)
      if (first >= 0) {
        setActiveIndex(first)
        itemRefs.current[first]?.focus()
      }
    } else if (event.key === 'End') {
      event.preventDefault()
      const last = lastEnabled(items)
      if (last >= 0) {
        setActiveIndex(last)
        itemRefs.current[last]?.focus()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
    } else if (event.key === 'Tab') {
      closeMenu()
    }
  }

  return (
    <div className="ui-menu">
      <button
        ref={triggerRef}
        type="button"
        className="ui-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${generatedId}-menu`}
        onClick={() => { if (open) setOpen(false); else setOpen(true) }}
      >
        {trigger ?? label}{trigger === undefined && <span className="ui-menu__trigger-icon" aria-hidden="true">⌄</span>}
      </button>
      {open && (
        <ul ref={menuRef} id={`${generatedId}-menu`} className="ui-menu__list" role="menu" aria-label={label} tabIndex={-1}>
          {items.map((item, index) => (
            <li key={item.id} role="none">
              <button
                ref={(element) => { itemRefs.current[index] = element }}
                type="button"
                className={classNames('ui-menu__item', item.destructive && 'ui-menu__item--destructive')}
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                aria-disabled={item.disabled || undefined}
                disabled={item.disabled}
                tabIndex={!item.disabled && index === activeIndex ? 0 : -1}
                onClick={() => {
                  if (item.disabled) return
                  item.onAction()
                  closeMenu(true)
                }}
                onKeyDown={(event) => onItemKeyDown(event, index)}
              >
                {item.checked !== undefined && <span aria-hidden="true">{item.checked ? '✓ ' : '　'}</span>}{item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
