import { useLayoutEffect, useRef, type ReactNode } from 'react'

type Props = { title: string; onClose: () => void; children: ReactNode; wide?: boolean }

/** Open dialogs, oldest first; Escape closes only the last so a dialog stacked on another leaves it open. */
const open: symbol[] = []

/** A modal dialog over the window; a click on the backdrop or Escape closes it. */
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

type ConfirmProps = {
  title: string
  body: string
  confirm: string
  /** Styles the confirm button as destructive. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** A question with Cancel and a confirm button that has focus, so Enter confirms. */
export function ConfirmDialog({ title, body, confirm, danger, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Dialog title={title} onClose={onCancel}>
      {body !== '' && <p className="dialog-message">{body}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={danger ? 'danger' : 'primary'} autoFocus onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </Dialog>
  )
}
