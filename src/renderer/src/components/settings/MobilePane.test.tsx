// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPairedMobileDevicesCacheForTests,
  type PairedMobileDevice
} from '../mobile/paired-mobile-devices'

type PairedDevice = PairedMobileDevice

type PairedDevicesProps = {
  devices: readonly PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
}

type StoreState = {
  settingsSearchQuery: string
  settings: {
    mobileAutoRestoreFitMs: number | null
    mobilePairingCustomAddress?: string | null
    mobilePairingCustomAddresses?: string[]
  }
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
  recordFeatureInteraction: (feature: string) => void
}

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = { state: {} as StoreState }
  const useAppStore = Object.assign(
    (selector: (state: StoreState) => unknown) => selector(holder.state),
    { getState: () => holder.state }
  )
  return {
    holder,
    useAppStore,
    latestPairedDevicesProps: null as PairedDevicesProps | null,
    getPairingQR: vi.fn(),
    listDevices: vi.fn(),
    listNetworkInterfaces: vi.fn(),
    revokeDevice: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    updateSettings: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))
vi.mock('./mobile-pairing-device-polling', () => ({ useMobilePairingDevicePolling: vi.fn() }))

// Stub the child sections so the test targets MobilePane's own pairing wiring in isolation.
vi.mock('./MobilePairingSetupSection', () => ({
  MobilePairingSetupSection: (props: {
    loading: boolean
    networkInterfaces: { name: string; address: string }[]
    customAddresses: readonly string[]
    selectedAddress: string | undefined
    selectedAddressIsCustom: boolean
    onSelectedAddressChange: (address: string) => void
    onCustomAddressSelect: (address: string) => void
    onCustomAddressRemove: (address: string) => void
    refreshingNetworkInterfaces: boolean
    onRefreshNetworkInterfaces: () => void
    onGenerateQr: () => void
  }) => (
    <div>
      <span data-testid="loading">{String(props.loading)}</span>
      <span data-testid="selected-address">{props.selectedAddress ?? 'none'}</span>
      <span data-testid="selected-address-is-custom">{String(props.selectedAddressIsCustom)}</span>
      <span data-testid="custom-addresses">{props.customAddresses.join(',')}</span>
      <span data-testid="refreshing-addresses">{String(props.refreshingNetworkInterfaces)}</span>
      {/* Mirror the real Generate gate so a stuck loading flag surfaces as a
          disabled control the tests can catch. */}
      <button type="button" onClick={props.onGenerateQr} disabled={props.loading}>
        Generate
      </button>
      <button type="button" onClick={() => props.onCustomAddressSelect('100.126.117.25:6768')}>
        choose-custom-address
      </button>
      <button type="button" onClick={() => props.onCustomAddressRemove('100.126.117.25:6768')}>
        remove-custom-address
      </button>
      <button
        type="button"
        disabled={props.networkInterfaces.length === 0}
        onClick={() => props.onSelectedAddressChange(props.networkInterfaces[0]!.address)}
      >
        choose-discovered-address
      </button>
      <button type="button" onClick={props.onRefreshNetworkInterfaces}>
        refresh-addresses
      </button>
    </div>
  )
}))
vi.mock('./MobilePairingQrSection', () => ({
  MobilePairingQrSection: (props: {
    qrDataUrl: string | null
    pairingUrl: string | null
    qrError: boolean
  }) => (
    <div>
      <span data-testid="qr">{props.qrDataUrl ?? 'none'}</span>
      <span data-testid="pairing-url">{props.pairingUrl ?? 'none'}</span>
      <span data-testid="qr-error">{String(props.qrError)}</span>
    </div>
  )
}))
vi.mock('./MobilePairedDevicesSection', () => ({
  MobilePairedDevicesSection: (props: PairedDevicesProps) => {
    mocks.latestPairedDevicesProps = props
    return <div data-testid="paired-devices">{props.devices.map((d) => d.deviceId).join(',')}</div>
  }
}))
vi.mock('./MobileAutoRestoreFitSection', () => ({ MobileAutoRestoreFitSection: () => <div /> }))
vi.mock('../mobile/WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: () => <div data-testid="firewall-notice" />
}))

import { MobilePane } from './MobilePane'

describe('MobilePane pairing', () => {
  const getPairingQR = mocks.getPairingQR
  const updateSettings = mocks.updateSettings

  beforeEach(() => {
    vi.clearAllMocks()
    _resetPairedMobileDevicesCacheForTests()
    mocks.latestPairedDevicesProps = null
    getPairingQR.mockReset().mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'quirky://pair',
      endpoint: 'ws://host'
    })
    mocks.listDevices.mockReset().mockResolvedValue({ devices: [] })
    mocks.listNetworkInterfaces.mockReset().mockResolvedValue({ interfaces: [] })
    mocks.revokeDevice.mockReset().mockResolvedValue({ revoked: true })
    updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.holder.state = {
      settingsSearchQuery: '',
      settings: { mobileAutoRestoreFitMs: null },
      updateSettings,
      recordFeatureInteraction: vi.fn()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR,
          listDevices: mocks.listDevices,
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          revokeDevice: mocks.revokeDevice
        },
        ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) }
      }
    })
  })

  afterEach(() => {
    cleanup()
    _resetPairedMobileDevicesCacheForTests()
    document.body.innerHTML = ''
  })

  it('keeps the copy fallback when QR encoding fails', async () => {
    getPairingQR.mockResolvedValue({
      available: true,
      qrDataUrl: null,
      qrError: 'encoding_failed',
      pairingUrl: 'quirky://pair?code=copy-fallback',
      endpoint: 'wss://host.example/large'
    })
    const user = userEvent.setup()
    render(<MobilePane />)

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => expect(screen.getByTestId('qr-error')).toHaveTextContent('true'))
    expect(screen.getByTestId('qr')).toHaveTextContent('none')
    expect(screen.getByTestId('pairing-url')).toHaveTextContent('copy-fallback')
  })

  it('restores a saved custom address for future pairing codes', async () => {
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingCustomAddress: '100.126.117.25:6768'
    }
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'Ethernet', address: '10.0.0.2' }]
    })
    const user = userEvent.setup()
    render(<MobilePane />)

    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('100.126.117.25:6768')
    )
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() =>
      expect(getPairingQR).toHaveBeenCalledWith({
        address: '100.126.117.25:6768'
      })
    )
  })

  it('persists a custom address and clears it when a discovered address is selected', async () => {
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'Ethernet', address: '10.0.0.2' }]
    })
    const user = userEvent.setup()
    render(<MobilePane />)
    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledOnce())

    await user.click(screen.getByRole('button', { name: 'choose-custom-address' }))
    expect(updateSettings).toHaveBeenCalledWith({
      mobilePairingCustomAddress: '100.126.117.25:6768',
      mobilePairingCustomAddresses: ['100.126.117.25:6768']
    })
    expect(screen.getByTestId('selected-address')).toHaveTextContent('100.126.117.25:6768')
    expect(screen.getByTestId('selected-address-is-custom')).toHaveTextContent('true')
    expect(screen.getByTestId('custom-addresses')).toHaveTextContent('100.126.117.25:6768')

    await user.click(screen.getByRole('button', { name: 'choose-discovered-address' }))
    expect(updateSettings).toHaveBeenCalledWith({ mobilePairingCustomAddress: null })
    expect(screen.getByTestId('selected-address')).toHaveTextContent('10.0.0.2')
    expect(screen.getByTestId('custom-addresses')).toHaveTextContent('100.126.117.25:6768')
  })

  it('keeps the current pairing code when the active custom address is reselected', async () => {
    const customAddress = '100.126.117.25:6768'
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingCustomAddress: customAddress,
      mobilePairingCustomAddresses: [customAddress]
    }
    const user = userEvent.setup()
    render(<MobilePane />)

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr'))
    getPairingQR.mockClear()
    updateSettings.mockClear()

    await user.click(screen.getByRole('button', { name: 'choose-custom-address' }))

    expect(updateSettings).not.toHaveBeenCalled()
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr')
  })

  it('keeps the current pairing code when only custom address intent changes', async () => {
    const address = '100.126.117.25:6768'
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingCustomAddress: address,
      mobilePairingCustomAddresses: [address]
    }
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'Tailscale', address }]
    })
    const user = userEvent.setup()
    render(<MobilePane />)
    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr'))
    getPairingQR.mockClear()
    updateSettings.mockClear()

    await user.click(screen.getByRole('button', { name: 'choose-discovered-address' }))

    expect(updateSettings).toHaveBeenCalledWith({ mobilePairingCustomAddress: null })
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr')
    expect(screen.getByTestId('selected-address-is-custom')).toHaveTextContent('false')

    updateSettings.mockClear()
    await user.click(screen.getByRole('button', { name: 'choose-custom-address' }))
    expect(updateSettings).toHaveBeenCalledWith({
      mobilePairingCustomAddress: address,
      mobilePairingCustomAddresses: [address]
    })
    updateSettings.mockClear()
    await user.click(screen.getByRole('button', { name: 'remove-custom-address' }))

    expect(updateSettings).toHaveBeenCalledWith({
      mobilePairingCustomAddress: null,
      mobilePairingCustomAddresses: []
    })
    expect(getPairingQR).not.toHaveBeenCalled()
    expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr')
    expect(screen.getByTestId('selected-address-is-custom')).toHaveTextContent('false')
  })

  it('removes the selected custom address and falls back to discovery', async () => {
    const customAddress = '100.126.117.25:6768'
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingCustomAddress: customAddress,
      mobilePairingCustomAddresses: [customAddress, 'second.example:6768']
    }
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'Ethernet', address: '10.0.0.2' }]
    })
    const user = userEvent.setup()
    render(<MobilePane />)
    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent(customAddress)
    )

    await user.click(screen.getByRole('button', { name: 'remove-custom-address' }))

    expect(updateSettings).toHaveBeenCalledWith({
      mobilePairingCustomAddress: null,
      mobilePairingCustomAddresses: ['second.example:6768']
    })
    expect(screen.getByTestId('selected-address')).toHaveTextContent('10.0.0.2')
    expect(screen.getByTestId('selected-address-is-custom')).toHaveTextContent('false')
  })

  it('removes an inactive custom address without changing the selection', async () => {
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingCustomAddress: 'second.example:6768',
      mobilePairingCustomAddresses: ['100.126.117.25:6768', 'second.example:6768']
    }
    const user = userEvent.setup()
    render(<MobilePane />)

    await user.click(screen.getByRole('button', { name: 'remove-custom-address' }))

    expect(updateSettings).toHaveBeenCalledWith({
      mobilePairingCustomAddresses: ['second.example:6768']
    })
    expect(screen.getByTestId('selected-address')).toHaveTextContent('second.example:6768')
    expect(screen.getByTestId('selected-address-is-custom')).toHaveTextContent('true')
  })

  it('keeps a saved custom override when discovery later stops listing it', async () => {
    const customAddress = '100.126.117.25:6768'
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingCustomAddress: customAddress
    }
    mocks.listNetworkInterfaces.mockResolvedValueOnce({
      interfaces: [{ name: 'Tailscale', address: customAddress }]
    })
    const user = userEvent.setup()
    render(<MobilePane />)
    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent(customAddress)
    )

    let resolveRefresh: ((value: Record<string, unknown>) => void) | undefined
    mocks.listNetworkInterfaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    await user.click(screen.getByRole('button', { name: 'refresh-addresses' }))
    expect(screen.getByTestId('refreshing-addresses')).toHaveTextContent('true')

    resolveRefresh?.({ interfaces: [{ name: 'Ethernet', address: '10.0.0.2' }] })
    await waitFor(() =>
      expect(screen.getByTestId('refreshing-addresses')).toHaveTextContent('false')
    )

    expect(screen.getByTestId('selected-address')).toHaveTextContent(customAddress)
    expect(updateSettings).not.toHaveBeenCalled()
  })
})

const mountedRoots: Root[] = []

function pairedDevice(deviceId: string): PairedDevice {
  return {
    deviceId,
    name: deviceId,
    pairedAt: 1,
    lastSeenAt: 2
  }
}

async function renderMobilePane(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<MobilePane />)
  })
}

async function unmountMobilePaneRoots(): Promise<void> {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })
}

describe('MobilePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPairedMobileDevicesCacheForTests()
    mocks.latestPairedDevicesProps = null
    mocks.getPairingQR.mockReset().mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'quirky://pair',
      endpoint: 'ws://host'
    })
    mocks.listDevices.mockReset()
    mocks.listNetworkInterfaces.mockReset().mockResolvedValue({ interfaces: [] })
    mocks.revokeDevice.mockReset()
    mocks.updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.holder.state = {
      settingsSearchQuery: '',
      settings: { mobileAutoRestoreFitMs: null },
      updateSettings: mocks.updateSettings,
      recordFeatureInteraction: vi.fn()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR: mocks.getPairingQR,
          listDevices: mocks.listDevices,
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          revokeDevice: mocks.revokeDevice
        }
      }
    })
  })

  afterEach(async () => {
    await unmountMobilePaneRoots()
    _resetPairedMobileDevicesCacheForTests()
    document.body.innerHTML = ''
  })

  it('refreshes paired devices from the backend after revoking one', async () => {
    mocks.listDevices
      .mockResolvedValueOnce({ devices: [pairedDevice('phone-1')] })
      .mockResolvedValueOnce({ devices: [pairedDevice('phone-2')] })
    mocks.revokeDevice.mockResolvedValue({ revoked: true })

    await renderMobilePane()

    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
    )

    await act(async () => {
      mocks.latestPairedDevicesProps?.onRevokeDevice('phone-1')
    })

    await vi.waitFor(() => expect(mocks.revokeDevice).toHaveBeenCalledWith({ deviceId: 'phone-1' }))
    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-2'])
    )
    // Positive control so the unmount test below can't stay green if the
    // success toast is ever dropped from the revoke path.
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))
  })

  it('shows an error and keeps the device when revoke returns revoked:false', async () => {
    mocks.listDevices.mockResolvedValue({ devices: [pairedDevice('phone-1')] })
    mocks.revokeDevice.mockResolvedValue({ revoked: false })

    await renderMobilePane()

    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
    )

    await act(async () => {
      mocks.latestPairedDevicesProps?.onRevokeDevice('phone-1')
    })

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    // A revoke that did not happen must not fire a second (refresh) IPC call.
    expect(mocks.listDevices).toHaveBeenCalledTimes(1)
    expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
  })

  it('optimistically drops the revoked device when the post-revoke refresh fails', async () => {
    mocks.listDevices
      .mockResolvedValueOnce({ devices: [pairedDevice('phone-1'), pairedDevice('phone-2')] })
      .mockRejectedValueOnce(new Error('refresh failed'))
    mocks.revokeDevice.mockResolvedValue({ revoked: true })

    await renderMobilePane()

    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual([
        'phone-1',
        'phone-2'
      ])
    )

    await act(async () => {
      mocks.latestPairedDevicesProps?.onRevokeDevice('phone-1')
    })

    // Refresh rejected, so the fallback republishes the optimistic list without
    // the revoked device, and success is still reported.
    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-2'])
    )
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1))
  })

  it('does not show revoke success after unmounting during the refresh', async () => {
    let resolveRefreshAfterRevoke: (value: { devices: [] }) => void = () => {}
    const refreshAfterRevoke = new Promise<{ devices: [] }>((resolve) => {
      resolveRefreshAfterRevoke = resolve
    })
    mocks.listDevices
      .mockResolvedValueOnce({ devices: [pairedDevice('phone-1')] })
      .mockReturnValueOnce(refreshAfterRevoke)
    mocks.revokeDevice.mockResolvedValue({ revoked: true })

    await renderMobilePane()

    await vi.waitFor(() =>
      expect(mocks.latestPairedDevicesProps?.devices.map((d) => d.deviceId)).toEqual(['phone-1'])
    )

    await act(async () => {
      mocks.latestPairedDevicesProps?.onRevokeDevice('phone-1')
    })

    await vi.waitFor(() => expect(mocks.listDevices).toHaveBeenCalledTimes(2))
    await unmountMobilePaneRoots()

    await act(async () => {
      resolveRefreshAfterRevoke({ devices: [] })
    })

    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
