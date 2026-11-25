import { connect, type ConnectOptions, type RpcClient } from './rpc-client'
import { resolvePairingHostIdentity, savePairedHost } from './host-store'
import type { HostProfile, PairingOffer } from './types'
import { recordHostDescriptorFromStatus } from './host-descriptor-recorder'
import type { HostStatusReply } from './host-status-reply-schema'
import {
  hostAnsweredStatusProbe,
  hostStatusProbe,
  readPairingCandidateStatus
} from './host-status-probe-operations'

export type PreProfilePairingAttempt = {
  readonly result: Promise<{ hostId: string }>
  readonly timedOut: boolean
  dispose(): void
}

type Dependencies = {
  connectDirect: typeof connect
  resolveHostIdentity: typeof resolvePairingHostIdentity
  savePairedHost: typeof savePairedHost
  recordDescriptorFromStatus: typeof recordHostDescriptorFromStatus
  now: () => number
}

const defaultDependencies: Dependencies = {
  connectDirect: connect,
  resolveHostIdentity: resolvePairingHostIdentity,
  savePairedHost,
  recordDescriptorFromStatus: recordHostDescriptorFromStatus,
  now: Date.now
}

export function startPreProfilePairing(args: {
  offer: PairingOffer
  timeoutMs: number
  connectOptions?: ConnectOptions
  dependencies?: Partial<Dependencies>
}): PreProfilePairingAttempt {
  const dependencies = { ...defaultDependencies, ...args.dependencies }
  const clients = new Set<RpcClient>()
  let disposed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const closeClients = (): void => {
    for (const client of clients) {
      client.close()
    }
    clients.clear()
  }

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    closeClients()
  }

  timer = setTimeout(() => {
    timedOut = true
    dispose()
  }, args.timeoutMs)

  const result = runPairing(args.offer, args.connectOptions, dependencies, clients, () => disposed)
    .catch((error: unknown) => {
      if (timedOut) {
        throw new Error('mobile pairing timed out')
      }
      throw error
    })
    .finally(() => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      closeClients()
    })

  return {
    result,
    get timedOut() {
      return timedOut
    },
    dispose
  }
}

async function runPairing(
  offer: PairingOffer,
  connectOptions: ConnectOptions | undefined,
  dependencies: Dependencies,
  clients: Set<RpcClient>,
  isDisposed: () => boolean
): Promise<{ hostId: string }> {
  const now = dependencies.now()
  // Why: every pairing artifact must share the preserved host id so re-pairing
  // updates one card instead of publishing a second identity (STA-1840).
  const { id: hostId, name: hostName } = await dependencies.resolveHostIdentity(
    offer.publicKeyB64,
    `host-${now}`
  )
  assertActive(isDisposed)

  const directClient = dependencies.connectDirect(
    offer.endpoint,
    offer.deviceToken,
    offer.publicKeyB64,
    connectOptions
  )
  clients.add(directClient)
  const reply = await hostStatusProbe.request(directClient)
  if (!hostAnsweredStatusProbe(reply)) {
    throw new Error('desktop refused the pairing status probe')
  }
  assertActive(isDisposed)

  await dependencies.savePairedHost(baseHost(offer, hostId, hostName, now))
  recordWinnerDescriptor(dependencies, hostId, readPairingCandidateStatus(reply))
  return { hostId }
}

/**
 * Why after the save: the saved row starts as its existing name (or "Host N") and the descriptor
 * writer adopt-renames it to the desktop's machine name in the same serialized store chain, so a
 * load issued after pairing returns the desktop-reported name. A recording failure is swallowed —
 * descriptor upkeep must never fail a pairing that already saved.
 */
function recordWinnerDescriptor(
  dependencies: Dependencies,
  hostId: string,
  status: HostStatusReply | null
): void {
  if (!status) {
    return
  }
  try {
    dependencies.recordDescriptorFromStatus(hostId, status)
  } catch {
    // Best-effort bookkeeping; the host is already saved.
  }
}

function baseHost(
  offer: PairingOffer,
  hostId: string,
  name: string,
  lastConnected: number
): HostProfile {
  return {
    id: hostId,
    name,
    endpoint: offer.endpoint,
    deviceToken: offer.deviceToken,
    publicKeyB64: offer.publicKeyB64,
    lastConnected
  }
}

function assertActive(isDisposed: () => boolean): void {
  if (isDisposed()) {
    throw new Error('mobile pairing cancelled')
  }
}
