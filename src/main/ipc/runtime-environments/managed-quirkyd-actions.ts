/** The managed-server actions behind both the Managed servers settings and runtime RPC. */
import {
  cancelManagedQuirkydStop,
  forgetManagedQuirkydEnvironment,
  stopManagedQuirkydEnvironment
} from '../../managed-server/lifecycle/quirkyd-runtime-decommission'
import { getManagedQuirkydRuntimeStatus } from '../../managed-server/lifecycle/quirkyd-runtime-status'
import {
  recoverManagedQuirkydEnvironment,
  rollbackManagedQuirkydEnvironment,
  updateManagedQuirkydEnvironment
} from '../../ssh/quirkyd-runtime-maintenance'
import { getQuirkydSshDeployment } from '../../../shared/runtime-environments'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { QuirkydManagedRestartResult } from '../../../shared/quirkyd-managed-runtime'
import { restartManagedQuirkydEnvironment } from '../../managed-server/lifecycle/quirkyd-managed-launch-session'
import { clearLaunchSessionNote } from './runtime-environment-managed-tunnel'
import { forgetLaunchSessionVerdict } from '../ssh/ssh-host-launch-session-note'
import type { ManagedServerActions } from '../../runtime/managed-server-actions-registry'
import {
  retireRemovedRuntimeEnvironment,
  type RemovedServerStore
} from './runtime-environment-removal-cleanup'

export type ManagedQuirkydActionOptions = {
  getUserDataPath: () => string
  getActiveEnvironmentId: () => string | null | undefined
  invalidateTransport: (environmentId: string) => Promise<void> | void
  /** Drops the SSH host's stale update/serving notes once an update verified its server. */
  clearHostServerNotes: (sshTargetId: string, environmentId: string) => void
  /** Drops the SSH host's stale managed-server state once its server is unlinked. */
  clearHostServerStatus: (sshTargetId: string) => void
  /** Holds what an unlinked server leaves in the profile. */
  store: RemovedServerStore
}

export function createManagedQuirkydActions(
  options: ManagedQuirkydActionOptions
): ManagedServerActions {
  const userDataPath = options.getUserDataPath
  const unlinkPolicy = {
    isActiveEnvironment: (environmentId: string) =>
      options.getActiveEnvironmentId() === environmentId,
    retireLocalState: (environmentId: string) =>
      retireRemovedRuntimeEnvironment(environmentId, options.invalidateTransport, options.store)
  }
  return {
    status: (selector) => getManagedQuirkydRuntimeStatus(userDataPath(), selector),
    update: async (selector, force) => {
      const result = await updateManagedQuirkydEnvironment(userDataPath(), { selector, force })
      // Why: a restarted quirkyd drops the old connection; reconnect on the new one.
      if (result.outcome === 'updated') {
        await options.invalidateTransport(result.environment.id)
      }
      if (result.outcome !== 'deferred') {
        const targetId = getQuirkydSshDeployment(result.environment)?.sshTargetId
        if (targetId) {
          options.clearHostServerNotes(targetId, result.environment.id)
        }
      }
      return result
    },
    rollback: async (selector) => {
      const result = await rollbackManagedQuirkydEnvironment(userDataPath(), { selector })
      if (result.outcome === 'rolled-back') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    recover: async (selector, acceptChangedState) => {
      const result = await recoverManagedQuirkydEnvironment(userDataPath(), {
        selector,
        acceptChangedState: acceptChangedState === true
      })
      if (result.outcome === 'recovered' && result.activeVersion) {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    },
    stop: async (selector) => {
      const result = await stopManagedQuirkydEnvironment(userDataPath(), { selector }, unlinkPolicy)
      if (result.outcome === 'unlinked') {
        options.clearHostServerStatus(result.sshTargetId)
      }
      return result
    },
    cancelStop: (selector) => cancelManagedQuirkydStop(userDataPath(), { selector }),
    forget: async (selector) => {
      const result = await forgetManagedQuirkydEnvironment(
        userDataPath(),
        { selector },
        unlinkPolicy
      )
      if (result.outcome === 'forgotten') {
        options.clearHostServerStatus(result.sshTargetId)
      }
      return result
    }
  }
}

/** Desktop-only: the host status line offers it when the launching SSH session ended (#25934). */
export async function restartManagedQuirkyd(
  options: ManagedQuirkydActionOptions,
  selector: string
): Promise<QuirkydManagedRestartResult> {
  const result = await restartManagedQuirkydEnvironment(options.getUserDataPath(), selector)
  if (result.outcome === 'restarted') {
    // Why: the restarted quirkyd dropped the old connection; reconnect on the new one.
    await options.invalidateTransport(result.environmentId)
    const environment = resolveEnvironment(options.getUserDataPath(), result.environmentId)
    const targetId = getQuirkydSshDeployment(environment)?.sshTargetId
    if (targetId) {
      options.clearHostServerNotes(targetId, result.environmentId)
      forgetLaunchSessionVerdict(targetId)
      clearLaunchSessionNote(targetId, result.environmentId)
    }
  }
  return result
}
