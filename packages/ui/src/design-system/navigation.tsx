import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ListRowProps, MenuItem, MenuProps, SectionHeaderProps, TabsProps } from './contracts'
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

function MenuLevel({ label, items, onChoose, onDismiss, onBack, nested = false }: {
  label: string
  items: readonly MenuItem[]
  onChoose: (item: MenuItem) => void
  onDismiss: (restoreFocus: boolean) => void
  onBack?: () => void
  nested?: boolean
}) {
  const id = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [active, setActive] = useState(() => items.findIndex((item) => !item.disabled))

  useEffect(() => {
    const first = items.findIndex((item) => !item.disabled)
    ;(refs.current[first] ?? listRef.current)?.focus()
  }, [])

  const focusAt = (index: number) => {
    if (index < 0) return
    setActive(index)
    refs.current[index]?.focus()
  }
  const handleKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      for (let offset = 1; offset <= items.length; offset++) {
        const next = (index + direction * offset + items.length) % items.length
        if (!items[next].disabled) { focusAt(next); break }
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusAt(event.key === 'Home' ? items.findIndex((item) => !item.disabled) : lastEnabled(items))
    } else if (event.key === 'ArrowRight' && items[index].submenu) {
      event.preventDefault()
      setExpanded(items[index].id)
    } else if (event.key === 'ArrowLeft' && onBack) {
      event.preventDefault()
      onBack()
    }
  }

  return (
    <ul ref={listRef} id={id} className={classNames('ui-menu__list', nested && 'ui-menu__submenu')} role="menu" aria-label={label} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss(true)
        } else if (event.key === 'Tab') {
          event.stopPropagation()
          onDismiss(false)
        }
      }}>
      {items.map((item, index) => (
        <li key={item.id} role="none" title={item.title}>
          <button
            ref={(element) => { refs.current[index] = element }}
            type="button"
            className={classNames('ui-menu__item', item.destructive && 'ui-menu__item--destructive')}
            role="menuitem"
            title={item.title}
            data-current={item.current ? '' : undefined}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? expanded === item.id : undefined}
            tabIndex={!item.disabled && index === active ? 0 : -1}
            onClick={() => {
              if (item.disabled) return
              if (item.submenu) setExpanded(expanded === item.id ? null : item.id)
              else onChoose(item)
            }}
            onKeyDown={(event) => handleKey(event, index)}
          >
            <span>{item.current && <span aria-hidden="true">✓ </span>}{item.label}</span>
            {item.submenu && <span aria-hidden="true">›</span>}
          </button>
          {item.submenu && expanded === item.id && (
            <MenuLevel label={item.label} items={item.submenu} nested onChoose={onChoose} onDismiss={onDismiss}
              onBack={() => { setExpanded(null); refs.current[index]?.focus() }} />
          )}
        </li>
      ))}
    </ul>
  )
}

export function Menu({ label, items, position, onClose }: MenuProps) {
  const [expanded, setExpanded] = useState(false)
  const [coordinates, setCoordinates] = useState(position ?? { x: 0, y: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const opener = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const closing = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const open = position !== undefined || expanded
  const id = useId()
  const dismiss = (restoreFocus: boolean) => {
    if (closing.current) return
    closing.current = true
    setExpanded(false)
    if (restoreFocus) (triggerRef.current ?? opener.current)?.focus()
    closeRef.current?.()
  }

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!position || !menu) return
    const place = () => {
      const bounds = menu.getBoundingClientRect()
      const x = Math.max(0, Math.min(position.x, window.innerWidth - bounds.width))
      const y = Math.max(0, Math.min(position.y, window.innerHeight - bounds.height))
      setCoordinates((current) => current.x === x && current.y === y ? current : { x, y })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(menu)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [position?.x, position?.y, open])

  useEffect(() => {
    if (!open) return
    closing.current = false
    const dismissOutside = (event: Event) => {
      if (closing.current || !(event.target instanceof Node)) return
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return
      closing.current = true
      setExpanded(false)
      closeRef.current?.()
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('focusin', dismissOutside)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('focusin', dismissOutside)
    }
  }, [open])

  const menu = open && (
    <div ref={menuRef} id={id} className={classNames('ui-menu__popup', position && 'ui-context-menu')}
      style={position ? { left: coordinates.x, top: coordinates.y } : undefined}>
      <MenuLevel label={label} items={items} onDismiss={dismiss} onChoose={(item) => {
        dismiss(true)
        item.onAction?.()
      }} />
    </div>
  )

  if (position) return createPortal(menu, document.body)
  return (
    <div className="ui-menu">
      <button ref={triggerRef} type="button" className="ui-menu__trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={id}
        onClick={() => setExpanded((current) => !current)}>
        {label}<span className="ui-menu__trigger-icon" aria-hidden="true">⌄</span>
      </button>
      {menu}
    </div>
  )
}
