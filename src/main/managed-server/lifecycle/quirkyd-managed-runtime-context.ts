import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getQuirkydSshDeployment,
  type KnownRuntimeEnvironment,
  type QuirkydSshDeploymentLink
} from '../../../shared/runtime-environments'
import { getManagedQuirkydFenceEnvironmentId } from '../../../shared/managed-quirkyd-ssh-owner'
import type { ServeReadiness } from '../../server/serve-readiness'
import { computeLocalQuirkydBuildHash } from '../../ssh/quirkyd-local-build-hash'
import { sshQuirkydHostTransport } from '../../ssh/quirkyd-ssh-host-transport'
import type { QuirkydHostTarget } from '../../ssh/quirkyd-host-transport'
import type { QuirkydActivationRecord } from '../activation/quirkyd-activation-record'
import { refuseQuirkydHostDowngrade } from '../../ssh/quirkyd-host-version-admission'
import type { QuirkydTerminalCensus } from '../../../shared/quirkyd-terminal-census'
import { probeActiveQuirkydReadiness } from '../../ssh/quirkyd-active-readiness'
import {
  resolveQuirkydRemoteContext,
  type QuirkydRemoteContext
} from '../install/quirkyd-remote-context'
import { QUIRKYD_INSTALL_MODEL } from '../install/remote-install-model'
import { computeRemoteInstallDir } from '../install/remote-versioned-install'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'

export const QUIRKYD_BIND_HOST = '127.0.0.1'

// Why empty: managed slots always carry their pinned runtime marker, so a marker-less slot
// fails to launch instead of silently running on whatever Node the host has.
export const MANAGED_QUIRKYD_LEGACY_NODE_PATH = ''

export function requireManagedQuirkydInfrastructure() {
  const targetStore = requireManagedQuirkydTargetStore()
  const connectionManager = getSshConnectionManager()
  if (!connectionManager) {
    throw new Error('SSH is unavailable on this client; this host’s Quirky server is unverifiable.')
  }
  return { connectionManager, targetStore, claims: targetStore.getQuirkydRuntimeClaims() }
}

export function requireManagedQuirkydTargetStore() {
  const targetStore = getSshTargetRegistryStore()
  if (!targetStore) {
    throw new Error('SSH target state is unavailable; this host’s Quirky server is unverifiable.')
  }
  return targetStore
}

export function requireManagedQuirkydEnvironment(
  userDataPath: string,
  selector: string
): { environment: KnownRuntimeEnvironment; deployment: QuirkydSshDeploymentLink } {
  const environment = resolveEnvironment(userDataPath, selector)
  const deployment = getQuirkydSshDeployment(environment)
  if (!deployment || environment.connectionDependency !== 'ssh-tunnel') {
    throw new Error('This server is not managed through an quirkyd SSH deployment.')
  }
  return { environment, deployment }
}

export async function resolveLinkedQuirkydContext(
  environment: KnownRuntimeEnvironment,
  deployment: QuirkydSshDeploymentLink,
  signal?: AbortSignal
): Promise<QuirkydRemoteContext> {
  const { connectionManager, targetStore } = requireManagedQuirkydInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  if (
    !target ||
    target.generation !== deployment.sshTargetGeneration ||
    getManagedQuirkydFenceEnvironmentId(target) !== environment.id
  ) {
    throw new Error('The SSH registration for this host’s Quirky server is no longer valid.')
  }
  const connection = await connectionManager.connect(target)
  return resolveQuirkydRemoteContext(target, sshQuirkydHostTransport(connection), signal)
}

/** The slot options every remote lifecycle step takes for this managed server. */
export function managedQuirkydSlot(
  context: QuirkydRemoteContext<QuirkydHostTarget>,
  port: number,
  signal?: AbortSignal
) {
  return {
    conn: context.connection,
    host: context.host,
    remoteHome: context.remoteHome,
    nodePath: MANAGED_QUIRKYD_LEGACY_NODE_PATH,
    userDataDir: context.userDataDir,
    bindHost: QUIRKYD_BIND_HOST,
    port,
    signal
  }
}

export function managedQuirkydInstallDir(
  context: QuirkydRemoteContext<QuirkydHostTarget>,
  version: string
): string {
  return computeRemoteInstallDir(
    QUIRKYD_INSTALL_MODEL,
    context.remoteHome,
    version,
    context.host.pathFlavor
  )
}

/** The active slot's readiness, accepted only if it is the build this client holds. */
export function probeManagedQuirkydReadiness(
  context: QuirkydRemoteContext<QuirkydHostTarget>,
  localQuirkydDir: string,
  fullVersion: string,
  signal?: AbortSignal
): Promise<ServeReadiness> {
  return probeActiveQuirkydReadiness(
    {
      conn: context.connection,
      host: context.host,
      remoteInstallDir: managedQuirkydInstallDir(context, fullVersion),
      signal
    },
    { buildHash: computeLocalQuirkydBuildHash(localQuirkydDir), fullVersion }
  )
}

/** The census and version admission every first deploy onto a host applies, SSH or WSL. */
export function managedQuirkydDeployPolicy(
  context: Pick<QuirkydRemoteContext<QuirkydHostTarget>, 'activationRecord'>,
  appVersion: string,
  force?: boolean
): {
  census: QuirkydTerminalCensus
  recountCensus: () => Promise<QuirkydTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
  censusRecord: QuirkydActivationRecord
  admitRecord: (record: QuirkydActivationRecord, candidateVersion: string) => string | null
} {
  // Why unknown when a version is active: only the daemon can count its sessions, and
  // a deploy that guessed zero would restart over live terminals.
  const census: QuirkydTerminalCensus = context.activationRecord.active
    ? { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: null }
    : { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
  return {
    census,
    recountCensus: async () => census,
    // Nothing was fenced: this recount never asks the server.
    releaseIncumbentAdmission: async () => {},
    censusRecord: context.activationRecord,
    // Why: a host another desktop stopped may hold state its newer build migrated, and this
    // path has no linked record to check first, so only the fenced read can refuse it.
    // An explicit force runs this version anyway, as `environment update --force` does.
    admitRecord: (record, candidateVersion) =>
      !force && refuseQuirkydHostDowngrade(record, candidateVersion, appVersion)
        ? `Quirky ${record.activeAppVersion} last ran this host's server, newer than this ` +
          `Quirky (${appVersion}). Update Quirky to start it.`
        : null
  }
}

// Why only this code: deploy never has a session count to force past, so forcing an unknown
// census lands on the daemon-protocol deferral, which force cannot clear.
export function isForceableQuirkydDeferral(code: string): boolean {
  return code === 'quirkyd_update_terminals_running'
}
