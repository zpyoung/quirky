import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { QuirkydManagedServing } from './quirkyd-managed-serving'
import { verifyManagedTunnelServing } from './quirkyd-managed-tunnel'

/** After the tunnel: the server answers, or was proven stopped and started; never throws. */
export function verifyQuirkydManagedServing(
  userDataPath: string,
  selector: string
): Promise<QuirkydManagedServing> {
  return Promise.resolve()
    .then(() => verifyManagedTunnelServing(resolveEnvironment(userDataPath, selector)))
    .catch((error: unknown) => ({ state: 'unverifiable', detail: String(error) }))
}
