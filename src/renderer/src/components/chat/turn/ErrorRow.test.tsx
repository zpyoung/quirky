// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderItemOf } from '../chat-turns'
import { ChatErrorActionsProvider } from './chat-error-actions'
import { ErrorRow } from './ErrorRow'

afterEach(cleanup)

const item: RenderItemOf<'status'> = {
  itemId: 'status-1',
  revision: 1,
  sequence: 1,
  observedAt: 0,
  body: { kind: 'status', text: 'agent exited' }
}

describe('ErrorRow', () => {
  it('shows only the text when no recovery actions are provided', () => {
    render(<ErrorRow item={item} />)
    expect(screen.getByText('agent exited')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('draws Restart and Open in terminal for the handlers present', () => {
    const onRestart = vi.fn()
    const onOpenInTerminal = vi.fn()
    render(
      <ChatErrorActionsProvider actions={{ onRestart, onOpenInTerminal }}>
        <ErrorRow item={item} />
      </ChatErrorActionsProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open in terminal' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onOpenInTerminal).toHaveBeenCalledTimes(1)
  })

  it('omits an action that has no handler', () => {
    render(
      <ChatErrorActionsProvider actions={{ onRestart: vi.fn() }}>
        <ErrorRow item={item} />
      </ChatErrorActionsProvider>
    )
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open in terminal' })).toBeNull()
  })
})
