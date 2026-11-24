/**
 * One SSH forward per managed environment, owned across reconnects and host resume, and the
 * serving check that starts a stopped server behind it.
 */
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { isAuthError } from '../../ssh/ssh-reconnect-error-classification'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import { QuirkydManagedTunnelTransportProvider } from './quirkyd-managed-tunnel-transport'
import {
  QuirkydManagedTunnelResumeRecovery,
  type QuirkydManagedServingCheck,
  type QuirkydManagedTunnelProbe,
  type QuirkydManagedTunnelResumeOptions
} from './quirkyd-managed-tunnel-resume'
import type { QuirkydManagedServing } from './quirkyd-managed-serving'
import {
  activeTunnelMatches,
  dropActiveQuirkydTunnel,
  managedTunnelStillPaired,
  recordActiveQuirkydTunnel,
  resolveManagedTunnelBinding,
  supersededTunnelError,
  type ActiveQuirkydTunnel
} from './quirkyd-managed-tunnel-active'
import {
  checkManagedTunnelServing,
  type QuirkydTunnelServing
} from './quirkyd-managed-tunnel-serving'
import type { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import {
  environmentForwardChecks,
  forwardToVerifiedQuirkyd,
  PERSISTED_PORT_TARGETING,
  type QuirkydManagedTunnelTargeting,
  type QuirkydTunnelStartChecks
} from './quirkyd-managed-tunnel-target'

export type QuirkydManagedTunnelDependencies = {
  getConnectionManager: () => SshConnectionManager | null
  getTargetStore: () => ReturnType<typeof getSshTargetRegistryStore>
  forwardManager?: SshPortForwardManager
  probeTunnel?: QuirkydManagedTunnelProbe
  targeting?: QuirkydManagedTunnelTargeting
  /** Runs after a fresh forward is up; starts a server that stopped (e.g. after idling). */
  ensureServing?: QuirkydManagedServingCheck
}

export class QuirkydManagedTunnelManager {
  private readonly active = new Map<string, ActiveQuirkydTunnel>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly ownershipGenerations = new Map<string, number>()
  // The SSH target each environment's latest build dialled, so its Disconnect can supersede it.
  private readonly buildTargets = new Map<string, string>()
  private readonly forwards: SshPortForwardManager
  private readonly resumeRecovery: QuirkydManagedTunnelResumeRecovery
  private readonly targeting: QuirkydManagedTunnelTargeting
  private managerGeneration = 0

  constructor(private readonly dependencies: QuirkydManagedTunnelDependencies) {
    this.forwards =
      dependencies.forwardManager ??
      new SshPortForwardManager({}, [new QuirkydManagedTunnelTransportProvider()])
    this.targeting = dependencies.targeting ?? PERSISTED_PORT_TARGETING
    this.resumeRecovery = new QuirkydManagedTunnelResumeRecovery({
      active: this.active,
      forwards: this.forwards,
      getConnectionManager: dependencies.getConnectionManager,
      getManagerGeneration: () => this.managerGeneration,
      getTargetStore: dependencies.getTargetStore,
      inFlight: this.inFlight,
      ownershipGenerations: this.ownershipGenerations,
      probeTunnel: dependencies.probeTunnel,
      targeting: this.targeting,
      checkServing: (environment) => this.checkServing(environment)
    })
    this.forwards.setCallbacks({
      onForwardClosed: (entry) => {
        for (const [environmentId, active] of this.active) {
          if (active.forwardId === entry.id) {
            this.active.delete(environmentId)
          }
        }
      }
    })
  }

  ensure(
    environment: KnownRuntimeEnvironment,
    resolveCurrent: () => KnownRuntimeEnvironment | null = () => environment,
    retryJoined = true
  ): Promise<void> {
    if (!getRuntimeSshAccess(environment)) {
      return Promise.resolve()
    }
    const pending = this.inFlight.get(environment.id)
    if (pending) {
      // A joiner did not start that run, so its end (a close(), a disconnect that cancelled its
      // connect, a lost exec) is not this caller's answer: build once anew. An auth failure is.
      return pending.catch((error: unknown) =>
        retryJoined && !(error instanceof Error && isAuthError(error))
          ? this.ensure(environment, resolveCurrent, false)
          : Promise.reject(error)
      )
    }
    const operation = this.ensureManagedTunnel(environment, resolveCurrent).finally(() => {
      if (this.inFlight.get(environment.id) === operation) {
        this.inFlight.delete(environment.id)
      }
    })
    this.inFlight.set(environment.id, operation)
    return operation
  }

  /** Forwards anew to the port the server bound now; a redeploy can bind another port. */
  async rebuild(
    environment: KnownRuntimeEnvironment,
    resolveCurrent: () => KnownRuntimeEnvironment | null = () => environment
  ): Promise<void> {
    await this.inFlight.get(environment.id)?.catch(() => undefined)
    const active = this.active.get(environment.id)
    if (active) {
      await dropActiveQuirkydTunnel(this.active, this.forwards, environment.id, active)
    }
    await this.ensure(environment, resolveCurrent)
  }

  async start(
    environmentId: string,
    target: SshTarget,
    connection: SshConnection,
    remotePort: number,
    checks: QuirkydTunnelStartChecks = {}
  ): Promise<number> {
    if (!target.generation) {
      throw new Error('Managed Quirky SSH target has no registration generation.')
    }
    this.buildTargets.set(environmentId, target.id)
    const managerGeneration = this.managerGeneration
    const ownershipGeneration = (this.ownershipGenerations.get(environmentId) ?? 0) + 1
    const transportGeneration = connection.getConnectGeneration()
    const stillCurrent = (): boolean =>
      this.managerGeneration === managerGeneration &&
      this.ownershipGenerations.get(environmentId) === ownershipGeneration &&
      connection.getConnectGeneration() === transportGeneration
    await this.close(environmentId)
    if (!stillCurrent()) {
      throw supersededTunnelError()
    }
    const forward = await forwardToVerifiedQuirkyd({
      targetId: target.id,
      connection,
      forwards: this.forwards,
      localPort: 0,
      label: 'Quirky on this host',
      remotePort,
      rereadRemotePort: checks.rereadRemotePort,
      verify: checks.verify,
      stillCurrent
    })
    // Why re-check: a teardown can land between the build's last check and this record.
    if (!forward || !stillCurrent()) {
      await (forward && this.forwards.removeForwardAndWait(forward.id))
      throw supersededTunnelError()
    }
    recordActiveQuirkydTunnel(this.active, environmentId, forward, {
      connection,
      preferredPort: checks.preferredPort ?? remotePort,
      sshTargetGeneration: target.generation,
      targetId: target.id,
      transportGeneration
    })
    return forward.localPort
  }

  async close(environmentId: string): Promise<void> {
    this.ownershipGenerations.set(
      environmentId,
      (this.ownershipGenerations.get(environmentId) ?? 0) + 1
    )
    const active = this.active.get(environmentId)
    if (!active) {
      return
    }
    this.active.delete(environmentId)
    await this.forwards.removeForwardAndWait(active.forwardId)
  }

  /** The host's SSH session ends: every managed tunnel it carried, built or building, goes. */
  async closeTarget(targetId: string): Promise<void> {
    const environmentIds = new Set([...this.buildTargets.keys(), ...this.active.keys()])
    const carried = [...environmentIds].filter(
      (id) => this.buildTargets.get(id) === targetId || this.active.get(id)?.targetId === targetId
    )
    // Why both: a build's forward is unrecorded while its identity check runs, or still starting.
    await Promise.all([
      ...carried.map((environmentId) => this.close(environmentId)),
      this.forwards.removeAllForwards(targetId)
    ])
  }

  /** Quit: supersedes every build in flight and waits for each forward process to exit. */
  async shutdown(): Promise<void> {
    this.managerGeneration += 1
    this.active.clear()
    await this.forwards.closeAll()
  }

  dispose(): void {
    this.managerGeneration += 1
    this.active.clear()
    this.inFlight.clear()
    this.ownershipGenerations.clear()
    this.buildTargets.clear()
    this.resumeRecovery.dispose()
    this.forwards.dispose()
  }

  /** The server behind the tunnel answers, or is started; a moved port rebuilds the forward. */
  async verifyServing(environment: KnownRuntimeEnvironment): Promise<QuirkydManagedServing> {
    if (!this.active.has(environment.id)) {
      await this.ensure(environment)
    }
    const serving = await this.checkServing(environment)
    if (serving.rebind) {
      await this.ensure(environment)
    }
    // Why re-check: an unanswered old port says nothing about the server the new tunnel reaches.
    return serving.rebind && serving.state !== 'started' ? this.checkServing(environment) : serving
  }

  /** Never rebuilds, so it is safe inside a build: a moved port only drops the forward. */
  checkServing(environment: KnownRuntimeEnvironment): Promise<QuirkydTunnelServing> {
    return checkManagedTunnelServing({
      environment,
      active: this.active,
      getTarget: (id) => this.dependencies.getTargetStore()?.getTarget(id),
      forwards: this.forwards,
      ensureServing: this.dependencies.ensureServing,
      readPublishedPort: this.targeting.readPublishedPort
    })
  }

  recoverAfterHostResume(options: QuirkydManagedTunnelResumeOptions): Promise<void> {
    return this.resumeRecovery.recover(options)
  }

  private async ensureManagedTunnel(
    environment: KnownRuntimeEnvironment,
    resolveCurrent: () => KnownRuntimeEnvironment | null,
    rebound = false
  ): Promise<void> {
    const { deployment, targetStore, connectionManager, target } = resolveManagedTunnelBinding(
      environment,
      this.dependencies
    )
    this.buildTargets.set(environment.id, target.id)
    const managerGeneration = this.managerGeneration
    const ownershipGeneration = this.ownershipGenerations.get(environment.id) ?? 0
    const expected = { environmentId: environment.id, ...deployment }
    const stillOwned = (): boolean =>
      this.managerGeneration === managerGeneration &&
      (this.ownershipGenerations.get(environment.id) ?? 0) === ownershipGeneration &&
      managedTunnelStillPaired(
        environment,
        resolveCurrent(),
        targetStore.getTarget(target.id),
        expected
      )
    const connection = await connectionManager.connect(target)
    if (!stillOwned()) {
      throw supersededTunnelError()
    }
    const transportGeneration = connection.getConnectGeneration()
    const active = this.active.get(environment.id)
    if (activeTunnelMatches(active, { connection, transportGeneration, target, deployment })) {
      return
    }
    const checks = await environmentForwardChecks(this.targeting, {
      environment,
      target,
      connection
    })
    if (active && stillOwned()) {
      await dropActiveQuirkydTunnel(this.active, this.forwards, environment.id, active)
    }
    if (!stillOwned()) {
      throw supersededTunnelError()
    }
    const forward = await forwardToVerifiedQuirkyd({
      targetId: target.id,
      connection,
      forwards: this.forwards,
      localPort: deployment.localPort,
      label: `Quirky on ${environment.name}`,
      ...checks,
      stillCurrent: () => stillOwned() && connection.getConnectGeneration() === transportGeneration
    })
    if (!forward) {
      throw supersededTunnelError()
    }
    recordActiveQuirkydTunnel(this.active, environment.id, forward, {
      connection,
      preferredPort: deployment.remotePort,
      sshTargetGeneration: deployment.sshTargetGeneration,
      targetId: target.id,
      transportGeneration
    })
    const recorded = this.active.get(environment.id)
    const serving = await this.checkServing(environment)
    if (!stillOwned() || connection.getConnectGeneration() !== transportGeneration) {
      if (recorded) {
        await dropActiveQuirkydTunnel(this.active, this.forwards, environment.id, recorded)
      }
      throw supersededTunnelError()
    }
    if (serving.rebind && !rebound) {
      await this.ensureManagedTunnel(environment, resolveCurrent, true)
    }
  }
}
