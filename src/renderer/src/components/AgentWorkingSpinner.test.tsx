// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentWorkingSpinner } from './AgentWorkingSpinner'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('AgentWorkingSpinner', () => {
  it('renders the blue dot driven by the CSS pulse, not a JS clock', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentWorkingSpinner))

    expect(markup).toContain('data-agent-spinner')
    expect(markup).toContain('agent-working-pulse')
    expect(markup).toContain('bg-agent-working')
    expect(markup).toContain('rounded-full')
    expect(markup).toContain('size-2')
    expect(markup).not.toContain('agent-working-spinner')
    expect(markup).not.toContain('border-t-transparent')
  })

  it('lets callers resize the dot through className', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentWorkingSpinner, { className: 'size-1.5' })
    )

    expect(markup).toContain('size-1.5')
    expect(markup).not.toContain('size-2')
  })

  it('mounts without touching the Web Animations API', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<AgentWorkingSpinner />)
      })
      expect(container.querySelector('[data-agent-spinner]')).not.toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
