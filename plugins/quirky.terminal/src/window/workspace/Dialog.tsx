import { useEffect, type ReactNode } from 'react'

type Props = { title: string; onClose: () => void; children: ReactNode }

/** A modal box over the whole window; Escape or a click on the backdrop closes it. */
export function Dialog({ title, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="qt-overlay" onMouseDown={onClose}>
      <div className="qt-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}
