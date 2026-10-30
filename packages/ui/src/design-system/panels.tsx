import { cloneElement, Fragment, isValidElement, Children, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EmptyStateProps, FormRowProps, InlineAgentCardProps, ToolPanelActionsProps, ToolPanelFrameProps, ToolPanelTabsProps, ToolPanelToolsProps } from './contracts'
import { classNames } from './shared'
import { Button, IconButton, StatusDot } from './primitives'
import { ControlIcon } from './tool-icons'

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

/**
 * A tool panel's header, left tool rail and body. A plugin's frame mounted inside the host's frame
 * for the same panel draws only its body and moves its tabs, tools and actions into the host frame,
 * so the panel has one header.
 */
export function ToolPanelFrame({ title, tabs, tools, actions, onMinimize, children }: ToolPanelFrameProps) {
  const titleId = useId()
  const section = useRef<HTMLElement>(null)
  const [nested, setNested] = useState(false)

  useLayoutEffect(() => {
    if (section.current?.parentElement?.closest('[data-ui-tool-panel-frame]')) setNested(true)
  }, [])

  if (nested) {
    return (
      <>
        {tabs !== undefined && <ToolPanelTabs>{tabs}</ToolPanelTabs>}
        {tools !== undefined && <ToolPanelTools>{tools}</ToolPanelTools>}
        {actions !== undefined && <ToolPanelActions>{actions}</ToolPanelActions>}
        {children}
      </>
    )
  }
  return (
    <section ref={section} className="ui-tool-panel-frame" data-ui-tool-panel-frame="" aria-labelledby={titleId}>
      <header className="ui-tool-panel-frame__header">
        <h2 className="ui-tool-panel-frame__title" id={titleId}>{title}</h2>
        <div className="ui-tool-panel-frame__tabs" data-ui-tool-panel-tabs-target="" />
        <div className="ui-tool-panel-frame__actions">
          {actions}
          <span data-ui-tool-panel-action-target="" style={{ display: 'contents' }} />
          {onMinimize && <IconButton label={`Minimize ${title}`} onClick={onMinimize}><ControlIcon name="minus" /></IconButton>}
        </div>
      </header>
      <div className="ui-tool-panel-frame__rail" data-ui-tool-panel-rail-target="" />
      <div className="ui-tool-panel-frame__body">{children}</div>
      {tabs !== undefined && <ToolPanelTabs>{tabs}</ToolPanelTabs>}
      {tools !== undefined && <ToolPanelTools>{tools}</ToolPanelTools>}
    </section>
  )
}

function useFrameTarget(selector: string) {
  const marker = useRef<HTMLSpanElement>(null)
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const frame = marker.current?.closest<HTMLElement>('[data-ui-tool-panel-frame]')
    setTarget(frame?.querySelector<HTMLElement>(selector) ?? null)
  }, [selector])

  return { marker, target }
}

export function ToolPanelActions({ children }: ToolPanelActionsProps) {
  const { marker, target } = useFrameTarget(
    ':scope > .ui-tool-panel-frame__header > .ui-tool-panel-frame__actions > [data-ui-tool-panel-action-target]'
  )
  return (
    <>
      <span ref={marker} hidden data-ui-tool-panel-actions-marker="" />
      {target && createPortal(children, target)}
    </>
  )
}

export function ToolPanelTools({ children }: ToolPanelToolsProps) {
  const { marker, target } = useFrameTarget(':scope > [data-ui-tool-panel-rail-target]')
  return (
    <>
      <span ref={marker} hidden data-ui-tool-panel-tools-marker="" />
      {target && createPortal(children, target)}
    </>
  )
}

export function ToolPanelTabs({ children }: ToolPanelTabsProps) {
  const { marker, target } = useFrameTarget(':scope > .ui-tool-panel-frame__header > [data-ui-tool-panel-tabs-target]')
  return (
    <>
      <span ref={marker} hidden data-ui-tool-panel-tabs-marker="" />
      {target && createPortal(children, target)}
    </>
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
