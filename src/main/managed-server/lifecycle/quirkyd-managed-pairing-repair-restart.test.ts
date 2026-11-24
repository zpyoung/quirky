import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePairingCode, type PairingOffer } from '../../../shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import { DeviceRegistry } from '../../runtime/device-registry'
import { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import { QuirkyRuntimeRpcServer } from '../../runtime/runtime-rpc'
import { verifyRuntimePairingIdentity } from '../../runtime/runtime-environment-identity-verification'
import { buildServePairingReadiness } from '../../server/serve-pairing-readiness'
import type { ServeReadiness } from '../../server/serve-readiness'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import { ManagedQuirkydPairingRepairs } from './quirkyd-managed-pairing-repair'
import {
  QuirkydManagedIdentityError,
  verifyManagedQuirkydTunnelIdentity
} from './quirkyd-managed-tunnel-identity'

vi.mock('../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const servers: QuirkyRuntimeRpcServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

/** An quirkyd process on `hostProfile`, the host profile that holds its E2EE key and devices. */
async function startQuirkyd(hostProfile: string): Promise<QuirkyRuntimeRpcServer> {
  const server = new QuirkyRuntimeRpcServer({
    runtime: new QuirkyRuntimeService(),
    userDataPath: hostProfile,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  servers.push(server)
  return server
}

/** What the slot publishes in its readiness file, which the repair reads over SSH. */
async function publishedReadiness(server: QuirkyRuntimeRpcServer): Promise<ServeReadiness> {
  return {
    runtimeId: 'runtime-now',
    managedWslCliReconciliation: 'settled',
    ...(await buildServePairingReadiness({ pairingAddress: '127.0.0.1' }, server))
  }
}

function offerIn(readiness: ServeReadiness): PairingOffer {
  if (!readiness.pairing.available) {
    throw new Error('pairing unavailable')
  }
  return parsePairingCode(readiness.pairing.url)!
}

/** The desktop's saved server; the tunnel's local port is where the server listens here. */
function savedEnvironment(offer: PairingOffer, at = 1): KnownRuntimeEnvironment {
  return {
    ...createEnvironmentFromPairingOffer({
      id: 'env-1',
      name: 'Box server',
      now: at,
      offer,
      connectionDependency: 'ssh-tunnel'
    }),
    quirkydDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: Number(new URL(offer.endpoint).port),
      remotePort: 6_768
    }
  }
}

function repairsAgainst(saved: KnownRuntimeEnvironment, readiness: ServeReadiness) {
  let current = saved
  const refresh = vi.fn((_id: string, code: string) => {
    current = savedEnvironment(parsePairingCode(code)!, 2)
    return current
  })
  const repairs = new ManagedQuirkydPairingRepairs({
    resolve: () => current,
    connect: async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only passed to readReadiness, which ignores it here.
      target: {} as SshTarget,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only passed to readReadiness, which ignores it here.
      connection: {} as QuirkydHostTransport
    }),
    readReadiness: async () => readiness,
    refresh,
    repaired: vi.fn(),
    now: () => 0
  })
  return { repairs, refresh }
}

describe('a managed quirkyd that dropped this desktop and restarted', () => {
  it('reads as our server refusing our token, and pairing again over SSH restores access', async () => {
    const hostProfile = mkdtempSync(join(tmpdir(), 'quirkyd-host-'))
    const first = await startQuirkyd(hostProfile)
    const paired = offerIn(await publishedReadiness(first))
    await verifyRuntimePairingIdentity(pairedRuntimeConnectionFromOffer(paired), {
      runtimeId: null
    })
    await first.stop()
    // Host side: this desktop's device is removed, then the server restarts.
    new DeviceRegistry(hostProfile).removeDevice(paired.pairedDeviceId!)
    const restarted = await startQuirkyd(hostProfile)
    const readiness = await publishedReadiness(restarted)
    const reached = { ...paired, endpoint: offerIn(readiness).endpoint }

    const refused = await verifyManagedQuirkydTunnelIdentity(savedEnvironment(reached))
    // Not "another Quirky holds the port": the refusal came sealed under the pinned key.
    expect(refused.verdict).toBe('unpaired')

    const { repairs, refresh } = repairsAgainst(savedEnvironment(reached), readiness)
    const repaired = await repairs.repair('env-1', 1)
    expect(refresh).toHaveBeenCalledOnce()
    await expect(verifyManagedQuirkydTunnelIdentity(repaired)).resolves.toEqual({
      verdict: 'verified'
    })
  })

  it('never pairs with a server whose key differs from the pinned one', async () => {
    const paired = offerIn(
      await publishedReadiness(await startQuirkyd(mkdtempSync(join(tmpdir(), 'quirkyd-host-'))))
    )
    const other = await publishedReadiness(
      await startQuirkyd(mkdtempSync(join(tmpdir(), 'quirkyd-other-')))
    )
    const reached = { ...paired, endpoint: offerIn(other).endpoint }
    await expect(
      verifyManagedQuirkydTunnelIdentity(savedEnvironment(reached))
    ).resolves.toMatchObject({ verdict: 'foreign' })

    const { repairs, refresh } = repairsAgainst(savedEnvironment(reached), other)
    await expect(repairs.repair('env-1', 1)).rejects.toBeInstanceOf(QuirkydManagedIdentityError)
    expect(refresh).not.toHaveBeenCalled()
  })
})
