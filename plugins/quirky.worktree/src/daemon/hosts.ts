type HostCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type HostFail = (kind: 'invalid-params' | 'not-found' | 'conflict', message: string) => Error

type Peer = { id: string; label: string; fingerprint: string; pairingRevision: number }
export type AvailableHost = {
  id: string
  label: string
  fingerprint: string
  pairingRevision: number
  available: boolean
  capabilities: string[]
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function peersOf(value: unknown): Peer[] | null {
  const response = recordOf(value)
  if (!Array.isArray(response?.peers)) return null
  const peers: Peer[] = []
  for (const raw of response.peers) {
    const peer = recordOf(raw)
    if (!peer || typeof peer.id !== 'string' || peer.id.trim() === '' || typeof peer.label !== 'string' ||
      typeof peer.fingerprint !== 'string' || peer.fingerprint.trim() === '' ||
      typeof peer.pairingRevision !== 'number' || !Number.isSafeInteger(peer.pairingRevision) || peer.pairingRevision < 1) return null
    peers.push({ id: peer.id, label: peer.label, fingerprint: peer.fingerprint, pairingRevision: peer.pairingRevision })
  }
  return peers
}

async function statusFor(call: HostCall, peer: Peer): Promise<AvailableHost> {
  try {
    const status = recordOf(await call('quirky.orchestration/peerStatus', { peerId: peer.id, pairingRevision: peer.pairingRevision }))
    if (!status || status.fingerprint !== peer.fingerprint || typeof status.incarnation !== 'string' || status.incarnation.length === 0 ||
      !Array.isArray(status.capabilities) || !status.capabilities.every((capability) => typeof capability === 'string')) {
      return { ...peer, available: false, capabilities: [] }
    }
    return { ...peer, available: true, capabilities: status.capabilities }
  } catch {
    return { ...peer, available: false, capabilities: [] }
  }
}

/** Lists only authenticated peer roster entries, and rechecks each exact revision/fingerprint. */
export async function availableHosts(call: HostCall, fail: HostFail): Promise<{ hosts: AvailableHost[] }> {
  let roster: unknown
  try {
    roster = await call('quirky.orchestration/peerList', {})
  } catch (error) {
    throw fail('conflict', `The authenticated peer roster is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const peers = peersOf(roster)
  if (!peers) throw fail('conflict', 'The authenticated peer roster returned incomplete host identity evidence.')
  return { hosts: await Promise.all(peers.map((peer) => statusFor(call, peer))) }
}

/** A caller-supplied label is never authority; target must be the exact ID in the authenticated roster. */
export async function requireAvailableHost(call: HostCall, fail: HostFail, id: unknown): Promise<AvailableHost> {
  if (typeof id !== 'string' || id.trim() === '' || id !== id.trim()) {
    throw fail('invalid-params', 'host must be an exact authenticated peer ID')
  }
  const roster = await availableHosts(call, fail)
  const host = roster.hosts.find((candidate) => candidate.id === id)
  if (!host) throw fail('not-found', `No authenticated peer has ID "${id}".`)
  if (!host.available) throw fail('conflict', `Peer "${host.label}" is not available at its current pairing revision.`)
  return host
}
