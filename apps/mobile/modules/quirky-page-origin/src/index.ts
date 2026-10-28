import { requireNativeViewManager } from 'expo-modules-core'
import type { ComponentType, RefAttributes } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import type { MobileWebShellLoadStatePayload } from './load-state'

export type QuirkyPageOriginBridgeMessage = { json: string }
export type QuirkyPageOriginExternalNavigation = { url: string }

export type QuirkyPageOriginViewProps = ViewProps & {
  generationDirectory: string
  sessionId: string
  bridgeEnabled?: boolean
  onLoadState?: (event: NativeSyntheticEvent<MobileWebShellLoadStatePayload>) => void
  onBridgeMessage?: (event: NativeSyntheticEvent<QuirkyPageOriginBridgeMessage>) => void
  onExternalNavigation?: (event: NativeSyntheticEvent<QuirkyPageOriginExternalNavigation>) => void
}

export type QuirkyPageOriginViewHandle = { postBridgeMessage(json: string): Promise<void> }

export const QuirkyPageOriginView: ComponentType<
  QuirkyPageOriginViewProps & RefAttributes<QuirkyPageOriginViewHandle>
> = requireNativeViewManager<QuirkyPageOriginViewProps & RefAttributes<QuirkyPageOriginViewHandle>>('QuirkyPageOrigin')

export {
  MOBILE_WEB_SHELL_FAILURE_REASONS,
  parseMobileWebShellLoadState,
  type MobileWebShellFailureReason,
  type MobileWebShellLoadState,
  type MobileWebShellLoadStatePayload
} from './load-state'
