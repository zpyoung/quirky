import { createHash } from 'node:crypto'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { BrowserClientPageAuthorityIdentity } from './browser-client-page-command-executor-dependencies'

/** Authority identities a paired server's client-hosted pages derive their partitions from. */
export function derivePairedRuntimeBrowserAuthorityIdentity(input: {
  quirkyProfileId: string
  environment: Pick<KnownRuntimeEnvironment, 'id' | 'quirkydDeployment'>
  pairingRevision: number
  authorityRuntimeId: string
  connection: PairedRuntimeConnection
}): BrowserClientPageAuthorityIdentity {
  const { quirkyProfileId, environment, pairingRevision, connection } = input
  const pairingIdentity = pairingAuthorityConnectionIdentity(
    quirkyProfileId,
    environment.id,
    pairingRevision,
    connection
  )
  return {
    // Why: Quirky re-pairs its own deployments (managed SSH, WSL) in place on updates and
    // refusals, so their jar must outlive the pairing; it still ends with the server's key.
    authorityConnectionIdentity: environment.quirkydDeployment
      ? deployedAuthorityConnectionIdentity(quirkyProfileId, environment.id, connection)
      : pairingIdentity,
    pairingAuthorityConnectionIdentity: pairingIdentity,
    legacyAuthorityConnectionIdentity: legacyAuthorityConnectionIdentity(
      quirkyProfileId,
      environment.id,
      pairingRevision,
      input.authorityRuntimeId,
      connection
    )
  }
}

/**
 * Storage identity of the connection to a paired server.
 *
 * Every component is a durable client-side record: the environment, its pairing
 * revision, and the server's public key. The server's `authorityRuntimeId` is
 * deliberately absent -- it is a per-process UUID, and hashing it here minted a
 * fresh partition on every remote restart, dropping the user's cookies.
 */
function pairingAuthorityConnectionIdentity(
  quirkyProfileId: string,
  environmentId: string,
  pairingRevision: number,
  connection: PairedRuntimeConnection
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser',
    quirkyProfileId,
    environmentId,
    pairingRevision,
    connection.hostPublicKeyB64,
    connection.pairedDeviceId ?? null
  ])
}

/**
 * Storage identity of a server Quirky deployed and re-pairs in place.
 *
 * Pairing revision and device id rotate on every re-pair, so only the environment and the
 * server's public key remain: a server with a different key never reaches this jar.
 */
function deployedAuthorityConnectionIdentity(
  quirkyProfileId: string,
  environmentId: string,
  connection: PairedRuntimeConnection
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser-deployed',
    quirkyProfileId,
    environmentId,
    connection.hostPublicKeyB64
  ])
}

/** Superseded per-process identity, kept only so its partition can be adopted. */
function legacyAuthorityConnectionIdentity(
  quirkyProfileId: string,
  environmentId: string,
  pairingRevision: number,
  authorityRuntimeId: string,
  connection: PairedRuntimeConnection
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser',
    quirkyProfileId,
    environmentId,
    pairingRevision,
    authorityRuntimeId,
    connection.hostPublicKeyB64,
    connection.pairedDeviceId ?? null
  ])
}

function connectionIdentityDigest(components: readonly unknown[]): string {
  return `paired-runtime:${createHash('sha256').update(JSON.stringify(components)).digest('hex')}`
}
