import { useEffect, useRef, type ReactNode } from 'react'

export function PageModal({ title, children, footer, onClose, labelledBy }: {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose(): void
  labelledBy?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const currentPanel = panel.current
      if (!currentPanel) return
      const focusable = currentPanel.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) {
        event.preventDefault()
        currentPanel.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && (document.activeElement === first || !currentPanel.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !currentPanel.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [])

  return (
    <div className="qp-sheet-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeRef.current()
    }}>
      <div className="qp-sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} ref={panel}>
        <header className="qp-sheet__header">
          <h2 id={labelledBy}>{title}</h2>
          <button className="qp-icon-button" type="button" aria-label="Close dialog" onClick={onClose}>×</button>
        </header>
        {children}
        {footer && <footer className="qp-sheet__footer">{footer}</footer>}
      </div>
    </div>
  )
}

export function PageError({ children }: { children: ReactNode }) {
  return <div className="qp-error" role="alert">{children}</div>
}

export function errorMessage(error: unknown, fallback = 'The request could not be completed.'): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const safe = message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240)
  return safe || fallback
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'todo': return 'To do'
    case 'in-progress': return 'In progress'
    case 'in-review': return 'In review'
    case 'done': return 'Done'
    case 'starting': return 'Starting'
    case 'running': return 'Running'
    case 'working': return 'Working'
    case 'waiting': return 'Waiting for input'
    case 'exited': return 'Exited'
    case 'answered': return 'Answered'
    case 'partial': return 'Partially answered'
    case 'declined': return 'Declined'
    case 'timed_out': return 'Expired'
    default: return status
  }
}
