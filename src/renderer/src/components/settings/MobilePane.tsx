import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getPairedMobileDevicesSnapshot,
  usePairedMobileDevices
} from '../mobile/paired-mobile-devices'
import { useMobilePairingDevicePolling } from './mobile-pairing-device-polling'
import { useMobilePairedDeviceRevocation } from './use-mobile-paired-device-revocation'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import { MachineNameField } from './MachineNameField'
import { MobilePairingQrSection } from './MobilePairingQrSection'
import { MobilePairedDevicesSection } from './MobilePairedDevicesSection'
import { MobileAutoRestoreFitSection } from './MobileAutoRestoreFitSection'
import { MobilePairingSetupSection } from './MobilePairingSetupSection'
import { translate } from '@/i18n/i18n'
import { useMobilePairingAddressPreference } from '../mobile/use-mobile-pairing-address-preference'
export { getMobilePaneSearchEntries } from './mobile-pane-search'

export function MobilePane(): React.JSX.Element {
  const autoRestoreFitMs = useAppStore((s) => s.settings?.mobileAutoRestoreFitMs ?? null)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrSize, setQrSize] = useState<number | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState(false)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [qrEnlarged, setQrEnlarged] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  const [deviceCountAtQr, setDeviceCountAtQr] = useState<number | null>(null)
  const [rotateNextQr, setRotateNextQr] = useState(false)
  const codeCopiedResetTimerRef = useRef<number | null>(null)
  // Why: monotonically bumped per pairing request so a late getPairingQR
  // response cannot paint a stale QR after an address change invalidated the
  // request that produced it.
  const pairingRequestIdRef = useRef(0)
  // Ref mirrors of QR-visible / loading so invalidatePairing stays stable and
  // cannot make loadNetworkInterfaces re-fetch on every generate.
  const qrDisplayedRef = useRef(false)
  const loadingRef = useRef(false)
  const mountedRef = useMountedRef()
  const {
    devices,
    loaded: devicesLoaded,
    refresh: refreshDevices
  } = usePairedMobileDevices({ refreshOnMount: false })
  const revokeDevice = useMobilePairedDeviceRevocation(refreshDevices)

  useEffect(() => {
    qrDisplayedRef.current = qrDataUrl != null
  }, [qrDataUrl])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  // Why: an offer encodes a specific endpoint. When the selection that
  // produced it changes, drop any displayed QR and invalidate the in-flight
  // request so a late response can't restore it; arm rotation so the next mint
  // issues a fresh credential rather than the discarded pending one.
  const invalidatePairing = useCallback((): void => {
    pairingRequestIdRef.current += 1
    const hadPending = qrDisplayedRef.current || loadingRef.current
    setQrDataUrl(null)
    setQrSize(null)
    setPairingUrl(null)
    setQrError(false)
    setEndpoint(null)
    // Why: a superseded in-flight generate no longer clears loading in its
    // finally (the epoch bump skips it), so drop the spinner here or Generate
    // stays disabled forever after a mid-flight address change.
    loadingRef.current = false
    setLoading(false)
    if (hadPending) {
      setRotateNextQr(true)
    }
  }, [])
  const {
    selectedAddress,
    selectedAddressIsCustom,
    customAddresses,
    selectAddress: handleSelectedAddressChange,
    selectCustomAddress: handleCustomAddressSelect,
    removeCustomAddress: handleCustomAddressRemove,
    selectAddressAfterRefresh
  } = useMobilePairingAddressPreference({
    networkInterfaces,
    onSelectionInvalidated: invalidatePairing
  })

  const clearCodeCopiedResetTimer = useCallback((): void => {
    if (codeCopiedResetTimerRef.current !== null) {
      window.clearTimeout(codeCopiedResetTimerRef.current)
      codeCopiedResetTimerRef.current = null
    }
  }, [])

  const loadDevices = useCallback(async () => {
    try {
      await refreshDevices()
    } catch {
      // Silently fail — device list is non-critical
    }
  }, [refreshDevices])

  const loadNetworkInterfaces = useCallback(
    async (opts: { notifyOnError?: boolean } = {}) => {
      setRefreshingNetworkInterfaces(true)
      try {
        const result = await window.api.mobile.listNetworkInterfaces()
        if (mountedRef.current) {
          setNetworkInterfaces(result.interfaces)
          selectAddressAfterRefresh(result.interfaces)
        }
      } catch {
        if (opts.notifyOnError && mountedRef.current) {
          toast.error(
            translate(
              'auto.components.settings.MobilePane.d714614dbf',
              'Failed to refresh network interfaces'
            )
          )
        }
      } finally {
        if (mountedRef.current) {
          setRefreshingNetworkInterfaces(false)
        }
      }
    },
    [mountedRef, selectAddressAfterRefresh]
  )

  const generateQR = useCallback(
    async (opts: { rotate?: boolean } = {}) => {
      const requestId = ++pairingRequestIdRef.current
      setLoading(true)
      setQrError(false)
      try {
        const result = await window.api.mobile.getPairingQR({
          ...(selectedAddress ? { address: selectedAddress } : {}),
          ...(opts.rotate || rotateNextQr ? { rotate: true } : {})
        })
        // Why: an address change bumps the epoch. A response for a superseded
        // request must not paint a QR that no longer matches the selection.
        if (requestId !== pairingRequestIdRef.current) {
          return
        }
        if (result.available) {
          useAppStore.getState().recordFeatureInteraction('mobile-pairing')
          if (mountedRef.current) {
            setQrDataUrl(result.qrDataUrl)
            setQrSize(result.qrSize)
            setPairingUrl(result.pairingUrl)
            setQrError(result.qrDataUrl === null)
            setEndpoint(result.endpoint)
            setDeviceCountAtQr(getPairedMobileDevicesSnapshot().length)
            clearCodeCopiedResetTimer()
            setCodeCopied(false)
            setRotateNextQr(false)
            void loadDevices()
          }
        } else if (mountedRef.current) {
          setQrDataUrl(null)
          setQrSize(null)
          setPairingUrl(null)
          setQrError(false)
          setEndpoint(null)
          // Why: IPC now forwards reason/guidance for all unavailability paths;
          // prefer that copy over a hard-coded WebSocket-only message.
          toast.error(
            result.guidance ??
              translate(
                'auto.components.settings.MobilePane.cb9067c1c1',
                'WebSocket transport is not running'
              )
          )
        }
      } catch {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          toast.error(
            translate(
              'auto.components.settings.MobilePane.e3c427e020',
              'Failed to generate QR code'
            )
          )
        }
      } finally {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          setLoading(false)
        }
      }
    },
    [clearCodeCopiedResetTimer, loadDevices, mountedRef, rotateNextQr, selectedAddress]
  )

  useEffect(() => {
    void loadNetworkInterfaces()
  }, [loadNetworkInterfaces])

  // Why: another surface (e.g. the sidebar) may have already populated the
  // shared cache; only fetch on mount when it hasn't loaded yet.
  useEffect(() => {
    if (!devicesLoaded) {
      void loadDevices()
    }
  }, [devicesLoaded, loadDevices])

  useMobilePairingDevicePolling({
    deviceCountAtQr,
    currentDeviceCount: devices.length,
    loadDevices
  })

  return (
    <div className="space-y-6">
      <MachineNameField id="mobile-machine-name" />

      <MobilePairingSetupSection
        networkInterfaces={networkInterfaces}
        customAddresses={customAddresses}
        selectedAddress={selectedAddress}
        selectedAddressIsCustom={selectedAddressIsCustom}
        onSelectedAddressChange={handleSelectedAddressChange}
        onCustomAddressSelect={handleCustomAddressSelect}
        onCustomAddressRemove={handleCustomAddressRemove}
        refreshingNetworkInterfaces={refreshingNetworkInterfaces}
        onRefreshNetworkInterfaces={() => void loadNetworkInterfaces({ notifyOnError: true })}
        loading={loading}
        hasQrCode={qrDataUrl != null}
        onGenerateQr={() => void generateQR({ rotate: qrDataUrl != null })}
      />

      <span className="sr-only" role="status" aria-live="polite">
        {pairingUrl != null && !loading
          ? translate('auto.components.settings.MobilePane.pairingCodeReady', 'Pairing code ready')
          : ''}
      </span>

      <MobilePairingQrSection
        qrDataUrl={qrDataUrl}
        qrSize={qrSize}
        qrError={qrError}
        pairingUrl={pairingUrl}
        endpoint={endpoint}
        qrEnlarged={qrEnlarged}
        codeCopied={codeCopied}
        onQrEnlargedChange={setQrEnlarged}
        onCodeCopiedChange={setCodeCopied}
        onClearCodeCopiedTimer={clearCodeCopiedResetTimer}
      />

      <MobilePairedDevicesSection
        devices={devices}
        hasQrCode={qrDataUrl != null}
        onRevokeDevice={(deviceId) => void revokeDevice(deviceId)}
      />

      <MobileAutoRestoreFitSection
        autoRestoreFitMs={autoRestoreFitMs}
        onAutoRestoreFitChange={(ms) => void updateSettings({ mobileAutoRestoreFitMs: ms })}
      />
    </div>
  )
}
