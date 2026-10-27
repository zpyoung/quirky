import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'

/** One row of a menu. `title` is the tooltip: the reason when the row is disabled. */
export type MenuEntry = {
  label: string
  onSelect?(): void
  disabled?: boolean
  title?: string
  separatorBefore?: boolean
  /** Marks the row that matches the current value. */
  current?: boolean
  /** Leading mark, such as a state dot. */
  icon?: ReactNode
  /** A second, muted line under the label. */
  detail?: string
  /** A trailing count. */
  badge?: string | number
  /** Rows opened beside this one on hover or ArrowRight; the row then opens them instead of picking. */
  submenu?: MenuEntry[]
  /** A caption between rows rather than a row: not focusable, never picked. */
  heading?: boolean
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
const SUBMENU_WIDTH = 260

/** The enabled buttons of one menu list, not those of the submenus nested in it. */
function ownButtons(list: Element | null): HTMLButtonElement[] {
  if (!list) return []
  return [...list.children].flatMap((li) => {
    const button = [...li.children].find((child): child is HTMLButtonElement => child instanceof HTMLButtonElement)
    return button && !button.disabled ? [button] : []
  })
}

type ListProps = {
  items: MenuEntry[]
  label: string
  depth: number
  /** The index of the row whose submenu is open at each depth. */
  open: readonly number[]
  setOpen(update: (open: readonly number[]) => readonly number[]): void
  onClose(): void
  /** Which side a submenu opens on. */
  flip: boolean
  style?: { left: number; top: number }
  listRef?: Ref<HTMLUListElement>
}

function MenuList({ items, label, depth, open, setOpen, onClose, flip, style, listRef }: ListProps) {
  return (
    <ul
      ref={listRef}
      className={depth === 0 ? 'menu menu-context' : `menu menu-submenu${flip ? ' menu-flip' : ''}`}
      role="menu"
      aria-label={label}
      data-depth={depth}
      style={style}
    >
      {items.map((item, index) => {
        const key = `${index}:${item.label}`
        if (item.heading) {
          return (
            <li key={key} role="presentation" className={`menu-heading${item.separatorBefore ? ' menu-separated' : ''}`}>
              {item.label}
            </li>
          )
        }
        const opened = item.submenu !== undefined && open[depth] === index
        const classes = [item.separatorBefore ? 'menu-separated' : '', item.submenu ? 'menu-has-submenu' : ''].filter(Boolean).join(' ')
        return (
          <li
            key={key}
            role="none"
            title={item.title}
            className={classes === '' ? undefined : classes}
            onMouseEnter={() => setOpen((prev) => [...prev.slice(0, depth), ...(item.submenu && !item.disabled ? [index] : [])])}
          >
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              data-current={item.current ? '' : undefined}
              data-menu-at={`${depth}:${index}`}
              aria-haspopup={item.submenu ? 'menu' : undefined}
              aria-expanded={item.submenu ? opened : undefined}
              onClick={() => {
                if (item.submenu) return setOpen((prev) => [...prev.slice(0, depth), index])
                onClose()
                item.onSelect?.()
              }}
            >
              {item.icon !== undefined && <span className="menu-icon">{item.icon}</span>}
              <span className="menu-text">
                <span className="menu-label">{item.label}</span>
                {item.detail !== undefined && <span className="menu-detail">{item.detail}</span>}
              </span>
              {item.badge !== undefined && <span className="menu-badge">{item.badge}</span>}
            </button>
            {opened && (
              <MenuList items={item.submenu!} label={item.label} depth={depth + 1} open={open} setOpen={setOpen} onClose={onClose} flip={flip} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A menu opened at a screen position; Escape, a click outside or picking a row closes it. A row
 * with a `submenu` opens it on hover or ArrowRight, ArrowLeft returns to the row, and Escape
 * closes the innermost open submenu before the menu itself.
 */
export function PopupMenu({ x, y, label, items, onClose }: Props) {
  const root = useRef<HTMLUListElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [open, setOpen] = useState<readonly number[]>([])
  const openRef = useRef(open)
  openRef.current = open
  const afterRender = useRef<(() => void) | null>(null)

  useEffect(() => {
    afterRender.current?.()
    afterRender.current = null
  })

  useEffect(() => {
    ownButtons(root.current)[0]?.focus()
    const find = (selector: string) => root.current?.querySelector<HTMLElement>(selector) ?? null
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close.current()
    }
    const onKey = (event: KeyboardEvent) => {
      const depth = openRef.current.length
      if (event.key === 'Escape') {
        if (depth === 0) return close.current()
        const at = `${depth - 1}:${openRef.current[depth - 1]}`
        afterRender.current = () => find(`[data-menu-at="${at}"]`)?.focus()
        return setOpen((prev) => prev.slice(0, -1))
      }
      const active = document.activeElement
      const list = active instanceof Element ? active.closest('ul[role="menu"]') : null
      const level = Number(list?.getAttribute('data-depth') ?? 0)
      const here = list && root.current?.contains(list) ? list : root.current

      if (event.key === 'ArrowRight') {
        if (!(active instanceof HTMLButtonElement) || active.getAttribute('aria-haspopup') !== 'menu') return
        const target = Number(active.getAttribute('data-menu-at')?.split(':')[1])
        event.preventDefault()
        afterRender.current = () => ownButtons(find(`ul[data-depth="${level + 1}"]`))[0]?.focus()
        return setOpen((prev) => [...prev.slice(0, level), target])
      }
      if (event.key === 'ArrowLeft') {
        if (level === 0) return
        event.preventDefault()
        const at = `${level - 1}:${openRef.current[level - 1]}`
        afterRender.current = () => find(`[data-menu-at="${at}"]`)?.focus()
        return setOpen((prev) => prev.slice(0, level - 1))
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const buttons = ownButtons(here)
      if (buttons.length === 0) return
      event.preventDefault()
      const at = buttons.indexOf(active as HTMLButtonElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(at + step + buttons.length) % buttons.length]!.focus()
      setOpen((prev) => prev.slice(0, level))
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH))
  const flip = left + MENU_WIDTH + SUBMENU_WIDTH > window.innerWidth
  return <MenuList items={items} label={label} depth={0} open={open} setOpen={setOpen} onClose={onClose} flip={flip} style={{ left, top: y }} listRef={root} />
}
