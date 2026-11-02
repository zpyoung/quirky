import { useRef, useState } from 'react'
import type { SplitButtonProps } from './contracts'
import { ContextMenu } from './context-menu'
import type { ContextMenuItem } from './context-menu-contracts'
import { ControlIcon } from './tool-icons'
import { Button, IconButton } from './primitives'

/**
 * A primary action with a caret that lists the alternatives. Items the caller marks
 * `enabled: false` stay visible with their `detail` reason. Choosing an item or pressing Escape
 * closes the menu and returns focus to the caret.
 */
export function SplitButton({ label, onClick, disabled, busy, title, menuLabel, items, onChoose }: SplitButtonProps) {
  const caret = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  const open = () => {
    const rect = caret.current?.getBoundingClientRect()
    if (rect) setAnchor({ x: rect.right, y: rect.bottom })
  }
  const withChoose = (list: ContextMenuItem[]): ContextMenuItem[] =>
    list.map((item) => {
      if (item.submenu) return { ...item, submenu: withChoose(item.submenu) }
      if (item.id === undefined) return item
      return {
        ...item,
        onSelect: () => {
          caret.current?.focus()
          onChoose(item.id!)
        },
      }
    })
  const menuItems = withChoose(items)

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
        aria-expanded={anchor !== null}
        disabled={busy}
        onClick={open}
      >
        <ControlIcon name="caret-down" />
      </IconButton>
      {anchor && (
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
