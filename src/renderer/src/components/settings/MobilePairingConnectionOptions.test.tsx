// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobilePairingConnectionOptions } from './MobilePairingConnectionOptions'

vi.mock('../../i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('MobilePairingConnectionOptions', () => {
  afterEach(() => cleanup())

  it('keeps Relay unavailable and unselectable', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    expect(relay).toHaveTextContent('Unavailable')
    expect(relay).toHaveTextContent(/isn’t available in this build/i)
    expect(relay).toHaveAttribute('aria-disabled', 'true')

    await user.click(relay)
    expect(onChange).not.toHaveBeenCalled()

    screen.getByRole('radio', { name: /^LAN\b/i }).focus()
    await user.keyboard('{ArrowUp}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('selects LAN from the compact list', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} compact />)

    expect(
      screen.getByText(
        'Phone must be on this Wi‑Fi or connected through Tailscale. No account needed.'
      )
    ).toBeVisible()

    await user.click(screen.getByRole('radio', { name: /^LAN\b/i }))
    expect(onChange).toHaveBeenCalledWith('local-only')
  })
})
