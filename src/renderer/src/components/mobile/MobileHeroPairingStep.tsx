import { useEffect, useRef } from 'react'
import { CircleAlert, Copy, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'
import { NetworkInterfacePicker } from './NetworkInterfacePicker'
import { MachineNameField } from '../settings/MachineNameField'
import { translate } from '@/i18n/i18n'

/** Why: one full sentence per device kind so translators own word order and punctuation. */
function pairDeviceHeading(): string {
  const ua = navigator.userAgent
  if (ua.includes('Mac')) {
    return translate('auto.components.mobile.MobileHero.pairThisMac', 'Pair this Mac.')
  }
  if (ua.includes('Windows')) {
    return translate('auto.components.mobile.MobileHero.pairThisPc', 'Pair this PC.')
  }
  return translate('auto.components.mobile.MobileHero.pairThisComputer', 'Pair this computer.')
}

/** Short copy for the QR frame when no image can be shown. */
function emptyPairingQrMessage(args: {
  pairingQrError: boolean
  pairingUrl: string | null
}): string {
  if (args.pairingQrError && args.pairingUrl != null) {
    return translate(
      'auto.components.mobile.MobileHero.qrRenderFailed',
      'QR couldn’t be rendered — copy the code below'
    )
  }
  return translate(
    'auto.components.mobile.MobileHero.qrGeneratePrompt',
    'Generate a pairing code to continue'
  )
}

export function MobileHeroPairingStep({
  pairQrDataUrl,
  pairQrSize = null,
  pairingUrl,
  pairingQrError,
  pairLoading,
  onRegeneratePairing,
  onCopyPairingCode,
  networkInterfaces,
  customAddresses,
  selectedAddress,
  selectedAddressIsCustom,
  onSelectedAddressChange,
  onCustomAddressSelect,
  onCustomAddressRemove,
  beforeCustomAddressChange,
  onRefreshNetworkInterfaces,
  refreshingNetworkInterfaces
}: {
  pairQrDataUrl: string | null
  pairQrSize?: number | null
  pairingUrl: string | null
  pairingQrError: boolean
  pairLoading: boolean
  onRegeneratePairing: () => void
  onCopyPairingCode: () => void
  networkInterfaces: readonly MobileNetworkInterface[]
  customAddresses: readonly string[]
  selectedAddress: string | undefined
  selectedAddressIsCustom: boolean
  onSelectedAddressChange: (address: string) => void
  onCustomAddressSelect: (address: string) => void
  onCustomAddressRemove: (address: string) => void
  beforeCustomAddressChange: (address: string) => Promise<boolean>
  onRefreshNetworkInterfaces: () => void
  refreshingNetworkInterfaces: boolean
}): React.JSX.Element {
  const pairingLayoutStyle =
    pairQrSize == null
      ? undefined
      : ({
          '--mp-pairing-qr-image-size': `${pairQrSize}px`,
          '--mp-pairing-qr-frame-size': `${pairQrSize + 20}px`
        } as React.CSSProperties)
  const copyPairingCodeRef = useRef<HTMLButtonElement | null>(null)
  const pairingWasReadyRef = useRef(pairingUrl != null && !pairLoading)
  const emptyQrMessage =
    !pairLoading && pairQrDataUrl == null
      ? emptyPairingQrMessage({ pairingQrError, pairingUrl })
      : null

  useEffect(() => {
    const pairingReady = pairingUrl != null && !pairLoading
    const becameReady = !pairingWasReadyRef.current && pairingReady
    pairingWasReadyRef.current = pairingReady
    if (becameReady && document.activeElement === document.body) {
      copyPairingCodeRef.current?.focus()
    }
  }, [pairLoading, pairingUrl])

  const networkRow = (
    <div className="mp-network-row">
      <span className="mp-network-label">
        {translate('auto.components.mobile.MobileHero.dfd2aa9d5d', 'Network')}
      </span>
      <NetworkInterfacePicker
        networkInterfaces={networkInterfaces}
        customAddresses={customAddresses}
        selectedAddress={selectedAddress}
        selectedAddressIsCustom={selectedAddressIsCustom}
        onSelectedAddressChange={onSelectedAddressChange}
        onCustomAddressSelect={onCustomAddressSelect}
        onCustomAddressRemove={onCustomAddressRemove}
        beforeCustomAddressChange={beforeCustomAddressChange}
        disabled={false}
        className="mp-network-select"
      />
      <button
        type="button"
        className={cn('mp-network-refresh', refreshingNetworkInterfaces && 'is-spinning')}
        onClick={onRefreshNetworkInterfaces}
        disabled={refreshingNetworkInterfaces}
        aria-label={translate(
          'auto.components.mobile.MobileHero.85067b9e06',
          'Refresh network interfaces'
        )}
        title={translate(
          'auto.components.mobile.MobileHero.85067b9e06',
          'Refresh network interfaces'
        )}
      >
        <RefreshCw className="size-3.5" />
      </button>
    </div>
  )

  return (
    <div className="mp-pairing-layout" style={pairingLayoutStyle}>
      <div className="mp-step2-copy mp-pairing-copy">
        <div className="mp-eyebrow-row">
          <div className="mp-step-num">2</div>
          <span className="mp-eyebrow">
            {translate('auto.components.mobile.MobileHero.3960f5c339', 'Step 2 of 2')}
          </span>
        </div>
        <h2 className="mp-h2">{pairDeviceHeading()}</h2>
        <p className="mp-lead-sm">
          {translate('auto.components.mobile.MobileHero.d1495e5e64', 'Open Orca Mobile, tap')}{' '}
          <strong>
            {translate('auto.components.mobile.MobileHero.3aa7bb2d8b', 'Pair Desktop')}
          </strong>
          {translate('auto.components.mobile.MobileHero.2f077ef4eb', ', and scan the code.')}
        </p>
        <MachineNameField id="mobile-hero-machine-name" className="mp-pairing-machine" />
      </div>
      <div className="mp-qr-stack mp-pairing-qr">
        <div className="mp-qr mp-qr-large" aria-busy={pairLoading}>
          {pairQrDataUrl ? (
            <img
              src={pairQrDataUrl}
              alt={translate('auto.components.mobile.MobileHero.27735e5f4e', 'Pairing QR')}
              className={cn(pairLoading && 'mp-qr-refreshing')}
            />
          ) : null}
          {pairLoading ? (
            <span className="mp-qr-loading">
              {translate('auto.components.mobile.MobileHero.65b3f2e8bc', 'Generating…')}
            </span>
          ) : null}
          {emptyQrMessage != null ? (
            <span className="mp-qr-empty text-center text-xs text-muted-foreground px-3">
              {emptyQrMessage}
            </span>
          ) : null}
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {pairQrDataUrl != null && !pairLoading
            ? translate('auto.components.mobile.MobileHero.pairingCodeReady', 'Pairing code ready')
            : ''}
        </span>
        <button
          type="button"
          className="mp-link-under"
          onClick={onRegeneratePairing}
          disabled={pairLoading}
        >
          {pairLoading
            ? translate('auto.components.mobile.MobileHero.65b3f2e8bc', 'Generating…')
            : pairQrDataUrl
              ? translate('auto.components.mobile.MobileHero.e59a252eca', 'Regenerate code')
              : translate('auto.components.mobile.MobileHero.a6cffbbb0b', 'Generate code')}
        </button>
        {pairingQrError ? (
          <p
            className="flex w-full min-w-0 items-start gap-1.5 text-xs text-destructive"
            role="alert"
          >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              {translate(
                'auto.components.mobile.MobileHero.pairingQrError',
                'This pairing code couldn’t be rendered as a QR code. Copy it into Orca Mobile instead.'
              )}
            </span>
          </p>
        ) : null}
      </div>
      <div className="mp-pairing-controls">
        {networkRow}

        <div className="mp-inline-actions">
          <span className="mp-action-divider">
            {translate('auto.components.mobile.MobileHero.4c1df4eba7', "Can't scan?")}
          </span>
          <button
            ref={copyPairingCodeRef}
            type="button"
            className="mp-text-link"
            onClick={onCopyPairingCode}
            disabled={!pairingUrl || pairLoading}
          >
            <Copy className="size-3.5" />
            {translate('auto.components.mobile.MobileHero.010dddcf27', 'Copy pairing code')}
          </button>
        </div>
      </div>
    </div>
  )
}
