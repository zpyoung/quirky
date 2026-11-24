import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type MutableRef<T> = { current: T }

/** Mints (or rotates) the LAN pairing QR. */
export function useMobilePairingGeneration(params: {
  selectedAddress: string | undefined
  mountedRef: MutableRef<boolean>
  hasGeneratedRef: MutableRef<boolean>
  pairingRequestIdRef: MutableRef<number>
  setPairQrDataUrl: (value: string | null) => void
  setPairQrSize: (value: number | null) => void
  setPairingUrl: (value: string | null) => void
  setPairingQrError: (value: boolean) => void
  setPairLoading: (value: boolean) => void
}): {
  generatePairing: (rotate: boolean, addressOverride?: string) => Promise<void>
} {
  const {
    selectedAddress,
    mountedRef,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairQrSize,
    setPairingUrl,
    setPairingQrError,
    setPairLoading
  } = params

  const generatePairing = useCallback(
    async (rotate: boolean, addressOverride?: string) => {
      const requestId = ++pairingRequestIdRef.current
      hasGeneratedRef.current = true
      if (mountedRef.current) {
        setPairLoading(true)
      }
      try {
        const address = addressOverride ?? selectedAddress
        const result = await window.api.mobile.getPairingQR({
          ...(address ? { address } : {}),
          ...(rotate ? { rotate: true } : {})
        })
        if (requestId !== pairingRequestIdRef.current) {
          return
        }
        if (result.available) {
          if (mountedRef.current) {
            setPairQrDataUrl(result.qrDataUrl)
            setPairQrSize(result.qrSize)
            setPairingUrl(result.pairingUrl)
            setPairingQrError(result.qrDataUrl === null)
          }
        } else {
          // Why: keep hasGenerated so step-2 auto-mint does not loop on failure.
          if (mountedRef.current) {
            setPairQrDataUrl(null)
            setPairQrSize(null)
            setPairingUrl(null)
            setPairingQrError(false)
            // Why: IPC now forwards reason/guidance for all unavailability paths;
            // prefer that copy over a hard-coded WebSocket-only message.
            toast.error(
              result.guidance ??
                translate(
                  'auto.components.mobile.MobilePage.b353e18de1',
                  'WebSocket transport is not running'
                )
            )
          }
        }
      } catch {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          hasGeneratedRef.current = false
          setPairQrDataUrl(null)
          setPairQrSize(null)
          setPairingUrl(null)
          setPairingQrError(false)
          toast.error(
            translate(
              'auto.components.mobile.MobilePage.4c8bd11c1a',
              'Failed to generate pairing code'
            )
          )
        }
      } finally {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          setPairLoading(false)
        }
      }
    },
    [
      hasGeneratedRef,
      mountedRef,
      pairingRequestIdRef,
      selectedAddress,
      setPairLoading,
      setPairQrDataUrl,
      setPairQrSize,
      setPairingUrl,
      setPairingQrError
    ]
  )

  return { generatePairing }
}
