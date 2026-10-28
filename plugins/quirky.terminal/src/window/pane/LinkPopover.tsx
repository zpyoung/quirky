import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { Button } from '@quirky/ui'

export type PopoverItem = { label: string; run(event: ReactMouseEvent<HTMLButtonElement>): void }

type Props = { x: number; y: number; items: PopoverItem[]; onClose(): void }


/** The small action menu a plain click on a link opens at the pointer. */
export function LinkPopover({ x, y, items, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [onClose])

  return (
    <div ref={menu} role="menu" data-pane-link-popover className="tt-pane-link-popover" style={{ left: x, top: y }}>
      {items.map((item) => (
        <Button
          key={item.label}
          role="menuitem"
          className="tt-pane-link-popover__item"
          onClick={(event) => {
            onClose()
            item.run(event)
          }}
        >
          {item.label}
        </Button>
      ))}
    </div>
  )
}
