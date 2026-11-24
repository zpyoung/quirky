/**
 * Proving the runtime behind a managed tunnel is this environment's quirkyd. A port held by another
 * runtime still accepts the connection, so a forward that opened proves nothing; only a status
 * call that completes the pairing handshake and reports the paired runtime id does.
 */
import { parsePairingCode } from '../../../shared/pairing'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../../shared/paired-runtime-connection'
import { QUIRKYD_MANAGED_REMOTE_PORT } from '../../../shared/quirkyd-managed-runtime'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { verifyRuntimePairingIdentity } from '../../runtime/runtime-environment-identity-verification'
import type { ServeReadiness } from '../../server/serve-readiness'
import { quirkydBoundPort } from './quirkyd-managed-bound-port'
import { tunneledQuirkydPairingCode } from '../../ssh/quirkyd-tunneled-pairing'

/**
 * `unreachable` means nothing answered; it is never evidence about which server holds the port.
 * `unpaired` is our server (it completed the handshake with the pinned key) refusing our token.
 */
export type QuirkydTunnelIdentity =
  | { verdict: 'verified' }
  | { verdict: 'foreign' | 'unreachable' | 'unpaired'; detail: string }

export const QUIRKYD_IDENTITY_MISMATCH_CODE = 'quirkyd_identity_mismatch'

export class QuirkydManagedIdentityError extends Error {
  readonly code = QUIRKYD_IDENTITY_MISMATCH_CODE
  constructor(remotePort: number, detail: string) {
    super(
      `${QUIRKYD_IDENTITY_MISMATCH_CODE}: the server on remote port ${remotePort} is not this ` +
        `host’s Quirky server (another Quirky may be using that port): ${detail}`
    )
    this.name = 'QuirkydManagedIdentityError'
  }
}

export const QUIRKYD_PAIRING_REJECTED_CODE = 'quirkyd_pairing_rejected'

/** The host's own server no longer accepts this desktop's pairing; another port won't help. */
export class QuirkydManagedPairingRejectedError extends Error {
  readonly code = QUIRKYD_PAIRING_REJECTED_CODE
  constructor(detail: string) {
    super(
      `${QUIRKYD_PAIRING_REJECTED_CODE}: this host’s Quirky server no longer accepts ` +
        `this desktop's pairing (its saved devices were reset, or this desktop was removed ` +
        `there), so reconnecting alone won't restore access: ${detail}`
    )
    this.name = 'QuirkydManagedPairingRejectedError'
  }
}

/** The refusal for an answer that is not this desktop's server, or no longer accepts its pairing. */
export function quirkydIdentityRefusal(
  remotePort: number,
  identity: Exclude<QuirkydTunnelIdentity, { verdict: 'verified' }>
): Error {
  return identity.verdict === 'unpaired'
    ? new QuirkydManagedPairingRejectedError(identity.detail)
    : new QuirkydManagedIdentityError(remotePort, identity.detail)
}

// Why 4001/4003: a runtime that rejects our keys closes the socket rather than replying.
const FOREIGN_CLOSE_CODES = new Set([4001, 4003])

export function classifyQuirkydTunnelIdentityFailure(error: unknown): QuirkydTunnelIdentity {
  const detail = error instanceof Error ? error.message : String(error)
  // Why access-grant only: that refusal arrives sealed, so the holder of our pinned key sent it.
  if (
    error instanceof RemoteRuntimeClientError &&
    error.code === 'unauthorized' &&
    error.pairingStage === 'access-grant'
  ) {
    return { verdict: 'unpaired', detail }
  }
  if (error instanceof RemoteRuntimeClientError && FOREIGN_CLOSE_CODES.has(error.closeCode ?? 0)) {
    return { verdict: 'foreign', detail }
  }
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
    ? { verdict: 'unreachable', detail }
    : { verdict: 'foreign', detail }
}

export async function verifyQuirkydPairingIdentity(
  connection: PairedRuntimeConnection,
  expected: Pick<KnownRuntimeEnvironment, 'runtimeId' | 'pairedDeviceId'>
): Promise<QuirkydTunnelIdentity> {
  try {
    await verifyRuntimePairingIdentity(connection, expected)
    return { verdict: 'verified' }
  } catch (error) {
    return classifyQuirkydTunnelIdentityFailure(error)
  }
}

/** Independent SSH access proved its identity when it linked; only managed quirkyd is checked. */
export function verifyManagedQuirkydTunnelIdentity(
  environment: KnownRuntimeEnvironment
): Promise<QuirkydTunnelIdentity> {
  if (!environment.quirkydDeployment) {
    return Promise.resolve({ verdict: 'verified' })
  }
  // Why no runtime id: it is minted per process, so a restart by another desktop, or while this one
  // was away, changes it. The E2EE handshake with our pinned host key and our token being accepted
  // prove the server; the first authenticated status reply records the new id. Why no device id:
  // one left stale by a racing reply must not block it either.
  return verifyQuirkydPairingIdentity(getPreferredPairedRuntimeConnection(environment), {
    runtimeId: null
  })
}

/**
 * A fresh deploy has no saved environment yet: its pairing comes from the readiness, and a
 * foreign answer re-reads that readiness, whose bound endpoint the tunnel then follows.
 */
export function deployedQuirkydTunnelChecks(
  initial: ServeReadiness,
  rereadReadiness: () => Promise<ServeReadiness>
) {
  let readiness = initial
  return {
    readiness: () => readiness,
    remotePort: quirkydBoundPort(initial) ?? QUIRKYD_MANAGED_REMOTE_PORT,
    rereadRemotePort: async () => {
      readiness = await rereadReadiness()
      return quirkydBoundPort(readiness) ?? QUIRKYD_MANAGED_REMOTE_PORT
    },
    verify: async (localPort: number): Promise<QuirkydTunnelIdentity> => {
      const pairing = parsePairingCode(tunneledQuirkydPairingCode(readiness, localPort))
      return pairing
        ? verifyQuirkydPairingIdentity(pairedRuntimeConnectionFromOffer(pairing), {
            runtimeId: readiness.runtimeId || null
          })
        : { verdict: 'foreign', detail: 'This host’s Quirky server published an invalid pairing.' }
    }
  }
}
