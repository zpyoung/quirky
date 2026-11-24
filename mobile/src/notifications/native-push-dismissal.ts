import type { QuirkyPushPayload } from './push-payload'

export type NativeDismissal = {
  remember(payload: QuirkyPushPayload): Promise<void>
  wasDismissed(payload: QuirkyPushPayload): Promise<boolean>
}
// Android and web use JavaScript storage; iOS requires the native ledger.
export const nativePushDismissal: NativeDismissal | null = null
