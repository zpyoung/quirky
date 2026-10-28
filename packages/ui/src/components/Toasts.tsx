import type { ToastAction } from '@quirky/protocol'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Button, Toast, type UiStatus } from '../design-system'
import { useAppState, useConnection, usePluginHost } from '../context'
import { AttentionToasts } from '../shell/ShellChrome'
import type { Toast as ToastState } from '../lib/state'
import type { WindowPluginHost } from '../plugins/host'
import type { Store } from '../store'

const TOAST_MS = 8000

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
export async function pressToastAction(runtime: ToastRuntime, toast: ToastState, action: ToastAction): Promise<void> {
  if (!(await attempt(runtime, action.command, action.args))) return
  if (!action.keepOpen) runtime.store.dispatch({ type: 'dismissToast', id: toast.id })
}

function statusOf(kind: ToastState['kind']): UiStatus {
  switch (kind) {
    case 'success': return 'done'
    case 'warning': return 'needs-you'
    case 'error': return 'failing'
    case 'info': return 'idle'
  }
}

function ToastItem({ toast }: { toast: ToastState }) {
  const connection = useConnection()
  const host = usePluginHost()
  const runtime = useMemo<ToastRuntime>(() => ({ store: connection.store, plugins: host }), [connection, host])
  const pressing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useCallback(() => {
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
  }, [])
  const armTimer = useCallback(() => {
    clearTimer()
    if (toast.persistent) return
    timer.current = setTimeout(() => {
      timer.current = null
      dismissToast(runtime, toast.id)
    }, TOAST_MS)
  }, [clearTimer, runtime, toast.id, toast.persistent])

  useEffect(() => {
    armTimer()
    return clearTimer
  }, [armTimer, clearTimer])

  const open = () => {
    if (toast.open) host.openView(toast.open.view, toast.open.input)
    else if (toast.persistent) return
    dismissToast(runtime, toast.id)
  }

  const press = (action: ToastAction) => {
    if (pressing.current) return
    pressing.current = true
    clearTimer()
    void pressToastAction(runtime, toast, action).finally(() => {
      pressing.current = false
      if (runtime.store.getState().toasts.some((candidate) => candidate.id === toast.id)) armTimer()
    })
  }

  return (
    <div
      className="shell-legacy-toast"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button')) return
        open()
      }}
    >
      <Toast
        title={toast.title}
        description={(
          <div className="shell-legacy-toast__description">
            <span>{toast.body}</span>
            {toast.detail !== undefined && <span>{toast.detail}</span>}
            {toast.actions !== undefined && toast.actions.length > 0 && (
              <div className="shell-legacy-toast__actions">
                {toast.actions.map((action, index) => (
                  <Button
                    key={index}
                    onClick={(event) => {
                      event.stopPropagation()
                      press(action)
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        status={statusOf(toast.kind)}
        durationMs={0}
        onDismiss={() => dismissToast(runtime, toast.id)}
      />
    </div>
  )
}

export function Toasts() {
  const { toasts } = useAppState()
  return (
    <>
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </div>
      <AttentionToasts />
    </>
  )
}
