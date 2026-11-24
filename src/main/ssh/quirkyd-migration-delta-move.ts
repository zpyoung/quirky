/**
 * The delta move: a fresh, journaled conversion of only what an older build added to a converted
 * host, committed to the same managed server. Its journal supersedes the previous head of the
 * host's chain; both stay, and the source rows of every manifest in the chain are kept.
 *
 * A row the server already holds under another identity fails the whole move at stage, before
 * anything is committed: the journal goes, and the host keeps its "changed" mark and the relay.
 * A move whose outcome the server can't confirm keeps its journal, and the next move resumes it.
 */
import {
  QUIRKYD_MIGRATION_SOURCE_CUTOVER_VERSION,
  type QuirkydMigrationSourceCutover
} from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import type { QuirkydDeltaMoveResult } from '../../shared/quirkyd-managed-runtime'
import { recordManagedQuirkydMigration } from '../../shared/runtime-environment-managed-quirkyd-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import {
  abortQuirkydMigrationCutover,
  commitQuirkydMigrationDestination,
  type QuirkydMigrationCutoverContext,
  type QuirkydMigrationDestinationCatalog
} from './quirkyd-migration-cutover-coordinator'
import {
  findQuirkydMigrationSourceCutoverForTarget,
  listQuirkydMigrationCutoverChainForTarget,
  removeQuirkydMigrationSourceCutover,
  writeQuirkydMigrationSourceCutover
} from './quirkyd-migration-cutover-journal'
import {
  committedQuirkydMigrationChain,
  quirkydDeltaSourceStore,
  planQuirkydDeltaMove,
  unfinishedQuirkydDelta,
  type QuirkydDeltaMovePlan
} from './quirkyd-migration-delta-plan'
import { assertQuirkydMigrationRequestFits } from './quirkyd-migration-manifest-export'
import { retainQuirkydMigrationSource } from './quirkyd-migration-source-retention'
import {
  assessQuirkydMigrationTerminals,
  type QuirkydMigrationTerminalVerdict,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals
} from './quirkyd-migration-terminal-gate'
import { currentQuirkydSourceFingerprint } from './quirkyd-retained-source'
import type { SshTargetQuirkydClaims } from './targets/ssh-target-quirkyd-claims'
import { quirkydMigrationRefusalReason } from './quirkyd-migration-refusal-reason'
import { errorMessage } from '../../shared/error-message'

export type QuirkydDeltaMoveArgs = {
  userDataPath: string
  store: Store
  claims: SshTargetQuirkydClaims
  target: SshTarget
  environment: KnownRuntimeEnvironment
  /**
   * Opens the tunnel and returns the destination built from the pairing it stands on, the only
   * way to get one: a re-pair while it opens replaces the credentials a commit must carry.
   */
  connectDestination: () => Promise<QuirkydMigrationDestinationCatalog>
  /** The census of the host's relay endpoints that must prove exit. */
  censusHost?: CensusHostRelayTerminals | null
  /** Serializes the journal write through the commit with every other change to this host. */
  runTargetLifecycle: <T>(targetId: string, operation: () => Promise<T>) => Promise<T>
  now?: () => Date
}

export async function runQuirkydDeltaMove(
  args: QuirkydDeltaMoveArgs
): Promise<QuirkydDeltaMoveResult> {
  const { userDataPath, store, target } = args
  const now = args.now ?? (() => new Date())
  const plan = planQuirkydDeltaMove(userDataPath, store, target, { now })
  // Taken with the manifest, before any await: the baseline must describe what the server receives.
  const planned = currentQuirkydSourceFingerprint(store, target)
  if (!plan.resumes && plan.added.length === 0) {
    return refuse('quirkyd_delta_nothing_new', 'An older build added nothing new to move.')
  }
  if (plan.blockers.length > 0) {
    return {
      ...refuse(
        'quirkyd_migration_preflight_blocked',
        quirkydMigrationRefusalReason(plan.blockers)
      ),
      blockers: plan.blockers
    }
  }
  if (!plan.resumes) {
    // Before the journal: a delta no request can carry would pin the host's fence for good.
    assertQuirkydMigrationRequestFits({ manifest: plan.manifest })
  }
  const terminals = await assessQuirkydMigrationTerminals(store, target.id, args.censusHost)
  if (terminals.verdict !== 'exited' && terminals.verdict !== 'bridged') {
    return refuse('quirkyd_migration_terminals', terminals.reason)
  }
  const settled: SettledTerminals = terminals
  retireProvenExitedLeases(store, target.id, terminals)
  return args.runTargetLifecycle(target.id, async () => {
    // Why re-checked: another move of this host may have journaled or finished while this waited.
    const changedAt = store.getSshTarget(target.id)?.quirkydFence?.sourceChangedAt
    const head = findQuirkydMigrationSourceCutoverForTarget(userDataPath, target.id)
    if (!changedAt || head?.migrationId !== (plan.resumes ?? plan.head).migrationId) {
      return refuse('quirkyd_delta_superseded', 'Another move of this host ran first.')
    }
    // The source stays writable until the fence below: a draft typed while the terminals were
    // checked is newer than the manifest, so it must not become the baseline the server is held to.
    if (!plan.resumes && planned !== currentQuirkydSourceFingerprint(store, target)) {
      return refuse(
        'quirkyd_delta_source_changed',
        'This host changed while the move was starting. Try the move again.'
      )
    }
    const cutover = plan.resumes ?? journalDelta(args, plan, planned, settled, now)
    return commitDelta(args, plan, cutover, changedAt, now)
  })
}

type SettledTerminals = Extract<QuirkydMigrationTerminalVerdict, { verdict: 'exited' | 'bridged' }>

function journalDelta(
  args: QuirkydDeltaMoveArgs,
  plan: QuirkydDeltaMovePlan,
  planned: string,
  terminals: SettledTerminals,
  now: () => Date
): QuirkydMigrationSourceCutover {
  const timestamp = now().toISOString()
  const cutover: QuirkydMigrationSourceCutover = {
    version: QUIRKYD_MIGRATION_SOURCE_CUTOVER_VERSION,
    migrationId: plan.manifest.migrationId,
    phase: 'source-fenced',
    startedAt: timestamp,
    updatedAt: timestamp,
    destinationEnvironmentId: plan.environmentId,
    destinationName: plan.head.destinationName,
    sshTargetId: args.target.id,
    sshTargetGeneration: plan.head.sshTargetGeneration,
    manifestSha256: plan.manifest.manifestSha256,
    provenPtyIds: terminals.verdict === 'exited' ? terminals.provenPtyIds : [],
    // COMPAT(legacy-relay-bridge): a move leaves relay terminals running for the bridge too.
    ...(terminals.verdict === 'bridged' ? { bridgedPtyIds: terminals.bridgedPtyIds } : {}),
    supersedesMigrationId: plan.head.migrationId,
    // The whole source as the manifest saw it: what the retained rows must keep matching.
    sourceBaselineFingerprint: planned,
    manifest: plan.manifest
  }
  writeQuirkydMigrationSourceCutover(args.userDataPath, cutover)
  return cutover
}

async function commitDelta(
  args: QuirkydDeltaMoveArgs,
  plan: QuirkydDeltaMovePlan,
  cutover: QuirkydMigrationSourceCutover,
  changedAt: string,
  now: () => Date
): Promise<QuirkydDeltaMoveResult> {
  const { userDataPath, store, target } = args
  // The fence goes back without its "changed" mark: the source freezes for the move.
  store.updateSshTarget(target.id, { quirkydFence: { environmentId: plan.environmentId } })
  await args.claims.flush()
  // Before any commit can land, resumed ones included: a rollback must not cross this move.
  recordManagedQuirkydMigration(userDataPath, plan.environmentId, now().toISOString())
  let destination: QuirkydMigrationDestinationCatalog
  try {
    destination = await args.connectDestination()
  } catch (error) {
    // Nothing reached the server this time; the journal stays for the next move to resume.
    await restoreChangedMark(args, cutover, changedAt)
    throw error
  }
  const context: QuirkydMigrationCutoverContext = {
    userDataPath,
    store: plan.source,
    freshSource: () => quirkydDeltaSourceStore(store, target, plan.moved, cutover.manifest),
    claims: args.claims,
    destination,
    now
  }
  try {
    const committed = await commitQuirkydMigrationDestination(context, cutover.migrationId)
    if (committed.phase !== 'destination-committed' && committed.phase !== 'source-retired') {
      throw new Error(`quirkyd_migration_commit_not_proven:${committed.phase}`)
    }
  } catch (error) {
    const released = await releaseUncommittedDelta(args, context, cutover, changedAt)
    if (released === 'released') {
      return refuse('quirkyd_delta_refused_by_server', errorMessage(error))
    }
    if (released === 'kept') {
      throw error
    }
  }
  await retainQuirkydMigrationSource(userDataPath, cutover.migrationId, store, now)
  return { outcome: 'moved', migrationId: cutover.migrationId }
}

/**
 * Undoes a delta only once the server provably holds nothing of it, so no row moves twice. One it
 * may hold stays journaled for the next move to resume; either way the host gets its mark back.
 */
async function releaseUncommittedDelta(
  args: QuirkydDeltaMoveArgs,
  context: QuirkydMigrationCutoverContext,
  cutover: QuirkydMigrationSourceCutover,
  changedAt: string
): Promise<'released' | 'committed' | 'kept'> {
  const restoreMark = (): Promise<void> => restoreChangedMark(args, cutover, changedAt)
  try {
    const result = await abortQuirkydMigrationCutover(context, cutover.migrationId, async () => {
      // Mark first: a crash before the journal goes leaves a marked host that resumes this delta.
      await restoreMark()
      removeQuirkydMigrationSourceCutover(args.userDataPath, cutover.migrationId)
    })
    return result.outcome === 'released' ? 'released' : 'committed'
  } catch {
    await restoreMark()
    return 'kept'
  }
}

async function restoreChangedMark(
  args: Pick<QuirkydDeltaMoveArgs, 'store' | 'claims'>,
  cutover: QuirkydMigrationSourceCutover,
  changedAt: string
): Promise<void> {
  args.store.updateSshTarget(cutover.sshTargetId, {
    quirkydFence: { environmentId: cutover.destinationEnvironmentId, sourceChangedAt: changedAt }
  })
  await args.claims.flush()
}

/** "Keep the server's version": the older build's changes stay only in the retained profile rows. */
export async function keepQuirkydServerVersion(args: {
  userDataPath: string
  store: Store
  claims: SshTargetQuirkydClaims
  target: SshTarget
}): Promise<void> {
  const environmentId = args.target.quirkydFence?.environmentId
  const chain = listQuirkydMigrationCutoverChainForTarget(args.userDataPath, args.target.id)
  if (unfinishedQuirkydDelta(chain)) {
    // Its rows may be on the server already; only finishing or undoing the move can say.
    throw new Error('quirkyd_delta_move_unfinished')
  }
  const head = committedQuirkydMigrationChain(chain).at(-1)
  if (!environmentId || !args.target.quirkydFence?.sourceChangedAt || !head) {
    throw new Error('quirkyd_delta_not_changed')
  }
  writeQuirkydMigrationSourceCutover(args.userDataPath, {
    ...head,
    // Keeping the server's version is the explicit reconcile: the source as it is now is the baseline.
    sourceBaselineFingerprint: currentQuirkydSourceFingerprint(args.store, args.target)
  })
  args.store.updateSshTarget(args.target.id, { quirkydFence: { environmentId } })
  await args.claims.flush()
}

function refuse(
  code: string,
  reason: string
): Extract<QuirkydDeltaMoveResult, { outcome: 'refused' }> {
  return { outcome: 'refused', code, reason }
}
