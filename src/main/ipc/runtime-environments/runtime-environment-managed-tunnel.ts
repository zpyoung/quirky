import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getQuirkydSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { classifyRuntimeEnvironmentHost } from '../../../shared/runtime-environment-host-kind'
import type {
  SshManagedServerStatus,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../../shared/ssh-types'
import { managedServerUpdateDeps } from '../../ssh/managed-server-update-deps'
import {
  ensureQuirkydManagedTunnel,
  rebuildQuirkydManagedTunnel
} from '../../managed-server/lifecycle/quirkyd-managed-tunnel'
import { verifyQuirkydManagedServing } from '../../managed-server/lifecycle/quirkyd-managed-serving-verify'
import {
  MANAGED_QUIRKYD_NOT_ACTIVATED_DETAIL,
  setManagedQuirkydStartListener,
  type QuirkydManagedServing
} from '../../managed-server/lifecycle/quirkyd-managed-serving'
import {
  redeployStoppedManagedQuirkyd,
  updateManagedQuirkydOnRestore
} from '../../managed-server/lifecycle/quirkyd-managed-update-on-restore'
import { getSshHostServerStatus, setSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { connectionManager, getCurrentMainWindow } from '../ssh/ssh-ipc-context'
import { broadcastSshState } from '../ssh/ssh-renderer-broadcast'

export async function resolveManagedRuntimeEnvironment(
  userDataPath: string,
  selector: string
): Promise<ReturnType<typeof resolveEnvironment>> {
  const environment = resolveEnvironment(userDataPath, selector)
  const host = classifyRuntimeEnvironmentHost(environment)
  if (host.kind === 'network') {
    await prepareNetworkServerForCall(userDataPath, environment)
  }
  return resolveEnvironment(userDataPath, environment.id)
}

async function prepareNetworkServerForCall(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): Promise<void> {
  await ensureQuirkydManagedTunnel(userDataPath, environment.id)
  // Why: a server that stopped (idle, killed, host rebooted) starts before the call that needs it.
  const serving = await verifyQuirkydManagedServing(userDataPath, environment.id)
  const createDeps = () => ({
    ...managedServerUpdateDeps(userDataPath),
    target: () => {
      const targetId = getQuirkydSshDeployment(environment)?.sshTargetId
      return targetId ? (getSshTargetRegistryStore()?.getTarget(targetId) ?? null) : null
    },
    publish: publishRestoreUpdate
  })
  if (isStoppedElsewhere(serving)) {
    // Why awaited: this call needs the server, and another desktop's stop can land mid-session.
    if (await redeployStoppedManagedQuirkyd(environment.id, createDeps)) {
      const targetId = getQuirkydSshDeployment(environment)?.sshTargetId
      if (targetId) {
        await forgetLaunchSessionVerdictLazily(targetId)
      }
      // Why rebuild: the redeployed server may bind another port than the reused forward targets.
      await rebuildQuirkydManagedTunnel(userDataPath, environment.id)
    }
  } else {
    // Why here: an auto-restored host may never see an SSH connect, so it would never update.
    const update = updateManagedQuirkydOnRestore(environment.id, createDeps)
    const targetId = getQuirkydSshDeployment(environment)?.sshTargetId
    if (targetId) {
      // Why after the update: its settled status would otherwise replace the warning.
      // Why lazy: the note publishes through this module.
      void Promise.resolve(update)
        .then(() => import('../ssh/ssh-host-launch-session-note'))
        .then(({ noteEndedLaunchSshSession }) =>
          noteEndedLaunchSshSession(targetId, environment.id)
        )
        .catch(() => {})
    }
  }
}

/** This session relaunched the server, so a cached "launch session ended" verdict is stale. */
async function forgetLaunchSessionVerdictLazily(targetId: string): Promise<void> {
  // Why lazy: the note module publishes through this one.
  const { forgetLaunchSessionVerdict } = await import('../ssh/ssh-host-launch-session-note')
  forgetLaunchSessionVerdict(targetId)
}

function isStoppedElsewhere(serving: QuirkydManagedServing): boolean {
  return serving.state === 'unverifiable' && serving.detail === MANAGED_QUIRKYD_NOT_ACTIVATED_DETAIL
}

function publishRestoreUpdate(
  target: SshTarget,
  environmentId: string,
  phase: 'updating' | 'settled',
  note?: SshManagedServerUpdateNote
): void {
  publishHostServerStatus(
    target.id,
    phase === 'updating'
      ? { kind: 'setting-up', phase: 'updating' }
      : { kind: 'managed', environmentId, ...(note ? { update: note } : {}) }
  )
}

/** Shows a managed server's start on the host's status line, wherever the start began. */
export function installManagedQuirkydStartStatus(): void {
  setManagedQuirkydStartListener({
    starting: (target) =>
      publishHostServerStatus(target.id, { kind: 'setting-up', phase: 'starting' }),
    settled: (target, environmentId, serving) => {
      if (serving.state === 'started') {
        void forgetLaunchSessionVerdictLazily(target.id).catch(() => {})
      }
      publishHostServerStatus(target.id, {
        kind: 'managed',
        environmentId,
        ...(serving.state === 'unverifiable' ? { serving } : {})
      })
    }
  })
}

/** A changed host the user resolved (moved or kept) is managed again; its status line says so now. */
export function publishResolvedChangedHostStatus(target: SshTarget, environmentId: string): void {
  setSshHostServerStatus(target.id, { kind: 'managed', environmentId })
  // Why a disconnected state too: the move released the relay session, which had the stale line.
  broadcastSshState(
    getCurrentMainWindow,
    target.id,
    connectionManager?.getState(target.id) ?? {
      targetId: target.id,
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    }
  )
}

export function publishHostServerStatus(targetId: string, status: SshManagedServerStatus): void {
  setSshHostServerStatus(targetId, status)
  // Only a host with a connection state has a status line to refresh.
  const state = connectionManager?.getState(targetId)
  if (state) {
    broadcastSshState(getCurrentMainWindow, targetId, { ...state, managedServer: status })
  }
}

/** A verified update supersedes the host's update and serving notes; any other host route is kept. */
export function clearManagedServerNotes(targetId: string, environmentId: string): void {
  const current = getSshHostServerStatus(targetId)
  if (current?.kind !== 'managed' || current.environmentId !== environmentId) {
    return
  }
  if (current.update || current.serving) {
    // An update can keep the terminal daemon, so only a verified restart clears that warning.
    publishHostServerStatus(targetId, {
      kind: 'managed',
      environmentId,
      ...(current.launchSessionEnded ? { launchSessionEnded: true as const } : {})
    })
  }
}

/** A restart that verified a fresh daemon and a live launching session clears the warning. */
export function clearLaunchSessionNote(targetId: string, environmentId: string): void {
  const current = getSshHostServerStatus(targetId)
  if (current?.kind === 'managed' && current.environmentId === environmentId) {
    const { launchSessionEnded: _cleared, ...rest } = current
    publishHostServerStatus(targetId, rest)
  }
}
