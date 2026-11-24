/** The relay-era SSH target as a migration source: keyed by its target id, paths unchanged. */
import { QUIRKYD_MIGRATION_SSH_RELAY_SOURCE_KIND } from '../../shared/quirkyd-migration/quirkyd-migration-source-kind'
import type { SshTarget } from '../../shared/ssh-types'
import { collectQuirkydMigrationSourceCatalog } from '../persistence/migrating-quirkyd-catalog/quirkyd-source-catalog'
import type { Store } from '../persistence'
import { createQuirkydMigrationManifest } from './quirkyd-migration-manifest-export'
import { IDENTITY_QUIRKYD_MIGRATION_PATH_REWRITER } from './quirkyd-migration-path-rewrite'
import type {
  QuirkydMigrationSource,
  QuirkydMigrationSourceCutoverPort
} from './quirkyd-migration-source'
import { assertQuirkydMigrationSourceUnchanged } from './quirkyd-migration-source-assertions'
import {
  fenceQuirkydMigrationSource,
  releaseQuirkydMigrationFence,
  resolveQuirkydMigrationFence
} from './quirkyd-migration-source-fence'
import {
  assessQuirkydMigrationTerminals,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals
} from './quirkyd-migration-terminal-gate'
import type { SshTargetQuirkydClaims } from './targets/ssh-target-quirkyd-claims'
import type { QuirkydMigrationPreflightStore } from './targets/ssh-target-quirkyd-preflight'

type SshRelayCutoverDeps = {
  userDataPath: string
  store: QuirkydMigrationPreflightStore
  claims: SshTargetQuirkydClaims
  /** Rebuilt for every check when `store` is a copy that would never see a later edit. */
  freshSource?: () => QuirkydMigrationPreflightStore
  signal?: AbortSignal
}

/** The fenced SSH target a journaled cutover names. */
export function sshRelayMigrationCutoverPort(
  deps: SshRelayCutoverDeps
): QuirkydMigrationSourceCutoverPort {
  return {
    verifyFence: (cutover) =>
      assertQuirkydMigrationSourceUnchanged(
        { userDataPath: deps.userDataPath, store: deps.freshSource?.() ?? deps.store },
        cutover
      ),
    releaseFence: (cutover) => releaseQuirkydMigrationFence(deps, cutover)
  }
}

export function createSshRelayMigrationSource(
  deps: SshRelayCutoverDeps & {
    store: QuirkydMigrationPreflightStore &
      Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease'>
    target: SshTarget
    /** Every relay endpoint on the host's account; without it exit can never be proven. */
    censusHost?: CensusHostRelayTerminals | null
  }
): QuirkydMigrationSource {
  const { userDataPath, store, target } = deps
  return {
    ...sshRelayMigrationCutoverPort(deps),
    kind: QUIRKYD_MIGRATION_SSH_RELAY_SOURCE_KIND,
    journalKey: target.id,
    collectCatalog: () => collectQuirkydMigrationSourceCatalog(store, target),
    exportManifest: (options = {}) =>
      createQuirkydMigrationManifest(store, target, {
        ...options,
        rewrite: IDENTITY_QUIRKYD_MIGRATION_PATH_REWRITER
      }),
    assessTerminals: () => assessQuirkydMigrationTerminals(store, target.id, deps.censusHost),
    retireProvenExitedTerminals: (proof) => retireProvenExitedLeases(store, target.id, proof),
    resolveFence: () => resolveQuirkydMigrationFence(userDataPath, target),
    acquireFence: (args) =>
      fenceQuirkydMigrationSource({
        userDataPath,
        store,
        claims: deps.claims,
        targetId: target.id,
        ...args
      })
  }
}
