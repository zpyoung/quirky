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

/** Asks the user to confirm; resolves false on cancel. Falls back to `window.confirm` before the host mounts. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (present) present({ ...options, resolve })
    else resolve(window.confirm(options.message))
  })
}

export function ConfirmHost() {
  const [request, setRequest] = useState<Request | null>(null)

  useEffect(() => {
    present = setRequest
    return () => {
      present = null
    }
  }, [])

  if (!request) return null
  const finish = (ok: boolean) => {
    request.resolve(ok)
    setRequest(null)
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
