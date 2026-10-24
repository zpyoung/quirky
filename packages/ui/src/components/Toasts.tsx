import { useEffect } from 'react'
import { useAppState, useDispatch } from '../context'
import type { Toast } from '../lib/state'

const TOAST_MS = 6000

function ToastItem({ toast }: { toast: Toast }) {
  const state = useAppState()
  const dispatch = useDispatch()

  useEffect(() => {
    const timer = setTimeout(() => dispatch({ type: 'dismissToast', id: toast.id }), TOAST_MS)
    return () => clearTimeout(timer)
  }, [dispatch, toast.id])

  const open = () => {
    if (toast.sessionId && state.sessions.some((s) => s.id === toast.sessionId)) {
      dispatch({ type: 'selectSession', id: toast.sessionId })
    } else if (toast.worktreeId) {
      dispatch({ type: 'selectWorktree', id: toast.worktreeId })
    }
    dispatch({ type: 'dismissToast', id: toast.id })
  }

  return (
    <div className={`toast toast-${toast.kind}`} role="status" onClick={open}>
      <div className="toast-title">{toast.title}</div>
      <div className="toast-body">{toast.body}</div>
      <button
        className="icon-button"
        aria-label="Dismiss"
        onClick={(event) => {
          event.stopPropagation()
          dispatch({ type: 'dismissToast', id: toast.id })
        }}
      >
        ×
      </button>
    </div>
  )
}

export function Toasts() {
  const { toasts } = useAppState()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
