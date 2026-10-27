import { useEffect, useRef, type CSSProperties } from 'react'

export type PopoverItem = { label: string; run(): void }

type Props = { x: number; y: number; items: PopoverItem[]; onClose(): void }

const style: Record<string, CSSProperties> = {
  menu: {
    position: 'fixed',
    zIndex: 1000,
    minWidth: 180,
    padding: 4,
    borderRadius: 8,
    border: '1px solid var(--border, #3a3d45)',
    background: 'var(--popover, #1e2026)',
    color: 'var(--popover-foreground, #d7dae0)',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.4)',
    fontSize: 12
  },
  item: { display: 'block', width: '100%', padding: '5px 10px', border: 'none', borderRadius: 4, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' }
}

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
    <div ref={menu} role="menu" data-pane-link-popover style={{ ...style.menu, left: x, top: y }}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          style={style.item}
          onClick={() => {
            onClose()
            item.run()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
