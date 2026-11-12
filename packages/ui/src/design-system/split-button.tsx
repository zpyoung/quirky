import { useRef, useState } from 'react'
import type { SplitButtonProps } from './contracts'
import { ContextMenu } from './context-menu'
import type { ContextMenuItem } from './context-menu-contracts'
import { ControlIcon } from './tool-icons'
import { Button, IconButton } from './primitives'

/**
 * A primary action with a caret menu. The caller may own that menu's lifecycle with `onOpenMenu`.
 * Items marked `enabled: false` stay visible with their `detail` reason. Internal menu choices
 * and Escape close the menu and return focus to the caret.
 */
export function SplitButton({ label, onClick, disabled, busy, title, menuLabel, items, onChoose, onOpenMenu, menuOpen }: SplitButtonProps) {
  const caret = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  const open = () => {
    if (busy) return
    const rect = caret.current?.getBoundingClientRect()
    if (!rect) return
    const position = { x: rect.right, y: rect.bottom }
    if (onOpenMenu) onOpenMenu(position)
    else setAnchor(position)
  }
  const withChoose = (list: ContextMenuItem[]): ContextMenuItem[] =>
    list.map((item) => {
      if (item.submenu) return { ...item, submenu: withChoose(item.submenu) }
      if (item.id === undefined || onChoose === undefined) return item
      return {
        ...item,
        onSelect: () => {
          caret.current?.focus()
          onChoose(item.id!)
        },
      }
    })
  const menuItems = items && !onOpenMenu ? withChoose(items) : []

  return (
    <span className="ui-split-button">
      <Button
        variant="primary"
        className="ui-split-button__primary"
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        title={title}
        onClick={onClick}
      >
        {label}
      </Button>
      <IconButton
        ref={caret}
        variant="primary"
        label={menuLabel}
        className="ui-split-button__caret"
        aria-haspopup="menu"
        aria-expanded={onOpenMenu ? menuOpen === true : anchor !== null}
        disabled={busy}
        onClick={open}
      >
        <ControlIcon name="caret-down" />
      </IconButton>
      {!onOpenMenu && anchor && (
        <ContextMenu
          items={menuItems}
          label={menuLabel}
          x={anchor.x}
          y={anchor.y}
          align="end"
          returnFocusTo={caret.current ?? undefined}
          onClose={() => setAnchor(null)}
        />
      )}
    </span>
  )
}
