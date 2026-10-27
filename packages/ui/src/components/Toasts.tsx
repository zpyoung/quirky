import type { ToastAction } from '@quirky/protocol'
import { useEffect, useMemo, useRef } from 'react'
import { useAppState, useConnection, usePluginHost } from '../context'
import type { Toast } from '../lib/state'
import type { WindowPluginHost } from '../plugins/host'
import type { Store } from '../store'

const TOAST_MS = 6000

/** What a toast needs to dismiss itself and run its commands. */
export type ToastRuntime = {
  store: Pick<Store, 'getState' | 'dispatch'>
  plugins: Pick<WindowPluginHost, 'runCommandForResult'>
}

async function attempt(runtime: ToastRuntime, command: string, args: unknown): Promise<boolean> {
  try {
    await runtime.plugins.runCommandForResult(command, args)
    return true
  } catch (error) {
    const body = error instanceof Error ? error.message : String(error)
    runtime.store.dispatch({ type: 'toast', toast: { kind: 'error', title: `${command} failed: ${body}`, body } })
    return false
  }
}

/**
 * Removes toast `id` and runs its `onDismiss` command. A toast that is already gone does nothing,
 * so `onDismiss` runs at most once however many routes dismiss it.
 */
export function dismissToast(runtime: ToastRuntime, id: number): void {
  const toast = runtime.store.getState().toasts.find((candidate) => candidate.id === id)
  if (!toast) return
  runtime.store.dispatch({ type: 'dismissToast', id })
  if (toast.onDismiss) void attempt(runtime, toast.onDismiss.command, toast.onDismiss.args)
}

/** Dismisses the toast with `key` like its close button does; nothing happens when none has it. */
export function dismissToastByKey(runtime: ToastRuntime, key: string): void {
  const toast = runtime.store.getState().toasts.find((candidate) => candidate.key === key)
  if (toast) dismissToast(runtime, toast.id)
}

/**
 * Runs an action's command. The toast goes away without running its `onDismiss` unless the action
 * keeps it open; a failing command shows an error toast and leaves the toast showing.
 */
export async function pressToastAction(runtime: ToastRuntime, toast: Toast, action: ToastAction): Promise<void> {
  if (!(await attempt(runtime, action.command, action.args))) return
  if (!action.keepOpen) runtime.store.dispatch({ type: 'dismissToast', id: toast.id })
}

function ToastItem({ toast }: { toast: Toast }) {
  const connection = useConnection()
  const host = usePluginHost()
  const runtime = useMemo<ToastRuntime>(() => ({ store: connection.store, plugins: host }), [connection, host])
  const pressing = useRef(false)

  useEffect(() => {
    if (toast.persistent) return
    const timer = setTimeout(() => dismissToast(runtime, toast.id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [runtime, toast.id, toast.persistent])

  const open = () => {
    if (toast.open) host.openView(toast.open.view, toast.open.input)
    else if (toast.persistent) return
    dismissToast(runtime, toast.id)
  }

  const press = (action: ToastAction) => {
    if (pressing.current) return
    pressing.current = true
    void pressToastAction(runtime, toast, action).finally(() => {
      pressing.current = false
    })
  }

  return (
    <div className={`toast toast-${toast.kind}`} role="status" onClick={open}>
      <div className="toast-title">{toast.title}</div>
      <div className="toast-body">{toast.body}</div>
      {toast.detail !== undefined && <div className="toast-detail">{toast.detail}</div>}
      {toast.actions !== undefined && toast.actions.length > 0 && (
        <div className="toast-actions">
          {toast.actions.map((action, index) => (
            <button
              key={index}
              onClick={(event) => {
                event.stopPropagation()
                press(action)
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <button
        className="icon-button"
        aria-label="Dismiss"
        onClick={(event) => {
          event.stopPropagation()
          dismissToast(runtime, toast.id)
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
