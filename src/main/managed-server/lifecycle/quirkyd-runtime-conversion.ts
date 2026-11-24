/**
 * Converting a relay-hosted SSH target that holds Quirky state into a managed quirkyd server:
 * fence the source, deploy and pair the server, stage and commit the dormant catalog, then keep
 * the source rows, hidden, for a downgraded build.
 *
 * Every step is keyed by the journal, so calling this again after a crash or lost contact resumes
 * the same migration instead of starting another. The source stays authoritative until the
 * destination proves its commit, and is never deleted afterwards.
 */
import { randomUUID } from 'node:crypto'
import type { QuirkydManagedConversionResult } from '../../../shared/quirkyd-managed-runtime'
import type { QuirkydMigrationSourceCutover } from '../../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import { recordManagedQuirkydMigration } from '../../../shared/runtime-environment-managed-quirkyd-store'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import {
  getQuirkydSshDeployment,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import { environmentMatchesManagedQuirkydCutover } from './quirkyd-managed-migration-status'
import { requireManagedQuirkydInfrastructure } from './quirkyd-managed-runtime-context'
import { ensureQuirkydManagedTunnel } from './quirkyd-managed-tunnel'
import {
  commitQuirkydMigrationDestination,
  type QuirkydMigrationDestinationCatalog
} from '../../ssh/quirkyd-migration-cutover-coordinator'
import {
  findQuirkydMigrationSourceCutoverForTarget,
  removeQuirkydMigrationJournalsForDestination
} from '../../ssh/quirkyd-migration-cutover-journal'
import type { SshTarget } from '../../../shared/ssh-types'
import type { CensusHostRelayTerminals } from '../../ssh/quirkyd-migration-terminal-gate'
import { createManagedQuirkydEnvironment } from './quirkyd-runtime-deployment'
import { createSshRelayMigrationSource } from '../../ssh/quirkyd-migration-ssh-relay-source'
import {
  leaveBehindClearsQuirkydMigrationBlockers,
  onlyLeavableQuirkydMigrationBlockers
} from '../../ssh/targets/ssh-target-quirkyd-preflight'
import { QUIRKYD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON } from '../../ssh/quirkyd-migration-source-fence'
import { retainQuirkydMigrationSource } from '../../ssh/quirkyd-migration-source-retention'
import {
  linkedQuirkydMigrationCutoverPort,
  linkedQuirkydMigrationProjects,
  linkServerHeldRepositories,
  type QuirkydServerRepository
} from '../../ssh/quirkyd-migration-repository-link'
import type { QuirkydServerFolderCatalog } from '../../ssh/quirkyd-server-folder-workspaces'

export type QuirkydManagedConversionArgs = {
  sshTargetId: string
  name: string
  /** The census of the host's relay endpoints that must prove exit. */
  censusHost?: ((target: SshTarget) => ReturnType<CensusHostRelayTerminals>) | null
  /** The destination's T6-9 catalog client, reached through the server's tunnel. */
  destinationFor: (environment: KnownRuntimeEnvironment) => QuirkydMigrationDestinationCatalog
  /** The server's own projects, so ones this host already holds at the same path link to them. */
  serverRepositoriesFor?: (
    environment: KnownRuntimeEnvironment
  ) => Promise<QuirkydServerRepository[]>
  /** The server's folder workspaces, so ones an earlier move left there link to them. */
  serverFolderCatalogFor?: (
    environment: KnownRuntimeEnvironment
  ) => Promise<QuirkydServerFolderCatalog>
  /** Releases the direct SSH session after the terminal check, before the fence. */
  releaseDirectSession?: (sshTargetId: string) => Promise<void>
  now?: () => Date
  signal?: AbortSignal
}

export async function convertSshTargetToManagedQuirkyd(
  userDataPath: string,
  args: QuirkydManagedConversionArgs
): Promise<QuirkydManagedConversionResult> {
  const fenced = await fenceOrResume(userDataPath, args)
  if ('outcome' in fenced) {
    return fenced
  }
  const deployed = await createManagedQuirkydEnvironment(userDataPath, {
    name: fenced.destinationName,
    sshTargetId: fenced.sshTargetId,
    migration: true,
    signal: args.signal
  })
  if (deployed.outcome === 'deferred') {
    return deployed // The fence and journal stay; a later call resumes here.
  }
  const environment = listEnvironments(userDataPath).find(
    (entry) => entry.id === fenced.destinationEnvironmentId
  )
  if (!environment || !environmentMatchesManagedQuirkydCutover(environment, fenced)) {
    throw new Error('quirkyd_migration_destination_environment_mismatch')
  }
  // Before any commit can land, so a crash after it still blocks rollbacks across it.
  recordManagedQuirkydMigration(
    userDataPath,
    environment.id,
    (args.now ?? (() => new Date()))().toISOString()
  )
  // Why the record ensure returns: a re-pair while the tunnel stands replaces the credentials
  // every request below must carry; it keeps the migration mark recorded above.
  const marked = await ensureQuirkydManagedTunnel(userDataPath, environment.id)
  const { claims, targetStore } = requireManagedQuirkydInfrastructure()
  const store = targetStore.getQuirkydMigrationSource()
  const destination = args.destinationFor(marked)
  const serverRepositoriesFor = args.serverRepositoriesFor
  const serverFolderCatalogFor = args.serverFolderCatalogFor
  let linked: Pick<
    QuirkydMigrationSourceCutover,
    'linkedRepositoryIds' | 'linkedFolderWorkspaceIds'
  > = {}
  const committed = await runTargetLifecycle(fenced.sshTargetId, async () => {
    const journaled = requireJournaledCutover(userDataPath, fenced)
    const cutover = serverRepositoriesFor
      ? await linkServerHeldRepositories({
          userDataPath,
          store,
          claims,
          cutover: journaled,
          destination,
          serverRepositories: () => serverRepositoriesFor(marked),
          ...(serverFolderCatalogFor
            ? { serverFolderCatalog: () => serverFolderCatalogFor(marked) }
            : {}),
          now: args.now
        })
      : journaled
    linked = cutover
    return commitQuirkydMigrationDestination(
      {
        userDataPath,
        store,
        claims,
        source: linkedQuirkydMigrationCutoverPort({ userDataPath, store, claims, cutover }),
        destination,
        now: args.now
      },
      cutover.migrationId
    )
  })
  if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
    throw new Error(`quirkyd_migration_commit_not_proven:${committed.phase}`)
  }
  if (committed.phase === 'destination-committed') {
    await retainQuirkydMigrationSource(userDataPath, committed.migrationId, store, args.now)
  }
  const linkedProjects = linkedQuirkydMigrationProjects(store, linked)
  return {
    outcome: 'converted',
    environment: redactRuntimeEnvironment(marked),
    migrationId: committed.migrationId,
    ...(linkedProjects.length > 0 ? { linkedProjects } : {})
  }
}

async function fenceOrResume(
  userDataPath: string,
  args: QuirkydManagedConversionArgs
): Promise<
  QuirkydMigrationSourceCutover | Extract<QuirkydManagedConversionResult, { outcome: 'refused' }>
> {
  const { claims, targetStore } = requireManagedQuirkydInfrastructure()
  const target = targetStore.getTarget(args.sshTargetId)
  if (!target) {
    return refuse('unverifiable', 'quirkyd_migration_target_not_found', 'The SSH host is gone.')
  }
  const store = targetStore.getQuirkydMigrationSource()
  const censusHost = args.censusHost
  const source = createSshRelayMigrationSource({
    userDataPath,
    store,
    claims,
    target,
    censusHost: censusHost ? () => censusHost(target) : null
  })
  const existing = source.resolveFence()
  if (existing.state === 'fenced') {
    return existing.cutover
  }
  const stale = existing.state === 'stale-journal' ? existing.cutover : null
  if (stale && !isRegistered(userDataPath, stale.destinationEnvironmentId)) {
    // Its fence is gone and its server unregistered, so nothing it records can still be acted on.
    removeQuirkydMigrationJournalsForDestination(
      userDataPath,
      target.id,
      stale.destinationEnvironmentId
    )
  }
  const converted = listEnvironments(userDataPath).some(
    (environment) => getQuirkydSshDeployment(environment)?.sshTargetId === target.id
  )
  if (converted) {
    return refuse(
      'live',
      'quirkyd_migration_already_managed',
      'Quirky already runs on this SSH host.'
    )
  }
  // The fence re-checks leases once it holds.
  const terminalProof = await source.assessTerminals()
  if (terminalProof.verdict === 'live' || terminalProof.verdict === 'unverifiable') {
    return refuse(terminalProof.verdict, 'quirkyd_migration_terminals', terminalProof.reason)
  }
  source.retireProvenExitedTerminals(terminalProof)
  await args.releaseDirectSession?.(target.id)
  const result = await runTargetLifecycle(target.id, () =>
    source.acquireFence({
      destinationEnvironmentId: randomUUID(),
      destinationName: args.name,
      terminalProof,
      now: args.now,
      signal: args.signal
    })
  )
  if (result.outcome === 'fenced') {
    return result.cutover
  }
  if (result.blockers?.length) {
    // Why logged: the connect surfaces only the reason, and support needs which state blocked.
    console.warn(
      '[ssh] Conversion refused by:',
      JSON.stringify(
        result.blockers.map((blocker) =>
          'dependencies' in blocker
            ? { code: blocker.code, dependencies: blocker.dependencies }
            : { code: blocker.code }
        )
      )
    )
  }
  // Already moving anyway: what still refuses is what can't be left behind.
  const leavable =
    result.blockers &&
    onlyLeavableQuirkydMigrationBlockers(result.blockers) &&
    !target.managedServerLeaveBehind
  if (leavable && terminalProof.verdict !== 'exited') {
    // Why no offer: leaving tabs behind would strand terminals the relay bridge still serves.
    return refuse(
      result.verdict,
      result.code,
      `${result.reason} ${QUIRKYD_MIGRATION_LEAVE_BEHIND_TERMINALS_REASON}`
    )
  }
  return {
    ...refuse(result.verdict, result.code, result.reason),
    // Why previewed: an offer the confirmed export would refuse again is a dead end.
    ...(leavable && leaveBehindClearsQuirkydMigrationBlockers(store, target.id)
      ? { canLeaveBehind: true }
      : {})
  }
}

function requireJournaledCutover(
  userDataPath: string,
  fenced: QuirkydMigrationSourceCutover
): QuirkydMigrationSourceCutover {
  const journaled = findQuirkydMigrationSourceCutoverForTarget(userDataPath, fenced.sshTargetId)
  if (journaled?.migrationId !== fenced.migrationId) {
    throw new Error('quirkyd_migration_source_fence_lost')
  }
  return journaled
}

function isRegistered(userDataPath: string, environmentId: string): boolean {
  return listEnvironments(userDataPath).some((environment) => environment.id === environmentId)
}

function refuse(
  verdict: 'live' | 'unverifiable',
  code: string,
  reason: string
): Extract<QuirkydManagedConversionResult, { outcome: 'refused' }> {
  return { outcome: 'refused', verdict, code, reason }
}
