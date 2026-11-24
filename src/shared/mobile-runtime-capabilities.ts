import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from './delegated-mobile-device-contract'

// Hosts without this capability have no notifications.registerPush RPC.
export const NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY = 'notifications.remote-push.v1' as const

export const MOBILE_RUNTIME_CAPABILITIES = [
  'mobile.tasks.v1',
  NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY
] as const
