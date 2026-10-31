import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DialogProps, ToastProps, UiStatus } from './contracts'
import { classNames } from './shared'
import { Button, StatusDot } from './primitives'

function isUrgent(status: UiStatus): boolean {
  return status === 'needs-you' || status === 'failing'
}

export function Toast({ title, description, status = 'idle', action, onDismiss, durationMs = 8000 }: ToastProps) {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return
    const timeout = setTimeout(() => dismissRef.current(), durationMs)
    return () => clearTimeout(timeout)
  }, [durationMs])

  const invokeAction = () => {
    if (!action || action.disabled) return
    action.onAction()
    onDismiss()
  }

  return (
    <div className={classNames('ui-toast', status === 'needs-you' && 'ui-toast--needs-you', status === 'failing' && 'ui-toast--failing')} role={isUrgent(status) ? 'alert' : 'status'} aria-live={isUrgent(status) ? 'assertive' : 'polite'} aria-atomic="true">
      <span className="ui-toast__status"><StatusDot status={status} label={`Status: ${status}`} /></span>
      <div className="ui-toast__content">
        <div className="ui-toast__title">{title}</div>
        {description !== undefined && <div className="ui-toast__description">{description}</div>}
      </div>
      <div className="ui-toast__actions">
        {action && <Button className="ui-toast__action" variant="primary" disabled={action.disabled} onClick={invokeAction}>{action.label}</Button>}
        <button type="button" className="ui-toast__dismiss" aria-label="Dismiss notification" onClick={onDismiss}>×</button>
      </div>
    </div>
  )
}

const focusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Only the top open dialog owns focus; project/trust dialogs may be siblings. */
// host and plugin bundles need the same per-document isolation state
const DIALOG_STATE = Symbol.for('quirky.ui.dialogState')
type DialogState = {
  stack: HTMLElement[]
  inertStates: Map<HTMLElement, boolean>
}

function getDialogState(ownerDocument: Document): DialogState {
  const slot = ownerDocument as unknown as { [DIALOG_STATE]?: DialogState }
  return slot[DIALOG_STATE] ??= { stack: [], inertStates: new Map() }
}

function syncDialogIsolation(ownerDocument: Document, state: DialogState) {
  const activeDialog = state.stack[state.stack.length - 1]
  let branch = activeDialog?.parentElement ?? null
  const inertSiblings = new Set<HTMLElement>()

  while (branch) {
    const parent = branch.parentElement
    if (!parent) break
    for (const sibling of parent.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) inertSiblings.add(sibling)
    }
    if (parent === ownerDocument.body) break
    branch = parent
  }

  for (const [element, wasInert] of state.inertStates) {
    if (inertSiblings.has(element)) continue
    if (wasInert) element.setAttribute('inert', '')
    else element.removeAttribute('inert')
    state.inertStates.delete(element)
  }
  for (const element of inertSiblings) {
    if (!state.inertStates.has(element)) state.inertStates.set(element, element.hasAttribute('inert'))
    element.setAttribute('inert', '')
  }
}

export function Dialog({ open, title, children, actions, onClose, variant = 'dialog', placement = 'center', size = 'default', closeOnBackdrop = true, scrollBody = false }: DialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const element = dialogRef.current
    if (!element) return
    const ownerDocument = element.ownerDocument
    const state = getDialogState(ownerDocument)
    state.stack.push(element)
    const opener = ownerDocument.activeElement instanceof HTMLElement ? ownerDocument.activeElement : null
    syncDialogIsolation(ownerDocument, state)
    if (!element.contains(ownerDocument.activeElement)) {
      const firstFocusable = element.querySelector<HTMLElement>(focusableSelector)
      ;(firstFocusable ?? element).focus()
    }
    const keepFocusInside = (event: FocusEvent) => {
      if (state.stack[state.stack.length - 1] !== element) return
      if (!(event.target instanceof Node)) return
      const dialog = dialogRef.current
      if (dialog?.contains(event.target)) return
      ;(dialog?.querySelector<HTMLElement>(focusableSelector) ?? dialog)?.focus()
    }
    ownerDocument.addEventListener('focusin', keepFocusInside)
    return () => {
      ownerDocument.removeEventListener('focusin', keepFocusInside)
      const wasTop = state.stack[state.stack.length - 1] === element
      const index = state.stack.indexOf(element)
      if (index >= 0) state.stack.splice(index, 1)
      syncDialogIsolation(ownerDocument, state)
      if (wasTop && opener?.isConnected) opener.focus()
      const parent = state.stack[state.stack.length - 1]
      if (parent && !parent.contains(ownerDocument.activeElement)) {
        ;(parent.querySelector<HTMLElement>(focusableSelector) ?? parent).focus()
      }
    }
  }, [open])

  if (!open) return null

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const dialog = event.currentTarget
    const state = getDialogState(dialog.ownerDocument)
    if (state.stack[state.stack.length - 1] !== dialog) return
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      onClose?.()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true')
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (dialog.ownerDocument.activeElement === first || !dialog.contains(dialog.ownerDocument.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (dialog.ownerDocument.activeElement === last || !dialog.contains(dialog.ownerDocument.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className={classNames('ui-dialog-backdrop', variant === 'sheet' && 'ui-dialog-backdrop--sheet', variant === 'dialog' && placement === 'top' && 'ui-dialog-backdrop--top')}
      onClick={(event) => {
        const dialog = dialogRef.current
        if (!closeOnBackdrop || event.target !== event.currentTarget || !dialog) return
        const state = getDialogState(dialog.ownerDocument)
        if (state.stack[state.stack.length - 1] === dialog) onClose?.()
      }}
    >
      <section
        ref={dialogRef}
        className={classNames('ui-dialog', variant === 'sheet' && 'ui-dialog--sheet', size === 'wide' && 'ui-dialog--wide', scrollBody && 'ui-dialog--scroll-body')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <header className="ui-dialog__header">
          <h2 className="ui-dialog__title" id={titleId}>{title}</h2>
          {onClose && <button type="button" className="ui-dialog__close" aria-label="Close dialog" onClick={onClose}>×</button>}
        </header>
        <div className="ui-dialog__body">{children}</div>
        {actions !== undefined && <footer className="ui-dialog__actions">{actions}</footer>}
      </section>
    </div>
  )
}
