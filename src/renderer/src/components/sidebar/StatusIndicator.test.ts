import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import StatusIndicator, { type Status } from './StatusIndicator'

vi.mock('@/components/StateIndicatorTooltip', async () => {
  const { createElement } = await import('react')
  return {
    StateIndicatorTooltip: ({
      label,
      children
    }: {
      label: string | null
      children: React.ReactElement
    }) =>
      label === null
        ? children
        : createElement('span', { 'data-state-indicator-tooltip': label }, children)
  }
})

function renderMarkup(status: Status): string {
  return renderToStaticMarkup(React.createElement(StatusIndicator, { status }))
}

function renderDotClassNames(status: Status): string[] {
  const markup = renderMarkup(status)
  const dotClassName = markup.match(/<span class="([^"]*rounded-full[^"]*)"/)?.[1]

  expect(dotClassName).toBeDefined()

  return dotClassName!.split(/\s+/)
}

describe('StatusIndicator', () => {
  it('renders working as the pulsing blue dot', () => {
    const markup = renderMarkup('working')

    // The spinner's own classes and animation contract belong to AgentWorkingSpinner.test.tsx;
    // this pins only that 'working' reaches for it.
    expect(markup).toContain('data-agent-spinner')
  })

  it('renders monitoring as a static heartbeat glyph', () => {
    const markup = renderMarkup('monitoring')

    expect(markup).toContain('data-state-indicator-tooltip="Monitoring background tasks"')
    expect(markup).not.toContain(' title=')
    expect(markup).toContain('lucide-activity')
    expect(markup).toContain('text-agent-working')
    expect(markup).not.toContain('data-agent-spinner')
  })

  it('renders permission as the shared question glyph', () => {
    const markup = renderMarkup('permission')

    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-agent-question')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('data-agent-spinner')
  })

  it('renders active as full green dot', () => {
    const classNames = renderDotClassNames('active')

    expect(classNames).toContain('bg-agent-done')
  })

  it('renders done as a green dot', () => {
    const classNames = renderDotClassNames('done')

    expect(classNames).toContain('bg-agent-done')
    expect(classNames).not.toContain('bg-emerald-500')
  })

  it('renders inactive as the quiet muted dot', () => {
    const classNames = renderDotClassNames('inactive')

    expect(classNames).toContain('bg-muted-foreground/40')
    expect(classNames).not.toContain('bg-neutral-500/40')
  })

  it("renders a user's Stop muted, distinct from done and from a failure", () => {
    const classNames = renderDotClassNames('interrupted')

    expect(classNames).toContain('bg-muted-foreground')
    expect(classNames).not.toContain('bg-agent-done')
    expect(classNames).not.toContain('bg-agent-failed')
  })

  it('renders failed as a red dot', () => {
    expect(renderDotClassNames('failed')).toContain('bg-agent-failed')
  })

  it.each([
    ['working', 'Working'],
    ['monitoring', 'Monitoring background tasks'],
    ['permission', 'Needs permission'],
    ['interrupted', 'Interrupted'],
    ['done', 'Done']
  ] as const)('labels the agent-derived %s workspace state', (status, label) => {
    const markup = renderMarkup(status)

    expect(markup).toContain(`data-state-indicator-tooltip="${label}"`)
    expect(markup).not.toContain(' title=')
  })

  it.each(['active', 'inactive'] as const)(
    'does not label the passive %s workspace state',
    (status) => {
      const markup = renderMarkup(status)

      expect(markup).not.toContain('data-state-indicator-tooltip')
      expect(markup).not.toContain(' title=')
    }
  )

  it('lets an enclosing action own the tooltip', () => {
    const markup = renderToStaticMarkup(
      React.createElement(StatusIndicator, { status: 'working', showTooltip: false })
    )

    expect(markup).not.toContain('data-state-indicator-tooltip')
    expect(markup).toContain('data-agent-spinner')
  })
})
