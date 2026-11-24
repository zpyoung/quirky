import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import {
  resolveMobilePairingConnectionMode,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'

/**
 * Selected pairing path, seeded from the persisted preference and re-synced when it
 * changes. Shared by MobilePage and MobilePane so the two surfaces cannot resolve the
 * default differently.
 */
export function useMobilePairingConnectionMode(): [
  MobilePairingConnectionMode,
  React.Dispatch<React.SetStateAction<MobilePairingConnectionMode>>
] {
  const savedConnectionMode = useAppStore((s) => s.settings?.mobilePairingConnectionMode)
  const signedIn = false
  const [connectionMode, setConnectionMode] = useState<MobilePairingConnectionMode>(() =>
    resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn })
  )
  useEffect(() => {
    setConnectionMode(resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn }))
  }, [savedConnectionMode, signedIn])
  return [connectionMode, setConnectionMode]
}
