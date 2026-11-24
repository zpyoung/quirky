/** Opens a managed tunnel at the port quirkyd bound and keeps it only if quirkyd is what answers. */
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  readManagedQuirkydPublishedPort,
  resolveManagedQuirkydTunnelPort,
  type QuirkydTunnelPortInput
} from './quirkyd-managed-bound-port'
import {
  quirkydIdentityRefusal,
  verifyManagedQuirkydTunnelIdentity,
  type QuirkydTunnelIdentity
} from './quirkyd-managed-tunnel-identity'
import { managedQuirkydSlot } from './quirkyd-managed-runtime-context'
import { wakeStoppedManagedQuirkyd } from './quirkyd-managed-wake'
import { resolveQuirkydRemoteContext } from '../install/quirkyd-remote-context'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type {
  PortForwardEntry,
  SshPortForwardManager
} from '../../ssh/port-forwarding/ssh-port-forward'

export type QuirkydManagedTunnelTargeting = {
  resolveRemotePort: (input: QuirkydTunnelPortInput) => Promise<number>
  /** Checks the runtime the environment's pairing endpoint (the tunnel's local port) reaches. */
  verifyIdentity: (environment: KnownRuntimeEnvironment) => Promise<QuirkydTunnelIdentity>
  /** Starts the active slot only on proven exit, before a foreign answer re-reads the port. */
  wakeStoppedServer?: (input: QuirkydTunnelPortInput) => Promise<void>
  /** The port the host's readiness names now, or null; a tunnel that stopped answering follows it. */
  readPublishedPort?: (input: QuirkydTunnelPortInput) => Promise<number | null>
}

export const MANAGED_QUIRKYD_TUNNEL_TARGETING: QuirkydManagedTunnelTargeting = {
  resolveRemotePort: resolveManagedQuirkydTunnelPort,
  verifyIdentity: verifyManagedQuirkydTunnelIdentity,
  wakeStoppedServer: wakeStoppedManagedQuirkydForTunnel,
  readPublishedPort: readManagedQuirkydPublishedPort
}

/**
 * A stopped slot's readiness still names the port it bound, which another runtime may hold by
 * now; starting it moves it to a free port the re-read then follows.
 */
async function wakeStoppedManagedQuirkydForTunnel(input: QuirkydTunnelPortInput): Promise<void> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    return
  }
  try {
    const context = await resolveQuirkydRemoteContext(input.target, input.connection)
    await wakeStoppedManagedQuirkyd(managedQuirkydSlot(context, access.remotePort))
  } catch (error) {
    // The re-read and its identity check still decide; a failed wake only leaves the port as is.
    console.warn('[ssh] Could not start the managed Quirky server behind a foreign answer:', error)
  }
}

/** Test default: the persisted port, and no identity round trip. */
export const PERSISTED_PORT_TARGETING: QuirkydManagedTunnelTargeting = {
  resolveRemotePort: async ({ environment }) => getRuntimeSshAccess(environment)?.remotePort ?? 0,
  verifyIdentity: async () => ({ verdict: 'verified' })
}

export type VerifiedQuirkydForwardArgs = {
  targetId: string
  connection: SshConnection
  forwards: SshPortForwardManager
  /** 0 picks a free local port. */
  localPort: number
  label: string
  remotePort: number
  /** Defaults to the same port, so a foreign answer fails at once. */
  rereadRemotePort?: () => Promise<number>
  /** Defaults to trusting the forward, for callers that verify on their own. */
  verify?: (localPort: number) => Promise<QuirkydTunnelIdentity>
  stillCurrent: () => boolean
}

export type QuirkydTunnelStartChecks = Pick<
  VerifiedQuirkydForwardArgs,
  'rereadRemotePort' | 'verify'
> & {
  /** The persisted launch port, when the forward targets a port quirkyd fell back to. */
  preferredPort?: number
}

/** The manager's targeting, bound to one environment's tunnel, with the port it reads now. */
export async function environmentForwardChecks(
  targeting: QuirkydManagedTunnelTargeting,
  input: QuirkydTunnelPortInput
): Promise<
  Required<Pick<VerifiedQuirkydForwardArgs, 'remotePort' | 'rereadRemotePort' | 'verify'>>
> {
  return {
    remotePort: await targeting.resolveRemotePort(input),
    rereadRemotePort: async () => {
      await targeting.wakeStoppedServer?.(input)
      return targeting.resolveRemotePort(input)
    },
    verify: () => targeting.verifyIdentity(input.environment)
  }
}

/**
 * Null when `stillCurrent` turned false mid-setup; the forward is already removed then.
 * An answer from another runtime re-reads the port once, since quirkyd may have restarted onto a
 * new one or been started there by that re-read, and throws if the port did not move or the new
 * one is foreign too. Our own server refusing our token throws at once.
 */
export async function forwardToVerifiedQuirkyd(
  args: VerifiedQuirkydForwardArgs
): Promise<PortForwardEntry | null> {
  let remotePort = args.remotePort
  for (let attempt = 0; ; attempt++) {
    const forward = await addCurrentForward(args, remotePort)
    if (!forward) {
      return null
    }
    const identity = args.verify
      ? await args.verify(forward.localPort)
      : ({ verdict: 'verified' } as const)
    if (!args.stillCurrent()) {
      await args.forwards.removeForwardAndWait(forward.id)
      return null
    }
    if (identity.verdict === 'verified' || identity.verdict === 'unreachable') {
      if (identity.verdict === 'unreachable') {
        // Why not fail: a server that is down or still starting is not a wrong server.
        console.warn(
          `[ssh] Managed Quirky server did not answer through its tunnel: ${identity.detail}`
        )
      }
      return forward
    }
    await args.forwards.removeForwardAndWait(forward.id)
    // Why no re-read: our own server refusing our token is not a moved port, and waking it is moot.
    if (identity.verdict === 'unpaired') {
      throw quirkydIdentityRefusal(remotePort, identity)
    }
    const reread =
      attempt === 0 && args.rereadRemotePort ? await args.rereadRemotePort() : remotePort
    if (reread === remotePort || !args.stillCurrent()) {
      throw quirkydIdentityRefusal(remotePort, identity)
    }
    remotePort = reread
  }
}

async function addCurrentForward(
  args: VerifiedQuirkydForwardArgs,
  remotePort: number
): Promise<PortForwardEntry | null> {
  const forward = await args.forwards.addForward(
    args.targetId,
    args.connection,
    args.localPort,
    '127.0.0.1',
    remotePort,
    args.label
  )
  if (args.localPort !== 0 && forward.localPort !== args.localPort) {
    await args.forwards.removeForwardAndWait(forward.id)
    throw new Error('Managed Quirky tunnel bound an unexpected local port.')
  }
  if (!args.stillCurrent()) {
    await args.forwards.removeForwardAndWait(forward.id)
    return null
  }
  return forward
}
