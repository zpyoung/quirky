import { useRef, useState } from 'react'
import { PopupMenu } from './popup-menu'
import type { StatusBarItemProps } from './contracts'

/**
 * One value in the status bar. Given `items` it opens a popup anchored to itself, closing any other
 * open popup; without them it is static content such as a file type.
 */
export function StatusBarItem({ label, items, popupTitle, children }: StatusBarItemProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (items === undefined) return <span className="ui-status-bar-item ui-status-bar-item--static" title={label}>{children}</span>
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="ui-status-bar-item"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {children}
      </button>
      {open && ref.current && <PopupMenu anchor={ref.current} items={items} title={popupTitle ?? label} onClose={() => setOpen(false)} />}
    </>
  )
}
