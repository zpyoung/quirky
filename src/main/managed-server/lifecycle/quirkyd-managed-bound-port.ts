/**
 * The port a managed quirkyd actually listens on. quirkyd asks for its preferred port but moves to a
 * free one when another runtime (a desktop Quirky, `quirky serve`) holds it, so a tunnel that assumed
 * the preferred port would reach that other runtime instead. The slot's readiness says which.
 */
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { ServeReadiness } from '../../server/serve-readiness'
import { managedQuirkydInstallDir } from './quirkyd-managed-runtime-context'
import { resolveQuirkydRemoteContext } from '../install/quirkyd-remote-context'
import {
  parseQuirkydReadinessWaitOutput,
  readQuirkydReadinessNowCommand
} from '../install/quirkyd-remote-readiness-wait'
import {
  execQuirkydRemote,
  type QuirkydRemoteExecTarget
} from '../install/quirkyd-remote-runtime-control'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'

export type QuirkydTunnelPortInput = {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: QuirkydHostTransport
}

export function quirkydBoundPort(readiness: Pick<ServeReadiness, 'boundEndpoint'>): number | null {
  if (!readiness.boundEndpoint) {
    return null
  }
  try {
    const port = Number(new URL(readiness.boundEndpoint).port)
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
  } catch {
    return null
  }
}

async function readManagedQuirkydSlotReadiness(
  target: QuirkydRemoteExecTarget & { remoteInstallDir: string }
): Promise<ServeReadiness | null> {
  const parsed = parseQuirkydReadinessWaitOutput(
    target.host,
    await execQuirkydRemote(
      target,
      readQuirkydReadinessNowCommand(target.host, target.remoteInstallDir)
    )
  )
  return parsed.state === 'ready' ? parsed.readiness : null
}

async function readSlotBoundPort(
  target: QuirkydRemoteExecTarget & { remoteInstallDir: string }
): Promise<number | null> {
  const readiness = await readManagedQuirkydSlotReadiness(target)
  return readiness ? quirkydBoundPort(readiness) : null
}

/** Falls back to the preferred port only when the slot published no endpoint (older builds). */
export async function readManagedQuirkydBoundPort(
  target: QuirkydRemoteExecTarget & { remoteInstallDir: string },
  preferredPort: number
): Promise<number> {
  return (await readSlotBoundPort(target)) ?? preferredPort
}

/** What the active slot publishes now, read over SSH; null when none is active or ready. */
export async function readActiveManagedQuirkydReadiness(
  input: Pick<QuirkydTunnelPortInput, 'target' | 'connection'>
): Promise<ServeReadiness | null> {
  const context = await resolveQuirkydRemoteContext(input.target, input.connection)
  const active = context.activationRecord.active
  if (!active) {
    return null
  }
  return readManagedQuirkydSlotReadiness({
    conn: context.connection,
    host: context.host,
    remoteHome: context.remoteHome,
    remoteInstallDir: managedQuirkydInstallDir(context, active)
  })
}

/** The bound port the active slot's readiness names now; null when it names none. */
async function readActiveSlotBoundPort(input: QuirkydTunnelPortInput): Promise<number | null> {
  if (!input.environment.quirkydDeployment) {
    return null
  }
  const readiness = await readActiveManagedQuirkydReadiness(input)
  return readiness ? quirkydBoundPort(readiness) : null
}

/** Where a tunnel to this environment must point; independent SSH access keeps its own port. */
export async function resolveManagedQuirkydTunnelPort(
  input: QuirkydTunnelPortInput
): Promise<number> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    throw new Error('Managed quirkyd environment is missing its SSH tunnel dependency.')
  }
  try {
    return (await readActiveSlotBoundPort(input)) ?? access.remotePort
  } catch (error) {
    // Why fall back: the identity check after the forward still catches a wrong server.
    console.warn(
      '[ssh] Could not read the managed Quirky server port; trying the preferred one:',
      error
    )
    return access.remotePort
  }
}

/**
 * The port the host says its server is bound to now, whichever desktop restarted it; null when
 * the host names none (older builds) or cannot be read, which is never a reason to move a tunnel.
 */
export async function readManagedQuirkydPublishedPort(
  input: QuirkydTunnelPortInput
): Promise<number | null> {
  try {
    return await readActiveSlotBoundPort(input)
  } catch {
    return null
  }
}
