import { useEffect, useState } from 'react'
import { Dialog } from './Dialog'

type ConfirmOptions = {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
}

type Request = ConfirmOptions & { resolve: (ok: boolean) => void }

let present: ((request: Request) => void) | null = null

/**
 * Asks the person to confirm; resolves false on cancel. Requests made while a dialog is open wait
 * their turn. Falls back to `window.confirm` before the host mounts.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (present) present({ ...options, resolve })
    else resolve(window.confirm(options.message))
  })
}

/** The shell's side of `UiPluginContext.confirm`. */
export function confirmForPlugin(options: { title: string; body?: string; confirmLabel?: string }): Promise<boolean> {
  return confirmAction({
    title: options.title,
    message: options.body ?? '',
    confirmLabel: options.confirmLabel ?? 'Confirm'
  })
}

export function ConfirmHost() {
  const [queue, setQueue] = useState<Request[]>([])

  useEffect(() => {
    present = (request) => setQueue((current) => [...current, request])
    return () => {
      present = null
    }
  }, [])

  const request = queue[0]
  if (!request) return null
  const finish = (ok: boolean) => {
    request.resolve(ok)
    setQueue((current) => current.slice(1))
  }

  return (
    <Dialog title={request.title} onClose={() => finish(false)}>
      <p className="dialog-message">{request.message}</p>
      <div className="dialog-actions">
        <button onClick={() => finish(false)}>Cancel</button>
        <button
          className={request.danger ? 'danger' : 'primary'}
          autoFocus
          onClick={() => finish(true)}
        >
          {request.confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
