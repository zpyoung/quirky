import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

export function directPathForEndpoint(endpoint: string): MobileConnectionPath {
  return isTailscaleEndpoint(endpoint) ? 'tailscale' : 'lan'
}
