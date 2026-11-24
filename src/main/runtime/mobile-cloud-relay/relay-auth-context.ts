import type { OrcaCloudAuthConfig } from './relay-cloud-auth-config'
import type { RelayAuthContext } from './relay-auth-identity'

// Cloud sign-in is gone, so no auth context can ever be produced.
export async function readRelayAuthContext(
  _authConfig: OrcaCloudAuthConfig,
  _userDataPath: string
): Promise<RelayAuthContext | null> {
  return null
}
