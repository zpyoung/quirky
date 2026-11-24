import type { ServeReadiness } from '../server/serve-readiness'
import type { QuirkyRuntimeRpcServer } from '../runtime/runtime-rpc'
import { buildServePairingReadiness } from '../server/serve-pairing-readiness'
import type { QuirkydHealth } from './quirkyd-health'
import type { QuirkydOptions } from './quirkyd-start-contract'

/** The readiness payload quirkyd publishes once its RPC transport is listening. */
export async function buildQuirkydServeReadiness(input: {
  options: QuirkydOptions
  runtimeId: string
  rpc: Pick<QuirkyRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
  collectHealth: () => Promise<QuirkydHealth>
}): Promise<ServeReadiness> {
  return {
    runtimeId: input.runtimeId,
    ...(await buildServePairingReadiness(input.options, input.rpc)),
    // Why 'settled': the WSL CLI reconciliation barrier is a desktop-launch concern.
    // quirkyd never runs it, so there is no pending repair a client could race.
    managedWslCliReconciliation: 'settled',
    // Why in the readiness payload: this is the one message a supervisor and a deploy
    // transaction both read, and a green quirkyd with a dead daemon is exactly the
    // looks-healthy-but-useless state they must not activate.
    health: await input.collectHealth()
  }
}
