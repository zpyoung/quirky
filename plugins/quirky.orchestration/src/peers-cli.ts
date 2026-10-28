import { lstatSync, readFileSync } from 'node:fs'
import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { RuntimePeer, RuntimePeerStatus } from '@quirky/protocol'
import type { PeerListenerReceipt } from './peers'

function privateTokenFile(context: CliContext, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw context.usage('--token-file is required')
  let info
  try {
    info = lstatSync(value)
  } catch {
    throw context.usage('--token-file must name a readable private file')
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 4096 || (info.mode & 0o077) !== 0) {
    throw context.usage('--token-file must be a regular non-symlink file with mode 0600 or stricter')
  }
  let token: string
  try {
    token = readFileSync(value, 'utf8').trim()
  } catch {
    throw context.usage('--token-file must name a readable private file')
  }
  if (Buffer.byteLength(token, 'utf8') < 32) throw context.usage('--token-file must contain a credential of at least 32 UTF-8 bytes')
  return token
}

function flagString(args: CliArgs, context: CliContext, name: string): string {
  const value = args.flags[name]
  if (typeof value !== 'string' || value.length === 0) throw context.usage(`--${name} is required`)
  return value
}

export const peerCommands: CliModule['commands'] = {
  'peer-list': async (_args, context) => {
    const result = await context.call('quirky.orchestration/peerList', {}) as { peers: RuntimePeer[] }
    context.out.result(result, () => result.peers.length === 0
      ? 'No paired peers.'
      : context.format.table(
        ['ID', 'Label', 'Endpoint', 'Fingerprint', 'Pairing revision'],
        result.peers.map((peer) => [peer.id, peer.label, peer.endpoint, peer.fingerprint, String(peer.pairingRevision)]),
      ))
  },
  'peer-status': async (args, context) => {
    const params: Record<string, unknown> = { peerId: flagString(args, context, 'peer') }
    if (args.flags['pairing-revision'] !== undefined) params.pairingRevision = Number(args.flags['pairing-revision'])
    const status = await context.call('quirky.orchestration/peerStatus', params) as RuntimePeerStatus
    context.out.result(status, () => [
      `Fingerprint: ${status.fingerprint}`,
      `Incarnation: ${status.incarnation}`,
      `Capabilities: ${status.capabilities.join(', ')}`,
    ].join('\n'))
  },
  'peer-listen': async (args, context) => {
    const params: Record<string, unknown> = {
      host: flagString(args, context, 'host'),
      port: Number(args.flags.port ?? 0),
      token: privateTokenFile(context, args.flags['token-file']),
    }
    if (args.flags['certificate-file'] !== undefined) params.certificateFile = flagString(args, context, 'certificate-file')
    if (args.flags['private-key-file'] !== undefined) params.privateKeyFile = flagString(args, context, 'private-key-file')
    const listener = await context.call('quirky.orchestration/peerListen', params) as PeerListenerReceipt
    context.out.result(listener, () => [
      `Peer listener: ${listener.endpoint}`,
      `Fingerprint: ${listener.fingerprint}`,
      `Incarnation: ${listener.incarnation}`,
      `Capabilities: ${listener.capabilities.join(', ')}`,
    ].join('\n'))
  },
  'peer-listen-stop': async (_args, context) => {
    const result = await context.call('quirky.orchestration/peerListenStop', {}) as { stopped: boolean }
    context.out.result(result, () => result.stopped ? 'Peer listener stopped.' : 'Peer listener was not running.')
  },
  'peer-pair': async (args, context) => {
    const result = await context.call('quirky.orchestration/peerPair', {
      peerId: flagString(args, context, 'id'),
      label: flagString(args, context, 'label'),
      endpoint: flagString(args, context, 'endpoint'),
      fingerprint: flagString(args, context, 'fingerprint'),
      token: privateTokenFile(context, args.flags['token-file']),
    }) as { peer: RuntimePeer }
    context.out.result(result, () => `Paired ${result.peer.id} [revision ${result.peer.pairingRevision}]: ${result.peer.endpoint}`)
  },
  'peer-unpair': async (args, context) => {
    const params: Record<string, unknown> = { peerId: flagString(args, context, 'id') }
    if (args.flags['pairing-revision'] !== undefined) params.pairingRevision = Number(args.flags['pairing-revision'])
    const result = await context.call('quirky.orchestration/peerUnpair', params) as { unpaired: boolean }
    context.out.result(result, () => result.unpaired ? `Unpaired ${String(params.peerId)}.` : `Peer ${String(params.peerId)} was not paired.`)
  },
}
