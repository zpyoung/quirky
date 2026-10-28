import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobilePairingResult, UiPluginContext } from '@quirky/protocol'
import { createPairing } from './api'
import { DeviceList } from './DeviceList'
import { MobileStyles } from './MobileStyles'
import { NetworkPicker } from './NetworkPicker'
import { PairingPanel } from './PairingPanel'
import { useMobileState } from './useMobileState'

export const MOBILE_PAGE_ID = 'view:quirky.mobile/page'
export const MOBILE_SETTINGS_ID = 'view:quirky.mobile/settings'

type Stage = 'intro' | 'install' | 'pair' | 'paired'

function stageInput(input: unknown): Stage | null {
  if (input && typeof input === 'object' && 'stage' in input) {
    const stage = input.stage
    if (stage === 'intro' || stage === 'install' || stage === 'pair' || stage === 'paired') return stage
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function MobilePage({ context, input }: { context: UiPluginContext; input?: unknown }) {
  const mobile = useMobileState(context)
  const [stage, setStage] = useState<Stage | null>(() => stageInput(input))
  const [platform, setPlatform] = useState<'iOS' | 'Android'>('iOS')
  const [channel, setChannel] = useState<'Preview' | 'Stable'>('Preview')
  const [selectedAddress, setSelectedAddress] = useState('')
  const [offer, setOffer] = useState<MobilePairingResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [offerVisible, setOfferVisible] = useState(false)
  const [baselineCount, setBaselineCount] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (stage === null && mobile.state) setStage(mobile.state.devices.length > 0 ? 'paired' : mobile.state.onboardingSeen ? 'install' : 'intro')
  }, [mobile.state, stage])

  useEffect(() => {
    if (!mobile.state || selectedAddress) return
    setSelectedAddress(mobile.state.interfaces[0]?.address ?? mobile.state.customAddresses[0] ?? '')
  }, [mobile.state, selectedAddress])


  useEffect(() => {
    if (!offerVisible) return
    const refresh = () => void mobile.refreshDevices().catch((error: unknown) => setActionError(messageOf(error)))
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [mobile.refreshDevices, offerVisible])

  useEffect(() => {
    if (!offerVisible || baselineCount === null || mobile.state === null || mobile.state.devices.length <= baselineCount) return
    setStage('paired')
    setOfferVisible(false)
    if (!mobile.state.onboardingSeen) void mobile.configure({ onboardingSeen: true }).catch((error: unknown) => setActionError(messageOf(error)))
  }, [baselineCount, mobile.configure, mobile.state?.devices.length, mobile.state?.onboardingSeen, offerVisible])

  const generate = useCallback(async (rotate: boolean) => {
    const currentState = mobile.state
    if (currentState === null) return
    setBusy(true)
    setActionError(null)
    setOfferVisible(false)
    setOffer(null)
    try {
      const devices = await mobile.refreshDevices()
      if (!rotate) setBaselineCount(devices.length)
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
  }, [context, mobile.refreshDevices, mobile.state, selectedAddress])

  const startPairing = useCallback(() => {
    setStage('pair')
    void generate(false)
  }, [generate])

  const saveOnboardingSeen = async () => {
    setStage('install')
    try {
      await mobile.configure({ onboardingSeen: true })
      setActionError(null)
    } catch (error) {
      setActionError(messageOf(error))
    }
  }

  const updateSidebar = async () => {
    if (!mobile.state) return
    try {
      await mobile.configure({ showMobileButton: !mobile.state.showMobileButton })
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

  if (mobile.loading && mobile.state === null) return <main className="mobile-root"><MobileStyles /><p role="status">Loading Mobile…</p></main>
  if (mobile.state === null) {
    return (
      <main className="mobile-root">
        <MobileStyles />
        <h1 className="mobile-title">Mobile</h1>
        <p className="mobile-error" role="alert">Unable to load Mobile settings: {mobile.error ?? 'The daemon returned no state.'}</p>
        <button className="mobile-button" type="button" onClick={() => void mobile.refresh()}>Try again</button>
      </main>
    )
  }

  const currentStage = stage ?? 'intro'
  return (
    <main className="mobile-root">
      <MobileStyles />
      <header className="mobile-header">
        <div>
          <h1 className="mobile-title">Mobile</h1>
          <p className="mobile-description">Control terminals and agents from your phone.</p>
        </div>
        <div className="mobile-actions">
          <button className="mobile-button" type="button" onClick={() => context.openView(MOBILE_SETTINGS_ID)}>Settings</button>
          <button className="mobile-button" type="button" onClick={() => void updateSidebar()}>{mobile.state.showMobileButton ? 'Hide from sidebar' : 'Show in sidebar'}</button>
        </div>
      </header>
      {mobile.error && <p className="mobile-error" role="alert">Could not refresh Mobile state: {mobile.error}</p>}
      {actionError && <p className="mobile-error" role="alert">{actionError}</p>}

      {currentStage === 'intro' && (
        <section className="mobile-card">
          <h2>Your workspaces, in your pocket.</h2>
          <p className="mobile-muted">Pair Quirky Mobile directly with this desktop to watch sessions and control terminals.</p>
          <div className="mobile-actions"><button className="mobile-button primary" type="button" onClick={() => void saveOnboardingSeen()}>Get started</button></div>
        </section>
      )}

      {currentStage === 'install' && (
        <section className="mobile-card">
          <p className="mobile-muted">Step 1 of 2</p>
          <h2>Get the app</h2>
          <p>Choose your phone platform and release channel.</p>
          <div className="mobile-choice-row" role="group" aria-label="Phone platform">
            {(['iOS', 'Android'] as const).map((choice) => (
              <button key={choice} className="mobile-button mobile-choice" type="button" aria-pressed={platform === choice} onClick={() => setPlatform(choice)}>{choice}</button>
            ))}
          </div>
          <div className="mobile-choice-row" role="group" aria-label="Release channel">
            {(['Preview', 'Stable'] as const).map((choice) => (
              <button key={choice} className="mobile-button mobile-choice" type="button" aria-pressed={channel === choice} onClick={() => setChannel(choice)}>{choice}</button>
            ))}
          </div>
          <p className="mobile-callout">Quirky mobile app is not available yet for {platform} ({channel.toLowerCase()}). Orca’s hosted mobile app uses an incompatible RPC protocol and cannot pair with Quirky.</p>
          <div className="mobile-actions">
            <button className="mobile-button" type="button" onClick={() => setStage('intro')}>Back</button>
            <button className="mobile-button primary" type="button" onClick={startPairing}>Continue</button>
          </div>
        </section>
      )}

      {currentStage === 'pair' && (
        <>
          <section className="mobile-card">
            <p className="mobile-muted">Step 2 of 2</p>
            <h2>Pair this desktop</h2>
            <p>Pairing uses the selected LAN or Tailscale address. Relay is unavailable in this build.</p>
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
          </section>
          <PairingPanel offer={offer} busy={busy} error={null} buttonLabel="Generate code" onGenerate={generate} />
          <div className="mobile-actions">
            <button className="mobile-button" type="button" onClick={() => setStage('install')}>Back</button>
          </div>
        </>
      )}

      {currentStage === 'paired' && (
        <>
          <section className="mobile-card">
            <h2>{mobile.state.devices.length > 0 ? 'Your phone is paired.' : 'No phones paired yet.'}</h2>
            <p className="mobile-muted">{mobile.state.devices.length > 0 ? 'Open Quirky Mobile to pick up where you left off, or pair another device.' : 'Pair a phone to connect this desktop to Quirky Mobile.'}</p>
          </section>
          <DeviceList context={context} devices={mobile.state.devices} onChanged={async () => { await mobile.refreshDevices() }} />
          <div className="mobile-actions"><button className="mobile-button primary" type="button" onClick={startPairing}>Pair another device</button></div>
        </>
      )}
      <button className="mobile-button" type="button" onClick={() => context.openView(MOBILE_SETTINGS_ID)}>Configure in Settings &gt; Mobile</button>
    </main>
  )
}
