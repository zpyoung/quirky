import { useAppStore } from '@/store'
import { QUIRKY_BROWSER_PARTITION } from '../../../../../shared/constants'
import { getQuirkyProfileBrowserDefaultPartition } from '../../../../../shared/quirky-profiles'

export function useBrowserPageWebviewPartition({
  sessionProfileId,
  sessionPartition
}: {
  sessionProfileId: string | null
  sessionPartition: string | null
}): string {
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const activeQuirkyProfileId = useAppStore((s) => s.activeQuirkyProfileId)
  const fallbackBrowserPartition = activeQuirkyProfileId
    ? getQuirkyProfileBrowserDefaultPartition(activeQuirkyProfileId)
    : null
  const defaultSessionProfile = browserSessionProfiles.find((p) => p.id === 'default') ?? null
  const sessionProfile = sessionProfileId
    ? (browserSessionProfiles.find((p) => p.id === sessionProfileId) ?? null)
    : defaultSessionProfile
  return (
    sessionPartition ??
    sessionProfile?.partition ??
    defaultSessionProfile?.partition ??
    fallbackBrowserPartition ??
    QUIRKY_BROWSER_PARTITION
  )
}
