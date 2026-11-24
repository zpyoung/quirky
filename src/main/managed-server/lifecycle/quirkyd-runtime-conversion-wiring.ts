/** The live collaborators a host conversion needs: the census, the direct session and the server. */
import { encodePairingOffer } from '../../../shared/pairing'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { disconnectRegisteredSshTarget } from '../../ipc/ssh/ssh-session-teardown'
import type { QuirkydMigrationDestinationCatalog } from '../../ssh/quirkyd-migration-cutover-coordinator'
import {
  abortRemoteQuirkydMigrationCatalog,
  commitRemoteQuirkydMigrationCatalog,
  listRemoteQuirkydRepositories,
  readRemoteQuirkydMigrationCatalogState,
  stageRemoteQuirkydMigrationCatalog,
  stageRemoteQuirkydMigrationSnapshotChunk
} from '../../ssh/quirkyd-migration-catalog-client'
import { abortRemoteQuirkydMigrationCatalogByReference } from '../../ssh/quirkyd-migration-catalog-reference-client'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import type { QuirkydManagedConversionArgs } from './quirkyd-runtime-conversion'
import type { QuirkydServerRepository } from '../../ssh/quirkyd-migration-repository-link'
import {
  listRemoteQuirkydFolderCatalog,
  type QuirkydServerFolderCatalog
} from '../../ssh/quirkyd-server-folder-workspaces'

/** The T6-9 client against this server, pinned to the runtime it paired with. */
export function quirkydMigrationDestinationFor(
  environment: KnownRuntimeEnvironment
): QuirkydMigrationDestinationCatalog {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  return {
    readState: (manifest) => readRemoteQuirkydMigrationCatalogState(pairingCode, manifest, options),
    stage: (manifest) => stageRemoteQuirkydMigrationCatalog(pairingCode, manifest, options),
    commit: (manifest) => commitRemoteQuirkydMigrationCatalog(pairingCode, manifest, options),
    abort: (manifest) => abortRemoteQuirkydMigrationCatalog(pairingCode, manifest, options),
    abortByReference: (manifest) =>
      abortRemoteQuirkydMigrationCatalogByReference(pairingCode, manifest, options),
    stageChunk: (request) => stageRemoteQuirkydMigrationSnapshotChunk(pairingCode, request, options)
  }
}

/** The projects this server already holds, read through the same pinned pairing. */
export function quirkydServerRepositoriesFor(
  environment: KnownRuntimeEnvironment
): Promise<QuirkydServerRepository[]> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteQuirkydRepositories(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

/** The folder workspaces this server already holds, read through the same pinned pairing. */
export function quirkydServerFolderCatalogFor(
  environment: KnownRuntimeEnvironment
): Promise<QuirkydServerFolderCatalog> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteQuirkydFolderCatalog(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

export function conversionCollaborators(): Pick<
  QuirkydManagedConversionArgs,
  | 'destinationFor'
  | 'serverRepositoriesFor'
  | 'serverFolderCatalogFor'
  | 'censusHost'
  | 'releaseDirectSession'
> {
  return {
    destinationFor: quirkydMigrationDestinationFor,
    serverRepositoriesFor: quirkydServerRepositoriesFor,
    serverFolderCatalogFor: quirkydServerFolderCatalogFor,
    censusHost: (target) => censusHostRelayTerminalsFor(target)(),
    releaseDirectSession: disconnectRegisteredSshTarget
  }
}
