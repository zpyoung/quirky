/** The live collaborators behind each connect's server decision. */
import { getAppEnvironment } from '../../../shared/app-environment'
import {
  getManagedQuirkydFenceEnvironmentId,
  managedQuirkydServerName
} from '../../../shared/managed-quirkyd-ssh-owner'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { findQuirkydMigrationSourceCutoverForTarget } from '../../ssh/quirkyd-migration-cutover-journal'
import { abandonQuirkydConversion } from '../../ssh/quirkyd-conversion-abandon'
import { retainQuirkydMigrationSource } from '../../ssh/quirkyd-migration-source-retention'
import { hasQuirkydTemplate } from '../../quirkyd/quirkyd-artifact-materializer'
import { isQuirkydHostUnavailableFixableOnHost } from '../../quirkyd/quirkyd-host-unavailable'
import { managedServerUpdateDeps } from '../../ssh/managed-server-update-deps'
import { ensureQuirkydManagedTunnel } from '../../managed-server/lifecycle/quirkyd-managed-tunnel'
import { verifyQuirkydManagedServing } from '../../managed-server/lifecycle/quirkyd-managed-serving-verify'
import { convertSshTargetToManagedQuirkyd } from '../../managed-server/lifecycle/quirkyd-runtime-conversion'
import {
  quirkydMigrationDestinationFor,
  quirkydServerFolderCatalogFor,
  quirkydServerRepositoriesFor
} from '../../managed-server/lifecycle/quirkyd-runtime-conversion-wiring'
import { createManagedQuirkydEnvironment } from '../../managed-server/lifecycle/quirkyd-runtime-deployment'
import type { HostServerOnConnectDeps } from '../../ssh/ssh-host-server-on-connect'
import {
  censusSshHostRelaysBeforeSession,
  relayTerminalsOnConnect
} from '../../ssh/legacy-relay/ssh-host-relay-terminals-on-connect'
import { requireManagedQuirkydInfrastructure } from '../../managed-server/lifecycle/quirkyd-managed-runtime-context'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import { setSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { releaseUnreachableQuirkydSetup } from '../../ssh/quirkyd-unreachable-setup-release'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { startLegacyRelayBridge } from '../../ssh/legacy-relay/legacy-relay-bridge-registry'

export function hostServerOnConnectDeps(userDataPath: string): HostServerOnConnectDeps {
  const registry = getSshTargetRegistryStore()!
  const claims = registry.getQuirkydRuntimeClaims()
  const store = registry.getQuirkydMigrationSource()
  const appVersion = getAppEnvironment().getVersion()
  const isRegistered = (environmentId: string): boolean =>
    listEnvironments(userDataPath).some((entry) => entry.id === environmentId)
  return {
    // Why registered only: a fence whose server never registered is an unfinished setup, not a server.
    managedEnvironmentId: (target) => {
      const environmentId = getManagedQuirkydFenceEnvironmentId(target)
      return environmentId && isRegistered(environmentId) ? environmentId : null
    },
    ensureTunnel: async (environmentId) => {
      await ensureQuirkydManagedTunnel(userDataPath, environmentId)
    },
    ensureServing: (environmentId) => verifyQuirkydManagedServing(userDataPath, environmentId),
    retainCommittedSource: async (target) => {
      const head = findQuirkydMigrationSourceCutoverForTarget(userDataPath, target.id)
      if (head?.phase === 'destination-committed') {
        await retainQuirkydMigrationSource(userDataPath, head.migrationId, store)
      }
    },
    hasTemplate: hasQuirkydTemplate,
    recordedUnavailable: (target) =>
      target.managedServerUnavailable?.appVersion === appVersion
        ? target.managedServerUnavailable.reason
        : null,
    recordUnavailable: (target, reason) => {
      if (!isQuirkydHostUnavailableFixableOnHost(reason)) {
        registry.updateTarget(target.id, { managedServerUnavailable: { reason, appVersion } })
      }
    },
    ...managedServerUpdateDeps(userDataPath),
    isEmptyHost: (target) => {
      // An interrupted empty-host deploy passes its own claim, recorded by its provisioning intent.
      const environmentId = getManagedQuirkydFenceEnvironmentId(target)
      return claims.preflight(
        target.id,
        environmentId
          ? { environmentId, recorded: target.quirkydProvisioning !== undefined }
          : undefined
      ).claimable
    },
    relayTerminals: (target) =>
      relayTerminalsOnConnect({
        store,
        targetId: target.id,
        censusHost: async () =>
          censusSshHostRelaysBeforeSession(
            await requireManagedQuirkydInfrastructure().connectionManager.connect(target),
            target.id
          )
      }),
    deploy: (target) =>
      createManagedQuirkydEnvironment(userDataPath, {
        name: target.quirkydProvisioning?.name ?? managedQuirkydServerName(target),
        sshTargetId: target.id
      }),
    convert: async (target, hostProof) => {
      // COMPAT(legacy-relay-bridge): find the panes old relays still run before the tabs remount.
      if (hostProof?.bridged) {
        await startLegacyRelayBridge(target.id)
      }
      const converted = await convertSshTargetToManagedQuirkyd(userDataPath, {
        sshTargetId: target.id,
        name: managedQuirkydServerName(target),
        // The connect's own census already answered; a conversion before any session reuses it.
        censusHost: (host) =>
          hostProof ? Promise.resolve(hostProof) : censusHostRelayTerminalsFor(host)(),
        // Why no releaseDirectSession: a disconnect here would cancel the connect that asked for it.
        destinationFor: quirkydMigrationDestinationFor,
        serverRepositoriesFor: quirkydServerRepositoriesFor,
        serverFolderCatalogFor: quirkydServerFolderCatalogFor
      })
      if (converted.outcome === 'converted' || converted.outcome === 'refused') {
        // "Move anyway" covers one attempt; a later move, or a later delta, asks again.
        // Kept on a throw: verifyFence re-exports with it, so a held fence could never resume.
        registry.updateTarget(target.id, { managedServerLeaveBehind: undefined })
      }
      return converted
    },
    abandonDeploy: async (target) => {
      const environmentId =
        getManagedQuirkydFenceEnvironmentId(target) ??
        getManagedQuirkydFenceEnvironmentId(registry.getTarget(target.id))
      if (environmentId && !isRegistered(environmentId)) {
        claims.release(target.id, environmentId)
        await claims.flush()
      }
    },
    hasUnfinishedConversion: (target) => {
      const head = findQuirkydMigrationSourceCutoverForTarget(userDataPath, target.id)
      return (
        head !== null &&
        !head.supersedesMigrationId &&
        (head.phase === 'source-fenced' || head.phase === 'destination-staged')
      )
    },
    abandonConversion: async (target) => {
      await abandonQuirkydConversion({
        userDataPath,
        store,
        claims,
        targetId: target.id,
        destinationFor: quirkydMigrationDestinationFor
      })
    },
    isFencedBeforeStaging: (target) =>
      findQuirkydMigrationSourceCutoverForTarget(userDataPath, target.id)?.phase ===
      'source-fenced',
    releaseUnreachableSetup: (target) =>
      releaseUnreachableQuirkydSetup({ userDataPath, claims, targetId: target.id }),
    progress: (target, phase) => {
      // A cancelled connect's decision keeps running; its progress must not revive the status.
      if (!connectInFlight.has(target.id)) {
        return
      }
      setSshHostServerStatus(target.id, { kind: 'setting-up', phase })
      broadcastSshState(getCurrentMainWindow, target.id, {
        targetId: target.id,
        status: 'connecting',
        error: null,
        reconnectAttempt: 0
      })
    }
  }
}
