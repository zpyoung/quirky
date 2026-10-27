import { useEffect, useRef } from 'react'

/** One row of a menu. `title` is the tooltip: the reason when the row is disabled. */
export type MenuEntry = {
  label: string
  onSelect?(): void
  disabled?: boolean
  title?: string
  separatorBefore?: boolean
  /** Marks the row that matches the current value. */
  current?: boolean
}

type Props = {
  /** Viewport position of the menu's top-left corner. */
  x: number
  y: number
  label: string
  items: MenuEntry[]
  onClose(): void
}

const MENU_WIDTH = 220

/** A menu opened at a screen position; Escape, a click outside or picking an item closes it. */
export function PopupMenu({ x, y, label, items, onClose }: Props) {
  const root = useRef<HTMLUListElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const enabled = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    enabled()[0]?.focus()
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return close.current()
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const buttons = enabled()
      if (buttons.length === 0) return
      event.preventDefault()
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(at + step + buttons.length) % buttons.length]!.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH))
  return (
    <ul ref={root} className="menu menu-context" role="menu" aria-label={label} style={{ left, top: y }}>
      {items.map((item) => (
        <li key={item.label} role="none" title={item.title} className={item.separatorBefore ? 'menu-separated' : undefined}>
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            data-current={item.current ? '' : undefined}
            onClick={() => {
              onClose()
              item.onSelect?.()
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
