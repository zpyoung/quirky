import type { InlineErrorProps } from './contracts'
import { ControlIcon } from './tool-icons'
import { IconButton } from './primitives'

/** A one-line alert with optional action and dismiss controls. */
export function InlineError({ message, action, onDismiss }: InlineErrorProps) {
  return (
    <div role="alert" className="ui-inline-error">
      <span className="ui-inline-error__message">{message}</span>
      {action && (
        <button type="button" className="ui-inline-error__action" onClick={action.onAction}>{action.label}</button>
      )}
      {onDismiss && (
        <IconButton label="Dismiss" className="ui-inline-error__dismiss" onClick={onDismiss}>
          <ControlIcon name="x" />
        </IconButton>
      )}
    </div>
  )
}
