import { useEffect, useState } from 'react'
import { Badge, Button, FormRow, SectionHeader, SelectField, TextField, ToolPanelFrame } from '@quirky/ui'
import type { MobilePairingResult, UiPluginContext } from '@quirky/protocol'
import { createPairing } from './api'
import { DeviceList } from './DeviceList'
import { NetworkPicker } from './NetworkPicker'
import { PairingPanel } from './PairingPanel'
import { MOBILE_PAGE_ID } from './MobilePage'
import { useMobileState } from './useMobileState'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const AUTO_RESTORE_OPTIONS = [
  { value: 'keep', label: 'Keep at phone size (default)' },
  { value: '60000', label: 'After 1 minute' },
  { value: '300000', label: 'After 5 minutes' },
  { value: '1800000', label: 'After 30 minutes' }
] as const

export function MobileSettings({ context, report }: { context: UiPluginContext; report?(state: unknown): void }) {
  const mobile = useMobileState(context)
  const [machineName, setMachineName] = useState('')
  const [selectedAddress, setSelectedAddress] = useState('')
  const [offer, setOffer] = useState<MobilePairingResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [offerVisible, setOfferVisible] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    report?.({
      machineName, address: selectedAddress, busy,
      autoRestoreFitMs: mobile.state?.autoRestoreFitMs ?? null,
      showMobileButton: mobile.state?.showMobileButton ?? true,
      pairingAvailable: offer?.available ?? false,
      devices: mobile.state?.devices ?? [],
      error: actionError ?? mobile.error
    })
  }, [report, machineName, selectedAddress, busy, offer?.available, mobile.state, actionError, mobile.error])

  useEffect(() => {
    if (mobile.state) setMachineName(mobile.state.machineName)
  }, [mobile.state?.machineName])

  useEffect(() => {
    if (!mobile.state || selectedAddress) return
    setSelectedAddress(mobile.state.interfaces[0]?.address ?? mobile.state.customAddresses[0] ?? '')
  }, [mobile.state?.interfaces, mobile.state?.customAddresses, selectedAddress])

  useEffect(() => {
    if (!offerVisible) return
    const refresh = () => void mobile.refreshDevices().catch((error: unknown) => setActionError(messageOf(error)))
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [mobile.refreshDevices, offerVisible])

  const generate = async (rotate: boolean) => {
    const currentState = mobile.state
    if (!currentState) return
    setBusy(true)
    setActionError(null)
    setOfferVisible(false)
    setOffer(null)
    try {
      await mobile.refreshDevices()
      const address = selectedAddress || currentState.interfaces[0]?.address || currentState.customAddresses[0]
      const result = await createPairing(context, address, rotate)
      setOffer(result)
      setOfferVisible(result.available)
      setActionError(null)
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const saveMachineName = async () => {
    try {
      await mobile.configure({ machineName })
      setActionError(null)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const toggleSidebar = async (showMobileButton: boolean) => {
    try {
      await mobile.configure({ showMobileButton })
      setActionError(null)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const changeAutoRestore = async (value: string) => {
    const autoRestoreFitMs = value === 'keep' ? null : Number(value)
    try {
      await mobile.configure({ autoRestoreFitMs })
      setActionError(null)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const addAddress = async (address: string) => {
    const current = mobile.state
    if (!current) return
    if (current.customAddresses.includes(address)) {
      setSelectedAddress(address)
      return
    }
    if (current.customAddresses.length >= 50) throw new Error('You can save up to 50 custom addresses.')
    const next = await mobile.configure({ customAddresses: [...current.customAddresses, address] })
    setSelectedAddress(address)
    setActionError(null)
    if (!next.customAddresses.includes(address)) throw new Error('The address was not saved.')
  }

  const removeAddress = async (address: string) => {
    const current = mobile.state
    if (!current) return
    const next = await mobile.configure({ customAddresses: current.customAddresses.filter((item) => item !== address) })
    setSelectedAddress(next.interfaces[0]?.address ?? next.customAddresses[0] ?? '')
    setActionError(null)
  }

  const refreshInterfaces = async () => {
    try {
      const interfaces = await mobile.refreshInterfaces()
      if (!interfaces.some((item) => item.address === selectedAddress) && !mobile.state?.customAddresses.includes(selectedAddress)) {
        setSelectedAddress(interfaces[0]?.address ?? mobile.state?.customAddresses[0] ?? '')
      }
      setActionError(null)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  if (mobile.loading && mobile.state === null) {
    return <main className="ui-stack"><p role="status">Loading Mobile settings…</p></main>
  }
  if (mobile.state === null) {
    return (
      <main className="ui-stack">
        <SectionHeader title="Mobile" />
        <p className="ui-error-text" role="alert">Unable to load Mobile settings: {mobile.error ?? 'The daemon returned no state.'}</p>
        <div className="ui-cluster"><Button onClick={() => void mobile.refresh()}>Try again</Button></div>
      </main>
    )
  }

  return (
    <main className="ui-stack">
      <div className="ui-stack">
        <SectionHeader title="Mobile" actions={<Button onClick={() => context.openView(MOBILE_PAGE_ID)}>Open Mobile page</Button>} />
        <p className="ui-text-muted">Control terminals and agents from your phone.</p>
      </div>
      {mobile.error && <p className="ui-error-text" role="alert">Could not refresh Mobile state: {mobile.error}</p>}
      {actionError && <p className="ui-error-text" role="alert">{actionError}</p>}

      <ToolPanelFrame title="Desktop identity">
        <div className="ui-stack">
          <TextField
            label="Machine name"
            name="machineName"
            maxLength={128}
            value={machineName}
            onChange={(event) => setMachineName(event.target.value)}
          />
          <div className="ui-cluster">
            <Button disabled={!machineName.trim() || machineName === mobile.state.machineName} onClick={() => void saveMachineName()}>Save machine name</Button>
          </div>
          <FormRow label="Show Mobile in the sidebar" htmlFor="mobile-sidebar-visibility">
            <input
              id="mobile-sidebar-visibility"
              type="checkbox"
              checked={mobile.state.showMobileButton}
              onChange={(event) => void toggleSidebar(event.target.checked)}
            />
          </FormRow>
        </div>
      </ToolPanelFrame>

      <ToolPanelFrame title="Pair a phone">
        <div className="ui-stack">
          <p className="ui-text-muted">Generate a QR code, then scan it in Quirky Mobile under Pair Desktop.</p>
          <div role="group" aria-label="How the phone reaches this computer" className="ui-stack">
            <p><strong>LAN</strong> <span className="ui-text-muted">Selected · no account needed</span></p>
            <p><Badge tone="needs-you">Relay unavailable</Badge> Quirky Relay isn’t available in this build. Use LAN.</p>
          </div>
          <NetworkPicker
            interfaces={mobile.state.interfaces}
            customAddresses={mobile.state.customAddresses}
            selectedAddress={selectedAddress}
            busy={busy}
            onSelect={setSelectedAddress}
            onRefresh={refreshInterfaces}
            onAdd={addAddress}
            onRemove={removeAddress}
          />
          <PairingPanel offer={offer} busy={busy} error={null} buttonLabel="Generate QR code" onGenerate={generate} />
          <SelectField
            label="When you leave the mobile app"
            aria-label="When you leave the mobile app"
            value={mobile.state.autoRestoreFitMs === null ? 'keep' : String(mobile.state.autoRestoreFitMs)}
            onChange={(event) => void changeAutoRestore(event.target.value)}
          >
            {AUTO_RESTORE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </SelectField>
        </div>
      </ToolPanelFrame>

      <DeviceList context={context} devices={mobile.state.devices} onChanged={async () => { await mobile.refreshDevices() }} />
    </main>
  )
}
