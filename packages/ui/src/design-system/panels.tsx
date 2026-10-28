import { cloneElement, Fragment, isValidElement, Children, useId } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { EmptyStateProps, FormRowProps, InlineAgentCardProps, ToolPanelFrameProps } from './contracts'
import { classNames } from './shared'
import { Button, IconButton, StatusDot } from './primitives'

export function EmptyState({ message, action, icon }: EmptyStateProps) {
  return (
    <section className="ui-empty-state">
      {icon !== undefined && <span className="ui-empty-state__icon">{icon}</span>}
      <p className="ui-empty-state__message">{message}</p>
      {action && <Button className="ui-empty-state__action" variant="secondary" disabled={action.disabled} onClick={action.onAction}>{action.label}</Button>}
    </section>
  )
}

type DescribedControlProps = {
  id?: string
  children?: ReactNode
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'grammar' | 'spelling'
}

function withDescriptions(element: ReactElement<DescribedControlProps>, htmlFor: string, descriptionIds: string, hasError: boolean): ReactElement {
  if (element.type === Fragment) {
    return cloneElement(element, {}, Children.map(element.props.children, (child) => {
      if (!isValidElement<DescribedControlProps>(child)) return child
      return withDescriptions(child, htmlFor, descriptionIds, hasError)
    }))
  }

  if (typeof element.type === 'string' && !['input', 'select', 'textarea', 'button'].includes(element.type)) {
    if (element.props.children === undefined) return element
    return cloneElement(element, {}, Children.map(element.props.children, (child) => {
      if (!isValidElement<DescribedControlProps>(child)) return child
      return withDescriptions(child, htmlFor, descriptionIds, hasError)
    }))
  }

  const existing = element.props['aria-describedby']
  const describedBy = [existing, descriptionIds].filter(Boolean).join(' ')
  return cloneElement(element, {
    id: htmlFor,
    'aria-describedby': describedBy || undefined,
    ...(hasError ? { 'aria-invalid': true } : {}),
  })
}

function associateDescriptions(children: ReactNode, htmlFor: string, descriptionIds: string, hasError: boolean): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<DescribedControlProps>(child)) return child
    return withDescriptions(child, htmlFor, descriptionIds, hasError)
  })
}

export function FormRow({ label, htmlFor, help, error, children }: FormRowProps) {
  const descriptionIds = [help ? `${htmlFor}-help` : undefined, error ? `${htmlFor}-error` : undefined].filter(Boolean).join(' ')
  return (
    <div className="ui-form-row">
      <label className="ui-form-row__label" htmlFor={htmlFor}>{label}</label>
      <div className="ui-form-row__control">{associateDescriptions(children, htmlFor, descriptionIds, Boolean(error))}</div>
      {help && <span className="ui-help-text" id={`${htmlFor}-help`}>{help}</span>}
      {error && <span className="ui-error-text" id={`${htmlFor}-error`} role="alert">{error}</span>}
    </div>
  )
}

export function ToolPanelFrame({ title, actions, onMinimize, children }: ToolPanelFrameProps) {
  const titleId = useId()
  return (
    <section className="ui-tool-panel-frame" aria-labelledby={titleId}>
      <header className="ui-tool-panel-frame__header">
        <h2 className="ui-tool-panel-frame__title" id={titleId}>{title}</h2>
        {(actions !== undefined || onMinimize) && (
          <div className="ui-tool-panel-frame__actions">
            {actions}
            {onMinimize && <IconButton label={`Minimize ${title}`} onClick={onMinimize}>−</IconButton>}
          </div>
        )}
      </header>
      <div className="ui-tool-panel-frame__body">{children}</div>
    </section>
  )
}

export function InlineAgentCard({ title, description, status, action }: InlineAgentCardProps) {
  return (
    <article className={classNames('ui-inline-agent-card', status === 'needs-you' && 'ui-inline-agent-card--needs-you', status === 'failing' && 'ui-inline-agent-card--failing')}>
      <span className="ui-inline-agent-card__status"><StatusDot status={status} label={`Status: ${status}`} /></span>
      <div className="ui-inline-agent-card__content">
        <h3 className="ui-inline-agent-card__title">{title}</h3>
        {description !== undefined && <div className="ui-inline-agent-card__description">{description}</div>}
      </div>
      {action && <Button className="ui-inline-agent-card__action" variant="primary" disabled={action.disabled} onClick={action.onAction}>{action.label}</Button>}
    </article>
  )
}
