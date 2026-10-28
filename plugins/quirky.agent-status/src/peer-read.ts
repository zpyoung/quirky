import type { PluginContext } from '@quirky/protocol'

type RecordValue = Record<string, unknown>
type Peer = { id: string; label: string; fingerprint: string; pairingRevision: number }
type PeerStatus = { fingerprint: string; incarnation: string; capabilities: string[] }
export type RemoteStatusReadMethod = 'quirky.agent-status/get' | 'quirky.agent-status/hooksStatus'

export type StatusHostIdentity =
  | { kind: 'local'; id: 'local' }
  | { kind: 'paired'; id: string; label: string; fingerprint: string; pairingRevision: number; incarnation: string }

export type HostedStatusResult = { host: StatusHostIdentity; result: unknown }
export const localStatusHost: StatusHostIdentity = { kind: 'local', id: 'local' }

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fingerprint(value: string): string {
  return value.replaceAll(':', '').toLowerCase()
}

function conflict(context: PluginContext, message: string): never {
  throw context.error('conflict', message)
}

function readPeer(value: unknown, hostId: string, context: PluginContext): Peer {
  if (!isRecord(value) || value.id !== hostId || typeof value.label !== 'string' ||
    typeof value.fingerprint !== 'string' || value.fingerprint.trim() === '' ||
    typeof value.pairingRevision !== 'number' || !Number.isSafeInteger(value.pairingRevision)) {
    return conflict(context, `No exact paired host matches ${hostId}.`)
  }
  return { id: hostId, label: value.label, fingerprint: fingerprint(value.fingerprint), pairingRevision: value.pairingRevision }
}

function readStatus(value: unknown, peer: Peer, method: string, context: PluginContext): PeerStatus {
  if (!isRecord(value) || typeof value.fingerprint !== 'string' || fingerprint(value.fingerprint) !== peer.fingerprint ||
    typeof value.incarnation !== 'string' || value.incarnation === '' ||
    !Array.isArray(value.capabilities) || !value.capabilities.every((item) => typeof item === 'string') ||
    !value.capabilities.includes(method)) {
    return conflict(context, `The exact paired host does not advertise ${method}.`)
  }
  return { fingerprint: peer.fingerprint, incarnation: value.incarnation, capabilities: value.capabilities as string[] }
}

async function assertCurrentPeer(context: PluginContext, peer: Peer): Promise<void> {
  let roster: unknown
  try {
    roster = await context.call('quirky.orchestration/peerList', {})
  } catch {
    return conflict(context, 'Paired host authority changed during the request.')
  }
  const current = isRecord(roster) && Array.isArray(roster.peers)
    ? roster.peers.find((candidate) => isRecord(candidate) && candidate.id === peer.id)
    : undefined
  const currentPeer = readPeer(current, peer.id, context)
  if (currentPeer.fingerprint !== peer.fingerprint || currentPeer.pairingRevision !== peer.pairingRevision) {
    return conflict(context, 'Paired host identity changed during the request.')
  }
}

/** Proxies a fixed read-only status method through the exact authenticated paired owner. */
export async function readFromStatusPeer(
  context: PluginContext,
  hostId: string,
  method: RemoteStatusReadMethod,
  params: RecordValue
): Promise<HostedStatusResult> {
  if (hostId.trim() === '') return conflict(context, 'host must be a non-empty exact peer ID.')
  let roster: unknown
  try {
    roster = await context.call('quirky.orchestration/peerList', {})
  } catch {
    return conflict(context, 'Paired host authority is unavailable.')
  }
  if (!isRecord(roster) || !Array.isArray(roster.peers)) {
    return conflict(context, 'Paired host authority returned an invalid roster.')
  }
  const peer = readPeer(roster.peers.find((candidate) => isRecord(candidate) && candidate.id === hostId), hostId, context)
  let rawStatus: unknown
  try {
    rawStatus = await context.call('quirky.orchestration/peerStatus', { peerId: peer.id, pairingRevision: peer.pairingRevision })
  } catch {
    return conflict(context, 'The exact paired host is unavailable.')
  }
  const status = readStatus(rawStatus, peer, method, context)
  let reply: unknown
  try {
    reply = await context.call('quirky.orchestration/peerCall', {
      peerId: peer.id,
      pairingRevision: peer.pairingRevision,
      method,
      params: { ...params, expectedIncarnation: status.incarnation },
      timeoutMs: 15_000
    })
  } catch {
    return conflict(context, 'The exact paired host could not complete the request.')
  }
  if (!isRecord(reply) || !isRecord(reply.peer) || !isRecord(reply.status) ||
    reply.peer.id !== peer.id || reply.peer.pairingRevision !== peer.pairingRevision ||
    typeof reply.peer.fingerprint !== 'string' || fingerprint(reply.peer.fingerprint) !== peer.fingerprint ||
    reply.status.incarnation !== status.incarnation || typeof reply.status.fingerprint !== 'string' ||
    fingerprint(reply.status.fingerprint) !== peer.fingerprint) {
    return conflict(context, 'The paired host identity changed during the request.')
  }
  await assertCurrentPeer(context, peer)
  return {
    host: {
      kind: 'paired',
      id: peer.id,
      label: peer.label,
      fingerprint: peer.fingerprint,
      pairingRevision: peer.pairingRevision,
      incarnation: status.incarnation
    },
    result: reply.result
  }
}
