import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, RefObject } from 'react'
import type { ContextMenuItem, ContextMenuProps, PopoverProps } from './contracts'
import { Badge } from './primitives'
import { classNames } from './shared'

function ownButtons(list: Element | null): HTMLButtonElement[] {
  if (!list) return []
  return [...list.children].flatMap((item) => {
    const button = [...item.children].find((child): child is HTMLButtonElement => child instanceof HTMLButtonElement)
    return button && !button.disabled ? [button] : []
  })
}

function placeFloating(node: HTMLElement, x: number, y: number): void {
  const box = node.getBoundingClientRect()
  node.style.left = `${Math.max(0, Math.min(x, window.innerWidth - box.width))}px`
  node.style.top = `${Math.max(0, Math.min(y, window.innerHeight - box.height))}px`
}

type MenuListProps = {
  items: ContextMenuItem[]
  label: string
  depth: number
  open: readonly number[]
  setOpen(update: (value: readonly number[]) => readonly number[]): void
  onClose(): void
  x?: number
  y?: number
  rootRef?: RefObject<HTMLUListElement | null>
}

function ContextMenuList({ items, label, depth, open, setOpen, onClose, x = 0, y = 0, rootRef }: MenuListProps) {
  const ownRef = useRef<HTMLUListElement>(null)
  const ref = rootRef ?? ownRef
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const position = () => {
      const parent = depth > 0 ? node.parentElement?.getBoundingClientRect() : undefined
      const width = node.getBoundingClientRect().width
      const left = parent ? (parent.right + width <= window.innerWidth ? parent.right : parent.left - width) : x
      placeFloating(node, left, parent?.top ?? y)
    }
    position()
    window.addEventListener('resize', position)
    return () => window.removeEventListener('resize', position)
  }, [depth, x, y, ref])
  return <ul ref={ref} role="menu" aria-label={label} data-depth={depth} className="ui-menu__list ui-context-menu">
    {items.map((item, index) => {
      const key = `${index}:${item.label}`
      if (item.heading) return <li key={key} role="presentation" className={classNames('ui-context-menu__heading', item.separatorBefore && 'ui-context-menu__separated')}>{item.label}</li>
      const opened = item.submenu !== undefined && open[depth] === index
      return <li key={key} role="none" title={item.title} className={item.separatorBefore ? 'ui-context-menu__separated' : undefined}
        onMouseEnter={() => setOpen((previous) => [...previous.slice(0, depth), ...(item.submenu && !item.disabled ? [index] : [])])}>
        <button type="button" role="menuitem" disabled={item.disabled} aria-disabled={item.disabled || undefined} title={item.title}
          className={classNames('ui-menu__item', 'ui-context-menu__item', item.destructive && 'ui-menu__item--destructive')}
          data-current={item.current ? '' : undefined} data-menu-at={`${depth}:${index}`}
          aria-haspopup={item.submenu ? 'menu' : undefined} aria-expanded={item.submenu ? opened : undefined}
          onClick={() => {
            if (item.submenu) { setOpen((previous) => [...previous.slice(0, depth), index]); return }
            onClose()
            item.onSelect?.()
          }}>
          {item.icon !== undefined && <span aria-hidden="true">{item.icon}</span>}
          <span className="ui-context-menu__text"><span>{item.label}</span>{item.detail !== undefined && <span className="ui-help-text ui-text-muted">{item.detail}</span>}</span>
          {item.current && <span aria-label="Current">✓</span>}
          {item.badge !== undefined && <Badge>{item.badge}</Badge>}
          {item.submenu && <span aria-hidden="true">›</span>}
        </button>
        {opened && <ContextMenuList items={item.submenu!} label={item.label} depth={depth + 1} open={open} setOpen={setOpen} onClose={onClose} />}
      </li>
    })}
  </ul>
}

/** Controlled menu variant for a pointer position; same rows/actions as a triggered Menu. */
export function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const root = useRef<HTMLUListElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [open, setOpen] = useState<readonly number[]>([])
  const openRef = useRef(open)
  openRef.current = open
  const afterRender = useRef<(() => void) | null>(null)
  useLayoutEffect(() => { afterRender.current?.(); afterRender.current = null })
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ownButtons(root.current)[0]?.focus()
    const find = (selector: string) => root.current?.querySelector<HTMLElement>(selector) ?? null
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close.current()
    }
    const keydown = (event: KeyboardEvent) => {
      const active = document.activeElement
      const list = active instanceof Element ? active.closest('ul[role="menu"]') : null
      const level = Number(list?.getAttribute('data-depth') ?? 0)
      const here = list && root.current?.contains(list) ? list : root.current
      const closeLevel = (depth: number) => {
        const at = `${depth - 1}:${openRef.current[depth - 1]}`
        afterRender.current = () => find(`[data-menu-at="${at}"]`)?.focus()
        setOpen((value) => value.slice(0, depth - 1))
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        const depth = openRef.current.length
        if (depth === 0) close.current()
        else closeLevel(depth)
      } else if (event.key === 'ArrowRight') {
        if (!(active instanceof HTMLButtonElement) || active.getAttribute('aria-haspopup') !== 'menu') return
        event.preventDefault()
        const index = Number(active.getAttribute('data-menu-at')?.split(':')[1])
        afterRender.current = () => ownButtons(find(`ul[data-depth="${level + 1}"]`))[0]?.focus()
        setOpen((value) => [...value.slice(0, level), index])
      } else if (event.key === 'ArrowLeft' && level > 0) {
        event.preventDefault()
        closeLevel(level)
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const buttons = ownButtons(here)
        if (buttons.length === 0) return
        event.preventDefault()
        const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
        setOpen((value) => value.slice(0, level))
      } else if (event.key === 'Tab') close.current()
    }
    window.addEventListener('mousedown', outside, true)
    window.addEventListener('keydown', keydown, true)
    return () => {
      window.removeEventListener('mousedown', outside, true)
      window.removeEventListener('keydown', keydown, true)
      if (root.current?.contains(document.activeElement) || document.activeElement === document.body) previous?.focus()
    }
  }, [])
  return createPortal(<ContextMenuList items={items} label={label} depth={0} open={open} setOpen={setOpen} onClose={onClose} x={x} y={y} rootRef={root} />, document.body)
}

/** Nonmodal shared dialog variant anchored to a control, with no focus trap or backdrop. */
export function Popover({ open, label, anchor, onClose, children }: PopoverProps) {
  const root = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const node = root.current
      const target = anchor.current
      if (!node || !target) return
      const box = target.getBoundingClientRect()
      const size = node.getBoundingClientRect()
      setPosition({
        left: Math.max(0, Math.min(box.left, window.innerWidth - size.width)),
        top: Math.max(0, Math.min(box.bottom, window.innerHeight - size.height)),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open, anchor, children])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !root.current?.contains(event.target)) close.current()
    }
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close.current() } }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown, true) }
  }, [open, anchor])
  return open ? createPortal(<div ref={root} className="ui-popover ui-stack" role="dialog" aria-label={label} style={position}>{children}</div>, document.body) : null
}
