import { useId } from 'react'
import type { CSSProperties } from 'react'
import type { BadgeProps, ButtonProps, IconButtonProps, StatusDotProps, TextFieldProps, UiStatus } from './contracts'
import { classNames } from './shared'

const statusClasses: Record<UiStatus, string> = {
  working: 'ui-status-dot--working',
  'needs-you': 'ui-status-dot--needs-you',
  failing: 'ui-status-dot--failing',
  done: 'ui-status-dot--done',
  idle: 'ui-status-dot--idle',
  queued: 'ui-status-dot--queued',
}

export function Button({ variant = 'secondary', type = 'button', className, ...props }: ButtonProps) {
  return <button {...props} type={type} className={classNames('ui-button', `ui-button--${variant}`, className)} />
}

export function IconButton({ label, children, variant = 'secondary', type = 'button', className, ...props }: IconButtonProps) {
  return (
    <button
      {...props}
      aria-label={label}
      type={type}
      className={classNames('ui-button', `ui-button--${variant}`, 'ui-icon-button', className)}
    >
      <span className="ui-icon-button__icon">{children}</span>
    </button>
  )
}

export function TextField({ label, help, error, id: providedId, className, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: TextFieldProps) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  const descriptions = [describedBy, help ? `${id}-help` : undefined, error ? `${id}-error` : undefined].filter(Boolean).join(' ')

  return (
    <div className="ui-text-field">
      <label className="ui-text-field__label" htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        className={classNames('ui-text-field__input', className)}
        aria-describedby={descriptions || undefined}
        aria-invalid={error ? true : invalid}
      />
      {help && <span className="ui-help-text" id={`${id}-help`}>{help}</span>}
      {error && <span className="ui-error-text" id={`${id}-error`} role="alert">{error}</span>}
    </div>
  )
}

export function Badge({ children, tone = 'neutral', label }: BadgeProps) {
  return (
    <span className={classNames('ui-badge', tone !== 'neutral' && `ui-badge--${tone}`)} role={label ? 'img' : undefined} aria-label={label}>
      {children}
    </span>
  )
}

export function StatusDot({ status, label, progress }: StatusDotProps) {
  const percent = progress !== undefined && Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : undefined
  return (
    <span
      className={classNames('ui-status-dot', statusClasses[status], percent !== undefined && 'ui-status-dot--progress')}
      style={percent !== undefined ? { '--ui-dot-progress': `${percent}%` } as CSSProperties : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
