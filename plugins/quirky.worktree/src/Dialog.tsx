import { useLayoutEffect, useRef, type ReactNode } from 'react'

type Props = { title: string; onClose: () => void; children: ReactNode; wide?: boolean }

/** Open dialogs, oldest first; Escape closes only the last so a dialog stacked on another leaves it open. */
const open: symbol[] = []

export function Dialog({ title, onClose, children, wide }: Props) {
  const close = useRef(onClose)
  close.current = onClose

  // a layout effect, so a dialog counts as open from the moment it is on screen
  useLayoutEffect(() => {
    const me = Symbol(title)
    open.push(me)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open[open.length - 1] === me) close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      open.splice(open.indexOf(me), 1)
    }
  }, [title])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className={wide ? 'dialog dialog-wide' : 'dialog'}
        role="dialog"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}
