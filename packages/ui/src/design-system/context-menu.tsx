import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ContextMenuItem, ContextMenuListProps, ContextMenuProps } from './context-menu-contracts'

/** A shared menu separator for callers assembling dynamic command lists. */
export const CONTEXT_MENU_SEPARATOR: ContextMenuItem = { label: '', separator: true }

const isRow = (item: ContextMenuItem) => !item.separator && item.enabled !== false

function firstRow(items: readonly ContextMenuItem[]): number {
  return items.findIndex(isRow)
}

function step(items: readonly ContextMenuItem[], from: number, direction: 1 | -1): number {
  if (!items.some(isRow)) return -1
  let index = from
  for (let n = 0; n < items.length; n += 1) {
    index = (index + direction + items.length) % items.length
    if (isRow(items[index]!)) return index
  }
  return -1
}

/**
 * One keyboard-scoped menu level: arrows navigate and open submenus; Escape and Left return one
 * level; Enter and Space select. A header may own focus for searchable menus.
 */
export function ContextMenuList({ items, label, onChoose, onClose, onBack, header, highlightFirst, autoFocus = true }: ContextMenuListProps) {
  const [highlight, setHighlight] = useState(() => (highlightFirst ? firstRow(items) : -1))
  const [open, setOpen] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const signature = items.map((item) => item.label).join('\n')

  useEffect(() => {
    setOpen(-1)
    setHighlight(highlightFirst ? firstRow(items) : -1)
    // The rows changed (a filter typed into the header), so the old position means nothing.
  }, [signature, highlightFirst])

  useEffect(() => {
    if (autoFocus && !header) root.current?.focus()
  }, [autoFocus, header])

  const closeSubmenu = () => {
    setOpen(-1)
    root.current?.focus()
  }

  const pick = (index: number) => {
    const item = items[index]
    if (!item || !isRow(item)) return
    if (item.submenu) setOpen(index)
    else onChoose(item)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    switch (event.key) {
      case 'ArrowDown':
        handled()
        setHighlight(step(items, highlight, 1))
        break
      case 'ArrowUp':
        handled()
        setHighlight(step(items, highlight < 0 ? 0 : highlight, -1))
        break
      case 'ArrowRight':
        if (highlight >= 0 && items[highlight]?.submenu && isRow(items[highlight]!)) {
          handled()
          setOpen(highlight)
        }
        break
      case 'ArrowLeft':
        if (onBack) {
          handled()
          onBack()
        }
        break
      case 'Enter':
        if (event.nativeEvent.isComposing || event.keyCode === 229) break
        if (highlight >= 0) {
          handled()
          pick(highlight)
        }
        break
      case ' ':
        if (highlight >= 0 && !(event.target instanceof HTMLInputElement)) {
          handled()
          pick(highlight)
        }
        break
      case 'Escape':
        handled()
        if (onBack) onBack()
        else onClose()
        break
    }
  }

  return (
    <div ref={root} className="qt-menu" role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={(event) => event.stopPropagation()}>
      {header}
      {items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} className="qt-menu-separator" role="separator" />
        ) : (
          <div key={item.id ?? `${item.label}-${index}`} className="qt-menu-row">
            <button
              type="button"
              role="menuitem"
              className={`qt-menu-item${item.danger ? ' qt-danger' : ''}${highlight === index ? ' qt-highlight' : ''}`}
              disabled={item.enabled === false}
              aria-haspopup={item.submenu ? 'menu' : undefined}
              aria-expanded={item.submenu ? open === index : undefined}
              aria-checked={item.checked === undefined ? undefined : item.checked}
              data-highlighted={highlight === index ? '' : undefined}
              tabIndex={-1}
              onMouseEnter={() => {
                if (item.enabled === false) return
                setHighlight(index)
                if (item.submenu) setOpen(index)
                else if (open >= 0) closeSubmenu()
              }}
              onClick={() => pick(index)}
            >
              {item.swatch ? <span className="qt-swatch" style={{ background: item.swatch }} aria-hidden /> : null}
              <span className="qt-menu-label">{item.label}</span>
              {item.checked ? <span aria-hidden>✓</span> : null}
              {item.key ? <span className="qt-menu-key">{item.key}</span> : null}
              {item.submenu ? <span className="qt-menu-arrow" aria-hidden>▸</span> : null}
            </button>
            {item.submenu && open === index ? (
              <div className="qt-submenu">
                <ContextMenuList items={item.submenu} label={item.label} onChoose={onChoose} onClose={onClose} onBack={closeSubmenu} />
              </div>
            ) : null}
          </div>
        )
      )}
    </div>
  )
}

/** A menu positioned at its caller-provided screen coordinate. */
export function ContextMenu({ items, label, x, y, onClose, header, highlightFirst }: ContextMenuProps) {
  const anchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const onChoose = (item: ContextMenuItem) => {
    onClose()
    item.onSelect?.()
  }

  return (
    <div ref={anchor} className="qt-menu-anchor" style={{ left: x, top: y }}>
      <ContextMenuList
        items={items}
        label={label}
        header={header}
        highlightFirst={highlightFirst}
        onClose={onClose}
        onChoose={onChoose}
      />
    </div>
  )
}
