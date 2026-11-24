// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./MobileBrandIcons', () => ({
  AndroidLogo: () => null,
  IosBrandIcon: () => null
}))

vi.mock('./NetworkInterfacePicker', () => ({
  NetworkInterfacePicker: () => null
}))

vi.mock('./WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: () => null
}))

vi.mock('../settings/MachineNameField', () => ({
  MachineNameField: ({ id, className }: { id?: string; className?: string }) => (
    <div data-testid="machine-name-field" data-id={id} className={className} />
  )
}))

import { HeroFlow, type StepIndex } from './MobileHero'
import { MobileHeroPairingStep } from './MobileHeroPairingStep'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

describe('HeroFlow height', () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight'
  )

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.textContent?.includes('Step 1 of 2') ? 300 : 520
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    }
  })

  function renderFlow(
    stepIdx: StepIndex,
    overrides: Partial<React.ComponentProps<typeof HeroFlow>> = {}
  ) {
    return render(
      <HeroFlow
        stepIdx={stepIdx}
        platform="ios"
        onPlatformChange={vi.fn()}
        installQrUrl={null}
        installCopy={{ ctaLabel: 'Open TestFlight', url: 'https://example.com' }}
        iosChannel="preview"
        onIosChannelChange={vi.fn()}
        onOpenAndroidInstallGuide={vi.fn()}
        onOpenInstallUrl={vi.fn()}
        onCopyInstallUrl={vi.fn()}
        pairQrDataUrl={null}
        pairingUrl={null}
        pairingQrError={false}
        pairLoading={false}
        onRegeneratePairing={vi.fn()}
        onCopyPairingCode={vi.fn()}
        networkInterfaces={[]}
        customAddresses={[]}
        selectedAddress={undefined}
        selectedAddressIsCustom={false}
        onSelectedAddressChange={vi.fn()}
        onCustomAddressSelect={vi.fn()}
        onCustomAddressRemove={vi.fn()}
        beforeCustomAddressChange={vi.fn().mockResolvedValue(true)}
        onRefreshNetworkInterfaces={vi.fn()}
        refreshingNetworkInterfaces={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
        {...overrides}
      />
    )
  }

  it('sizes to the active step and updates when the taller pairing step opens', () => {
    const { rerender } = renderFlow(0)
    const viewport = document.querySelector<HTMLElement>('.mp-flow-viewport')
    expect(viewport).toHaveStyle({ height: '300px' })
    expect(screen.getByText('Step 2 of 2').closest('.mp-flow-screen')).toHaveAttribute('inert')

    rerender(
      <HeroFlow
        stepIdx={1}
        platform="ios"
        onPlatformChange={vi.fn()}
        installQrUrl={null}
        installCopy={{ ctaLabel: 'Open TestFlight', url: 'https://example.com' }}
        iosChannel="preview"
        onIosChannelChange={vi.fn()}
        onOpenAndroidInstallGuide={vi.fn()}
        onOpenInstallUrl={vi.fn()}
        onCopyInstallUrl={vi.fn()}
        pairQrDataUrl={null}
        pairingUrl={null}
        pairingQrError={false}
        pairLoading={false}
        onRegeneratePairing={vi.fn()}
        onCopyPairingCode={vi.fn()}
        networkInterfaces={[]}
        customAddresses={[]}
        selectedAddress={undefined}
        selectedAddressIsCustom={false}
        onSelectedAddressChange={vi.fn()}
        onCustomAddressSelect={vi.fn()}
        onCustomAddressRemove={vi.fn()}
        beforeCustomAddressChange={vi.fn().mockResolvedValue(true)}
        onRefreshNetworkInterfaces={vi.fn()}
        refreshingNetworkInterfaces={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />
    )

    expect(viewport).toHaveStyle({ height: '520px' })
    expect(screen.getByText('Step 1 of 2').closest('.mp-flow-screen')).toHaveAttribute('inert')
  })

  it('opens the APK install guide without duplicating its troubleshooting steps', async () => {
    const user = userEvent.setup()
    const onOpenAndroidInstallGuide = vi.fn()
    renderFlow(0, {
      platform: 'android',
      installCopy: { ctaLabel: 'Download APK', url: 'https://example.com/app-release.apk' },
      onOpenAndroidInstallGuide
    })

    expect(screen.queryByText(/full browser, not an in-app browser/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Install guide' }))
    expect(onOpenAndroidInstallGuide).toHaveBeenCalledOnce()
  })

  it('explains an empty QR frame when no code has been generated yet', () => {
    renderFlow(1, { pairQrDataUrl: null })
    expect(screen.getByText('Generate a pairing code to continue')).toBeInTheDocument()
  })

  it('renders a pairing QR at its natural integer-scaled bitmap size', () => {
    renderFlow(1, { pairQrDataUrl: 'data:image/png;base64,qr', pairQrSize: 218 })

    const image = screen.getByRole('img', { name: 'Pairing QR' })
    const layout = image.closest('.mp-pairing-layout') as HTMLElement
    expect(layout.style.getPropertyValue('--mp-pairing-qr-image-size')).toBe('218px')
    expect(layout.style.getPropertyValue('--mp-pairing-qr-frame-size')).toBe('238px')
  })

  it('shows an encoder error while keeping the copy fallback enabled', () => {
    renderFlow(1, {
      pairingQrError: true,
      pairingUrl: 'orca://pair?code=copy-fallback'
    })

    expect(screen.getByRole('alert')).toHaveTextContent('couldn’t be rendered as a QR code')
    expect(screen.getByRole('button', { name: /Copy pairing code/ })).toBeEnabled()
  })

  it('moves focus to the pairing-code action once a code is ready', () => {
    const props: React.ComponentProps<typeof MobileHeroPairingStep> = {
      pairQrDataUrl: null,
      pairingUrl: null,
      pairingQrError: false,
      pairLoading: true,
      onRegeneratePairing: vi.fn(),
      onCopyPairingCode: vi.fn(),
      networkInterfaces: [],
      customAddresses: [],
      selectedAddress: undefined,
      selectedAddressIsCustom: false,
      onSelectedAddressChange: vi.fn(),
      onCustomAddressSelect: vi.fn(),
      onCustomAddressRemove: vi.fn(),
      beforeCustomAddressChange: vi.fn().mockResolvedValue(true),
      onRefreshNetworkInterfaces: vi.fn(),
      refreshingNetworkInterfaces: false
    }
    const { rerender } = render(<MobileHeroPairingStep {...props} />)

    rerender(
      <MobileHeroPairingStep
        {...props}
        pairQrDataUrl="data:image/png;base64,qr"
        pairingUrl="orca://pair#ready"
        pairLoading={false}
      />
    )

    expect(screen.getByRole('button', { name: 'Copy pairing code' })).toHaveFocus()
  })

  it('keeps focus on a persistent control when an ordinary remint finishes', () => {
    const props: React.ComponentProps<typeof MobileHeroPairingStep> = {
      pairQrDataUrl: null,
      pairingUrl: null,
      pairingQrError: false,
      pairLoading: true,
      onRegeneratePairing: vi.fn(),
      onCopyPairingCode: vi.fn(),
      networkInterfaces: [],
      customAddresses: [],
      selectedAddress: undefined,
      selectedAddressIsCustom: false,
      onSelectedAddressChange: vi.fn(),
      onCustomAddressSelect: vi.fn(),
      onCustomAddressRemove: vi.fn(),
      beforeCustomAddressChange: vi.fn().mockResolvedValue(true),
      onRefreshNetworkInterfaces: vi.fn(),
      refreshingNetworkInterfaces: false
    }
    const { rerender } = render(<MobileHeroPairingStep {...props} />)
    const refresh = screen.getByRole('button', { name: 'Refresh network interfaces' })
    refresh.focus()

    rerender(
      <MobileHeroPairingStep
        {...props}
        pairQrDataUrl="data:image/png;base64,qr"
        pairingUrl="orca://pair#ready"
        pairLoading={false}
      />
    )

    expect(refresh).toHaveFocus()
  })

  it('lets the user name this computer in the pairing step, ahead of the code', () => {
    const props: React.ComponentProps<typeof MobileHeroPairingStep> = {
      pairQrDataUrl: 'data:image/png;base64,AAAA',
      pairingUrl: 'orca://pair?code=abc',
      pairingQrError: false,
      pairLoading: false,
      onRegeneratePairing: vi.fn(),
      onCopyPairingCode: vi.fn(),
      networkInterfaces: [],
      customAddresses: [],
      selectedAddress: undefined,
      selectedAddressIsCustom: false,
      onSelectedAddressChange: vi.fn(),
      onCustomAddressSelect: vi.fn(),
      onCustomAddressRemove: vi.fn(),
      beforeCustomAddressChange: vi.fn().mockResolvedValue(true),
      onRefreshNetworkInterfaces: vi.fn(),
      refreshingNetworkInterfaces: false
    }
    render(<MobileHeroPairingStep {...props} />)

    const field = screen.getByTestId('machine-name-field')
    expect(field).toHaveAttribute('data-id', 'mobile-hero-machine-name')
    const qr = screen.getByRole('img', { name: 'Pairing QR' })
    expect(field.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Why: the field lives inside the copy cell, so the web client, where it renders nothing,
    // leaves no empty grid track behind.
    expect(field.parentElement).toHaveClass('mp-pairing-copy')
    expect(field).toHaveClass('mp-pairing-machine')
  })
})
