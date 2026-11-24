/** IPC for a host an older build changed after conversion: move its newer projects, or keep the server's. */
import { ipcMain } from 'electron'
import type {
  QuirkydDeltaMovePreview,
  QuirkydDeltaMoveResult
} from '../../../shared/quirkyd-managed-runtime'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { requireManagedQuirkydInfrastructure } from '../../managed-server/lifecycle/quirkyd-managed-runtime-context'
import { ensureQuirkydManagedTunnel } from '../../managed-server/lifecycle/quirkyd-managed-tunnel'
import {
  keepQuirkydServerVersion,
  runQuirkydDeltaMove
} from '../../ssh/quirkyd-migration-delta-move'
import { planQuirkydDeltaMove } from '../../ssh/quirkyd-migration-delta-plan'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import { quirkydMigrationDestinationFor } from '../../managed-server/lifecycle/quirkyd-runtime-conversion-wiring'
import { requiredString } from './quirkyd-runtime-lifecycle-handlers'
import { publishResolvedChangedHostStatus } from './runtime-environment-managed-tunnel'
import { runTargetLifecycle } from '../ssh/ssh-target-lifecycle-queue'

export function registerQuirkydDeltaMoveHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:previewQuirkydDeltaMove',
    (_event, args: { sshTargetId: string }): QuirkydDeltaMovePreview => {
      const { store, target } = requireChangedHost(args)
      const plan = planQuirkydDeltaMove(getUserDataPath(), store, target)
      const { sshTargetId, environmentId, added, notReflected, blockers } = plan
      return { sshTargetId, environmentId, added, notReflected, blockers }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:moveQuirkydDelta',
    async (_event, args: { sshTargetId: string }): Promise<QuirkydDeltaMoveResult> => {
      const userDataPath = getUserDataPath()
      const { store, claims, target } = requireChangedHost(args)
      const environment = listEnvironments(userDataPath).find(
        (entry) => entry.id === target.quirkydFence?.environmentId
      )
      if (!environment) {
        throw new Error('This host’s Quirky server is no longer registered.')
      }
      const result = await runQuirkydDeltaMove({
        userDataPath,
        store,
        claims,
        target,
        environment,
        connectDestination: async () =>
          quirkydMigrationDestinationFor(
            await ensureQuirkydManagedTunnel(userDataPath, environment.id)
          ),
        censusHost: censusHostRelayTerminalsFor(target),
        runTargetLifecycle
      })
      if (result.outcome === 'moved') {
        publishResolvedChangedHostStatus(target, environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:keepQuirkydServerVersion',
    async (_event, args: { sshTargetId: string }): Promise<void> => {
      const { store, claims, target, environmentId } = requireChangedHost(args)
      await runTargetLifecycle(target.id, () =>
        keepQuirkydServerVersion({ userDataPath: getUserDataPath(), store, claims, target })
      )
      publishResolvedChangedHostStatus(target, environmentId)
    }
  )
}

function requireChangedHost(args: { sshTargetId: string } | undefined) {
  const sshTargetId = requiredString(args?.sshTargetId, 'SSH target')
  const { targetStore, claims } = requireManagedQuirkydInfrastructure()
  const store = targetStore.getQuirkydMigrationSource()
  const target = store.getSshTarget(sshTargetId)
  if (!target?.quirkydFence?.sourceChangedAt) {
    throw new Error('This SSH host has no changes from an older Quirky to resolve.')
  }
  return { store, claims, target, environmentId: target.quirkydFence.environmentId }
}
